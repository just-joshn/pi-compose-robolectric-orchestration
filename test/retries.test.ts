import { describe, expect, it } from "vitest";

import { type Exec, runTargets } from "../src/gradle.ts";
import { deps, recordTask, RESULT_XML, TEST_FILE, workspace, write } from "./helpers.ts";

const retried = (root: string, attempt: string): Exec => {
  return async (_command, args) => {
    const failed = `<${attempt} message="expected:&lt;false&gt; but was:&lt;true&gt;" type="java.lang.AssertionError"><stackTrace>trace</stackTrace></${attempt}>`;
    const testCase = `<testcase name="showsGreeting" classname="a.FooTest" time="0.001">${failed}</testcase>`;
    write(root, RESULT_XML, `<testsuite name="a.FooTest" tests="2">${testCase}</testsuite>`);
    recordTask(root, args);
    return { code: 0, stdout: "", stderr: "" };
  };
};

describe("a test that failed an attempt Gradle retried", () => {
  it.each(["flakyFailure", "flakyError", "rerunFailure", "rerunError"])(
    "fails the run when the XML records the attempt as %s",
    async (attempt) => {
      const root = workspace();
      const ran = await runTargets(deps(root, retried(root, attempt)), [{ file: TEST_FILE }]);
      expect(ran.outcome).toBe("failed");
      expect(ran.cases).toEqual([
        {
          className: "a.FooTest",
          name: "showsGreeting",
          status: "failed",
          seconds: 0.001,
          message: "expected:<false> but was:<true>",
        },
      ]);
    },
  );
});
