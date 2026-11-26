import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { ANNOTATION, annotation, blockEnd, stripCode, testFunctions } from "./lint.ts";
import { inside } from "./paths.ts";
import { INIT_SCRIPT, RECORD_PROPERTY, takeOwnTask } from "./record.ts";
import { atomicWrite } from "./swap.ts";

export interface Target {
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
  /** From Gradle's test listener; unlike JUnit XML times it includes class setup. */
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
  readonly testIds: readonly string[];
}

const DECLARATION = new RegExp(
  `^[ \\t]*((?:${ANNOTATION}\\s+)*)((?:(?:public|internal|private|open|abstract|final|data|sealed)\\s+)*)(?:class|object)\\s+(\\w+)`,
  "gm",
);

interface Declaration {
  readonly name: string;
  readonly annotations: string;
  readonly modifiers: string;
  readonly at: number;
  readonly header: string;
  readonly body: { readonly from: number; readonly to: number } | null;
  readonly topLevel: boolean;
}

function declarationsIn(code: string): Declaration[] {
  const matches = [...code.matchAll(DECLARATION)];
  return matches.map((m, i) => {
    const start = m.index + m[0].length;
    const limit = matches[i + 1]?.index ?? code.length;
    let parens = 0;
    let angles = 0;
    let end = start;
    for (; end < limit; end++) {
      const ch = code[end];
      if (ch === "`") {
        end = code.indexOf("`", end + 1);
        continue;
      }
      if (parens === 0 && angles === 0 && (ch === "{" || ch === "}")) break;
      if (ch === "(") parens++;
      if (ch === ")") parens--;
      if (parens === 0 && ch === "<") angles++;
      if (parens === 0 && ch === ">" && code[end - 1] !== "-") angles--;
    }
    const before = code.slice(0, m.index);
    return {
      name: m[3] ?? "",
      annotations: m[1] ?? "",
      modifiers: m[2] ?? "",
      at: m.index,
      header: code.slice(start, end),
      body: end < limit && code[end] === "{" ? { from: end, to: blockEnd(code, end) } : null,
      topLevel: before.split("{").length === before.split("}").length,
    };
  });
}

const contains = (declaration: Declaration, at: number) =>
  declaration.body !== null && declaration.body.from < at && at < declaration.body.to;

const supertypeName = (part: string) => /^\s*([\w.]+)/.exec(part)?.[1] ?? "";

function supertypes(header: string): string[] {
  let parens = 0;
  let angles = 0;
  let start = -1;
  const names: string[] = [];
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (parens === 0 && angles === 0) {
      if (/^where\b/.test(header.slice(i))) break;
      if (ch === ":" && start < 0) start = i + 1;
      else if (ch === "," && start >= 0) {
        names.push(supertypeName(header.slice(start, i)));
        start = i + 1;
      }
    }
    if (ch === "(") parens++;
    if (ch === ")") parens--;
    if (parens === 0 && ch === "<") angles++;
    if (parens === 0 && ch === ">" && header[i - 1] !== "-") angles--;
  }
  if (start >= 0) names.push(supertypeName(header.slice(start)));
  return names;
}

export function testClasses(source: string, file: string): TestClass[] {
  const code = stripCode(source);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1];
  const qualify = (name: string) => (pkg ? `${pkg}.${name}` : name);
  const declarations = declarationsIn(code);
  const tops = declarations.filter((declaration) => declaration.topLevel);
  const ignore = annotation(code, "Ignore");
  const functions = testFunctions(source);
  const declarationsWithTests = tops.map((m, i) => {
    const [from, to] = [m.at, tops[i + 1]?.at ?? code.length];
    const bases = supertypes(m.header).map((type) =>
      pkg && type.startsWith(`${pkg}.`) ? type.slice(pkg.length + 1) : type,
    );
    const own = functions
      .filter((t) => t.at >= from && t.at < to)
      .map((t) => {
        const before = code.slice(from, t.at);
        return {
          name: t.name,
          ignored: ignore.test(t.header),
          direct: before.split("{").length - before.split("}").length === 1,
          inIgnoredClass: declarations.some((d) => ignore.test(d.annotations) && contains(d, t.at)),
          owners: declarations.filter((d) => contains(d, t.at)).map((d) => d.name),
        };
      });
    return {
      name: m.name,
      abstract: /\b(abstract|sealed)\s/.test(m.modifiers),
      ignored: ignore.test(m.annotations),
      bases,
      direct: own.filter((t) => t.direct),
      nested: own.filter((t) => !t.direct && !t.ignored && !t.inIgnoredClass),
    };
  });
  const byName = new Map(declarationsWithTests.map((c) => [c.name, c]));
  const inherited = (name: string, seen: Set<string>, declared: Set<string>): string[] => {
    const declaration = byName.get(name);
    if (!declaration || seen.has(name)) return [];
    seen.add(name);
    const direct = declaration.direct.filter((test) => {
      if (declared.has(test.name)) return false;
      declared.add(test.name);
      return true;
    });
    return [
      ...direct.filter((test) => !test.ignored).map((test) => test.name),
      ...declaration.bases.flatMap((base) => inherited(base, seen, declared)),
    ];
  };
  const classes = declarationsWithTests
    .filter((c) => !c.abstract && !c.ignored)
    .map((c) => {
      const seen = new Set([c.name]);
      const declared = new Set(c.direct.map((test) => test.name));
      const name = qualify(c.name);
      const direct = c.direct.filter((test) => !test.ignored).map((test) => test.name);
      const bases = c.bases.flatMap((b) => inherited(b, seen, declared));
      const tests = [...direct, ...c.nested.map((test) => test.name), ...bases];
      const testIds = [
        ...direct.map((test) => `${name}.${test}`),
        ...c.nested.map(
          (test) =>
            `${name}${test.owners
              .slice(1)
              .map((owner) => `$${owner}`)
              .join("")}.${test.name}`,
        ),
        ...bases.map((test) => `${name}.${test}`),
      ];
      return { name, tests, testIds };
    });
  const withTests = classes.filter((c) => c.tests.length > 0);
  if (withTests.length) return withTests;
  return [
    {
      name: classes.at(-1)?.name ?? qualify(basename(file).replace(/\.kt$/, "")),
      tests: [],
      testIds: [],
    },
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

const FAILED_ATTEMPT =
  /<(?:failure|error|flakyFailure|flakyError|rerunFailure|rerunError)\b([^>]*)/;

function parseCase(tag: string, body: string): TestCase {
  const failure = FAILED_ATTEMPT.exec(body);
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

function reports(target: Resolved, dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (f) => f === `TEST-${target.className}.xml` || f.startsWith(`TEST-${target.className}$`),
    )
    .map((f) => join(dir, f));
}

export const ofTest = (name: string, test: string) => name === test || name.startsWith(`${test}[`);

const casesFor = (target: Resolved, dir: string) =>
  reports(target, dir).flatMap((file) =>
    parseJUnitXml(readFileSync(file, "utf8")).filter(
      (c) => !target.method || ofTest(c.name, target.method),
    ),
  );

function outcomeOf(exitCode: number, perTarget: readonly (readonly TestCase[])[]): Outcome {
  if (perTarget.some((cases) => cases.every((c) => c.status === "skipped")))
    return exitCode === 0 ? "no-tests" : "build-error";
  if (perTarget.flat().some((c) => c.status === "failed")) return "failed";
  return exitCode === 0 ? "passed" : "build-error";
}

interface Invocation {
  readonly root: string;
  readonly module: string;
  readonly record: string;
  readonly gradle: string;
  readonly args: readonly string[];
  readonly targets: readonly Resolved[];
}

/** Never deleted: a run in flight may still hand it to Gradle. Unchanged content keeps Gradle's configuration cache. */
const SCRIPT = `${randomUUID()}.init.gradle`;

const total = (parts: readonly (number | null)[]) =>
  parts.reduce<number | null>(
    (sum, part) => (sum === null || part === null ? null : sum + part),
    0,
  );

function invocation(
  group: readonly Resolved[],
  { gradle, task }: { gradle: string; task: string },
  { script, dir }: { script: string; dir: string },
): Invocation {
  const root = group[0]?.root ?? "";
  // Gradle maps the module directory to its project, which may sit at a different path.
  const module = group[0]?.module ?? root;
  const moduleDir = relative(root, module) || ".";
  const wrapper = join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  // A class filter does not match the class's nested classes, which Gradle names Outer$Inner, and
  // a method filter does not match the method's parameterized cases, which it names method[i].
  const tests = group.flatMap(({ className, method }) =>
    [className, `${className}$*`]
      .flatMap((c) => (method ? [`${c}.${method}`, `${c}.${method}[*`] : [c]))
      .flatMap((filter) => ["--tests", filter]),
  );
  const record = join(dir, `${randomUUID()}.record`);
  return {
    root,
    module,
    record,
    gradle: existsSync(wrapper) ? wrapper : gradle,
    args: [
      "--console=plain",
      "-p",
      moduleDir,
      task,
      "--rerun",
      ...tests,
      "--init-script",
      script,
      `-D${RECORD_PROPERTY}=${record}`,
    ],
    targets: group,
  };
}

type Ran = Awaited<ReturnType<Exec>> & {
  readonly testSeconds: number | null;
  readonly perTarget: readonly (readonly TestCase[])[];
};

interface RunOptions {
  readonly task: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Gradle invocations share the project's build lock, so they run one after another. `-p <module>`
 * also reruns, and so clears, child projects' tests, so each invocation's results are read before
 * the next one runs. Only the module's own task counts.
 */
async function inOrder(
  exec: Exec,
  invocations: readonly Invocation[],
  { task, ...options }: RunOptions,
): Promise<Ran[]> {
  if (options.signal?.aborted)
    throw new Error("Gradle run cancelled; it is not recorded as evidence.", {
      cause: options.signal.reason,
    });
  const [first, ...rest] = invocations;
  if (!first) return [];
  const result = await exec(first.gradle, first.args, { ...options, cwd: first.root });
  const own = takeOwnTask(first.record, task, first.module);
  const perTarget = first.targets.map((t) => (own ? casesFor(t, own.xml) : []));
  const ran = { ...result, testSeconds: own ? own.ms / 1000 : null, perTarget };
  return [ran, ...(await inOrder(exec, rest, { task, ...options }))];
}

export async function runTargets(
  { cwd, exec, dir, signal }: GradleDeps,
  targets: readonly Target[],
): Promise<Execution> {
  const config = gradleConfig();
  const resolved = targets.flatMap((t) => resolve(cwd, t));
  const script = join(dir, SCRIPT);
  atomicWrite(script, INIT_SCRIPT);
  const started = Date.now();
  const keys = [...new Set(resolved.map((t) => `${t.root}\0${t.module}`))];
  const invocations = keys.map((key) =>
    invocation(
      resolved.filter((t) => `${t.root}\0${t.module}` === key),
      config,
      { script, dir },
    ),
  );
  const results = await inOrder(exec, invocations, {
    task: config.task,
    timeoutMs: config.timeoutMs,
    ...(signal ? { signal } : {}),
  });
  const exitCode = results.reduce((code, r) => (r.code === 0 ? code : r.code), 0);
  const output = results.map((r) => `${r.stdout}\n${r.stderr}`).join("\n");
  const commands = invocations.map((i) => `${i.gradle} ${i.args.join(" ")}`);
  const ordered = invocations.flatMap((i) => i.targets);
  const perTarget = results.flatMap((r) => r.perTarget);
  return {
    command: commands.join(" && "),
    exitCode,
    outcome: outcomeOf(exitCode, perTarget),
    cases: [
      ...new Map(
        ordered.flatMap((t, i) =>
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
