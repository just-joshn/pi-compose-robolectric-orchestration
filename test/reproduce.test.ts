import { describe, expect, it } from "vitest";

import { type Deps, start, step } from "../src/engine.ts";
import type { Exec } from "../src/gradle.ts";
import { currentPhase, newRun, type Run } from "../src/state.ts";
import { commit, deps, MAIN_FILE, read, TEST_FILE, workspace, write } from "./helpers.ts";

type Cases = Readonly<Record<string, readonly (readonly [name: string, ok: boolean])[]>>;

const glob = (filter: string) =>
  new RegExp(`^${filter.replaceAll(/[.$[\]()]/g, "\\$&").replaceAll("*", ".*")}$`);

/**
 * Like Gradle: a filter names a class or `Class.method`, `*` is its only wildcard, a class-level
 * failure (classMethod) shows whenever any of the class's tests runs, and every class that ran a
 * case gets its own report.
 */
function gradle(root: string, cases: () => Cases): Exec {
  return async (_c, args) => {
    const filters = args.filter((_, i) => args[i - 1] === "--tests").map(glob);
    const runs = (name: string) => filters.some((f) => f.test(name));
    const ran = Object.entries(cases()).map(([cls, all]) => {
      const any = runs(cls) || all.some(([name]) => runs(`${cls}.${name}`));
      const selected = (name: string) =>
        runs(cls) || runs(`${cls}.${name}`) || (name === "classMethod" && any);
      return [cls, all.filter(([name]) => selected(name))] as const;
    });
    for (const [cls, selected] of ran.filter(([, some]) => some.length > 0)) {
      const xml = selected.map(
        ([name, ok]) =>
          `<testcase name="${name}" classname="${cls}">${ok ? "" : '<failure message="x"/>'}</testcase>`,
      );
      write(root, `app/build/test-results/testDebugUnitTest/TEST-${cls}.xml`, xml.join(""));
    }
    const failed = ran.some(([, selected]) => selected.some(([, ok]) => !ok));
    return { code: failed ? 1 : 0, stdout: "", stderr: "" };
  };
}

const source = `package a
class FooTest {
  @Test fun greets() { assertEquals("Hello", greeting()) }
  @Test fun waves() { assertEquals("Hi", wave()) }
}
@RunWith(Parameterized::class)
class SuffixTest(private val suffix: String) {
  companion object {
    @JvmStatic @Parameterized.Parameters fun data() = listOf("", "!", "?")
  }
  @Test fun startsWithGreeting() { assertTrue((greeting() + suffix).startsWith("Hello")) }
}
`;

/** FooTest.greets fails while greeting() is BROKEN; `extra` adds or overrides FooTest's cases. */
function fixFailing(extra: readonly (readonly [string, boolean])[] = []) {
  const root = workspace({ test: source });
  write(root, MAIN_FILE, 'package a\nfun greeting() = "BROKEN"\n');
  commit(root, "bug");
  const d: Deps = deps(
    root,
    gradle(root, () => {
      const params = /listOf\(([^)]*)\)/.exec(read(root, TEST_FILE))?.[1]?.split(",") ?? [];
      const greets = !read(root, MAIN_FILE).includes("BROKEN");
      const foo = new Map<string, boolean>([["greets", greets], ["waves", true], ...extra]);
      return {
        "a.FooTest": [...foo],
        "a.SuffixTest": params.map((_, i) => [`startsWithGreeting[${i}]`, true] as const),
      };
    }),
  );
  const input = {
    workflow: "fix-failing",
    targets: [{ file: TEST_FILE, method: "greets" }],
  } as const;
  const run: Run = start(newRun("g", null), input, root).run;
  return { root, d, run };
}

describe("fix-failing with a method target", () => {
  it("records the file's other cases before the fix, so dropping one is caught", async () => {
    const { root, d, run } = fixFailing();
    const fixing = (await step(run, d)).run;
    expect(currentPhase(fixing)?.id).toBe("fix");
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    write(root, TEST_FILE, source.replace(', "?")', ")"));
    const done = (await step(fixing, d)).run;
    expect(done.status).not.toBe("verified");
    expect(done.statusReason).toContain(
      "Original tests missing or not passing: a.SuffixTest.startsWithGreeting[2].",
    );
  });

  it("does not count a failing sibling as the target's failure", async () => {
    const { run, d } = fixFailing([
      ["greets", true],
      ["waves", false],
    ]);
    const once = await step(run, d);
    expect(currentPhase(once.run)?.id).toBe("reproduce");
    expect(once.message).toContain("Did not reproduce");
  });

  it("counts a failure of the target's class that names no test", async () => {
    const { run, d } = fixFailing([
      ["greets", true],
      ["classMethod", false],
    ]);
    expect(currentPhase((await step(run, d)).run)?.id).toBe("fix");
  });
});
