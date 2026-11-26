import { rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { editProblem } from "../src/checks.ts";
import { addFinding, mutate, step } from "../src/engine.ts";
import {
  begin,
  BREAK,
  commit,
  git,
  MAIN_FILE,
  passingTest,
  TEST_FILE,
  twoTests,
  workspace,
  write,
} from "./helpers.ts";

const dotted = (file: string) => `./${file}`;

describe("workspace paths written with ./", () => {
  it("match the same files read, changed or deleted without it", async () => {
    const review = begin(workspace(), {
      workflow: "review",
      targets: [{ file: dotted(TEST_FILE) }],
    });
    const read = { ...review.run, reads: [{ path: TEST_FILE, from: 1, to: 10_000 }] };
    expect((await step(read, review.d)).run.status).toBe("verified");

    const root = workspace({ test: null });
    const source = "app/src/androidTest/java/a/FooTest.kt";
    write(root, source, passingTest);
    git(root, "add", "-A");
    commit(root, "source");
    const targets = [{ file: dotted(TEST_FILE) }];
    const migrate = begin(root, { workflow: "migrate", source: dotted(source), targets });
    write(root, TEST_FILE, passingTest);
    rmSync(join(root, source));
    expect(editProblem(migrate.run, root)).toBeUndefined();
  });

  it("let a refactor merge its target's tests", async () => {
    const root = workspace({ test: twoTests("other") });
    const { run, d } = begin(root, {
      workflow: "refactor",
      targets: [{ file: dotted(TEST_FILE) }],
    });
    const editing = (await step(run, d)).run;
    write(root, TEST_FILE, passingTest);
    expect(editProblem(editing, root)).toBeUndefined();
  });

  it("name the same subject and finding file", async () => {
    const root = workspace();
    const { run, d } = begin(root, { subject: [dotted(MAIN_FILE)] });
    const verified = (await step(run, d)).run;
    expect((await mutate(verified, BREAK, d)).run.status).toBe("verified");
    const review = begin(workspace(), { workflow: "review" }).run;
    const finding = {
      file: TEST_FILE,
      line: 1,
      rule: "r",
      severity: "warning",
      message: "m",
    } as const;
    const once = addFinding(review, { ...finding, file: dotted(TEST_FILE) }, root).run;
    expect(addFinding(once, finding, root).message).toBe("Already recorded.");
  });
});
