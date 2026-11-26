import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type Exec, gradleConfig, parseJUnitXml, runTargets, testClasses } from "../src/gradle.ts";
import { fakeGradle, passingTest, RESULT_XML, TEST_FILE, workspace, write } from "./helpers.ts";

const fooTarget = { file: TEST_FILE };
const firstClass = (source: string, file: string) => testClasses(source, file)[0]?.name;

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
      firstClass("package a\nobject Fixtures\nclass FooTest {\n  @Test fun t() {}\n}", "x.kt"),
    ).toBe("a.FooTest");
    expect(
      firstClass(
        "package a\n@Config(sdk = [33]) class Actual {\n  @Test fun t() {}\n}",
        "Renamed.kt",
      ),
    ).toBe("a.Actual");
    expect(firstClass("// nothing", "x/FooTest.kt")).toBe("FooTest");
  });

  it("takes an indented top-level class but never a nested one", () => {
    expect(firstClass("package p\n  class Actual {\n @Test fun ok() {}\n}", "Different.kt")).toBe(
      "p.Actual",
    );
    const nested = "package p\nclass Outer {\nclass Helper\n  @Test fun ok() {}\n}";
    expect(firstClass(nested, "Outer.kt")).toBe("p.Outer");
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

describe("targets that leave the workspace after start", () => {
  it("refuses a target reached through a symlink before touching its reports", async () => {
    const outside = workspace();
    const root = workspace({ test: null });
    symlinkSync(join(outside, "app"), join(root, "link"));
    const report = join(outside, RESULT_XML);
    write(outside, RESULT_XML, "keep");
    const run = runTargets(fakeGradle(root, () => "pass").exec, root, [
      { file: "link/src/test/java/a/FooTest.kt" },
    ]);
    await expect(run).rejects.toThrow(/outside the workspace/);
    expect(existsSync(report)).toBe(true);
  });
});

describe("aliased test annotations", () => {
  it("still selects the class that holds the tests", () => {
    const source =
      "package p\nimport org.junit.Test as JUnitTest\nclass ActualTest { @JUnitTest fun works() {} }\nclass Helper {}";
    expect(firstClass(source, "ActualTest.kt")).toBe("p.ActualTest");
  });
});

describe("a file with several top-level test classes", () => {
  const source =
    "package a\nclass First {\n  @Test fun good() {}\n}\nobject Helpers\nclass Second {\n  @Test fun broken() {}\n}\n";

  it("lists every class that holds tests, with its tests", () => {
    expect(testClasses(source, "Both.kt")).toEqual([
      { name: "a.First", tests: ["good"] },
      { name: "a.Second", tests: ["broken"] },
    ]);
  });

  it("asks Gradle for every class, or only the one holding a named method", async () => {
    const root = workspace({ test: source });
    const calls: string[][] = [];
    const exec: Exec = async (_c, args) => {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runTargets(exec, root, [fooTarget]);
    await runTargets(exec, root, [{ file: TEST_FILE, method: "broken" }]);
    const filters = calls.map((args) => args.filter((_, i) => args[i - 1] === "--tests"));
    expect(filters).toEqual([["a.First", "a.Second"], ["a.Second.broken"]]);
  });
});

describe("the same test class in two modules", () => {
  it("keeps both modules' cases", async () => {
    const root = workspace({ test: null });
    write(root, "settings.gradle.kts", 'include(":app", ":lib")\n');
    const files = ["app/src/test/java/a/FooTest.kt", "lib/src/test/java/a/FooTest.kt"];
    for (const file of files) write(root, file, passingTest);
    const exec: Exec = async (_c, args) => {
      const module = args.includes(":lib:testDebugUnitTest") ? "lib" : "app";
      write(
        root,
        `${module}/build/test-results/testDebugUnitTest/TEST-a.FooTest.xml`,
        '<testcase name="showsGreeting" classname="a.FooTest"/>',
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runTargets(
      exec,
      root,
      files.map((file) => ({ file })),
    );
    expect(result.cases).toHaveLength(2);
  });
});

describe("a package directory named src", () => {
  it("does not move the module boundary", async () => {
    const file = "app/src/test/java/com/src/ExampleTest.kt";
    const root = workspace({ test: null });
    write(
      root,
      file,
      "package com.src\nclass ExampleTest {\n  @Test fun works() { assert(true) }\n}\n",
    );
    const tasks: string[] = [];
    const exec: Exec = async (_c, args) => {
      tasks.push(args[1] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    };
    await runTargets(exec, root, [{ file }]);
    expect(tasks).toEqual([":app:testDebugUnitTest"]);
  });
});
