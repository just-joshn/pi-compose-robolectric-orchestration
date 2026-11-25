# Performance evaluation

## What was measured

Every end-to-end scenario records wall time, model turns, tool calls, extension Gradle runs, gate
continuations, and input, cache-read and output tokens. The values come from Pi's JSON event
stream (`message_end` usage) and the persisted run (`evals/harness.ts` `summarize`).

## Where time goes

In the final run (`evals/results/2026-11-25T22-47-24.md`), wall time is 25–78 s per scenario. Gradle
dominates. One warm-daemon Robolectric run of one class takes 3.5–5 s in the extension's records.
fix-flaky runs Gradle 11 times (5 probe runs, 5 stress runs, 1 negative control) and is the slowest
at 78 s. Model latency covers the rest.

## Overhead found and removed

The traces showed that every run read `SKILL.md`, even though the kickoff already embeds its
core rules. That cost one extra turn and about 1.3k input tokens, re-sent on every later turn.

Change: the kickoff says the rules are already loaded (commit `e9e7f2d`).

| Scenario | Before (22:31 full run, 1 sample) turns / input+cache tokens | After (22:33 and 22:34, 2 samples) turns / input+cache tokens |
|---|---|---|
| write-test | 11 / 56.5k | 10 / 42.3k, 9 / 36.5k |
| fix-failing | 11 / 51.1k | 8 / 30.2k, 8 / 30.2k |
| audit | 13 / 67.4k | 12 / 45.1k, 11 / 42.9k |

The before baseline has one sample on identical code. The 22:09 run is older code: write-test
was 11 turns / 56.5k there too, while fix-failing hit the whole-class bug and audit took
15 turns / 79.0k. The 22:09 run is not used as a baseline. With this few samples, treat the
deltas as indications. The direction is consistent across every pair. In the final full run
(16 scenarios, final code), input plus cache tokens for these three scenarios were 37.0k, 33.4k
and 45.5k, and turns were 9, 9 and 12.

## Other cost decisions

- **Phase chaining**: one `compose_test_step` call completes an edit phase and runs every test
  phase that follows, so verification costs no extra model turn.
- **Whole-class verification** only in test-preserving workflows. Elsewhere only the targeted methods run.
- **Fingerprinting**: three git commands per check (`rev-parse`, `status`, `ls-files` twice). The fake-Gradle unit tests
  slowed from about 0.3 s to 0.5 s each with hidden-path detection. That is acceptable next to
  multi-second Gradle runs.
- **No subagents**: each run is a single agent (see the parity matrix, C10). Fan-out would add process
  startup and duplicate context, with no measured benefit for single-target workflows.
