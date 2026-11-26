import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type Category = "test" | "build" | "production" | "other";

export function categorize(path: string): Category {
  const p = path.replaceAll("\\", "/");
  const build =
    /(^|\/)(buildSrc|build-logic)\/|\.gradle(\.kts)?$|(^|\/)(gradle\.properties|[\w-]+\.versions\.toml|gradle-wrapper\.properties)$/;
  if (build.test(p)) return "build";
  if (
    /(^|\/)src\/(test|androidTest|sharedTest)[A-Za-z0-9]*\/|(^|\/)robolectric\.properties$/.test(p)
  )
    return "test";
  if (/(^|\/)src\/[A-Za-z][A-Za-z0-9]*\//.test(p)) return "production";
  return "other";
}

/** Kotlin source: the test inventory and lint rules parse Kotlin only. */
export const isSource = (path: string) => path.endsWith(".kt");

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function landing(path: string): string | undefined {
  if (existsSync(path)) return realpathSync(path);
  if (lstatSync(path, { throwIfNoEntry: false })) return undefined;
  const parent = dirname(path);
  if (parent === path) return path;
  const base = landing(parent);
  return base === undefined ? undefined : join(base, basename(path));
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Where Pi's file tools resolve a path argument; mirrors Pi's resolveToCwd, which it does not export. */
export function toolPath(cwd: string, path: string): string {
  const bare = path.replace(UNICODE_SPACES, " ").replace(/^@/, "");
  if (bare === "~" || bare.startsWith("~/")) return resolve(homedir(), bare.slice(2));
  if (bare.startsWith("file://")) return fileURLToPath(bare);
  return resolve(cwd, bare);
}

/** Inside the workspace both as written and where a write would land after resolving symlinks. */
export function inside(cwd: string, path: string): boolean {
  const full = resolve(cwd, path);
  const target = landing(full);
  return within(cwd, full) && target !== undefined && within(realpathSync(cwd), target);
}
