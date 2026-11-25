import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaults, loadConfig, parseConfig } from "../src/config.ts";
import { parseJUnitXml } from "../src/junit.ts";
import { countIgnores, countTests, lintTestSource, testFunctions } from "../src/lint.ts";
import { categorize, isLocalTestPath } from "../src/paths.ts";
import { className, gradleCommand, resolveTarget } from "../src/project.ts";
import { report, statusLine } from "../src/report.ts";
import { runTargets } from "../src/runner.ts";
import { addRun, finish, lastRun, newRun, parseRun, terminal } from "../src/state.ts";
import { changedPaths, digest, fingerprint } from "../src/tree.ts";
import { isWorkflowId, routingTable, workflowIds, workflows } from "../src/workflows.ts";
import { recoverSwap, withSwappedFiles } from "../src/swap.ts";
import { acquireLock, releaseLock, stateDir } from "../src/workspace.ts";
import { fakeGradle, git, MAIN_FILE, passingTest, TEST_FILE, workspace, write } from "./helpers.ts";

describe("categorize", () => {
  it.each([
    ["app/src/test/java/A.kt", "test"],
    ["app/src/androidTest/java/A.kt", "test"],
    ["app/src/testDebug/java/A.kt", "test"],
    ["src/test/resources/robolectric.properties", "test"],
    ["app/src/main/java/A.kt", "production"],
    ["feature/src/debug/res/x.xml", "production"],
    ["app/build.gradle.kts", "build"],
    ["gradle/libs.versions.toml", "build"],
    ["gradle.properties", "build"],
    ["README.md", "other"],
  ])("%s is %s", (path, category) => expect(categorize(path)).toBe(category));

  it("knows which tests run locally", () => {
    expect(isLocalTestPath("app/src/test/A.kt")).toBe(true);
    expect(isLocalTestPath("app\\src\\test\\A.kt")).toBe(true);
    expect(isLocalTestPath("app/src/androidTest/A.kt")).toBe(false);
  });
});

describe("lintTestSource", () => {
  const rules = (source: string, file = "app/src/test/A.kt") =>
    lintTestSource(file, source)
      .map((f) => f.rule)
      .toSorted();

  it("passes a clean v2 test", () => expect(rules(passingTest)).toEqual([]));

  it("flags v1 APIs, sleeps, missing assertions and missing runners", () => {
    const source = `import androidx.compose.ui.test.junit4.createComposeRule
class A {
  @get:Rule val rule = createComposeRule()
  @Test fun crashesOnly() { rule.setContent { }; Thread.sleep(5) }
  @Test fun \`expression body\`() = rule.onNodeWithText("x").assertExists()
}`;
    expect(rules(source)).toEqual([
      "missing-runner",
      "no-assertion",
      "thread-sleep",
      "v1-compose-test-api",
    ]);
  });

  it("flags warnings only where they apply, and ignores comments", () => {
    const source = `@RunWith(X::class)
class A {
  @get:Rule val rule = createComposeRule()
  @Ignore
  @Test fun t() = runTest { rule.onRoot().printToLog("T"); assertTrue(true) }
  // Thread.sleep(1)
  val c = mock<Context>()
}`;
    expect(rules(source)).toEqual([
      "ignored-test",
      "mock-android-framework",
      "print-to-log",
      "run-test-with-compose-rule",
    ]);
    expect(rules("class B { val x = runTest { } }")).toEqual([]);
  });

  it("counts tests and ignores", () => {
    expect(countTests(passingTest)).toBe(1);
    expect(countIgnores("@Ignore\n@org.junit.Ignore\n// @Ignore")).toBe(2);
    expect(testFunctions("@Test fun broken(")).toEqual([]);
  });
});

describe("parseJUnitXml", () => {
  it("reads passed, failed, errored and skipped cases with escaped messages", () => {
    const cases = parseJUnitXml(`<testsuite>
      <testcase name="a" classname="p.T" time="1.5"/>
      <testcase name="b" classname="p.T" time="0.1"><failure message="x &lt; &quot;y&quot; &amp; z" type="java.lang.AssertionError">t</failure></testcase>
      <testcase name="c" classname="p.T" time="0"><error type="NPE">t</error></testcase>
      <testcase name="d" classname="p.T"><skipped/></testcase>
    </testsuite>`);
    expect(cases.map((c) => [c.name, c.status])).toEqual([
      ["a", "passed"],
      ["b", "failed"],
      ["c", "failed"],
      ["d", "skipped"],
    ]);
    expect(cases[1]?.message).toBe('x < "y" & z');
    expect(cases[2]?.failureType).toBe("NPE");
    expect(cases[0]?.seconds).toBe(1.5);
  });
});

describe("project resolution", () => {
  it("finds the module, Gradle path and class name", () => {
    const root = workspace();
    write(
      root,
      "lib/feature/src/test/java/b/BarTest.kt",
      "package b\n\n@RunWith(X::class)\nclass BarTest",
    );
    const target = resolveTarget(root, { file: "lib/feature/src/test/java/b/BarTest.kt" });
    expect(target.gradlePath).toBe(":lib:feature");
    expect(target.className).toBe("b.BarTest");
    expect(resolveTarget(root, { file: TEST_FILE }).gradlePath).toBe(":app");
    expect(() => resolveTarget(root, { file: "nope.kt" })).toThrow(/does not exist/);
    write(root, "Loose.kt", "class Loose");
    expect(() => resolveTarget(root, { file: "Loose.kt" })).toThrow(/src\//);
  });

  it("falls back to the file name and prefers the wrapper", () => {
    expect(className("// nothing", "x/FooTest.kt")).toBe("FooTest");
    const root = workspace();
    expect(gradleCommand(root, undefined)).toBe("gradle");
    expect(gradleCommand(root, "/opt/gradle")).toBe("/opt/gradle");
    write(root, "gradlew", "#!/bin/sh");
    expect(gradleCommand(root, "/opt/gradle")).toBe(join(root, "gradlew"));
  });

  it("rejects a module without settings.gradle", () => {
    const root = mkdtempSync(join(tmpdir(), "compose-test-nosettings-"));
    write(root, "app/src/test/A.kt", "class A");
    expect(() => resolveTarget(root, { file: "app/src/test/A.kt" })).toThrow(/settings.gradle/);
  });
});

describe("runTargets", () => {
  const config = { gradle: "gradle", unitTestTask: "testDebugUnitTest", timeoutSeconds: 5 };

  it("runs one invocation per module with --rerun and method filters", async () => {
    const root = workspace();
    const gradle = fakeGradle(root, () => "pass");
    const target = resolveTarget(root, { file: TEST_FILE, method: "showsGreeting" });
    const result = await runTargets(gradle.exec, [target], config);
    expect(gradle.calls[0]).toEqual([
      "--console=plain",
      ":app:testDebugUnitTest",
      "--rerun",
      "--tests",
      "a.FooTest.showsGreeting",
    ]);
    expect(result.outcome).toBe("passed");
    expect(result.cases).toHaveLength(1);
  });

  it("distinguishes failures, build errors and empty runs", async () => {
    const root = workspace();
    const target = resolveTarget(root, { file: TEST_FILE });
    expect((await runTargets(fakeGradle(root, () => "fail").exec, [target], config)).outcome).toBe(
      "failed",
    );
    const broken = await runTargets(fakeGradle(root, () => "build-error").exec, [target], config);
    expect(broken.outcome).toBe("build-error");
    expect(broken.outputTail).toContain("BUILD FAILED");
    const empty = await runTargets(
      async () => ({ code: 0, stdout: "", stderr: "" }),
      [target],
      config,
    );
    expect(empty.outcome).toBe("no-tests");
    const odd = await runTargets(
      fakeGradle(root, () => "pass").exec,
      [{ ...target, method: "missing" }],
      config,
    );
    expect(odd.outcome).toBe("no-tests");
  });
});

describe("fingerprint", () => {
  it("tracks dirty, untracked, renamed and committed changes under git", () => {
    const root = workspace();
    const base = fingerprint(root);
    expect(base.files).toEqual({});
    write(root, "new.txt", "x");
    write(root, MAIN_FILE, "changed");
    expect(changedPaths(root, base, fingerprint(root))).toEqual([MAIN_FILE, "new.txt"]);
    git(root, "add", "-A");
    renameSync(join(root, "new.txt"), join(root, "moved.txt"));
    git(root, "add", "-A");
    const renamed = fingerprint(root);
    expect(Object.keys(renamed.files)).toEqual(expect.arrayContaining(["moved.txt"]));
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "next");
    const committed = fingerprint(root);
    expect(changedPaths(root, base, committed)).toEqual([MAIN_FILE, "moved.txt"]);
    expect(digest(committed)).not.toBe(digest(base));
    expect(digest(fingerprint(root))).toBe(digest(committed));
  });

  it("hashes every file outside git and ignores build output", () => {
    const root = workspace({ git: false });
    write(root, "app/build/out.txt", "ignored");
    const before = fingerprint(root);
    expect(before.head).toBeNull();
    expect(Object.keys(before.files)).not.toContain("app/build/out.txt");
    rmSync(join(root, MAIN_FILE));
    expect(changedPaths(root, before, fingerprint(root))).toEqual([MAIN_FILE]);
  });
});

describe("config", () => {
  it("validates keys and values", () => {
    expect(parseConfig({ stressRuns: 3, gradle: "/g", minSpeedup: 0.1 }, "x")).toEqual({
      stressRuns: 3,
      gradle: "/g",
      minSpeedup: 0.1,
    });
    expect(() => parseConfig([], "x")).toThrow(/object/);
    expect(() => parseConfig({ nope: 1 }, "x")).toThrow(/unknown key/);
    expect(() => parseConfig({ stressRuns: 0 }, "x")).toThrow(/invalid value/);
    expect(() => parseConfig({ minSpeedup: 2 }, "x")).toThrow(/invalid value/);
  });

  it("layers project config only for trusted projects, then the environment", () => {
    const root = workspace();
    write(root, ".pi/compose-test.json", JSON.stringify({ stressRuns: 9 }));
    expect(loadConfig(root, false, {}).stressRuns).toBe(defaults.stressRuns);
    expect(loadConfig(root, true, {}).stressRuns).toBe(9);
    expect(loadConfig(root, true, { COMPOSE_TEST_GRADLE: "/env/gradle" }).gradle).toBe(
      "/env/gradle",
    );
  });
});

describe("workspace state", () => {
  const env = { PI_COMPOSE_TEST_HOME: mkdtempSync(join(tmpdir(), "compose-test-home-")) };

  it("locks per workspace and lets stale or own locks through", () => {
    const dir = stateDir("/some/workspace", env);
    acquireLock(dir, "s1");
    acquireLock(dir, "s1");
    expect(() => acquireLock(dir, "s2")).toThrow(/Another Pi session/);
    releaseLock(dir, "s2");
    expect(() => acquireLock(dir, "s2")).toThrow();
    releaseLock(dir, "s1");
    acquireLock(dir, "s2");
    writeFileSync(join(dir, "lock.json"), JSON.stringify({ pid: 999_999_999, session: "dead" }));
    acquireLock(dir, "s3");
    releaseLock(dir, "s3");
    releaseLock(dir, "s3");
  });

  it("restores swapped files, deletes created ones and keeps files someone else changed", async () => {
    const dir = stateDir("/other/workspace", env);
    const root = mkdtempSync(join(tmpdir(), "compose-test-swap-"));
    const a = join(root, "A.kt");
    const b = join(root, "B.kt");
    writeFileSync(a, "original");
    const { conflicts } = await withSwappedFiles(dir, [{ path: a, content: Buffer.from("mutated") }, { path: b, content: Buffer.from("new") }], async () => {
      expect(readFileSync(a, "utf8")).toBe("mutated");
      writeFileSync(b, "edited meanwhile");
    });
    expect(readFileSync(a, "utf8")).toBe("original");
    expect(readFileSync(b, "utf8")).toBe("edited meanwhile");
    expect(conflicts).toEqual([b]);
    await expect(withSwappedFiles(dir, [{ path: a, content: null }], async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(readFileSync(a, "utf8")).toBe("original");
  });

  it("repairs a swap left behind by a crash exactly once", () => {
    const dir = stateDir("/crash/workspace", env);
    const file = join(mkdtempSync(join(tmpdir(), "compose-test-mut-")), "Foo.kt");
    writeFileSync(file, "mutated");
    const record = [{ path: file, original: Buffer.from("original").toString("base64"), written: createHash("sha256").update("mutated").digest("hex") }];
    writeFileSync(join(dir, "swap.json"), JSON.stringify(record));
    expect(recoverSwap(dir)).toEqual({ restored: [file], conflicts: [] });
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(recoverSwap(dir)).toEqual({ restored: [], conflicts: [] });
    writeFileSync(join(dir, "swap.json"), JSON.stringify(record));
    writeFileSync(file, "operator edit");
    expect(recoverSwap(dir).conflicts[0]).toContain(file);
    expect(readFileSync(file, "utf8")).toBe("operator edit");
  });
});

describe("state and report", () => {
  it("parses only well-formed persisted runs", () => {
    const run = newRun("g", null);
    expect(parseRun(run)).toEqual(run);
    expect(parseRun(null)).toBeNull();
    expect(parseRun({ ...run, version: 2 })).toBeNull();
    expect(parseRun({ ...run, workflow: "nope" })).toBeNull();
    expect(parseRun({ ...run, goal: 1 })).toBeNull();
    expect(parseRun({ ...run, runs: {} })).toBeNull();
  });

  it("reports evidence from the record", () => {
    const [withRun] = addRun(
      {
        ...newRun("Add tests", null),
        workflow: "write-test",
        targets: [{ file: TEST_FILE, method: "m" }],
      },
      {
        phase: "verify",
        purpose: "verify",
        command: "gradlew test",
        exitCode: 1,
        outcome: "failed",
        cases: [
          {
            className: "a.FooTest",
            name: "m",
            status: "failed",
            seconds: 1,
            message: "boom\nmore",
          },
        ],
        seconds: 3,
        outputTail: "",
        tree: "t",
      },
    );
    const done = finish(
      {
        ...withRun,
        notes: { explore: "note" },
        mutations: [
          {
            file: MAIN_FILE,
            find: "a",
            replace: "b",
            runId: 1,
            tree: "t",
            detected: false,
            restored: true,
          },
        ],
        findings: [
          { file: TEST_FILE, line: 1, rule: "r", severity: "error", message: "m", source: "agent" },
        ],
      },
      "incomplete",
      "why",
    );
    const text = report(done);
    expect(text).toContain("compose-test status: INCOMPLETE");
    expect(text).toContain(`${TEST_FILE}#m`);
    expect(text).toContain("first failure m: boom");
    expect(text).toContain("NOT detected");
    expect(text).toContain("[error] r (agent)");
    expect(statusLine(done, undefined)).toBe("compose-test incomplete");
    expect(statusLine({ ...done, status: "active" }, "write")).toBe("write-test: write");
    expect(report(newRun("g", null))).toContain("(none started)");
    expect(lastRun(done, "mutation")).toBeUndefined();
    expect(terminal("routing")).toBe(false);
  });

  it("routes every workflow id", () => {
    expect(workflowIds.every(isWorkflowId)).toBe(true);
    expect(isWorkflowId("nope")).toBe(false);
    expect(routingTable().split("\n")).toHaveLength(workflowIds.length);
    for (const id of workflowIds) expect(workflows[id].phases.length).toBeGreaterThan(0);
  });
});
