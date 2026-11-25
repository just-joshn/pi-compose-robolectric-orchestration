import { relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.ts";
import { nextStep } from "./engine.ts";
import { categorize } from "./paths.ts";
import { kickoff } from "./prompts.ts";
import { report, statusLine } from "./report.ts";
import { Session } from "./session.ts";
import { currentPhase, finish, newRun, terminal } from "./state.ts";
import { registerTools } from "./tools.ts";
import { isWorkflowId, routingTable } from "./workflows.ts";
import { recoverPendingMutation, stateDir } from "./workspace.ts";

const EDIT_TOOLS = new Set(["edit", "write"]);
const pathInput = (input: Record<string, unknown>) =>
  typeof input["path"] === "string" ? input["path"] : "";

function showStatus(ctx: ExtensionContext, session: Session) {
  const run = session.run;
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("compose-test", run ? statusLine(run, currentPhase(run)?.id) : undefined);
}

function onSessionStart(pi: ExtensionAPI, session: Session) {
  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    const restored = recoverPendingMutation(stateDir(ctx.cwd));
    if (restored && ctx.hasUI)
      ctx.ui.notify(
        `compose-test restored ${restored} after an interrupted negative control.`,
        "warning",
      );
    session.restore(ctx);
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
      const items = [
        "status",
        "cancel",
        ...routingTable()
          .split("\n")
          .map((l) => l.slice(2).split(":")[0] ?? ""),
      ]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const [first = "", ...rest] = input.split(/\s+/);
      const notify = (message: string): void => {
        if (ctx.hasUI) ctx.ui.notify(message, "info");
        else process.stdout.write(`${message}\n`);
      };
      if (!input || first === "status")
        return notify(
          session.run ? report(session.run) : `No compose-test run.\n${routingTable()}`,
        );
      if (first === "cancel") {
        const run = session.run;
        if (!run || terminal(run.status)) return notify("No active compose-test run.");
        session.set(finish(run, "incomplete", "Cancelled by the operator."));
        session.release(ctx);
        return notify(report(session.run ?? run));
      }
      const forced = isWorkflowId(first) ? first : null;
      const goal = forced ? rest.join(" ") : input;
      if (!goal)
        return notify(`Describe the goal and acceptance criteria after the workflow name.`);
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

function registerGates(pi: ExtensionAPI, session: Session) {
  pi.on("tool_call", async (event, ctx) => {
    const run = session.run;
    if (!run || terminal(run.status) || !EDIT_TOOLS.has(event.toolName)) return;
    if (run.status === "routing")
      return { block: true, reason: "compose-test: call compose_test_start before editing files." };
    const phase = currentPhase(run);
    const path = pathInput(event.input);
    const category = categorize(relative(ctx.cwd, resolve(ctx.cwd, path)));
    if (phase && !phase.scope.includes(category)) {
      const allowed = phase.scope.length ? phase.scope.join(", ") : "nothing";
      return {
        block: true,
        reason: `compose-test: phase "${phase.id}" may change ${allowed}; ${path} is ${category}. ${nextStep(run)}`,
      };
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    const run = session.run;
    if (!run || run.status !== "active" || event.toolName !== "read" || event.isError) return;
    const path = relative(ctx.cwd, resolve(ctx.cwd, pathInput(event.input)));
    if (!run.reads.includes(path)) session.set({ ...run, reads: [...run.reads, path] });
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    let run = session.run;
    if (!run) return;
    if (terminal(run.status)) {
      if (session.reportedRevision === run.revision) return;
      session.reportedRevision = run.revision;
      session.release(ctx);
      showStatus(ctx, session);
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "compose-test-status",
            content: report(run),
            display: true,
          },
        ],
      };
    }
    const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    if (session.settledRevision === run.revision)
      run = session.set({ ...run, stalls: run.stalls + 1 });
    session.settledRevision = run.revision;
    if (run.stalls >= config.maxStalls) {
      run = session.set(
        finish(
          run,
          "incomplete",
          `The agent stopped ${run.stalls + 1} times without progress. ${nextStep(run)}`,
        ),
      );
      session.reportedRevision = run.revision;
      session.settledRevision = run.revision;
      session.release(ctx);
      showStatus(ctx, session);
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "compose-test-status",
            content: report(run),
            display: true,
          },
        ],
      };
    }
    const instruction =
      run.status === "routing"
        ? "Call compose_test_start with the workflow and targets."
        : nextStep(run);
    const content = `compose-test is not finished, so do not report completion. ${instruction}`;
    showStatus(ctx, session);
    return {
      entries: [
        ...event.entries,
        { type: "custom_message", customType: "compose-test-gate", content, display: true },
      ],
      continue: true,
    };
  });
}

export default function composeTest(pi: ExtensionAPI) {
  const session = new Session(pi);
  onSessionStart(pi, session);
  registerCommand(pi, session);
  registerTools(pi, session);
  registerGates(pi, session);
}
