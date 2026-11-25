# Semantics and accessibility

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
