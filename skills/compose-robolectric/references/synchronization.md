# Synchronization and flakiness

## Synchronization, clocks, and coroutines

Source: developer.android.com/develop/ui/compose/testing/synchronization and /migrate-v2.

- Compose tests run on a virtual clock. Every rule action, assertion and finder waits for Compose
  to be idle first. [official]
- Without a synchronizing call, no recomposition happens. State you set from the test is only
  visible after an action, an assertion, or `waitForIdle()`. [official]
- `mainClock.autoAdvance = false` with `advanceTimeByFrame()` or `advanceTimeBy(ms)` steps through
  animations. `advanceTimeUntil { }` only works on Compose state. [official]
- `registerIdlingResource` covers background work Compose cannot see. [official]
- `waitUntil(timeoutMillis) { condition }` waits for real asynchronous work. [official, testing/apis]

## v1 → v2 [official: migrate-v2]

|                                  | v1 (deprecated)                            | v2                                                  |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------- |
| Dispatcher for composition       | UnconfinedTestDispatcher, runs immediately | StandardTestDispatcher, queued                      |
| Coroutine launched from a test   | Ran before the next line                   | Runs at the next sync                               |
| Fix for "still Loading" failures | -                                          | `waitForIdle()` or `runOnIdle { }` before asserting |
| Run tasks without advancing time | -                                          | `mainClock.scheduler.runCurrent()`                  |

Measured on Compose ui-test 1.13.0 and Robolectric 4.18.1: a
`scope.launch { hits++ }` issued from `runOnUiThread` showed `hits == 1` immediately under v1 and
`hits == 0` under v2 until `waitForIdle()`.

## Kotlin `runTest` [official: migrate-v2]

`runTest` together with `createComposeRule` creates two clocks. Advancing one does not advance the
other. Use `v2.runComposeUiTest`, or pass `mainClock.scheduler` to `runTest`.

## Flaky Compose tests

Common sources:

| Source                                              | Real fix                                                           | Citation                             |
| --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `Thread.sleep` or real-time waits                   | `waitUntil`, `waitForIdle`, `mainClock`                            | official: synchronization            |
| Work Compose cannot see (custom executors, real IO) | Inject a test dispatcher or fake; `registerIdlingResource`         | official: synchronization            |
| Threads that outlive the test                       | Stop executors; use a direct executor or fakes                     | official: robolectric best-practices |
| Shared mutable singletons between tests             | Construct state per test                                           | judgment                             |
| Animations sampled at arbitrary times               | `autoAdvance = false` with explicit frames                         | official: synchronization            |
| Input mode leaking between tests                    | v2 enforces `InputMode.Touch`; configure via `ComposeUiTestConfig` | official: migrate-v2                 |

Retries, `@Ignore`, longer timeouts and sleeps hide flakiness; they do not remove it. The
fix-flaky workflow reruns the tests several times and requires every run to pass.
