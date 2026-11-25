# Migrating androidTest Compose tests to Robolectric

Source: developer.android.com/training/testing/local-tests/robolectric.

1. Move the test to `src/test` and add the Robolectric dependencies and
   `isIncludeAndroidResources`. [official]
2. Keep the test body. Compose test APIs are the same on both runtimes. Switch to the v2 rule
   while you are here. [official: migrate-v2]
3. Replace instrumentation-only APIs (`InstrumentationRegistry.getInstrumentation().uiAutomation`,
   UiDevice, device permissions) or leave those cases as device tests. See limits.md.
4. Screenshot tests run with lower fidelity on Robolectric. Decide per case. [official]

The migrate workflow requires the Robolectric version to have at least as many @Test cases as
the source, plus a passing run and a negative control.
