import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isArrayOf, isRecord, isString } from "./guards.ts";
import { sha256 } from "./tree.ts";

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

interface Journal {
  readonly pid: number;
  readonly files: readonly PendingFile[];
}

function readJournal(path: string): Journal | undefined {
  if (!existsSync(path)) return undefined;
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (isRecord(v) && typeof v["pid"] === "number" && isArrayOf(v["files"], isPendingFile))
    return { pid: v["pid"], files: v["files"] };
  throw new Error(`${path} is not a pending swap record.`);
}

const hasCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

const holding = new Set<string>();
const held = (path: string, journal: Journal) =>
  journal.pid === process.pid ? holding.has(path) : alive(journal.pid);

function claim(path: string, journal: Journal) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(journal));
  try {
    linkSync(temp, path);
  } catch (error) {
    if (hasCode(error, "EEXIST"))
      throw new Error(
        "Another compose-test run in this workspace is applying a negative control. Try again when it finishes.",
        { cause: error },
      );
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

const current = (path: string) => (existsSync(path) ? readFileSync(path) : null);

function put(path: string, content: Buffer | null) {
  if (content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  } else rmSync(path, { force: true });
}

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
      const name = `${sha256(file.path).slice(0, 12)}-${basename(file.path).slice(-64)}`;
      const saved = join(dir, `conflict-${Date.now()}-${name}`);
      if (original) writeFileSync(saved, original);
      conflicts.push(original ? `${file.path} (original saved to ${saved})` : file.path);
      continue;
    }
    put(file.path, original);
    restored.push(file.path);
  }
  return { restored, conflicts };
}

export async function withSwappedFiles<T>(
  dir: string,
  swaps: readonly FileSwap[],
  work: () => Promise<T>,
): Promise<{ value: T; conflicts: string[] }> {
  recoverSwap(dir);
  const files: PendingFile[] = swaps.map((swap) => ({
    path: swap.path,
    original: current(swap.path)?.toString("base64") ?? null,
    written: sha(swap.content),
  }));
  const path = join(dir, PENDING);
  claim(path, { pid: process.pid, files });
  holding.add(path);
  const restoreAll = () => {
    const { conflicts } = restore(dir, files);
    rmSync(path, { force: true });
    holding.delete(path);
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
  const journal = readJournal(path);
  if (!journal || held(path, journal)) return { restored: [], conflicts: [] };
  const result = restore(dir, journal.files);
  rmSync(path, { force: true });
  return result;
}
