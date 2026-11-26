import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { ANNOTATION, annotation, blockEnd, stripCode, testFunctions } from "./lint.ts";
import { inside } from "./paths.ts";
import { atomicWrite } from "./swap.ts";

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
  /** Test task time from Gradle's test listener; unlike JUnit XML times it includes class setup. Null when Gradle reported none. */
  readonly testSeconds: number | null;
  readonly outputTail: string;
}

export type Exec = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface GradleDeps {
  readonly cwd: string;
  readonly exec: Exec;
  /** Private state directory outside the workspace. */
  readonly dir: string;
  readonly signal?: AbortSignal;
}

export function gradleConfig(env = process.env) {
  const timeout = Number(env["COMPOSE_TEST_TIMEOUT"] ?? 1200);
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error(
      `COMPOSE_TEST_TIMEOUT must be a positive number of seconds, got "${env["COMPOSE_TEST_TIMEOUT"]}".`,
    );
  const task = env["COMPOSE_TEST_TASK"] || "testDebugUnitTest";
  if (task.includes(":"))
    throw new Error(
      `COMPOSE_TEST_TASK must be a task name such as testDebugUnitTest, not a path; got "${task}".`,
    );
  return { gradle: env["COMPOSE_TEST_GRADLE"] || "gradle", task, timeoutMs: timeout * 1000 };
}

export interface TestClass {
  readonly name: string;
  readonly tests: readonly string[];
}

const DECLARATION = new RegExp(
  `^[ \\t]*((?:${ANNOTATION}\\s+)*)((?:(?:public|internal|private|open|abstract|final|data|sealed)\\s+)*)(?:class|object)\\s+(\\w+)`,
  "gm",
);

function inIgnoredClass(code: string, declarations: readonly RegExpExecArray[], ignore: RegExp) {
  const bodies = declarations.flatMap((m, i) => {
    const open = code.indexOf("{", m.index + m[0].length);
    const bodied = open >= 0 && open < (declarations[i + 1]?.index ?? code.length);
    return ignore.test(m[1] ?? "") && bodied ? [[open, blockEnd(code, open)] as const] : [];
  });
  return (at: number) => bodies.some(([from, to]) => at > from && at < to);
}

/**
 * Concrete top-level classes with tests that are not @Ignore'd (an abstract class's tests run under
 * its subclasses). With none, the last concrete top-level class or the file name.
 */
export function testClasses(source: string, file: string): TestClass[] {
  const code = stripCode(source);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1];
  const qualify = (name: string) => (pkg ? `${pkg}.${name}` : name);
  const declarations = [...code.matchAll(DECLARATION)];
  const tops = declarations.filter((m) => {
    const before = code.slice(0, m.index);
    return before.split("{").length === before.split("}").length;
  });
  const ignore = annotation(code, "Ignore");
  const skipped = inIgnoredClass(code, declarations, ignore);
  const tests = testFunctions(source).filter((t) => !ignore.test(t.header) && !skipped(t.at));
  const classes = tops.flatMap((m, i) => {
    if (/\b(abstract|sealed)\s/.test(m[2] ?? "")) return [];
    const [from, to] = [m.index, tops[i + 1]?.index ?? code.length];
    const name = qualify(m[3] ?? "");
    return [{ name, tests: tests.filter((t) => t.at >= from && t.at < to).map((t) => t.name) }];
  });
  const withTests = classes.filter((c) => c.tests.length > 0);
  if (withTests.length) return withTests;
  return [
    { name: classes.at(-1)?.name ?? qualify(basename(file).replace(/\.kt$/, "")), tests: [] },
  ];
}

function resolve(cwd: string, target: Target): Resolved[] {
  if (!inside(cwd, target.file)) throw new Error(`Target ${target.file} is outside the workspace.`);
  const absolute = join(cwd, target.file);
  if (!existsSync(absolute)) throw new Error(`Target ${target.file} does not exist.`);
  const index = `/${target.file}`.indexOf("/src/");
  if (index < 0) throw new Error(`Target ${target.file} is not inside a src/ source set.`);
  const module = join(cwd, target.file.slice(0, index));
  let root = module;
  while (!["settings.gradle.kts", "settings.gradle"].some((f) => existsSync(join(root, f)))) {
    if (dirname(root) === root) throw new Error(`No settings.gradle(.kts) above ${target.file}.`);
    root = dirname(root);
  }
  const classes = testClasses(readFileSync(absolute, "utf8"), target.file);
  const { method } = target;
  const holding = method ? classes.filter((c) => c.tests.includes(method)) : classes;
  return (holding.length ? holding : classes).map((c) => ({
    file: target.file,
    method,
    root,
    module,
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

const resultsDir = (module: string, task: string) => join(module, "build", "test-results", task);

function reports(target: Resolved, task: string): string[] {
  const dir = resultsDir(target.module, task);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (f) => f === `TEST-${target.className}.xml` || f.startsWith(`TEST-${target.className}$`),
    )
    .map((f) => join(dir, f));
}

export const ofTest = (name: string, test: string) => name === test || name.startsWith(`${test}[`);

const casesFor = (target: Resolved, task: string) =>
  reports(target, task).flatMap((file) =>
    parseJUnitXml(readFileSync(file, "utf8")).filter(
      (c) => !target.method || ofTest(c.name, target.method),
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

/**
 * Random per process: a build script cannot predict the timing file, and the init script's content,
 * which keys Gradle's configuration cache, stays the same from run to run.
 */
const PRIVATE = { script: `${randomUUID()}.init.gradle`, timing: `${randomUUID()}.time` };

const groovyString = (text: string) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/**
 * `-p <module>` also runs the task in child projects, whose tests never match the filters. Only
 * the module's own task records its root suite's time, which spans every test class, class-level
 * setup included.
 */
const initScript = (task: string, timing: string) => `allprojects {
  tasks.withType(Test).configureEach { task ->
    filter.failOnNoMatchingTests = false
    def own = task.name == ${groovyString(task)} && task.project.projectDir == gradle.startParameter.currentDir
    afterSuite { suite, result ->
      if (own && suite.parent == null) new File(${groovyString(timing)}).text = String.valueOf(result.endTime - result.startTime)
    }
  }
}
`;

function takeTestSeconds(timing: string): number | null {
  const text = existsSync(timing) ? readFileSync(timing, "utf8") : "";
  rmSync(timing, { force: true });
  return /^\d+$/.test(text) ? Number(text) / 1000 : null;
}

const total = (parts: readonly (number | null)[]) =>
  parts.reduce<number | null>(
    (sum, part) => (sum === null || part === null ? null : sum + part),
    0,
  );

function invocation(
  group: readonly Resolved[],
  { gradle, task }: { gradle: string; task: string },
  script: string,
): Invocation {
  const root = group[0]?.root ?? "";
  // Gradle maps the module directory to its project, which may sit at a different path.
  const module = group[0]?.module ?? root;
  const moduleDir = relative(root, module) || ".";
  for (const file of group.flatMap((t) => reports(t, task))) rmSync(file, { force: true });
  // The project's gradlew always wins over COMPOSE_TEST_GRADLE.
  const wrapper = join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  // A class filter does not match the class's nested classes, which Gradle names Outer$Inner, and
  // a method filter does not match the method's parameterized cases, which it names method[i].
  const tests = group.flatMap(({ className, method }) =>
    [className, `${className}$*`]
      .flatMap((c) => (method ? [`${c}.${method}`, `${c}.${method}[*`] : [c]))
      .flatMap((filter) => ["--tests", filter]),
  );
  return {
    root,
    gradle: existsSync(wrapper) ? wrapper : gradle,
    args: ["--console=plain", "-p", moduleDir, task, "--rerun", ...tests, "--init-script", script],
  };
}

type Ran = Awaited<ReturnType<Exec>> & { readonly testSeconds: number | null };

/** Gradle invocations share the project's build lock, so they run one after another. */
async function inOrder(
  exec: Exec,
  invocations: readonly Invocation[],
  timing: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<Ran[]> {
  if (options.signal?.aborted)
    throw new Error("Gradle run cancelled; it is not recorded as evidence.", {
      cause: options.signal.reason,
    });
  const [first, ...rest] = invocations;
  if (!first) return [];
  rmSync(timing, { force: true });
  const result = await exec(first.gradle, first.args, { ...options, cwd: first.root });
  const ran = { ...result, testSeconds: takeTestSeconds(timing) };
  return [ran, ...(await inOrder(exec, rest, timing, options))];
}

/**
 * Run the targets with `--rerun`, one Gradle invocation per module, and read only the JUnit XML
 * this run wrote.
 */
export async function runTargets(
  { cwd, exec, dir, signal }: GradleDeps,
  targets: readonly Target[],
): Promise<Execution> {
  const config = gradleConfig();
  const resolved = targets.flatMap((t) => resolve(cwd, t));
  const [script, timing] = [join(dir, PRIVATE.script), join(dir, PRIVATE.timing)];
  atomicWrite(script, initScript(config.task, timing));
  const started = Date.now();
  // `-p <module>` reruns, and so clears, child projects' tests. Sorted, a module runs before its children.
  const keys = [...new Set(resolved.map((t) => `${t.root}\0${t.module}`))].toSorted();
  const invocations = keys.map((key) =>
    invocation(
      resolved.filter((t) => `${t.root}\0${t.module}` === key),
      config,
      script,
    ),
  );
  const results = await inOrder(exec, invocations, timing, {
    timeoutMs: config.timeoutMs,
    ...(signal ? { signal } : {}),
  }).finally(() => rmSync(script, { force: true }));
  const exitCode = results.reduce((code, r) => (r.code === 0 ? code : r.code), 0);
  const output = results.map((r) => `${r.stdout}\n${r.stderr}`).join("\n");
  const commands = invocations.map((i) => `${i.gradle} ${i.args.join(" ")}`);
  const perTarget = resolved.map((t) => casesFor(t, config.task));
  return {
    command: commands.join(" && "),
    exitCode,
    outcome: outcomeOf(exitCode, perTarget),
    cases: [
      ...new Map(
        resolved.flatMap((t, i) =>
          (perTarget[i] ?? []).map((c) => [`${t.module}\0${c.className}#${c.name}`, c] as const),
        ),
      ).values(),
    ],
    seconds: Math.round((Date.now() - started) / 100) / 10,
    testSeconds: total(results.map((r) => r.testSeconds)),
    outputTail: output
      .split("\n")
      .filter((line) => /FAILED|What went wrong|error|e: |Exception/.test(line))
      .slice(-30)
      .join("\n"),
  };
}
