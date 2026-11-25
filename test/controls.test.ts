import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaults } from "../src/config.ts";
import { describeRun, nextStep } from "../src/core.ts";
import { mutate, start, step } from "../src/engine.ts";
import { finalize, recheck } from "../src/finalize.ts";
import { parseJUnitXml } from "../src/junit.ts";
import { backtrack, changes } from "../src/progress.ts";
import { kickoff } from "../src/prompts.ts";
import { currentPhase, finish, newRun, type Run } from "../src/state.ts";
import { changedPaths, fingerprint } from "../src/tree.ts";
import {
  behavior,
  deps,
  fakeGradle,
  git,
  MAIN_FILE,
  passingTest,
  read,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

const commit = (root: string, message: string) =>
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", message);

async function atRegression(root: string, decide: Parameters<typeof fakeGradle>[1]) {
  write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
  commit(root, "bug");
  const d = deps(root, fakeGradle(root, decide).exec);
  let run: Run = start(
    newRun("g", null),
    { workflow: "fix-failing", targets: [{ file: TEST_FILE }] },
    root,
  ).run;
  run = (await step(run, undefined, d)).run;
  run = (await step(run, "greeting() returns the wrong text.", d)).run;
  return { run, d };
}

describe("regression check", () => {
  it("sends the run back when the tests also pass on the original code", async () => {
    const root = workspace();
    let calls = 0;
    const { run, d } = await atRegression(root, (main) =>
      ++calls === 1 && main.includes("BROKEN") ? "fail" : "pass",
    );
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    const result = await step(run, undefined, d);
    expect(currentPhase(result.run)?.id).toBe("fix");
    expect(result.message).toContain("also pass on the original production code");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
  });

  it("asks for a negative control when the tests do not compile on the original code", async () => {
    const root = workspace();
    let calls = 0;
    const { run, d } = await atRegression(root, (main) => {
      calls++;
      if (calls === 1) return "fail";
      if (main.includes("Nope")) return "fail";
      return main.includes("BROKEN") ? "build-error" : "pass";
    });
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    const result = await step(run, undefined, d);
    expect(currentPhase(result.run)?.kind).toBe("regression");
    expect(result.message).toContain("do not compile against the original");
    const done = await mutate(
      result.run,
      { file: MAIN_FILE, find: '"Hello"', replace: '"Nope"' },
      d,
    );
    expect(done.run.status).toBe("verified");
  });

  it("asks for a negative control when only tests changed", async () => {
    const root = workspace();
    const { run, d } = await atRegression(root, (main, test) =>
      main.includes("BROKEN") && !test.includes("Hi") ? "fail" : "pass",
    );
    write(root, TEST_FILE, passingTest.replace('"Hello"', '"Hi"'));
    const result = await step(run, undefined, d);
    expect(result.message).toContain("No production code changed");
    expect(currentPhase(result.run)?.kind).toBe("regression");
  });

  it("rejects mutations outside the declared subject or outside a control phase", async () => {
    const root = workspace();
    write(root, "app/src/main/java/a/Other.kt", 'package a\nval x = "Hello"\n');
    const d = deps(root, fakeGradle(root, behavior).exec);
    let run = start(
      newRun("g", null),
      { workflow: "write-test", targets: [{ file: TEST_FILE }], subject: [MAIN_FILE] },
      root,
    ).run;
    await expect(
      mutate(run, { file: MAIN_FILE, find: '"Hello"', replace: '"X"' }, d),
    ).rejects.toThrow(/Not in a negative-control/);
    run = (await step(run, "Shows the greeting text to the user.", d)).run;
    run = (await step(run, undefined, d)).run;
    await expect(
      mutate(run, { file: "app/src/main/java/a/Other.kt", find: '"Hello"', replace: '"X"' }, d),
    ).rejects.toThrow(/subject files/);
  });
});

describe("recheck and finalize", () => {
  it("keeps a verified run whose tree is unchanged and ends findings workflows as incomplete", async () => {
    const root = workspace();
    const d = deps(root, fakeGradle(root, behavior).exec);
    let run = start(
      newRun("g", null),
      { workflow: "audit", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    run = (await step({ ...run, reads: [TEST_FILE] }, undefined, d)).run;
    expect(recheck(run, d)).toBe(run);
    writeFileSync(join(root, "stray.txt"), "x");
    const reopened = recheck(run, d);
    expect(reopened.status).toBe("incomplete");
    expect(reopened.statusReason).toContain("Files changed after verification");
    expect(recheck(reopened, d)).toBe(reopened);
  });

  it("reports a missing passing run and a missing control", () => {
    const root = workspace();
    const run = start(
      newRun("g", null),
      { workflow: "write-test", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    const ended = finalize(
      { ...run, phaseIndex: 4, backtracks: 9 },
      { cwd: root, config: defaults },
    );
    expect(ended.status).toBe("incomplete");
    expect(ended.statusReason).toContain("No passing run");
    expect(ended.statusReason).toContain("No negative control");
  });
});

describe("small contracts", () => {
  it("describes runs, next steps and terminal runs", () => {
    const run = finish(newRun("g", null), "blocked", "offline");
    expect(nextStep(run)).toBe("Workflow blocked: offline");
    const text = describeRun({
      id: 1,
      phase: "p",
      purpose: "verify",
      command: "c",
      exitCode: 1,
      outcome: "build-error",
      cases: [],
      seconds: 1,
      outputTail: "e: boom",
      tree: "t",
    });
    expect(text).toContain("e: boom");
    expect(kickoff("goal", null)).toContain("Pick the workflow");
    expect(kickoff("goal", "audit")).toContain("operator selected the audit workflow");
  });

  it("handles runs without a workflow or baseline", () => {
    const run = newRun("g", null);
    expect(changes(run, "/")).toEqual([]);
    expect(backtrack(run, "why", defaults).status).toBe("incomplete");
  });

  it("parses JUnit cases with missing attributes", () => {
    expect(parseJUnitXml('<testcase><failure/></testcase><testcase name="x"/>')).toEqual([
      { className: "", name: "", status: "failed", seconds: 0 },
      { className: "", name: "x", status: "passed", seconds: 0 },
    ]);
  });

  it("ignores build output and non-source ignored directories but sees ignored source directories", () => {
    const root = workspace();
    appendFileSync(join(root, ".gitignore"), "generated/\napp/src/main/gen/\nnotes/\n");
    const base = fingerprint(root);
    mkdirSync(join(root, "app/build"), { recursive: true });
    write(root, "app/build/out.kt", "x");
    write(root, "notes/todo.txt", "x");
    write(root, "app/src/main/gen/Gen.kt", "x");
    expect(changedPaths(root, base, fingerprint(root))).toEqual(["app/src/main/gen/Gen.kt"]);
    const outside = mkdtempSync(join(tmpdir(), "compose-test-nogit-"));
    expect(fingerprint(outside).head).toBeNull();
  });
});

describe("session", () => {
  it("restores the latest valid state on the branch, serializes work and passes signals through", async () => {
    const { Session, STATE_ENTRY } = await import("../src/session.ts");
    const { methodology } = await import("../src/prompts.ts");
    const appended: unknown[] = [];
    const pi = {
      appendEntry: (_type: string, data: unknown) => appended.push(data),
      exec: async () => ({ code: 0, stdout: "o", stderr: "e", killed: false }),
    };
    const session = new Session(pi as never);
    const good = newRun("good", null);
    const branch = [
      { type: "message" },
      { type: "custom", customType: STATE_ENTRY, data: good },
      { type: "custom", customType: STATE_ENTRY, data: { broken: true } },
      { type: "custom", customType: "other", data: newRun("other", null) },
    ];
    const root = workspace();
    const ctx = {
      cwd: root,
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => branch, getSessionId: () => "s" },
    };
    session.restore(ctx as never);
    expect(session.run?.goal).toBe("good");
    const order: number[] = [];
    const failing = session.exclusive(async () => {
      order.push(1);
      throw new Error("x");
    });
    const next = session.exclusive(async () => order.push(2));
    await expect(failing).rejects.toThrow("x");
    await next;
    expect(order).toEqual([1, 2]);
    const signal = new AbortController().signal;
    const d = session.deps(ctx as never, signal);
    expect(d.signal).toBe(signal);
    expect(await d.exec("g", [], { cwd: root, timeoutMs: 1, signal })).toEqual({
      code: 0,
      stdout: "o",
      stderr: "e",
    });
    expect(session.deps(ctx as never).signal).toBeUndefined();
    expect(methodology()).toContain("## Core rules");
    expect(methodology()).not.toContain("## References");
    session.set(good);
    expect(appended).toHaveLength(1);
  });

  it("describes failures that only carry a type", () => {
    const text = describeRun({
      id: 2,
      phase: "p",
      purpose: "verify",
      command: "c",
      exitCode: 1,
      outcome: "failed",
      cases: [{ className: "a.T", name: "t", status: "failed", seconds: 0, failureType: "NPE" }],
      seconds: 1,
      outputTail: "",
      tree: "t",
    });
    expect(text).toContain("a.T.t: NPE");
    expect(
      describeRun({
        id: 3,
        phase: "p",
        purpose: "verify",
        command: "c",
        exitCode: 1,
        outcome: "failed",
        cases: [{ className: "a.T", name: "t", status: "failed", seconds: 0 }],
        seconds: 1,
        outputTail: "",
        tree: "t",
      }),
    ).toContain("a.T.t: ");
  });
});
