import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  baselineContent,
  changes,
  editProblem,
  finalize,
  read,
  saveSnapshot,
  scopeViolations,
} from "./checks.ts";
import { type Exec, runTargets, type Target, testClasses } from "./gradle.ts";
import { type LintFinding, lintTestSource } from "./lint.ts";
import { categorize, inside, isSource } from "./paths.ts";
import {
  addRun,
  advance,
  backtrack,
  currentPhase,
  describeRun,
  type Finding,
  finish,
  nextStep,
  type Purpose,
  revise,
  type Run,
  type TestRun,
} from "./state.ts";
import { type FileSwap, stateDir, withSwappedFiles } from "./swap.ts";
import { digest, fingerprint } from "./tree.ts";
import { type Phase, type PhaseKind, type WorkflowId, workflows } from "./workflows.ts";

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
const result = (run: Run, ...lines: string[]): StepResult => ({ run, message: lines.join("\n") });
const reject = (message: string): never => {
  throw new WorkflowError(message);
};

const STRESS_RUNS = 5;
const MEASURE_RUNS = 3;
const MIN_SPEEDUP = 0.05;

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
  const paths = [...input.targets.map((t) => t.file), ...(input.subject ?? []), input.source ?? ""];
  for (const file of paths.filter(Boolean))
    if (!inside(cwd, file)) reject(`${file} is outside the workspace.`);
  for (const { file } of input.targets) {
    if (runsTests && !/(^|\/)src\/test[A-Za-z]*\/.*\.kt$/.test(file))
      reject(`Target ${file} must be a .kt test under src/test (Robolectric runs local tests).`);
    if (!workflow.createsTargets && !existsSync(join(cwd, file)))
      reject(`Target ${file} does not exist.`);
  }
  for (const file of input.subject ?? [])
    if (categorize(file) !== "production" || !existsSync(join(cwd, file)))
      reject(`Subject ${file} is not an existing production source file.`);
  const source = input.source ?? "";
  const androidTest =
    /(^|\/)src\/androidTest\/.*\.kt$/.test(source) && existsSync(join(cwd, source));
  if (input.workflow === "migrate" && !androidTest)
    reject("migrate needs source: an existing androidTest .kt file.");
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
      testClasses(read(cwd, t.file), t.file).flatMap((c) => c.tests.map((n) => `${c.name}.${n}`)),
    ),
  });
  return result(started, `Started ${input.workflow}.`, nextStep(started));
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

const detected = (r: TestRun) =>
  r.outcome === "failed" && r.cases.some((c) => c.status === "failed");
const testSeconds = (r: TestRun) => r.cases.reduce((sum, c) => sum + c.seconds, 0);
const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

function completeEdit(run: Run, deps: Deps): Run {
  const problem = editProblem(run, deps.cwd);
  if (problem) reject(problem);
  return advance(run);
}

const asLintFinding = (f: LintFinding): Finding => ({ ...f, source: "lint" });

function completeFindings(run: Run, deps: Deps): Run {
  const unread = run.targets.filter((t) => !run.reads.includes(t.file));
  if (unread.length)
    reject(`Read every target first. Not read yet: ${unread.map((t) => t.file).join(", ")}.`);
  const changed = changes(run, deps.cwd);
  if (changed.length) reject(`Review is read-only; revert: ${changed.join(", ")}.`);
  const lint = run.targets
    .filter((t) => isSource(t.file) && categorize(t.file) === "test")
    .flatMap((t) => lintTestSource(t.file, read(deps.cwd, t.file)))
    .map(asLintFinding);
  return advance(revise(run, { findings: [...run.findings, ...lint] }));
}

async function repeat(
  run: Run,
  purpose: Purpose,
  times: number,
  deps: Deps,
): Promise<{ run: Run; recorded: TestRun[] }> {
  if (times === 0) return { run, recorded: [] };
  const [next, r] = await execute(run, purpose, deps);
  if (r.outcome === "build-error") return { run: next, recorded: [r] };
  const rest = await repeat(next, purpose, times - 1, deps);
  return { run: rest.run, recorded: [r, ...rest.recorded] };
}

async function verify(run: Run, deps: Deps): Promise<StepResult> {
  const [next, r] = await execute(run, "verify", deps);
  if (r.outcome === "passed") return result(advance(next), describeRun(r));
  const reason =
    run.phaseIndex === 0
      ? "The tests fail before any change. This workflow needs a passing baseline; fix the failures first (fix-failing)."
      : `Verification ${r.outcome}.`;
  return result(backtrack(next, reason), describeRun(r), reason);
}

async function reproduce(run: Run, deps: Deps): Promise<StepResult> {
  const [next, r] = await execute(run, "reproduce", deps);
  if (r.outcome === "failed" || r.outcome === "build-error")
    return result(advance(next), "Reproduced.", describeRun(r));
  if (next.runs.filter((x) => x.purpose === "reproduce").length >= 2)
    return result(
      finish(next, "blocked", "The failure does not reproduce locally."),
      describeRun(r),
    );
  const retry =
    "Did not reproduce. Check the target and method, then call compose_test_step again.";
  return result(next, describeRun(r), retry);
}

async function stress(run: Run, deps: Deps): Promise<StepResult> {
  const { run: next, recorded } = await repeat(run, "stress", STRESS_RUNS, deps);
  const bad = recorded.filter((r) => r.outcome !== "passed");
  if (bad.length === 0) return result(advance(next), `All ${STRESS_RUNS} stress runs passed.`);
  const reason = `${bad.length}/${recorded.length} stress runs did not pass.`;
  return result(backtrack(next, reason), reason, ...bad.map(describeRun));
}

type Runner = (run: Run, deps: Deps, phase: Phase) => Promise<StepResult>;

/** The phases the extension executes itself; every other kind waits for the model. */
const RUNNERS: Partial<Record<PhaseKind, Runner>> = {
  verify,
  reproduce,
  stress,
  measure,
  regression: regressionCheck,
};

async function runPhase(run: Run, phase: Phase, runner: Runner, deps: Deps): Promise<StepResult> {
  const violations = scopeViolations(run, deps.cwd);
  if (violations.length === 0) return runner(run, deps, phase);
  const reason = `Out-of-scope changes: ${violations.join(", ")}. Revert them.`;
  return result(backtrack(run, reason), reason);
}

async function measure(run: Run, deps: Deps, phase: Phase): Promise<StepResult> {
  const baseline = phase.id === "baseline";
  const { run: next, recorded } = await repeat(run, "measure", MEASURE_RUNS, deps);
  const timing = `test time per run: ${recorded.map((r) => testSeconds(r).toFixed(2)).join(", ")}s`;
  if (recorded.some((r) => r.outcome !== "passed")) {
    const reason = "Every measurement run must pass.";
    const ended = baseline
      ? finish(next, "blocked", `${reason} Fix failing tests first.`)
      : backtrack(next, reason);
    return result(ended, reason, ...recorded.map(describeRun));
  }
  if (baseline) return result(advance(next), `Baseline ${timing}`);
  const before = median(
    next.runs.filter((r) => r.purpose === "measure" && r.phase === "baseline").map(testSeconds),
  );
  const after = median(recorded.map(testSeconds));
  const speedup = before > 0 ? (before - after) / before : 0;
  const summary = `Median test time ${before.toFixed(2)}s -> ${after.toFixed(2)}s (${(speedup * 100).toFixed(1)}%).`;
  if (speedup >= MIN_SPEEDUP) return result(advance(next), summary, timing);
  const reason = `${summary} Needs at least ${MIN_SPEEDUP * 100}%.`;
  return result(backtrack(next, reason), reason);
}

function complete(run: Run, deps: Deps, message: string): StepResult {
  const next = advance(run);
  const done = currentPhase(next) ? next : finalize(next, deps.cwd);
  return result(done, message, nextStep(done));
}

const COMPLETERS: Partial<Record<PhaseKind, (run: Run, deps: Deps) => Run>> = {
  edit: completeEdit,
  findings: completeFindings,
};

async function runOwned(run: Run, deps: Deps, messages: readonly string[]): Promise<StepResult> {
  const phase = currentPhase(run);
  const runner = phase && RUNNERS[phase.kind];
  if (phase && runner && !deps.signal?.aborted) {
    const next = await runPhase(run, phase, runner, deps);
    const moved = next.run.phaseIndex > run.phaseIndex;
    if (moved) return runOwned(next.run, deps, [...messages, next.message]);
    return result(next.run, ...messages, next.message, nextStep(next.run));
  }
  const done = run.status === "active" && !phase ? finalize(run, deps.cwd) : run;
  return result(done, ...messages, nextStep(done));
}

export async function step(run: Run, deps: Deps): Promise<StepResult> {
  const phase = currentPhase(run) ?? reject(`No active phase. ${nextStep(run)}`);
  if (phase.kind === "mutation") reject("This phase is completed with compose_test_mutate.");
  return runOwned(COMPLETERS[phase.kind]?.(run, deps) ?? run, deps, []);
}

/**
 * Run the targets with files temporarily replaced and require a test failure. A file someone
 * else changed meanwhile is left as they wrote it and the run ends as INCOMPLETE.
 */
async function control(
  run: Run,
  purpose: Purpose,
  swaps: readonly FileSwap[],
  deps: Deps,
  text: { proof: string; noCompile: string; missed: string },
  record: (ran: Run, r: TestRun, tree: string) => Run = (ran) => ran,
): Promise<StepResult> {
  const tree = digest(fingerprint(deps.cwd));
  const ran = await withSwappedFiles(deps.dir, swaps, () => execute(run, purpose, deps, tree));
  const [after, r] = ran.value;
  const next = record(after, r, tree);
  if (ran.conflicts.length || digest(fingerprint(deps.cwd)) !== tree) {
    const reason = `Files changed by someone else during the run were left as they are: ${ran.conflicts.join(", ") || "tree differs"}.`;
    return result(finish(next, "incomplete", reason), reason);
  }
  if (detected(r)) return complete(next, deps, `${text.proof}\n${describeRun(r)}`);
  if (r.outcome === "build-error") return result(next, describeRun(r), text.noCompile);
  const back = backtrack(next, text.missed);
  return result(back, describeRun(r), nextStep(back));
}

export interface MutationInput {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

export async function mutate(run: Run, input: MutationInput, deps: Deps): Promise<StepResult> {
  const kind = currentPhase(run)?.kind;
  if (kind !== "mutation" && kind !== "regression")
    reject(`Not in a negative-control phase. ${nextStep(run)}`);
  if (!inside(deps.cwd, input.file)) reject(`${input.file} is outside the workspace.`);
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
  return control(
    run,
    "mutation",
    [swap],
    deps,
    {
      proof: "Mutation detected and reverted.",
      noCompile: "The mutation does not compile. Choose one that compiles and changes behavior.",
      missed: `The tests did not detect the mutation in ${input.file}. Strengthen the assertions on the behavior it changed.`,
    },
    (ran, r, tree) =>
      revise(ran, {
        mutations: [...ran.mutations, { ...input, runId: r.id, tree, detected: detected(r) }],
      }),
  );
}

/**
 * Regression check for a fix: run the final tests against the original production code and
 * require them to fail there. With no production change, a negative control is required instead.
 */
async function regressionCheck(run: Run, deps: Deps): Promise<StepResult> {
  const production = changes(run, deps.cwd).filter((p) => categorize(p) === "production");
  if (production.length === 0) {
    const ask =
      "No production code changed. Prove the tests detect the behavior: call compose_test_mutate.";
    return result(run, ask, nextStep(run));
  }
  const swaps = production.map((p) => ({
    path: join(deps.cwd, p),
    content: baselineContent(deps.cwd, run, p),
  }));
  return control(run, "regression", swaps, deps, {
    proof: "The tests fail on the original code, so the fix is what makes them pass.",
    noCompile:
      "The tests do not compile against the original code. Call compose_test_mutate instead.",
    missed: "The tests also pass on the original production code, so they do not prove the fix.",
  });
}

const key = (f: Omit<Finding, "source">) => [f.file, f.line, f.rule, f.message].join("\0");
const ranNothing = (r: TestRun) => r.outcome === "build-error" || r.outcome === "no-tests";

export function addFinding(run: Run, finding: Omit<Finding, "source">, cwd: string): StepResult {
  if (currentPhase(run)?.kind !== "findings") reject(`Not in a review phase. ${nextStep(run)}`);
  if (!inside(cwd, finding.file)) reject(`${finding.file} is outside the workspace.`);
  if (!existsSync(join(cwd, finding.file))) reject(`${finding.file} does not exist.`);
  const lines = read(cwd, finding.file).split("\n").length;
  if (finding.line > lines)
    reject(`${finding.file} has ${lines} lines; line ${finding.line} is out of range.`);
  if (run.findings.some((f) => key(f) === key(finding))) return result(run, "Already recorded.");
  return result(
    revise(run, { findings: [...run.findings, { ...finding, source: "agent" }] }),
    "Finding recorded.",
  );
}

/** Blocking needs evidence: the two most recent runs executed no tests. */
export function block(run: Run, reason: string): StepResult {
  if (run.status !== "active") reject(`No active workflow to block. ${nextStep(run)}`);
  const recent = run.runs.slice(-2);
  if (recent.length < 2 || !recent.every(ranNothing))
    reject(
      "Blocking needs evidence: the two most recent extension runs must both fail to execute tests. Continue the workflow.",
    );
  const evidence = `runs #${recent.map((r) => r.id).join(", #")} could not execute tests`;
  const blocked = finish(run, "blocked", `${reason} (${evidence})`);
  return result(blocked, nextStep(blocked));
}
