import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";

import { isRecord, isString } from "./guards.ts";

const groovyString = (text: string) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/**
 * `-p <module>` also runs the task in child projects, whose tests never match the filters. Each
 * Test task that runs records its project, its JUnit XML directory and its root suite's time, which
 * spans every test class, class-level setup included. It first deletes its old reports: Gradle
 * replaces them only after the tests, so a run killed in between, or one with XML reports turned
 * off, would leave them.
 */
export const initScript = (record: string) => `allprojects {
  tasks.withType(Test).configureEach { task ->
    filter.failOnNoMatchingTests = false
    def facts = [task: task.name, project: task.project.projectDir.path]
    def xml = task.reports.junitXml.outputLocation
    beforeSuite { suite ->
      if (suite.parent == null) xml.get().asFile.listFiles()?.findAll { it.name.startsWith('TEST-') }*.delete()
    }
    afterSuite { suite, result ->
      if (suite.parent == null) new File(${groovyString(record)}) << groovy.json.JsonOutput.toJson(facts + [xml: xml.get().asFile.path, ms: result.endTime - result.startTime]) + '\\n'
    }
  }
}
`;

interface TaskRecord {
  readonly task: string;
  readonly project: string;
  readonly xml: string;
  readonly ms: number;
}

const isTaskRecord = (v: unknown): v is TaskRecord =>
  isRecord(v) &&
  ["task", "project", "xml"].every((k) => isString(v[k])) &&
  typeof v["ms"] === "number";

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Gradle records canonical project directories. */
const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/**
 * Consume the record and return what the module's own `task` recorded, if it ran. A line a kill
 * cut short is skipped.
 */
export function takeOwnTask(record: string, task: string, module: string): TaskRecord | undefined {
  const text = existsSync(record) ? readFileSync(record, "utf8") : "";
  rmSync(record, { force: true });
  const dir = canonical(module);
  return text
    .split("\n")
    .map(parseLine)
    .filter(isTaskRecord)
    .find((r) => r.task === task && canonical(r.project) === dir);
}
