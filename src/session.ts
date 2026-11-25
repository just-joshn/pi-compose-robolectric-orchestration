import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.ts";
import type { Deps } from "./engine.ts";
import type { Exec } from "./runner.ts";
import { parseRun, type Run } from "./state.ts";
import { releaseLock, stateDir } from "./workspace.ts";

export const STATE_ENTRY = "compose-test-state";

/** Holds the run for the current session branch and persists every change to it. */
export class Session {
  private current: Run | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  settledRevision = -1;

  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  get run(): Run | null {
    return this.current;
  }

  set(run: Run): Run {
    this.current = run;
    this.pi.appendEntry(STATE_ENTRY, run);
    return run;
  }

  /** Rebuild from the latest persisted state on the active branch; abandoned branches are ignored. */
  restore(ctx: ExtensionContext): void {
    let found: Run | null = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY)
        found = parseRun(entry.data) ?? found;
    }
    this.current = found;
    this.settledRevision = -1;
  }

  /** Serialize operations that run Gradle or mutate files, even when tool calls run in parallel. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  deps(ctx: ExtensionContext, signal?: AbortSignal): Deps {
    const exec: Exec = async (command, args, options) => {
      const result = await this.pi.exec(command, [...args], {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { code: result.code, stdout: result.stdout, stderr: result.stderr };
    };
    return {
      cwd: ctx.cwd,
      exec,
      config: loadConfig(ctx.cwd, ctx.isProjectTrusted()),
      dir: stateDir(ctx.cwd),
      ...(signal ? { signal } : {}),
    };
  }

  release(ctx: ExtensionContext): void {
    releaseLock(stateDir(ctx.cwd), ctx.sessionManager.getSessionId());
  }
}
