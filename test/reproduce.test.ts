import { describe, expect, it } from "vitest";

import { type Deps, start, step } from "../src/engine.ts";
import { type Exec, runTargets } from "../src/gradle.ts";
import { currentPhase, newRun, type Run } from "../src/state.ts";
import { commit, deps, glob, MAIN_FILE, read, TEST_FILE, workspace, write } from "./helpers.ts";

type Cases = Readonly<Record<string, readonly (readonly [name: string, ok: boolean])[]>>;

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

/** greets and every startsWithGreeting case fail while greeting() is BROKEN; `extra` adds or overrides FooTest's cases. */
function fixFailing(extra: readonly (readonly [string, boolean])[] = [], method = "greets") {
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
        "a.SuffixTest": params.map((_, i) => [`startsWithGreeting[${i}]`, greets] as const),
      };
    }),
  );
  const input = { workflow: "fix-failing", targets: [{ file: TEST_FILE, method }] } as const;
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

/** Gradle's output, from real Gradle 8.14.5 and Kotlin 2.2.20, for a run that executed no test. */
const NOTHING_RAN = {
  "timeout kill": { code: 143, stdout: "> Task :app:compileTestKotlin\n", stderr: "" },
  "missing dependency": {
    code: 1,
    stdout: "> Task :app:compileTestKotlin FAILED\n",
    stderr:
      "* What went wrong:\nExecution failed for task ':app:compileTestKotlin'.\n> Could not resolve all files for configuration ':app:testCompileClasspath'.\n   > Could not find junit:junit:4.99.99.\n",
  },
};
const COMPILE_ERRORS = {
  kotlin: "e: file:///w/app/src/test/kotlin/a/FooTest.kt:5:46 Unresolved reference 'greting'.",
  java: "/w/app/src/main/java/a/Bar.java:2: error: cannot find symbol",
};

describe("a fix-failing run that executed no test", () => {
  it.each(Object.entries(NOTHING_RAN))(
    "does not reproduce the failure after a %s, and blocks after two",
    async (_kind, output) => {
      const root = workspace();
      const input = { workflow: "fix-failing", targets: [{ file: TEST_FILE }] } as const;
      const run = start(newRun("g", null), input, root).run;
      const d = deps(root, async () => output);
      const once = await step(run, d);
      expect(currentPhase(once.run)?.id).toBe("reproduce");
      expect(once.message).toContain("no compile error and no failing test");
      const twice = (await step(once.run, d)).run;
      expect(twice.status).toBe("blocked");
      expect(twice.statusReason).toMatch(/runs #1, #2 could not execute tests/);
    },
  );

  it.each(Object.entries(COMPILE_ERRORS))(
    "reproduces a failure to compile, shown by a %s diagnostic",
    async (_kind, diagnostic) => {
      const root = workspace();
      const input = { workflow: "fix-failing", targets: [{ file: TEST_FILE }] } as const;
      const run = start(newRun("g", null), input, root).run;
      const d = deps(root, async () => ({ code: 1, stdout: "", stderr: `${diagnostic}\n` }));
      expect(currentPhase((await step(run, d)).run)?.id).toBe("fix");
    },
  );
});

describe("a method target on a Parameterized test", () => {
  it("runs the method's cases and no method its name prefixes", async () => {
    const root = workspace({ test: source });
    const exec = gradle(root, () => ({
      "a.SuffixTest": [
        ["startsWithGreeting[0]", true],
        ["startsWithGreeting[1]", true],
        ["startsWithGreetingLoud[0]", false],
      ],
    }));
    const target = { file: TEST_FILE, method: "startsWithGreeting" };
    const ran = await runTargets(deps(root, exec), [target]);
    expect(ran.outcome).toBe("passed");
    expect(ran.cases.map((c) => c.name)).toEqual([
      "startsWithGreeting[0]",
      "startsWithGreeting[1]",
    ]);
  });

  it("proves the fix on the original code", async () => {
    const { root, d, run } = fixFailing([], "startsWithGreeting");
    const fixing = (await step(run, d)).run;
    expect(currentPhase(fixing)?.id).toBe("fix");
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
    expect((await step(fixing, d)).run.status).toBe("verified");
  });
});
