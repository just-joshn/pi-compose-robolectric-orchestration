import { describe, expect, it } from "vitest";

import { finalize } from "../src/checks.ts";
import { start } from "../src/engine.ts";
import { type Exec, runTargets, testClasses } from "../src/gradle.ts";
import { newRun, type TestRun } from "../src/state.ts";
import { digest, fingerprint } from "../src/tree.ts";
import { BREAK, deps, recordTask, RESULT_XML, TEST_FILE, workspace, write } from "./helpers.ts";

const tests = (source: string) =>
  testClasses(source, "FooTest.kt").map((c) => `${c.name}: ${c.tests.join(", ")}`);

describe("tests JUnit skips because they are @Ignore'd", () => {
  it("are not part of the inventory, whether the function or a class is ignored", () => {
    const source = `package a
import org.junit.Ignore as Skip
class FooTest {
  @Test fun greets() { assert(true) }
  @Ignore("TODO") @Test fun inFrench() { assert(true) }
  @Skip
  @Test fun inGerman() { assert(true) }
  @Ignore
  class Later {
    @Test fun nested() { assert(true) }
  }
}
@Ignore class OtherTest {
  @Test fun other() { assert(true) }
}
`;
    expect(tests(source)).toEqual(["a.FooTest: greets"]);
  });

  it("need not pass for a test-preserving workflow to verify", () => {
    const source = `package a\nclass FooTest {\n  @Test fun greets() { assert(true) }\n  @Ignore @Test fun inFrench() { assert(true) }\n}\n`;
    const root = workspace({ test: source });
    const input = { workflow: "performance", targets: [{ file: TEST_FILE }] } as const;
    const run = start(newRun("g", null), input, root).run;
    const cases = [
      { className: "a.FooTest", name: "greets", status: "passed", seconds: 1 },
      { className: "a.FooTest", name: "inFrench", status: "skipped", seconds: 0 },
    ] as const;
    const measured: TestRun = {
      id: 1,
      phase: "after",
      purpose: "measure",
      command: "",
      exitCode: 0,
      outcome: "passed",
      cases,
      seconds: 1,
      testSeconds: 1,
      outputTail: "",
      tree: digest(fingerprint(root)),
    };
    const mutations = [{ ...BREAK, runId: 2, tree: measured.tree, detected: true }];
    expect(finalize({ ...run, runs: [measured], mutations }, root).status).toBe("verified");
  });
});

it("runs every concrete subclass with inherited tests", async () => {
  const root = workspace({
    test: `package a
import org.junit.Test
abstract class Base {
  @Test fun inherited() {}
}
class FirstTest : Base()
class SecondTest : Base()
`,
  });
  const exec: Exec = async (_command, args) => {
    const filters = new Set(args.filter((_, i) => args[i - 1] === "--tests"));
    if (filters.has("a.FirstTest")) {
      write(
        root,
        "app/build/test-results/testDebugUnitTest/TEST-a.FirstTest.xml",
        '<testcase name="inherited" classname="a.FirstTest"><failure/></testcase>',
      );
    }
    if (filters.has("a.SecondTest")) {
      write(
        root,
        "app/build/test-results/testDebugUnitTest/TEST-a.SecondTest.xml",
        '<testcase name="inherited" classname="a.SecondTest"/>',
      );
    }
    recordTask(root, args);
    return { code: filters.has("a.FirstTest") ? 1 : 0, stdout: "", stderr: "" };
  };
  const result = await runTargets(deps(root, exec), [{ file: TEST_FILE }]);
  expect(result.outcome).toBe("failed");
});

it("gives a subclass the tests of an open base class in the file", () => {
  const source = `package a
open class BaseTest {
  @Test fun inherited() {}
}
class SubTest : BaseTest()
`;
  expect(tests(source)).toEqual(["a.BaseTest: inherited", "a.SubTest: inherited"]);
});

describe("an abstract base class in the target file", () => {
  const source = `package a
abstract class GreetingContract {
  @Test fun isNotBlank() { assert(true) }
}
sealed class Shapes {
  @Test fun closed() { assert(true) }
}
class FooTest : GreetingContract() {
  @Test fun greets() { assert(true) }
}
`;

  it("is not run as a class of its own, since its tests run under subclasses", async () => {
    expect(tests(source)).toEqual(["a.FooTest: greets, isNotBlank"]);
    const root = workspace({ test: source });
    const cases = ["isNotBlank", "greets"].map(
      (n) => `<testcase name="${n}" classname="a.FooTest"/>`,
    );
    const exec: Exec = async (_c, args) => {
      write(root, RESULT_XML, `<testsuite>${cases.join("")}</testsuite>`);
      recordTask(root, args);
      return { code: 0, stdout: "", stderr: "" };
    };
    expect((await runTargets(deps(root, exec), [{ file: TEST_FILE }])).outcome).toBe("passed");
  });
});
