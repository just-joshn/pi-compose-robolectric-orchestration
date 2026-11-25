# Independent adversarial review

Three reviewers ran in parallel as fresh Pi sessions (`pstack_delegate` swarm, read-only), each
with its own attack brief:

1. Gate integrity: reach VERIFIED while a check is false, or corrupt user files.
2. Runner and fingerprint: wrong outcomes on realistic Android projects, missed tree changes.
3. Pi integration: dropped workflows, scope bypass, resume/fork/tree state, locks, lint false positives.

The reviewers had no shell, so they returned findings with repro code but no runs. Every finding
was then reproduced as a failing test in `test/review-findings.test.ts` before any fix. A finding
counts as confirmed only if its test failed on the code at commit `e9e7f2d`'s parent
(`3c619fc` + engine fix `edf8206`).

| Id    | Finding                                                                                             | Confirmed by a failing test          | Fix                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| I1    | Edits after VERIFIED kept the VERIFIED status                                                       | yes                                  | `recheck` at settle reopens the run at its last edit phase (`src/finalize.ts`)                                        |
| I2a   | `git update-index --assume-unchanged` hid production edits                                          | yes                                  | Fingerprint hashes flagged files (`src/tree.ts` `hiddenPaths`)                                                        |
| I2b   | `.git/info/exclude` hid new production files                                                        | yes                                  | Fingerprint hashes ignored files inside source sets                                                                   |
| I3    | Restoring a mutation overwrote a concurrent write                                                   | yes                                  | `src/swap.ts` restores only bytes it wrote. Conflicts end the run INCOMPLETE and save the original                    |
| I4    | Deleting a non-target test file was not detected                                                    | yes                                  | `weakenedTests` checks every changed test file (`src/baseline.ts`)                                                    |
| I5    | fix-failing passed with a weakened assertion and the bug still present                              | yes                                  | New regression-check phase: tests must fail on the original production code, otherwise a negative control is required |
| R1/R2 | Test class taken from the first class in the file or lost with one-line annotations                 | yes                                  | `className` picks the last top-level class before the first `@Test`                                                   |
| R3    | Nested class reports ignored                                                                        | yes                                  | Reads `TEST-<class>$*.xml`                                                                                            |
| R4    | JUnit 5 display names fail method filters                                                           | not tested                           | Not applicable: Robolectric and the Compose rules run on JUnit 4. Documented                                          |
| R5    | A target with no cases hidden by another passing target                                             | yes                                  | Outcome is computed per target                                                                                        |
| T1    | Worktree rename codes                                                                               | refuted (test passed before the fix) | Hardened anyway: either status column                                                                                 |
| T2    | Committed renames drop the old path                                                                 | yes                                  | `git diff --no-renames`                                                                                               |
| T3    | Symlinks not fingerprinted without git                                                              | yes                                  | Symlink targets are hashed                                                                                            |
| T4    | Subdirectory workspace misses changes                                                               | refuted                              | Covered by a regression test                                                                                          |
| T6    | Locale-dependent digest ordering                                                                    | not tested                           | Code-point ordering                                                                                                   |
| F1    | Invalid config disabled the settle gate                                                             | yes                                  | `safeConfig` plus a fail-closed handler                                                                               |
| F2    | Repeated identical findings defeated the stall bound                                                | yes                                  | Findings are deduplicated, and a `maxNudges` budget applies to every run                                              |
| F3    | Cancel during a Gradle run was undone by the run's result, and the lock was released while work ran | yes                                  | Compare-and-set on tool results. Lock release waits for in-flight work                                                |
| F4    | Resumed terminal runs never posted their status                                                     | yes                                  | `reported` revision persisted with the run                                                                            |
| F5    | Leaving a run's branch kept its lock                                                                | yes                                  | Restore releases the lock when the branch has no active run                                                           |
| F6    | A corrupt recovery record skipped state restore                                                     | yes                                  | Recovery is best-effort and isolated                                                                                  |
| F7    | Edits outside the workspace were allowed                                                            | yes                                  | Blocked while a run is active                                                                                         |
| F8    | Persisted run with an impossible phase disabled the gate                                            | yes                                  | `parseRun` validates the phase range. An active run without a phase blocks edits                                      |
| F9    | Lint flagged comments, strings and helper assertions                                                | yes                                  | Comment- and string-aware lint. Helper assertions recognized transitively                                             |

Totals: 23 findings, 20 confirmed and fixed, 2 refuted, 1 not applicable (R4), plus T6 hardened
without a test. After the fixes the full unit suite (90 tests) and the end-to-end suite pass. See
docs/verification.md.

Reviewer observations not acted on, with reasons:

- `parseRun` does not re-verify the evidence in a persisted run. The session file belongs to the user. Forging it is outside the threat model, which covers the agent, not the operator.
- Review workflows may finish with zero findings. "No problems found" is a legitimate audit result, and the extension's own lint findings are still added.
- Session entries grow with each state change. A run produces tens of entries of a few KB each, which is acceptable for now.
