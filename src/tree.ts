import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

import { categorize } from "./paths.ts";

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

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** Content hash of a file, or of a symlink's target path; never follows links out of the tree. */
function hashFile(path: string): string {
  if (!existsSync(path) && !isLink(path)) return DELETED;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `link:${sha(readlinkSync(path))}`;
  return stat.isFile() ? sha(readFileSync(path)) : DELETED;
}

function isLink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function git(cwd: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

function walk(root: string, dir: string, out: Record<string, string>) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, join(dir, entry.name), out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
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
    if (/[RC]/.test(code)) {
      const original = tokens[++i];
      if (original) paths.push(relative(base, join(top, original)));
    }
  }
  return paths.filter((path) => !path.startsWith(".."));
}

/**
 * Paths git status cannot see but a workflow must: files flagged assume-unchanged or
 * skip-worktree, and ignored files inside source sets or build files. Build output stays out.
 */
function hiddenPaths(cwd: string): string[] {
  const flagged = (git(cwd, ["ls-files", "-v", "-z", "--", "."]) ?? "")
    .split("\0")
    .filter((entry) => /^[a-zS] /.test(entry))
    .map((entry) => entry.slice(2));
  const ignored = (git(cwd, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", "."]) ?? "")
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => (entry.endsWith("/") ? expandIgnoredDir(cwd, entry) : [entry]))
    .filter((path) => categorize(path) !== "other" && !/(^|\/)(build|\.gradle|\.kotlin)\//.test(path));
  return [...flagged, ...ignored];
}

function expandIgnoredDir(cwd: string, dir: string): string[] {
  if (/(^|\/)(build|\.gradle|\.kotlin|\.idea|node_modules|\.cxx)\/$/.test(dir) || categorize(`${dir}x.kt`) === "other") return [];
  const out: Record<string, string> = {};
  walk(cwd, join(cwd, dir), out);
  return Object.keys(out);
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
  for (const path of [...dirtyPaths(cwd, top, status), ...hiddenPaths(cwd)]) files[path] = hashFile(join(cwd, path));
  return { head, files };
}

/** Paths whose content differs between two fingerprints of the same workspace. */
export function changedPaths(cwd: string, a: Fingerprint, b: Fingerprint): string[] {
  const changed = new Set<string>();
  for (const path of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    if (a.files[path] !== b.files[path]) changed.add(path);
  }
  if (a.head !== b.head && a.head && b.head) {
    const diff = git(cwd, ["diff", "--relative", "--no-renames", "--name-only", a.head, b.head]) ?? "";
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
    .update(JSON.stringify(Object.entries(fp.files).toSorted(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))))
    .digest("hex")
    .slice(0, 16);
