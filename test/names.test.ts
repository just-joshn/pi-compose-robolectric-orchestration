import { describe, expect, it } from "vitest";

import { mutate, step } from "../src/engine.ts";
import { testClasses } from "../src/gradle.ts";
import { testFunctions } from "../src/lint.ts";
import { begin, BREAK, passingTest, workspace } from "./helpers.ts";

const named = (name: string) => passingTest.replace("fun showsGreeting()", `fun \`${name}\`()`);

describe("a backticked test name that holds quotes or slashes", () => {
  it.each(['shows "Hello" greeting', "user's greeting", "opens http://example.com"])(
    "keeps the name %s whole",
    (name) => {
      const source = named(name);
      expect(testFunctions(source).map((t) => t.name)).toEqual([name]);
      expect(testClasses(source, "FooTest.kt")).toEqual([{ name: "a.FooTest", tests: [name] }]);
    },
  );

  it("lets fix-flaky verify a run in which the test passes", async () => {
    const root = workspace({ test: named('shows "Hello" greeting') });
    const { run, d } = begin(root, { workflow: "fix-flaky" });
    expect(run.baselineTests).toEqual(['a.FooTest.shows "Hello" greeting']);
    const fixing = (await step(run, d)).run;
    const stable = (await step(fixing, d)).run;
    expect((await mutate(stable, BREAK, d)).run.status).toBe("verified");
  });
});
