import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { start } from "../src/engine.ts";
import { className, type Exec, gradleConfig, parseJUnitXml, runTargets } from "../src/gradle.ts";
import { lintTestSource } from "../src/lint.ts";
import { categorize } from "../src/paths.ts";
import { addRun, finish, isRun, newRun, report } from "../src/state.ts";
import { recoverSwap, stateDir, withSwappedFiles } from "../src/swap.ts";
import { changedPaths, digest, fingerprint } from "../src/tree.ts";
import { kickoff, methodology, workflowIds, workflows } from "../src/workflows.ts";
import {
  commit,
  fakeGradle,
  git,
  MAIN_FILE,
  passingTest,
  RESULT_XML,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

describe("path categories", () => {
  it.each([
    ["app/src/test/java/A.kt", "test"],
    ["app/src/androidTest/java/A.kt", "test"],
    ["src/test/resources/robolectric.properties", "test"],
    ["app/src/main/java/A.kt", "production"],
    ["app/build.gradle.kts", "build"],
    ["gradle/libs.versions.toml", "build"],
    ["README.md", "other"],
  ])("%s is %s", (path, category) => expect(categorize(path)).toBe(category));
});

const rules = (source: string) =>
  lintTestSource("app/src/test/A.kt", source)
    .map((f) => f.rule)
    .toSorted();

describe("lint rules", () => {
  it("passes a clean v2 test and idiomatic helpers, comments and strings", () => {
    expect(rules(passingTest)).toEqual([]);
    expect(
      rules(`@RunWith(X::class)
class A {
  @get:Rule val rule = createComposeRule()
  private fun showsText(t: String) = rule.onNodeWithText(t).assertIsDisplayed()
  @Test
  fun viaHelper() { showsText("x") }
  // @Test
  // fun legacy() { }
  /* Thread.sleep(1) */
  @Test fun inString() { val m = "no Thread.sleep(100)"; rule.onNodeWithText(m).assertExists() }
  @Test(expected = IllegalStateException::class)
  fun throws() { render(null) }
  @Test fun shared() = runTest(rule.mainClock.scheduler) { checkShown("x") }
}`),
    ).toEqual([]);
  });

  it("flags v1 APIs, sleeps, missing assertions, runners, ignores, two clocks and framework mocks", () => {
    expect(
      rules(`import androidx.compose.ui.test.junit4.createComposeRule
class A {
  @get:Rule val rule = createComposeRule()
  @Test fun crashesOnly() { rule.setContent { }; Thread.sleep(5) }
  @Ignore
  @Test fun t() = runTest { assertTrue(true) }
  val c = mock<Context>()
}`),
    ).toEqual([
      "ignored-test",
      "missing-runner",
      "mock-android-framework",
      "no-assertion",
      "run-test-with-compose-rule",
      "thread-sleep",
      "v1-compose-test-api",
    ]);
  });
});

const fooTarget = { file: TEST_FILE };

describe("reading Gradle results", () => {
  it("parses JUnit XML", () => {
    expect(
      parseJUnitXml(`<testcase name="a" classname="p.T" time="1.5"/>
        <testcase name="b" classname="p.T"><failure message="x &lt; &quot;y&quot; &amp; z" type="E">t</failure></testcase>
        <testcase name="c"><error type="NPE"/></testcase><testcase name="d"><skipped/></testcase>`),
    ).toEqual([
      { className: "p.T", name: "a", status: "passed", seconds: 1.5 },
      { className: "p.T", name: "b", status: "failed", seconds: 0, message: 'x < "y" & z' },
      { className: "", name: "c", status: "failed", seconds: 0, message: "NPE" },
      { className: "", name: "d", status: "skipped", seconds: 0 },
    ]);
  });

  it("finds the @Test class past helpers and one-line annotations", () => {
    expect(
      className("package a\nobject Fixtures\nclass FooTest {\n  @Test fun t() {}\n}", "x.kt"),
    ).toBe("a.FooTest");
    expect(
      className(
        "package a\n@Config(sdk = [33]) class Actual {\n  @Test fun t() {}\n}",
        "Renamed.kt",
      ),
    ).toBe("a.Actual");
    expect(className("// nothing", "x/FooTest.kt")).toBe("FooTest");
  });
});

describe("running Gradle per module", () => {
  it("runs one --rerun invocation per module, prefers the wrapper, and reads nested reports", async () => {
    const root = workspace();
    write(root, "lib/src/test/java/b/BarTest.kt", "package b\nclass BarTest");
    const gradle = fakeGradle(root, () => "pass");
    const result = await runTargets(gradle.exec, root, [
      { file: TEST_FILE, method: "showsGreeting" },
      { file: "lib/src/test/java/b/BarTest.kt" },
    ]);
    expect(gradle.calls[0]).toEqual([
      "--console=plain",
      ":app:testDebugUnitTest",
      "--rerun",
      "--tests",
      "a.FooTest.showsGreeting",
    ]);
    expect(gradle.calls[1]).toContain(":lib:testDebugUnitTest");
    expect(result.outcome).toBe("no-tests");
    const nested = await runTargets(
      async () => {
        write(
          root,
          "app/build/test-results/testDebugUnitTest/TEST-a.FooTest$Inner.xml",
          '<testcase name="t" classname="a.FooTest$Inner"><failure message="x"/></testcase>',
        );
        return { code: 1, stdout: "", stderr: "" };
      },
      root,
      [fooTarget],
    );
    expect(nested.outcome).toBe("failed");
  });
});

describe("classifying Gradle outcomes", () => {
  it("classifies failures, build errors, empty runs and phantom targets", async () => {
    const root = workspace();
    expect((await runTargets(fakeGradle(root, () => "fail").exec, root, [fooTarget])).outcome).toBe(
      "failed",
    );
    const broken = await runTargets(fakeGradle(root, () => "build-error").exec, root, [fooTarget]);
    expect(broken.outcome).toBe("build-error");
    expect(broken.outputTail).toContain("e: Unresolved reference");
    expect(
      (await runTargets(async () => ({ code: 0, stdout: "", stderr: "" }), root, [fooTarget]))
        .outcome,
    ).toBe("no-tests");
    expect(
      (
        await runTargets(fakeGradle(root, () => "pass").exec, root, [
          fooTarget,
          { file: TEST_FILE, method: "missing" },
        ])
      ).outcome,
    ).toBe("no-tests");
    await expect(
      runTargets(fakeGradle(root, () => "pass").exec, root, [{ file: "nope.kt" }]),
    ).rejects.toThrow(/does not exist/);
    expect(
      gradleConfig({
        COMPOSE_TEST_GRADLE: "/g",
        COMPOSE_TEST_TASK: "t",
        COMPOSE_TEST_TIMEOUT: "2",
      }),
    ).toEqual({ gradle: "/g", task: "t", timeoutMs: 2000 });
  });
});

describe("fingerprints under git", () => {
  it("sees dirty, untracked, renamed, committed and ignored source files", () => {
    const root = workspace();
    const base = fingerprint(root);
    write(root, "new.txt", "x");
    write(root, MAIN_FILE, "changed");
    expect(changedPaths(root, base, fingerprint(root))).toEqual([MAIN_FILE, "new.txt"]);
    rmSync(join(root, "new.txt"));
    git(root, "checkout", MAIN_FILE);
    git(root, "mv", MAIN_FILE, "app/src/main/java/a/Bar.kt");
    expect(changedPaths(root, base, fingerprint(root))).toEqual([
      "app/src/main/java/a/Bar.kt",
      MAIN_FILE,
    ]);
    commit(root, "mv");
    const moved = fingerprint(root);
    expect(changedPaths(root, base, moved)).toEqual(["app/src/main/java/a/Bar.kt", MAIN_FILE]);
    expect(digest(fingerprint(root))).toBe(digest(moved));
    appendFileSync(join(root, ".gitignore"), "gen/\nnotes/\n");
    commit(root, "ignore");
    const ignoredBase = fingerprint(root);
    write(root, "app/build/out.kt", "x");
    write(root, "notes/todo.txt", "x");
    write(root, "app/src/main/gen/Gen.kt", "x");
    expect(changedPaths(root, ignoredBase, fingerprint(root))).toEqual(["app/src/main/gen/Gen.kt"]);
  });
});

describe("fingerprints outside the repository root or git", () => {
  it("works in a subdirectory of a repository and without git, including symlinks", () => {
    const outer = mkdtempSync(join(tmpdir(), "compose-test-outer-"));
    mkdirSync(join(outer, "android"));
    writeFileSync(join(outer, "android", "a.txt"), "1");
    git(outer, "init", "-q");
    git(outer, "add", "-A");
    commit(outer, "b");
    const base = fingerprint(join(outer, "android"));
    writeFileSync(join(outer, "android", "a.txt"), "2");
    expect(changedPaths(join(outer, "android"), base, fingerprint(join(outer, "android")))).toEqual(
      ["a.txt"],
    );
    const plain = workspace({ git: false });
    symlinkSync("Foo.kt", join(plain, "app/src/main/java/a/Link.kt"));
    const before = fingerprint(plain);
    expect(before.head).toBeNull();
    rmSync(join(plain, "app/src/main/java/a/Link.kt"));
    symlinkSync("Other.kt", join(plain, "app/src/main/java/a/Link.kt"));
    expect(changedPaths(plain, before, fingerprint(plain))).toEqual([
      "app/src/main/java/a/Link.kt",
    ]);
  });
});

describe("temporary file swaps", () => {
  it("restores files, keeps files someone else changed, and repairs crashes once", async () => {
    const env = { PI_COMPOSE_TEST_HOME: mkdtempSync(join(tmpdir(), "compose-test-home-")) };
    const dir = stateDir("/w", env);
    const root = mkdtempSync(join(tmpdir(), "compose-test-swap-"));
    const a = join(root, "A.kt");
    const b = join(root, "B.kt");
    writeFileSync(a, "original");
    const { conflicts } = await withSwappedFiles(
      dir,
      [
        { path: a, content: Buffer.from("mutated") },
        { path: b, content: Buffer.from("new") },
      ],
      async () => {
        writeFileSync(b, "edited meanwhile");
      },
    );
    expect([readFileSync(a, "utf8"), readFileSync(b, "utf8"), conflicts]).toEqual([
      "original",
      "edited meanwhile",
      [b],
    ]);
    await expect(
      withSwappedFiles(dir, [{ path: a, content: null }], async () =>
        Promise.reject(new Error("boom")),
      ),
    ).rejects.toThrow("boom");
    expect(readFileSync(a, "utf8")).toBe("original");
    writeFileSync(a, "mutated");
    const record = JSON.stringify([
      {
        path: a,
        original: Buffer.from("original").toString("base64"),
        written: createHash("sha256").update("mutated").digest("hex"),
      },
    ]);
    writeFileSync(join(dir, "swap.json"), record);
    expect(recoverSwap(dir)).toEqual({ restored: [a], conflicts: [] });
    expect(recoverSwap(dir)).toEqual({ restored: [], conflicts: [] });
    writeFileSync(join(dir, "swap.json"), record);
    writeFileSync(a, "operator edit");
    expect(recoverSwap(dir).conflicts[0]).toContain(a);
  });
});

describe("persisted state", () => {
  it("accepts only well-formed persisted runs", () => {
    const run = newRun("g", null);
    expect(isRun(run)).toBe(true);
    expect(isRun(null)).toBe(false);
    expect(isRun({ ...run, version: 1 })).toBe(false);
    expect(isRun({ ...run, workflow: "nope" })).toBe(false);
    expect(isRun({ ...run, status: "active", workflow: "write-test", phaseIndex: 99 })).toBe(false);
    expect(isRun({ ...run, status: "active" })).toBe(false);
  });
});

const failedRun = {
  phase: "verify",
  purpose: "verify",
  command: "gradlew test",
  exitCode: 1,
  outcome: "failed",
  cases: [{ className: "a.T", name: "m", status: "failed", seconds: 1, message: "boom\nmore" }],
  seconds: 3,
  outputTail: "",
  tree: "t",
} as const;

describe("status report", () => {
  it("reports only recorded evidence", () => {
    const base = {
      ...newRun("Add tests", null),
      workflow: "write-test" as const,
      targets: [{ file: TEST_FILE, method: "m" }],
    };
    const [withRun] = addRun(base, failedRun);
    const mutation = {
      file: MAIN_FILE,
      find: "a",
      replace: "b",
      runId: 1,
      tree: "t",
      detected: false,
    };
    const finding = {
      file: TEST_FILE,
      line: 1,
      rule: "r",
      severity: "error",
      message: "m",
      source: "agent",
    } as const;
    const text = report(
      finish({ ...withRun, mutations: [mutation], findings: [finding] }, "incomplete", "why"),
    );
    for (const part of [
      "status: INCOMPLETE",
      `${TEST_FILE}#m`,
      "first failure m: boom",
      "NOT detected",
      "[error] r (agent)",
    ])
      expect(text).toContain(part);
    expect(report(newRun("g", null))).toContain("(none started)");
  });
});

describe("kickoff prompt", () => {
  it("builds the kickoff from the skill and the routing table", () => {
    expect(workflowIds.every((id) => workflows[id].phases.length > 0)).toBe(true);
    expect(methodology()).toContain("## Core rules");
    expect(methodology()).not.toContain("## References");
    expect(kickoff("goal", null)).toContain("- review:");
    expect(kickoff("goal", "review")).toContain("operator selected the review workflow");
  });
});

describe("untrusted input at the boundaries", () => {
  it("rejects a timeout that is not a positive number and defaults empty overrides", () => {
    for (const bad of ["abc", "0", "-5", "Infinity"])
      expect(() => gradleConfig({ COMPOSE_TEST_TIMEOUT: bad })).toThrow(/COMPOSE_TEST_TIMEOUT/);
    expect(gradleConfig({ COMPOSE_TEST_GRADLE: "", COMPOSE_TEST_TASK: "" })).toEqual({
      gradle: "gradle",
      task: "testDebugUnitTest",
      timeoutMs: 1_200_000,
    });
  });

  it("rejects persisted runs with wrong field types", () => {
    const run = newRun("g", null);
    for (const patch of [
      { goal: 1 },
      { runs: {} },
      { targets: [{ file: 2 }] },
      { nudges: "1" },
      { reads: [1] },
      { source: 3 },
      { forcedWorkflow: "nope" },
      { status: "done" },
      { phaseIndex: 0.5 },
    ])
      expect(isRun({ ...run, ...patch })).toBe(false);
    expect(isRun([])).toBe(false);
    expect(isRun(undefined)).toBe(false);
  });

  it("refuses a pending swap record with the wrong shape", () => {
    const dir = stateDir("/shape", {
      PI_COMPOSE_TEST_HOME: mkdtempSync(join(tmpdir(), "compose-test-home-")),
    });
    writeFileSync(join(dir, "swap.json"), JSON.stringify([{ path: 1 }]));
    expect(() => recoverSwap(dir)).toThrow(/not a pending swap record/);
  });

  it("handles empty sources and paths", () => {
    expect(parseJUnitXml("")).toEqual([]);
    expect(lintTestSource("app/src/test/A.kt", "")).toEqual([]);
    expect(categorize("")).toBe("other");
    expect(className("", "A.kt")).toBe("A");
  });
});

describe("maintainability review regressions", () => {
  it("rejects persisted runs whose nested records have the wrong shape", () => {
    const run = newRun("g", null);
    for (const patch of [
      { runs: [{}] },
      { mutations: [{ file: 1 }] },
      { findings: [{ file: "a" }] },
      { baseline: { head: 1, files: {} } },
      { baseline: { head: null, files: { a: 1 } } },
    ])
      expect(isRun({ ...run, ...patch })).toBe(false);
  });

  it("gives every run its own identity", () => {
    expect(newRun("g", null).id).not.toBe(newRun("g", null).id);
  });

  it("reports conflicts even when the swapped work throws", async () => {
    const dir = stateDir("/throws", { PI_COMPOSE_TEST_HOME: mkdtempSync(join(tmpdir(), "ct-")) });
    const file = join(mkdtempSync(join(tmpdir(), "ct-swap-")), "A.kt");
    writeFileSync(file, "original");
    const work = async () => {
      writeFileSync(file, "edited meanwhile");
      throw new Error("gradle crashed");
    };
    const swap = withSwappedFiles(dir, [{ path: file, content: Buffer.from("mutated") }], work);
    await expect(swap).rejects.toThrow(/gradle crashed[\s\S]*A\.kt/);
    expect(readFileSync(file, "utf8")).toBe("edited meanwhile");
  });

  it("accepts only Kotlin test targets", () => {
    const root = workspace();
    write(root, "app/src/test/java/a/FooTest.java", "class FooTest {}");
    const input = {
      workflow: "write-test" as const,
      targets: [{ file: "app/src/test/java/a/FooTest.java" }],
    };
    expect(() => start(newRun("g", null), input, root)).toThrow(/\.kt test/);
  });
});

describe("trusting Gradle results", () => {
  it("does not treat a target whose cases were all skipped as passing", async () => {
    const root = workspace();
    const exec: Exec = async () => {
      write(
        root,
        RESULT_XML,
        '<testsuite><testcase name="showsGreeting" classname="a.FooTest"><skipped/></testcase></testsuite>',
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    expect((await runTargets(exec, root, [fooTarget])).outcome).toBe("no-tests");
  });

  it("ignores failure markup inside captured output", () => {
    const xml =
      '<testcase name="a" classname="p.T"><system-out><![CDATA[log: <failure> </testcase>]]></system-out></testcase>';
    expect(parseJUnitXml(xml)).toEqual([
      { className: "p.T", name: "a", status: "passed", seconds: 0 },
    ]);
  });
});
