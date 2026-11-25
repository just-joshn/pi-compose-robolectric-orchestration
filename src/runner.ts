import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { parseJUnitXml, type TestCase } from "./junit.ts";
import { gradleCommand, type ResolvedTarget, resultsDir } from "./project.ts";

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type Exec = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export type RunOutcome = "passed" | "failed" | "build-error" | "no-tests";

export interface Execution {
  readonly command: string;
  readonly exitCode: number;
  readonly outcome: RunOutcome;
  readonly cases: readonly TestCase[];
  readonly seconds: number;
  readonly outputTail: string;
}

export interface RunnerConfig {
  readonly gradle: string | undefined;
  readonly unitTestTask: string;
  readonly timeoutSeconds: number;
}

const filterFor = (target: ResolvedTarget) =>
  target.method ? `${target.className}.${target.method}` : target.className;

function groupByInvocation(targets: readonly ResolvedTarget[]) {
  const groups = new Map<string, ResolvedTarget[]>();
  for (const target of targets) {
    const key = `${target.gradleRoot}\0${target.gradlePath}`;
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  return [...groups.values()];
}

function collectCases(targets: readonly ResolvedTarget[], task: string): TestCase[] {
  const cases: TestCase[] = [];
  for (const target of targets) {
    const file = join(resultsDir(target, task), `TEST-${target.className}.xml`);
    if (!existsSync(file)) continue;
    const parsed = parseJUnitXml(readFileSync(file, "utf8"));
    cases.push(
      ...parsed.filter(
        (c) => !target.method || c.name === target.method || c.name.startsWith(`${target.method}[`),
      ),
    );
  }
  return cases;
}

const tail = (text: string) =>
  text
    .split("\n")
    .filter((line) => /FAILED|What went wrong|error|Error|e: |Exception|BUILD|> /.test(line))
    .slice(-30)
    .join("\n");

function outcomeOf(exitCode: number, cases: readonly TestCase[]): RunOutcome {
  if (cases.some((c) => c.status === "failed")) return "failed";
  if (cases.length === 0) return exitCode === 0 ? "no-tests" : "build-error";
  return exitCode === 0 ? "passed" : "build-error";
}

/**
 * Run the targets through Gradle with `--rerun` so every recorded run is a real execution, and
 * read results only from JUnit XML files that this run wrote.
 */
export async function runTargets(
  exec: Exec,
  targets: readonly ResolvedTarget[],
  config: RunnerConfig,
  signal?: AbortSignal,
): Promise<Execution> {
  const started = Date.now();
  const commands: string[] = [];
  const outputs: string[] = [];
  let exitCode = 0;
  for (const group of groupByInvocation(targets)) {
    const first = group[0];
    if (!first) continue;
    for (const target of group)
      rmSync(join(resultsDir(target, config.unitTestTask), `TEST-${target.className}.xml`), {
        force: true,
      });
    const gradle = gradleCommand(first.gradleRoot, config.gradle);
    const args = [
      "--console=plain",
      `${first.gradlePath}:${config.unitTestTask}`,
      "--rerun",
      ...group.flatMap((target) => ["--tests", filterFor(target)]),
    ];
    commands.push(`${gradle} ${args.join(" ")}`);
    const result = await exec(gradle, args, {
      cwd: first.gradleRoot,
      timeoutMs: config.timeoutSeconds * 1000,
      ...(signal ? { signal } : {}),
    });
    if (result.code !== 0) exitCode = result.code;
    outputs.push(result.stdout, result.stderr);
  }
  const cases = collectCases(targets, config.unitTestTask);
  return {
    command: commands.join(" && "),
    exitCode,
    outcome: outcomeOf(exitCode, cases),
    cases,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    outputTail: tail(outputs.join("\n")),
  };
}
