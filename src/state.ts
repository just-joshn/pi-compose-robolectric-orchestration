import { randomUUID } from "node:crypto";

import type { Outcome, Target, TestCase } from "./gradle.ts";
import { isArrayOf, isOneOf, isRecord, isString, isStringRecord } from "./guards.ts";
import type { LintFinding } from "./lint.ts";
import type { Fingerprint } from "./tree.ts";
import { isWorkflowId, type Phase, type WorkflowId, workflows } from "./workflows.ts";

const PURPOSES = [
  "verify",
  "reproduce",
  "inventory",
  "mutation",
  "regression",
  "stress",
  "measure",
] as const;
export type Purpose = (typeof PURPOSES)[number];
const OUTCOMES: readonly Outcome[] = ["passed", "failed", "build-error", "no-tests"];

export interface TestRun {
  readonly id: number;
  readonly phase: string;
  readonly purpose: Purpose;
  readonly command: string;
  readonly exitCode: number;
  readonly outcome: Outcome;
  readonly cases: readonly TestCase[];
  readonly seconds: number;
  readonly testSeconds: number | null;
  readonly outputTail: string;
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

export type Status = "routing" | "active" | "verified" | "blocked" | "incomplete";
const STATUSES: readonly Status[] = ["routing", "active", "verified", "blocked", "incomplete"];

export interface ReadRange {
  readonly path: string;
  readonly from: number;
  readonly to: number;
}

export const lineCount = (text: string) => text.replace(/\n$/, "").split("\n").length;

export function wholeRead(reads: readonly ReadRange[], path: string, lines: number): boolean {
  let covered = 0;
  for (const range of reads.filter((r) => r.path === path).toSorted((a, b) => a.from - b.from)) {
    if (range.from > covered + 1) break;
    covered = Math.max(covered, range.to);
  }
  return covered >= lines;
}

export interface Run {
  readonly version: 3;
  readonly id: string;
  readonly goal: string;
  readonly status: Status;
  readonly statusReason: string;
  readonly forcedWorkflow: WorkflowId | null;
  readonly workflow: WorkflowId | null;
  readonly targets: readonly Target[];
  readonly subject: readonly string[];
  readonly source: string | null;
  readonly phaseIndex: number;
  readonly baseline: Fingerprint | null;
  readonly snapshot: string | null;
  readonly baselineTests: readonly string[];
  readonly runs: readonly TestRun[];
  readonly mutations: readonly Mutation[];
  readonly findings: readonly Finding[];
  readonly reads: readonly ReadRange[];
  readonly nudges: number;
  readonly backtracks: number;
  readonly reported: number;
  readonly revision: number;
}

export const terminal = (status: Status) =>
  status === "verified" || status === "blocked" || status === "incomplete";

export const newRun = (goal: string, forcedWorkflow: WorkflowId | null): Run => ({
  version: 3,
  id: randomUUID(),
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

export const ranNothing = (r: TestRun) => r.outcome === "build-error" || r.outcome === "no-tests";

export function cannotRunTests(run: Run): string | undefined {
  const recent = run.runs.slice(-2);
  if (recent.length < 2 || !recent.every(ranNothing)) return undefined;
  return `runs #${recent.map((r) => r.id).join(", #")} could not execute tests`;
}

const isTarget = (v: unknown): v is Target =>
  isRecord(v) && isString(v["file"]) && (v["method"] === undefined || isString(v["method"]));
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNullable = (v: unknown, guard: (x: unknown) => boolean) => v === null || guard(v);

function reachable(workflow: WorkflowId | null, status: Status, phase: number): boolean {
  const phases = workflow === null ? 0 : workflows[workflow].phases.length;
  if (status === "active" && workflow === null) return false;
  return phase >= 0 && phase <= (status === "active" ? phases - 1 : phases);
}

const hasStrings = (v: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((k) => isString(v[k]));
const hasNumbers = (v: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((k) => typeof v[k] === "number");

const isCase = (v: unknown): v is TestCase =>
  isRecord(v) &&
  hasStrings(v, ["className", "name"]) &&
  isOneOf(v["status"], ["passed", "failed", "skipped"]) &&
  hasNumbers(v, ["seconds"]) &&
  (v["message"] === undefined || isString(v["message"]));
const isTestRun = (v: unknown): v is TestRun =>
  isRecord(v) &&
  hasStrings(v, ["phase", "command", "outputTail", "tree"]) &&
  isOneOf(v["purpose"], PURPOSES) &&
  isOneOf(v["outcome"], OUTCOMES) &&
  hasNumbers(v, ["id", "exitCode", "seconds"]) &&
  isNullable(v["testSeconds"], (x) => typeof x === "number") &&
  isArrayOf(v["cases"], isCase);
const isMutation = (v: unknown): v is Mutation =>
  isRecord(v) &&
  hasStrings(v, ["file", "find", "replace", "tree"]) &&
  hasNumbers(v, ["runId"]) &&
  typeof v["detected"] === "boolean";
const isFinding = (v: unknown): v is Finding =>
  isRecord(v) &&
  hasStrings(v, ["file", "rule", "message"]) &&
  isOneOf(v["severity"], ["error", "warning"]) &&
  isOneOf(v["source"], ["agent", "lint"]) &&
  hasNumbers(v, ["line"]);
const isFingerprint = (v: unknown): v is Fingerprint =>
  isRecord(v) && isNullable(v["head"], isString) && isStringRecord(v["files"]);

const isWorkflowOrNull = (v: unknown): v is WorkflowId | null => v === null || isWorkflowId(v);

const isReadRange = (v: unknown): v is ReadRange =>
  isRecord(v) && isString(v["path"]) && isNumber(v["from"]) && isNumber(v["to"]);

export function isRun(v: unknown): v is Run {
  if (!isRecord(v) || v["version"] !== 3) return false;
  const { workflow, status, phaseIndex } = v;
  if (!isWorkflowOrNull(workflow) || !isOneOf(status, STATUSES) || !isNumber(phaseIndex))
    return false;
  return (
    isWorkflowOrNull(v["forcedWorkflow"]) &&
    hasStrings(v, ["id", "goal", "statusReason"]) &&
    ["nudges", "backtracks", "reported", "revision"].every((k) => isNumber(v[k])) &&
    ["subject", "baselineTests"].every((k) => isArrayOf(v[k], isString)) &&
    isArrayOf(v["reads"], isReadRange) &&
    isArrayOf(v["runs"], isTestRun) &&
    isArrayOf(v["mutations"], isMutation) &&
    isArrayOf(v["findings"], isFinding) &&
    isArrayOf(v["targets"], isTarget) &&
    isNullable(v["source"], isString) &&
    isNullable(v["snapshot"], isString) &&
    isNullable(v["baseline"], isFingerprint) &&
    reachable(workflow, status, phaseIndex)
  );
}

export function nextStep(run: Run): string {
  const phase = currentPhase(run);
  if (!phase || !run.workflow) return `Workflow ${run.status}: ${run.statusReason}`;
  const why = run.statusReason ? `\nReturned to this phase because: ${run.statusReason}` : "";
  return `Phase ${run.phaseIndex + 1}/${workflows[run.workflow].phases.length} "${phase.id}": ${phase.instruction}${why}`;
}

export function describeRun(r: TestRun): string {
  const failed = r.cases.filter((c) => c.status === "failed");
  return [
    `run #${r.id} (${r.purpose}): ${r.outcome}, ${r.cases.length} cases, ${failed.length} failed, ${r.seconds}s`,
    ...failed.slice(0, 5).map((c) => `  ✗ ${c.className}.${c.name}: ${c.message ?? ""}`),
    ...(r.outcome === "build-error" && r.cases.length === 0 ? [r.outputTail] : []),
  ].join("\n");
}

const runLine = (r: TestRun) => {
  const failed = r.cases.filter((c) => c.status === "failed");
  const first = failed[0]
    ? ` - first failure ${failed[0].name}: ${(failed[0].message ?? "").split("\n")[0]}`
    : "";
  return `- run #${r.id} ${r.phase}/${r.purpose}: ${r.outcome} (exit ${r.exitCode}, ${r.cases.length} cases, ${failed.length} failed, ${r.seconds}s)${first}`;
};

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

const MAX_BACKTRACKS = 3;

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
