import type { Run, TestRun } from "./state.ts";

const runLine = (r: TestRun) => {
  const failed = r.cases.filter((c) => c.status === "failed");
  const first = failed[0];
  const failure = first
    ? ` - first failure ${first.name}: ${(first.message ?? first.failureType ?? "").split("\n")[0]}`
    : "";
  return `- run #${r.id} ${r.phase}/${r.purpose}: ${r.outcome} (exit ${r.exitCode}, ${r.cases.length} cases, ${failed.length} failed, ${r.seconds}s, tree ${r.tree})${failure}`;
};

/** The authoritative status. Built only from recorded evidence, never from model prose. */
export function report(run: Run): string {
  const lines = [
    `compose-test status: ${run.status.toUpperCase()}`,
    `Workflow: ${run.workflow ?? "(none started)"}`,
    `Goal: ${run.goal}`,
    `Reason: ${run.statusReason || "-"}`,
  ];
  if (run.targets.length)
    lines.push(
      `Targets: ${run.targets.map((t) => (t.method ? `${t.file}#${t.method}` : t.file)).join(", ")}`,
    );
  const notes = Object.entries(run.notes);
  if (notes.length) lines.push("Notes:", ...notes.map(([phase, note]) => `- ${phase}: ${note}`));
  if (run.runs.length)
    lines.push("Test runs (executed by the extension):", ...run.runs.map(runLine));
  if (run.runs.length) lines.push(`Command: ${run.runs.at(-1)?.command ?? ""}`);
  for (const m of run.mutations) {
    lines.push(
      `Negative control: ${m.file}: "${m.find.slice(0, 80)}" -> "${m.replace.slice(0, 80)}" (run #${m.runId}, ${m.detected ? "detected" : "NOT detected"}, ${m.restored ? "restored" : "NOT restored"})`,
    );
  }
  if (run.findings.length) {
    lines.push(`Findings (${run.findings.length}):`);
    lines.push(
      ...run.findings.map(
        (f) => `- ${f.file}:${f.line} [${f.severity}] ${f.rule} (${f.source}): ${f.message}`,
      ),
    );
  }
  return lines.join("\n");
}

export const statusLine = (run: Run, phase: string | undefined) =>
  run.status === "active" ? `${run.workflow}: ${phase ?? ""}` : `compose-test ${run.status}`;
