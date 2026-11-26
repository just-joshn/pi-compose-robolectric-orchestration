import { describe, expect, it } from "vitest";

import { type Deps, mutate, start, step } from "../src/engine.ts";
import type { Exec } from "../src/gradle.ts";
import { currentPhase, isRun, newRun } from "../src/state.ts";
import {
  BREAK,
  deps,
  junitGradle,
  passingTest,
  recordTask,
  RESULT_XML,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

const input = { workflow: "performance", targets: [{ file: TEST_FILE }] } as const;
const baseline = (root: string, d: Deps) =>
  step(start(newRun("g", null), input, root, d.dir).run, d);
const optimize = (root: string) => write(root, "app/build.gradle.kts", "// tuned\n");

/** What the build does to the test time after Gradle's listener records the real 1.5s. */
type Build = "honest" | "forges" | "deletes";

/** Like Gradle with the extension's init script and the build's own test task actions. */
function gradle(root: string, build: () => Build): Exec {
  return async (_command, args) => {
    write(root, RESULT_XML, '<testcase name="showsGreeting" classname="a.FooTest" time="1"/>');
    if (build() !== "deletes") recordTask(root, args, { ms: 1500 });
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
      recordTask(root, args, { ms: 1500 });
      return { code: 0, stdout: "", stderr: "" };
    };
    const d = deps(root, exec);
    const measured = await baseline(root, d);
    caseSeconds = 0;
    optimize(root);
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
    optimize(root);
    const after = await step(measured.run, d);
    expect(after.message).toContain("Median test time 1.50s -> 1.50s");
    expect(after.run.status).toBe("active");
  });

  it("counts a run whose record it deletes as unmeasured and not passing, never 0s", async () => {
    const root = workspace();
    let build: Build = "honest";
    const d = deps(
      root,
      gradle(root, () => build),
    );
    const measured = await baseline(root, d);
    build = "deletes";
    optimize(root);
    const after = await step(measured.run, d);
    expect(after.run.status).toBe("active");
    expect(after.run.statusReason).toMatch(/must pass/);
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
    expect(unmeasured.run.statusReason).toMatch(/must pass/);
  });
});

/** Like JUnit: a test that checks the greeting fails when it is broken. */
const checksGreeting = (body: string, main: string) =>
  main.includes("BROKEN") && body.includes("onNodeWithText") ? "failed" : "passed";

/** Like Gradle with the extension's init script, timing the nth run at `ms[n]`. */
function timed(root: string, ms: readonly number[]): Exec {
  let call = 0;
  return junitGradle(root, checksGreeting, () => ms[call++] ?? 0);
}

describe("a speedup", () => {
  it("is noise unless every run after the change beats every baseline run", async () => {
    const root = workspace();
    const d = deps(root, timed(root, [1000, 1000, 1000, 500, 500, 1000]));
    const measured = await baseline(root, d);
    optimize(root);
    const after = await step(measured.run, d);
    expect(after.message).toContain("Median test time 1.00s -> 0.50s (50.0%)");
    expect(after.run.status).toBe("active");
    expect(after.run.statusReason).toMatch(/slowest took 1.00s.*fastest baseline run took 1.00s/);
  });

  it("verifies when every run after the change beats every baseline run", async () => {
    const root = workspace();
    const d = deps(root, timed(root, [1000, 1100, 1200, 900, 600, 500]));
    const measured = await baseline(root, d);
    optimize(root);
    const faster = (await step(measured.run, d)).run;
    expect((await mutate(faster, BREAK, d)).run.status).toBe("verified");
  });
});

describe("a speedup that guts the assertions", () => {
  it("cannot verify, since the tests no longer detect a broken behavior", async () => {
    const root = workspace();
    const d = deps(root, timed(root, [1000, 1000, 1000, 500, 500, 500]));
    const measured = await baseline(root, d);
    write(root, TEST_FILE, passingTest.replace('rule.onNodeWithText("Hello")', "rule.onRoot()"));
    const faster = (await step(measured.run, d)).run;
    expect(currentPhase(faster)?.kind).toBe("mutation");
    const missed = (await mutate(faster, BREAK, d)).run;
    expect(missed.status).toBe("active");
    expect(missed.statusReason).toMatch(/did not detect the mutation/);
  });
});
