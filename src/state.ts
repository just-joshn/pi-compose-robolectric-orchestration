import type { Outcome, Target, TestCase } from "./gradle.ts";
import type { LintFinding } from "./lint.ts";
import type { Fingerprint } from "./tree.ts";
import { isWorkflowId, type Phase, type WorkflowId, workflows } from "./workflows.ts";

export type Purpose = "verify" | "reproduce" | "mutation" | "regression" | "stress" | "measure";

export interface TestRun {
  readonly id: number;
  readonly phase: string;
  readonly purpose: Purpose;
  readonly command: string;
  readonly exitCode: number;
  readonly outcome: Outcome;
  readonly cases: readonly TestCase[];
  readonly seconds: number;
  readonly outputTail: string;
  /** Digest of the tree the tests ran against (the pre-swap tree for mutation and regression runs). */
  readonly tree: string;
}

export interface Mutation {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly runId: number;
  readonly tree: string;
  readonly detected: boolean;
}

export interface Finding extends LintFinding {
  readonly source: "agent" | "lint";
}

/** routing: /compose-test was issued and no workflow has started yet. */
export type Status = "routing" | "active" | "verified" | "blocked" | "incomplete";
const STATUSES: readonly Status[] = ["routing", "active", "verified", "blocked", "incomplete"];

export interface Run {
  readonly version: 2;
  readonly goal: string;
  readonly status: Status;
  readonly statusReason: string;
  /** Workflow fixed by `/compose-test <workflow> ...`. */
  readonly forcedWorkflow: WorkflowId | null;
  readonly workflow: WorkflowId | null;
  readonly targets: readonly Target[];
  readonly subject: readonly string[];
  readonly source: string | null;
  readonly phaseIndex: number;
  readonly baseline: Fingerprint | null;
  /** File holding the start content of files that were uncommitted at start. */
  readonly snapshot: string | null;
  /** @Test names in the targets at start. */
  readonly baselineTests: readonly string[];
  readonly runs: readonly TestRun[];
  readonly mutations: readonly Mutation[];
  readonly findings: readonly Finding[];
  /** Files opened with the read tool during the current phase. */
  readonly reads: readonly string[];
  readonly nudges: number;
  readonly backtracks: number;
  /** Revision whose terminal status was posted. */
  readonly reported: number;
  readonly revision: number;
}

export const terminal = (status: Status) =>
  status === "verified" || status === "blocked" || status === "incomplete";

export const newRun = (goal: string, forcedWorkflow: WorkflowId | null): Run => ({
  version: 2,
  goal,
  status: "routing",
  statusReason: "",
  forcedWorkflow,
  workflow: null,
  targets: [],
  subject: [],
  source: null,
  phaseIndex: 0,
  baseline: null,
  snapshot: null,
  baselineTests: [],
  runs: [],
  mutations: [],
  findings: [],
  reads: [],
  nudges: 0,
  backtracks: 0,
  reported: -1,
  revision: 0,
});

/** Every meaningful change bumps the revision; the settle gate uses it to detect progress. */
export const revise = (run: Run, patch: Partial<Run>): Run => ({
  ...run,
  ...patch,
  nudges: 0,
  revision: run.revision + 1,
});

export const currentPhase = (run: Run): Phase | undefined =>
  run.workflow && run.status === "active"
    ? workflows[run.workflow].phases[run.phaseIndex]
    : undefined;

export const finish = (run: Run, status: "verified" | "blocked" | "incomplete", reason: string) =>
  revise(run, { status, statusReason: reason });

export const advance = (run: Run) =>
  revise(run, { phaseIndex: run.phaseIndex + 1, reads: [], statusReason: "" });

export const addRun = (run: Run, testRun: Omit<TestRun, "id">): [Run, TestRun] => {
  const recorded = { ...testRun, id: run.runs.length + 1 };
  return [revise(run, { runs: [...run.runs, recorded] }), recorded];
};

/** Accept a persisted run only if it has the current shape and a reachable phase. */
export function parseRun(value: unknown): Run | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const workflow = v["workflow"];
  const status = v["status"];
  const phase = v["phaseIndex"];
  if (v["version"] !== 2 || (workflow !== null && !isWorkflowId(workflow))) return null;
  if (!STATUSES.some((s) => s === status) || typeof phase !== "number" || !Number.isInteger(phase))
    return null;
  const phases = workflow === null ? 0 : workflows[workflow].phases.length;
  if (
    phase < 0 ||
    phase > (status === "active" ? phases - 1 : phases) ||
    (status === "active" && workflow === null)
  )
    return null;
  return value as Run;
}

const runLine = (r: TestRun) => {
  const failed = r.cases.filter((c) => c.status === "failed");
  const first = failed[0]
    ? ` - first failure ${failed[0].name}: ${(failed[0].message ?? "").split("\n")[0]}`
    : "";
  return `- run #${r.id} ${r.phase}/${r.purpose}: ${r.outcome} (exit ${r.exitCode}, ${r.cases.length} cases, ${failed.length} failed, ${r.seconds}s)${first}`;
};

/** The authoritative status, built only from recorded evidence. */
export function report(run: Run): string {
  return [
    `compose-test status: ${run.status.toUpperCase()}`,
    `Workflow: ${run.workflow ?? "(none started)"}`,
    `Goal: ${run.goal}`,
    `Reason: ${run.statusReason || "-"}`,
    ...(run.targets.length
      ? [
          `Targets: ${run.targets.map((t) => (t.method ? `${t.file}#${t.method}` : t.file)).join(", ")}`,
        ]
      : []),
    ...(run.runs.length
      ? [
          "Test runs (executed by the extension):",
          ...run.runs.map(runLine),
          `Command: ${run.runs.at(-1)?.command}`,
        ]
      : []),
    ...run.mutations.map(
      (m) =>
        `Negative control: ${m.file}: "${m.find.slice(0, 80)}" -> "${m.replace.slice(0, 80)}" (run #${m.runId}, ${m.detected ? "detected" : "NOT detected"})`,
    ),
    ...(run.findings.length
      ? [
          `Findings (${run.findings.length}):`,
          ...run.findings.map(
            (f) => `- ${f.file}:${f.line} [${f.severity}] ${f.rule} (${f.source}): ${f.message}`,
          ),
        ]
      : []),
  ].join("\n");
}

export const MAX_BACKTRACKS = 3;

/** Send the run back to its last edit phase with the reason, or end it once retries are spent. */
export function backtrack(run: Run, reason: string): Run {
  const phases = run.workflow ? workflows[run.workflow].phases : [];
  const edit = phases.slice(0, run.phaseIndex).findLastIndex((p) => p.kind === "edit");
  if (edit < 0) return finish(run, "incomplete", reason);
  if (run.backtracks >= MAX_BACKTRACKS)
    return finish(run, "incomplete", `${reason} (gave up after ${run.backtracks} retries)`);
  return revise(run, {
    phaseIndex: edit,
    backtracks: run.backtracks + 1,
    reads: [],
    statusReason: reason,
  });
}
