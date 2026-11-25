import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import composeTest from "../src/index.ts";
import { STATE_ENTRY } from "../src/session.ts";
import {
  behavior,
  fakeGradle,
  MAIN_FILE,
  passingTest,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

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
function harness(root: string, exec = fakeGradle(root, behavior).exec) {
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
    sessionManager: { getBranch: () => entries, getSessionId: () => "session-1" },
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
  return { emit, call, command, settle, entries, sent, notes, commands };
}

beforeEach(() => {
  process.env["PI_COMPOSE_TEST_HOME"] = mkdtempSync(join(tmpdir(), "compose-test-home-"));
});

describe("extension", () => {
  it("drives a write-test request from command to an authoritative VERIFIED report", async () => {
    const root = workspace({ test: null });
    const h = harness(root);
    await h.command("Add a test for the greeting");
    expect(h.sent[0]).toContain("compose-test request: Add a test for the greeting");
    expect(h.sent[0]).toContain("- write-test:");

    const blocked = await h.emit("tool_call", { toolName: "write", input: { path: TEST_FILE } });
    expect(blocked).toMatchObject({ block: true });
    expect(String(blocked?.["reason"])).toContain("compose_test_start");

    const nudge = await h.settle();
    expect(nudge).toMatchObject({ continue: true });

    await h.call("compose_test_start", {
      workflow: "write-test",
      targets: [{ file: TEST_FILE }],
      subject: [MAIN_FILE],
    });
    await h.call("compose_test_step", { note: "Shows the greeting text to the user." });
    expect(
      await h.emit("tool_call", { toolName: "edit", input: { path: MAIN_FILE } }),
    ).toMatchObject({ block: true });
    expect(
      await h.emit("tool_call", { toolName: "write", input: { path: TEST_FILE } }),
    ).toBeUndefined();
    expect(
      await h.emit("tool_call", { toolName: "bash", input: { command: "ls" } }),
    ).toBeUndefined();
    write(root, TEST_FILE, passingTest);
    const verified = await h.call("compose_test_step", {});
    expect(verified.details["phase"]).toBe("negative-control");
    const done = await h.call("compose_test_mutate", {
      file: MAIN_FILE,
      find: '"Hello"',
      replace: '"BROKEN"',
    });
    expect(done.details["status"]).toBe("verified");

    const final = await h.settle();
    const posted = (final?.["entries"] as { content: string }[])[0]?.content ?? "";
    expect(posted).toContain("compose-test status: VERIFIED");
    expect(final?.["continue"]).toBeUndefined();
    expect(await h.settle()).toBeUndefined();
    expect(
      await h.emit("tool_call", { toolName: "write", input: { path: MAIN_FILE } }),
    ).toBeUndefined();
  });

  it("ends a run that stops making progress as INCOMPLETE", async () => {
    const root = workspace();
    const h = harness(root);
    await h.command("audit Check FooTest");
    expect(h.sent[0]).toContain("operator selected the audit workflow");
    expect(await h.settle()).toMatchObject({ continue: true });
    expect(await h.settle()).toMatchObject({ continue: true });
    expect(await h.settle()).toMatchObject({ continue: true });
    const last = await h.settle();
    expect(last?.["continue"]).toBeUndefined();
    expect((last?.["entries"] as { content: string }[])[0]?.content).toContain("INCOMPLETE");
  });

  it("records reads for findings workflows and restores state from the session branch", async () => {
    const root = workspace();
    const h = harness(root);
    await h.command("audit Check FooTest");
    await h.call("compose_test_start", { workflow: "audit", targets: [{ file: TEST_FILE }] });
    await h.emit("tool_result", { toolName: "read", input: { path: TEST_FILE }, isError: false });
    await h.emit("tool_result", { toolName: "read", input: { path: TEST_FILE }, isError: false });
    await h.emit("tool_result", { toolName: "grep", input: { path: TEST_FILE }, isError: false });
    await h.emit("session_start", { reason: "resume" });
    await h.call("compose_test_finding", {
      file: TEST_FILE,
      line: 1,
      rule: "r",
      severity: "warning",
      message: "m",
    });
    const done = await h.call("compose_test_step", {});
    expect(done.details["status"]).toBe("verified");
    expect(h.entries.filter((e) => e.customType === STATE_ENTRY).length).toBeGreaterThan(3);
  });

  it("handles status, cancel, empty goals, supersession, completions and missing runs", async () => {
    const root = workspace();
    const h = harness(root);
    await expect(h.call("compose_test_step", {})).rejects.toThrow(/No compose-test request/);
    await h.command("");
    expect(h.notes.at(-1)).toContain("No compose-test run");
    await h.command("cancel");
    expect(h.notes.at(-1)).toContain("No active");
    await h.command("audit");
    expect(h.notes.at(-1)).toContain("Describe the goal");
    await h.command("first goal");
    await h.command("second goal");
    await h.command("status");
    expect(h.notes.at(-1)).toContain("Goal: second goal");
    await h.command("cancel");
    expect(h.notes.at(-1)).toContain("Cancelled by the operator");
    const completions = h.commands.get("compose-test")?.getArgumentCompletions("fix");
    expect(completions).toEqual([
      { value: "fix-failing", label: "fix-failing" },
      { value: "fix-flaky", label: "fix-flaky" },
    ]);
    expect(h.commands.get("compose-test")?.getArgumentCompletions("zzz")).toBeNull();
    await h
      .call("compose_test_block", { reason: "x" })
      .catch((error: Error) => expect(error.message).toMatch(/No active workflow/));
    await h.emit("session_shutdown", {});
  });
});
