import type { FileCategory } from "./paths.ts";

/**
 * Who completes a phase and what evidence closes it. The model drives "explore", "edit" and
 * "findings" phases; the extension itself executes every other kind and decides the outcome.
 */
export type PhaseKind =
  | "explore"
  | "edit"
  | "findings"
  | "verify-pass"
  | "reproduce-fail"
  | "mutation"
  | "regression"
  | "probe"
  | "stress"
  | "measure";

export interface Phase {
  readonly id: string;
  readonly kind: PhaseKind;
  /** File categories the phase may change. Empty for every phase except "edit". */
  readonly scope: readonly FileCategory[];
  readonly instruction: string;
}

export const workflowIds = [
  "write-test",
  "setup",
  "fix-failing",
  "fix-flaky",
  "refactor",
  "performance",
  "migrate",
  "review",
  "audit",
  "coverage-gaps",
] as const;
export type WorkflowId = (typeof workflowIds)[number];

export interface Workflow {
  readonly id: WorkflowId;
  readonly trigger: string;
  readonly phases: readonly Phase[];
  /** Categories the final tree may differ from the baseline in. */
  readonly allowedChanges: readonly FileCategory[];
  /** Every test case that existed in the first recorded run must exist and pass at the end. */
  readonly preserveTests: boolean;
  /** The workflow needs `source`: an instrumented test whose @Test count bounds the result. */
  readonly needsSource: boolean;
  /** Target test files may be created by the workflow instead of existing at start. */
  readonly createsTargets: boolean;
  readonly references: readonly string[];
}

const phase = (
  id: string,
  kind: PhaseKind,
  instruction: string,
  scope: readonly FileCategory[] = [],
): Phase => ({ id, kind, scope, instruction });

const explore = (instruction: string) => phase("explore", "explore", instruction);
const verify = phase(
  "verify",
  "verify-pass",
  "Call compose_test_step. The extension runs every target test and requires all of them to pass.",
);
const mutation = phase(
  "negative-control",
  "mutation",
  "Call compose_test_mutate with an exact find/replace in production code under test that breaks the behavior the tests claim to cover. The extension applies it, runs the targets, requires a test failure (not a compile error), and restores the file.",
);

const TESTS: readonly FileCategory[] = ["test"];
const TESTS_AND_BUILD: readonly FileCategory[] = ["test", "build"];
const ANY: readonly FileCategory[] = ["test", "build", "production", "other"];

export const workflows: Readonly<Record<WorkflowId, Workflow>> = {
  "write-test": {
    id: "write-test",
    trigger: "Create tests for existing or new Compose UI behavior.",
    phases: [
      explore(
        "Read the composable under test and name the user-observable behavior (text, semantics, callbacks) the test must pin down. Call compose_test_step with that behavior as the note.",
      ),
      phase(
        "write",
        "edit",
        "Write or extend the test file(s) under src/test. Only test files may change. Call compose_test_step when done; the extension lints changed tests.",
        TESTS,
      ),
      verify,
      mutation,
    ],
    allowedChanges: TESTS,
    preserveTests: false,
    needsSource: false,
    createsTargets: true,
    references: ["writing-tests.md", "synchronization.md", "semantics.md"],
  },
  setup: {
    id: "setup",
    trigger: "Establish Robolectric testing infrastructure for Compose.",
    phases: [
      explore(
        "Inspect the module's build files, AGP/Kotlin/Compose versions and existing test source sets. Call compose_test_step naming what is missing.",
      ),
      phase(
        "configure",
        "edit",
        "Add the Robolectric and Compose test dependencies and testOptions, and one smoke test under src/test for an existing composable. Only build and test files may change. Call compose_test_step when done.",
        TESTS_AND_BUILD,
      ),
      verify,
      mutation,
    ],
    allowedChanges: TESTS_AND_BUILD,
    preserveTests: false,
    needsSource: false,
    createsTargets: true,
    references: ["setup.md", "writing-tests.md"],
  },
  "fix-failing": {
    id: "fix-failing",
    trigger: "Reproduce and diagnose a failing Compose test.",
    phases: [
      phase(
        "reproduce",
        "reproduce-fail",
        "Call compose_test_step. The extension runs the targets and requires the reported failure to reproduce.",
      ),
      explore(
        "Trace the failure to its root cause (the first place behavior goes wrong). Call compose_test_step with the root cause as the note. Do not weaken, delete or @Ignore the test.",
      ),
      phase(
        "fix",
        "edit",
        "Fix the root cause, in production or test code. Call compose_test_step when done.",
        ANY,
      ),
      verify,
      phase(
        "regression-check",
        "regression",
        "Call compose_test_step. If production code changed, the extension runs the tests against the original production code and requires them to fail there. If only tests changed, call compose_test_mutate instead to prove the tests still detect the behavior.",
      ),
    ],
    allowedChanges: ANY,
    preserveTests: true,
    needsSource: false,
    createsTargets: false,
    references: ["debugging.md", "synchronization.md"],
  },
  "fix-flaky": {
    id: "fix-flaky",
    trigger: "Eliminate a flaky Compose test.",
    phases: [
      phase(
        "reproduce",
        "probe",
        "Call compose_test_step. The extension reruns the targets several times and records every outcome.",
      ),
      explore(
        "Name the source of nondeterminism (real time, unsynchronized coroutine, shared state, rogue thread, ordering). Call compose_test_step with it as the note.",
      ),
      phase(
        "fix",
        "edit",
        "Remove the nondeterminism. Retries, sleeps and @Ignore are not fixes. Call compose_test_step when done.",
        ANY,
      ),
      phase(
        "stress",
        "stress",
        "Call compose_test_step. The extension reruns the targets and requires every run to pass.",
      ),
      mutation,
    ],
    allowedChanges: ANY,
    preserveTests: true,
    needsSource: false,
    createsTargets: false,
    references: ["flakiness.md", "synchronization.md"],
  },
  refactor: {
    id: "refactor",
    trigger: "Refactor or simplify tests without changing what they verify.",
    phases: [
      phase(
        "baseline",
        "verify-pass",
        "Call compose_test_step. The extension records the passing baseline and its test cases.",
      ),
      phase(
        "refactor",
        "edit",
        "Simplify the test files. Only test files may change. Call compose_test_step when done.",
        TESTS,
      ),
      verify,
      mutation,
    ],
    allowedChanges: TESTS,
    preserveTests: false,
    needsSource: false,
    createsTargets: false,
    references: ["writing-tests.md", "anti-patterns.md"],
  },
  performance: {
    id: "performance",
    trigger: "Improve Compose Robolectric test execution time.",
    phases: [
      phase("baseline", "measure", "Call compose_test_step. The extension times the targets."),
      phase(
        "optimize",
        "edit",
        "Reduce test cost without dropping coverage. Only test and build files may change. Call compose_test_step when done.",
        TESTS_AND_BUILD,
      ),
      phase(
        "after",
        "measure",
        "Call compose_test_step. The extension times the targets again; every baseline test must still pass.",
      ),
    ],
    allowedChanges: TESTS_AND_BUILD,
    preserveTests: true,
    needsSource: false,
    createsTargets: false,
    references: ["performance.md"],
  },
  migrate: {
    id: "migrate",
    trigger: "Migrate an instrumented (androidTest) Compose test to Robolectric.",
    phases: [
      explore(
        "Read the source instrumented test. Decide whether every case can run on Robolectric; name any case that needs a device and why. Call compose_test_step with that as the note.",
      ),
      phase(
        "migrate",
        "edit",
        "Write the Robolectric version under src/test. Only test files may change. Call compose_test_step when done.",
        TESTS,
      ),
      verify,
      mutation,
    ],
    allowedChanges: TESTS,
    preserveTests: false,
    needsSource: true,
    createsTargets: true,
    references: ["migration.md", "writing-tests.md"],
  },
  review: {
    id: "review",
    trigger: "Review test changes (a diff or named files).",
    phases: [
      phase(
        "review",
        "findings",
        "Read each target. Record every problem with compose_test_finding (file, line, rule, severity, message). The extension adds its own lint findings. Call compose_test_step when every target has been read.",
      ),
    ],
    allowedChanges: [],
    preserveTests: false,
    needsSource: false,
    createsTargets: false,
    references: ["anti-patterns.md", "writing-tests.md"],
  },
  audit: {
    id: "audit",
    trigger: "Audit existing tests against best practices.",
    phases: [
      phase(
        "audit",
        "findings",
        "Read each target. Record every problem with compose_test_finding. The extension adds its own lint findings. Call compose_test_step when every target has been read.",
      ),
    ],
    allowedChanges: [],
    preserveTests: false,
    needsSource: false,
    createsTargets: false,
    references: ["anti-patterns.md", "writing-tests.md"],
  },
  "coverage-gaps": {
    id: "coverage-gaps",
    trigger: "Identify meaningful untested Compose behavior.",
    phases: [
      phase(
        "gaps",
        "findings",
        "For each target composable, compare its user-observable behavior with what the tests assert. Record each untested behavior with compose_test_finding (rule: coverage-gap) at the composable's line. Call compose_test_step when every target has been read.",
      ),
    ],
    allowedChanges: [],
    preserveTests: false,
    needsSource: false,
    createsTargets: false,
    references: ["writing-tests.md"],
  },
};

export const isWorkflowId = (value: unknown): value is WorkflowId =>
  workflowIds.some((id) => id === value);

export const routingTable = () =>
  workflowIds.map((id) => `- ${id}: ${workflows[id].trigger}`).join("\n");
