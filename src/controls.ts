import { join } from "node:path";

import { baselineContent } from "./baseline.ts";
import { type Deps, describeRun, execute, failedCases, nextStep, readText, reject, type StepResult } from "./core.ts";
import { finalize } from "./finalize.ts";
import { categorize } from "./paths.ts";
import { backtrack, changes } from "./progress.ts";
import { advance, currentPhase, finish, revise, type Run, type TestRun } from "./state.ts";
import { withSwappedFiles } from "./swap.ts";
import { digest, fingerprint } from "./tree.ts";

export interface MutationInput {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

function validateMutation(run: Run, input: MutationInput, cwd: string): string {
  const kind = currentPhase(run)?.kind;
  if (kind !== "mutation" && kind !== "regression")
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

const conflictMessage = (conflicts: readonly string[]) =>
  `Files changed by someone else during the run were left as they are: ${conflicts.join(", ")}. Check them before continuing.`;

/** Apply a mutation, run the targets, and restore the file unless someone else changed it meanwhile. */
export async function mutate(run: Run, input: MutationInput, deps: Deps): Promise<StepResult> {
  const text = validateMutation(run, input, deps.cwd);
  const tree = digest(fingerprint(deps.cwd));
  const path = join(deps.cwd, input.file);
  const { value, conflicts } = await withSwappedFiles(
    deps.dir,
    [{ path, content: Buffer.from(text.replace(input.find, input.replace)) }],
    () => execute(run, "mutation", deps),
  );
  const [next, r] = value;
  const restored = conflicts.length === 0 && digest(fingerprint(deps.cwd)) === tree;
  const detected = r.outcome === "failed" && failedCases(r).length > 0;
  const record = { ...input, runId: r.id, tree, detected, restored };
  const withRecord = revise(next, { mutations: [...next.mutations, record] });
  if (!restored) {
    const reason = conflicts.length ? conflictMessage(conflicts) : `The tree differs after restoring ${input.file}.`;
    return { run: finish(withRecord, "incomplete", reason), message: reason };
  }
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
  return complete(withRecord, deps, `Mutation detected and reverted.\n${describeRun(r)}`);
}

function complete(run: Run, deps: Deps, message: string): StepResult {
  let done = advance(run);
  if (!currentPhase(done)) done = finalize(done, deps);
  return { run: done, message: `${message}\n${nextStep(done)}` };
}

/**
 * Regression check for a fix: put the production files back to their state at workflow start
 * and require the final tests to fail there. A test that passes on the unfixed code does not
 * prove the fix. With no production change, the negative control (compose_test_mutate) applies.
 */
export async function regressionCheck(run: Run, deps: Deps): Promise<StepResult> {
  const production = changes(run, deps.cwd).filter((path) => categorize(path) === "production");
  if (production.length === 0 || !run.baseline)
    return {
      run,
      message: `No production code changed. Prove the changed tests still detect the behavior: call compose_test_mutate.\n${nextStep(run)}`,
    };
  const baseline = run.baseline;
  const swaps = production.map((path) => ({
    path: join(deps.cwd, path),
    content: baselineContent(deps.cwd, baseline, run.snapshot, path),
  }));
  const tree = digest(fingerprint(deps.cwd));
  const { value, conflicts } = await withSwappedFiles(deps.dir, swaps, () =>
    execute(run, "regression", deps, tree),
  );
  const [next, r]: [Run, TestRun] = value;
  if (conflicts.length || digest(fingerprint(deps.cwd)) !== tree) {
    const reason = conflicts.length ? conflictMessage(conflicts) : "The tree differs after the regression check.";
    return { run: finish(next, "incomplete", reason), message: reason };
  }
  if (r.outcome === "failed" && failedCases(r).length > 0)
    return complete(next, deps, `The tests fail on the original production code, so the fix is what makes them pass.\n${describeRun(r)}`);
  if (r.outcome === "build-error")
    return {
      run: next,
      message: `${describeRun(r)}\nThe tests do not compile against the original production code. Prove detection with compose_test_mutate instead.`,
    };
  const reason = "The tests also pass on the original production code, so they do not prove the fix.";
  const back = backtrack(next, reason, deps.config);
  return { run: back, message: `${describeRun(r)}\n${reason}\n${nextStep(back)}` };
}
