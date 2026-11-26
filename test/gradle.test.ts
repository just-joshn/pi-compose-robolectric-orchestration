import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { step } from "../src/engine.ts";
import { type Exec, gradleConfig, parseJUnitXml, runTargets, testClasses } from "../src/gradle.ts";
import {
  begin,
  deps,
  fakeGradle,
  glob,
  passingTest,
  recordTask,
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
      "a.FooTest.showsGreeting[*",
      "--tests",
      "a.FooTest$*.showsGreeting",
      "--tests",
      "a.FooTest$*.showsGreeting[*",
      "--init-script",
      expect.stringMatching(/\.gradle$/),
      expect.stringMatching(/^-DcomposeTest\.record=.+\.record$/),
    ]);
    expect(gradle.calls[1]?.slice(1, 4)).toEqual(["-p", "lib", "testDebugUnitTest"]);
    expect(result.outcome).toBe("no-tests");
    const nested = await runTargets(
      deps(root, async (_c, args) => {
        write(
          root,
          "app/build/test-results/testDebugUnitTest/TEST-a.FooTest$Inner.xml",
          '<testcase name="t" classname="a.FooTest$Inner"><failure message="x"/></testcase>',
        );
        recordTask(root, args);
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
    const exec: Exec = async (_c, args) => {
      write(
        root,
        RESULT_XML,
        '<testsuite><testcase name="showsGreeting" classname="a.FooTest"><skipped/></testcase></testsuite>',
      );
      recordTask(root, args);
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
    expect(testClasses(source, "Both.kt")).toMatchObject([
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
      ["a.Second.broken", "a.Second.broken[*", "a.Second$*.broken", "a.Second$*.broken[*"],
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
      recordTask(root, args);
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

it("uses class bodies after constructor and superclass lambdas for ownership and ignored tests", () => {
  const source = `package a
import org.junit.Ignore
abstract class Base<T>(check: () -> Boolean) {
  @Test fun inherited() {}
}
class FooTest(val check: () -> Boolean = { true }) : Base<List<String>>({ true }) {
  @Test fun own() {}
  @Ignore class Ignored : Base<List<String>>({ true }) {
    @Test fun skipped() {}
  }
  class Nested : Base<List<String>>({ true }) {
    @Test fun works() {}
  }
}`;
  expect(testClasses(source, TEST_FILE)).toEqual([
    {
      name: "a.FooTest",
      tests: ["own", "works", "inherited"],
      testIds: ["a.FooTest.own", "a.FooTest$Nested.works", "a.FooTest.inherited"],
    },
  ]);
});

it("keeps braces in backtick class names out of class body boundaries", () => {
  const source = `package a
class FooTest {
  class \`Logged {in\` {
    @Test fun works() {}
  }
  class Other {
    @Test fun other() {}
  }
}
class AnotherTest {
  @Test fun another() {}
}`;
  expect(testClasses(source, TEST_FILE)).toEqual([
    {
      name: "a.FooTest",
      tests: ["works", "other"],
      testIds: ["a.FooTest$Logged {in.works", "a.FooTest$Other.other"],
    },
    { name: "a.AnotherTest", tests: ["another"], testIds: ["a.AnotherTest.another"] },
  ]);
});

describe("tests in nested classes", () => {
  const inner = "a.FooTest$WhenShouting";
  const source = `package a\nclass FooTest {\n  @Test fun greets() { assert(true) }\n  class WhenShouting {\n    @Test fun shouts() { assert(false) }\n  }\n}\n`;
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
      recordTask(root, args);
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

describe("a module with a child project", () => {
  it("is not failed by the child's tests, which never match the target", async () => {
    const root = workspace();
    write(root, "settings.gradle.kts", 'include(":app", ":app:sub")\n');
    write(root, "app/sub/src/test/java/b/SubTest.kt", "package b\nclass SubTest");
    const exec: Exec = async (_c, args) => {
      write(root, RESULT_XML, '<testcase name="showsGreeting" classname="a.FooTest"/>');
      recordTask(root, args);
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

describe("a child project's results", () => {
  it.each([
    ["app/sub", "first"],
    ["app/sub", "last"],
    ["aaa/sub", "first"],
    ["aaa/sub", "last"],
  ] as const)("keeps the results of a child at %s listed %s", async (dir, order) => {
    const root = workspace();
    write(
      root,
      "settings.gradle.kts",
      `include(":app", ":app:sub")\nproject(":app:sub").projectDir = file("${dir}")\n`,
    );
    const sub = `${dir}/src/test/java/b/SubTest.kt`;
    write(root, sub, "package b\nclass SubTest {\n  @Test fun works() { assert(true) }\n}\n");
    const subResults = `${dir}/build/test-results/testDebugUnitTest`;
    const exec: Exec = async (_c, args) => {
      rmSync(join(root, subResults), { recursive: true, force: true });
      if (args.includes(dir))
        write(
          root,
          `${subResults}/TEST-b.SubTest.xml`,
          '<testcase name="works" classname="b.SubTest"/>',
        );
      else write(root, RESULT_XML, '<testcase name="showsGreeting" classname="a.FooTest"/>');
      recordTask(root, args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const targets = order === "first" ? [{ file: sub }, fooTarget] : [fooTarget, { file: sub }];
    const result = await runTargets(deps(root, exec), targets);
    expect(result.outcome).toBe("passed");
    expect(result.cases.map((c) => c.name).toSorted()).toEqual(["showsGreeting", "works"]);
  });
});

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

it("runs a test class without treating its constructor parameter as a test subclass", async () => {
  const root = workspace({
    test: `package a
abstract class Base {
  @Test fun inherited() {}
}
class Fixture(val base: Base, val number: Int)
class RealTest : Base()
`,
  });
  const exec: Exec = async (_command, args) => {
    write(
      root,
      "app/build/test-results/testDebugUnitTest/TEST-a.RealTest.xml",
      '<testsuite><testcase classname="a.RealTest" name="inherited"/></testsuite>',
    );
    recordTask(root, args);
    return { code: 0, stdout: "", stderr: "" };
  };
  expect((await runTargets(deps(root, exec), [{ file: TEST_FILE }])).outcome).toBe("passed");
});

async function runMethod(source: string) {
  const root = workspace({ test: source });
  const exec: Exec = async (_command, args) => {
    const filters = new Set(args.filter((_, i) => args[i - 1] === "--tests"));
    for (const name of ["BaseTest", "LeafTest"]) {
      if (filters.has(`a.${name}.inherited`)) {
        write(
          root,
          `app/build/test-results/testDebugUnitTest/TEST-a.${name}.xml`,
          `<testcase name="inherited" classname="a.${name}"/>`,
        );
      }
    }
    recordTask(root, args);
    return { code: 0, stdout: "", stderr: "" };
  };
  return runTargets(deps(root, exec), [{ file: TEST_FILE, method: "inherited" }]);
}

describe("inherited test target selection", () => {
  it("runs the inherited method without selecting an unrelated constructor parameter", async () => {
    const result = await runMethod(`package a
open class BaseTest {
  @Test fun inherited() {}
}
class OtherTest(val dependency: BaseTest = BaseTest()) {
  @Test fun other() {}
}
`);
    expect(result.outcome).toBe("passed");
  });

  it("runs the inherited method without selecting a generic interface argument", async () => {
    const result = await runMethod(`package a
interface Marker<A, B>
open class BaseTest {
  @Test fun inherited() {}
}
class OtherTest : Marker<BaseTest, String> {
  @Test fun other() {}
}
`);
    expect(result.outcome).toBe("passed");
  });
});

describe("qualified inherited test selection", () => {
  it("includes a concrete test class with a fully qualified superclass", () => {
    const source = `package a
abstract class Base {
  @Test fun inherited() { assert(true) }
}
class InheritedTest : a.Base()
class OtherTest {
  @Test fun other() { assert(true) }
}`;
    expect(testClasses(source, "app/src/test/java/a/Tests.kt")).toMatchObject([
      { name: "a.InheritedTest", tests: ["inherited"] },
      { name: "a.OtherTest", tests: ["other"] },
    ]);
  });

  it("does not inherit from a same-named class in another package", () => {
    const source = `package a
open class Base {
  @Test fun inherited() { assert(true) }
}
class Other : support.Base() {
  @Test fun other() { assert(true) }
}`;
    expect(testClasses(source, "app/src/test/java/a/Tests.kt")).toMatchObject([
      { name: "a.Base", tests: ["inherited"] },
      { name: "a.Other", tests: ["other"] },
    ]);
  });

  it.each([
    ["a package-qualified superclass", "class Leaf : a.Base()"],
    ["a comparison in a constructor default", "class Leaf(val enabled: Boolean = 2 > 1) : Base()"],
  ])("runs a failing inherited test with %s", async (_case, declaration) => {
    const root = workspace({
      test: `package a
import org.junit.Test
abstract class Base {
  @Test fun inherited() { assert(false) }
}
${declaration}
class Other {
  @Test fun passes() { assert(true) }
}
`,
    });
    const exec: Exec = async (_command, args) => {
      const filters = new Set(args.filter((_, i) => args[i - 1] === "--tests"));
      write(
        root,
        "app/build/test-results/testDebugUnitTest/TEST-a.Other.xml",
        '<testcase classname="a.Other" name="passes"/>',
      );
      if (filters.has("a.Leaf")) {
        write(
          root,
          "app/build/test-results/testDebugUnitTest/TEST-a.Leaf.xml",
          '<testcase classname="a.Leaf" name="inherited"><failure/></testcase>',
        );
      }
      recordTask(root, args);
      return { code: filters.has("a.Leaf") ? 1 : 0, stdout: "", stderr: "" };
    };
    expect((await runTargets(deps(root, exec), [{ file: TEST_FILE }])).outcome).toBe("failed");
  });
});

async function runIgnoringTests(source: string) {
  const root = workspace({ test: source });
  const exec: Exec = async (_command, args) => {
    const filters = args.filter((_, i) => args[i - 1] === "--tests");
    write(
      root,
      "app/build/test-results/testDebugUnitTest/TEST-a.PassingTest.xml",
      '<testcase classname="a.PassingTest" name="works"/>',
    );
    if (filters.includes("a.IgnoredTest")) {
      write(
        root,
        "app/build/test-results/testDebugUnitTest/TEST-a.IgnoredTest.xml",
        '<testcase classname="a.IgnoredTest" name="works"><skipped/></testcase>',
      );
    }
    recordTask(root, args);
    return { code: 0, stdout: "", stderr: "" };
  };
  return runTargets(deps(root, exec), [{ file: TEST_FILE }]);
}

describe("ignored inherited test target selection", () => {
  const base = `package a
import org.junit.Ignore
import org.junit.Test
abstract class Base {
  @Test open fun works() { assert(true) }
}
class PassingTest : Base()
`;

  it("does not target an ignored class for its inherited test", async () => {
    const result = await runIgnoringTests(`${base}\n@Ignore class IgnoredTest : Base()\n`);
    expect(result.outcome).toBe("passed");
  });

  it("does not target an ignored override as an inherited test", async () => {
    const result = await runIgnoringTests(
      `${base}\nclass IgnoredTest : Base() {\n  @Ignore @Test override fun works() { }\n}\n`,
    );
    expect(result.outcome).toBe("passed");
  });

  it("runs inherited tests in a subclass of an ignored base class", async () => {
    const root = workspace({
      test: `package a
import org.junit.Ignore
import org.junit.Test
@Ignore open class BaseTest {
  @Test fun inherited() { assert(false) }
}
class DerivedTest : BaseTest()
class OtherTest {
  @Test fun passes() { assert(true) }
}
`,
    });
    const exec: Exec = async (_command, args) => {
      const filters = new Set(args.filter((_, i) => args[i - 1] === "--tests"));
      write(
        root,
        "app/build/test-results/testDebugUnitTest/TEST-a.OtherTest.xml",
        '<testcase classname="a.OtherTest" name="passes"/>',
      );
      if (filters.has("a.DerivedTest")) {
        write(
          root,
          "app/build/test-results/testDebugUnitTest/TEST-a.DerivedTest.xml",
          '<testcase classname="a.DerivedTest" name="inherited"><failure/></testcase>',
        );
      }
      recordTask(root, args);
      return { code: filters.has("a.DerivedTest") ? 1 : 0, stdout: "", stderr: "" };
    };
    const result = await runTargets(deps(root, exec), [{ file: TEST_FILE }]);
    expect(result.outcome).toBe("failed");
  });

  it("runs a non-ignored override of an ignored base test", () => {
    const source = `package a
open class Base {
  @Ignore @Test open fun works() {}
}
class Derived : Base() {
  @Test override fun works() {}
}`;
    expect(testClasses(source, TEST_FILE)).toMatchObject([{ name: "a.Derived", tests: ["works"] }]);
  });
});

describe("transitive inherited test target selection", () => {
  it("runs a concrete descendant through an abstract intermediate class", async () => {
    const root = workspace({
      test: `package a
abstract class Base {
  @Test fun inherited() {}
}
abstract class Intermediate : Base()
class LeafTest : Intermediate()
class OtherTest {
  @Test fun other() {}
}
`,
    });
    const exec: Exec = async (_command, args) => {
      const filters = new Set(args.filter((_, i) => args[i - 1] === "--tests"));
      write(
        root,
        "app/build/test-results/testDebugUnitTest/TEST-a.OtherTest.xml",
        '<testcase name="other" classname="a.OtherTest"/>',
      );
      if (filters.has("a.LeafTest")) {
        write(
          root,
          "app/build/test-results/testDebugUnitTest/TEST-a.LeafTest.xml",
          '<testcase name="inherited" classname="a.LeafTest"><failure/></testcase>',
        );
      }
      recordTask(root, args);
      return { code: filters.has("a.LeafTest") ? 1 : 0, stdout: "", stderr: "" };
    };
    const result = await runTargets(deps(root, exec), [{ file: TEST_FILE }]);
    expect(result.outcome).toBe("failed");
  });
});
