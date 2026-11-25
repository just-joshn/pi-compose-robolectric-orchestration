---
name: compose-robolectric
description: Methodology for Jetpack Compose UI tests that run on the local JVM through Robolectric - writing, reviewing, debugging, de-flaking, migrating and speeding up tests. Use for any Compose + Robolectric test question. For work that changes code, run /compose-test so the workflow is enforced.
---

# Compose UI tests on Robolectric

Labels: **[official]** is stated by developer.android.com or robolectric.org. **[judgment]** is an
engineering default you may override with a stated reason. Sources and versions:
the end of `references/setup.md`.

## Core rules

1. Test what a user observes: text, semantics state, enabled/selected, callbacks fired. Not
   internal state or composable structure. [official: compose/testing, semantics]
2. Use the v2 test APIs: `androidx.compose.ui.test.junit4.v2.createComposeRule` (or
   `createAndroidComposeRule`, `v2.runComposeUiTest`). The v1 APIs are deprecated. v2 runs
   composition on `StandardTestDispatcher`, so launched coroutines wait until the test synchronizes.
   [official: compose/testing/migrate-v2]
3. Every finder, action and assertion on the rule synchronizes first. Reading plain Kotlin state
   needs `waitForIdle()` or `runOnIdle {}` first. [official: synchronization, migrate-v2]
4. Never sleep. Use `waitUntil(timeoutMillis) { ... }` for real async work, `mainClock` with
   `autoAdvance = false` for frame-by-frame control, and `registerIdlingResource` for work Compose
   cannot see. [official: synchronization]
5. Find nodes the way a user or accessibility service would: `onNodeWithText`,
   `onNodeWithContentDescription`, role matchers. Use `testTag` when no user-facing handle exists.
   Use `useUnmergedTree = true` only when you need a child of a merged node. [official: apis, semantics]
6. Local Compose tests live in `src/test`, run with `@RunWith(RobolectricTestRunner::class)` or
   `AndroidJUnit4`, and need `testOptions.unitTests.isIncludeAndroidResources = true` and
   `debugImplementation("androidx.compose.ui:ui-test-manifest")` for `createComposeRule`.
   [official: local-tests/robolectric, compose/testing]
7. Pass state and fakes into the composable under test instead of mocking Android classes. Do not
   mock `Context`, `SharedPreferences` and similar framework classes. [official: robolectric best-practices]
8. Use `StateRestorationTester` for `rememberSaveable` and `DeviceConfigurationOverride` for
   font scale, locale, dark mode and size. [official: common-patterns]
9. Behavior tests run well on Robolectric. Pixel-exact rendering, real GPU, hardware sensors,
   system UI and cross-process work need instrumented tests. [official: local-tests/robolectric;
   details in references/debugging.md]
10. Prefer one focused test per behavior over one large test that asserts many things.
    [judgment]

## References (load only the one the current phase needs)

- `references/writing-tests.md`: structure, finders, assertions, semantics, and what reviews flag
- `references/synchronization.md`: clocks, coroutines, v1→v2 hazards, and flaky-test fixes
- `references/debugging.md`: reading failures, migrating androidTest, and when a device test is required
- `references/setup.md`: Gradle and Robolectric configuration, test speed, and sources
