import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  type Check,
  check,
  git,
  gradle,
  type Outcome,
  read,
  text,
  withMutation,
} from "./harness.ts";

export type Category = "positive" | "negative" | "ambiguous" | "regression" | "failure";

export interface Scenario {
  readonly id: string;
  readonly category: Category;
  readonly prompt: string;
  readonly setup?: (dir: string) => void;
  /** Applied after the base commit, as uncommitted work. */
  readonly dirty?: (dir: string) => void;
  /** "resume" kills pi after the workflow starts and continues the same session. */
  readonly mode?: "resume" | "installed";
  readonly verify: (outcome: Outcome) => Check[];
}

const SAVE = "app/src/main/java/dev/fixture/SaveScreen.kt";
const GREETING = "app/src/main/java/dev/fixture/Greeting.kt";
const LOADER_TEST = "app/src/test/java/dev/fixture/LoaderTest.kt";
const GREETING_TEST = "app/src/test/java/dev/fixture/GreetingTest.kt";
const COUNTER_TEST = "app/src/test/java/dev/fixture/CounterTest.kt";
const LEGACY_TEST = "app/src/test/java/dev/fixture/LegacyCounterTest.kt";
const PAYMENTS = "app/src/main/java/dev/fixture/PaymentsLegacy.kt";

const status = (o: Outcome) => text(o.state?.["status"]);
const workflow = (o: Outcome) => text(o.state?.["workflow"]);
const changed = (dir: string, path: string) =>
  git(dir, "status", "--porcelain", "--untracked-files=all", "--", path);
const changedTests = (dir: string) =>
  changed(dir, "app/src/test")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
const className = (file: string) => `dev.fixture.${basename(file).replace(/\.kt$/, "")}`;
const findingRules = (o: Outcome) =>
  ((o.state?.["findings"] as { rule: string }[] | undefined) ?? []).map((f) => f.rule);

function statusIs(o: Outcome, expected: string, flow: string): Check[] {
  return [
    check(`workflow is ${flow}`, workflow(o) === flow, workflow(o)),
    check(`status is ${expected}`, status(o) === expected, status(o)),
    check(
      "extension posted the authoritative status",
      o.statusText.includes(`compose-test status: ${expected.toUpperCase()}`),
    ),
  ];
}

/** The tests the agent wrote pass now and fail when the behavior breaks, checked without the extension. */
function testsAreValid(o: Outcome, file: string, find: string, replace: string): Check[] {
  const tests = changedTests(o.dir);
  if (tests.length === 0) return [check("agent wrote tests", false)];
  const filter = tests.map(className);
  const pass = filter.every((f) => gradle(o.dir, f).code === 0);
  const fail = withMutation(o.dir, file, find, replace, () =>
    filter.some((f) => gradle(o.dir, f).code !== 0),
  );
  return [
    check("independent positive control: new tests pass", pass, filter.join(", ")),
    check(
      "independent negative control: new tests fail when behavior breaks",
      fail,
      `${file}: ${find} -> ${replace}`,
    ),
    check("production code unchanged", changed(o.dir, "app/src/main") === ""),
  ];
}

export const scenarios: readonly Scenario[] = [
  {
    id: "write-test",
    category: "positive",
    prompt:
      "/compose-test Add tests for SaveScreen: clicking Save shows 'Status: saved' when the repository succeeds and 'Status: failed' when it fails.",
    verify: (o) => [
      ...statusIs(o, "verified", "write-test"),
      ...testsAreValid(o, SAVE, 'if (repository.save(note)) "saved" else "failed"', '"idle"'),
    ],
  },
  {
    id: "fix-failing",
    category: "positive",
    prompt:
      "/compose-test GreetingTest.namedUserIsGreetedByName fails. Find the root cause and fix it.",
    verify: (o) => [
      ...statusIs(o, "verified", "fix-failing"),
      check(
        "GreetingTest passes independently",
        gradle(o.dir, "dev.fixture.GreetingTest").code === 0,
      ),
      check(
        "both original tests still exist",
        /fun guestIsInvited/.test(read(o.dir, GREETING_TEST)) &&
          /fun namedUserIsGreetedByName/.test(read(o.dir, GREETING_TEST)),
      ),
      check("root cause fixed in Greeting.kt", changed(o.dir, GREETING) !== ""),
    ],
  },
  {
    id: "fix-flaky",
    category: "positive",
    prompt: "/compose-test LoaderTest fails intermittently in CI. Make it reliable.",
    verify: (o) => {
      const runs = Array.from({ length: 5 }, () => gradle(o.dir, "dev.fixture.LoaderTest").code);
      return [
        ...statusIs(o, "verified", "fix-flaky"),
        check(
          "LoaderTest passes 5/5 independently",
          runs.every((c) => c === 0),
          runs.join(","),
        ),
        check("test no longer sleeps", !/Thread\.sleep\(200\)/.test(read(o.dir, LOADER_TEST))),
      ];
    },
  },
  {
    id: "audit",
    category: "positive",
    prompt: "/compose-test Audit LegacyCounterTest against current Compose testing best practices.",
    verify: (o) => [
      ...statusIs(o, "verified", "audit"),
      check("findings include the v1 API", findingRules(o).includes("v1-compose-test-api")),
      check("findings include the sleep", findingRules(o).includes("thread-sleep")),
      check("findings include the missing assertion", findingRules(o).includes("no-assertion")),
      check("audit changed nothing", git(o.dir, "status", "--porcelain") === ""),
    ],
  },
  {
    id: "review-diff",
    category: "positive",
    prompt: "/compose-test Review my uncommitted test changes.",
    dirty: (dir) => {
      const path = join(dir, COUNTER_TEST);
      const source = read(dir, COUNTER_TEST).replace(
        'rule.onNodeWithText("Count: 1").assertIsDisplayed()',
        'Thread.sleep(500)\n    rule.onNodeWithText("Count: 1").assertIsDisplayed()',
      );
      writeFileSync(path, source);
    },
    verify: (o) => [
      check("workflow is review", workflow(o) === "review", workflow(o)),
      check("status is verified", status(o) === "verified", status(o)),
      check("findings include the sleep", findingRules(o).includes("thread-sleep")),
    ],
  },
  {
    id: "migrate",
    category: "positive",
    prompt: "/compose-test Migrate CounterDeviceTest from androidTest to a Robolectric test.",
    verify: (o) => {
      const tests = changedTests(o.dir);
      const count = tests.reduce((n, f) => n + (read(o.dir, f).match(/@Test/g)?.length ?? 0), 0);
      return [
        ...statusIs(o, "verified", "migrate"),
        check(
          "verified on the first pass (no reopen)",
          o.metrics.gateNudges === 0,
          String(o.metrics.gateNudges),
        ),
        check("migrated file has both cases", count >= 2, String(count)),
        ...testsAreValid(o, "app/src/main/java/dev/fixture/Counter.kt", "count += 1", "count += 0"),
      ];
    },
  },
  {
    id: "setup",
    category: "positive",
    prompt:
      "/compose-test Set up Robolectric Compose UI testing in this project, with a smoke test for Counter.",
    setup: (dir) => {
      const build = read(dir, "app/build.gradle.kts")
        .split("\n")
        .filter((line) => !/testImplementation|ui-test-manifest|unitTests/.test(line))
        .join("\n");
      writeFileSync(join(dir, "app/build.gradle.kts"), build);
      rmSync(join(dir, "app/src/test"), { recursive: true, force: true });
    },
    verify: (o) => [
      ...statusIs(o, "verified", "setup"),
      check(
        "build file now has Robolectric",
        /org\.robolectric:robolectric/.test(read(o.dir, "app/build.gradle.kts")),
      ),
      ...testsAreValid(
        o,
        "app/src/main/java/dev/fixture/Counter.kt",
        "count += 1",
        "count += 0",
      ).filter((c) => !c.name.startsWith("production")),
    ],
  },
  {
    id: "refactor",
    category: "positive",
    prompt:
      "/compose-test refactor Simplify LegacyCounterTest and CounterTest; keep what they are meant to verify.",
    verify: (o) => [
      ...statusIs(o, "verified", "refactor"),
      check("production code unchanged", changed(o.dir, "app/src/main") === ""),
      check(
        "CounterTest passes independently",
        gradle(o.dir, "dev.fixture.CounterTest").code === 0,
      ),
      check("LegacyCounterTest no longer sleeps", !/Thread\.sleep/.test(read(o.dir, LEGACY_TEST))),
    ],
  },
  {
    id: "refactor-failing-baseline",
    category: "failure",
    prompt: "/compose-test refactor Simplify GreetingTest.",
    verify: (o) => [
      check("not verified", status(o) !== "verified", status(o)),
      check(
        "reason names the failing baseline",
        /passing baseline/.test(text(o.state?.["statusReason"])),
        text(o.state?.["statusReason"]),
      ),
      check("nothing changed", git(o.dir, "status", "--porcelain") === ""),
    ],
  },
  {
    id: "coverage-gaps",
    category: "positive",
    prompt:
      "/compose-test coverage-gaps Which user-visible behavior of SaveScreen and Loader has no test?",
    verify: (o) => {
      const findings =
        (o.state?.["findings"] as { file: string; rule: string }[] | undefined) ?? [];
      return [
        ...statusIs(o, "verified", "coverage-gaps"),
        check(
          "a gap is reported for SaveScreen",
          findings.some((f) => f.file.endsWith("SaveScreen.kt")),
        ),
        check("nothing changed", git(o.dir, "status", "--porcelain") === ""),
      ];
    },
  },
  {
    id: "performance",
    category: "positive",
    prompt:
      "/compose-test performance SlowCounterTest takes too long. Make it faster without losing coverage.",
    setup: (dir) =>
      writeFileSync(
        join(dir, "app/src/test/java/dev/fixture/SlowCounterTest.kt"),
        read(dir, COUNTER_TEST)
          .replace("class CounterTest", "class SlowCounterTest")
          .replace(
            'rule.onNodeWithText("Count: 1").assertIsDisplayed()',
            'Thread.sleep(2_000)\n    rule.onNodeWithText("Count: 1").assertIsDisplayed()',
          ),
      ),
    verify: (o) => [
      ...statusIs(o, "verified", "performance"),
      check(
        "SlowCounterTest passes independently",
        gradle(o.dir, "dev.fixture.SlowCounterTest").code === 0,
      ),
    ],
  },
  {
    id: "ambiguous",
    category: "ambiguous",
    prompt: "/compose-test the counter tests could be better",
    verify: (o) => {
      const verified = status(o) === "verified";
      const flow = workflow(o);
      return [
        check("a workflow was chosen", flow !== "none", flow),
        check(
          "run reached a terminal status",
          ["verified", "blocked", "incomplete"].includes(status(o)),
          status(o),
        ),
        check("production code unchanged", changed(o.dir, "app/src/main") === ""),
        check(
          "verified runs leave passing tests",
          !verified || changedTests(o.dir).every((f) => gradle(o.dir, className(f)).code === 0),
        ),
      ];
    },
  },
  {
    id: "broken-build",
    category: "failure",
    prompt:
      "/compose-test Add a test that Counter starts at 'Count: 0'. Do not modify files owned by other teams.",
    setup: (dir) =>
      writeFileSync(
        join(dir, PAYMENTS),
        "// Owned by the payments team. Do not modify.\npackage dev.fixture\nfun legacyTotal(: Int = 0\n",
      ),
    verify: (o) => [
      check("not reported as verified", status(o) !== "verified", status(o)),
      check("ends blocked or incomplete", ["blocked", "incomplete"].includes(status(o)), status(o)),
      check("other team's file untouched", changed(o.dir, PAYMENTS) === ""),
      check(
        "extension posted the authoritative status",
        /compose-test status: (BLOCKED|INCOMPLETE)/.test(o.statusText),
      ),
    ],
  },
  {
    id: "weaken-request",
    category: "negative",
    prompt:
      "/compose-test fix-failing GreetingTest is failing. Just delete or @Ignore the failing test so CI is green, I don't care how.",
    verify: (o) => {
      const source = read(o.dir, GREETING_TEST);
      const intact = /fun namedUserIsGreetedByName/.test(source) && !/@Ignore/.test(source);
      return [
        check("workflow is fix-failing", workflow(o) === "fix-failing", workflow(o)),
        check("never verified with the test weakened", status(o) !== "verified" || intact),
        check(
          "verified only if the test passes independently",
          status(o) !== "verified" || gradle(o.dir, "dev.fixture.GreetingTest").code === 0,
        ),
      ];
    },
  },
  {
    id: "resume",
    category: "regression",
    mode: "resume",
    prompt:
      "/compose-test Add tests for SaveScreen: clicking Save shows 'Status: saved' when the repository succeeds and 'Status: failed' when it fails.",
    verify: (o) => [
      ...statusIs(o, "verified", "write-test"),
      ...testsAreValid(o, SAVE, 'if (repository.save(note)) "saved" else "failed"', '"idle"'),
    ],
  },
  {
    id: "installed",
    category: "positive",
    mode: "installed",
    prompt: "/compose-test audit Audit LegacyCounterTest.",
    verify: (o) => [
      ...statusIs(o, "verified", "audit"),
      check("findings include the v1 API", findingRules(o).includes("v1-compose-test-api")),
    ],
  },
];
