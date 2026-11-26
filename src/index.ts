import { relative } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

import { recheck } from "./checks.ts";
import { categorize, inside, toolPath } from "./paths.ts";
import { currentPhase, finish, newRun, nextStep, report, type Run, terminal } from "./state.ts";
import { recoverSwap, stateDir } from "./swap.ts";
import { registerTools, Session } from "./tools.ts";
import { isWorkflowId, kickoff, workflowIds } from "./workflows.ts";

/** Continuations without progress before a run ends as INCOMPLETE. */
const MAX_NUDGES = 3;

const pathOf = (input: Record<string, unknown>) =>
  typeof input["path"] === "string" ? input["path"] : "";

function say(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) ctx.ui.notify(message, "info");
  else process.stdout.write(`${message}\n`);
}

function editBlock(run: Run, cwd: string, path: string): string | undefined {
  if (run.status === "routing")
    return "compose-test: call compose_test_start before editing files.";
  const full = toolPath(cwd, path);
  if (!inside(cwd, full)) return `compose-test: ${path} is outside the workspace.`;
  const rel = relative(cwd, full);
  const phase = currentPhase(run);
  const category = categorize(rel);
  if (phase?.scope.includes(category)) return undefined;
  return `compose-test: phase "${phase?.id ?? "none"}" may change ${phase?.scope.join(", ") || "nothing"}; ${path} is ${category}. ${nextStep(run)}`;
}

const message = (customType: string, content: string): SessionBoundaryDraft => ({
  type: "custom_message",
  customType,
  content,
  display: true,
});

function registerRestore(pi: ExtensionAPI, session: Session) {
  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    try {
      const { restored, conflicts } = recoverSwap(stateDir(ctx.cwd));
      if (restored.length || conflicts.length)
        say(
          ctx,
          `compose-test repaired an interrupted run. Restored: ${restored.join(", ") || "-"}. Left alone: ${conflicts.join(", ") || "-"}.`,
        );
    } catch (error) {
      say(ctx, `compose-test could not repair an interrupted run: ${String(error)}`);
    }
    session.restore(ctx);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
}

function control(session: Session, request: string): string | undefined {
  const run = session.run;
  if (!request || request === "status")
    return run ? report(run) : `No compose-test run. Workflows: ${workflowIds.join(", ")}`;
  if (request !== "cancel") return undefined;
  if (!run || terminal(run.status)) return "No active compose-test run.";
  return report(session.set(finish(run, "incomplete", "Cancelled by the operator.")));
}

/** sendUserMessage starts the turn asynchronously: wait up to 2 s for it to begin, then for it to end. */
async function waitForTurn(ctx: ExtensionCommandContext, polls = 200): Promise<void> {
  if (polls > 0 && ctx.isIdle()) {
    await new Promise((r) => setTimeout(r, 10));
    return waitForTurn(ctx, polls - 1);
  }
  return ctx.waitForIdle();
}

function registerCommand(pi: ExtensionAPI, session: Session) {
  pi.registerCommand("compose-test", {
    description: "Run a Compose + Robolectric test workflow: /compose-test [workflow] <goal>",
    getArgumentCompletions: (prefix) => {
      const items = ["status", "cancel", ...workflowIds]
        .filter((v) => v.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const request = args.trim();
      const answer = control(session, request);
      if (answer !== undefined) return say(ctx, answer);
      const [first = "", ...rest] = request.split(/\s+/);
      const forced = isWorkflowId(first) ? first : null;
      const goal = forced ? rest.join(" ") : request;
      if (!goal) return say(ctx, "Describe the goal after the workflow name.");
      const run = session.run;
      if (run && !terminal(run.status))
        session.set(finish(run, "incomplete", "Superseded by a new request."));
      session.set(newRun(goal, forced));
      pi.sendUserMessage(kickoff(goal, forced));
      await waitForTurn(ctx);
    },
  });
}

function registerToolGates(pi: ExtensionAPI, session: Session) {
  pi.on("tool_call", async (event, ctx) => {
    const run = session.run;
    if (!run || terminal(run.status) || (event.toolName !== "edit" && event.toolName !== "write"))
      return undefined;
    const reason = editBlock(run, ctx.cwd, pathOf(event.input));
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const run = session.run;
    if (run?.status !== "active" || event.toolName !== "read" || event.isError) return;
    if (event.input["offset"] !== undefined || event.input["limit"] !== undefined) return;
    const path = relative(ctx.cwd, toolPath(ctx.cwd, pathOf(event.input)));
    if (!run.reads.includes(path)) session.set({ ...run, reads: [...run.reads, path] });
  });
}

function settle(session: Session, cwd: string): { status: string } | { gate: string } | undefined {
  let run = session.run;
  if (!run) return undefined;
  if (run.status === "verified" && run.reported !== run.revision)
    run = session.set(recheck(run, cwd));
  if (terminal(run.status)) {
    if (run.reported === run.revision) return undefined;
    session.set({ ...run, reported: run.revision });
    return { status: report(run) };
  }
  run = session.set({ ...run, nudges: run.nudges + 1 });
  if (run.nudges > MAX_NUDGES) {
    const reason = `The agent stopped ${MAX_NUDGES + 1} times without progress. ${nextStep(run)}`;
    const ended = finish(run, "incomplete", reason);
    session.set({ ...ended, reported: ended.revision });
    return { status: report(ended) };
  }
  const next =
    run.status === "routing"
      ? "Call compose_test_start with the workflow and targets."
      : nextStep(run);
  return { gate: `compose-test is not finished, so do not report completion. ${next}` };
}

/** The last point before Pi goes idle. Fails closed: an error continues the run. */
function registerSettle(pi: ExtensionAPI, session: Session) {
  pi.on("agent_before_settle", async (event, ctx) => {
    try {
      const decision = settle(session, ctx.cwd);
      if (!decision) return undefined;
      if ("status" in decision)
        return { entries: [...event.entries, message("compose-test-status", decision.status)] };
      return {
        entries: [...event.entries, message("compose-test-gate", decision.gate)],
        continue: true,
      };
    } catch (error) {
      const gate = `compose-test gate error: ${String(error)}`;
      return { entries: [...event.entries, message("compose-test-gate", gate)], continue: true };
    }
  });
}

export default function composeTest(pi: ExtensionAPI) {
  const session = new Session(pi);
  registerTools(pi, session);
  registerRestore(pi, session);
  registerCommand(pi, session);
  registerToolGates(pi, session);
  registerSettle(pi, session);
}
