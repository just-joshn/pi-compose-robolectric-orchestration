import { describe, expect, it } from "vitest";

import { ignoredDeclarations, lintTestSource, testFunctions } from "../src/lint.ts";

describe("Kotlin functions whose body starts on the next line", () => {
  it("inventories and lints them like any other test", () => {
    const source =
      "class T {\n  @Test\n  fun test()\n  { Thread.sleep(1) }\n\n  abstract fun noBody()\n}";
    expect(testFunctions(source).map((t) => t.name)).toEqual(["test"]);
    expect(lintTestSource("app/src/test/T.kt", source).map((f) => f.rule)).toContain(
      "thread-sleep",
    );
  });
});

describe("Kotlin the scanner must read like the compiler", () => {
  it("treats aliased JUnit annotations as the real ones", () => {
    const source =
      "import org.junit.Test as JUnitTest\nimport org.junit.Ignore as Skip\nclass T {\n  @Skip\n  @JUnitTest fun a() { Thread.sleep(1) }\n}";
    expect(testFunctions(source).map((t) => t.name)).toEqual(["a"]);
    expect(ignoredDeclarations(source)).toEqual(["a"]);
    expect(ignoredDeclarations("class T {\n  @Test @Ignore fun a() {}\n}")).toEqual(["a"]);
    expect(ignoredDeclarations("@Ignore\nclass T {\n  @Test fun a() {}\n}")).toEqual(["T"]);
    expect(lintTestSource("app/src/test/T.kt", source).map((f) => f.rule)).toContain(
      "no-assertion",
    );
  });

  it("ignores tests inside nested block comments", () => {
    const source =
      "class T {\n  /* outer\n    /* inner */\n    @Test fun phantom() { }\n  */\n  @Test fun real() { assert(true) }\n}";
    expect(testFunctions(source).map((t) => t.name)).toEqual(["real"]);
    expect(lintTestSource("app/src/test/T.kt", source)).toEqual([]);
  });

  it("keeps quotes and braces inside string templates out of the code", () => {
    const source =
      'class T {\n  @Test fun demo() {\n    val text = "${if (true) "}" else "x"}"\n    val raw = """${"\\""}"""\n    assertEquals("}", text)\n  }\n}';
    expect(lintTestSource("app/src/test/T.kt", source)).toEqual([]);
  });

  it("counts assertions made through a backtick-named helper", () => {
    const source =
      "class T {\n  fun `check [thing]`() { assert(true) }\n  @Test fun test() { `check [thing]`() }\n}";
    expect(lintTestSource("app/src/test/T.kt", source)).toEqual([]);
  });
});
