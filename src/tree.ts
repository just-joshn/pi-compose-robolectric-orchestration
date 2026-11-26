import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { categorize } from "./paths.ts";

/** The working tree as HEAD plus a truncated content hash for every path that differs from it: dirty and untracked files, files git hides that sit in source sets or build files, and every file when there is no git. Build output directories are never included. */
export interface Fingerprint {
  readonly head: string | null;
  readonly files: Readonly<Record<string, string>>;
}

const OUTPUT_DIR = /(^|\/)(build|\.gradle|\.kotlin|\.idea|node_modules|\.cxx|\.git)(\/|$)/;
/** Output directories, but not a package of the same name inside a source set. */
function isOutput(path: string): boolean {
  const match = OUTPUT_DIR.exec(path);
  return match !== null && !/(^|\/)src\//.test(path.slice(0, match.index + 1));
}
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const sha = (data: Buffer | string) => sha256(data).slice(0, 16);

function hashFile(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) return `link:${sha(readlinkSync(path))}`;
  // Git status lists a submodule or nested repository as one directory entry.
  if (stat?.isDirectory()) return `dir:${digest(fingerprint(path))}`;
  return stat?.isFile() ? sha(readFileSync(path)) : "deleted";
}

function git(cwd: string, args: readonly string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

function walk(root: string, dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return isOutput(`${relative(root, path)}/`) ? [] : walk(root, path);
    return [relative(root, path)];
  });
}

function dirtyPaths(cwd: string, top: string, status: string): string[] {
  const base = realpathSync(cwd);
  const tokens = status.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    paths.push(token.slice(3));
    if (/[RC]/.test(token.slice(0, 2))) paths.push(tokens[++i] ?? "");
  }
  return paths
    .map((p) => relative(base, join(top, p)))
    .filter((p) => p !== ".." && !p.startsWith(`..${sep}`) && !isOutput(`${dirname(p)}/`));
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
    .filter((entry) => entry && !isOutput(entry))
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

export function committed(cwd: string, head: string, path: string): Buffer | null {
  const shown = spawnSync("git", ["show", `${head}:./${path}`], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return shown.status === 0 ? shown.stdout : null;
}

function contentAt(cwd: string, fp: Fingerprint, path: string): string {
  const own = fp.files[path];
  if (own !== undefined || !fp.head) return own ?? "deleted";
  const content = committed(cwd, fp.head, path);
  return content ? sha(content) : "deleted";
}

export function changedPaths(cwd: string, a: Fingerprint, b: Fingerprint): string[] {
  const inCommits =
    a.head && b.head && a.head !== b.head
      ? (
          git(cwd, ["diff", "-z", "--relative", "--no-renames", "--name-only", a.head, b.head]) ??
          ""
        )
          .split("\0")
          .filter(Boolean)
      : [];
  const paths = new Set([...Object.keys(a.files), ...Object.keys(b.files), ...inCommits]);
  return [...paths].filter((p) => contentAt(cwd, a, p) !== contentAt(cwd, b, p)).toSorted();
}

export const digest = (fp: Fingerprint) =>
  sha(
    `${fp.head ?? ""}\n${Object.keys(fp.files)
      .toSorted()
      .map((p) => `${p}\0${fp.files[p]}`)
      .join("\n")}`,
  );
