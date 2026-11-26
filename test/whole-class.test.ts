import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mutate, start, type StartInput, step } from "../src/engine.ts";
import { currentPhase, newRun, type Run } from "../src/state.ts";
import {
  BREAK,
  commit,
  deps,
  git,
  junitGradle,
  passingTest,
  TEST_FILE,
  workspace,
  write,
} from "./helpers.ts";

const SOURCE = "app/src/androidTest/java/a/FooDeviceTest.kt";
const SHOWS = 'rule.onNodeWithText("Hello").assertIsDisplayed()';

const testFile = (...tests: readonly (readonly [string, string])[]) =>
  passingTest.replace(
    /  @Test[\s\S]*\n\}\n$/,
    `${tests.map(([name, body]) => `  @Test\n  fun ${name}() {\n    ${body}\n  }\n`).join("\n")}}\n`,
  );

const junit = (body: string, main: string) =>
  body.includes("assumeTrue(false)")
    ? "skipped"
    : body.includes("99") || main.includes("BROKEN")
      ? "failed"
      : "passed";

async function finish(input: StartInput, written: string, existing: string | null = null) {
  const root = workspace({ test: existing });
  write(root, SOURCE, testFile(["showsGreeting", SHOWS], ["second", SHOWS]));
  git(root, "add", "-A");
  commit(root, "source");
  const d = deps(root, junitGradle(root, junit));
  let run: Run = start(newRun("g", null), input, root).run;
  write(root, TEST_FILE, written);
  if (input.source) rmSync(join(root, SOURCE));
  run = (await step(run, d)).run;
  if (currentPhase(run)?.kind === "mutation") run = (await mutate(run, BREAK, d)).run;
  return run;
}

const method = [{ file: TEST_FILE, method: "showsGreeting" }];

describe("a method target", () => {
  it.each([
    { workflow: "migrate", source: SOURCE, targets: method },
    { workflow: "write-test", targets: method },
  ] as const)("is verified within its whole class in $workflow", async (input) => {
    const failing = testFile(["showsGreeting", SHOWS], ["second", "assertEquals(99, 2)"]);
    const run = await finish(input, failing);
    expect(run.status).toBe("active");
    expect(currentPhase(run)?.kind).toBe("edit");
    expect(run.statusReason).toBe("Verification failed.");
  });
});

describe("a migrated case that an assumption skips", () => {
  const skipped = `assumeTrue(false)\n    ${SHOWS}`;

  it("keeps migrate from verifying and is named", async () => {
    const input = { workflow: "migrate", source: SOURCE, targets: [{ file: TEST_FILE }] } as const;
    const run = await finish(input, testFile(["showsGreeting", SHOWS], ["second", skipped]));
    expect(run.status).not.toBe("verified");
    expect(run.statusReason).toMatch(/skipped.*: a\.FooTest\.second\b/);
  });

  it("does not count against a test the target already skipped", async () => {
    const existing = testFile(["onlyOnNewSdks", skipped]);
    const input = { workflow: "migrate", source: SOURCE, targets: [{ file: TEST_FILE }] } as const;
    const migrated = testFile(
      ["onlyOnNewSdks", skipped],
      ["showsGreeting", SHOWS],
      ["second", SHOWS],
    );
    const run = await finish(input, migrated, existing);
    expect(run.statusReason).toBe("All checks passed.");
  });
});
