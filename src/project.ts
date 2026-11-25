import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { stripCode } from "./lint.ts";

export interface Target {
  /** Path relative to the workspace root (ctx.cwd). */
  readonly file: string;
  readonly method?: string;
}

export interface ResolvedTarget extends Target {
  readonly gradleRoot: string;
  readonly moduleDir: string;
  readonly gradlePath: string;
  readonly className: string;
}

const SETTINGS = ["settings.gradle.kts", "settings.gradle"];

function findUp(start: string, stop: string, names: readonly string[]): string | undefined {
  let dir = start;
  for (;;) {
    if (names.some((name) => existsSync(join(dir, name)))) return dir;
    if (dir === stop || dirname(dir) === dir) return undefined;
    dir = dirname(dir);
  }
}

/**
 * Read `package` and the test class: the last top-level class or object declared before the first
 * @Test, so helper classes above it and annotations on the same line do not confuse it.
 */
export function className(source: string, file: string): string {
  const code = stripCode(source);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1];
  const firstTest = code.search(/@(org\.junit\.)?Test\b/);
  const declaration =
    /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|open|abstract|final|data|sealed)\s+)*(?:class|object)\s+(\w+)/gm;
  let name: string | undefined;
  for (const match of code.matchAll(declaration)) {
    if (firstTest >= 0 && (match.index ?? 0) > firstTest) break;
    name = match[1];
  }
  const resolved = name ?? basename(file).replace(/\.(kt|java)$/, "");
  return pkg ? `${pkg}.${resolved}` : resolved;
}

export function resolveTarget(cwd: string, target: Target): ResolvedTarget {
  const absolute = join(cwd, target.file);
  if (!existsSync(absolute)) throw new Error(`Target ${target.file} does not exist.`);
  const marker = `${sep}src${sep}`;
  const index = absolute.lastIndexOf(marker);
  if (index < 0) throw new Error(`Target ${target.file} is not inside a src/ source set.`);
  const moduleDir = absolute.slice(0, index);
  const gradleRoot = findUp(moduleDir, cwd, SETTINGS) ?? findUp(moduleDir, "/", SETTINGS);
  if (!gradleRoot) throw new Error(`No settings.gradle(.kts) above ${target.file}.`);
  const rel = relative(gradleRoot, moduleDir);
  const gradlePath = rel ? `:${rel.split(sep).join(":")}` : "";
  return {
    ...target,
    gradleRoot,
    moduleDir,
    gradlePath,
    className: className(readFileSync(absolute, "utf8"), target.file),
  };
}

export function gradleCommand(gradleRoot: string, configured: string | undefined): string {
  const wrapper = join(gradleRoot, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (existsSync(wrapper)) return wrapper;
  return configured ?? "gradle";
}

export const resultsDir = (target: ResolvedTarget, task: string) =>
  join(target.moduleDir, "build", "test-results", task);
