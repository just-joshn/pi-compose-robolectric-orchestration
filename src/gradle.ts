import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { stripCode } from "./lint.ts";

export interface Target {
  /** Path relative to the workspace root. */
  readonly file: string;
  readonly method?: string;
}

interface Resolved extends Target {
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

/** Overrides come from the environment; the project's gradlew always wins over COMPOSE_TEST_GRADLE. */
export const gradleConfig = (env = process.env) => ({
  gradle: env["COMPOSE_TEST_GRADLE"] ?? "gradle",
  task: env["COMPOSE_TEST_TASK"] ?? "testDebugUnitTest",
  timeoutMs: Number(env["COMPOSE_TEST_TIMEOUT"] ?? 1200) * 1000,
});

/** The test class: the last top-level class declared before the first @Test. */
export function className(source: string, file: string): string {
  const code = stripCode(source);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1];
  const firstTest = code.search(/@(org\.junit\.)?Test\b/);
  const declaration =
    /^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|open|abstract|final|data|sealed)\s+)*(?:class|object)\s+(\w+)/gm;
  let name = basename(file).replace(/\.(kt|java)$/, "");
  for (const match of code.matchAll(declaration)) {
    if (firstTest >= 0 && (match.index ?? 0) > firstTest) break;
    name = match[1] ?? name;
  }
  return pkg ? `${pkg}.${name}` : name;
}

function resolve(cwd: string, target: Target, task: string): Resolved {
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
  return {
    ...target,
    root,
    module,
    task: `${path ? `:${path}` : ""}:${task}`,
    className: className(readFileSync(absolute, "utf8"), target.file),
  };
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

export function parseJUnitXml(xml: string): TestCase[] {
  return [...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map(
    ([, tag = "", body = ""]) => {
      const failure = /<(?:failure|error)\b([^>]*)/.exec(body);
      const message = failure
        ? (attribute(failure[1] ?? "", "message") ?? attribute(failure[1] ?? "", "type"))
        : undefined;
      return {
        className: attribute(tag, "classname") ?? "",
        name: attribute(tag, "name") ?? "",
        status: failure ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed",
        seconds: Number(attribute(tag, "time") ?? 0),
        ...(message === undefined ? {} : { message: message.slice(0, 500) }),
      };
    },
  );
}

/** JUnit XML for the class and its nested classes. */
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

/** Every target must produce a case, so a target that ran nothing cannot hide behind another. */
function outcomeOf(exitCode: number, perTarget: readonly (readonly TestCase[])[]): Outcome {
  if (perTarget.some((cases) => cases.length === 0))
    return exitCode === 0 ? "no-tests" : "build-error";
  if (perTarget.flat().some((c) => c.status === "failed")) return "failed";
  return exitCode === 0 ? "passed" : "build-error";
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
  const resolved = targets.map((t) => resolve(cwd, t, config.task));
  const started = Date.now();
  const commands: string[] = [];
  let output = "";
  let exitCode = 0;
  for (const task of new Set(resolved.map((t) => `${t.root}\0${t.task}`))) {
    const group = resolved.filter((t) => `${t.root}\0${t.task}` === task);
    const root = group[0]?.root ?? cwd;
    for (const file of group.flatMap((t) => reports(t, config.task))) rmSync(file, { force: true });
    const wrapper = join(root, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    const gradle = existsSync(wrapper) ? wrapper : config.gradle;
    const args = [
      "--console=plain",
      group[0]?.task ?? "",
      "--rerun",
      ...group.flatMap((t) => ["--tests", t.method ? `${t.className}.${t.method}` : t.className]),
    ];
    commands.push(`${gradle} ${args.join(" ")}`);
    const result = await exec(gradle, args, {
      cwd: root,
      timeoutMs: config.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (result.code !== 0) exitCode = result.code;
    output += `${result.stdout}\n${result.stderr}\n`;
  }
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
