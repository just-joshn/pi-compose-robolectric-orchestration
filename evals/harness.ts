import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const repo = join(import.meta.dirname, "..");
export const fixture = join(repo, "fixtures", "android");

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail?: string;
}

export interface Outcome {
  readonly dir: string;
  readonly events: Record<string, unknown>[];
  readonly state: Record<string, unknown> | null;
  readonly statusText: string;
  readonly exitCode: number | null;
  readonly wallSeconds: number;
  readonly metrics: Metrics;
}

export interface Metrics {
  readonly turns: number;
  readonly toolCalls: number;
  readonly toolsByName: Record<string, number>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly gradleRuns: number;
  readonly gateNudges: number;
}

/** Copy the fixture into a fresh git repository so every scenario starts from the same commit. */
export function prepare(dir: string, setup?: (dir: string) => void) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, {
    recursive: true,
    filter: (src) => !/\/(build|\.gradle|\.kotlin)(\/|$)|local\.properties$/.test(src),
  });
  writeFileSync(join(dir, "local.properties"), `sdk.dir=${process.env["ANDROID_HOME"] ?? ""}\n`);
  setup?.(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=eval@local", "-c", "user.name=eval", "-c", "core.autocrlf=false", "commit", "-qm", "base");
}

export interface PiOptions {
  readonly model?: string;
  readonly installed?: { agentDir: string };
  readonly sessionDir?: string;
  readonly continueSession?: boolean;
  readonly timeoutSeconds: number;
  /** Kill pi once this predicate matches an event; used to simulate an interruption. */
  readonly killWhen?: (event: Record<string, unknown>) => boolean;
}

function piArgs(prompt: string, options: PiOptions): string[] {
  const args = ["-p", "--mode", "json", "-nc", "--no-prompt-templates"];
  if (!options.installed)
    args.push("--no-extensions", "-e", join(repo, "src", "index.ts"), "--no-skills", "--skill", join(repo, "skills"));
  args.push(...(options.sessionDir ? ["--session-dir", options.sessionDir] : ["--no-session"]));
  if (options.continueSession) args.push("-c");
  if (options.model) args.push("--model", options.model);
  args.push(prompt);
  return args;
}

export function runPi(dir: string, prompt: string, options: PiOptions): Promise<Outcome> {
  const started = Date.now();
  const env = { ...process.env, ...(options.installed ? { PI_CODING_AGENT_DIR: options.installed.agentDir } : {}) };
  const child = spawn("pi", piArgs(prompt, options), { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  const events: Record<string, unknown>[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        events.push(event);
        if (options.killWhen?.(event)) child.kill("SIGTERM");
      } catch {
        // Non-JSON output lines are ignored.
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutSeconds * 1000);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      const name = dir.split("/").at(-1) ?? "run";
      const suffix = options.continueSession ? ".continued" : "";
      writeFileSync(join(dir, "..", `${name}${suffix}.stderr.log`), stderr);
      writeFileSync(join(dir, "..", `${name}${suffix}.events.jsonl`), events.map((e) => JSON.stringify(e)).join("\n"));
      resolve(summarize(dir, events, code, (Date.now() - started) / 1000));
    });
  });
}

const entryOf = (event: Record<string, unknown>) =>
  event["type"] === "entry_appended" ? (event["entry"] as Record<string, unknown>) : undefined;

function summarize(dir: string, events: Record<string, unknown>[], exitCode: number | null, wallSeconds: number): Outcome {
  let state: Record<string, unknown> | null = null;
  let statusText = "";
  const toolsByName: Record<string, number> = {};
  const metrics = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, gateNudges: 0 };
  for (const event of events) {
    const entry = entryOf(event);
    if (entry?.["type"] === "custom" && entry["customType"] === "compose-test-state") state = entry["data"] as Record<string, unknown>;
    if (entry?.["type"] === "custom_message" && entry["customType"] === "compose-test-status") statusText = String(entry["content"]);
    if (entry?.["type"] === "custom_message" && entry["customType"] === "compose-test-gate") metrics.gateNudges++;
    if (event["type"] === "tool_execution_start") {
      const name = String(event["toolName"]);
      toolsByName[name] = (toolsByName[name] ?? 0) + 1;
      metrics.toolCalls++;
    }
    const message = event["message"] as Record<string, unknown> | undefined;
    if (event["type"] === "message_end" && message?.["role"] === "assistant") {
      metrics.turns++;
      const usage = (message["usage"] ?? {}) as Record<string, number>;
      metrics.inputTokens += usage["input"] ?? 0;
      metrics.outputTokens += usage["output"] ?? 0;
      metrics.cacheReadTokens += usage["cacheRead"] ?? 0;
    }
  }
  const runs = (state?.["runs"] as unknown[] | undefined)?.length ?? 0;
  return { dir, events, state, statusText, exitCode, wallSeconds, metrics: { ...metrics, toolsByName, gradleRuns: runs } };
}

/** Independent Gradle run: does not use the extension. Returns exit code and per-test results. */
export function gradle(dir: string, filter: string) {
  const result = spawnSync("./gradlew", ["-q", "--console=plain", ":app:testDebugUnitTest", "--rerun", "--tests", filter], {
    cwd: dir,
    encoding: "utf8",
  });
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

export const git = (dir: string, ...args: string[]) =>
  spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();

export const read = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "");

/** Temporarily replace text in a file, run `work`, and restore the file. */
export function withMutation<T>(dir: string, file: string, find: string, replace: string, work: () => T): T {
  const original = read(dir, file);
  if (!original.includes(find)) throw new Error(`${file} does not contain ${find}`);
  writeFileSync(join(dir, file), original.replace(find, replace));
  try {
    return work();
  } finally {
    writeFileSync(join(dir, file), original);
  }
}

export const check = (name: string, pass: boolean, detail?: string): Check => ({ name, pass, ...(detail ? { detail } : {}) });
