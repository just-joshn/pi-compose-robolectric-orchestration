import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isStringRecord } from "./guards.ts";
import { countIgnores, lintTestSource, testFunctions } from "./lint.ts";
import { backtrack, finish, type Run, type TestRun } from "./state.ts";
import { atomicWrite } from "./swap.ts";
import { changedPaths, digest, type Fingerprint, fingerprint } from "./tree.ts";
import { allowedChanges, categorize, isSource, workflows } from "./workflows.ts";

export const read = (cwd: string, file: string) =>
  existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : "";

export const changes = (run: Run, cwd: string) =>
  run.baseline ? changedPaths(cwd, run.baseline, fingerprint(cwd)) : [];

export function scopeViolations(run: Run, cwd: string): string[] {
  const phases = run.workflow ? workflows[run.workflow].phases.slice(0, run.phaseIndex + 1) : [];
  const allowed = new Set(phases.flatMap((p) => p.scope));
  return changes(run, cwd).filter((path) => !allowed.has(categorize(path)));
}

/** Save the test and production files that were already uncommitted at start; clean files are read back from git. */
export function saveSnapshot(cwd: string, baseline: Fingerprint, dir: string): string {
  const files: Record<string, string> = {};
  for (const path of Object.keys(baseline.files)) {
    const category = categorize(path);
    if ((category === "test" || category === "production") && existsSync(join(cwd, path)))
      files[path] = readFileSync(join(cwd, path)).toString("base64");
  }
  const file = join(dir, `baseline-${Date.now()}.json`);
  atomicWrite(file, JSON.stringify(files));
  return file;
}

function readSnapshot(file: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isStringRecord(parsed)) throw new Error(`${file} is not a baseline snapshot.`);
  return parsed;
}

export function baselineContent(cwd: string, run: Run, path: string): Buffer | null {
  const { baseline, snapshot } = run;
  if (!baseline) return null;
  if (baseline.files[path] !== undefined || baseline.head === null) {
    const saved = snapshot && existsSync(snapshot) ? readSnapshot(snapshot)[path] : undefined;
    return saved === undefined ? null : Buffer.from(saved, "base64");
  }
  const shown = spawnSync("git", ["show", `${baseline.head}:./${path}`], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return shown.status === 0 ? shown.stdout : null;
}

/**
 * Test files that lost @Test functions, gained @Ignore, or were deleted. A refactor's targets may
 * merge tests, and a migration may delete the source it moved.
 */
export function weakenedTests(run: Run, cwd: string, changed: readonly string[]): string[] {
  const reshape = new Set(
    run.workflow === "refactor" ? run.targets.map((t) => t.file) : run.source ? [run.source] : [],
  );
  const weakened: string[] = [];
  for (const path of changed.filter((p) => categorize(p) === "test" && isSource(p))) {
    const before = baselineContent(cwd, run, path)?.toString("utf8");
    if (before === undefined) continue;
    const exists = existsSync(join(cwd, path));
    const after = exists ? read(cwd, path) : "";
    if (!exists && !reshape.has(path)) weakened.push(`${path} was deleted`);
    const names = new Set(testFunctions(after).map((t) => t.name));
    const lost = testFunctions(before).filter((t) => !names.has(t.name));
    if (exists && lost.length && !reshape.has(path))
      weakened.push(`${path} lost tests: ${lost.map((t) => t.name).join(", ")}`);
    if (countIgnores(after) > countIgnores(before)) weakened.push(`${path} gained @Ignore`);
  }
  return weakened;
}

export function editProblem(run: Run, cwd: string): string | undefined {
  const missing = run.targets.filter((t) => !existsSync(join(cwd, t.file)));
  if (missing.length) return `Targets do not exist yet: ${missing.map((t) => t.file).join(", ")}.`;
  const violations = scopeViolations(run, cwd);
  if (violations.length)
    return `This phase may not change: ${violations.join(", ")}. Revert them, then call compose_test_step again.`;
  const changed = changes(run, cwd);
  const lint = lintErrors(cwd, changed).map((f) => `${f.file}:${f.line} ${f.rule}: ${f.message}`);
  if (lint.length) return `Fix these before continuing:\n${lint.join("\n")}`;
  const weakened = weakenedTests(run, cwd, changed);
  if (weakened.length) return `Tests may not be weakened: ${weakened.join("; ")}. Restore them.`;
  if (!run.source) return undefined;
  const source = baselineContent(cwd, run, run.source)?.toString("utf8") ?? read(cwd, run.source);
  const expected = testFunctions(source).length;
  const actual = run.targets.reduce((n, t) => n + testFunctions(read(cwd, t.file)).length, 0);
  if (actual < expected)
    return `The source has ${expected} @Test cases but the targets have ${actual}. Migrate every case.`;
  return undefined;
}

export const lintErrors = (cwd: string, changed: readonly string[]) =>
  changed
    .filter((p) => categorize(p) === "test" && isSource(p) && existsSync(join(cwd, p)))
    .flatMap((p) => lintTestSource(p, read(cwd, p)))
    .filter((f) => f.severity === "error");

const passed = (r: TestRun, name: string) =>
  r.cases.some((c) => c.status === "passed" && (c.name === name || c.name.startsWith(`${name}[`)));

function problems(run: Run, cwd: string): string[] {
  if (!run.workflow) return ["No workflow ran."];
  const workflow = workflows[run.workflow];
  const kinds = new Set(workflow.phases.map((p) => p.kind));
  const changed = changes(run, cwd);
  const found: string[] = [];
  const allowed = allowedChanges(run.workflow);
  const outside = changed.filter((p) => !allowed.has(categorize(p)));
  if (outside.length)
    found.push(`Changed files this workflow may not change: ${outside.join(", ")}.`);

  const lastPass = run.runs.findLast(
    (r) => r.outcome === "passed" && ["verify", "stress", "measure"].includes(r.purpose),
  );
  if (kinds.has("verify") || kinds.has("stress") || kinds.has("measure")) {
    if (!lastPass) found.push("No passing run was recorded.");
    else if (lastPass.tree !== digest(fingerprint(cwd)))
      found.push(`The tree changed after the last passing run (#${lastPass.id}).`);
  }
  if (kinds.has("mutation") || kinds.has("regression")) {
    const proofs = [
      ...run.mutations.filter((m) => m.detected).map((m) => m.tree),
      ...run.runs
        .filter((r) => r.purpose === "regression" && r.outcome === "failed")
        .map((r) => r.tree),
    ];
    if (!lastPass || !proofs.includes(lastPass.tree))
      found.push(
        "No negative control or regression check proved the tests detect the behavior on the final tree.",
      );
  }
  if (workflow.preserveTests && lastPass) {
    const lost = run.baselineTests.filter((name) => !passed(lastPass, name));
    if (lost.length) found.push(`Original tests missing or not passing: ${lost.join(", ")}.`);
  }
  found.push(...weakenedTests(run, cwd, changed).map((p) => `Weakened tests: ${p}.`));
  const lint = lintErrors(cwd, changed);
  if (lint.length)
    found.push(
      `Lint errors in changed tests: ${lint.map((f) => `${f.file}:${f.line} ${f.rule}`).join(", ")}.`,
    );
  return found;
}

/** Decide the final status. A failed check sends the run back to its edit phase while retries remain. */
export function finalize(run: Run, cwd: string): Run {
  const found = problems(run, cwd);
  if (found.length === 0) return finish(run, "verified", "All checks passed.");
  const back = backtrack(run, found.join(" "));
  return back.status === "active" ? back : finish(run, "incomplete", found.join(" "));
}

export function recheck(run: Run, cwd: string): Run {
  if (run.status !== "verified") return run;
  const found = problems(run, cwd);
  if (found.length === 0) return run;
  const reason = `Files changed after verification. ${found.join(" ")}`;
  const phases = workflows[run.workflow ?? "review"].phases.length;
  const back = backtrack({ ...run, status: "active", phaseIndex: phases }, reason);
  return back.status === "active" ? back : finish(run, "incomplete", reason);
}
