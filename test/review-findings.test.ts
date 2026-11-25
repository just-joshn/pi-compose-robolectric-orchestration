/**
 * Regression tests for the adversarial review findings (docs/review.md). Each test is named after
 * its finding id and asserts the behavior the intent requires.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { mutate, start, step } from "../src/engine.ts";
import { lintTestSource } from "../src/lint.ts";
import { resolveTarget } from "../src/project.ts";
import { type Exec, runTargets } from "../src/runner.ts";
import { STATE_ENTRY } from "../src/session.ts";
import { newRun, parseRun, type Run } from "../src/state.ts";
import { changedPaths, fingerprint } from "../src/tree.ts";
import { stateDir } from "../src/workspace.ts";
import {
  behavior,
  deps,
  fakeGradle,
  git,
  MAIN_FILE,
  passingTest,
  read,
  RESULT_XML,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";
import { harness } from "./pi-harness.ts";

const BREAK = { file: MAIN_FILE, find: '"Hello"', replace: '"BROKEN"' };

async function verifiedWriteTest(root: string, exec: Exec = fakeGradle(root, behavior).exec) {
  const d = deps(root, exec);
  let run: Run = start(
    newRun("goal", null),
    { workflow: "write-test", targets: [{ file: TEST_FILE }] },
    root,
  ).run;
  run = (await step(run, "Shows the greeting text to the user.", d)).run;
  write(root, TEST_FILE, passingTest);
  return { run, d };
}

beforeEach(() => {
  process.env["PI_COMPOSE_TEST_HOME"] = mkdtempSync(join(tmpdir(), "compose-test-home-"));
});

describe("gate integrity", () => {
  it("I1: edits after VERIFIED reopen the run at the next settle instead of keeping VERIFIED", async () => {
    const root = workspace({ test: null });
    const h = harness(root);
    await h.command("Add a test");
    await h.call("compose_test_start", { workflow: "write-test", targets: [{ file: TEST_FILE }] });
    await h.call("compose_test_step", { note: "Shows the greeting text to the user." });
    write(root, TEST_FILE, passingTest);
    await h.call("compose_test_step", {});
    const done = await h.call("compose_test_mutate", BREAK);
    expect(done.details["status"]).toBe("verified");
    write(root, TEST_FILE, passingTest.replace("assertIsDisplayed()", "assertExists()"));
    const settled = await h.settle();
    expect(settled?.["continue"]).toBe(true);
    await h.command("status");
    expect(h.notes.at(-1)).toContain("compose-test status: ACTIVE");
  });

  it("I2a: assume-unchanged production edits are still seen", async () => {
    const root = workspace({ test: null });
    const { run, d } = await verifiedWriteTest(root);
    git(root, "update-index", "--assume-unchanged", MAIN_FILE);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\nfun injected() = 42\n');
    await expect(step(run, undefined, d)).rejects.toThrow(/may not change: app\/src\/main/);
  });

  it("I2b: git-excluded production files are still seen", async () => {
    const root = workspace({ test: null });
    const { run, d } = await verifiedWriteTest(root);
    appendFileSync(join(root, ".git/info/exclude"), "app/src/main/java/a/Injected.kt\n");
    write(root, "app/src/main/java/a/Injected.kt", "package a\nfun injected() = 42\n");
    await expect(step(run, undefined, d)).rejects.toThrow(/Injected\.kt/);
  });

  it("I3: a write to the mutated file during the negative control is not clobbered", async () => {
    const root = workspace({ test: null });
    const gradle = fakeGradle(root, behavior);
    let calls = 0;
    const exec: Exec = async (command, args, options) => {
      const result = await gradle.exec(command, args, options);
      if (++calls === 2) write(root, MAIN_FILE, `${read(root, MAIN_FILE)}fun hotfix() = 1\n`);
      return result;
    };
    const { run, d } = await verifiedWriteTest(root, exec);
    const verified = (await step(run, undefined, d)).run;
    const done = await mutate(verified, BREAK, d);
    expect(read(root, MAIN_FILE)).toContain("hotfix");
    expect(done.run.status).toBe("incomplete");
  });

  it("I4: deleting a non-target test file is never verified", async () => {
    const root = workspace();
    write(
      root,
      "app/src/test/java/a/OtherTest.kt",
      passingTest.replace("class FooTest", "class OtherTest"),
    );
    git(root, "add", "-A");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "other");
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    const d = deps(root, fakeGradle(root, behavior).exec);
    let run = start(
      newRun("g", null),
      { workflow: "fix-failing", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    run = (await step(run, undefined, d)).run;
    run = (await step(run, "greeting() returns the wrong text.", d)).run;
    rmSync(join(root, "app/src/test/java/a/OtherTest.kt"));
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    await expect(step(run, undefined, d)).rejects.toThrow(/OtherTest/);
  });

  it("I5: a fix-failing run that guts the assertion instead of fixing the bug is never verified", async () => {
    const root = workspace();
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    const decide = (main: string, test: string) =>
      test.includes('onNodeWithText("Hello").assertIsDisplayed') && main.includes("BROKEN")
        ? "fail"
        : "pass";
    const d = deps(root, fakeGradle(root, decide).exec);
    let run = start(
      newRun("g", null),
      { workflow: "fix-failing", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    run = (await step(run, undefined, d)).run;
    run = (await step(run, "greeting() returns the wrong text.", d)).run;
    write(
      root,
      TEST_FILE,
      passingTest.replace(
        'rule.onNodeWithText("Hello").assertIsDisplayed()',
        'rule.onNodeWithText("Hello").assertExists()',
      ),
    );
    const result = await step(run, undefined, d);
    expect(result.run.status).not.toBe("verified");
  });

  it("I5b: a real production fix passes the regression check by failing on the original code", async () => {
    const root = workspace();
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "bug");
    const d = deps(root, fakeGradle(root, behavior).exec);
    let run = start(
      newRun("g", null),
      { workflow: "fix-failing", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    run = (await step(run, undefined, d)).run;
    run = (await step(run, "greeting() returns the wrong text.", d)).run;
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    const result = await step(run, undefined, d);
    expect(result.run.status).toBe("verified");
    expect(read(root, MAIN_FILE)).toContain('"Hello"');
  });
});

describe("runner and project", () => {
  it("R1/R2: the test class is the one with @Test, wherever its annotations sit", () => {
    const root = workspace();
    write(
      root,
      "app/src/test/java/a/FooTest.kt",
      "package a\n\nobject Fixtures { val x = 1 }\n\nclass FooTest {\n  @Test fun t() {}\n}\n",
    );
    expect(resolveTarget(root, { file: "app/src/test/java/a/FooTest.kt" }).className).toBe(
      "a.FooTest",
    );
    write(
      root,
      "app/src/test/java/a/Renamed.kt",
      "package a\n@Config(sdk = [33]) class ActualName {\n  @Test fun t() {}\n}\n",
    );
    expect(resolveTarget(root, { file: "app/src/test/java/a/Renamed.kt" }).className).toBe(
      "a.ActualName",
    );
  });

  it("R3: nested test class reports are read", async () => {
    const root = workspace();
    const exec: Exec = async () => {
      write(
        root,
        "app/build/test-results/testDebugUnitTest/TEST-a.FooTest$Inner.xml",
        '<testsuite><testcase name="t" classname="a.FooTest$Inner" time="0.1"><failure message="x" type="AssertionError"/></testcase></testsuite>',
      );
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await runTargets(exec, [resolveTarget(root, { file: TEST_FILE })], {
      gradle: "g",
      unitTestTask: "testDebugUnitTest",
      timeoutSeconds: 5,
    });
    expect(result.outcome).toBe("failed");
  });

  it("R5: a target that produced no test case is not hidden by another passing target", async () => {
    const root = workspace();
    const target = resolveTarget(root, { file: TEST_FILE });
    const result = await runTargets(
      fakeGradle(root, () => "pass").exec,
      [target, { ...target, method: "doesNotExist" }],
      {
        gradle: "g",
        unitTestTask: "testDebugUnitTest",
        timeoutSeconds: 5,
      },
    );
    expect(result.outcome).not.toBe("passed");
  });
});

describe("fingerprint", () => {
  it("T1: worktree renames are parsed into real paths", () => {
    const root = workspace();
    const base = fingerprint(root);
    git(root, "mv", MAIN_FILE, "app/src/main/java/a/Bar.kt");
    expect(changedPaths(root, base, fingerprint(root)).toSorted()).toEqual([
      "app/src/main/java/a/Bar.kt",
      MAIN_FILE,
    ]);
  });

  it("T2: committed renames report the deleted path too", () => {
    const root = workspace();
    const base = fingerprint(root);
    git(root, "mv", MAIN_FILE, "app/src/main/java/a/Bar.kt");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "mv");
    expect(changedPaths(root, base, fingerprint(root)).toSorted()).toEqual([
      "app/src/main/java/a/Bar.kt",
      MAIN_FILE,
    ]);
  });

  it("T3: symlinks are fingerprinted without git", () => {
    const root = workspace({ git: false });
    symlinkSync("Foo.kt", join(root, "app/src/main/java/a/Link.kt"));
    const before = fingerprint(root);
    rmSync(join(root, "app/src/main/java/a/Link.kt"));
    symlinkSync("Other.kt", join(root, "app/src/main/java/a/Link.kt"));
    expect(changedPaths(root, before, fingerprint(root))).toEqual(["app/src/main/java/a/Link.kt"]);
  });

  it("T4: a workspace inside a larger repository sees its own changes", () => {
    const outer = mkdtempSync(join(tmpdir(), "compose-test-outer-"));
    mkdirSync(join(outer, "android"));
    git(outer, "init", "-q");
    writeFileSync(join(outer, "android", "a.txt"), "1");
    git(outer, "add", "-A");
    git(outer, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "b");
    const cwd = join(outer, "android");
    const base = fingerprint(cwd);
    writeFileSync(join(cwd, "a.txt"), "2");
    expect(changedPaths(cwd, base, fingerprint(cwd))).toEqual(["a.txt"]);
  });
});

describe("pi integration", () => {
  it("F1: a broken config file cannot disable the settle gate", async () => {
    const root = workspace();
    write(root, ".pi/compose-test.json", '{"maxStall": 1}');
    const h = harness(root);
    h.ctx.isProjectTrusted = () => true;
    await h.command("audit Check FooTest");
    expect(await h.settle()).toMatchObject({ continue: true });
  });

  it("F2: repeating the same finding is not progress, so the stall bound holds", async () => {
    const root = workspace();
    const h = harness(root);
    await h.command("audit Check FooTest");
    await h.call("compose_test_start", { workflow: "audit", targets: [{ file: TEST_FILE }] });
    const finding = { file: TEST_FILE, line: 1, rule: "r", severity: "warning", message: "m" };
    for (let i = 0; i < 12; i++) {
      await h.call("compose_test_finding", finding).catch(() => undefined);
      await h.settle();
    }
    await h.command("status");
    expect(h.notes.at(-1)).toContain("INCOMPLETE");
  });

  it("F3: cancelling while a Gradle step runs is not undone when the step returns", async () => {
    const root = workspace({ test: null });
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = fakeGradle(root, behavior);
    const h = harness(root, async (c, a, o) => {
      await gate;
      return base.exec(c, a, o);
    });
    await h.command("Add a test");
    await h.call("compose_test_start", { workflow: "write-test", targets: [{ file: TEST_FILE }] });
    await h.call("compose_test_step", { note: "Shows the greeting text to the user." });
    write(root, TEST_FILE, passingTest);
    const running = h.call("compose_test_step", {});
    await new Promise((r) => setTimeout(r, 20));
    await h.command("cancel");
    expect(existsSync(join(stateDir(root), "lock.json"))).toBe(true);
    release();
    await running;
    await h.command("status");
    expect(h.notes.at(-1)).toContain("Cancelled by the operator");
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(stateDir(root), "lock.json"))).toBe(false);
  });

  it("F4: resuming a terminal run that was never reported posts the status once", async () => {
    const root = workspace();
    const h = harness(root);
    await h.command("audit Check FooTest");
    await h.call("compose_test_start", { workflow: "audit", targets: [{ file: TEST_FILE }] });
    await h.emit("tool_result", { toolName: "read", input: { path: TEST_FILE }, isError: false });
    await h.call("compose_test_step", {});
    await h.emit("session_start", { reason: "resume" });
    const out = await h.settle();
    expect(String((out?.["entries"] as { content: string }[] | undefined)?.[0]?.content)).toContain(
      "compose-test status: VERIFIED",
    );
    expect(await h.settle()).toBeUndefined();
  });

  it("F5: navigating to a branch without the run releases the lock", async () => {
    const root = workspace();
    const h = harness(root);
    await h.command("audit Check FooTest");
    await h.call("compose_test_start", { workflow: "audit", targets: [{ file: TEST_FILE }] });
    h.entries.length = 0;
    await h.emit("session_tree", {});
    expect(existsSync(join(stateDir(root), "lock.json"))).toBe(false);
  });

  it("F6: a corrupt mutation record does not prevent state restore", async () => {
    const root = workspace();
    const h = harness(root);
    await h.command("audit Check FooTest");
    writeFileSync(join(stateDir(root), "mutation.json"), "{not json");
    await h.emit("session_start", { reason: "resume" });
    await h.command("status");
    expect(h.notes.at(-1)).toContain("Goal: Check FooTest");
  });

  it("F7: edits outside the workspace are blocked during a run", async () => {
    const root = workspace();
    const h = harness(root);
    await h.command("Add a test");
    await h.call("compose_test_start", { workflow: "write-test", targets: [{ file: TEST_FILE }] });
    await h.call("compose_test_step", { note: "Shows the greeting text to the user." });
    expect(
      await h.emit("tool_call", {
        toolName: "write",
        input: { path: "../outside/src/test/Bad.kt" },
      }),
    ).toMatchObject({ block: true });
  });

  it("F8: a persisted run with an impossible phase index is rejected", () => {
    expect(
      parseRun({ ...newRun("g", null), status: "active", workflow: "write-test", phaseIndex: 99 }),
    ).toBeNull();
    expect(STATE_ENTRY).toBe("compose-test-state");
  });
});

describe("lint precision", () => {
  it("F9: comments, strings and helper assertions are not flagged", () => {
    const source = `package a
import androidx.compose.ui.test.junit4.v2.createComposeRule
@RunWith(RobolectricTestRunner::class)
class A {
  @get:Rule val rule = createComposeRule()

  private fun showsText(text: String) = rule.onNodeWithText(text).assertIsDisplayed()

  @Test
  fun showsGreeting() {
    rule.setContent { Greeting("Ada") }
    showsText("Hello, Ada")
  }

  // @Test
  // fun legacy() { rule.setContent { Greeting("Ada") } }

  /* Thread.sleep(1) */
  @Test
  fun reportsBadInput() {
    val message = "retry without Thread.sleep(100)"
    rule.onNodeWithText(message).assertIsDisplayed()
  }

  @Test(expected = IllegalStateException::class)
  fun rejectsNull() { render(null) }

  @Test
  fun sharedClock() = runTest(rule.mainClock.scheduler) { checkIsShown("x") }
}`;
    expect(lintTestSource("app/src/test/A.kt", source)).toEqual([]);
    expect(RESULT_XML).toContain("TEST-a.FooTest");
  });
});
