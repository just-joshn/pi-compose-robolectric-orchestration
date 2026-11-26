import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type Deps, start, type StartInput } from "../src/engine.ts";
import type { Exec } from "../src/gradle.ts";
import { newRun } from "../src/state.ts";

export const TEST_FILE = "app/src/test/java/a/FooTest.kt";
export const MAIN_FILE = "app/src/main/java/a/Foo.kt";
export const RESULT_XML = "app/build/test-results/testDebugUnitTest/TEST-a.FooTest.xml";
/** The file the init script's test listener records each Test task that ran to. */
export function recordFile(args: readonly string[]): string {
  const script = readFileSync(args[args.indexOf("--init-script") + 1] ?? "", "utf8");
  return /new File\('([^']+)'\)/.exec(script)?.[1] ?? "";
}

interface TaskRun {
  readonly module?: string;
  readonly task?: string;
  readonly xml?: string;
  readonly ms?: number;
}

/** Like the init script: records that a Test task ran, by default the -p module's, in the default layout. */
export function recordTask(root: string, args: readonly string[], run: TaskRun = {}) {
  const module = run.module ?? args[args.indexOf("-p") + 1] ?? ".";
  const task = run.task ?? args[args.indexOf("-p") + 2] ?? "";
  const xml = run.xml ?? join(root, module, "build", "test-results", task);
  const entry = { task, project: join(root, module), xml, ms: run.ms ?? 500 };
  appendFileSync(recordFile(args), `${JSON.stringify(entry)}\n`);
}

export const passingTest = `package a

import androidx.compose.ui.test.junit4.v2.createComposeRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class FooTest {
  @get:Rule val rule = createComposeRule()

  @Test
  fun showsGreeting() {
    rule.onNodeWithText("Hello").assertIsDisplayed()
  }
}
`;

export function write(root: string, file: string, content: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

export const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");

export function git(root: string, ...args: string[]) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

export function workspace(options: { git?: boolean; test?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "compose-test-"));
  write(root, "settings.gradle.kts", 'include(":app")\n');
  write(root, ".gitignore", "build/\n");
  write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello"\n');
  if (options.test !== null) write(root, TEST_FILE, options.test ?? passingTest);
  if (options.git !== false) {
    git(root, "init", "-q");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  }
  return root;
}

export type Verdict = "pass" | "fail" | "build-error" | "flaky";

const attribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const xml = (cases: readonly [string, boolean][]) =>
  `<?xml version="1.0"?><testsuite name="a.FooTest" tests="${cases.length}">${cases
    .map(([name, ok]) => [attribute(name), ok] as const)
    .map(([name, ok]) =>
      ok
        ? `<testcase name="${name}" classname="a.FooTest" time="0.5"/>`
        : `<testcase name="${name}" classname="a.FooTest" time="0.5"><failure message="Assert failed: &quot;Hello&quot; is not displayed" type="java.lang.AssertionError">trace</failure></testcase>`,
    )
    .join("")}</testsuite>`;

/**
 * A fake Gradle: decides each run from the current workspace content, writes the JUnit XML a real
 * run would write, and records every invocation.
 */
export function fakeGradle(
  root: string,
  decide: (main: string, test: string, call: number) => Verdict,
) {
  const calls: string[][] = [];
  const exec: Exec = async (_command, args) => {
    calls.push([...args]);
    const verdict = decide(read(root, MAIN_FILE), read(root, TEST_FILE), calls.length);
    if (verdict === "build-error")
      return { code: 1, stdout: "", stderr: "e: Unresolved reference\nBUILD FAILED" };
    const names = [...read(root, TEST_FILE).matchAll(/@Test\s+fun\s+(`[^`]+`|\w+)/g)].map(
      (m) => m[1]?.replaceAll("`", "") ?? "",
    );
    const ok = verdict === "pass" || (verdict === "flaky" && calls.length % 2 === 0);
    write(root, RESULT_XML, xml(names.map((name) => [name, ok])));
    recordTask(root, args, { ms: names.length * 500 });
    return { code: ok ? 0 : 1, stdout: ok ? "BUILD SUCCESSFUL" : "FAILED", stderr: "" };
  };
  return { exec, calls };
}

/** A Gradle --tests filter as a regular expression; `*` is its only wildcard. */
export const glob = (filter: string) =>
  new RegExp(`^${filter.replaceAll(/[.$[\]()]/g, "\\$&").replaceAll("*", ".*")}$`);

export const behavior = (main: string) => (main.includes("BROKEN") ? "fail" : "pass");

export function deps(root: string, exec: Exec): Deps {
  return { cwd: root, exec, dir: mkdtempSync(join(tmpdir(), "compose-test-state-")) };
}

export const commit = (root: string, message: string) =>
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", message);

export const BREAK = { file: MAIN_FILE, find: '"Hello"', replace: '"BROKEN"' };
export const twoTests = (second: string) =>
  passingTest.replace(
    "  @Test\n  fun showsGreeting",
    `  @Test\n  fun ${second}() {\n    rule.onNodeWithText("Hi").assertExists()\n  }\n\n  @Test\n  fun showsGreeting`,
  );

export function begin(
  root: string,
  input: Partial<StartInput> = {},
  decide: (main: string, test: string, call: number) => Verdict = behavior,
) {
  const gradle = fakeGradle(root, decide);
  const d = deps(root, gradle.exec);
  const run = start(
    newRun("goal", null),
    { workflow: "write-test", targets: [{ file: TEST_FILE }], ...input },
    root,
  ).run;
  return { run, d, gradle };
}
