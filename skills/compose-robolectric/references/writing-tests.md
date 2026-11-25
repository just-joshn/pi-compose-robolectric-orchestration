# Writing Compose tests for Robolectric

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
