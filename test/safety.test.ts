import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { finalize } from "../src/checks.ts";
import { mutate, start, type StartInput, step } from "../src/engine.ts";
import { newRun, type TestRun } from "../src/state.ts";
import { digest, fingerprint } from "../src/tree.ts";
import {
  begin,
  BREAK,
  commit,
  git,
  MAIN_FILE,
  passingTest,
  read,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

describe("a corrupt baseline snapshot", () => {
  it("stops the regression check with the file named", async () => {
    const root = workspace();
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    const { run, d } = begin(root, { workflow: "fix-failing" });
    const fixing = (await step(run, d)).run;
    writeFileSync(fixing.snapshot ?? "", "[1]");
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    await expect(step(fixing, d)).rejects.toThrow(/is not a baseline snapshot/);
  });
});

function nestedWorkspace() {
  const outer = workspace();
  const root = join(outer, "inner");
  write(root, "settings.gradle.kts", 'include(":app")\n');
  write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
  write(root, TEST_FILE, passingTest);
  return { outer, root, escape: `../${MAIN_FILE}` };
}

describe("workspace confinement", () => {
  it("rejects a subject outside the workspace", () => {
    const { root, escape } = nestedWorkspace();
    const input: StartInput = {
      workflow: "write-test",
      targets: [{ file: TEST_FILE }],
      subject: [escape],
    };
    expect(() => start(newRun("g", null), input, root)).toThrow(/outside the workspace/);
  });

  it("never mutates a file outside the workspace", async () => {
    const { outer, root, escape } = nestedWorkspace();
    const { run, d } = begin(root);
    const verified = (await step(run, d)).run;
    await expect(mutate(verified, { ...BREAK, file: escape }, d)).rejects.toThrow(
      /outside the workspace/,
    );
    expect(read(outer, MAIN_FILE)).toContain('"Hello"');
  });
});

describe("test preservation", () => {
  it("matches preserved tests by class, not just method name", () => {
    const root = workspace();
    const other = "app/src/test/java/a/OtherTest.kt";
    write(root, other, passingTest.replace("class FooTest", "class OtherTest"));
    git(root, "add", "-A");
    commit(root, "other");
    const input: StartInput = {
      workflow: "fix-flaky",
      targets: [{ file: TEST_FILE }, { file: other }],
    };
    const run = start(newRun("g", null), input, root).run;
    const pass: TestRun = {
      id: 1,
      phase: "verify",
      purpose: "verify",
      command: "",
      exitCode: 0,
      seconds: 1,
      outcome: "passed",
      outputTail: "",
      tree: digest(fingerprint(root)),
      cases: [{ className: "a.OtherTest", name: "showsGreeting", status: "passed", seconds: 1 }],
    };
    const done = finalize({ ...run, runs: [pass] }, root);
    expect(done.statusReason).toMatch(
      /Original tests missing or not passing: a\.FooTest\.showsGreeting/,
    );
  });
});
