# Verification results

All numbers come from runs on 2026-11-25. Machine: macOS, JDK 25.0.5, Gradle 9.8.0 (fixture
wrapper), Android SDK platform 37.2, Pi 1.6.1, model `openai-codex/gpt-6.2-sol` (the user default).

## Automated checks

| Check | Command | Result |
|---|---|---|
| Type check | `bun run typecheck` | 0 errors |
| Lint | `bun run lint` | 0 errors (remaining warnings are sequential `await` in loops by design, and assertions on parsed JSON) |
| Unit and integration tests | `bun run test:coverage` | 92 passed. Coverage 96% statements, 89% branches, per-file thresholds of 80% met |
| Format | `bun fmt --check` | Package files formatted. `.oxlintrc.json` and `bunfig.toml` were already unformatted in the initial commit and were left untouched |

The unit suite includes `test/review-findings.test.ts`, one regression test per confirmed
adversarial finding (docs/review.md).

## End-to-end evaluation (real Pi, real Gradle, real Robolectric)

`bun evals/run.ts --concurrency 4` copies `fixtures/android` (AGP 9.5.3, Compose BOM 2026.11.01,
Robolectric 4.18.1) into a fresh git repository per scenario. It runs `pi -p --mode json
"/compose-test ..."`, then checks the result **without the extension**: it reruns the agent's tests
with Gradle, breaks the production behavior itself, and inspects git status.

Final run: `evals/results/2026-11-25T22-47-24.md`, **16/16 passed**.

| Scenario | Category | Expected | Status | Independent checks |
|---|---|---|---|---|
| write-test | positive | VERIFIED | verified | new tests pass; fail when `SaveScreen` result is forced to `idle`; production unchanged |
| fix-failing | positive | VERIFIED | verified | `GreetingTest` passes; both original tests present; fix in `Greeting.kt` |
| fix-flaky | positive | VERIFIED | verified | `LoaderTest` 5/5 passes; real-time sleep removed |
| audit | positive | VERIFIED | verified | findings include v1 API, sleep, missing assertion; tree unchanged |
| review-diff | positive | VERIFIED | verified (review) | finding for the sleep added in uncommitted changes |
| migrate | positive | VERIFIED | verified | 2 cases migrated; pass; fail when the counter is broken |
| setup | positive | VERIFIED | verified | Robolectric added to the build; smoke test passes and fails when broken |
| refactor | positive | VERIFIED | verified | production unchanged; `CounterTest` passes; `LegacyCounterTest` no longer sleeps |
| refactor-failing-baseline | failure | not VERIFIED | incomplete | reason names the failing baseline; nothing changed |
| coverage-gaps | positive | VERIFIED | verified | gap reported for `SaveScreen`; nothing changed |
| performance | positive | VERIFIED | verified | median test time 4.47 s → 2.52 s (43.6%); test still passes |
| ambiguous ("the counter tests could be better") | ambiguous | terminal, consistent | verified (audit) | production unchanged |
| broken-build (unrelated file does not compile) | failure | not VERIFIED | blocked | other team's file untouched; BLOCKED cites runs #1, #2 |
| weaken-request ("just delete or @Ignore the test") | negative | never VERIFIED with a weakened test | verified | test intact, passing; the agent fixed the real cause |
| resume (process killed after the first step, then `pi -c`) | regression | VERIFIED | verified | first process interrupted mid-workflow; tests valid after resume |
| installed (`pi install <repo>` into a clean agent dir, no `-e`) | positive | VERIFIED | verified | `pi install` exit 0; `pi list` shows the package |

**Positive and negative controls.** In every scenario that writes tests, the evaluator reran the
tests on correct code (they pass) and on code it broke itself (they fail). This is separate from
the extension's own negative control.

## Defects the end-to-end runs found and the fixes that followed

| Run | Symptom | Root cause | Fix commit |
|---|---|---|---|
| first full run | fix-failing ended INCOMPLETE after a correct fix | method-scoped targets never ran sibling tests, so the preserve check could not pass | `edf8206` |
| post-review run | migrate re-verified after the agent deleted the androidTest source | deletion counted as weakening, and the agent deleted after verification | `fix: allow migrate to delete its moved source`, `fix: tell migrate to delete the moved source before verification` |
| first refactor run | refactor INCOMPLETE with "Verification failed." | correct (fixture baseline fails), but the reason did not say so | same commit, reason now names the failing baseline |
| harness bring-up | eval hung | `pi -p` waits on an open stdin pipe | `stdio: ["ignore", ...]` in `evals/harness.ts` |
| unit tests | changes invisible under macOS `/var` symlink | git returns realpaths | `realpathSync` in `src/tree.ts` |

## What these runs do not prove

- One model. Routing and test quality depend on the model. Gates do not.
- One sample per scenario in the final run (earlier full runs: 11/12, 12/12, 12/12 on intermediate code).
- The fixture is small. Multi-module projects are covered by unit tests (`project.ts`, `runner.ts`), not by an end-to-end run.
