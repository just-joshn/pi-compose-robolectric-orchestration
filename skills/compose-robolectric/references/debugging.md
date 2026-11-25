# Debugging, migration and device-only cases

## Debugging a failing Compose test

1. Read the failure message. Compose assertion errors print the matcher and, for "not found",
   often the nearby tree. [official: debug]
2. If a node is not found, print the tree with `onRoot(useUnmergedTree = true).printToLog("T")`.
   Check whether the text is merged into a parent, has different case, or never composed.
3. If an assertion sees stale state after a v2 migration, a coroutine was queued and never ran.
   Synchronize first (see synchronization.md). [official: migrate-v2]
4. `ComposeTimeoutException` from `waitUntil`: the condition never became true. Find why the async
   work does not finish (missing fake, real dispatcher, real network).
5. An exception from production code is a real defect. Fix the code, not the test.
6. Robolectric-specific failures: missing resources (enable `isIncludeAndroidResources`), an
   unsupported API or shadow (see "When a device or emulator test is still required" below), SDK jar download failures (offline).

The fix workflow requires the original test cases to still exist and pass, and refuses `@Ignore`
on the target tests. These checks run in code.

## Migrating androidTest Compose tests to Robolectric

Source: developer.android.com/training/testing/local-tests/robolectric.

1. Move the test to `src/test` and add the Robolectric dependencies and
   `isIncludeAndroidResources`. [official]
2. Keep the test body. Compose test APIs are the same on both runtimes. Switch to the v2 rule
   while you are here. [official: migrate-v2]
3. Replace instrumentation-only APIs (`InstrumentationRegistry.getInstrumentation().uiAutomation`,
   UiDevice, device permissions) or leave those cases as device tests. See the device-only section below.
4. Screenshot tests run with lower fidelity on Robolectric. Decide per case. [official]

The migrate workflow requires the Robolectric version to have at least as many @Test cases as
the source, plus a passing run and a negative control.

## When a device or emulator test is still required

From developer.android.com/training/testing/local-tests/robolectric and robolectric.org/best-practices:

- Robolectric does not have a real screen. Pixel-exact screenshots are lower fidelity. [official]
- Some APIs are only partially supported. [official]
- Android libcore differs from OpenJDK, for example time zone parsing with `Z` and `MMM` month
  names. [official: best-practices]
- Not covered: real GPU rendering, performance and jank, hardware sensors, camera, system UI and
  other apps, and real multi-process behavior. These need instrumented tests. [judgment derived
  from the above]
