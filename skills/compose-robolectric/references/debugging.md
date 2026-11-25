# Debugging a failing Compose test

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
   unsupported API or shadow (see limits.md), SDK jar download failures (offline).

The fix workflow requires the original test cases to still exist and pass, and refuses `@Ignore`
on the target tests. These checks run in code.
