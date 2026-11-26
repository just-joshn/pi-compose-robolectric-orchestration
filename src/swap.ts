import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isArrayOf, isRecord, isString } from "./guards.ts";
import { sha256 } from "./tree.ts";

/** Per-workspace directory outside the repository, so it never shows up in the fingerprint. */
export function stateDir(cwd: string, env = process.env): string {
  const root = env["PI_COMPOSE_TEST_HOME"] ?? join(homedir(), ".pi", "agent", "compose-test");
  const dir = join(root, sha256(cwd).slice(0, 16));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function atomicWrite(path: string, content: string) {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

/** Replace a file's content for the duration of a run; null deletes it. */
export interface FileSwap {
  readonly path: string;
  readonly content: Buffer | null;
}

interface PendingFile {
  readonly path: string;
  readonly original: string | null;
  readonly written: string | null;
}

const PENDING = "swap.json";
const sha = (data: Buffer | null) => (data ? sha256(data) : null);
const isPendingFile = (v: unknown): v is PendingFile =>
  isRecord(v) &&
  isString(v["path"]) &&
  (v["original"] === null || isString(v["original"])) &&
  (v["written"] === null || isString(v["written"]));
const current = (path: string) => (existsSync(path) ? readFileSync(path) : null);

function put(path: string, content: Buffer | null) {
  if (content) writeFileSync(path, content);
  else rmSync(path, { force: true });
}

/**
 * Put each file back only if it still holds what the extension wrote. A file someone else changed
 * meanwhile is left alone and its original is saved next to the pending record.
 */
function restore(
  dir: string,
  files: readonly PendingFile[],
): { restored: string[]; conflicts: string[] } {
  const restored: string[] = [];
  const conflicts: string[] = [];
  for (const file of files) {
    const now = current(file.path);
    const original = file.original === null ? null : Buffer.from(file.original, "base64");
    if (sha(now) === sha(original)) continue;
    if (sha(now) !== file.written) {
      const saved = join(dir, `conflict-${Date.now()}-${file.path.replaceAll(/[/\\]/g, "_")}`);
      if (original) writeFileSync(saved, original);
      conflicts.push(original ? `${file.path} (original saved to ${saved})` : file.path);
      continue;
    }
    put(file.path, original);
    restored.push(file.path);
  }
  return { restored, conflicts };
}

/**
 * Apply the swaps, run `work`, then restore. The originals are recorded on disk first, so a
 * crash is repaired by recoverSwap on the next session start.
 */
export async function withSwappedFiles<T>(
  dir: string,
  swaps: readonly FileSwap[],
  work: () => Promise<T>,
): Promise<{ value: T; conflicts: string[] }> {
  const files: PendingFile[] = swaps.map((swap) => ({
    path: swap.path,
    original: current(swap.path)?.toString("base64") ?? null,
    written: sha(swap.content),
  }));
  atomicWrite(join(dir, PENDING), JSON.stringify(files));
  const restoreAll = () => {
    const { conflicts } = restore(dir, files);
    rmSync(join(dir, PENDING), { force: true });
    return conflicts;
  };
  let value: T;
  try {
    for (const swap of swaps) put(swap.path, swap.content);
    value = await work();
  } catch (error) {
    const conflicts = restoreAll();
    if (conflicts.length === 0) throw error;
    const left = `Files changed during the run were left as they are: ${conflicts.join(", ")}`;
    throw new Error(`${String(error)}\n${left}`, { cause: error });
  }
  return { value, conflicts: restoreAll() };
}

export function recoverSwap(dir: string): { restored: string[]; conflicts: string[] } {
  const path = join(dir, PENDING);
  if (!existsSync(path)) return { restored: [], conflicts: [] };
  const files: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isArrayOf(files, isPendingFile)) throw new Error(`${path} is not a pending swap record.`);
  const result = restore(dir, files);
  rmSync(path, { force: true });
  return result;
}
