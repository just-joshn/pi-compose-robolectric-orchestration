import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { finalize } from "../src/checks.ts";
import { mutate, start, step } from "../src/engine.ts";
import { currentPhase, newRun, type Run, type TestRun } from "../src/state.ts";
import { digest, fingerprint } from "../src/tree.ts";
import {
  BREAK,
  deps,
  junitGradle,
  MAIN_FILE,
  TEST_FILE,
  twoTests,
  workspace,
  write,
} from "./helpers.ts";

const BUILD_FILE = "app/build.gradle.kts";
const SDK_GATED = twoTests("onlyOnNewSdks").replace(
  'rule.onNodeWithText("Hi").assertExists()',
  'assumeTrue(Build.VERSION.SDK_INT >= 34)\n    rule.onNodeWithText("Hi").assertExists()',
);

const onOldSdk = (body: string, main: string) =>
  body.includes("assumeTrue") ? "skipped" : main.includes("BROKEN") ? "failed" : "passed";

const fixes = {
  "fix-failing": (root: string) => write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n'),
  "fix-flaky": (root: string) =>
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello" // deterministic\n'),
  performance: (root: string) => write(root, BUILD_FILE, "// tuned\n"),
};

async function drive(workflow: keyof typeof fixes): Promise<Run> {
  const root = workspace({ test: SDK_GATED });
  if (workflow === "fix-failing") write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
  const tuned = () => (existsSync(join(root, BUILD_FILE)) ? 500 : 1000);
  const d = deps(root, junitGradle(root, onOldSdk, tuned));
  const input = { workflow, targets: [{ file: TEST_FILE }] };
  let run = (await step(start(newRun("g", null), input, root).run, d)).run;
  fixes[workflow](root);
  run = (await step(run, d)).run;
  if (currentPhase(run)?.kind === "mutation") run = (await mutate(run, BREAK, d)).run;
  return run;
}

describe("a test that Assume skipped in the first run", () => {
  it.each(["fix-failing", "fix-flaky", "performance"] as const)(
    "does not keep %s from verifying a correct change",
    async (workflow) => {
      const run = await drive(workflow);
      expect(run.statusReason).toBe("All checks passed.");
      expect(run.status).toBe("verified");
    },
  );
});

describe("a test the first run has no case for", () => {
  it("must still pass in the last run", () => {
    const root = workspace({ test: SDK_GATED });
    const input = { workflow: "fix-flaky", targets: [{ file: TEST_FILE }] } as const;
    const run = start(newRun("g", null), input, root).run;
    const tree = digest(fingerprint(root));
    const passed = {
      className: "a.FooTest",
      name: "showsGreeting",
      status: "passed",
      seconds: 1,
    } as const;
    const ran = (id: number, purpose: "inventory" | "stress"): TestRun => ({
      id,
      phase: purpose,
      purpose,
      command: "",
      exitCode: 0,
      outcome: "passed",
      cases: [passed],
      seconds: 1,
      testSeconds: 1,
      outputTail: "",
      tree,
    });
    const mutations = [{ ...BREAK, runId: 3, tree, detected: true }];
    const runs = [ran(1, "inventory"), ran(2, "stress")];
    const done = finalize({ ...run, runs, mutations, phaseIndex: 4 }, root);
    expect(done.statusReason).toContain(
      "Original tests missing or not passing: a.FooTest.onlyOnNewSdks.",
    );
  });
});
