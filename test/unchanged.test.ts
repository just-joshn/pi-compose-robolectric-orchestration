import { describe, expect, it } from "vitest";

import { step, WorkflowError } from "../src/engine.ts";
import { currentPhase } from "../src/state.ts";
import { begin, behavior, MAIN_FILE, workspace, write } from "./helpers.ts";

describe("a fix phase that changed nothing since start", () => {
  it("cannot end fix-failing, because a failure that went away by itself is flaky", async () => {
    const root = workspace();
    const { run, d, gradle } = begin(root, { workflow: "fix-failing" }, (_m, _t, call) =>
      call === 1 ? "fail" : "pass",
    );
    const fixing = (await step(run, d)).run;
    expect(currentPhase(fixing)?.id).toBe("fix");
    await expect(step(fixing, d)).rejects.toThrow(WorkflowError);
    await expect(step(fixing, d)).rejects.toThrow(/fails only sometimes.*fix-flaky/);
    expect(gradle.calls).toHaveLength(1);
  });

  it("cannot end fix-flaky, because passing stress runs on the same tree prove nothing", async () => {
    const root = workspace();
    let flaky = true;
    const { run, d, gradle } = begin(root, { workflow: "fix-flaky" }, (main) =>
      flaky ? "flaky" : behavior(main),
    );
    const fixing = (await step(run, d)).run;
    flaky = false;
    await expect(step(fixing, d)).rejects.toThrow(/Nothing changed since start/);
    expect(gradle.calls).toHaveLength(1);
    write(root, MAIN_FILE, 'package a\nfun greeting() = "Hello" // deterministic\n');
    expect(currentPhase((await step(fixing, d)).run)?.kind).toBe("mutation");
  });

  it("cannot end performance's optimize phase, because the timing difference would be noise", async () => {
    const { run, d, gradle } = begin(workspace(), { workflow: "performance" }, () => "pass");
    const optimizing = (await step(run, d)).run;
    expect(currentPhase(optimizing)?.id).toBe("optimize");
    await expect(step(optimizing, d)).rejects.toThrow(/since the baseline measure.*noise/);
    expect(gradle.calls).toHaveLength(3);
  });

  it("still lets a refactor that keeps the tests as they are finish", async () => {
    const { run, d } = begin(workspace(), { workflow: "refactor" });
    const editing = (await step(run, d)).run;
    expect(currentPhase((await step(editing, d)).run)?.kind).toBe("mutation");
  });
});
