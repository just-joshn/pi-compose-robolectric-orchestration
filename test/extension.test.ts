import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { Exec } from "../src/gradle.ts";
import composeTest from "../src/index.ts";
import { newRun } from "../src/state.ts";
import { stateDir } from "../src/swap.ts";
import { STATE_ENTRY } from "../src/tools.ts";
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
interface ToolResult {
  content: { text: string }[];
  details: Record<string, unknown>;
}
interface Tool {
  execute: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: unknown,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

/** A minimal stand-in for Pi's ExtensionAPI that records what the extension does. */
function harness(root: string, exec: Exec = fakeGradle(root, behavior).exec) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  let command:
    | {
        handler: (args: string, ctx: unknown) => Promise<void>;
        getArgumentCompletions: (p: string) => unknown;
      }
    | undefined;
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: (_name: string, c: typeof command) => (command = c),
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string) => sent.push(text),
    exec: async (c: string, args: string[], o: { cwd: string; timeout: number }) => ({
      ...(await exec(c, args, { cwd: o.cwd, timeoutMs: o.timeout })),
      killed: false,
    }),
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { notify: (text: string) => notes.push(text) },
    waitForIdle: async () => undefined,
    isIdle: () => sent.length === 0,
    sessionManager: { getBranch: () => entries },
  };
  composeTest(pi as never);
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? [])
      result = (await handler({ type: name, ...event }, ctx)) ?? result;
    return result as
      | { block?: boolean; reason?: string; continue?: boolean; entries?: { content: string }[] }
      | undefined;
  };
  const call = (name: string, params: unknown = {}) =>
    tools.get(name)?.execute("id", params, undefined, undefined, ctx) ??
    Promise.reject(new Error(name));
  const run = (args: string) => command?.handler(args, ctx);
  const settle = () => emit("agent_before_settle", { entries: [] });
  const status = async () => {
    await run("status");
    return notes.at(-1) ?? "";
  };
  return {
    emit,
    call,
    run,
    settle,
    status,
    entries,
    sent,
    notes,
    complete: (p: string) => command?.getArgumentCompletions(p),
  };
}

beforeEach(() => {
  process.env["PI_COMPOSE_TEST_HOME"] = mkdtempSync(join(tmpdir(), "compose-test-home-"));
});

async function verifiedWriteTest(h: ReturnType<typeof harness>, root: string) {
  await h.run("Add a test for the greeting");
  await h.call("compose_test_start", {
    workflow: "write-test",
    targets: [{ file: TEST_FILE }],
    subject: [MAIN_FILE],
  });
  write(root, TEST_FILE, passingTest);
  await h.call("compose_test_step");
  return h.call("compose_test_mutate", { file: MAIN_FILE, find: '"Hello"', replace: '"BROKEN"' });
}

describe("extension", () => {
  it("drives a request from command to one authoritative VERIFIED status", async () => {
    const root = workspace({ test: null });
    const h = harness(root);
    await h.run("Add a test for the greeting");
    expect(h.sent[0]).toContain("- write-test:");
    expect(
      await h.emit("tool_call", { toolName: "write", input: { path: TEST_FILE } }),
    ).toMatchObject({ block: true });
    expect(await h.settle()).toMatchObject({ continue: true });
    await h.call("compose_test_start", { workflow: "write-test", targets: [{ file: TEST_FILE }] });
    expect(
      await h.emit("tool_call", { toolName: "edit", input: { path: MAIN_FILE } }),
    ).toMatchObject({ block: true });
    expect(
      await h.emit("tool_call", {
        toolName: "write",
        input: { path: "../outside/src/test/Bad.kt" },
      }),
    ).toMatchObject({ block: true });
    expect(
      await h.emit("tool_call", { toolName: "write", input: { path: TEST_FILE } }),
    ).toBeUndefined();
    expect(
      await h.emit("tool_call", { toolName: "bash", input: { command: "ls" } }),
    ).toBeUndefined();
    write(root, TEST_FILE, passingTest);
    expect((await h.call("compose_test_step")).details["phase"]).toBe("negative-control");
    const done = await h.call("compose_test_mutate", {
      file: MAIN_FILE,
      find: '"Hello"',
      replace: '"BROKEN"',
    });
    expect(done.details["status"]).toBe("verified");
    expect((await h.settle())?.entries?.[0]?.content).toContain("compose-test status: VERIFIED");
    expect(await h.settle()).toBeUndefined();
  });

  it("reopens a VERIFIED run when files change before its status is posted", async () => {
    const root = workspace({ test: null });
    const h = harness(root);
    await verifiedWriteTest(h, root);
    write(root, TEST_FILE, passingTest.replace("assertIsDisplayed()", "assertExists()"));
    expect(await h.settle()).toMatchObject({ continue: true });
    expect(await h.status()).toContain("status: ACTIVE");
  });

  it("ends a run that stops making progress, and does not count repeated findings as progress", async () => {
    const root = workspace();
    const h = harness(root);
    await h.run("review Check FooTest");
    expect(h.sent[0]).toContain("operator selected the review workflow");
    await h.call("compose_test_start", { workflow: "review", targets: [{ file: TEST_FILE }] });
    const finding = { file: TEST_FILE, line: 1, rule: "r", severity: "warning", message: "m" };
    for (let i = 0; i < 3; i++) {
      await h.call("compose_test_finding", finding);
      expect(await h.settle()).toMatchObject({ continue: true });
    }
    expect((await h.settle())?.entries?.[0]?.content).toContain("INCOMPLETE");
  });

  it("restores state from the branch, posts an unposted terminal status once, and survives a corrupt swap record", async () => {
    const root = workspace();
    const h = harness(root);
    await h.run("review Check FooTest");
    await h.call("compose_test_start", { workflow: "review", targets: [{ file: TEST_FILE }] });
    await h.emit("tool_result", { toolName: "read", input: { path: TEST_FILE }, isError: false });
    await h.emit("tool_result", { toolName: "read", input: { path: TEST_FILE }, isError: false });
    expect((await h.call("compose_test_step")).details["status"]).toBe("verified");
    writeFileSync(join(stateDir(root), "swap.json"), "{not json");
    await h.emit("session_start", { reason: "resume" });
    expect(h.notes.at(-1)).toContain("could not repair");
    expect((await h.settle())?.entries?.[0]?.content).toContain("status: VERIFIED");
    expect(await h.settle()).toBeUndefined();
    h.entries.push({
      type: "custom",
      customType: STATE_ENTRY,
      data: { ...newRun("x", null), status: "active", workflow: "write-test", phaseIndex: 99 },
    });
    await h.emit("session_tree", {});
    expect(await h.status()).toContain("status: VERIFIED");
  });

  it("keeps a cancel that happens while Gradle runs", async () => {
    const root = workspace({ test: null });
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => (release = r));
    const gradle = fakeGradle(root, behavior);
    const h = harness(root, async (c, a, o) => {
      await gate;
      return gradle.exec(c, a, o);
    });
    await h.run("Add a test");
    await h.call("compose_test_start", { workflow: "write-test", targets: [{ file: TEST_FILE }] });
    write(root, TEST_FILE, passingTest);
    const running = h.call("compose_test_step");
    await new Promise((r) => setTimeout(r, 20));
    await h.run("cancel");
    release();
    expect((await running).content[0]?.text).toContain("Discarded");
    expect(await h.status()).toContain("Cancelled by the operator");
  });

  it("handles status, cancel, empty goals, supersession, completions and missing runs", async () => {
    const h = harness(workspace());
    await expect(h.call("compose_test_step")).rejects.toThrow(/No compose-test request/);
    expect(await h.status()).toContain("No compose-test run");
    await h.run("cancel");
    expect(h.notes.at(-1)).toContain("No active");
    await h.run("review");
    expect(h.notes.at(-1)).toContain("Describe the goal");
    await h.run("first goal");
    await h.run("second goal");
    expect(await h.status()).toContain("Goal: second goal");
    expect(h.complete("fix")).toEqual([
      { value: "fix-failing", label: "fix-failing" },
      { value: "fix-flaky", label: "fix-flaky" },
    ]);
    expect(h.complete("zzz")).toBeNull();
  });
});
