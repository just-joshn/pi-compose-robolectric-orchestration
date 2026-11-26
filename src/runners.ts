import { read } from "./checks.ts";
import {
  type GradleDeps,
  ofTest,
  runTargets,
  type Target,
  type TestCase,
  testClasses,
} from "./gradle.ts";
import {
  addRun,
  advance,
  backtrack,
  cannotRunTests,
  currentPhase,
  describeRun,
  finish,
  type Purpose,
  type Run,
  type TestRun,
} from "./state.ts";
import { digest, fingerprint } from "./tree.ts";
import { type Phase, workflows } from "./workflows.ts";

type Deps = GradleDeps;

export interface StepResult {
  readonly run: Run;
  readonly message: string;
}

export const result = (run: Run, ...lines: string[]): StepResult => ({
  run,
  message: lines.join("\n"),
});

const STRESS_RUNS = 5;
const MEASURE_RUNS = 3;
const MIN_SPEEDUP = 0.05;

/** Test-preserving workflows run whole classes, so sibling tests cannot break or disappear unseen. */
export async function execute(
  run: Run,
  purpose: Purpose,
  deps: Deps,
  tree: string,
): Promise<[Run, TestRun]> {
  const whole =
    run.workflow !== null &&
    workflows[run.workflow].preserveTests &&
    ["verify", "reproduce", "inventory", "stress", "measure"].includes(purpose);
  const targets = whole ? run.targets.map(({ file }) => ({ file })) : run.targets;
  const execution = await runTargets(deps, targets);
  return addRun(run, { phase: currentPhase(run)?.id ?? "", purpose, tree, ...execution });
}

async function evidence(run: Run, purpose: Purpose, deps: Deps): Promise<[Run, TestRun]> {
  const tree = digest(fingerprint(deps.cwd));
  const ran = await execute(run, purpose, deps, tree);
  if (digest(fingerprint(deps.cwd)) !== tree)
    throw new Error(
      "Files changed while Gradle ran, so the run is not evidence. Call compose_test_step again.",
    );
  return ran;
}

const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function repeat(
  run: Run,
  purpose: Purpose,
  times: number,
  deps: Deps,
): Promise<{ run: Run; recorded: TestRun[] }> {
  if (times === 0) return { run, recorded: [] };
  const [next, r] = await evidence(run, purpose, deps);
  if (r.outcome === "build-error") return { run: next, recorded: [r] };
  const rest = await repeat(next, purpose, times - 1, deps);
  return { run: rest.run, recorded: [r, ...rest.recorded] };
}

export async function verify(run: Run, deps: Deps): Promise<StepResult> {
  const [next, r] = await evidence(run, "verify", deps);
  if (r.outcome === "passed") return result(advance(next), describeRun(r));
  const reason =
    run.phaseIndex === 0
      ? "The tests fail before any change. This workflow needs a passing baseline; fix the failures first (fix-failing)."
      : `Verification ${r.outcome}.`;
  return result(backtrack(next, reason), describeRun(r), reason);
}

/** A class-level failure such as classMethod names no test, yet it stops the method too. */
function ownFailure(cwd: string, { file, method }: Target, failed: readonly TestCase[]) {
  const classes = testClasses(read(cwd, file), file).filter(
    (k) => !method || k.tests.includes(method),
  );
  return failed.some((c) => {
    const owner = classes.find((k) => k.name === c.className.split("$")[0]);
    const test = owner?.tests.find((t) => ofTest(c.name, t));
    return owner !== undefined && (!method || test === undefined || test === method);
  });
}

/** A run that executed nothing proves nothing, and two in a row mean the build cannot run tests. */
function retryOrBlock(next: Run, r: TestRun, reason: string): StepResult {
  const stuck = cannotRunTests(next);
  if (stuck) return result(finish(next, "blocked", `${reason} (${stuck})`), describeRun(r));
  const retry =
    "Call compose_test_step to run them again; a second run that executes nothing blocks the workflow.";
  return result(next, describeRun(r), `${reason} ${retry}`);
}

/** Kotlin and javac diagnostics. A timeout kill, a crashed daemon or a missing dependency prints none. */
const COMPILE_ERROR = /^e: |\.java:\d+: error: /m;

export async function reproduce(run: Run, deps: Deps): Promise<StepResult> {
  const [next, r] = await evidence(run, "reproduce", deps);
  const failed = r.cases.filter((c) => c.status === "failed");
  const compileError = r.outcome === "build-error" && COMPILE_ERROR.test(r.outputTail);
  if (compileError || run.targets.some((t) => ownFailure(deps.cwd, t, failed)))
    return result(advance(next), "Reproduced.", describeRun(r));
  if (r.outcome === "build-error")
    return retryOrBlock(
      next,
      r,
      "Gradle failed with no compile error and no failing test, so the run proves nothing.",
    );
  if (next.runs.filter((x) => x.purpose === "reproduce").length >= 2)
    return result(
      finish(next, "blocked", "The failure does not reproduce locally."),
      describeRun(r),
    );
  const retry =
    "Did not reproduce. Check the target and method, then call compose_test_step again.";
  return result(next, describeRun(r), retry);
}

export async function inventory(run: Run, deps: Deps): Promise<StepResult> {
  const [next, r] = await evidence(run, "inventory", deps);
  if (r.outcome === "passed" || r.outcome === "failed")
    return result(advance(next), describeRun(r));
  const reason = `The targets did not run before any change (${r.outcome}), so their cases are unknown.`;
  return retryOrBlock(next, r, reason);
}

export async function stress(run: Run, deps: Deps): Promise<StepResult> {
  const { run: next, recorded } = await repeat(run, "stress", STRESS_RUNS, deps);
  const bad = recorded.filter((r) => r.outcome !== "passed");
  if (bad.length === 0) return result(advance(next), `All ${STRESS_RUNS} stress runs passed.`);
  const reason = `${bad.length}/${recorded.length} stress runs did not pass.`;
  return result(backtrack(next, reason), reason, ...bad.map(describeRun));
}

export async function measure(run: Run, deps: Deps, phase: Phase): Promise<StepResult> {
  const baseline = phase.id === "baseline";
  const { run: next, recorded } = await repeat(run, "measure", MEASURE_RUNS, deps);
  if (recorded.some((r) => r.outcome !== "passed")) {
    const reason = "Every measurement run must pass.";
    const ended = baseline
      ? finish(next, "blocked", `${reason} Fix failing tests first.`)
      : backtrack(next, reason);
    return result(ended, reason, ...recorded.map(describeRun));
  }
  const unmeasured = recorded.filter((r) => r.testSeconds === null).map((r) => `#${r.id}`);
  if (unmeasured.length) {
    const reason = `Gradle reported no test time for run ${unmeasured.join(", ")}, so nothing was measured. The build must keep the extension's test listener.`;
    return result(baseline ? finish(next, "blocked", reason) : backtrack(next, reason), reason);
  }
  const timing = `test time per run: ${recorded.map((r) => r.testSeconds?.toFixed(2)).join(", ")}s`;
  if (baseline) return result(advance(next), `Baseline ${timing}`);
  const before = median(
    next.runs
      .filter((r) => r.purpose === "measure" && r.phase === "baseline")
      .flatMap((r) => r.testSeconds ?? []),
  );
  const after = median(recorded.flatMap((r) => r.testSeconds ?? []));
  const speedup = before > 0 ? (before - after) / before : 0;
  const summary = `Median test time ${before.toFixed(2)}s -> ${after.toFixed(2)}s (${(speedup * 100).toFixed(1)}%).`;
  if (speedup >= MIN_SPEEDUP) return result(advance(next), summary, timing);
  const reason = `${summary} Needs at least ${MIN_SPEEDUP * 100}%.`;
  return result(backtrack(next, reason), reason);
}
