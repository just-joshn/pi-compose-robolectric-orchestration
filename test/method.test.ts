import { describe, expect, it } from "vitest";

import { start, type StartInput, step, WorkflowError } from "../src/engine.ts";
import { currentPhase, newRun } from "../src/state.ts";
import { begin, MAIN_FILE, passingTest, TEST_FILE, twoTests, workspace, write } from "./helpers.ts";

const backticked = twoTests("second").replace("fun showsGreeting()", "fun `shows greeting`()");

describe("a target method", () => {
  it("named with its backticks reproduces the failure", async () => {
    const root = workspace({ test: backticked });
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    const targets = [{ file: TEST_FILE, method: "`shows greeting`" }];
    const { run, d } = begin(root, { workflow: "fix-failing", targets });
    expect(run.targets).toEqual([{ file: TEST_FILE, method: "shows greeting" }]);
    expect(currentPhase((await step(run, d)).run)?.id).toBe("fix");
  });

  it.each(["fix-failing", "refactor", "write-test"] as const)(
    "that is not a @Test function of the file is refused by %s, listing its tests",
    (workflow) => {
      const root = workspace({ test: backticked });
      const input = { workflow, targets: [{ file: TEST_FILE, method: "FooTest.shows greeting" }] };
      expect(() => start(newRun("g", null), input, root)).toThrow(WorkflowError);
      expect(() => start(newRun("g", null), input, root)).toThrow(
        `Method FooTest.shows greeting is not a @Test function in ${TEST_FILE}. Its tests: second, shows greeting.`,
      );
    },
  );

  it("in a file with no tests says so", () => {
    const root = workspace({ test: passingTest.replace("@Test", "") });
    const input: StartInput = {
      workflow: "refactor",
      targets: [{ file: TEST_FILE, method: "showsGreeting" }],
    };
    expect(() => start(newRun("g", null), input, root)).toThrow(/It has no @Test functions/);
  });

  it("in a target the workflow creates is not checked", () => {
    const root = workspace({ test: null });
    const input: StartInput = {
      workflow: "write-test",
      targets: [{ file: TEST_FILE, method: "`greets`" }],
    };
    const run = start(newRun("g", null), input, root).run;
    expect(run.targets).toEqual([{ file: TEST_FILE, method: "greets" }]);
  });
});
