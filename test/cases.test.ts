import { writeFileSync } from "node:fs";

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
  deps,
  MAIN_FILE,
  read,
  RESULT_XML,
  TEST_FILE,
  timingFile,
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

/**
 * Like Gradle running a JUnit Parameterized class: one case `greets[i]` per data() element, 0.5s
 * each. The "?" case of the flaky version fails on odd calls.
 */
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
    writeFileSync(timingFile(args) ?? "", String(params.length * 500));
    const ok = params.every((p) => !fails(p));
    return { code: ok ? 0 : 1, stdout: "", stderr: "" };
  };
}

/** Runs the phases before the edit, applies `edit`, then completes the workflow with a negative control. */
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
