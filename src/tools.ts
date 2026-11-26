import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  addFinding,
  block,
  type Deps,
  mutate,
  start,
  step,
  type StepResult,
  WorkflowError,
} from "./engine.ts";
import { currentPhase, isRun, type Run } from "./state.ts";
import { stateDir } from "./swap.ts";
import { skillDir, type WorkflowId, workflowIds, workflows } from "./workflows.ts";

export const STATE_ENTRY = "compose-test-state";

const reply = (run: Run, message: string) => ({
  content: [{ type: "text" as const, text: message }],
  details: { status: run.status, workflow: run.workflow, phase: currentPhase(run)?.id ?? null },
});

/** The run for the current session branch. Every change is persisted as a session entry. */
export class Session {
  private current: Run | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  get run(): Run | null {
    return this.current;
  }

  set(run: Run): Run {
    this.current = run;
    this.pi.appendEntry(STATE_ENTRY, run);
    return run;
  }

  /** Rebuild from the latest state on the active branch; abandoned branches are ignored. */
  restore(ctx: ExtensionContext): void {
    this.current = null;
    for (const entry of ctx.sessionManager.getBranch())
      if (entry.type === "custom" && entry.customType === STATE_ENTRY && isRun(entry.data))
        this.current = entry.data;
  }

  /** Serialize Gradle runs and file swaps, even when tool calls run in parallel. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  require(): Run {
    if (this.current) return this.current;
    throw new WorkflowError(
      "No compose-test request is active. The operator starts one with /compose-test.",
    );
  }

  respond(result: StepResult) {
    return reply(this.set(result.run), result.message);
  }

  /** Run serialized work; keep its result only if nothing (such as a cancel) changed the run meanwhile. */
  commit(work: (run: Run) => Promise<StepResult>) {
    return this.exclusive(async () => {
      const before = this.require();
      const result = await work(before);
      const now = this.require();
      if (now.revision === before.revision) return this.respond(result);
      return reply(
        now,
        `Discarded: the run changed while this ran (now ${now.status}).\n${result.message}`,
      );
    });
  }

  deps(ctx: ExtensionContext, signal?: AbortSignal): Deps {
    return {
      cwd: ctx.cwd,
      dir: stateDir(ctx.cwd),
      exec: (command, args, options) =>
        this.pi.exec(command, [...args], {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      ...(signal ? { signal } : {}),
    };
  }
}

function registerStart(pi: ExtensionAPI, session: Session) {
  pi.registerTool({
    name: "compose_test_start",
    label: "Start compose-test workflow",
    description:
      "Start the workflow for the active /compose-test request. Targets are local test files under src/test, or any files for review.",
    parameters: Type.Object({
      workflow: Type.Unsafe<WorkflowId>({ type: "string", enum: [...workflowIds] }),
      targets: Type.Array(
        Type.Object({ file: Type.String(), method: Type.Optional(Type.String()) }),
        { minItems: 1 },
      ),
      subject: Type.Optional(
        Type.Array(Type.String(), { description: "Production files under test" }),
      ),
      source: Type.Optional(Type.String({ description: "migrate only: the androidTest file" })),
    }),
    async execute(_id, { workflow, targets, subject, source }, _signal, _update, ctx) {
      const input = {
        workflow,
        targets,
        ...(subject ? { subject } : {}),
        ...(source ? { source } : {}),
      };
      const result = start(session.require(), input, ctx.cwd);
      const refs = workflows[workflow].references.map((f) => join(skillDir, "references", f));
      return session.respond({
        ...result,
        message: `${result.message}\nReferences:\n${refs.join("\n")}`,
      });
    },
  });
}

function registerPhaseTools(pi: ExtensionAPI, session: Session) {
  pi.registerTool({
    name: "compose_test_step",
    label: "Complete compose-test phase",
    description:
      "Complete the current phase. For test-running phases the extension runs Gradle and decides the outcome.",
    parameters: Type.Object({}),
    execute: (_id, _params, signal, _update, ctx) =>
      session.commit((run) => step(run, session.deps(ctx, signal))),
  });
  pi.registerTool({
    name: "compose_test_mutate",
    label: "Negative control",
    description:
      "Temporarily replace `find` (exactly one match) with `replace` in a production file, run the targets, restore the file. The tests must fail.",
    parameters: Type.Object({ file: Type.String(), find: Type.String(), replace: Type.String() }),
    execute: (_id, params, signal, _update, ctx) =>
      session.commit((run) => mutate(run, params, session.deps(ctx, signal))),
  });
}

function registerRecordTools(pi: ExtensionAPI, session: Session) {
  pi.registerTool({
    name: "compose_test_finding",
    label: "Record finding",
    description: "Record one review finding at a real file and line.",
    parameters: Type.Object({
      file: Type.String(),
      line: Type.Integer({ minimum: 1 }),
      rule: Type.String(),
      severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
      message: Type.String(),
    }),
    execute: (_id, params, _signal, _update, ctx) =>
      session.commit(async (run) => addFinding(run, params, ctx.cwd)),
  });
  pi.registerTool({
    name: "compose_test_block",
    label: "Report blocker",
    description:
      "End the workflow as BLOCKED. Allowed only when the two most recent extension runs executed no tests (broken build, offline).",
    parameters: Type.Object({ reason: Type.String() }),
    async execute(_id, { reason }) {
      return session.respond(block(session.require(), reason));
    },
  });
}

export function registerTools(pi: ExtensionAPI, session: Session) {
  registerStart(pi, session);
  registerPhaseTools(pi, session);
  registerRecordTools(pi, session);
}
