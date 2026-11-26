import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { categorize } from "./paths.ts";

export interface Fingerprint {
  readonly head: string | null;
  readonly files: Readonly<Record<string, string>>;
}

const OUTPUT_DIR = /(^|\/)(build|\.gradle|\.kotlin|\.idea|node_modules|\.cxx|\.git)(\/|$)/;
function isOutput(path: string): boolean {
  const match = OUTPUT_DIR.exec(path);
  return match !== null && !/(^|\/)src\//.test(path.slice(0, match.index + 1));
}
export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const sha = (data: Buffer | string) => sha256(data).slice(0, 16);

const tracksFileMode = (cwd: string) =>
  git(cwd, ["config", "--bool", "core.fileMode"])?.trim() !== "false";

function hashFile(path: string, fileMode: boolean): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) return `link:${sha(readlinkSync(path))}`;
  // Git status lists a submodule or nested repository as one directory entry.
  if (stat?.isDirectory()) return `dir:${digest(fingerprint(path))}`;
  return stat?.isFile()
    ? `${fileMode ? (stat.mode & 0o111 ? "100755" : "100644") : "file"}:${sha(readFileSync(path))}`
    : "deleted";
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
  const fileMode = tracksFileMode(cwd);
  const paths = gitAware ? [...dirtyPaths(cwd, top, status), ...hiddenPaths(cwd)] : walk(cwd, cwd);
  return {
    head: gitAware ? head : null,
    files: Object.fromEntries(paths.map((p) => [p, hashFile(join(cwd, p), fileMode)])),
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
  if (!content) return "deleted";
  const mode = git(cwd, ["ls-tree", fp.head, "--", `./${path}`])?.slice(0, 6);
  return mode === "120000"
    ? `link:${sha(content)}`
    : `${tracksFileMode(cwd) ? mode : "file"}:${sha(content)}`;
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
