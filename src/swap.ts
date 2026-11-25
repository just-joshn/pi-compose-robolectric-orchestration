import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./workspace.ts";

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
const sha = (data: Buffer | null) =>
  data ? createHash("sha256").update(data).digest("hex") : null;
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
  try {
    for (const swap of swaps) put(swap.path, swap.content);
    const value = await work();
    return { value, conflicts: restore(dir, files).conflicts };
  } catch (error) {
    restore(dir, files);
    throw error;
  } finally {
    rmSync(join(dir, PENDING), { force: true });
  }
}

/** Repair swaps left behind by a crash. Idempotent. */
export function recoverSwap(dir: string): { restored: string[]; conflicts: string[] } {
  const path = join(dir, PENDING);
  if (!existsSync(path)) return { restored: [], conflicts: [] };
  const files = JSON.parse(readFileSync(path, "utf8")) as PendingFile[];
  const result = restore(dir, files);
  rmSync(path, { force: true });
  return result;
}
