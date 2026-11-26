import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { type Deps, start, step } from "../src/engine.ts";
import type { Exec } from "../src/gradle.ts";
import { isRun, newRun } from "../src/state.ts";
import { deps, RESULT_XML, TEST_FILE, timingFile, workspace, write } from "./helpers.ts";

const input = { workflow: "performance", targets: [{ file: TEST_FILE }] } as const;
const baseline = (root: string, d: Deps) =>
  step(start(newRun("g", null), input, root, d.dir).run, d);

/** What the build does to the test time after Gradle's listener records the real 1.5s. */
type Build = "honest" | "forges" | "deletes";

/** Like Gradle with the extension's init script and the build's own test task actions. */
function gradle(root: string, build: () => Build): Exec {
  return async (_command, args) => {
    write(root, RESULT_XML, '<testcase name="showsGreeting" classname="a.FooTest" time="1"/>');
    const timing = timingFile(args);
    if (timing && build() !== "deletes") writeFileSync(timing, "1500");
    if (build() === "forges")
      write(root, "app/build/test-results/testDebugUnitTest/compose-test-time.txt", "1");
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("measuring test time", () => {
  it("counts class-level setup, so moving work out of the test cases is no speedup", async () => {
    const root = workspace();
    let caseSeconds = 1;
    /** Like Gradle with the extension's init script: XML case times leave out @BeforeClass. */
    const exec: Exec = async (_command, args) => {
      const testCase = `<testcase name="showsGreeting" classname="a.FooTest" time="${caseSeconds}"/>`;
      write(root, RESULT_XML, `<testsuite time="${caseSeconds}">${testCase}</testsuite>`);
      writeFileSync(timingFile(args) ?? "", "1500");
      return { code: 0, stdout: "", stderr: "" };
    };
    const d = deps(root, exec);
    const measured = await baseline(root, d);
    caseSeconds = 0;
    const after = await step(measured.run, d);
    expect(after.run.status).toBe("active");
    expect(after.message).toContain("Median test time 1.50s -> 1.50s");
  });
});

describe("a build script that tampers with the test time", () => {
  it("cannot forge a speedup by writing a time into the test results", async () => {
    const root = workspace();
    let build: Build = "honest";
    const d = deps(
      root,
      gradle(root, () => build),
    );
    const measured = await baseline(root, d);
    build = "forges";
    const after = await step(measured.run, d);
    expect(after.message).toContain("Median test time 1.50s -> 1.50s");
    expect(after.run.status).toBe("active");
  });

  it("leaves the run unmeasured, not 0s, when it deletes the time", async () => {
    const root = workspace();
    let build: Build = "honest";
    const d = deps(
      root,
      gradle(root, () => build),
    );
    const measured = await baseline(root, d);
    build = "deletes";
    const after = await step(measured.run, d);
    expect(after.run.status).toBe("active");
    expect(after.run.statusReason).toMatch(/no test time/);
    expect(after.message).not.toContain("Median");
    expect(isRun(JSON.parse(JSON.stringify(after.run)))).toBe(true);
    const other = workspace();
    const unmeasured = await baseline(
      other,
      deps(
        other,
        gradle(other, () => "deletes"),
      ),
    );
    expect(unmeasured.run.status).toBe("blocked");
    expect(unmeasured.run.statusReason).toMatch(/no test time/);
  });
});
