import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { editProblem, finalize, saveSnapshot } from "../src/checks.ts";
import { addFinding, mutate, start, type StartInput, step } from "../src/engine.ts";
import { isRun, newRun, type TestRun } from "../src/state.ts";
import { recoverSwap, withSwappedFiles } from "../src/swap.ts";
import { changedPaths, digest, fingerprint } from "../src/tree.ts";
import {
  begin,
  BREAK,
  commit,
  git,
  MAIN_FILE,
  passingTest,
  read,
  TEST_FILE,
  twoTests,
  workspace,
  write,
} from "./helpers.ts";

const aCase = {
  className: "a.OtherTest",
  name: "showsGreeting",
  status: "passed",
  seconds: 1,
} as const;
const aRun: TestRun = {
  id: 1,
  phase: "verify",
  purpose: "verify",
  command: "",
  exitCode: 0,
  seconds: 1,
  outcome: "passed",
  outputTail: "",
  tree: "",
  cases: [aCase],
};

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

  it("rejects a target that a symlink leads outside the workspace", () => {
    const { outer, root } = nestedWorkspace();
    symlinkSync(join(outer, "app"), join(root, "link"));
    const input: StartInput = {
      workflow: "write-test",
      targets: [{ file: "link/src/test/java/a/FooTest.kt" }],
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
    const pass: TestRun = { ...aRun, tree: digest(fingerprint(root)), cases: [aCase] };
    const done = finalize({ ...run, runs: [pass] }, root);
    expect(done.statusReason).toMatch(
      /Original tests missing or not passing: a\.FooTest\.showsGreeting/,
    );
  });
});

const journal = (dir: string, pid: number | undefined, path: string) =>
  writeFileSync(
    join(dir, "swap.json"),
    JSON.stringify({
      pid,
      files: [{ path, original: Buffer.from("original").toString("base64"), written: null }],
    }),
  );

describe("two sessions in one workspace", () => {
  it("never undoes or overlaps a swap that a live session still holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-test-state-"));
    const file = join(mkdtempSync(join(tmpdir(), "compose-test-swap-")), "A.kt");
    writeFileSync(file, "mutated by the other session");
    journal(dir, process.ppid, file);
    expect(recoverSwap(dir)).toEqual({ restored: [], conflicts: [] });
    const swap = withSwappedFiles(dir, [{ path: file, content: Buffer.from("x") }], async () => 1);
    await expect(swap).rejects.toThrow(/Another compose-test run/);
    expect(readFileSync(file, "utf8")).toBe("mutated by the other session");
  });

  it("leaves this process's own live swap alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-test-state-"));
    const file = join(mkdtempSync(join(tmpdir(), "compose-test-swap-")), "A.kt");
    writeFileSync(file, "original");
    const swap = [{ path: file, content: Buffer.from("mutant") }];
    const during = await withSwappedFiles(dir, swap, async () => {
      recoverSwap(dir);
      return readFileSync(file, "utf8");
    });
    expect(during.value).toBe("mutant");
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("recovers a swap whose session has exited", () => {
    const dir = mkdtempSync(join(tmpdir(), "compose-test-state-"));
    const file = join(mkdtempSync(join(tmpdir(), "compose-test-swap-")), "A.kt");
    journal(dir, spawnSync("true").pid, file);
    expect(recoverSwap(dir).conflicts).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("original");
  });
});

describe("migrate case count", () => {
  it("counts a target named twice once", () => {
    const root = workspace({ test: null });
    const source = "app/src/androidTest/java/a/FooDeviceTest.kt";
    write(root, source, twoTests("second"));
    git(root, "add", "-A");
    commit(root, "source");
    const input: StartInput = {
      workflow: "migrate",
      source,
      targets: [{ file: TEST_FILE }, { file: TEST_FILE }],
    };
    const run = start(newRun("g", null), input, root).run;
    write(root, TEST_FILE, passingTest);
    expect(editProblem(run, root)).toMatch(/source has 2 @Test cases but the targets have 1/);
  });
});

describe("restored test cases", () => {
  it("rejects a case whose message is not text", () => {
    const run = { ...newRun("g", null), runs: [{ ...aRun, cases: [{ ...aCase, message: 7 }] }] };
    expect(isRun(run)).toBe(false);
  });
});

describe("moving an existing @Ignore", () => {
  it("counts as ignoring the test it now sits on", () => {
    const ignoredOther = twoTests("other").replace(
      "  @Test\n  fun other",
      "  @Ignore\n  @Test\n  fun other",
    );
    const root = workspace({ test: ignoredOther });
    const run = start(
      newRun("g", null),
      { workflow: "write-test", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    const moved = twoTests("other").replace(
      "  @Test\n  fun showsGreeting",
      "  @Ignore\n  @Test\n  fun showsGreeting",
    );
    write(root, TEST_FILE, moved);
    expect(editProblem(run, root)).toMatch(/gained @Ignore on showsGreeting/);
  });
});

const nested = (second: string) =>
  `class FooTest {\n  class X {\n    @Test fun same() { assert(true) }\n  }\n  class Y {\n${second}  }\n}\n`;

describe("round 8 gaps", () => {
  it("rejects a Java migration source the Kotlin scanner cannot count", () => {
    const root = workspace({ test: null });
    const source = "app/src/androidTest/java/a/FooDeviceTest.java";
    write(root, source, "class FooDeviceTest { @Test public void a() {} }");
    const input: StartInput = { workflow: "migrate", source, targets: [{ file: TEST_FILE }] };
    expect(() => start(newRun("g", null), input, root)).toThrow(/androidTest \.kt file/);
  });

  it("notices one of two same-named tests in nested classes disappearing", () => {
    const root = workspace({ test: nested("    @Test fun same() { assert(true) }\n") });
    const run = start(
      newRun("g", null),
      { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    write(root, TEST_FILE, nested(""));
    expect(editProblem(run, root)).toMatch(/lost tests: same/);
  });

  it("refuses a review finding outside the workspace", () => {
    const { root } = nestedWorkspace();
    const run = start(
      newRun("g", null),
      { workflow: "review", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    const finding = {
      file: `../${MAIN_FILE}`,
      line: 1,
      rule: "r",
      severity: "warning",
      message: "m",
    } as const;
    expect(() => addFinding(run, finding, root)).toThrow(/outside the workspace/);
  });
});

describe("two sessions starting together", () => {
  it("never share a baseline snapshot file", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1);
    const root = workspace();
    const dir = mkdtempSync(join(tmpdir(), "compose-test-state-"));
    const baseline = fingerprint(root);
    expect(saveSnapshot(root, baseline, dir)).not.toBe(saveSnapshot(root, baseline, dir));
    now.mockRestore();
  });
});

describe("round 10 gaps", () => {
  it("fingerprints changes in a directory whose name starts with two dots", () => {
    const root = workspace();
    write(root, "..module/src/main/A.kt", "one");
    git(root, "add", "-A");
    commit(root, "dots");
    const before = fingerprint(root);
    write(root, "..module/src/main/A.kt", "two");
    expect(changedPaths(root, before, fingerprint(root))).toEqual(["..module/src/main/A.kt"]);
  });

  it("needs a passing case for every same-named baseline test", () => {
    const root = workspace();
    const run = { ...newRun("g", null), workflow: "fix-flaky" as const, status: "active" as const };
    const skipped = { ...aCase, className: "a.OtherTest$Two", status: "skipped" } as const;
    const pass: TestRun = { ...aRun, tree: digest(fingerprint(root)), cases: [aCase, skipped] };
    const tests = ["a.OtherTest.showsGreeting", "a.OtherTest.showsGreeting"];
    const done = finalize({ ...run, baselineTests: tests, runs: [pass] }, root);
    expect(done.statusReason).toMatch(/Original tests missing or not passing/);
  });
});

describe("baseline of a file with several test classes", () => {
  it("names each test with its own class", () => {
    const both =
      "package a\nclass First {\n  @Test fun good() {}\n}\nclass Second {\n  @Test fun broken() {}\n}\n";
    const root = workspace({ test: both });
    const run = start(
      newRun("g", null),
      { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    expect(run.baselineTests).toEqual(["a.First.good", "a.Second.broken"]);
  });
});

const pair = (second: string) =>
  `class FooTest {\n  class A {\n    @Ignore @Test fun same() { assert(true) }\n  }\n  class B {\n    ${second}@Test fun same() { assert(true) }\n  }\n}\n`;

describe("round 12 gaps", () => {
  it("notices a new @Ignore on a test that shares its name with an ignored one", () => {
    const root = workspace({ test: pair("") });
    const run = start(
      newRun("g", null),
      { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] },
      root,
    ).run;
    write(root, TEST_FILE, pair("@Ignore "));
    expect(editProblem(run, root)).toMatch(/gained @Ignore on same/);
  });

  it("reads committed non-ASCII paths as git stores them", () => {
    const root = workspace();
    const path = "app/src/main/java/a/Café.kt";
    write(root, path, "one");
    git(root, "add", "-A");
    commit(root, "cafe");
    const before = fingerprint(root);
    write(root, path, "two");
    commit(root, "cafe 2");
    expect(changedPaths(root, before, fingerprint(root))).toEqual([path]);
  });
});

describe("source outside migrate", () => {
  it("is refused, so it cannot exempt a test file from the deletion check", () => {
    const root = workspace();
    const input: StartInput = {
      workflow: "write-test",
      source: TEST_FILE,
      targets: [{ file: TEST_FILE }],
    };
    expect(() => start(newRun("g", null), input, root)).toThrow(/source is only for migrate/);
  });
});

describe("committing during a run", () => {
  it("does not count committing unchanged start content as a change", () => {
    const root = workspace();
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hi"\n');
    const before = fingerprint(root);
    commit(root, "commit the start content");
    expect(changedPaths(root, before, fingerprint(root))).toEqual([]);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hey"\n');
    commit(root, "a real change");
    expect(changedPaths(root, before, fingerprint(root))).toEqual([MAIN_FILE]);
  });
});

describe("two method targets in one file", () => {
  it("inventory the file's tests once", () => {
    const root = workspace({ test: twoTests("second") });
    const targets = [
      { file: TEST_FILE, method: "second" },
      { file: TEST_FILE, method: "showsGreeting" },
    ];
    const run = start(newRun("g", null), { workflow: "fix-flaky", targets }, root).run;
    expect(run.baselineTests).toEqual(["a.FooTest.second", "a.FooTest.showsGreeting"]);
  });
});

describe("round 18 gaps", () => {
  it("fingerprints a build package inside a source set, never a module's build output", () => {
    const root = workspace({ git: false });
    const pkg = "app/src/main/java/a/build/Thing.kt";
    write(root, pkg, "one");
    write(root, "app/build/out.txt", "output");
    const before = fingerprint(root);
    expect(Object.keys(before.files)).not.toContain("app/build/out.txt");
    write(root, pkg, "two");
    expect(changedPaths(root, before, fingerprint(root))).toEqual([pkg]);
  });
});
