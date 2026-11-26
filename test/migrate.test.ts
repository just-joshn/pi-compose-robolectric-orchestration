import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { editProblem } from "../src/checks.ts";
import { addFinding, start, type StartInput } from "../src/engine.ts";
import { newRun } from "../src/state.ts";
import { commit, git, TEST_FILE, twoTests, workspace, write } from "./helpers.ts";

const SOURCE = "app/src/androidTest/java/a/FooDeviceTest.kt";

function migrating(target: string | null) {
  const root = workspace({ test: target });
  write(root, SOURCE, twoTests("second"));
  git(root, "add", "-A");
  commit(root, "source");
  const input: StartInput = { workflow: "migrate", source: SOURCE, targets: [{ file: TEST_FILE }] };
  return { root, run: start(newRun("g", null), input, root).run };
}

describe("migrate's case count", () => {
  it("does not count tests the target already had", () => {
    const { root, run } = migrating(twoTests("other"));
    rmSync(join(root, SOURCE));
    expect(editProblem(run, root)).toMatch(/source has 2 @Test cases but the targets have 0/);
  });

  it("does not count migrated cases that are ignored", () => {
    const { root, run } = migrating(null);
    write(
      root,
      TEST_FILE,
      twoTests("second").replace("  @Test\n  fun second", "  @Ignore\n  @Test\n  fun second"),
    );
    expect(editProblem(run, root)).toMatch(/source has 2 @Test cases but the targets have 1/);
  });

  it("accepts every case migrated", () => {
    const { root, run } = migrating(null);
    write(root, TEST_FILE, twoTests("second"));
    expect(editProblem(run, root)).toBeUndefined();
  });
});

describe("directory paths", () => {
  it("are refused as targets and findings with a clear message", () => {
    const root = workspace();
    mkdirSync(join(root, "app/src/test/java/a/dir"), { recursive: true });
    const input: StartInput = {
      workflow: "review",
      targets: [{ file: "app/src/test/java/a/dir" }],
    };
    expect(() => start(newRun("g", null), input, root)).toThrow(/is not a file/);
    const run = start(
      newRun("g", null),
      { workflow: "review", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    const finding = {
      file: "app/src/test/java/a/dir",
      line: 1,
      rule: "r",
      severity: "warning",
      message: "m",
    } as const;
    expect(() => addFinding(run, finding, root)).toThrow(/is not a file/);
  });

  it("are refused as subjects, since a negative control mutates a file", () => {
    const root = workspace();
    const input: StartInput = {
      workflow: "write-test",
      targets: [{ file: TEST_FILE }],
      subject: ["app/src/main/java/a"],
    };
    expect(() => start(newRun("g", null), input, root)).toThrow(
      "Subject app/src/main/java/a is not a file.",
    );
  });
});
