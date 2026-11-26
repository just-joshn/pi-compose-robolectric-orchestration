import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/** Inside the workspace both as written and, for an existing file, after resolving symlinks. */
export function inside(cwd: string, path: string): boolean {
  const full = resolve(cwd, path);
  return within(cwd, full) && (!existsSync(full) || within(realpathSync(cwd), realpathSync(full)));
}
