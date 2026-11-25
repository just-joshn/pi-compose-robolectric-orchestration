# Anti-patterns that reviews and audits flag

Rules marked (lint) are checked by the extension in code. The rest need a reviewer's judgment.

| Rule                                                        | Why                                                | Source                               |
| ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| v1-compose-test-api (lint, error)                           | Deprecated; its eager dispatcher hides timing bugs | official: migrate-v2                 |
| thread-sleep (lint, error)                                  | Compose tests run on a virtual clock               | official: synchronization            |
| no-assertion (lint, error)                                  | A test without assertions only fails on a crash    | judgment                             |
| ignored-test (lint, warning)                                | It verifies nothing while ignored                  | judgment                             |
| run-test-with-compose-rule (lint, warning)                  | Two clocks                                         | official: migrate-v2                 |
| mock-android-framework (lint, warning)                      | Brittle on Robolectric                             | official: robolectric best-practices |
| missing-runner (lint, warning)                              | No Android environment                             | official: local-tests/robolectric    |
| print-to-log (lint, warning)                                | Debugging leftover                                 | judgment                             |
| Asserting internal state instead of UI                      | Breaks on refactors and misses UI bugs             | official: compose/testing overview   |
| Custom semantics for visual properties                      | Pollutes production code                           | official: common-patterns            |
| Testing the framework (that `Text` shows text)              | No behavior of yours is under test                 | judgment                             |
| Many behaviors in one test                                  | First failure hides the rest                       | judgment                             |
| Same behavior tested at several layers with no added signal | Cost without confidence                            | judgment                             |
