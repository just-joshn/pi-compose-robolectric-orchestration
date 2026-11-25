# pi-compose-robolectric-orchestration

A Pi package for Jetpack Compose UI tests that run on the local JVM through Robolectric. You run
one command with a goal. The extension picks the workflow, enforces its steps in code, runs the
tests itself, and writes the final status from what it observed.

```text
/compose-test GreetingTest.namedUserIsGreetedByName fails. Find the root cause and fix it.
```

The final message is always one of these:

```text
compose-test status: VERIFIED     every check passed on the final working tree
compose-test status: BLOCKED      two extension runs could not execute tests (broken build, offline)
compose-test status: INCOMPLETE   the agent stopped, ran out of retries, or was cancelled
```

## What is guaranteed, and what is not

The model does the creative work: reading code, writing tests, finding root causes. The
extension owns everything that decides the outcome:

| Decision | Who makes it |
|---|---|
| Which step comes next | The extension's state machine (`src/workflows.ts`) |
| Which files a step may change | The extension blocks `edit`/`write` outside the step's scope and re-checks the whole tree with git before every step |
| Whether tests pass | The extension runs Gradle with `--rerun` and reads the JUnit XML that run wrote |
| Whether tests can catch a bug | The extension applies the model's proposed break, runs the tests, requires a failure, and restores the file |
| Whether a fix is real | fix-failing runs the final tests against the original production code and requires them to fail there |
| Whether tests were weakened | Lost `@Test` functions, new `@Ignore`, or deleted test files block the run |
| The final status | Built from recorded runs only (`src/report.ts`). Model prose cannot change it |

What code cannot guarantee: that the model finishes, or that it writes the best possible test. If
it stops, crashes, or runs out of retries, the status is INCOMPLETE, never VERIFIED. A test can
satisfy every check and still be narrower than you wanted. The negative control proves it catches
at least one real break of the behavior.

## Install

Requires Pi 1.6 or later, a JDK, and an Android SDK. The project needs a Gradle wrapper, or
set `gradle` in the config below.

```bash
pi install git:github.com/just-joshn/pi-compose-robolectric-orchestration
# or, from a checkout
pi install ./pi-compose-robolectric-orchestration
```

To try it once without installing: `pi -e ./src/index.ts --skill ./skills`.

## Usage

```text
/compose-test <goal and acceptance criteria>             the extension routes it
/compose-test <workflow> <goal>                          you fix the workflow
/compose-test status                                     show the current run and its evidence
/compose-test cancel                                     end the run as INCOMPLETE
```

| Workflow | Use it for | Steps the extension enforces |
|---|---|---|
| `write-test` | New tests for existing or new behavior | explore, write (tests only), verify, negative control |
| `setup` | Adding Robolectric + Compose test infrastructure | explore, configure (build + tests only), verify, negative control |
| `fix-failing` | A failing test | reproduce (must fail), root cause, fix, verify the whole class, regression check |
| `fix-flaky` | An intermittent test | probe N runs, cause, fix, N consecutive passes, negative control |
| `refactor` | Simplifying tests without losing what they verify | passing baseline, edit (tests only), verify, negative control |
| `performance` | Faster tests | measured baseline, optimize, measured after (min. speedup), all baseline tests pass |
| `migrate` | androidTest → Robolectric | explore, migrate (at least as many cases), verify, negative control |
| `review` | Reviewing test changes | read every target, record findings, extension lint |
| `audit` | Checking tests against best practices | read every target, record findings, extension lint |
| `coverage-gaps` | Finding untested behavior | read every target, record findings |

The methodology the agent follows is the `compose-robolectric` skill
(`skills/compose-robolectric/SKILL.md`). It is grounded in developer.android.com and
robolectric.org, and each rule is labeled official or judgment. You can also load the skill on its
own for questions: `/skill:compose-robolectric`.

## Configuration

Optional JSON files: `~/.pi/agent/compose-test.json` (global) and `<project>/.pi/compose-test.json`
(read only for trusted projects, since it can name the Gradle executable). The
`COMPOSE_TEST_GRADLE` environment variable overrides `gradle`.

| Key | Default | Meaning |
|---|---|---|
| `gradle` | wrapper, else `gradle` | Gradle executable when the project has no `gradlew` |
| `unitTestTask` | `testDebugUnitTest` | Unit test task per module |
| `timeoutSeconds` | `1200` | Per Gradle invocation |
| `stressRuns` | `5` | Runs in the fix-flaky probe and stress steps |
| `measureRuns` | `3` | Runs per measurement in performance |
| `minSpeedup` | `0.05` | Required median speedup for performance |
| `maxStalls` | `3` | Stops without progress before INCOMPLETE |
| `maxNudges` | `8` | Continuations per run before INCOMPLETE |
| `maxBacktracks` | `3` | Failed checks that return to an edit step before INCOMPLETE |

The package does not choose models. It uses whatever model the Pi session runs.

## Customizing and extending

- **Methodology**: edit `skills/compose-robolectric/SKILL.md` and its `references/`. The kickoff
  embeds the SKILL.md core rules, and each workflow lists the references it needs.
- **Lint rules**: add an entry to `lineRules` in `src/lint.ts` with a citation. Error-severity
  rules block the edit step, and warnings show up in findings.
- **A new workflow**: add an entry to `workflows` in `src/workflows.ts`. Choose phases from the
  existing kinds (`explore`, `edit`, `findings`, `verify-pass`, `reproduce-fail`, `mutation`,
  `regression`, `probe`, `stress`, `measure`), its allowed changes, and whether it preserves tests.
  The engine, gates, and report pick it up without other changes. Add an eval scenario.
- **Another Gradle task layout**: set `unitTestTask`, for example `testReleaseUnitTest`.

## How it works

See [docs/architecture.md](docs/architecture.md). The pstack analysis behind the design and the
parity matrix are in [docs/pstack-analysis.md](docs/pstack-analysis.md) and
[docs/parity-matrix.md](docs/parity-matrix.md). Verification and review results are in
[docs/verification.md](docs/verification.md) and [docs/review.md](docs/review.md).

## Development

```bash
bun install
bun run typecheck && bun run lint && bun run test:coverage
bun evals/run.ts --concurrency 4            # real pi + Gradle on fixtures/android (needs ANDROID_HOME)
bun evals/run.ts --only fix-failing         # one scenario
python3 evals/trace.py <work>/<scenario>.events.jsonl
```
