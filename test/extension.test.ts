import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Exec } from "../src/gradle.ts";
import { isArrayOf, isRecord, isString } from "../src/guards.ts";
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

type Command = {
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions: (p: string) => unknown;
};

/** A minimal stand-in for Pi's ExtensionAPI that records what the extension registers and sends. */
function fakePi(root: string, exec: Exec) {
  const recorded = {
    handlers: new Map<string, Handler[]>(),
    tools: new Map<string, Tool>(),
    command: undefined as Command | undefined,
    entries: [] as { type: string; customType: string; data: unknown }[],
    sent: [] as string[],
    notes: [] as string[],
  };
  const pi = {
    on: (name: string, handler: Handler) =>
      recorded.handlers.set(name, [...(recorded.handlers.get(name) ?? []), handler]),
    registerTool: (tool: Tool & { name: string }) => recorded.tools.set(tool.name, tool),
    registerCommand: (_name: string, c: Command) => (recorded.command = c),
    appendEntry: (customType: string, data: unknown) =>
      recorded.entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string) => recorded.sent.push(text),
    exec: async (c: string, args: string[], o: { cwd: string; timeout: number }) => ({
      ...(await exec(c, args, { cwd: o.cwd, timeoutMs: o.timeout })),
      killed: false,
    }),
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: { notify: (text: string) => recorded.notes.push(text) },
    waitForIdle: async () => undefined,
    isIdle: () => recorded.sent.length === 0,
    sessionManager: { getBranch: () => recorded.entries },
  };
  return { pi, ctx, recorded };
}

type Outcome = { block?: boolean; continue?: boolean; entries?: { content: string }[] } | undefined;

function toOutcome(value: unknown): Outcome {
  if (!isRecord(value)) return undefined;
  const entries = isArrayOf(value["entries"], isRecord)
    ? value["entries"].map((e) => ({ content: isString(e["content"]) ? e["content"] : "" }))
    : undefined;
  return {
    ...(typeof value["block"] === "boolean" ? { block: value["block"] } : {}),
    ...(typeof value["continue"] === "boolean" ? { continue: value["continue"] } : {}),
    ...(entries ? { entries } : {}),
  };
}

/** The fake provides every ExtensionAPI member the extension calls. */
const isExtensionApi = (value: object): value is ExtensionAPI =>
  ["on", "registerTool", "registerCommand", "appendEntry", "sendUserMessage", "exec"].every(
    (name) => name in value,
  );

/** Run handlers in registration order, like Pi; the last defined result wins. */
async function runHandlers(
  handlers: readonly Handler[],
  event: Record<string, unknown>,
  ctx: unknown,
  last?: Outcome,
): Promise<Outcome> {
  const [first, ...rest] = handlers;
  if (!first) return last;
  const outcome = toOutcome(await first(event, ctx)) ?? last;
  return runHandlers(rest, event, ctx, outcome);
}

function harness(root: string, exec: Exec = fakeGradle(root, behavior).exec) {
  const { pi, ctx, recorded } = fakePi(root, exec);
  if (!isExtensionApi(pi)) throw new Error("fake Pi is missing an ExtensionAPI member");
  composeTest(pi);
  const emit = (name: string, event: Record<string, unknown> = {}) =>
    runHandlers(recorded.handlers.get(name) ?? [], { type: name, ...event }, ctx);
  const call = (name: string, params: unknown = {}) =>
    recorded.tools.get(name)?.execute("id", params, undefined, undefined, ctx) ??
    Promise.reject(new Error(name));
  const run = (args: string) => recorded.command?.handler(args, ctx);
  const status = async () => {
    await run("status");
    return recorded.notes.at(-1) ?? "";
  };
  const settle = () => emit("agent_before_settle", { entries: [] });
  const complete = (p: string) => recorded.command?.getArgumentCompletions(p);
  return { emit, call, run, settle, status, complete, ...recorded };
}

beforeEach(() => {
  vi.stubEnv("PI_COMPOSE_TEST_HOME", mkdtempSync(join(tmpdir(), "compose-test-home-")));
});

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("a request from command to status", () => {
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
});

describe("an agent that stops or is cancelled", () => {
  it("ends a run that stops making progress, and does not count repeated findings as progress", async () => {
    const root = workspace();
    const h = harness(root);
    await h.run("review Check FooTest");
    expect(h.sent[0]).toContain("operator selected the review workflow");
    await h.call("compose_test_start", { workflow: "review", targets: [{ file: TEST_FILE }] });
    const finding = { file: TEST_FILE, line: 1, rule: "r", severity: "warning", message: "m" };
    const findAndSettle = async () => {
      await h.call("compose_test_finding", finding);
      return h.settle();
    };
    expect(await findAndSettle()).toMatchObject({ continue: true });
    expect(await findAndSettle()).toMatchObject({ continue: true });
    expect(await findAndSettle()).toMatchObject({ continue: true });
    expect((await h.settle())?.entries?.[0]?.content).toContain("INCOMPLETE");
  });

  it("keeps a cancel that happens while Gradle runs", async () => {
    const root = workspace({ test: null });
    const gradle = fakeGradle(root, behavior);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const h = harness(root, async (c, a, o) => {
      started.resolve();
      await gate.promise;
      return gradle.exec(c, a, o);
    });
    await h.run("Add a test");
    await h.call("compose_test_start", { workflow: "write-test", targets: [{ file: TEST_FILE }] });
    write(root, TEST_FILE, passingTest);
    const running = h.call("compose_test_step");
    await started.promise;
    await h.run("cancel");
    gate.resolve();
    expect((await running).content[0]?.text).toContain("Discarded");
    expect(await h.status()).toContain("Cancelled by the operator");
  });
});

describe("session lifecycle and commands", () => {
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
