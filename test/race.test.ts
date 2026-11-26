import { describe, expect, it } from "vitest";

import { step } from "../src/engine.ts";
import { currentPhase } from "../src/state.ts";
import {
  begin,
  behavior,
  commit,
  MAIN_FILE,
  passingTest,
  read,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

/** Like a bash call running alongside compose_test_step: Gradle's `at`th run sees the test edited. */
const editedDuring = (root: string, at: number) => (main: string, _test: string, call: number) => {
  if (call === at) write(root, TEST_FILE, `${read(root, TEST_FILE)}// edited meanwhile\n`);
  return behavior(main);
};

describe("a file edited while Gradle runs", () => {
  it.each([
    ["fix-failing", "reproduce"],
    ["fix-flaky", "inventory"],
    ["refactor", "verify"],
    ["performance", "measure"],
  ] as const)("keeps %s's %s run from counting", async (workflow, _purpose) => {
    const root = workspace();
    const { run, d } = begin(root, { workflow }, editedDuring(root, 1));
    await expect(step(run, d)).rejects.toThrow(/changed while Gradle ran/);
  });

  it("keeps a stress run from counting", async () => {
    const root = workspace();
    const { run, d } = begin(root, { workflow: "fix-flaky" }, editedDuring(root, 4));
    const fixing = (await step(run, d)).run;
    expect(currentPhase(fixing)?.id).toBe("fix");
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello" // deterministic\n');
    await expect(step(fixing, d)).rejects.toThrow(/changed while Gradle ran/);
  });

  it("never verifies a fix that a test weakened during the run passed", async () => {
    const root = workspace();
    write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
    commit(root, "bug");
    const weak = passingTest.replace('"Hello"', '"BROKEN"');
    const { run, d } = begin(root, { workflow: "fix-failing" }, (main, _test, call) => {
      if (call !== 2) return behavior(main);
      write(root, TEST_FILE, weak);
      return "pass";
    });
    const fixing = (await step(run, d)).run;
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    await expect(step(fixing, d)).rejects.toThrow(/changed while Gradle ran/);
    write(root, TEST_FILE, passingTest);
    expect((await step(fixing, d)).run.status).toBe("verified");
  });
});
