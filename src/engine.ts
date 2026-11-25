import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  baselineContent,
  changes,
  finalize,
  lintErrors,
  read,
  saveSnapshot,
  scopeViolations,
  weakenedTests,
} from "./checks.ts";
import { type Exec, runTargets, type Target } from "./gradle.ts";
import { lintTestSource, testFunctions } from "./lint.ts";
import {
  addRun,
  advance,
  backtrack,
  currentPhase,
  type Finding,
  finish,
  type Purpose,
  revise,
  type Run,
  type TestRun,
} from "./state.ts";
import { stateDir, withSwappedFiles } from "./swap.ts";
import { digest, fingerprint } from "./tree.ts";
import { categorize, isSource, type WorkflowId, workflows } from "./workflows.ts";

export interface Deps {
  readonly cwd: string;
  readonly exec: Exec;
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

const STRESS_RUNS = 5;
const MEASURE_RUNS = 3;
const MIN_SPEEDUP = 0.05;
const MODEL_KINDS = new Set(["edit", "findings", "mutation"]);

export function nextStep(run: Run): string {
  const phase = currentPhase(run);
  if (!phase || !run.workflow) return `Workflow ${run.status}: ${run.statusReason}`;
  const why = run.statusReason ? `\nReturned to this phase because: ${run.statusReason}` : "";
  return `Phase ${run.phaseIndex + 1}/${workflows[run.workflow].phases.length} "${phase.id}": ${phase.instruction}${why}`;
}

export interface StartInput {
  readonly workflow: WorkflowId;
  readonly targets: readonly Target[];
  readonly subject?: readonly string[];
  readonly source?: string;
}

function validateStart(run: Run, input: StartInput, cwd: string) {
  const workflow = workflows[input.workflow];
  const runsTests = input.workflow !== "review";
  if (run.status !== "routing") reject("A workflow is already running.");
  if (run.forcedWorkflow && run.forcedWorkflow !== input.workflow)
    reject(`The operator selected the ${run.forcedWorkflow} workflow. Start that one.`);
  if (input.targets.length === 0) reject("Name at least one target file.");
  for (const { file } of input.targets) {
    if (file.startsWith("/") || file.includes(".."))
      reject(`Target ${file} must be relative to the workspace root.`);
    if (runsTests && !/(^|\/)src\/test[A-Za-z]*\/.*\.(kt|java)$/.test(file))
      reject(
        `Target ${file} must be a .kt or .java test under src/test (Robolectric runs local tests).`,
      );
    if (!existsSync(join(cwd, file)) && !workflow.createsTargets)
      reject(`Target ${file} does not exist.`);
  }
  for (const file of input.subject ?? [])
    if (categorize(file) !== "production" || !existsSync(join(cwd, file)))
      reject(`Subject ${file} is not an existing production source file.`);
  if (
    input.workflow === "migrate" &&
    !(
      input.source &&
      /(^|\/)src\/androidTest\//.test(input.source) &&
      existsSync(join(cwd, input.source))
    )
  )
    reject("migrate needs source: an existing androidTest file.");
}

export function start(run: Run, input: StartInput, cwd: string, dir = stateDir(cwd)): StepResult {
  validateStart(run, input, cwd);
  const baseline = fingerprint(cwd);
  const started = revise(run, {
    status: "active",
    workflow: input.workflow,
    targets: input.targets.map(({ file, method }) => ({ file, ...(method ? { method } : {}) })),
    subject: input.subject ?? [],
    source: input.source ?? null,
    phaseIndex: 0,
    baseline,
    snapshot: saveSnapshot(cwd, baseline, dir),
    baselineTests: input.targets.flatMap((t) =>
      testFunctions(read(cwd, t.file)).map((f) => f.name),
    ),
  });
  return { run: started, message: `Started ${input.workflow}.\n${nextStep(started)}` };
}

/** Test-preserving workflows verify whole classes, so sibling tests cannot break or disappear unseen. */
async function execute(
  run: Run,
  purpose: Purpose,
  deps: Deps,
  tree = digest(fingerprint(deps.cwd)),
): Promise<[Run, TestRun]> {
  const whole =
    run.workflow !== null &&
    workflows[run.workflow].preserveTests &&
    ["verify", "stress", "measure"].includes(purpose);
  const targets = whole ? run.targets.map(({ file }) => ({ file })) : run.targets;
  const execution = await runTargets(deps.exec, deps.cwd, targets, deps.signal);
  return addRun(run, { phase: currentPhase(run)?.id ?? "", purpose, tree, ...execution });
}

export function describeRun(r: TestRun): string {
  const failed = r.cases.filter((c) => c.status === "failed");
  return [
    `run #${r.id} (${r.purpose}): ${r.outcome}, ${r.cases.length} cases, ${failed.length} failed, ${r.seconds}s`,
    ...failed.slice(0, 5).map((c) => `  ✗ ${c.className}.${c.name}: ${c.message ?? ""}`),
    ...(r.outcome === "build-error" && r.cases.length === 0 ? [r.outputTail] : []),
  ].join("\n");
}

const detected = (r: TestRun) =>
  r.outcome === "failed" && r.cases.some((c) => c.status === "failed");
const testSeconds = (r: TestRun) => r.cases.reduce((sum, c) => sum + c.seconds, 0);
const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

function completeEdit(run: Run, deps: Deps): Run {
  const missing = run.targets.filter((t) => !existsSync(join(deps.cwd, t.file)));
  if (missing.length) reject(`Targets do not exist yet: ${missing.map((t) => t.file).join(", ")}.`);
  const violations = scopeViolations(run, deps.cwd);
  if (violations.length)
    reject(
      `This phase may not change: ${violations.join(", ")}. Revert them, then call compose_test_step again.`,
    );
  const changed = changes(run, deps.cwd);
  const lint = lintErrors(deps.cwd, changed);
  if (lint.length)
    reject(
      `Fix these before continuing:\n${lint.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.message}`).join("\n")}`,
    );
  const weakened = weakenedTests(run, deps.cwd, changed);
  if (weakened.length) reject(`Tests may not be weakened: ${weakened.join("; ")}. Restore them.`);
  if (run.source) {
    const expected = testFunctions(
      baselineContent(deps.cwd, run, run.source)?.toString("utf8") ?? read(deps.cwd, run.source),
    ).length;
    const actual = run.targets.reduce(
      (n, t) => n + testFunctions(read(deps.cwd, t.file)).length,
      0,
    );
    if (actual < expected)
      reject(
        `The source has ${expected} @Test cases but the targets have ${actual}. Migrate every case.`,
      );
  }
  return advance(run);
}

function completeFindings(run: Run, deps: Deps): Run {
  const unread = run.targets.filter((t) => !run.reads.includes(t.file));
  if (unread.length)
    reject(`Read every target first. Not read yet: ${unread.map((t) => t.file).join(", ")}.`);
  const changed = changes(run, deps.cwd);
  if (changed.length) reject(`Review is read-only; revert: ${changed.join(", ")}.`);
  const lint = run.targets
    .filter((t) => isSource(t.file) && categorize(t.file) === "test")
    .flatMap((t) => lintTestSource(t.file, read(deps.cwd, t.file)))
    .map((f): Finding => ({ ...f, source: "lint" }));
  return advance(revise(run, { findings: [...run.findings, ...lint] }));
}

async function repeat(run: Run, purpose: Purpose, times: number, deps: Deps) {
  let current = run;
  const recorded: TestRun[] = [];
  for (let i = 0; i < times && recorded.at(-1)?.outcome !== "build-error"; i++) {
    const [next, r] = await execute(current, purpose, deps);
    current = next;
    recorded.push(r);
  }
  return { run: current, recorded };
}

/** Run one extension-owned phase. */
async function runPhase(run: Run, deps: Deps): Promise<StepResult> {
  const phase = currentPhase(run);
  const violations = scopeViolations(run, deps.cwd);
  if (violations.length) {
    const reason = `Out-of-scope changes: ${violations.join(", ")}. Revert them.`;
    return { run: backtrack(run, reason), message: reason };
  }
  switch (phase?.kind) {
    case "verify": {
      const [next, r] = await execute(run, "verify", deps);
      if (r.outcome === "passed") return { run: advance(next), message: describeRun(r) };
      const reason =
        run.phaseIndex === 0
          ? "The tests fail before any change. This workflow needs a passing baseline; fix the failures first (fix-failing)."
          : `Verification ${r.outcome}.`;
      return { run: backtrack(next, reason), message: `${describeRun(r)}\n${reason}` };
    }
    case "reproduce": {
      const [next, r] = await execute(run, "reproduce", deps);
      if (r.outcome === "failed" || r.outcome === "build-error")
        return { run: advance(next), message: `Reproduced.\n${describeRun(r)}` };
      if (next.runs.filter((x) => x.purpose === "reproduce").length >= 2)
        return {
          run: finish(next, "blocked", "The failure does not reproduce locally."),
          message: describeRun(r),
        };
      return {
        run: next,
        message: `${describeRun(r)}\nDid not reproduce. Check the target and method, then call compose_test_step again.`,
      };
    }
    case "stress": {
      const { run: next, recorded } = await repeat(run, "stress", STRESS_RUNS, deps);
      const bad = recorded.filter((r) => r.outcome !== "passed");
      if (bad.length === 0)
        return { run: advance(next), message: `All ${STRESS_RUNS} stress runs passed.` };
      const reason = `${bad.length}/${recorded.length} stress runs did not pass.`;
      return {
        run: backtrack(next, reason),
        message: `${reason}\n${bad.map(describeRun).join("\n")}`,
      };
    }
    case "measure":
      return measure(run, phase.id, deps);
    case "regression":
      return regressionCheck(run, deps);
    case undefined:
    case "edit":
    case "findings":
    case "mutation":
      return { run, message: nextStep(run) };
  }
}

async function measure(run: Run, phaseId: string, deps: Deps): Promise<StepResult> {
  const { run: next, recorded } = await repeat(run, "measure", MEASURE_RUNS, deps);
  const timing = `test time per run: ${recorded.map((r) => testSeconds(r).toFixed(2)).join(", ")}s`;
  if (recorded.some((r) => r.outcome !== "passed")) {
    const reason = "Every measurement run must pass.";
    return {
      run:
        phaseId === "baseline"
          ? finish(next, "blocked", `${reason} Fix failing tests first.`)
          : backtrack(next, reason),
      message: `${reason}\n${recorded.map(describeRun).join("\n")}`,
    };
  }
  if (phaseId === "baseline") return { run: advance(next), message: `Baseline ${timing}` };
  const before = median(
    next.runs.filter((r) => r.purpose === "measure" && r.phase === "baseline").map(testSeconds),
  );
  const after = median(recorded.map(testSeconds));
  const speedup = before > 0 ? (before - after) / before : 0;
  const summary = `Median test time ${before.toFixed(2)}s -> ${after.toFixed(2)}s (${(speedup * 100).toFixed(1)}%).`;
  if (speedup >= MIN_SPEEDUP) return { run: advance(next), message: `${summary}\n${timing}` };
  const reason = `${summary} Needs at least ${MIN_SPEEDUP * 100}%.`;
  return { run: backtrack(next, reason), message: reason };
}

function complete(run: Run, deps: Deps, message: string): StepResult {
  const next = advance(run);
  const done = currentPhase(next) ? next : finalize(next, deps.cwd);
  return { run: done, message: `${message}\n${nextStep(done)}` };
}

/** Complete the current phase, then run extension-owned phases until the model is needed again. */
export async function step(run: Run, deps: Deps): Promise<StepResult> {
  const phase = currentPhase(run) ?? reject(`No active phase. ${nextStep(run)}`);
  if (phase.kind === "mutation") reject("This phase is completed with compose_test_mutate.");
  let current =
    phase.kind === "edit"
      ? completeEdit(run, deps)
      : phase.kind === "findings"
        ? completeFindings(run, deps)
        : run;
  const messages: string[] = [];
  for (
    let next = currentPhase(current);
    next && !MODEL_KINDS.has(next.kind) && !deps.signal?.aborted;
    next = currentPhase(current)
  ) {
    const before = current.phaseIndex;
    const result = await runPhase(current, deps);
    current = result.run;
    messages.push(result.message);
    if (current.phaseIndex <= before) break;
  }
  if (current.status === "active" && !currentPhase(current)) current = finalize(current, deps.cwd);
  return { run: current, message: [...messages, nextStep(current)].join("\n") };
}

/**
 * Run the targets with files temporarily replaced. Returns undefined, with the run ended, if
 * someone else changed a swapped file meanwhile (it is left as they wrote it).
 */
async function swapped(
  run: Run,
  purpose: Purpose,
  swaps: readonly { path: string; content: Buffer | null }[],
  deps: Deps,
) {
  const tree = digest(fingerprint(deps.cwd));
  const { value, conflicts } = await withSwappedFiles(deps.dir, swaps, () =>
    execute(run, purpose, deps, tree),
  );
  if (conflicts.length === 0 && digest(fingerprint(deps.cwd)) === tree) return { value, tree };
  const reason = `Files changed by someone else during the run were left as they are: ${conflicts.join(", ") || "tree differs"}.`;
  return { value: [finish(value[0], "incomplete", reason), value[1]] as const, tree, reason };
}

export interface MutationInput {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

/** Negative control: break the code under test, require a test failure, restore the file. */
export async function mutate(run: Run, input: MutationInput, deps: Deps): Promise<StepResult> {
  const kind = currentPhase(run)?.kind;
  if (kind !== "mutation" && kind !== "regression")
    reject(`Not in a negative-control phase. ${nextStep(run)}`);
  if (categorize(input.file) !== "production")
    reject(`${input.file} is not production source; mutate the code under test.`);
  if (run.subject.length && !run.subject.includes(input.file))
    reject(`Mutate one of the subject files: ${run.subject.join(", ")}.`);
  if (input.find === input.replace) reject("The replacement must change the code.");
  const text = read(deps.cwd, input.file);
  const count = text.split(input.find).length - 1;
  if (count !== 1)
    reject(`find must match exactly once in ${input.file}; it matched ${count} times.`);
  const swap = {
    path: join(deps.cwd, input.file),
    content: Buffer.from(text.replace(input.find, input.replace)),
  };
  const { value, tree, reason } = await swapped(run, "mutation", [swap], deps);
  const [next, r] = value;
  const recorded = revise(next, {
    mutations: [...next.mutations, { ...input, runId: r.id, tree, detected: detected(r) }],
  });
  if (reason) return { run: recorded, message: reason };
  if (r.outcome === "build-error")
    return {
      run: recorded,
      message: `${describeRun(r)}\nThe mutation does not compile. Choose one that compiles and changes behavior.`,
    };
  if (!detected(r)) {
    const back = backtrack(
      recorded,
      `The tests did not detect the mutation in ${input.file}. Strengthen the assertions on the behavior it changed.`,
    );
    return { run: back, message: `${describeRun(r)}\n${nextStep(back)}` };
  }
  return complete(recorded, deps, `Mutation detected and reverted.\n${describeRun(r)}`);
}

/**
 * Regression check for a fix: run the final tests against the original production code and
 * require them to fail there. With no production change, a negative control is required instead.
 */
async function regressionCheck(run: Run, deps: Deps): Promise<StepResult> {
  const production = changes(run, deps.cwd).filter((p) => categorize(p) === "production");
  if (production.length === 0)
    return {
      run,
      message: `No production code changed. Prove the tests detect the behavior: call compose_test_mutate.\n${nextStep(run)}`,
    };
  const swaps = production.map((p) => ({
    path: join(deps.cwd, p),
    content: baselineContent(deps.cwd, run, p),
  }));
  const { value, reason } = await swapped(run, "regression", swaps, deps);
  const [next, r] = value;
  if (reason) return { run: next, message: reason };
  if (detected(r))
    return complete(
      next,
      deps,
      `The tests fail on the original code, so the fix is what makes them pass.\n${describeRun(r)}`,
    );
  if (r.outcome === "build-error")
    return {
      run: next,
      message: `${describeRun(r)}\nThe tests do not compile against the original code. Call compose_test_mutate instead.`,
    };
  const back = backtrack(
    next,
    "The tests also pass on the original production code, so they do not prove the fix.",
  );
  return { run: back, message: `${describeRun(r)}\n${nextStep(back)}` };
}

export function addFinding(run: Run, finding: Omit<Finding, "source">, cwd: string): StepResult {
  if (currentPhase(run)?.kind !== "findings") reject(`Not in a review phase. ${nextStep(run)}`);
  const lines = read(cwd, finding.file).split("\n").length;
  if (!existsSync(join(cwd, finding.file))) reject(`${finding.file} does not exist.`);
  if (!Number.isInteger(finding.line) || finding.line < 1 || finding.line > lines)
    reject(`${finding.file} has ${lines} lines; line ${finding.line} is out of range.`);
  const same = (f: Finding) =>
    f.file === finding.file &&
    f.line === finding.line &&
    f.rule === finding.rule &&
    f.message === finding.message;
  if (run.findings.some(same)) return { run, message: "Already recorded." };
  return {
    run: revise(run, { findings: [...run.findings, { ...finding, source: "agent" }] }),
    message: "Finding recorded.",
  };
}

/** Blocking needs evidence: the two most recent runs executed no tests. */
export function block(run: Run, reason: string): StepResult {
  if (run.status !== "active") reject(`No active workflow to block. ${nextStep(run)}`);
  const recent = run.runs.slice(-2);
  if (
    recent.length < 2 ||
    recent.some((r) => r.outcome !== "build-error" && r.outcome !== "no-tests")
  )
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
