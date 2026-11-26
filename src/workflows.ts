import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Category } from "./paths.ts";

/** The model completes "edit" and "findings" phases with compose_test_step and "mutation" with compose_test_mutate. The extension executes every other kind and decides its outcome. */
export type PhaseKind =
  | "edit"
  | "findings"
  | "verify"
  | "reproduce"
  | "inventory"
  | "mutation"
  | "regression"
  | "stress"
  | "measure";

export interface Phase {
  readonly id: string;
  readonly kind: PhaseKind;
  /** Categories the phase may change; only edit phases change anything. */
  readonly scope: readonly Category[];
  readonly instruction: string;
  /** Why the edit phase cannot end with nothing changed since start, if it cannot. */
  readonly ifUnchanged?: string;
}

export interface Workflow {
  readonly trigger: string;
  readonly phases: readonly Phase[];
  /** Every test that existed at start must still exist and pass. */
  readonly preserveTests: boolean;
  /** Target test files may be created rather than exist at start. */
  readonly createsTargets: boolean;
  readonly references: readonly string[];
}

const TESTS: readonly Category[] = ["test"];
const TESTS_AND_BUILD: readonly Category[] = ["test", "build"];
const ANY: readonly Category[] = ["test", "build", "production", "other"];

const edit = (
  id: string,
  scope: readonly Category[],
  instruction: string,
  ifUnchanged?: string,
): Phase => ({
  id,
  kind: "edit",
  scope,
  instruction: `${instruction} Call compose_test_step when done.`,
  ...(ifUnchanged ? { ifUnchanged } : {}),
});
const auto = (id: string, kind: PhaseKind, instruction: string): Phase => ({
  id,
  kind,
  scope: [],
  instruction,
});

const verify = auto(
  "verify",
  "verify",
  "Call compose_test_step. The extension runs the targets and requires them to pass.",
);
const mutation = auto(
  "negative-control",
  "mutation",
  "Call compose_test_mutate with an exact find/replace in the production code under test that breaks the behavior the tests cover. The extension applies it, requires a test failure (not a compile error), and restores the file.",
);

export const workflows = {
  "write-test": {
    trigger: "Create tests for existing or new Compose UI behavior.",
    phases: [
      edit(
        "write",
        TESTS,
        "Read the composable, then write tests under src/test that pin its user-observable behavior. Only test files may change.",
      ),
      verify,
      mutation,
    ],
    preserveTests: false,
    createsTargets: true,
    references: ["writing-tests.md", "synchronization.md"],
  },
  setup: {
    trigger: "Set up Robolectric testing infrastructure for Compose.",
    phases: [
      edit(
        "configure",
        TESTS_AND_BUILD,
        "Add the Robolectric and Compose test dependencies and testOptions, plus one smoke test under src/test for an existing composable. Only build and test files may change.",
      ),
      verify,
      mutation,
    ],
    preserveTests: false,
    createsTargets: true,
    references: ["setup.md", "writing-tests.md"],
  },
  "fix-failing": {
    trigger: "Reproduce and fix a failing Compose test.",
    phases: [
      auto(
        "reproduce",
        "reproduce",
        "Call compose_test_step. The extension runs the targets and requires the failure to reproduce.",
      ),
      edit(
        "fix",
        ANY,
        "Trace the failure to its root cause and fix it there, in production or test code. Do not weaken, delete or @Ignore tests.",
        "Nothing changed since start, so a passing run now would only show that the test fails only sometimes. A test that fails only sometimes belongs in fix-flaky.",
      ),
      verify,
      auto(
        "regression-check",
        "regression",
        "Call compose_test_step. If production code changed, the extension requires the tests to fail on the original production code. If only tests changed, call compose_test_mutate instead.",
      ),
    ],
    preserveTests: true,
    createsTargets: false,
    references: ["debugging.md", "synchronization.md"],
  },
  "fix-flaky": {
    trigger: "Make a flaky Compose test deterministic.",
    phases: [
      auto(
        "baseline",
        "inventory",
        "Call compose_test_step. The extension runs the targets once to record their cases; they may pass or fail.",
      ),
      edit(
        "fix",
        ANY,
        "Find the source of nondeterminism (real time, unsynchronized coroutine, shared state, rogue thread) and remove it. Retries, sleeps and @Ignore are not fixes.",
        "Nothing changed since start, so passing stress runs would prove nothing. Find the source of nondeterminism and remove it.",
      ),
      auto(
        "stress",
        "stress",
        "Call compose_test_step. The extension reruns the targets and requires every run to pass.",
      ),
      mutation,
    ],
    preserveTests: true,
    createsTargets: false,
    references: ["synchronization.md", "debugging.md"],
  },
  refactor: {
    trigger: "Simplify tests without losing what they verify.",
    phases: [
      auto(
        "baseline",
        "verify",
        "Call compose_test_step. The extension requires the targets to pass before any change.",
      ),
      edit("refactor", TESTS, "Simplify the test files. Only test files may change."),
      verify,
      mutation,
    ],
    preserveTests: false,
    createsTargets: false,
    references: ["writing-tests.md"],
  },
  performance: {
    trigger: "Make Compose Robolectric tests faster.",
    phases: [
      auto("baseline", "measure", "Call compose_test_step. The extension times the targets."),
      edit(
        "optimize",
        TESTS_AND_BUILD,
        "Reduce test time without dropping coverage. Only test and build files may change.",
        "Nothing changed since the baseline measure, so any difference in test time would be noise. Change the tests or the build to make them faster.",
      ),
      auto(
        "after",
        "measure",
        "Call compose_test_step. The extension times the targets again and requires every run to beat every baseline run, the median by at least 5%, with every test passing.",
      ),
    ],
    preserveTests: true,
    createsTargets: false,
    references: ["setup.md"],
  },
  migrate: {
    trigger: "Move an instrumented (androidTest) Compose test to Robolectric.",
    phases: [
      edit(
        "migrate",
        TESTS,
        "Write the Robolectric version under src/test with every case from the source. If every case moved, delete the androidTest source now. Only test files may change.",
      ),
      verify,
      mutation,
    ],
    preserveTests: false,
    createsTargets: true,
    references: ["debugging.md", "writing-tests.md"],
  },
  review: {
    trigger: "Review or audit tests, or find untested behavior.",
    phases: [
      {
        id: "review",
        kind: "findings",
        scope: [],
        instruction:
          "Read every target. Record each problem or untested behavior with compose_test_finding (file, line, rule, severity, message). The extension adds its own lint findings. Call compose_test_step when done.",
      },
    ],
    preserveTests: false,
    createsTargets: false,
    references: ["writing-tests.md"],
  },
} as const satisfies Record<string, Workflow>;

export type WorkflowId = keyof typeof workflows;
export const isWorkflowId = (value: unknown): value is WorkflowId =>
  typeof value === "string" && Object.hasOwn(workflows, value);
export const workflowIds: readonly WorkflowId[] = Object.keys(workflows).filter(isWorkflowId);
export const allowedChanges = (id: WorkflowId): ReadonlySet<Category> =>
  new Set(workflows[id].phases.flatMap((p): readonly Category[] => p.scope));

export const skillDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "compose-robolectric",
);

export function methodology(): string {
  const body = readFileSync(join(skillDir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\n/, "");
  return body.slice(0, body.indexOf("## References")).trim();
}

export function kickoff(goal: string, forced: WorkflowId | null): string {
  const routing = forced
    ? `The operator selected the ${forced} workflow: ${workflows[forced].trigger}`
    : `Pick the workflow whose trigger matches the request:\n${workflowIds.map((id) => `- ${id}: ${workflows[id].trigger}`).join("\n")}`;
  return [
    `compose-test request: ${goal}`,
    routing,
    "Find the target files, then call compose_test_start. Files cannot be edited before that.",
    "The extension runs every Gradle test, applies and reverts negative controls, and writes the final status. You do not run Gradle yourself, and your prose cannot change the status.",
    "",
    "Core rules (already loaded; do not read SKILL.md again):",
    methodology(),
    "",
    `References live in ${join(skillDir, "references")}; compose_test_start names the ones that apply.`,
  ].join("\n");
}
