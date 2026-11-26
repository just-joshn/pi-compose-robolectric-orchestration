import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Category = "test" | "build" | "production" | "other";

export function categorize(path: string): Category {
  const p = path.replaceAll("\\", "/");
  if (/(^|\/)src\/(test|androidTest|sharedTest)[A-Za-z]*\/|(^|\/)robolectric\.properties$/.test(p))
    return "test";
  if (
    /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|libs\.versions\.toml|gradle-wrapper\.properties)$/.test(
      p,
    )
  )
    return "build";
  if (/(^|\/)src\/[A-Za-z]+\//.test(p)) return "production";
  return "other";
}

/** Kotlin source: the test inventory and lint rules parse Kotlin only. */
export const isSource = (path: string) => path.endsWith(".kt");

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Where a write to `path` lands: its deepest existing ancestor resolved; undefined for a dangling symlink. */
function landing(path: string): string | undefined {
  if (existsSync(path)) return realpathSync(path);
  if (lstatSync(path, { throwIfNoEntry: false })) return undefined;
  const parent = dirname(path);
  if (parent === path) return path;
  const base = landing(parent);
  return base === undefined ? undefined : join(base, basename(path));
}

/** Inside the workspace both as written and where a write would land after resolving symlinks. */
export function inside(cwd: string, path: string): boolean {
  const full = resolve(cwd, path);
  const target = landing(full);
  return within(cwd, full) && target !== undefined && within(realpathSync(cwd), target);
}
