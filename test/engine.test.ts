import { appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  addFinding,
  block,
  type Deps,
  mutate,
  start,
  type StartInput,
  step,
  WorkflowError,
} from "../src/engine.ts";
import type { Exec } from "../src/gradle.ts";
import { currentPhase, newRun, type Run } from "../src/state.ts";
import {
  begin,
  behavior,
  BREAK,
  commit,
  fakeGradle,
  git,
  MAIN_FILE,
  passingTest,
  read,
  TEST_FILE,
  twoTests,
  type Verdict,
  workspace,
  write,
} from "./helpers.ts";

describe("write-test verification and scope", () => {
  it("verifies only after a passing run and a detected, restored mutation", async () => {
    const root = workspace({ test: null });
    const { run, d } = begin(root);
    await expect(step(run, d)).rejects.toThrow(/do not exist yet/);
    write(root, TEST_FILE, passingTest);
    const verified = await step(run, d);
    expect(verified.message).toContain("run #1 (verify): passed");
    const done = await mutate(verified.run, BREAK, d);
    expect(done.run.status).toBe("verified");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
  });

  it("refuses production edits, lint errors and hidden production edits", async () => {
    const root = workspace();
    const { run, d } = begin(root);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hi"\n');
    await expect(step(run, d)).rejects.toThrow(/may not change: app\/src\/main/);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    write(root, TEST_FILE, passingTest.replace(".v2.createComposeRule", ".createComposeRule"));
    await expect(step(run, d)).rejects.toThrow(/v1-compose-test-api/);
    write(root, TEST_FILE, passingTest);
    git(root, "update-index", "--assume-unchanged", MAIN_FILE);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\nfun injected() = 1\n');
    await expect(step(run, d)).rejects.toThrow(/Foo\.kt/);
    git(root, "update-index", "--no-assume-unchanged", MAIN_FILE);
    git(root, "checkout", MAIN_FILE);
    appendFileSync(join(root, ".git/info/exclude"), "app/src/main/java/a/Injected.kt\n");
    write(root, "app/src/main/java/a/Injected.kt", "package a\n");
    await expect(step(run, d)).rejects.toThrow(/Injected\.kt/);
  });
});

describe("write-test negative control", () => {
  it("returns to editing when tests miss the mutation, and keeps the phase when it does not compile", async () => {
    const root = workspace();
    const missed = begin(root, {}, () => "pass");
    const verified = (await step(missed.run, missed.d)).run;
    const back = await mutate(verified, BREAK, missed.d);
    expect(currentPhase(back.run)?.id).toBe("write");
    const broken = begin(root, {}, (main) => (main.includes("BROKEN") ? "build-error" : "pass"));
    const v2 = (await step(broken.run, broken.d)).run;
    expect(currentPhase((await mutate(v2, BREAK, broken.d)).run)?.kind).toBe("mutation");
    await expect(mutate(v2, { ...BREAK, file: TEST_FILE }, broken.d)).rejects.toThrow(
      /not production/,
    );
    await expect(mutate(v2, { ...BREAK, find: "nope" }, broken.d)).rejects.toThrow(
      /matched 0 times/,
    );
    await expect(mutate(v2, { ...BREAK, replace: BREAK.find }, broken.d)).rejects.toThrow(
      /must change/,
    );
    await expect(mutate(missed.run, BREAK, missed.d)).rejects.toThrow(/Not in a negative-control/);
  });
});

async function stepTimes(run: Run, d: Deps, times: number): Promise<Run> {
  return times === 0 ? run : stepTimes((await step(run, d)).run, d, times - 1);
}

/** The original assertion fails on broken code; a weakened one passes. */
const strict = (main: string, test: string): Verdict =>
  test.includes('"Hello").assertIsDisplayed') && main.includes("BROKEN") ? "fail" : "pass";

describe("write-test retries and file safety", () => {
  it("gives up after three failed verifications", async () => {
    const root = workspace();
    const { run } = begin(root);
    const { d } = begin(root, {}, () => "fail");
    const retried = await stepTimes(run, d, 3);
    expect(currentPhase(retried)?.id).toBe("write");
    expect((await step(retried, d)).run.status).toBe("incomplete");
  });

  it("re-verifies when the tree changes after the passing run", async () => {
    const root = workspace();
    const { run, d } = begin(root);
    const verified = (await step(run, d)).run;
    write(root, TEST_FILE, passingTest.replace("Hello", "Hello!"));
    const result = await mutate(verified, BREAK, d);
    expect(currentPhase(result.run)?.id).toBe("write");
  });

  it("restores the mutated file when Gradle throws, and never clobbers a concurrent write", async () => {
    const root = workspace();
    const gradle = fakeGradle(root, behavior);
    let calls = 0;
    const throwing: Exec = async (c, a, o) => {
      if (++calls > 1) throw new Error("gradle crashed");
      return gradle.exec(c, a, o);
    };
    const first = begin(root);
    const d1 = { ...first.d, exec: throwing };
    const verified = (await step(first.run, d1)).run;
    await expect(mutate(verified, BREAK, d1)).rejects.toThrow("gradle crashed");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
    const writing: Exec = async (c, a, o) => {
      const result = await gradle.exec(c, a, o);
      write(root, MAIN_FILE, `${read(root, MAIN_FILE)}fun hotfix() = 1\n`);
      return result;
    };
    const done = await mutate(verified, BREAK, { ...first.d, exec: writing });
    expect(read(root, MAIN_FILE)).toContain("hotfix");
    expect(done.run.status).toBe("incomplete");
  });
});

describe("starting a workflow", () => {
  it("rejects targets and inputs the workflow cannot use", () => {
    const root = workspace();
    const s = (input: Partial<StartInput>, forced: "fix-failing" | null = null) =>
      start(
        newRun("goal", forced),
        { workflow: "write-test", targets: [{ file: TEST_FILE }], ...input },
        root,
      );
    expect(() => s({ targets: [] })).toThrow(/at least one/);
    expect(() => s({ targets: [{ file: MAIN_FILE }] })).toThrow(/under src\/test/);
    expect(() => s({ targets: [{ file: "../x/src/test/A.kt" }] })).toThrow(/outside the workspace/);
    expect(() =>
      s({ workflow: "fix-failing", targets: [{ file: "app/src/test/java/a/Missing.kt" }] }),
    ).toThrow(/does not exist/);
    expect(() => s({ subject: [TEST_FILE] })).toThrow(/production/);
    expect(() => s({ workflow: "review" }, "fix-failing")).toThrow(/operator selected/);
    expect(() => s({ workflow: "migrate" })).toThrow(/androidTest/);
    const run = s({ workflow: "review" }).run;
    expect(() => start(run, { workflow: "review", targets: [{ file: TEST_FILE }] }, root)).toThrow(
      WorkflowError,
    );
  });
});

async function atFix(
  root: string,
  decide: (main: string, test: string, call: number) => Verdict = behavior,
  method?: string,
) {
  write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
  commit(root, "bug");
  const target = method ? { file: TEST_FILE, method } : { file: TEST_FILE };
  const { run, d, gradle } = begin(root, { workflow: "fix-failing", targets: [target] }, decide);
  return { run: (await step(run, d)).run, d, gradle };
}

describe("fix-failing proves the fix", () => {
  it("reproduces one method, verifies the whole class, and proves the fix on the original code", async () => {
    const root = workspace({ test: twoTests("sibling") });
    const { run, d, gradle } = await atFix(root, behavior, "showsGreeting");
    expect(currentPhase(run)?.id).toBe("fix");
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    const done = await step(run, d);
    expect(gradle.calls[0]).toContain("a.FooTest.showsGreeting");
    expect(gradle.calls[1]).toContain("a.FooTest");
    expect(done.run.status).toBe("verified");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
  });

  it("never verifies a weakened assertion while the bug remains", async () => {
    const root = workspace();
    const { run, d } = await atFix(root, strict);
    write(
      root,
      TEST_FILE,
      passingTest.replace('"Hello").assertIsDisplayed()', '"Hello").assertExists()'),
    );
    const result = await step(run, d);
    expect(result.message).toContain("No production code changed");
    const back = await mutate(result.run, { file: MAIN_FILE, find: '"BROKEN"', replace: '"X"' }, d);
    expect(back.run.status).not.toBe("verified");
  });
});

describe("fix-failing regression check", () => {
  it("sends a fix back when the tests also pass on the original code, and accepts a mutation when they do not compile there", async () => {
    const root = workspace();
    const { run, d } = await atFix(root, (main, _t, call) =>
      call === 1 && main.includes("BROKEN") ? "fail" : "pass",
    );
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    expect((await step(run, d)).message).toContain("also pass on the original");
    const other = workspace();
    const c = await atFix(other, (main, _t, call) =>
      call === 1
        ? "fail"
        : main.includes("Nope")
          ? "fail"
          : main.includes("BROKEN")
            ? "build-error"
            : "pass",
    );
    write(other, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    const r = await step(c.run, c.d);
    expect(r.message).toContain("do not compile against the original");
    expect(
      (await mutate(r.run, { file: MAIN_FILE, find: '"Hello"', replace: '"Nope"' }, c.d)).run
        .status,
    ).toBe("verified");
  });
});

describe("fix-failing protects existing tests", () => {
  it("rejects deleted, lost or ignored tests", async () => {
    const root = workspace({ test: twoTests("other") });
    write(
      root,
      "app/src/test/java/a/OtherTest.kt",
      passingTest.replace("class FooTest", "class OtherTest"),
    );
    git(root, "add", "-A");
    const { run, d } = await atFix(root);
    write(
      root,
      TEST_FILE,
      twoTests("other").replace("  @Test\n  fun other", "  @Ignore\n  @Test\n  fun other"),
    );
    await expect(step(run, d)).rejects.toThrow(/gained @Ignore/);
    write(root, TEST_FILE, passingTest);
    await expect(step(run, d)).rejects.toThrow(/lost tests: other/);
    write(root, TEST_FILE, twoTests("other"));
    rmSync(join(root, "app/src/test/java/a/OtherTest.kt"));
    await expect(step(run, d)).rejects.toThrow(/OtherTest.kt was deleted/);
  });

  it("uses the uncommitted start content of a file for the regression check", async () => {
    const root = workspace();
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    const { run, d } = begin(root, { workflow: "fix-failing" });
    const fixing = (await step(run, d)).run;
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    expect((await step(fixing, d)).run.status).toBe("verified");
  });

  it("blocks when the failure does not reproduce twice", async () => {
    const root = workspace();
    const { run, d } = begin(root, { workflow: "fix-failing" }, () => "pass");
    const once = (await step(run, d)).run;
    expect(once.status).toBe("active");
    expect((await step(once, d)).run.status).toBe("blocked");
  });
});

describe("flaky, refactor and performance workflows", () => {
  it("fix-flaky requires five passing stress runs and a negative control", async () => {
    const root = workspace();
    let flaky = true;
    const { run, d } = begin(root, { workflow: "fix-flaky" }, (main) =>
      flaky ? "flaky" : behavior(main),
    );
    const fixing = (await step(run, d)).run;
    expect(currentPhase(fixing)?.id).toBe("fix");
    const still = await step(fixing, d);
    expect(currentPhase(still.run)?.id).toBe("fix");
    expect(still.run.statusReason).toMatch(/stress runs did not pass/);
    flaky = false;
    const stable = await step(still.run, d);
    expect(currentPhase(stable.run)?.kind).toBe("mutation");
    expect((await mutate(stable.run, BREAK, d)).run.status).toBe("verified");
  });

  it("refactor needs a passing baseline and may merge its own tests", async () => {
    const root = workspace({ test: twoTests("duplicate") });
    const { run, d } = begin(root, { workflow: "refactor" });
    const editing = (await step(run, d)).run;
    write(root, TEST_FILE, passingTest);
    const verified = (await step(editing, d)).run;
    expect((await mutate(verified, BREAK, d)).run.status).toBe("verified");
    const failing = begin(workspace(), { workflow: "refactor" }, () => "fail");
    const result = await step(failing.run, failing.d);
    expect(result.run.statusReason).toContain("passing baseline");
  });

  it("performance needs a measured speedup and a passing baseline", async () => {
    const root = workspace();
    const { run, d } = begin(root, { workflow: "performance" }, () => "pass");
    const optimizing = (await step(run, d)).run;
    expect(currentPhase(optimizing)?.id).toBe("optimize");
    expect((await step(optimizing, d)).message).toContain("Needs at least 5%");
    const failing = begin(workspace(), { workflow: "performance" }, () => "fail");
    expect((await step(failing.run, failing.d)).run.status).toBe("blocked");
  });
});

describe("review workflow", () => {
  it("review requires reading every target, stays read-only, and adds lint findings", async () => {
    const root = workspace({
      test: passingTest.replace("assertIsDisplayed()", "toString()\n    Thread.sleep(10)"),
    });
    const { run, d } = begin(root, { workflow: "review" });
    await expect(step(run, d)).rejects.toThrow(/Not read yet/);
    let read1: Run = addFinding(
      run,
      { file: TEST_FILE, line: 3, rule: "custom", severity: "warning", message: "m" },
      root,
    ).run;
    expect(
      addFinding(
        read1,
        { file: TEST_FILE, line: 3, rule: "custom", severity: "warning", message: "m" },
        root,
      ).message,
    ).toBe("Already recorded.");
    expect(() =>
      addFinding(
        read1,
        { file: TEST_FILE, line: 999, rule: "r", severity: "error", message: "m" },
        root,
      ),
    ).toThrow(/out of range/);
    read1 = { ...read1, reads: [TEST_FILE] };
    write(root, "stray.txt", "x");
    await expect(step(read1, d)).rejects.toThrow(/read-only/);
    rmSync(join(root, "stray.txt"));
    const done = await step(read1, d);
    expect(done.run.status).toBe("verified");
    expect(done.run.findings.map((f) => f.rule)).toEqual(
      expect.arrayContaining(["custom", "thread-sleep", "no-assertion"]),
    );
  });
});

describe("migrate and blocking", () => {
  it("migrate needs every source case and may delete the source", async () => {
    const root = workspace({ test: null });
    const source = "app/src/androidTest/java/a/FooDeviceTest.kt";
    write(root, source, twoTests("second"));
    git(root, "add", "-A");
    commit(root, "source");
    const { run, d } = begin(root, { workflow: "migrate", source });
    write(root, TEST_FILE, passingTest);
    await expect(step(run, d)).rejects.toThrow(/source has 2 @Test cases but the targets have 1/);
    write(root, TEST_FILE, twoTests("second"));
    rmSync(join(root, source));
    const verified = (await step(run, d)).run;
    expect((await mutate(verified, BREAK, d)).run.status).toBe("verified");
    expect(existsSync(join(root, source))).toBe(false);
  });

  it("block needs two runs that executed nothing", async () => {
    const root = workspace();
    const { run, d } = begin(root, {}, () => "build-error");
    expect(() => block(run, "offline")).toThrow(/needs evidence/);
    const twice = (await step((await step(run, d)).run, d)).run;
    const blocked = block(twice, "offline");
    expect(blocked.run.statusReason).toMatch(/runs #1, #2/);
    expect(() => block(blocked.run, "again")).toThrow(/No active workflow/);
  });
});
