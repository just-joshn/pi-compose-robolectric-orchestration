import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  /** Gradle executable used when the project has no gradlew wrapper. */
  readonly gradle: string | undefined;
  readonly unitTestTask: string;
  readonly timeoutSeconds: number;
  readonly stressRuns: number;
  readonly measureRuns: number;
  /** Fractional speedup the performance workflow must reach, e.g. 0.05 for 5%. */
  readonly minSpeedup: number;
  /** Settle boundaries without progress before a run ends as incomplete. */
  readonly maxStalls: number;
  /** Failed checks that send a run back to an edit phase before it ends as incomplete. */
  readonly maxBacktracks: number;
  /** Settle continuations per run, progress or not, before it ends as incomplete. */
  readonly maxNudges: number;
}

export const defaults: Config = {
  gradle: undefined,
  unitTestTask: "testDebugUnitTest",
  timeoutSeconds: 1200,
  stressRuns: 5,
  measureRuns: 3,
  minSpeedup: 0.05,
  maxStalls: 3,
  maxBacktracks: 3,
  maxNudges: 8,
};

const positiveInteger = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** Parse one config object; unknown keys and invalid values are reported, never silently used. */
export function parseConfig(value: unknown, origin: string): Partial<Config> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${origin}: expected a JSON object.`);
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const valid =
      key === "gradle" || key === "unitTestTask"
        ? typeof raw === "string" && raw.length > 0
        : key === "minSpeedup"
          ? typeof raw === "number" && raw >= 0 && raw < 1
          : key in defaults && positiveInteger(raw);
    if (!(key in defaults)) throw new Error(`${origin}: unknown key "${key}".`);
    if (!valid) throw new Error(`${origin}: invalid value for "${key}".`);
    out[key] = raw;
  }
  return out as Partial<Config>;
}

function readConfigFile(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  return parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
}

/**
 * Global config, then project config (only for trusted projects, since it can name the Gradle
 * executable), then the COMPOSE_TEST_GRADLE environment variable.
 */
export function loadConfig(cwd: string, projectTrusted: boolean, env = process.env): Config {
  const global = readConfigFile(join(homedir(), ".pi", "agent", "compose-test.json"));
  const project = projectTrusted ? readConfigFile(join(cwd, ".pi", "compose-test.json")) : {};
  const gradle = env["COMPOSE_TEST_GRADLE"];
  return { ...defaults, ...global, ...project, ...(gradle ? { gradle } : {}) };
}

/** Config for code paths that must not fail, such as the settle gate: errors fall back to defaults. */
export function safeConfig(
  cwd: string,
  projectTrusted: boolean,
): { config: Config; error?: string } {
  try {
    return { config: loadConfig(cwd, projectTrusted) };
  } catch (error) {
    return { config: defaults, error: error instanceof Error ? error.message : String(error) };
  }
}
