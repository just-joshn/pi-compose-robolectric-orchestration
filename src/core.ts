import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { type ResolvedTarget, resolveTarget } from "./project.ts";
import { type Exec, runTargets } from "./runner.ts";
import { addRun, currentPhase, type Run, type RunPurpose, type TestRun } from "./state.ts";
import { digest, fingerprint } from "./tree.ts";
import { workflows } from "./workflows.ts";

export interface Deps {
  readonly cwd: string;
  readonly exec: Exec;
  readonly config: Config;
  readonly dir: string;
  readonly signal?: AbortSignal;
}

export interface StepResult {
  readonly run: Run;
  readonly message: string;
}

export class WorkflowError extends Error {}
export const reject = (message: string): never => {
  throw new WorkflowError(message);
};

export const readText = (cwd: string, file: string) =>
  existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : "";

export function nextStep(run: Run): string {
  const phase = currentPhase(run);
  if (phase && run.workflow) {
    const workflow = workflows[run.workflow];
    const why = run.statusReason ? `\nReturned to this phase because: ${run.statusReason}` : "";
    return `Phase ${run.phaseIndex + 1}/${workflow.phases.length} "${phase.id}": ${phase.instruction}${why}`;
  }
  return `Workflow ${run.status}: ${run.statusReason}`;
}

const resolveAll = (run: Run, cwd: string): ResolvedTarget[] =>
  run.targets.map((target) => resolveTarget(cwd, target));

/**
 * Workflows that must preserve tests verify whole test classes, so a fix cannot pass by narrowing
 * the run to one method while sibling tests break or disappear.
 */
const WHOLE_CLASS: ReadonlySet<RunPurpose> = new Set(["verify", "stress", "measure"]);

function runnable(run: Run, purpose: RunPurpose, cwd: string): ResolvedTarget[] {
  const resolved = resolveAll(run, cwd);
  const preserves = run.workflow !== null && workflows[run.workflow].preserveTests;
  if (!WHOLE_CLASS.has(purpose) || !preserves) return resolved;
  return resolved.map(({ method: _method, ...whole }) => whole);
}

/** Run the targets and record the run. `tree` overrides the recorded tree, for runs on swapped files. */
export async function execute(
  run: Run,
  purpose: RunPurpose,
  deps: Deps,
  tree = digest(fingerprint(deps.cwd)),
): Promise<[Run, TestRun]> {
  const execution = await runTargets(
    deps.exec,
    runnable(run, purpose, deps.cwd),
    deps.config,
    deps.signal,
  );
  return addRun(run, { phase: currentPhase(run)?.id ?? "", purpose, tree, ...execution });
}

export const describeRun = (r: TestRun) => {
  const failed = r.cases.filter((c) => c.status === "failed");
  const lines = [
    `run #${r.id} (${r.purpose}): ${r.outcome}, exit ${r.exitCode}, ${r.cases.length} cases, ${failed.length} failed, ${r.seconds}s`,
    ...failed
      .slice(0, 5)
      .map((c) => `  ✗ ${c.className}.${c.name}: ${c.message ?? c.failureType ?? ""}`),
  ];
  if (r.outcome === "build-error" && r.cases.length === 0) lines.push(r.outputTail);
  return lines.join("\n");
};

export const failedCases = (r: TestRun) => r.cases.filter((c) => c.status === "failed");
