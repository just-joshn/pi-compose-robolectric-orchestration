# Flaky Compose tests

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
