import { isAbsolute, relative, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

import { recheck } from "./checks.ts";
import { nextStep } from "./engine.ts";
import { currentPhase, finish, newRun, report, type Run, terminal } from "./state.ts";
import { recoverSwap, stateDir } from "./swap.ts";
import { registerTools, Session } from "./tools.ts";
import { categorize, isWorkflowId, kickoff, workflowIds } from "./workflows.ts";

/** Continuations without progress before a run ends as INCOMPLETE. */
const MAX_NUDGES = 3;

const pathOf = (input: Record<string, unknown>) =>
  typeof input["path"] === "string" ? input["path"] : "";

function say(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) ctx.ui.notify(message, "info");
  else process.stdout.write(`${message}\n`);
}

/** Why an edit/write call is refused, if it is. */
function editBlock(run: Run, cwd: string, path: string): string | undefined {
  if (run.status === "routing")
    return "compose-test: call compose_test_start before editing files.";
  const rel = relative(cwd, resolve(cwd, path));
  if (rel.startsWith("..") || isAbsolute(rel))
    return `compose-test: ${path} is outside the workspace.`;
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

/** `status` and `cancel`, or undefined when the arguments start a new run. */
function control(session: Session, first: string): string | undefined {
  const run = session.run;
  if (!first || first === "status")
    return run ? report(run) : `No compose-test run. Workflows: ${workflowIds.join(", ")}`;
  if (first !== "cancel") return undefined;
  if (!run || terminal(run.status)) return "No active compose-test run.";
  return report(session.set(finish(run, "incomplete", "Cancelled by the operator.")));
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
      const [first = "", ...rest] = args.trim().split(/\s+/);
      const answer = control(session, first);
      if (answer !== undefined) return say(ctx, answer);
      const forced = isWorkflowId(first) ? first : null;
      const goal = forced ? rest.join(" ") : args.trim();
      if (!goal) return say(ctx, "Describe the goal after the workflow name.");
      const run = session.run;
      if (run && !terminal(run.status))
        session.set(finish(run, "incomplete", "Superseded by a new request."));
      session.set(newRun(goal, forced));
      pi.sendUserMessage(kickoff(goal, forced));
      // sendUserMessage starts the turn asynchronously; wait for it to begin, then to finish.
      for (let i = 0; i < 200 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 10));
      await ctx.waitForIdle();
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
    const path = relative(ctx.cwd, resolve(ctx.cwd, pathOf(event.input)));
    if (!run.reads.includes(path)) session.set({ ...run, reads: [...run.reads, path] });
  });
}

/**
 * Decide what happens when the agent stops: re-check VERIFIED, post a terminal status once, end a
 * run that keeps stopping without progress, or return the continuation message.
 */
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
