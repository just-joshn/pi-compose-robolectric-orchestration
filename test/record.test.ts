import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type Exec, runTargets } from "../src/gradle.ts";
import {
  deps,
  recordFile,
  recordTask,
  RESULT_XML,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

const passing = '<testcase name="showsGreeting" classname="a.FooTest"/>';
const targets = [{ file: TEST_FILE }];
const ok = { code: 0, stdout: "", stderr: "" };
const failed = async () => ({ code: 1, stdout: "", stderr: "BUILD FAILED" });

describe("the Test task record the init script keeps", () => {
  it("leads to reports in a relocated build directory", async () => {
    const root = workspace();
    const relocated = "build/modules/app/test-results/testDebugUnitTest";
    const exec: Exec = async (_c, args) => {
      write(root, `${relocated}/TEST-a.FooTest.xml`, passing);
      recordTask(root, args, { xml: join(root, relocated), ms: 1500 });
      return ok;
    };
    const ran = await runTargets(deps(root, exec), targets);
    expect(ran.outcome).toBe("passed");
    expect(ran.cases.map((c) => c.name)).toEqual(["showsGreeting"]);
    expect(ran.testSeconds).toBe(1.5);
  });

  it("gives the module's own task time, not a child project's or another task's", async () => {
    const root = workspace();
    const exec: Exec = async (_c, args) => {
      write(root, RESULT_XML, passing);
      appendFileSync(recordFile(args), '{"task":"testDebugUnitTest","proj\n');
      recordTask(root, args, { module: "app/sub", ms: 9000 });
      recordTask(root, args, { task: "testReleaseUnitTest", ms: 8000 });
      recordTask(root, args, { ms: 1500 });
      return ok;
    };
    expect((await runTargets(deps(root, exec), targets)).testSeconds).toBe(1.5);
  });

  it("reads no earlier report when the module's Test task did not run", async () => {
    const root = workspace();
    write(root, RESULT_XML, passing);
    const ran = await runTargets(deps(root, failed), targets);
    expect(ran.outcome).toBe("build-error");
    expect(ran.cases).toEqual([]);
    expect(ran.testSeconds).toBeNull();
  });
});
