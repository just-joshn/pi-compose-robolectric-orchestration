import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The state of the working tree: the HEAD commit plus the content hash of every path that differs
 * from it. Without git, every file is listed. Two equal fingerprints mean identical trees.
 */
export interface Fingerprint {
  readonly head: string | null;
  readonly files: Readonly<Record<string, string>>;
}

const DELETED = "deleted";
const SKIP_DIRS = new Set([".git", "build", ".gradle", ".kotlin", ".idea", "node_modules", ".cxx"]);

const hashFile = (path: string) =>
  existsSync(path) && statSync(path).isFile()
    ? createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)
    : DELETED;

function git(cwd: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

function walk(root: string, dir: string, out: Record<string, string>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out[relative(root, join(dir, entry.name))] = hashFile(join(dir, entry.name));
    }
  }
}

function dirtyPaths(cwd: string, top: string, status: string): string[] {
  const base = realpathSync(cwd);
  const tokens = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    const code = token.slice(0, 2);
    paths.push(relative(base, join(top, token.slice(3))));
    if (code.startsWith("R") || code.startsWith("C")) {
      const original = tokens[++i];
      if (original) paths.push(relative(base, join(top, original)));
    }
  }
  return paths.filter((path) => !path.startsWith(".."));
}

export function fingerprint(cwd: string): Fingerprint {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (!head || !top || status === undefined) {
    const files: Record<string, string> = {};
    walk(cwd, cwd, files);
    return { head: null, files };
  }
  const files: Record<string, string> = {};
  for (const path of dirtyPaths(cwd, top, status)) files[path] = hashFile(join(cwd, path));
  return { head, files };
}

/** Paths whose content differs between two fingerprints of the same workspace. */
export function changedPaths(cwd: string, a: Fingerprint, b: Fingerprint): string[] {
  const changed = new Set<string>();
  for (const path of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    if (a.files[path] !== b.files[path]) changed.add(path);
  }
  if (a.head !== b.head && a.head && b.head) {
    const diff = git(cwd, ["diff", "--relative", "--name-only", a.head, b.head]) ?? "";
    for (const path of diff.split("\n").filter(Boolean)) {
      const sameDirty = a.files[path] !== undefined && a.files[path] === b.files[path];
      if (!sameDirty) changed.add(path);
    }
  }
  return [...changed].sort();
}

export const digest = (fp: Fingerprint) =>
  createHash("sha256")
    .update(fp.head ?? "")
    .update(JSON.stringify(Object.entries(fp.files).sort(([x], [y]) => x.localeCompare(y))))
    .digest("hex")
    .slice(0, 16);
