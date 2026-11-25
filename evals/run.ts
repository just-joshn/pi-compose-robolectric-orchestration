/**
 * End-to-end evaluation: runs each scenario through a real `pi` process against a copy of the
 * Android fixture, then checks the result independently of the extension.
 *
 *   bun evals/run.ts [--only id,id] [--model provider/id] [--concurrency 3] [--out dir]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { type Check, check, type Metrics, type Outcome, prepare, repo, runPi } from "./harness.ts";
import { type Scenario, scenarios } from "./scenarios.ts";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    model: { type: "string" },
    concurrency: { type: "string", default: "3" },
    timeout: { type: "string", default: "1200" },
    out: { type: "string", default: join(repo, "evals", "results") },
  },
});

const work = mkdtempSync(join(tmpdir(), "compose-test-eval-"));
const timeoutSeconds = Number(values.timeout);
const selected = values.only ? scenarios.filter((s) => values.only?.split(",").includes(s.id)) : scenarios;

function installedAgentDir(): string {
  const agentDir = join(work, "agent");
  mkdirSync(agentDir, { recursive: true });
  for (const file of ["auth.json", "models.json"]) {
    const source = join(homedir(), ".pi", "agent", file);
    if (existsSync(source)) copyFileSync(source, join(agentDir, file));
  }
  const user = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: user["defaultProvider"], defaultModel: user["defaultModel"] }));
  return agentDir;
}

function install(agentDir: string): Check[] {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  const installed = spawnSync("pi", ["install", repo], { env, encoding: "utf8" });
  const listed = spawnSync("pi", ["list"], { env, encoding: "utf8" });
  return [
    check("pi install exits 0", installed.status === 0, `${installed.stdout}${installed.stderr}`.trim().slice(-300)),
    check("pi list shows the package", listed.stdout.includes(repo), listed.stdout.trim().slice(-300)),
  ];
}

const sum = (a: Metrics, b: Metrics): Metrics => ({
  turns: a.turns + b.turns,
  toolCalls: a.toolCalls + b.toolCalls,
  toolsByName: Object.fromEntries(
    [...new Set([...Object.keys(a.toolsByName), ...Object.keys(b.toolsByName)])].map((k) => [k, (a.toolsByName[k] ?? 0) + (b.toolsByName[k] ?? 0)]),
  ),
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  gradleRuns: Math.max(a.gradleRuns, b.gradleRuns),
  gateNudges: a.gateNudges + b.gateNudges,
});

async function execute(scenario: Scenario): Promise<{ outcome: Outcome; extra: Check[] }> {
  const dir = join(work, scenario.id);
  prepare(dir, scenario.setup);
  scenario.dirty?.(dir);
  const base = { timeoutSeconds, ...(values.model ? { model: values.model } : {}) };
  if (scenario.mode === "installed") {
    const agentDir = installedAgentDir();
    const extra = install(agentDir);
    return { outcome: await runPi(dir, scenario.prompt, { ...base, installed: { agentDir } }), extra };
  }
  if (scenario.mode === "resume") {
    const sessionDir = join(work, `${scenario.id}.sessions`);
    const first = await runPi(dir, scenario.prompt, {
      ...base,
      sessionDir,
      killWhen: (e) => e["type"] === "tool_execution_end" && e["toolName"] === "compose_test_step",
    });
    const interrupted = first.state?.["status"] === "active";
    const second = await runPi(dir, "Continue.", { ...base, sessionDir, continueSession: true });
    const outcome = { ...second, state: second.state ?? first.state, wallSeconds: first.wallSeconds + second.wallSeconds, metrics: sum(first.metrics, second.metrics) };
    return { outcome, extra: [check("first process was interrupted mid-workflow", interrupted, String(first.state?.["status"]))] };
  }
  return { outcome: await runPi(dir, scenario.prompt, base), extra: [] };
}

interface Result {
  readonly id: string;
  readonly category: string;
  readonly pass: boolean;
  readonly checks: Check[];
  readonly status: string;
  readonly workflow: string;
  readonly wallSeconds: number;
  readonly metrics: Metrics;
  readonly dir: string;
}

async function evaluate(scenario: Scenario): Promise<Result> {
  const { outcome, extra } = await execute(scenario);
  const checks = [...extra, ...scenario.verify(outcome)];
  const result = {
    id: scenario.id,
    category: scenario.category,
    pass: checks.every((c) => c.pass),
    checks,
    status: String(outcome.state?.["status"] ?? "none"),
    workflow: String(outcome.state?.["workflow"] ?? "none"),
    wallSeconds: Math.round(outcome.wallSeconds),
    metrics: outcome.metrics,
    dir: outcome.dir,
  };
  process.stdout.write(`${result.pass ? "PASS" : "FAIL"} ${scenario.id} (${result.status}, ${result.wallSeconds}s)\n`);
  for (const c of checks.filter((x) => !x.pass)) process.stdout.write(`  ✗ ${c.name} ${c.detail ?? ""}\n`);
  return result;
}

async function pool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

function markdown(results: readonly Result[], model: string) {
  const rows = results.map((r) => {
    const m = r.metrics;
    return `| ${r.id} | ${r.category} | ${r.pass ? "PASS" : "FAIL"} | ${r.workflow} | ${r.status} | ${r.wallSeconds} | ${m.turns} | ${m.toolCalls} | ${m.gradleRuns} | ${m.gateNudges} | ${m.inputTokens} | ${m.cacheReadTokens} | ${m.outputTokens} |`;
  });
  const failures = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `- ${r.id}: ${c.name} ${c.detail ?? ""}`));
  return [
    `# Evaluation results`,
    "",
    `Date: ${new Date().toISOString()}  Model: ${model}  Passed: ${results.filter((r) => r.pass).length}/${results.length}`,
    "",
    "| scenario | category | result | workflow | status | wall s | turns | tool calls | gradle runs | gate nudges | input tok | cache read tok | output tok |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## Failed checks",
    "",
    ...(failures.length ? failures : ["none"]),
    "",
  ].join("\n");
}

const results = await pool(selected, Number(values.concurrency), evaluate);
mkdirSync(values.out, { recursive: true });
const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
const model = values.model ?? "default";
writeFileSync(join(values.out, `${stamp}.json`), JSON.stringify({ model, results }, null, 2));
writeFileSync(join(values.out, `${stamp}.md`), markdown(results, model));
process.stdout.write(`\n${markdown(results, model)}\nWork dir: ${work}\n`);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
