import { describe, expect, it } from "vitest";

import { className, type Exec, gradleConfig, parseJUnitXml, runTargets } from "../src/gradle.ts";
import { fakeGradle, RESULT_XML, TEST_FILE, workspace, write } from "./helpers.ts";

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
