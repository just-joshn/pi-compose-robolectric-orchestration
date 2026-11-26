# Writing, semantics and review

## Writing Compose tests for Robolectric

## Shape [official: developer.android.com/develop/ui/compose/testing]

```kotlin
@RunWith(RobolectricTestRunner::class)
class SaveButtonTest {
  @get:Rule val rule = createComposeRule() // androidx.compose.ui.test.junit4.v2

  @Test fun clickingSaveShowsSavedStatus() {
    rule.setContent { SaveScreen(repository = FakeRepository()) }
    rule.onNodeWithText("Save").performClick()
    rule.onNodeWithText("Status: saved").assertIsDisplayed()
  }
}
```

- Arrange with `setContent { }` and pass in state or fakes. Act with `perform*`. Assert on
  semantics with `assert*`.
- Use `createAndroidComposeRule<ComponentActivity>()` when you need `activity` (for example
  string resources) and still want to call `setContent`. [official: common-patterns]
- Use `v2.runComposeUiTest { }` instead of a rule when the test also uses coroutine test APIs. It
  shares one clock. [official: migrate-v2]

## Finders [official: testing/apis]

- `onNodeWithText`, `onNodeWithContentDescription`, `onNodeWithTag`, `onNode(matcher)`, and
  `onAllNodes*` for lists.
- Combine matchers: `hasText("Delete") and hasClickAction()`.
- Pass `useUnmergedTree = true` to target a child inside a merged node, for example a Text inside
  a Button.

## Assertions [official: testing/apis]

- `assertIsDisplayed`, `assertExists`, `assertDoesNotExist`, `assertTextEquals`,
  `assertIsEnabled`/`NotEnabled`, `assertIsSelected`, `assertIsOn`/`Off`, and `assertCountEquals`
  on collections.
- To check a callback, capture it in a local variable and assert after an action. Actions
  synchronize first. To read plain state without an action, call `waitForIdle()` before reading it.

## Actions [official: testing/apis]

- `performClick`, `performTextInput`, `performTextReplacement`, `performScrollTo`,
  `performScrollToNode`, `performTouchInput { swipeLeft() }`, `performImeAction`.

## What makes a test worth keeping [judgment]

- It fails when the user-visible behavior breaks. The workflow's negative control checks exactly
  this.
- One behavior per test, named after the behavior.
- It does not duplicate a cheaper test of the same behavior, for example a ViewModel unit test.

## Semantics and accessibility

Source: developer.android.com/develop/ui/compose/testing/semantics, /apis, /common-patterns.

- Tests see the semantics tree, the same tree that accessibility services see. A node with no
  text, content description or role is hard both to test and to use. [official]
- Some nodes merge their children (`mergeDescendants`), for example a Button with two Texts. The
  default finders search the merged tree. `useUnmergedTree = true` searches the children.
  [official]
- `onRoot().printToLog("TAG")` or `onRoot(useUnmergedTree = true).printToLog(...)` shows the
  tree when a finder fails. Remove it afterwards. [official: debug]
- Custom `SemanticsPropertyKey` with `SemanticsMatcher.expectValue` is for values that are hard to
  match otherwise. Do not expose visual properties such as color, font size or corner radius this
  way. [official: common-patterns]
- `testTag` is a test-only handle. Prefer user-facing text, content description or role, and use
  a tag when none of those exists. [judgment, consistent with the official finder ordering]

## Anti-patterns that reviews flag

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
