import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  addFinding,
  block,
  mutate,
  start,
  step,
  type StepResult,
  WorkflowError,
} from "./engine.ts";
import { referencePaths } from "./prompts.ts";
import type { Session } from "./session.ts";
import { currentPhase, type Run } from "./state.ts";
import { workflowIds } from "./workflows.ts";
import { acquireLock, stateDir } from "./workspace.ts";

const text = (value: string) => [{ type: "text" as const, text: value }];

function requireRun(session: Session): Run {
  const run = session.run;
  if (!run)
    throw new WorkflowError(
      "No compose-test request is active. The operator starts one with /compose-test.",
    );
  return run;
}

function respond(session: Session, result: StepResult) {
  const run = session.set(result.run);
  return {
    content: text(result.message),
    details: { status: run.status, workflow: run.workflow, phase: currentPhase(run)?.id ?? null },
  };
}

const target = Type.Object({
  file: Type.String({ description: "Path relative to the workspace root" }),
  method: Type.Optional(Type.String({ description: "Single test method to target" })),
});

export function registerTools(pi: ExtensionAPI, session: Session) {
  pi.registerTool({
    name: "compose_test_start",
    label: "Start compose-test workflow",
    description:
      "Start the compose-test workflow for the active /compose-test request. Targets are local test files under src/test for workflows that run tests, or any files for review, audit and coverage-gaps.",
    parameters: Type.Object({
      workflow: Type.Union(workflowIds.map((id) => Type.Literal(id))),
      targets: Type.Array(target, { minItems: 1 }),
      subject: Type.Optional(
        Type.Array(Type.String(), { description: "Production files under test" }),
      ),
      source: Type.Optional(
        Type.String({ description: "migrate only: the androidTest file to migrate" }),
      ),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
      const run = requireRun(session);
      const result = start(
        run,
        {
          workflow: params.workflow,
          targets: params.targets,
          ...(params.subject ? { subject: params.subject } : {}),
          ...(params.source ? { source: params.source } : {}),
        },
        ctx.cwd,
      );
      acquireLock(stateDir(ctx.cwd), ctx.sessionManager.getSessionId());
      const refs = referencePaths(params.workflow).join("\n");
      return respond(session, {
        ...result,
        message: `${result.message}\nRelevant references:\n${refs}`,
      });
    },
  });

  pi.registerTool({
    name: "compose_test_step",
    label: "Complete compose-test phase",
    description:
      "Complete the current compose-test phase. For explore phases pass a note. For test-running phases the extension runs Gradle and decides the outcome.",
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _update, ctx) {
      return session.exclusive(async () =>
        respond(session, await step(requireRun(session), params.note, session.deps(ctx, signal))),
      );
    },
  });

  pi.registerTool({
    name: "compose_test_mutate",
    label: "Negative control",
    description:
      "Negative control: temporarily replace `find` (exactly one match) with `replace` in a production file, run the targets, and restore the file. The tests must fail.",
    parameters: Type.Object({ file: Type.String(), find: Type.String(), replace: Type.String() }),
    async execute(_id, params, signal, _update, ctx) {
      return session.exclusive(async () =>
        respond(session, await mutate(requireRun(session), params, session.deps(ctx, signal))),
      );
    },
  });

  pi.registerTool({
    name: "compose_test_finding",
    label: "Record finding",
    description: "Record one review, audit or coverage-gap finding at a real file and line.",
    parameters: Type.Object({
      file: Type.String(),
      line: Type.Integer({ minimum: 1 }),
      rule: Type.String(),
      severity: Type.Union([Type.Literal("error"), Type.Literal("warning")]),
      message: Type.String(),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      return respond(session, addFinding(requireRun(session), params, ctx.cwd));
    },
  });

  pi.registerTool({
    name: "compose_test_block",
    label: "Report blocker",
    description:
      "End the workflow as BLOCKED. Allowed only when the two most recent extension test runs could not execute tests, for example a broken build or offline dependencies.",
    parameters: Type.Object({ reason: Type.String() }),
    async execute(_id, params) {
      return respond(session, block(requireRun(session), params.reason));
    },
  });
}
