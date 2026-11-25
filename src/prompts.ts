import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { routingTable, type WorkflowId, workflows } from "./workflows.ts";

export const skillDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "compose-robolectric",
);

const methodology = () =>
  readFileSync(join(skillDir, "SKILL.md"), "utf8")
    .replace(/^---[\s\S]*?---\n/, "")
    .split("## References")[0]
    ?.trim() ?? "";

export function kickoff(goal: string, forced: WorkflowId | null): string {
  const routing = forced
    ? `The operator selected the ${forced} workflow: ${workflows[forced].trigger}`
    : `Pick the workflow whose trigger matches the request:\n${routingTable()}\nIf the request is ambiguous, choose the workflow that matches the operator's acceptance criteria, and state the choice in one sentence.`;
  return [
    `compose-test request: ${goal}`,
    "",
    "Restate the goal and the smallest change that meets it in one sentence. Then:",
    routing,
    "Find the target files (read and grep), then call compose_test_start. Until then, files cannot be edited.",
    "The extension owns the workflow. It decides each phase, runs Gradle tests itself, applies and reverts negative-control mutations, and writes the final status. Your prose cannot change that status, so report only what the tools returned.",
    "",
    "Core rules (the compose-robolectric skill's SKILL.md body, already loaded here, so do not read SKILL.md again):",
    methodology(),
    "",
    `Reference files live in ${join(skillDir, "references")}. compose_test_start names the ones that apply; read one only when you need its detail.`,
  ].join("\n");
}

export const referencePaths = (workflow: WorkflowId) =>
  workflows[workflow].references.map((file) => join(skillDir, "references", file));
