import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

import { categorize } from "./workflows.ts";

/**
 * The working tree: the HEAD commit plus a content hash for every path that differs from it
 * (every file, without git). Equal fingerprints mean identical trees.
 */
export interface Fingerprint {
  readonly head: string | null;
  readonly files: Readonly<Record<string, string>>;
}

const OUTPUT_DIR = /(^|\/)(build|\.gradle|\.kotlin|\.idea|node_modules|\.cxx|\.git)(\/|$)/;
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const sha = (data: Buffer | string) => sha256(data).slice(0, 16);

/** Hash a file, or a symlink's target path without following it. */
function hashFile(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) return `link:${sha(readlinkSync(path))}`;
  return stat?.isFile() ? sha(readFileSync(path)) : "deleted";
}

function git(cwd: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

function walk(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return OUTPUT_DIR.test(`${entry.name}/`) ? [] : walk(root, path);
    return [relative(root, path)];
  });
}

/** Paths from `git status -z`, made relative to cwd; renames list both sides. */
function dirtyPaths(cwd: string, top: string, status: string): string[] {
  const base = realpathSync(cwd);
  const tokens = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    paths.push(token.slice(3));
    if (/[RC]/.test(token.slice(0, 2))) paths.push(tokens[++i] ?? "");
  }
  return paths.map((p) => relative(base, join(top, p))).filter((p) => !p.startsWith(".."));
}

/**
 * Paths git status hides but a workflow must see: files flagged assume-unchanged or
 * skip-worktree, and ignored files in source sets or build files.
 */
function hiddenPaths(cwd: string): string[] {
  const flagged = (git(cwd, ["ls-files", "-v", "-z", "--", "."]) ?? "")
    .split("\0")
    .filter((entry) => /^[a-zS] /.test(entry))
    .map((entry) => entry.slice(2));
  const ignored = (
    git(cwd, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--",
      ".",
    ]) ?? ""
  )
    .split("\0")
    .filter((entry) => entry && !OUTPUT_DIR.test(entry))
    .flatMap((entry) => (entry.endsWith("/") ? walk(cwd, join(cwd, entry)) : [entry]))
    .filter((path) => categorize(path) !== "other");
  return [...flagged, ...ignored];
}

export function fingerprint(cwd: string): Fingerprint {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  const gitAware = head && top && status !== undefined;
  const paths = gitAware ? [...dirtyPaths(cwd, top, status), ...hiddenPaths(cwd)] : walk(cwd, cwd);
  return {
    head: gitAware ? head : null,
    files: Object.fromEntries(paths.map((p) => [p, hashFile(join(cwd, p))])),
  };
}

/** Paths whose content differs between two fingerprints of the same workspace. */
export function changedPaths(cwd: string, a: Fingerprint, b: Fingerprint): string[] {
  const changed = new Set(
    [...Object.keys(a.files), ...Object.keys(b.files)].filter((p) => a.files[p] !== b.files[p]),
  );
  if (a.head && b.head && a.head !== b.head)
    for (const path of (
      git(cwd, ["diff", "--relative", "--no-renames", "--name-only", a.head, b.head]) ?? ""
    ).split("\n"))
      if (path && (a.files[path] === undefined || a.files[path] !== b.files[path]))
        changed.add(path);
  return [...changed].toSorted();
}

export const digest = (fp: Fingerprint) =>
  sha(
    `${fp.head ?? ""}\n${Object.keys(fp.files)
      .toSorted()
      .map((p) => `${p}\0${fp.files[p]}`)
      .join("\n")}`,
  );
