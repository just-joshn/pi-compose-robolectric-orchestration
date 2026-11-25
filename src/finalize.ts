import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { countIgnores, lintTestSource } from "./lint.ts";
import { categorize, isKotlinOrJava } from "./paths.ts";
import { backtrack, changes } from "./progress.ts";
import { errorFindings, finish, lastRun, type Run, type TestRun } from "./state.ts";
import { digest, fingerprint } from "./tree.ts";
import { workflows } from "./workflows.ts";

const passingRuns = (run: Run) =>
  run.runs.filter(
    (r) => r.outcome === "passed" && r.purpose !== "mutation" && r.purpose !== "probe",
  );

const hasCase = (r: TestRun, name: string) =>
  r.cases.some((c) => c.status === "passed" && (c.name === name || c.name.startsWith(`${name}[`)));

const read = (cwd: string, file: string) =>
  existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : "";

/** Every check the final status depends on. Each returns a problem or nothing. */
function problems(run: Run, deps: { cwd: string; config: Config }): string[] {
  const workflow = workflows[run.workflow ?? "write-test"];
  const found: string[] = [];
  const changed = changes(run, deps.cwd);
  const outside = changed.filter((path) => !workflow.allowedChanges.includes(categorize(path)));
  if (outside.length)
    found.push(`Changed files this workflow may not change: ${outside.join(", ")}.`);

  const executes = workflow.phases.some((p) =>
    ["verify-pass", "stress", "measure"].includes(p.kind),
  );
  const lastPass = passingRuns(run).at(-1);
  const tree = digest(fingerprint(deps.cwd));
  if (executes && !lastPass) found.push("No passing run was recorded.");
  if (executes && lastPass && lastPass.tree !== tree)
    found.push(
      `The tree changed after the last passing run (#${lastPass.id}); it must be verified again.`,
    );

  if (workflow.phases.some((p) => p.kind === "mutation")) {
    const mutation = [...run.mutations].reverse().find((m) => m.detected && m.restored);
    if (!mutation) found.push("No detected and restored negative-control mutation was recorded.");
    else if (lastPass && mutation.tree !== lastPass.tree)
      found.push("The negative control ran against a different tree than the last passing run.");
  }

  if (workflow.preserveTests && lastPass) {
    const lost = run.baselineTests.filter((name) => !hasCase(lastPass, name));
    if (lost.length) found.push(`Original tests missing or not passing: ${lost.join(", ")}.`);
    const ignores = run.targets.reduce((n, t) => n + countIgnores(read(deps.cwd, t.file)), 0);
    if (ignores > run.baselineIgnores) found.push("A target test was @Ignored.");
  }

  const lintErrors = errorFindings(
    changed
      .filter(
        (path) =>
          categorize(path) === "test" && isKotlinOrJava(path) && existsSync(join(deps.cwd, path)),
      )
      .flatMap((path) => lintTestSource(path, read(deps.cwd, path))),
  );
  if (lintErrors.length)
    found.push(
      `Lint errors in changed tests: ${lintErrors.map((f) => `${f.file}:${f.line} ${f.rule}`).join(", ")}.`,
    );
  return found;
}

/** Decide the final status. A failed check sends the run back to edit instead of ending it. */
export function finalize(run: Run, deps: { cwd: string; config: Config }): Run {
  const found = problems(run, deps);
  if (found.length === 0) {
    const last = lastRun(run);
    return finish(
      run,
      "verified",
      last ? `All checks passed; last run #${last.id}.` : "All checks passed.",
    );
  }
  const reason = found.join(" ");
  const back = backtrack(run, reason, deps.config);
  return back.status === "active" ? back : finish(run, "incomplete", reason);
}
