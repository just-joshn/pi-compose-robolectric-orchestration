import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { step } from "../src/engine.ts";
import { type Exec, gradleConfig, parseJUnitXml, runTargets, testClasses } from "../src/gradle.ts";
import {
  begin,
  deps,
  fakeGradle,
  passingTest,
  RESULT_XML,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

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
    const result = await runTargets(deps(root, gradle.exec), [
      { file: TEST_FILE, method: "showsGreeting" },
      { file: "lib/src/test/java/b/BarTest.kt" },
    ]);
    expect(gradle.calls[0]).toEqual([
      "--console=plain",
      "-p",
      "app",
      "testDebugUnitTest",
      "--rerun",
      "--tests",
      "a.FooTest.showsGreeting",
      "--tests",
      "a.FooTest$*.showsGreeting",
      "--init-script",
      expect.stringMatching(/\.gradle$/),
    ]);
    expect(gradle.calls[1]?.slice(1, 4)).toEqual(["-p", "lib", "testDebugUnitTest"]);
    expect(result.outcome).toBe("no-tests");
    const nested = await runTargets(
      deps(root, async () => {
        write(
          root,
          "app/build/test-results/testDebugUnitTest/TEST-a.FooTest$Inner.xml",
          '<testcase name="t" classname="a.FooTest$Inner"><failure message="x"/></testcase>',
        );
        return { code: 1, stdout: "", stderr: "" };
      }),
      [fooTarget],
    );
    expect(nested.outcome).toBe("failed");
  });
});

describe("classifying Gradle outcomes", () => {
  it("classifies failures, build errors, empty runs and phantom targets", async () => {
    const root = workspace();
    expect(
      (await runTargets(deps(root, fakeGradle(root, () => "fail").exec), [fooTarget])).outcome,
    ).toBe("failed");
    const broken = await runTargets(deps(root, fakeGradle(root, () => "build-error").exec), [
      fooTarget,
    ]);
    expect(broken.outcome).toBe("build-error");
    expect(broken.outputTail).toContain("e: Unresolved reference");
    expect(
      (
        await runTargets(
          deps(root, async () => ({ code: 0, stdout: "", stderr: "" })),
          [fooTarget],
        )
      ).outcome,
    ).toBe("no-tests");
    expect(
      (
        await runTargets(deps(root, fakeGradle(root, () => "pass").exec), [
          fooTarget,
          { file: TEST_FILE, method: "missing" },
        ])
      ).outcome,
    ).toBe("no-tests");
    await expect(
      runTargets(deps(root, fakeGradle(root, () => "pass").exec), [{ file: "nope.kt" }]),
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
    expect((await runTargets(deps(root, exec), [fooTarget])).outcome).toBe("no-tests");
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
    const run = runTargets(deps(root, fakeGradle(root, () => "pass").exec), [
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
    await runTargets(deps(root, exec), [fooTarget]);
    await runTargets(deps(root, exec), [{ file: TEST_FILE, method: "broken" }]);
    const filters = calls.map((args) => args.filter((_, i) => args[i - 1] === "--tests"));
    expect(filters).toEqual([
      ["a.First", "a.First$*", "a.Second", "a.Second$*"],
      ["a.Second.broken", "a.Second$*.broken"],
    ]);
  });
});

describe("the same test class in two modules", () => {
  it("keeps both modules' cases", async () => {
    const root = workspace({ test: null });
    write(root, "settings.gradle.kts", 'include(":app", ":lib")\n');
    const files = ["app/src/test/java/a/FooTest.kt", "lib/src/test/java/a/FooTest.kt"];
    for (const file of files) write(root, file, passingTest);
    const exec: Exec = async (_c, args) => {
      const module = args.includes("lib") ? "lib" : "app";
      write(
        root,
        `${module}/build/test-results/testDebugUnitTest/TEST-a.FooTest.xml`,
        '<testcase name="showsGreeting" classname="a.FooTest"/>',
      );
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runTargets(
      deps(root, exec),
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
      tasks.push(args.slice(1, 4).join(" "));
      return { code: 0, stdout: "", stderr: "" };
    };
    await runTargets(deps(root, exec), [{ file }]);
    expect(tasks).toEqual(["-p app testDebugUnitTest"]);
  });
});

describe("a module whose Gradle path differs from its directory", () => {
  it("lets Gradle map the directory to its project", async () => {
    const file = "android/app/src/test/java/a/FooTest.kt";
    const root = workspace({ test: null });
    write(root, file, passingTest);
    const calls: string[][] = [];
    const exec: Exec = async (_c, args) => {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    await runTargets(deps(root, exec), [{ file }]);
    expect(calls[0]?.slice(1, 4)).toEqual(["-p", "android/app", "testDebugUnitTest"]);
  });
});

const glob = (filter: string) =>
  new RegExp(`^${filter.replaceAll(/[.$]/g, "\\$&").replaceAll("*", ".*")}$`);

describe("tests in nested classes", () => {
  const inner = "a.FooTest$WhenShouting";
  const source = `package a\nclass FooTest {\n  @Test fun greets() { assert(true) }\n  class WhenShouting {\n    @Test fun shouts() { assert(false) }\n  }\n}\n`;
  /** Like Gradle: a class filter does not match a nested class; a filter must name it. */
  const exec =
    (root: string): Exec =>
    async (_c, args) => {
      const filters = args.filter((_, i) => args[i - 1] === "--tests").map(glob);
      const runs = (name: string) => filters.some((f) => f.test(name));
      if (runs("a.FooTest") || runs("a.FooTest.greets"))
        write(root, RESULT_XML, '<testcase name="greets" classname="a.FooTest"/>');
      const failed = runs(inner) || runs(`${inner}.shouts`);
      if (failed)
        write(
          root,
          `app/build/test-results/testDebugUnitTest/TEST-${inner}.xml`,
          `<testcase name="shouts" classname="${inner}"><failure message="x"/></testcase>`,
        );
      return { code: failed ? 1 : 0, stdout: "", stderr: "" };
    };

  it("runs them, so their failures count", async () => {
    const root = workspace({ test: source });
    const whole = await runTargets(deps(root, exec(root)), [fooTarget]);
    expect(whole.outcome).toBe("failed");
    const method = await runTargets(deps(root, exec(root)), [
      { file: TEST_FILE, method: "shouts" },
    ]);
    expect(method.cases.map((c) => `${c.className}.${c.name}:${c.status}`)).toEqual([
      `${inner}.shouts:failed`,
    ]);
  });
});

describe("a module with a child project inside its directory", () => {
  it("is not failed by the child's tests, which never match the target", async () => {
    const root = workspace();
    write(root, "settings.gradle.kts", 'include(":app", ":app:sub")\n');
    write(root, "app/sub/src/test/java/b/SubTest.kt", "package b\nclass SubTest");
    /** Like Gradle: -p app also runs :app:sub's test task, which fails on a filter it cannot match. */
    const exec: Exec = async (_c, args) => {
      write(root, RESULT_XML, '<testcase name="showsGreeting" classname="a.FooTest"/>');
      const script = args[args.indexOf("--init-script") + 1] ?? "";
      const allowed =
        existsSync(script) && /failOnNoMatchingTests = false/.test(readFileSync(script, "utf8"));
      return allowed
        ? { code: 0, stdout: "BUILD SUCCESSFUL", stderr: "" }
        : { code: 1, stdout: "> Task :app:sub:test FAILED", stderr: "No tests found" };
    };
    expect((await runTargets(deps(root, exec), [fooTarget])).outcome).toBe("passed");
  });
});

/** Like pi.exec: an abort during the run kills Gradle, which exits 143 without results. */
function abortedRun() {
  const controller = new AbortController();
  const exec: Exec = async () => {
    controller.abort();
    return { code: 143, stdout: "", stderr: "" };
  };
  return { exec, signal: controller.signal };
}

describe("a run the operator aborts", () => {
  it("is never read as test evidence", async () => {
    const root = workspace();
    const gradle = abortedRun();
    await expect(
      runTargets({ ...deps(root, gradle.exec), signal: gradle.signal }, [fooTarget]),
    ).rejects.toThrow(/cancelled/);
    const { run, d } = begin(root, { workflow: "fix-failing" });
    await expect(step(run, { ...d, ...abortedRun() })).rejects.toThrow(/cancelled/);
  });
});
