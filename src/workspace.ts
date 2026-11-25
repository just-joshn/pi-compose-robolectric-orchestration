import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per-workspace directory outside the repository, so it never shows up in the tree fingerprint. */
export function stateDir(cwd: string, env = process.env): string {
  const root = env["PI_COMPOSE_TEST_HOME"] ?? join(homedir(), ".pi", "agent", "compose-test");
  const dir = join(root, createHash("sha256").update(cwd).digest("hex").slice(0, 16));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicWrite(path: string, content: string) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

interface LockOwner {
  readonly pid: number;
  readonly session: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * One workflow per workspace at a time. A lock held by a live process from another session
 * refuses the start; a stale lock from a dead process is taken over.
 */
export function acquireLock(dir: string, session: string): void {
  const path = join(dir, "lock.json");
  if (existsSync(path)) {
    const owner = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
    if (owner.session !== session && alive(owner.pid))
      throw new Error(
        `Another Pi session (pid ${owner.pid}) is running a compose-test workflow in this workspace. Wait for it to finish.`,
      );
  }
  atomicWrite(path, JSON.stringify({ pid: process.pid, session } satisfies LockOwner));
}

export function releaseLock(dir: string, session: string): void {
  const path = join(dir, "lock.json");
  if (!existsSync(path)) return;
  const owner = JSON.parse(readFileSync(path, "utf8")) as LockOwner;
  if (owner.session === session) rmSync(path, { force: true });
}

interface PendingMutation {
  readonly file: string;
  readonly original: string;
}

/** Record the original bytes before a mutation is applied, so a crash can never leave it in place. */
export function recordPendingMutation(dir: string, file: string, original: Buffer): void {
  atomicWrite(
    join(dir, "mutation.json"),
    JSON.stringify({ file, original: original.toString("base64") } satisfies PendingMutation),
  );
}

export function clearPendingMutation(dir: string): void {
  rmSync(join(dir, "mutation.json"), { force: true });
}

/** Restore a mutation left behind by a crash. Idempotent. Returns the restored file, if any. */
export function recoverPendingMutation(dir: string): string | undefined {
  const path = join(dir, "mutation.json");
  if (!existsSync(path)) return undefined;
  const pending = JSON.parse(readFileSync(path, "utf8")) as PendingMutation;
  const original = Buffer.from(pending.original, "base64");
  const current = existsSync(pending.file) ? readFileSync(pending.file) : undefined;
  const changed = !current || !current.equals(original);
  if (changed) writeFileSync(pending.file, original);
  clearPendingMutation(dir);
  return changed ? pending.file : undefined;
}
