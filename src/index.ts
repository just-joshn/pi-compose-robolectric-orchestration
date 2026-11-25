import { isAbsolute, relative, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

import { safeConfig } from "./config.ts";
import { nextStep } from "./engine.ts";
import { recheck } from "./finalize.ts";
import { categorize } from "./paths.ts";
import { kickoff } from "./prompts.ts";
import { report, statusLine } from "./report.ts";
import { Session } from "./session.ts";
import { currentPhase, finish, newRun, type Run, terminal } from "./state.ts";
import { recoverSwap } from "./swap.ts";
import { registerTools } from "./tools.ts";
import { isWorkflowId, routingTable } from "./workflows.ts";
import { stateDir } from "./workspace.ts";

const EDIT_TOOLS = new Set(["edit", "write"]);
const pathInput = (input: Record<string, unknown>) =>
  typeof input["path"] === "string" ? input["path"] : "";

function showStatus(ctx: ExtensionContext, session: Session) {
  const run = session.run;
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("compose-test", run ? statusLine(run, currentPhase(run)?.id) : undefined);
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stdout.write(`${message}\n`);
}

/** Repair interrupted file swaps, then restore the branch's run. Neither step can block the other. */
function onSessionStart(pi: ExtensionAPI, session: Session) {
  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    try {
      const { restored, conflicts } = recoverSwap(stateDir(ctx.cwd));
      if (restored.length)
        notify(
          ctx,
          `compose-test restored ${restored.join(", ")} after an interrupted run.`,
          "warning",
        );
      if (conflicts.length)
        notify(ctx, `compose-test left changed files alone: ${conflicts.join(", ")}`, "warning");
    } catch (error) {
      notify(ctx, `compose-test could not repair an interrupted run: ${String(error)}`, "warning");
    }
    session.restore(ctx);
    if (!session.run || terminal(session.run.status)) session.release(ctx);
    showStatus(ctx, session);
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", async (_event, ctx) => session.release(ctx));
}

function registerCommand(pi: ExtensionAPI, session: Session) {
  pi.registerCommand("compose-test", {
    description:
      "Run a Compose + Robolectric test workflow: /compose-test [workflow] <goal and acceptance criteria>",
    getArgumentCompletions: (prefix) => {
      const ids = routingTable()
        .split("\n")
        .map((line) => line.slice(2).split(":")[0] ?? "");
      const items = ["status", "cancel", ...ids]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const [first = "", ...rest] = input.split(/\s+/);
      if (!input || first === "status")
        return notify(
          ctx,
          session.run ? report(session.run) : `No compose-test run.\n${routingTable()}`,
        );
      if (first === "cancel") {
        const run = session.run;
        if (!run || terminal(run.status)) return notify(ctx, "No active compose-test run.");
        const cancelled = session.set(finish(run, "incomplete", "Cancelled by the operator."));
        session.exclusive(async () => session.release(ctx)).catch(() => undefined);
        return notify(ctx, report(cancelled));
      }
      const forced = isWorkflowId(first) ? first : null;
      const goal = forced ? rest.join(" ") : input;
      if (!goal)
        return notify(ctx, "Describe the goal and acceptance criteria after the workflow name.");
      const previous = session.run;
      if (previous && !terminal(previous.status))
        session.set(finish(previous, "incomplete", "Superseded by a new request."));
      session.set(newRun(goal, forced));
      showStatus(ctx, session);
      pi.sendUserMessage(kickoff(goal, forced));
      await new Promise((settle) => setTimeout(settle, 20));
      await ctx.waitForIdle();
    },
  });
}

/** Paths the run may never touch: anything outside the workspace. */
function outsideWorkspace(cwd: string, path: string) {
  const rel = relative(cwd, resolve(cwd, path));
  return rel.startsWith("..") || isAbsolute(rel);
}

function editGate(run: Run, cwd: string, path: string): string | undefined {
  if (run.status === "routing")
    return "compose-test: call compose_test_start before editing files.";
  if (outsideWorkspace(cwd, path)) return `compose-test: ${path} is outside the workspace.`;
  const phase = currentPhase(run);
  if (!phase) return `compose-test: no phase is active. ${nextStep(run)}`;
  const category = categorize(relative(cwd, resolve(cwd, path)));
  if (phase.scope.includes(category)) return undefined;
  const allowed = phase.scope.length ? phase.scope.join(", ") : "nothing";
  return `compose-test: phase "${phase.id}" may change ${allowed}; ${path} is ${category}. ${nextStep(run)}`;
}

const statusEntry = (run: Run) => ({
  type: "custom_message" as const,
  customType: "compose-test-status",
  content: report(run),
  display: true,
});
const gateEntry = (content: string) => ({
  type: "custom_message" as const,
  customType: "compose-test-gate",
  content,
  display: true,
});

function registerGates(pi: ExtensionAPI, session: Session) {
  pi.on("tool_call", async (event, ctx) => {
    const run = session.run;
    if (!run || terminal(run.status) || !EDIT_TOOLS.has(event.toolName)) return undefined;
    const reason = editGate(run, ctx.cwd, pathInput(event.input));
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const run = session.run;
    if (!run || run.status !== "active" || event.toolName !== "read" || event.isError) return;
    const path = relative(ctx.cwd, resolve(ctx.cwd, pathInput(event.input)));
    if (!run.reads.includes(path)) session.set({ ...run, reads: [...run.reads, path] });
  });

  /**
   * The final actionable boundary. Fails closed: if anything here throws, the run continues
   * with the error shown, and the nudge budget still bounds it.
   */
  pi.on("agent_before_settle", async (event, ctx) => {
    const run = session.run;
    if (!run) return undefined;
    try {
      return settle(run, ctx, event.entries);
    } catch (error) {
      if (terminal(run.status)) return undefined;
      return {
        entries: [
          ...event.entries,
          gateEntry(`compose-test gate error: ${String(error)}. ${nextStep(run)}`),
        ],
        continue: true,
      };
    }
  });

  function settle(initial: Run, ctx: ExtensionContext, entries: readonly SessionBoundaryDraft[]) {
    const { config, error } = safeConfig(ctx.cwd, ctx.isProjectTrusted());
    if (error) notify(ctx, `compose-test config ignored: ${error}`, "warning");
    let run =
      initial.status === "verified" && initial.reported !== initial.revision
        ? session.set(recheck(initial, { cwd: ctx.cwd, config }))
        : initial;
    const post = (final: Run) => {
      session.set({ ...final, reported: final.revision });
      session.release(ctx);
      showStatus(ctx, session);
      return { entries: [...entries, statusEntry(final)] };
    };
    if (terminal(run.status)) return run.reported === run.revision ? undefined : post(run);
    const stalled = session.settledRevision === run.revision;
    session.settledRevision = run.revision;
    run = session.set({
      ...run,
      stalls: stalled ? run.stalls + 1 : run.stalls,
      nudges: run.nudges + 1,
    });
    if (run.stalls >= config.maxStalls || run.nudges > config.maxNudges) {
      const why =
        run.stalls >= config.maxStalls
          ? `stopped ${run.stalls + 1} times without progress`
          : `needed more than ${config.maxNudges} continuations`;
      const ended = session.set(finish(run, "incomplete", `The agent ${why}. ${nextStep(run)}`));
      session.settledRevision = ended.revision;
      return post(ended);
    }
    const instruction =
      run.status === "routing"
        ? "Call compose_test_start with the workflow and targets."
        : nextStep(run);
    showStatus(ctx, session);
    return {
      entries: [
        ...entries,
        gateEntry(`compose-test is not finished, so do not report completion. ${instruction}`),
      ],
      continue: true,
    };
  }
}

export default function composeTest(pi: ExtensionAPI) {
  const session = new Session(pi);
  onSessionStart(pi, session);
  registerCommand(pi, session);
  registerTools(pi, session);
  registerGates(pi, session);
}
