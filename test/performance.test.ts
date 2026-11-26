import { describe, expect, it } from "vitest";

import { start, step } from "../src/engine.ts";
import type { Exec } from "../src/gradle.ts";
import { newRun } from "../src/state.ts";
import { deps, RESULT_XML, TEST_FILE, TIMING, workspace, write } from "./helpers.ts";

describe("measuring test time", () => {
  it("counts class-level setup, so moving work out of the test cases is no speedup", async () => {
    const root = workspace();
    let caseSeconds = 1;
    /** Like Gradle with the extension's init script: XML case times leave out @BeforeClass. */
    const exec: Exec = async () => {
      const testCase = `<testcase name="showsGreeting" classname="a.FooTest" time="${caseSeconds}"/>`;
      write(root, RESULT_XML, `<testsuite time="${caseSeconds}">${testCase}</testsuite>`);
      write(root, TIMING, "1500");
      return { code: 0, stdout: "", stderr: "" };
    };
    const d = deps(root, exec);
    const input = { workflow: "performance", targets: [{ file: TEST_FILE }] } as const;
    const baseline = await step(start(newRun("g", null), input, root, d.dir).run, d);
    caseSeconds = 0;
    const after = await step(baseline.run, d);
    expect(after.run.status).toBe("active");
    expect(after.message).toContain("Median test time 1.50s -> 1.50s");
  });
});
