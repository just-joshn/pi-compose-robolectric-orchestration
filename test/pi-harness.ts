import composeTest from "../src/index.ts";
import type { Exec } from "../src/runner.ts";
import { behavior, fakeGradle } from "./helpers.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
interface Tool {
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: unknown,
  ) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
}

/** A minimal stand-in for Pi's ExtensionAPI that records what the extension does. */
export function harness(
  root: string,
  exec: Exec = fakeGradle(root, behavior).exec,
  sessionId = "session-1",
) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const commands = new Map<
    string,
    {
      handler: (args: string, ctx: unknown) => Promise<void>;
      getArgumentCompletions: (p: string) => unknown;
    }
  >();
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: never) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string) => sent.push(text),
    exec: async (command: string, args: string[], options: { cwd: string; timeout: number }) => {
      const result = await exec(command, args, { cwd: options.cwd, timeoutMs: options.timeout });
      return { ...result, killed: false };
    },
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { notify: (text: string) => notes.push(text), setStatus: () => undefined },
    isProjectTrusted: () => false,
    waitForIdle: async () => undefined,
    sessionManager: { getBranch: () => entries, getSessionId: () => sessionId },
  };
  composeTest(pi as never);
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? [])
      result = (await handler({ type: name, ...event }, ctx)) ?? result;
    return result as Record<string, unknown> | undefined;
  };
  const call = (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute("id", params, undefined, undefined, ctx);
  };
  const command = (args: string) => commands.get("compose-test")?.handler(args, ctx);
  const settle = () => emit("agent_before_settle", { entries: [], continue: false });
  return { emit, call, command, settle, entries, sent, notes, commands, ctx };
}
