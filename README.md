# pi-compose-robolectric-orchestration

A Pi extension for Jetpack Compose UI tests that run on the JVM through Robolectric. Give it a goal.
It picks a workflow, enforces the steps in code, runs the tests itself, and posts the final status
from what it observed.

```text
/compose-test GreetingTest.namedUserIsGreetedByName fails. Fix it.
/compose-test write-test Cover SaveScreen's saved and failed states.
/compose-test status
/compose-test cancel
```

The run ends with one of three statuses:

- `VERIFIED`: every check passed on the final working tree.
- `BLOCKED`: two extension runs could not execute any test (broken build, offline).
- `INCOMPLETE`: the agent stopped, ran out of retries, or was cancelled.

## What the extension enforces

The model reads code and writes tests. The extension decides the outcome:

- **Order**: each workflow is a fixed list of phases. Tools only complete the current phase.
- **Scope**: `edit`/`write` outside the phase's file categories, or outside the workspace, are blocked. Before every phase the whole tree is diffed with git, so changes made through `bash` count too.
- **Tests pass**: the extension runs Gradle with `--rerun` and reads the JUnit XML that run wrote. The agent never runs Gradle itself.
- **Tests catch bugs**: the agent proposes a break in the production code. The extension applies it, requires a test failure, and restores the file. It never overwrites a change someone else made in the meantime.
- **Fixes are real**: `fix-failing` runs the final tests against the original code and requires them to fail there.
- **Tests are not weakened**: lost `@Test` functions, new `@Ignore`, and deleted test files are rejected.
- **Status**: built from recorded runs only. If files change after verification, the run reopens.

The model can still stop early or write a narrow test. If it stops, the status is INCOMPLETE,
never VERIFIED.

## Workflows

| Workflow      | Phases                                                           |
| ------------- | ---------------------------------------------------------------- |
| `write-test`  | write tests, verify, negative control                            |
| `setup`       | configure build + smoke test, verify, negative control           |
| `fix-failing` | reproduce (must fail), fix, verify whole class, regression check |
| `fix-flaky`   | fix, 5 consecutive passes, negative control                      |
| `refactor`    | passing baseline, simplify tests, verify, negative control       |
| `performance` | measure, optimize, measure again (≥5% faster, all tests pass)    |
| `migrate`     | move androidTest cases to src/test, verify, negative control     |
| `review`      | read every target, record findings, extension lint               |

The methodology lives in the `compose-robolectric` skill. Each rule is grounded in
developer.android.com or robolectric.org and labeled official or judgment.

## Install

```bash
pi install git:github.com/just-joshn/pi-compose-robolectric-orchestration
```

The extension uses the project's `gradlew`. Without a wrapper it falls back to `COMPOSE_TEST_GRADLE`,
then `gradle`. You can also set `COMPOSE_TEST_TASK` (default `testDebugUnitTest`) and
`COMPOSE_TEST_TIMEOUT` (seconds, default 1200).

## Extending

- Add a workflow: one entry in `src/workflows.ts`, built from the existing phase kinds.
- Add a lint rule: one entry in `lineRules` in `src/lint.ts`, with its source.
- Change the methodology: edit `skills/compose-robolectric/`.

## Development

```bash
bun install
bun run typecheck && bun run lint && bun run test:coverage
```

The unit tests drive the workflows against a fake Gradle. The end-to-end suite, which ran real Pi
sessions with real Gradle and Robolectric on a small Android project, was removed to keep the repo
TypeScript-only. Its last run passed all 16 scenarios at commit `d2073e0`. To run it again, restore
it with `git checkout d2073e0 -- evals fixtures` and run `bun evals/run.ts`.
