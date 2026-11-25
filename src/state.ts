import type { TestCase } from "./junit.ts";
import type { LintFinding, Severity } from "./lint.ts";
import type { Target } from "./project.ts";
import type { RunOutcome } from "./runner.ts";
import type { Fingerprint } from "./tree.ts";
import { isWorkflowId, type Phase, type WorkflowId, workflows } from "./workflows.ts";

export type RunPurpose = "verify" | "reproduce" | "mutation" | "probe" | "stress" | "measure";

export interface TestRun {
  readonly id: number;
  readonly phase: string;
  readonly purpose: RunPurpose;
  readonly command: string;
  readonly exitCode: number;
  readonly outcome: RunOutcome;
  readonly cases: readonly TestCase[];
  readonly seconds: number;
  readonly outputTail: string;
  readonly tree: string;
}

export interface MutationRecord {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly runId: number;
  /** Tree digest before the mutation was applied. */
  readonly tree: string;
  readonly detected: boolean;
  readonly restored: boolean;
}

export interface Finding extends LintFinding {
  readonly source: "agent" | "lint";
}

/** routing: /compose-test was issued and no workflow has started yet. */
export type Status = "routing" | "active" | "verified" | "blocked" | "incomplete";

export interface Run {
  readonly version: 1;
  readonly goal: string;
  readonly status: Status;
  readonly statusReason: string;
  /** Workflow fixed by `/compose-test <workflow> ...`; the model cannot start another one. */
  readonly forcedWorkflow: WorkflowId | null;
  readonly workflow: WorkflowId | null;
  readonly targets: readonly Target[];
  readonly subject: readonly string[];
  readonly source: string | null;
  readonly phaseIndex: number;
  readonly notes: Readonly<Record<string, string>>;
  readonly baseline: Fingerprint | null;
  readonly baselineIgnores: number;
  /** Names of the @Test functions in the targets when the workflow started. */
  readonly baselineTests: readonly string[];
  readonly runs: readonly TestRun[];
  readonly mutations: readonly MutationRecord[];
  readonly findings: readonly Finding[];
  /** Consecutive settle boundaries without progress. Reset by any state change. */
  readonly stalls: number;
  /** Times a failed check sent the workflow back to an earlier edit phase. */
  readonly backtracks: number;
  /** Files the agent opened with the read tool during the current phase. */
  readonly reads: readonly string[];
  readonly revision: number;
}

export const terminal = (status: Status) =>
  status === "verified" || status === "blocked" || status === "incomplete";

export function newRun(goal: string, forcedWorkflow: WorkflowId | null): Run {
  return {
    version: 1,
    goal,
    status: "routing",
    statusReason: "",
    forcedWorkflow,
    workflow: null,
    targets: [],
    subject: [],
    source: null,
    phaseIndex: 0,
    notes: {},
    baseline: null,
    baselineIgnores: 0,
    baselineTests: [],
    runs: [],
    mutations: [],
    findings: [],
    stalls: 0,
    backtracks: 0,
    reads: [],
    revision: 0,
  };
}

export const revise = (run: Run, patch: Partial<Run>): Run => ({
  ...run,
  ...patch,
  stalls: 0,
  revision: run.revision + 1,
});

export function currentPhase(run: Run): Phase | undefined {
  if (!run.workflow || run.status !== "active") return undefined;
  return workflows[run.workflow].phases[run.phaseIndex];
}

export function finish(
  run: Run,
  status: "verified" | "blocked" | "incomplete",
  reason: string,
): Run {
  return revise(run, { status, statusReason: reason });
}

export const advance = (run: Run, note?: string): Run => {
  const phase = currentPhase(run);
  if (!phase || !run.workflow) return run;
  const notes = note === undefined ? run.notes : { ...run.notes, [phase.id]: note };
  return revise(run, { phaseIndex: run.phaseIndex + 1, notes, reads: [], statusReason: "" });
};

export const addRun = (run: Run, testRun: Omit<TestRun, "id">): [Run, TestRun] => {
  const recorded = { ...testRun, id: run.runs.length + 1 };
  return [revise(run, { runs: [...run.runs, recorded] }), recorded];
};

export const lastRun = (run: Run, purpose?: RunPurpose) =>
  [...run.runs].reverse().find((r) => purpose === undefined || r.purpose === purpose);

export const errorFindings = (findings: readonly LintFinding[]) =>
  findings.filter((f) => f.severity === ("error" satisfies Severity));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Accept a persisted run only if it has the current shape; anything else is discarded. */
export function parseRun(value: unknown): Run | null {
  if (!isRecord(value) || value["version"] !== 1) return null;
  const workflow = value["workflow"];
  if (workflow !== null && !isWorkflowId(workflow)) return null;
  if (typeof value["goal"] !== "string" || typeof value["phaseIndex"] !== "number") return null;
  if (!Array.isArray(value["runs"]) || !Array.isArray(value["targets"])) return null;
  return value as unknown as Run;
}
