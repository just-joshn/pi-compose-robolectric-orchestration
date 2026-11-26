import { describe, expect, it } from "vitest";

import { finalize } from "../src/checks.ts";
import { type Deps, mutate, start, step } from "../src/engine.ts";
import type { Exec } from "../src/gradle.ts";
import { currentPhase, newRun, type Run, type TestRun } from "../src/state.ts";
import { digest, fingerprint } from "../src/tree.ts";
import type { WorkflowId } from "../src/workflows.ts";
import {
  begin,
  behavior,
  BREAK,
  commit,
  deps,
  git,
  MAIN_FILE,
  read,
  recordTask,
  RESULT_XML,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

const parameterized = (params: string, flaky: boolean) => `package a
@RunWith(Parameterized::class)
class FooTest(private val suffix: String) {
  companion object {
    @JvmStatic @Parameterized.Parameters fun data() = listOf(${params})
  }
  @Test fun greets() {
    val flake = ${flaky ? 'suffix == "?" && Math.random() < 0.5' : "false"}
    assertEquals("Hello$suffix", if (flake) "nope" else greeting() + suffix)
  }
}
`;

function gradle(root: string): Exec {
  let call = 0;
  return async (_command, args) => {
    call++;
    const source = read(root, TEST_FILE);
    const params = /listOf\(([^)]*)\)/.exec(source)?.[1]?.split(",") ?? [];
    const broken = read(root, MAIN_FILE).includes("BROKEN");
    const fails = (p: string) =>
      broken || (p.includes("?") && source.includes("Math.random") && call % 2 === 1);
    const cases = params.map((p, i) => {
      const failure = fails(p) ? '<failure message="x"/>' : "";
      return `<testcase name="greets[${i}]" classname="a.FooTest">${failure}</testcase>`;
    });
    write(root, RESULT_XML, `<testsuite>${cases.join("")}</testsuite>`);
    recordTask(root, args, { ms: params.length * 500 });
    const ok = params.every((p) => !fails(p));
    return { code: ok ? 0 : 1, stdout: "", stderr: "" };
  };
}

async function drive(workflow: WorkflowId, source: string, edit: (s: string) => string) {
  const root = workspace({ test: source });
  const d: Deps = deps(root, gradle(root));
  let run: Run = start(newRun("g", null), { workflow, targets: [{ file: TEST_FILE }] }, root).run;
  run = (await step(run, d)).run;
  write(root, TEST_FILE, edit(source));
  run = (await step(run, d)).run;
  const kind = currentPhase(run)?.kind;
  if (kind === "mutation" || kind === "regression") run = (await mutate(run, BREAK, d)).run;
  return run;
}

const dropQuestion = (s: string) => s.replace(', "?")', ")");

it("does not verify when an inherited passing test becomes skipped", async () => {
  const root = workspace({
    test: `package a\nimport org.junit.Test\nclass FooTest : BaseTest() {\n  @Test fun own() { assert(true) }\n}\n`,
  });
  const base = "app/src/test/java/a/BaseTest.kt";
  const source = `package a\nimport org.junit.Test\nimport org.junit.Assume.assumeTrue\nopen class BaseTest {\n  @Test fun inherited() { assert(true) }\n}\n`;
  write(root, base, source);
  git(root, "add", "-A");
  commit(root, "base test");
  const d = deps(root, async (_command, args) => {
    const skipped = read(root, base).includes("assumeTrue(false)");
    const broken = read(root, MAIN_FILE).includes("BROKEN");
    write(
      root,
      RESULT_XML,
      `<testsuite><testcase classname="a.FooTest" name="inherited">${skipped ? "<skipped/>" : ""}</testcase><testcase classname="a.FooTest" name="own">${broken ? "<failure/>" : ""}</testcase></testsuite>`,
    );
    recordTask(root, args);
    return { code: broken ? 1 : 0, stdout: "", stderr: "" };
  });
  const run = start(
    newRun("fix flaky", null),
    { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] },
    root,
    d.dir,
  ).run;
  const baseline = await step(run, d);
  write(root, base, source.replace("assert(true)", "assumeTrue(false); assert(true)"));
  const after = await step(baseline.run, d);
  const done = await mutate(after.run, BREAK, d);

  expect(baseline.run.runs[0]?.cases.find((c) => c.name === "inherited")?.status).toBe("passed");
  expect(after.run.runs.at(-1)?.cases.find((c) => c.name === "inherited")?.status).toBe("skipped");
  expect(done.run.status).not.toBe("verified");
});

describe("a parameterized case dropped during a test-preserving workflow", () => {
  it.each([
    ["fix-flaky", parameterized('"", "!", "?"', true)],
    ["fix-failing", parameterized('"", "!", "?"', true)],
    ["performance", parameterized('"", "!", "?"', false)],
  ] as const)("keeps %s from verifying", async (workflow, source) => {
    const run = await drive(workflow, source, dropQuestion);
    expect(run.status).not.toBe("verified");
    expect(run.statusReason).toContain(
      "Original tests missing or not passing: a.FooTest.greets[2].",
    );
  });

  it("does not stop a real fix of the flaky case", async () => {
    const flaky = parameterized('"", "!", "?"', true);
    const run = await drive("fix-flaky", flaky, () => parameterized('"", "!", "?"', false));
    expect(run.status).toBe("verified");
  });
});

describe("fix-flaky's run before the fix", () => {
  it("runs again after a crash, since the crash may be the flakiness", async () => {
    const { run, d } = begin(workspace(), { workflow: "fix-flaky" }, (main, _t, call) =>
      call === 1 ? "build-error" : behavior(main),
    );
    const crashed = await step(run, d);
    expect(currentPhase(crashed.run)?.id).toBe("baseline");
    expect(crashed.message).toMatch(/did not run before any change \(build-error\)/);
    expect(currentPhase((await step(crashed.run, d)).run)?.id).toBe("fix");
  });

  it("blocks after two runs that execute nothing, since the cases stay unknown", async () => {
    const { run, d } = begin(workspace(), { workflow: "fix-flaky" }, () => "build-error");
    const once = (await step(run, d)).run;
    expect(once.status).toBe("active");
    const blocked = (await step(once, d)).run;
    expect(blocked.status).toBe("blocked");
    expect(blocked.statusReason).toMatch(/runs #1, #2 could not execute tests/);
  });

  it("takes the cases from a run that finished, not one a crash cut short", async () => {
    const root = workspace({ test: parameterized('"", "!", "?"', true) });
    const flaky = gradle(root);
    let calls = 0;
    const crashOnce: Exec = async (c, a, o) => {
      const ran = await flaky(c, a, o);
      if (++calls > 1) return ran;
      write(root, RESULT_XML, read(root, RESULT_XML).replace(/<testcase name="greets\[2\]".*/, ""));
      return { ...ran, code: 1 };
    };
    const d = deps(root, crashOnce);
    const input = { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] } as const;
    let run = start(newRun("g", null), input, root).run;
    run = (await step((await step(run, d)).run, d)).run;
    write(root, TEST_FILE, dropQuestion(parameterized('"", "!", "?"', false)));
    run = (await mutate((await step(run, d)).run, BREAK, d)).run;
    expect(run.statusReason).toContain(
      "Original tests missing or not passing: a.FooTest.greets[2].",
    );
  });
});

describe("a class-level failure that a fix removes", () => {
  it("is not a missing test, since it names no test function", () => {
    const root = workspace();
    const input = { workflow: "fix-failing", targets: [{ file: TEST_FILE }] } as const;
    const run = start(newRun("g", null), input, root).run;
    const tree = digest(fingerprint(root));
    const ran = (id: number, purpose: "reproduce" | "verify", name: string, ok: boolean) =>
      ({
        id,
        phase: purpose,
        purpose,
        command: "",
        exitCode: ok ? 0 : 1,
        outcome: ok ? "passed" : "failed",
        cases: [{ className: "a.FooTest", name, status: ok ? "passed" : "failed", seconds: 1 }],
        seconds: 1,
        testSeconds: 1,
        outputTail: "",
        tree,
      }) satisfies TestRun;
    const runs = [
      ran(1, "reproduce", "classMethod", false),
      ran(2, "verify", "showsGreeting", true),
    ];
    const mutations = [{ ...BREAK, runId: 3, tree, detected: true }];
    expect(finalize({ ...run, runs, mutations }, root).status).toBe("verified");
  });
});
const enclosed = (first: string, second: string) => `package a
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.experimental.runners.Enclosed

@RunWith(Enclosed::class)
class FooTest {
  class First {
    ${first}@Test fun works() { assert(true) }
  }
  class Second {
    ${second}@Test fun works() { assert(true) }
  }
}
`;

const nestedRun = (id: number, tree: string, first: "passed" | "skipped"): TestRun => ({
  id,
  phase: "test",
  purpose: id === 1 ? "inventory" : "stress",
  command: "",
  exitCode: 0,
  outcome: "passed",
  cases: [
    { className: "a.FooTest$First", name: "works", status: first, seconds: 1 },
    {
      className: "a.FooTest$Second",
      name: "works",
      status: first === "passed" ? "skipped" : "passed",
      seconds: 1,
    },
  ],
  seconds: 1,
  testSeconds: 1,
  outputTail: "",
  tree,
});

it("rejects moving @Ignore from one nested test to another with the same method name", () => {
  const root = workspace({ test: enclosed("", "@Ignore ") });
  const run = start(
    newRun("g", null),
    {
      workflow: "fix-flaky",
      targets: [{ file: TEST_FILE }],
    },
    root,
  ).run;
  const before = digest(fingerprint(root));
  write(root, TEST_FILE, enclosed("@Ignore ", ""));
  const after = digest(fingerprint(root));
  const done = finalize(
    {
      ...run,
      runs: [nestedRun(1, before, "passed"), nestedRun(2, after, "skipped")],
      mutations: [{ ...BREAK, runId: 3, tree: after, detected: true }],
      phaseIndex: 4,
    },
    root,
  );
  expect(done.status).not.toBe("verified");
});

it("tracks parameterized cases in deeply nested classes separately", () => {
  const root = workspace({
    test: `package a
class FooTest {
  class First {
    class Deep {
      @Test fun works() {}
    }
  }
  class Second {
    @Test fun works() {}
  }
}
`,
  });
  const run = start(
    newRun("g", null),
    { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] },
    root,
  ).run;
  const tree = digest(fingerprint(root));
  const ran = (id: number, secondCase: "passed" | "skipped"): TestRun => ({
    id,
    phase: "test",
    purpose: id === 1 ? "inventory" : "stress",
    command: "",
    exitCode: 0,
    outcome: "passed",
    cases: [
      { className: "a.FooTest$First$Deep", name: "works[0]", status: "passed", seconds: 1 },
      { className: "a.FooTest$First$Deep", name: "works[1]", status: secondCase, seconds: 1 },
      { className: "a.FooTest$Second", name: "works[0]", status: "passed", seconds: 1 },
    ],
    seconds: 1,
    testSeconds: 1,
    outputTail: "",
    tree,
  });
  const done = finalize(
    {
      ...run,
      runs: [ran(1, "passed"), ran(2, "skipped")],
      mutations: [{ ...BREAK, runId: 3, tree, detected: true }],
      phaseIndex: 4,
    },
    root,
  );
  expect(run.baselineTests).toEqual(["a.FooTest$First$Deep.works", "a.FooTest$Second.works"]);
  expect(done.statusReason).toContain("a.FooTest$First$Deep.works[1]");
});

it("accepts a preserved passing nested test when a same-named sibling is skipped by an assumption", () => {
  const source = enclosed("", "").replace(
    "class Second {\n    @Test fun works() { assert(true) }",
    "class Second {\n    @Test fun works() { org.junit.Assume.assumeTrue(false); assert(true) }",
  );
  const root = workspace({ test: source });
  const run = start(
    newRun("g", null),
    {
      workflow: "fix-flaky",
      targets: [{ file: TEST_FILE }],
    },
    root,
  ).run;
  const tree = digest(fingerprint(root));
  const ran = (id: number): TestRun => ({
    id,
    phase: "test",
    purpose: id === 1 ? "inventory" : "stress",
    command: "",
    exitCode: 0,
    outcome: "passed",
    cases: [
      { className: "a.FooTest$First", name: "works", status: "passed", seconds: 1 },
      { className: "a.FooTest$Second", name: "works", status: "skipped", seconds: 0 },
    ],
    seconds: 1,
    testSeconds: 1,
    outputTail: "",
    tree,
  });
  const done = finalize(
    {
      ...run,
      runs: [ran(1), ran(2)],
      mutations: [{ ...BREAK, runId: 3, tree, detected: true }],
      phaseIndex: 4,
    },
    root,
  );
  expect(done.statusReason).toBe("All checks passed.");
});

it.each([
  ["backtick-named nested class", "class `Logged in`", "Logged in"],
  [
    "nested class with a lambda in its superclass argument",
    "class LoggedIn : Base({ true })",
    "LoggedIn",
  ],
])("accepts a passing %s", (_description, declaration, name) => {
  const root = workspace({
    test: `package a
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.experimental.runners.Enclosed
open class Base(check: () -> Boolean)
@RunWith(Enclosed::class)
class FooTest {
  ${declaration} {
    @Test fun works() { assert(true) }
  }
}
`,
  });
  const run = start(
    newRun("fix flaky", null),
    { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] },
    root,
  ).run;
  const tree = digest(fingerprint(root));
  const ran = (id: number): TestRun => ({
    id,
    phase: "test",
    purpose: id === 1 ? "inventory" : "stress",
    command: "",
    exitCode: 0,
    outcome: "passed",
    cases: [{ className: `a.FooTest$${name}`, name: "works", status: "passed", seconds: 1 }],
    seconds: 1,
    testSeconds: 1,
    outputTail: "",
    tree,
  });
  const done = finalize(
    {
      ...run,
      runs: [ran(1), ran(2)],
      mutations: [{ ...BREAK, runId: 3, tree, detected: true }],
      phaseIndex: 4,
    },
    root,
  );
  expect(done.statusReason).toBe("All checks passed.");
});

it("does not verify a migration with a skipped backtick-named nested test", async () => {
  const root = workspace({ test: null });
  const source = "app/src/androidTest/java/a/DeviceTest.kt";
  write(
    root,
    source,
    `package a
class DeviceTest {
  @Test fun works() { assert(true) }
  @Test fun other() { assert(true) }
}
`,
  );
  git(root, "add", "-A");
  commit(root, "device tests");
  const d = deps(root, async (_command, args) => {
    const broken = read(root, MAIN_FILE).includes("BROKEN");
    write(
      root,
      "app/build/test-results/testDebugUnitTest/TEST-a.FooTest$Logged in.xml",
      `<testsuite><testcase classname="a.FooTest$Logged in" name="works"><skipped/></testcase></testsuite>`,
    );
    write(
      root,
      "app/build/test-results/testDebugUnitTest/TEST-a.FooTest$Other.xml",
      `<testsuite><testcase classname="a.FooTest$Other" name="other">${broken ? "<failure/>" : ""}</testcase></testsuite>`,
    );
    recordTask(root, args);
    return { code: broken ? 1 : 0, stdout: "", stderr: "" };
  });
  const run = start(
    newRun("migrate", null),
    {
      workflow: "migrate",
      source,
      targets: [{ file: TEST_FILE }],
    },
    root,
  ).run;
  write(
    root,
    TEST_FILE,
    `package a
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.experimental.runners.Enclosed
@RunWith(Enclosed::class)
class FooTest {
  class \`Logged in\` {
    @Test fun works() { org.junit.Assume.assumeTrue(false); assert(true) }
  }
  class Other {
    @Test fun other() { assert(true) }
  }
}
`,
  );
  const verified = await step(run, d);
  const done = await mutate(verified.run, BREAK, d);
  expect(done.run.status).not.toBe("verified");
  expect(done.run.statusReason).toContain("Migrated cases were skipped");
});
