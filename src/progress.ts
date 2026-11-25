import type { Config } from "./config.ts";
import { categorize, type FileCategory } from "./paths.ts";
import { finish, revise, type Run } from "./state.ts";
import { changedPaths, fingerprint } from "./tree.ts";
import { workflows } from "./workflows.ts";

function allowedSoFar(run: Run): Set<FileCategory> {
  const phases = run.workflow ? workflows[run.workflow].phases : [];
  return new Set(phases.slice(0, run.phaseIndex + 1).flatMap((p) => p.scope));
}

export function changes(run: Run, cwd: string) {
  return run.baseline ? changedPaths(cwd, run.baseline, fingerprint(cwd)) : [];
}

export function scopeViolations(run: Run, cwd: string) {
  const allowed = allowedSoFar(run);
  return changes(run, cwd).filter((path) => !allowed.has(categorize(path)));
}

/** Send the run back to its most recent edit phase, or end it once the retry budget is spent. */
export function backtrack(run: Run, reason: string, config: Config): Run {
  const phases = run.workflow ? workflows[run.workflow].phases : [];
  const editIndex = phases.slice(0, run.phaseIndex).findLastIndex((p) => p.kind === "edit");
  if (editIndex < 0) return finish(run, "incomplete", reason);
  if (run.backtracks >= config.maxBacktracks)
    return finish(run, "incomplete", `${reason} (gave up after ${run.backtracks} retries)`);
  return revise(run, {
    phaseIndex: editIndex,
    backtracks: run.backtracks + 1,
    reads: [],
    statusReason: reason,
  });
}
