import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { addFinding, block, mutate, start, step, WorkflowError } from "../src/engine.ts";
import { currentPhase, newRun, type Run } from "../src/state.ts";
import {
  behavior,
  deps,
  fakeGradle,
  MAIN_FILE,
  passingTest,
  read,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

const BREAK = { file: MAIN_FILE, find: '"Hello"', replace: '"BROKEN"' };

async function writeTestFlow(root: string, d = deps(root, fakeGradle(root, behavior).exec)) {
  let run: Run = start(
    newRun("goal", null),
    { workflow: "write-test", targets: [{ file: TEST_FILE }] },
    root,
  ).run;
  run = (await step(run, "Shows the greeting text to the user.", d)).run;
  return { run, d };
}

describe("write-test workflow", () => {
  it("verifies only after a passing run and a detected, restored mutation", async () => {
    const root = workspace({ test: null });
    const { run: writing, d } = await writeTestFlow(root);
    expect(currentPhase(writing)?.id).toBe("write");
    write(root, TEST_FILE, passingTest);
    const verified = await step(writing, undefined, d);
    expect(verified.message).toContain("run #1 (verify): passed");
    expect(currentPhase(verified.run)?.kind).toBe("mutation");
    const done = await mutate(verified.run, BREAK, d);
    expect(done.run.status).toBe("verified");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
    expect(done.run.mutations[0]).toMatchObject({ detected: true, restored: true });
  });

  it("rejects explore notes that say nothing and edits outside the phase scope", async () => {
    const root = workspace();
    const d = deps(root, fakeGradle(root, behavior).exec);
    const run = start(
      newRun("goal", null),
      { workflow: "write-test", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    await expect(step(run, "ok", d)).rejects.toThrow(/at least one sentence/);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hi"\n');
    await expect(step(run, "Shows the greeting text to the user.", d)).rejects.toThrow(
      /may not change files/,
    );
  });

  it("refuses to leave the edit phase with production changes or lint errors", async () => {
    const root = workspace();
    const { run, d } = await writeTestFlow(root);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hi"\n');
    await expect(step(run, undefined, d)).rejects.toThrow(/may not change: app\/src\/main/);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    write(root, TEST_FILE, passingTest.replace(".v2.createComposeRule", ".createComposeRule"));
    await expect(step(run, undefined, d)).rejects.toThrow(/v1-compose-test-api/);
  });

  it("returns to the edit phase when the tests miss the mutation", async () => {
    const root = workspace();
    const gradle = fakeGradle(root, () => "pass");
    const { run, d } = await writeTestFlow(root, deps(root, gradle.exec));
    const verified = await step(run, undefined, d);
    const missed = await mutate(verified.run, BREAK, d);
    expect(currentPhase(missed.run)?.id).toBe("write");
    expect(missed.message).toContain("did not detect");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
  });

  it("keeps the phase when a mutation does not compile and validates mutation targets", async () => {
    const root = workspace();
    const gradle = fakeGradle(root, (main) => (main.includes("BROKEN") ? "build-error" : "pass"));
    const { run, d } = await writeTestFlow(root, deps(root, gradle.exec));
    const verified = (await step(run, undefined, d)).run;
    const result = await mutate(verified, BREAK, d);
    expect(currentPhase(result.run)?.kind).toBe("mutation");
    expect(result.message).toContain("does not compile");
    await expect(mutate(verified, { ...BREAK, file: TEST_FILE }, d)).rejects.toThrow(
      /not production/,
    );
    await expect(mutate(verified, { ...BREAK, find: "nope" }, d)).rejects.toThrow(
      /matched 0 times/,
    );
    await expect(mutate(verified, { ...BREAK, replace: BREAK.find }, d)).rejects.toThrow(
      /must change/,
    );
  });

  it("goes back to edit when verification fails and gives up after the retry budget", async () => {
    const root = workspace();
    const gradle = fakeGradle(root, () => "fail");
    const { run, d } = await writeTestFlow(root, deps(root, gradle.exec, { maxBacktracks: 1 }));
    const first = await step(run, undefined, d);
    expect(currentPhase(first.run)?.id).toBe("write");
    expect(first.message).toContain("Returned to this phase because");
    const second = await step(first.run, undefined, d);
    expect(second.run.status).toBe("incomplete");
  });

  it("refuses verification when the tree changed after the last passing run", async () => {
    const root = workspace();
    const { run, d } = await writeTestFlow(root);
    const verified = (await step(run, undefined, d)).run;
    write(root, TEST_FILE, passingTest.replace("Hello", "Hello!"));
    const result = await mutate(verified, BREAK, d);
    expect(result.run.status).toBe("active");
    expect(currentPhase(result.run)?.id).toBe("write");
  });

  it("restores the mutated file when the test run throws", async () => {
    const root = workspace();
    let calls = 0;
    const exec = async () => {
      calls++;
      if (calls > 1) throw new Error("gradle crashed");
      return fakeGradle(root, behavior).exec("gradle", [], { cwd: root, timeoutMs: 1 });
    };
    const { run, d } = await writeTestFlow(root, deps(root, exec));
    const verified = (await step(run, undefined, d)).run;
    await expect(mutate(verified, BREAK, d)).rejects.toThrow("gradle crashed");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
    expect(existsSync(join(d.dir, "mutation.json"))).toBe(false);
  });
});

describe("start validation", () => {
  const root = workspace();
  const begin = (input: Parameters<typeof start>[1], forced: Parameters<typeof newRun>[1] = null) =>
    start(newRun("goal", forced), input, root);

  it("rejects targets that Robolectric cannot run", () => {
    expect(() => begin({ workflow: "write-test", targets: [] })).toThrow(/at least one/);
    expect(() => begin({ workflow: "write-test", targets: [{ file: MAIN_FILE }] })).toThrow(
      /src\/test/,
    );
    expect(() =>
      begin({ workflow: "write-test", targets: [{ file: "../x/src/test/A.kt" }] }),
    ).toThrow(/relative/);
    expect(() =>
      begin({ workflow: "write-test", targets: [{ file: "app/src/test/a.txt" }] }),
    ).toThrow(/\.kt or \.java/);
    expect(() =>
      begin({ workflow: "fix-failing", targets: [{ file: "app/src/test/java/a/Missing.kt" }] }),
    ).toThrow(/does not exist/);
    expect(() =>
      begin({ workflow: "write-test", targets: [{ file: TEST_FILE }], subject: [TEST_FILE] }),
    ).toThrow(/not a production/);
    expect(() =>
      begin({ workflow: "write-test", targets: [{ file: TEST_FILE }], subject: ["nope.kt"] }),
    ).toThrow(/does not exist/);
  });

  it("enforces the operator's workflow choice and the migrate source", () => {
    expect(() =>
      begin({ workflow: "audit", targets: [{ file: TEST_FILE }] }, "fix-failing"),
    ).toThrow(/operator selected/);
    expect(() => begin({ workflow: "migrate", targets: [{ file: TEST_FILE }] })).toThrow(
      /needs source/,
    );
    expect(() =>
      begin({ workflow: "migrate", targets: [{ file: TEST_FILE }], source: TEST_FILE }),
    ).toThrow(/androidTest/);
    expect(() =>
      begin({
        workflow: "migrate",
        targets: [{ file: TEST_FILE }],
        source: "app/src/androidTest/X.kt",
      }),
    ).toThrow(/does not exist/);
  });

  it("refuses a second start while a workflow is running", () => {
    const run = begin({ workflow: "audit", targets: [{ file: TEST_FILE }] }).run;
    expect(() => start(run, { workflow: "audit", targets: [{ file: TEST_FILE }] }, root)).toThrow(
      WorkflowError,
    );
  });
});

describe("fix-failing workflow", () => {
  it("requires the failure to reproduce, then the original tests to pass unweakened", async () => {
    const twoTests = passingTest.replace(
      "  @Test\n  fun showsGreeting",
      '  @Test\n  fun other() {\n    rule.onNodeWithText("Hi").assertExists()\n  }\n\n  @Test\n  fun showsGreeting',
    );
    const root = workspace({ test: twoTests });
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    const d = deps(root, fakeGradle(root, behavior).exec);
    let run = start(
      newRun("goal", null),
      { workflow: "fix-failing", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    run = (await step(run, undefined, d)).run;
    expect(currentPhase(run)?.id).toBe("explore");
    run = (await step(run, "greeting() returns the wrong text.", d)).run;
    write(
      root,
      TEST_FILE,
      twoTests.replace("  @Test\n  fun other", "  @org.junit.Ignore\n  @Test\n  fun other"),
    );
    await expect(step(run, undefined, d)).rejects.toThrow(/@Ignore/);
    write(root, TEST_FILE, passingTest);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    const done = await step(run, undefined, d);
    expect(done.run.status).toBe("active");
    expect(done.run.statusReason).toContain("Original tests missing");
  });

  it("blocks after two passing reproduction attempts", async () => {
    const root = workspace();
    const d = deps(root, fakeGradle(root, () => "pass").exec);
    let run = start(
      newRun("goal", null),
      { workflow: "fix-failing", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    run = (await step(run, undefined, d)).run;
    expect(run.status).toBe("active");
    run = (await step(run, undefined, d)).run;
    expect(run.status).toBe("blocked");
  });
});

describe("fix-flaky workflow", () => {
  it("records the probe and verifies only when every stress run passes", async () => {
    const root = workspace();
    let flaky = true;
    const d = deps(root, fakeGradle(root, () => (flaky ? "flaky" : "pass")).exec, {
      stressRuns: 3,
    });
    let run = start(
      newRun("goal", null),
      { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    const probe = await step(run, undefined, d);
    expect(probe.message).toMatch(/Flake probe: \d\/3 runs failed/);
    run = (await step(probe.run, "Real time sleep races the loader.", d)).run;
    const stillFlaky = await step(run, undefined, d);
    expect(currentPhase(stillFlaky.run)?.id).toBe("fix");
    flaky = false;
    const done = await step(stillFlaky.run, undefined, d);
    expect(done.run.status).toBe("verified");
  });
});

describe("performance workflow", () => {
  it("requires the minimum speedup measured by the extension", async () => {
    const root = workspace();
    const d = deps(root, fakeGradle(root, () => "pass").exec, { measureRuns: 1, maxBacktracks: 1 });
    let run = start(
      newRun("goal", null),
      { workflow: "performance", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    run = (await step(run, undefined, d)).run;
    expect(currentPhase(run)?.id).toBe("optimize");
    const slow = await step(run, undefined, d);
    expect(slow.message).toContain("Below the required");
    expect(currentPhase(slow.run)?.id).toBe("optimize");
  });

  it("blocks when the baseline does not pass", async () => {
    const root = workspace();
    const d = deps(root, fakeGradle(root, () => "fail").exec, { measureRuns: 1 });
    const run = start(
      newRun("goal", null),
      { workflow: "performance", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    expect((await step(run, undefined, d)).run.status).toBe("blocked");
  });
});

describe("findings workflows", () => {
  it("requires every target to be read, keeps the tree unchanged and adds lint findings", async () => {
    const root = workspace({
      test: passingTest.replace("assertIsDisplayed()", "toString()\n    Thread.sleep(10)"),
    });
    const d = deps(root, fakeGradle(root, behavior).exec);
    let run = start(
      newRun("goal", null),
      { workflow: "audit", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    await expect(step(run, undefined, d)).rejects.toThrow(/Not read yet/);
    run = addFinding(
      run,
      { file: TEST_FILE, line: 3, rule: "custom", severity: "warning", message: "m" },
      root,
    ).run;
    expect(() =>
      addFinding(
        run,
        { file: TEST_FILE, line: 999, rule: "r", severity: "error", message: "m" },
        root,
      ),
    ).toThrow(/out of range/);
    expect(() =>
      addFinding(
        run,
        { file: "nope.kt", line: 1, rule: "r", severity: "error", message: "m" },
        root,
      ),
    ).toThrow(/does not exist/);
    run = { ...run, reads: [TEST_FILE] };
    writeFileSync(join(root, "stray.txt"), "x");
    await expect(step(run, undefined, d)).rejects.toThrow(/read-only/);
    writeFileSync(join(root, "stray.txt"), "");
    const { rmSync } = await import("node:fs");
    rmSync(join(root, "stray.txt"));
    const done = await step(run, undefined, d);
    expect(done.run.status).toBe("verified");
    expect(done.run.findings.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["custom", "thread-sleep", "no-assertion"]),
    );
  });
});

describe("block", () => {
  it("is refused without evidence and accepted after two runs that executed nothing", async () => {
    const root = workspace();
    const { run, d } = await writeTestFlow(
      root,
      deps(root, fakeGradle(root, () => "build-error").exec),
    );
    expect(() => block(run, "offline")).toThrow(/needs evidence/);
    const first = await step(run, undefined, d);
    const second = await step(first.run, undefined, d);
    const blocked = block(second.run, "offline");
    expect(blocked.run.status).toBe("blocked");
    expect(blocked.run.statusReason).toMatch(/runs #1, #2/);
    expect(() => block(blocked.run, "again")).toThrow(/No active workflow/);
  });
});

describe("migrate workflow", () => {
  it("requires at least as many test cases as the instrumented source", async () => {
    const root = workspace();
    write(
      root,
      "app/src/androidTest/java/a/FooDeviceTest.kt",
      `${passingTest}\n@Test fun a() { assert(true) }\n@Test fun b() { assert(true) }\n`,
    );
    const d = deps(root, fakeGradle(root, behavior).exec);
    let run = start(
      newRun("goal", null),
      {
        workflow: "migrate",
        targets: [{ file: TEST_FILE }],
        source: "app/src/androidTest/java/a/FooDeviceTest.kt",
      },
      root,
    ).run;
    run = (await step(run, "Every case is pure Compose and runs on Robolectric.", d)).run;
    await expect(step(run, undefined, d)).rejects.toThrow(
      /source has 3 @Test cases but the targets have 1/,
    );
    expect(readFileSync(join(root, TEST_FILE), "utf8")).toContain("showsGreeting");
  });
});
