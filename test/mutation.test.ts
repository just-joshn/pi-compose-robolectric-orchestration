import { describe, expect, it } from "vitest";

import { mutate, step } from "../src/engine.ts";
import { begin, MAIN_FILE, read, workspace } from "./helpers.ts";

describe("a negative control's replacement", () => {
  it("is inserted literally, even when it contains $& or $'", async () => {
    const root = workspace();
    const original = read(root, MAIN_FILE);
    const compiled: string[] = [];
    const { run, d } = begin(root, {}, (main) => {
      compiled.push(main);
      return main.includes('"Hello"') ? "pass" : "fail";
    });
    const verified = (await step(run, d)).run;
    const replace = `"$&$'"`;
    const done = await mutate(verified, { file: MAIN_FILE, find: '"Hello"', replace }, d);
    expect(compiled.at(-1)).toBe(original.split('"Hello"').join(replace));
    expect(done.run.status).toBe("verified");
  });
});
