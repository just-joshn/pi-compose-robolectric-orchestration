import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { stripCode, testFunctions } from "./lint.ts";
import { inside } from "./paths.ts";

export interface Target {
  /** Path relative to the workspace root. */
  readonly file: string;
  readonly method?: string;
}

interface Resolved {
  readonly file: string;
  readonly method: string | undefined;
  readonly root: string;
  readonly module: string;
  readonly task: string;
  readonly className: string;
}

export interface TestCase {
  readonly className: string;
  readonly name: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly seconds: number;
  readonly message?: string;
}

export type Outcome = "passed" | "failed" | "build-error" | "no-tests";

export interface Execution {
  readonly command: string;
  readonly exitCode: number;
  readonly outcome: Outcome;
  readonly cases: readonly TestCase[];
  readonly seconds: number;
  readonly outputTail: string;
}

export type Exec = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function gradleConfig(env = process.env) {
  const timeout = Number(env["COMPOSE_TEST_TIMEOUT"] ?? 1200);
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error(
      `COMPOSE_TEST_TIMEOUT must be a positive number of seconds, got "${env["COMPOSE_TEST_TIMEOUT"]}".`,
    );
  return {
    gradle: env["COMPOSE_TEST_GRADLE"] || "gradle",
    task: env["COMPOSE_TEST_TASK"] || "testDebugUnitTest",
    timeoutMs: timeout * 1000,
  };
}

export interface TestClass {
  readonly name: string;
  readonly tests: readonly string[];
}

const DECLARATION =
  /^[ \t]*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|open|abstract|final|data|sealed)\s+)*(?:class|object)\s+(\w+)/gm;

/**
 * Every top-level class holding @Test functions, each with its tests. With none, the last
 * top-level class, or the file name, so a file that has no tests yet still names a class.
 */
export function testClasses(source: string, file: string): TestClass[] {
  const code = stripCode(source);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1];
  const qualify = (name: string) => (pkg ? `${pkg}.${name}` : name);
  const tops = [...code.matchAll(DECLARATION)].filter((m) => {
    const before = code.slice(0, m.index);
    return before.split("{").length === before.split("}").length;
  });
  const tests = testFunctions(source);
  const classes = tops.map((m, i) => {
    const [from, to] = [m.index, tops[i + 1]?.index ?? code.length];
    return {
      name: qualify(m[1] ?? ""),
      tests: tests.filter((t) => t.at >= from && t.at < to).map((t) => t.name),
    };
  });
  const withTests = classes.filter((c) => c.tests.length > 0);
  if (withTests.length) return withTests;
  return [
    { name: classes.at(-1)?.name ?? qualify(basename(file).replace(/\.kt$/, "")), tests: [] },
  ];
}

function resolve(cwd: string, target: Target, task: string): Resolved[] {
  if (!inside(cwd, target.file)) throw new Error(`Target ${target.file} is outside the workspace.`);
  const absolute = join(cwd, target.file);
  if (!existsSync(absolute)) throw new Error(`Target ${target.file} does not exist.`);
  const index = absolute.lastIndexOf(`${sep}src${sep}`);
  if (index < 0) throw new Error(`Target ${target.file} is not inside a src/ source set.`);
  const module = absolute.slice(0, index);
  let root = module;
  while (!["settings.gradle.kts", "settings.gradle"].some((f) => existsSync(join(root, f)))) {
    if (dirname(root) === root) throw new Error(`No settings.gradle(.kts) above ${target.file}.`);
    root = dirname(root);
  }
  const path = relative(root, module).split(sep).filter(Boolean).join(":");
  const classes = testClasses(readFileSync(absolute, "utf8"), target.file);
  const { method } = target;
  const holding = method ? classes.filter((c) => c.tests.includes(method)) : classes;
  const gradleTask = `${path ? `:${path}` : ""}:${task}`;
  return (holding.length ? holding : classes).map((c) => ({
    file: target.file,
    method,
    root,
    module,
    task: gradleTask,
    className: c.name,
  }));
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`)
    .exec(tag)?.[1]
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");

function parseCase(tag: string, body: string): TestCase {
  const failure = /<(?:failure|error)\b([^>]*)/.exec(body);
  const testCase: TestCase = {
    className: attribute(tag, "classname") ?? "",
    name: attribute(tag, "name") ?? "",
    status: failure ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed",
    seconds: Number(attribute(tag, "time") ?? 0),
  };
  const message =
    failure && (attribute(failure[1] ?? "", "message") ?? attribute(failure[1] ?? "", "type"));
  return message ? { ...testCase, message: message.slice(0, 500) } : testCase;
}

export const parseJUnitXml = (xml: string): TestCase[] =>
  [
    ...xml
      .replaceAll(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
      .matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
  ].map(([, tag = "", body = ""]) => parseCase(tag, body));

function reports(target: Resolved, task: string): string[] {
  const dir = join(target.module, "build", "test-results", task);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (f) => f === `TEST-${target.className}.xml` || f.startsWith(`TEST-${target.className}$`),
    )
    .map((f) => join(dir, f));
}

const casesFor = (target: Resolved, task: string) =>
  reports(target, task).flatMap((file) =>
    parseJUnitXml(readFileSync(file, "utf8")).filter(
      (c) => !target.method || c.name === target.method || c.name.startsWith(`${target.method}[`),
    ),
  );

/** Every target must run a case, so a target that ran nothing cannot hide behind another. */
function outcomeOf(exitCode: number, perTarget: readonly (readonly TestCase[])[]): Outcome {
  if (perTarget.some((cases) => cases.every((c) => c.status === "skipped")))
    return exitCode === 0 ? "no-tests" : "build-error";
  if (perTarget.flat().some((c) => c.status === "failed")) return "failed";
  return exitCode === 0 ? "passed" : "build-error";
}

interface Invocation {
  readonly root: string;
  readonly gradle: string;
  readonly args: readonly string[];
}

function invocation(group: readonly Resolved[], gradle: string, task: string): Invocation {
  const root = group[0]?.root ?? "";
  for (const file of group.flatMap((t) => reports(t, task))) rmSync(file, { force: true });
  // The project's gradlew always wins over COMPOSE_TEST_GRADLE.
  const wrapper = join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  const tests = group.flatMap((t) => [
    "--tests",
    t.method ? `${t.className}.${t.method}` : t.className,
  ]);
  return {
    root,
    gradle: existsSync(wrapper) ? wrapper : gradle,
    args: ["--console=plain", group[0]?.task ?? "", "--rerun", ...tests],
  };
}

/** Gradle invocations share the project's build lock, so they run one after another. */
async function inOrder(
  exec: Exec,
  invocations: readonly Invocation[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Awaited<ReturnType<Exec>>[]> {
  const [first, ...rest] = invocations;
  if (!first) return [];
  const result = await exec(first.gradle, first.args, { ...options, cwd: first.root });
  return [result, ...(await inOrder(exec, rest, options))];
}

/**
 * Run the targets with `--rerun`, one Gradle invocation per module, and read only the JUnit XML
 * this run wrote.
 */
export async function runTargets(
  exec: Exec,
  cwd: string,
  targets: readonly Target[],
  signal?: AbortSignal,
): Promise<Execution> {
  const config = gradleConfig();
  const resolved = targets.flatMap((t) => resolve(cwd, t, config.task));
  const started = Date.now();
  const keys = new Set(resolved.map((t) => `${t.root}\0${t.task}`));
  const invocations = [...keys].map((key) =>
    invocation(
      resolved.filter((t) => `${t.root}\0${t.task}` === key),
      config.gradle,
      config.task,
    ),
  );
  const results = await inOrder(exec, invocations, {
    timeoutMs: config.timeoutMs,
    ...(signal ? { signal } : {}),
  });
  const exitCode = results.reduce((code, r) => (r.code === 0 ? code : r.code), 0);
  const output = results.map((r) => `${r.stdout}\n${r.stderr}`).join("\n");
  const commands = invocations.map((i) => `${i.gradle} ${i.args.join(" ")}`);
  const perTarget = resolved.map((t) => casesFor(t, config.task));
  return {
    command: commands.join(" && "),
    exitCode,
    outcome: outcomeOf(exitCode, perTarget),
    cases: [...new Map(perTarget.flat().map((c) => [`${c.className}#${c.name}`, c])).values()],
    seconds: Math.round((Date.now() - started) / 100) / 10,
    outputTail: output
      .split("\n")
      .filter((line) => /FAILED|What went wrong|error|e: |Exception/.test(line))
      .slice(-30)
      .join("\n"),
  };
}
