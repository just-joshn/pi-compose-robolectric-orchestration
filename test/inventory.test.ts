import { describe, expect, it } from "vitest";

import { finalize } from "../src/checks.ts";
import { start } from "../src/engine.ts";
import { testClasses } from "../src/gradle.ts";
import { newRun, type TestRun } from "../src/state.ts";
import { digest, fingerprint } from "../src/tree.ts";
import { TEST_FILE, workspace } from "./helpers.ts";

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
      outputTail: "",
      tree: digest(fingerprint(root)),
    };
    expect(finalize({ ...run, runs: [measured] }, root).status).toBe("verified");
  });
});
