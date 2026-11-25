import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "./config.ts";
import { finalize } from "./finalize.ts";
import { countIgnores, lintTestSource, testFunctions } from "./lint.ts";
import { categorize, isKotlinOrJava, isLocalTestPath } from "./paths.ts";
import { backtrack, changes, scopeViolations } from "./progress.ts";
import { type ResolvedTarget, resolveTarget, type Target } from "./project.ts";
import { type Exec, runTargets } from "./runner.ts";
import {
  addRun,
  advance,
  currentPhase,
  errorFindings,
  type Finding,
  finish,
  revise,
  type Run,
  type RunPurpose,
  type TestRun,
} from "./state.ts";
import { digest, fingerprint } from "./tree.ts";
import { type WorkflowId, workflows } from "./workflows.ts";
import { clearPendingMutation, recordPendingMutation } from "./workspace.ts";

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
const reject = (message: string): never => {
  throw new WorkflowError(message);
};

const RUN_KINDS = new Set(["verify-pass", "reproduce-fail", "probe", "stress", "measure"]);

export interface StartInput {
  readonly workflow: WorkflowId;
  readonly targets: readonly Target[];
  readonly subject?: readonly string[];
  readonly source?: string;
}

const readText = (cwd: string, file: string) =>
  existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), "utf8") : "";

function validateStart(run: Run, input: StartInput, cwd: string) {
  const workflow = workflows[input.workflow];
  if (run.status !== "routing")
    reject("A workflow is already running. Finish it or call compose_test_block.");
  if (run.forcedWorkflow && run.forcedWorkflow !== input.workflow)
    reject(`The operator selected the ${run.forcedWorkflow} workflow. Start that one.`);
  if (input.targets.length === 0) reject("Name at least one target file.");
  const runsTests = workflow.phases.some((p) => RUN_KINDS.has(p.kind) || p.kind === "mutation");
  const mayCreate = workflow.createsTargets;
  for (const target of input.targets) {
    if (target.file.startsWith("/") || target.file.includes(".."))
      reject(`Target ${target.file} must be relative to the workspace root.`);
    const exists = existsSync(join(cwd, target.file));
    if (runsTests && !isLocalTestPath(target.file))
      reject(
        `Target ${target.file} must be a local test under src/test (Robolectric runs local tests).`,
      );
    if (runsTests && !isKotlinOrJava(target.file))
      reject(`Target ${target.file} must be .kt or .java.`);
    if (!exists && !(runsTests && mayCreate)) reject(`Target ${target.file} does not exist.`);
  }
  for (const file of input.subject ?? []) {
    if (!existsSync(join(cwd, file))) reject(`Subject ${file} does not exist.`);
    if (categorize(file) !== "production")
      reject(`Subject ${file} is not a production source file.`);
  }
  if (workflow.needsSource) {
    if (!input.source)
      reject("The migrate workflow needs source: the androidTest file to migrate.");
    if (input.source && !/(^|\/)src\/androidTest/.test(input.source))
      reject(`Source ${input.source} is not under src/androidTest.`);
    if (input.source && !existsSync(join(cwd, input.source)))
      reject(`Source ${input.source} does not exist.`);
  }
}

export function start(run: Run, input: StartInput, cwd: string): StepResult {
  validateStart(run, input, cwd);
  const sources = input.targets.map((t) => readText(cwd, t.file));
  const started = revise(run, {
    status: "active",
    workflow: input.workflow,
    targets: input.targets.map((t) => ({
      file: t.file,
      ...(t.method ? { method: t.method } : {}),
    })),
    subject: input.subject ?? [],
    source: input.source ?? null,
    phaseIndex: 0,
    baseline: fingerprint(cwd),
    baselineIgnores: sources.reduce((n, s) => n + countIgnores(s), 0),
    baselineTests: sources.flatMap((s) => testFunctions(s).map((t) => t.name)),
  });
  return { run: started, message: `Started ${input.workflow}.\n${nextStep(started)}` };
}

export function nextStep(run: Run): string {
  const phase = currentPhase(run);
  if (phase) {
    const workflow = workflows[run.workflow ?? "write-test"];
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
  if (!WHOLE_CLASS.has(purpose) || !workflows[run.workflow ?? "write-test"].preserveTests) return resolved;
  return resolved.map(({ method: _method, ...whole }) => whole);
}

async function execute(run: Run, purpose: RunPurpose, deps: Deps): Promise<[Run, TestRun]> {
  const tree = digest(fingerprint(deps.cwd));
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

function lintChanged(run: Run, cwd: string) {
  return changes(run, cwd)
    .filter(
      (path) => categorize(path) === "test" && isKotlinOrJava(path) && existsSync(join(cwd, path)),
    )
    .flatMap((path) => lintTestSource(path, readText(cwd, path)));
}

function completeEdit(run: Run, note: string | undefined, deps: Deps): StepResult {
  const missing = run.targets.filter((t) => !existsSync(join(deps.cwd, t.file)));
  if (missing.length) reject(`Targets do not exist yet: ${missing.map((t) => t.file).join(", ")}.`);
  const violations = scopeViolations(run, deps.cwd);
  if (violations.length)
    reject(
      `This phase may not change: ${violations.join(", ")}. Revert them, then call compose_test_step again.`,
    );
  const lintErrors = errorFindings(lintChanged(run, deps.cwd));
  if (lintErrors.length)
    reject(
      `Fix these before continuing:\n${lintErrors.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.message}`).join("\n")}`,
    );
  const ignores = run.targets.reduce((n, t) => n + countIgnores(readText(deps.cwd, t.file)), 0);
  if (workflows[run.workflow ?? "write-test"].preserveTests && ignores > run.baselineIgnores)
    reject("Adding @Ignore to a target test is not allowed in this workflow.");
  if (run.source) {
    const expected = testFunctions(readText(deps.cwd, run.source)).length;
    const actual = run.targets.reduce(
      (n, t) => n + testFunctions(readText(deps.cwd, t.file)).length,
      0,
    );
    if (actual < expected)
      reject(
        `The source has ${expected} @Test cases but the targets have ${actual}. Migrate every case.`,
      );
  }
  return { run: advance(run, note), message: "Edit phase accepted." };
}

function completeNoteOnly(run: Run, note: string | undefined, deps: Deps): StepResult {
  if (!note || note.trim().length < 10)
    reject("Give a note of at least one sentence for this phase.");
  const violations = scopeViolations(run, deps.cwd);
  if (violations.length)
    reject(`This phase may not change files: ${violations.join(", ")}. Revert them.`);
  return { run: advance(run, note), message: "Phase accepted." };
}

function completeFindings(run: Run, deps: Deps): StepResult {
  const unread = run.targets.filter((t) => !run.reads.includes(t.file));
  if (unread.length)
    reject(`Read every target first. Not read yet: ${unread.map((t) => t.file).join(", ")}.`);
  const violations = changes(run, deps.cwd);
  if (violations.length) reject(`This workflow is read-only; revert: ${violations.join(", ")}.`);
  const lint: Finding[] = run.targets
    .filter((t) => isKotlinOrJava(t.file) && categorize(t.file) === "test")
    .flatMap((t) => lintTestSource(t.file, readText(deps.cwd, t.file)))
    .map((f) => ({ ...f, source: "lint" }));
  return {
    run: advance(revise(run, { findings: [...run.findings, ...lint] })),
    message: `Added ${lint.length} lint findings.`,
  };
}

const failedCases = (r: TestRun) => r.cases.filter((c) => c.status === "failed");
const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
export const testSeconds = (r: TestRun) => r.cases.reduce((sum, c) => sum + c.seconds, 0);

async function repeat(run: Run, purpose: RunPurpose, times: number, deps: Deps) {
  let current = run;
  const recorded: TestRun[] = [];
  for (let i = 0; i < times; i++) {
    const [next, r] = await execute(current, purpose, deps);
    current = next;
    recorded.push(r);
    if (r.outcome === "build-error" || r.outcome === "no-tests") break;
  }
  return { run: current, recorded };
}

async function runPhase(run: Run, deps: Deps): Promise<StepResult> {
  const phase = currentPhase(run);
  if (!phase) return { run, message: nextStep(run) };
  const violations = scopeViolations(run, deps.cwd);
  if (violations.length)
    return {
      run: backtrack(run, `Out-of-scope changes: ${violations.join(", ")}`, deps.config),
      message: `Out-of-scope changes: ${violations.join(", ")}. Revert them.`,
    };
  switch (phase.kind) {
    case "verify-pass": {
      const [next, r] = await execute(run, "verify", deps);
      if (r.outcome === "passed") return { run: advance(next), message: describeRun(r) };
      const reason = `Verification ${r.outcome}.`;
      return { run: backtrack(next, reason, deps.config), message: `${describeRun(r)}\n${reason}` };
    }
    case "reproduce-fail": {
      const [next, r] = await execute(run, "reproduce", deps);
      if (r.outcome === "failed" || r.outcome === "build-error")
        return { run: advance(next), message: `Reproduced.\n${describeRun(r)}` };
      const passes = next.runs.filter(
        (x) => x.purpose === "reproduce" && x.outcome === "passed",
      ).length;
      if (passes >= 2)
        return {
          run: finish(next, "blocked", "The failure does not reproduce locally."),
          message: describeRun(r),
        };
      return {
        run: next,
        message: `${describeRun(r)}\nDid not reproduce. Check the target and method, then call compose_test_step again.`,
      };
    }
    case "probe": {
      const { run: next, recorded } = await repeat(run, "probe", deps.config.stressRuns, deps);
      const last = recorded.at(-1);
      if (!last || last.outcome === "build-error" || last.outcome === "no-tests")
        return { run: next, message: last ? describeRun(last) : "No run." };
      const failures = recorded.filter((r) => r.outcome === "failed").length;
      return {
        run: advance(next),
        message: `Flake probe: ${failures}/${recorded.length} runs failed.\n${recorded.map(describeRun).join("\n")}`,
      };
    }
    case "stress": {
      const { run: next, recorded } = await repeat(run, "stress", deps.config.stressRuns, deps);
      const bad = recorded.filter((r) => r.outcome !== "passed");
      if (bad.length === 0 && recorded.length === deps.config.stressRuns)
        return { run: advance(next), message: `All ${recorded.length} stress runs passed.` };
      const reason = `${bad.length}/${recorded.length} stress runs did not pass.`;
      return {
        run: backtrack(next, reason, deps.config),
        message: `${reason}\n${bad.map(describeRun).join("\n")}`,
      };
    }
    case "measure":
      return measure(run, phase.id, deps);
    case "edit":
    case "explore":
    case "findings":
    case "mutation":
      return { run, message: nextStep(run) };
  }
}

async function measure(run: Run, phaseId: string, deps: Deps): Promise<StepResult> {
  const { run: next, recorded } = await repeat(run, "measure", deps.config.measureRuns, deps);
  const bad = recorded.filter((r) => r.outcome !== "passed");
  const timing = `test time per run: ${recorded.map((r) => testSeconds(r).toFixed(2)).join(", ")}s`;
  if (bad.length || recorded.length < deps.config.measureRuns) {
    const reason = `Measurement runs must all pass (${bad.length} did not).`;
    const ended =
      phaseId === "baseline"
        ? finish(next, "blocked", `${reason} Fix failing tests first.`)
        : backtrack(next, reason, deps.config);
    return { run: ended, message: `${reason}\n${bad.map(describeRun).join("\n")}` };
  }
  if (phaseId === "baseline") return { run: advance(next), message: `Baseline ${timing}` };
  const before = median(
    next.runs.filter((r) => r.purpose === "measure" && r.phase === "baseline").map(testSeconds),
  );
  const after = median(recorded.map(testSeconds));
  const speedup = before > 0 ? (before - after) / before : 0;
  const summary = `Median test time ${before.toFixed(2)}s -> ${after.toFixed(2)}s (${(speedup * 100).toFixed(1)}%).`;
  if (speedup >= deps.config.minSpeedup)
    return { run: advance(next), message: `${summary}\n${timing}` };
  const reason = `${summary} Below the required ${(deps.config.minSpeedup * 100).toFixed(0)}% improvement.`;
  return { run: backtrack(next, reason, deps.config), message: reason };
}

/** Complete the current phase, then keep executing extension-run phases until the model is needed. */
export async function step(run: Run, note: string | undefined, deps: Deps): Promise<StepResult> {
  const phase = currentPhase(run) ?? reject(`No active phase. ${nextStep(run)}`);
  const messages: string[] = [];
  let current = run;
  if (phase.kind === "mutation") reject("This phase is completed with compose_test_mutate.");
  if (phase.kind === "edit") ({ run: current } = completeEdit(current, note, deps));
  else if (phase.kind === "explore") ({ run: current } = completeNoteOnly(current, note, deps));
  else if (phase.kind === "findings") {
    const done = completeFindings(current, deps);
    current = done.run;
    messages.push(done.message);
  }
  for (;;) {
    const next = currentPhase(current);
    if (!next || !RUN_KINDS.has(next.kind) || deps.signal?.aborted) break;
    const before = current.phaseIndex;
    const result = await runPhase(current, deps);
    current = result.run;
    messages.push(result.message);
    if (current.phaseIndex <= before || current.status !== "active") break;
  }
  if (current.status === "active" && !currentPhase(current)) current = finalize(current, deps);
  messages.push(nextStep(current));
  return { run: current, message: messages.join("\n") };
}

export interface MutationInput {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

function validateMutation(run: Run, input: MutationInput, cwd: string): string {
  if (currentPhase(run)?.kind !== "mutation")
    reject(`Not in a negative-control phase. ${nextStep(run)}`);
  if (categorize(input.file) !== "production")
    reject(`${input.file} is not production source; mutate the code under test.`);
  if (run.subject.length && !run.subject.includes(input.file))
    reject(`Mutate one of the declared subject files: ${run.subject.join(", ")}.`);
  if (input.find === input.replace) reject("The replacement must change the code.");
  const text = readText(cwd, input.file);
  const count = text.split(input.find).length - 1;
  if (count !== 1)
    reject(`find must match exactly once in ${input.file}; it matched ${count} times.`);
  return text;
}

/** Apply a mutation, run the targets, and restore the file byte-for-byte, even on failure. */
export async function mutate(run: Run, input: MutationInput, deps: Deps): Promise<StepResult> {
  validateMutation(run, input, deps.cwd);
  const path = join(deps.cwd, input.file);
  const original = readFileSync(path);
  const tree = digest(fingerprint(deps.cwd));
  recordPendingMutation(deps.dir, path, original);
  let result: [Run, TestRun];
  try {
    writeFileSync(path, original.toString("utf8").replace(input.find, input.replace));
    result = await execute(run, "mutation", deps);
  } finally {
    writeFileSync(path, original);
    clearPendingMutation(deps.dir);
  }
  const [next, r] = result;
  const restored = readFileSync(path).equals(original) && digest(fingerprint(deps.cwd)) === tree;
  const detected = r.outcome === "failed" && failedCases(r).length > 0;
  const record = { ...input, runId: r.id, tree, detected, restored };
  const withRecord = revise(next, { mutations: [...next.mutations, record] });
  if (!restored)
    return {
      run: finish(withRecord, "incomplete", `Could not restore ${input.file}.`),
      message: "Restore failed.",
    };
  if (r.outcome === "build-error")
    return {
      run: withRecord,
      message: `${describeRun(r)}\nThe mutation does not compile. Choose a mutation that compiles and changes behavior.`,
    };
  if (!detected) {
    const reason = `The tests did not detect the mutation in ${input.file}. Strengthen the assertions on the behavior it changed.`;
    const back = backtrack(withRecord, reason, deps.config);
    return { run: back, message: `${describeRun(r)}\n${reason}\n${nextStep(back)}` };
  }
  let done = advance(withRecord);
  if (!currentPhase(done)) done = finalize(done, deps);
  return {
    run: done,
    message: `Mutation detected and reverted.\n${describeRun(r)}\n${nextStep(done)}`,
  };
}

export function addFinding(run: Run, finding: Omit<Finding, "source">, cwd: string): StepResult {
  if (currentPhase(run)?.kind !== "findings") reject(`Not in a findings phase. ${nextStep(run)}`);
  const text = readText(cwd, finding.file);
  if (!text) reject(`${finding.file} does not exist.`);
  const lines = text.split("\n").length;
  if (!Number.isInteger(finding.line) || finding.line < 1 || finding.line > lines)
    reject(`${finding.file} has ${lines} lines; line ${finding.line} is out of range.`);
  return {
    run: revise(run, { findings: [...run.findings, { ...finding, source: "agent" }] }),
    message: "Finding recorded.",
  };
}

/** Blocking is allowed only with evidence: the two most recent runs failed to execute any test. */
export function block(run: Run, reason: string): StepResult {
  if (run.status !== "active") reject(`No active workflow to block. ${nextStep(run)}`);
  const recent = run.runs.slice(-2);
  const evidenced =
    recent.length === 2 &&
    recent.every((r) => r.outcome === "build-error" || r.outcome === "no-tests");
  if (!evidenced)
    reject(
      "Blocking needs evidence: the two most recent extension runs must both fail to execute tests. Continue the workflow.",
    );
  const blocked = finish(
    run,
    "blocked",
    `${reason} (runs #${recent.map((r) => r.id).join(", #")} could not execute tests)`,
  );
  return { run: blocked, message: nextStep(blocked) };
}
