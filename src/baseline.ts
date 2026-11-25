import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { countIgnores, testFunctions } from "./lint.ts";
import { categorize, isKotlinOrJava } from "./paths.ts";
import type { Fingerprint } from "./tree.ts";
import { atomicWrite } from "./workspace.ts";

/**
 * Save the content of every test and production file that differed from HEAD when the workflow
 * started. Clean files are read back from git, so only uncommitted work is stored.
 */
export function saveSnapshot(cwd: string, baseline: Fingerprint, dir: string): string {
  const files: Record<string, string> = {};
  for (const path of Object.keys(baseline.files)) {
    if (categorize(path) === "other" || categorize(path) === "build") continue;
    if (existsSync(join(cwd, path))) files[path] = readFileSync(join(cwd, path)).toString("base64");
  }
  const file = join(dir, `baseline-${Date.now()}-${process.pid}.json`);
  atomicWrite(file, JSON.stringify(files));
  return file;
}

/** A file's content when the workflow started, or null if it did not exist then. */
export function baselineContent(
  cwd: string,
  baseline: Fingerprint,
  snapshot: string | null,
  path: string,
): Buffer | null {
  if (baseline.files[path] !== undefined || baseline.head === null) {
    if (!snapshot || !existsSync(snapshot)) return null;
    const saved = (JSON.parse(readFileSync(snapshot, "utf8")) as Record<string, string>)[path];
    return saved === undefined ? null : Buffer.from(saved, "base64");
  }
  const shown = spawnSync("git", ["show", `${baseline.head}:./${path}`], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return shown.status === 0 ? shown.stdout : null;
}

/**
 * Test files that lost @Test functions, gained @Ignore, or disappeared since the workflow
 * started. `exempt` files (a refactor's own targets) may merge or drop tests but not gain @Ignore.
 */
export function weakenedTests(
  cwd: string,
  baseline: Fingerprint,
  snapshot: string | null,
  changed: readonly string[],
  exempt: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const path of changed) {
    if (categorize(path) !== "test" || !isKotlinOrJava(path)) continue;
    const before = baselineContent(cwd, baseline, snapshot, path)?.toString("utf8");
    if (before === undefined) continue;
    if (!existsSync(join(cwd, path)) && !exempt.has(path)) {
      problems.push(`${path} was deleted`);
      continue;
    }
    const after = existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), "utf8") : "";
    const names = new Set(testFunctions(after).map((t) => t.name));
    const lost = testFunctions(before)
      .map((t) => t.name)
      .filter((name) => !names.has(name));
    if (lost.length && !exempt.has(path)) problems.push(`${path} lost tests: ${lost.join(", ")}`);
    if (countIgnores(after) > countIgnores(before)) problems.push(`${path} gained @Ignore`);
  }
  return problems;
}

/**
 * Test files a workflow may reshape: a refactor's targets may merge or drop tests, and a
 * migration may delete the instrumented source it moved.
 */
export function reshapeable(
  workflow: string | null,
  targets: readonly { file: string }[],
  source: string | null,
) {
  if (workflow === "refactor") return new Set(targets.map((t) => t.file));
  if (workflow === "migrate" && source) return new Set([source]);
  return new Set<string>();
}
