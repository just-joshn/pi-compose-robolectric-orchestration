export type Severity = "error" | "warning";

export interface LintFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
}

interface LineRule {
  readonly rule: string;
  readonly severity: Severity;
  readonly pattern: RegExp;
  readonly message: string;
  readonly when?: (source: string) => boolean;
}

const usesComposeRule = (source: string) =>
  /createComposeRule|createAndroidComposeRule|runComposeUiTest|createEmptyComposeRule/.test(source);

/**
 * Each rule cites the official guidance it enforces. Rules that encode only a style preference
 * are deliberately absent.
 */
const lineRules: readonly LineRule[] = [
  {
    rule: "v1-compose-test-api",
    severity: "error",
    pattern:
      /^\s*import\s+androidx\.compose\.ui\.test\.(junit4\.)?(createComposeRule|createAndroidComposeRule|createEmptyComposeRule|runComposeUiTest|runAndroidComposeUiTest|runEmptyComposeUiTest|AndroidComposeUiTestEnvironment)\b/,
    message:
      "Deprecated v1 Compose test API (UnconfinedTestDispatcher). Import the .v2 equivalent (developer.android.com/develop/ui/compose/testing/migrate-v2).",
  },
  {
    rule: "thread-sleep",
    severity: "error",
    pattern: /\bThread\.sleep\s*\(|\bSystemClock\.sleep\s*\(/,
    message:
      "Real-time sleep in a Compose test. Compose tests run on a virtual clock; use waitUntil, waitForIdle or mainClock (developer.android.com/develop/ui/compose/testing/synchronization).",
  },
  {
    rule: "ignored-test",
    severity: "warning",
    pattern: /^\s*@(org\.junit\.)?Ignore\b/,
    message: "Ignored test: it verifies nothing while it is ignored.",
  },
  {
    rule: "print-to-log",
    severity: "warning",
    pattern: /\.printToLog\s*\(/,
    message: "printToLog is a debugging aid; remove it once the test is understood.",
  },
  {
    rule: "run-test-with-compose-rule",
    severity: "warning",
    pattern: /\brunTest\s*[({]/,
    when: (source) => /createComposeRule|createAndroidComposeRule/.test(source),
    message:
      "runTest next to a compose rule creates a second clock. Use runComposeUiTest (developer.android.com/develop/ui/compose/testing/migrate-v2).",
  },
  {
    rule: "mock-android-framework",
    severity: "warning",
    pattern:
      /\b(mock|mockk|spy|spyk)\s*(<\s*(Context|SharedPreferences|Resources|Activity|Application)\s*>|\(\s*(Context|SharedPreferences|Resources|Activity|Application)::class)/,
    message:
      "Mocking Android framework classes is brittle under Robolectric; use the real class (robolectric.org/best-practices).",
  },
];

const ASSERTION =
  /\.assert\w*\s*\(|\bassert\w*\s*\(|\bassertThat\s*\(|\bverify\w*\s*[({]|\bcheck\s*\(|\bfail\s*\(|\bexpect\w*\s*\(|\.should\w*\s*\(|\bawaitItem\s*\(|\bwaitUntil\w*\s*\(/;

interface TestFunction {
  readonly name: string;
  readonly line: number;
  readonly body: string;
}

function lineOf(source: string, index: number) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

/** Find `@Test fun name(...) { body }` or `= expr` bodies with balanced-brace matching. */
export function testFunctions(source: string): TestFunction[] {
  const found: TestFunction[] = [];
  const header = /@(org\.junit\.)?Test\b[\s\S]*?\bfun\s+(`[^`]+`|\w+)\s*\(/g;
  for (const match of source.matchAll(header)) {
    const name = (match[2] ?? "").replaceAll("`", "");
    let i = (match.index ?? 0) + match[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      if (source[i] === ")") depth--;
      i++;
    }
    const open = source.slice(i).search(/[{=]/);
    if (open < 0) continue;
    const start = i + open;
    let end = start + 1;
    if (source[start] === "{") {
      depth = 1;
      while (end < source.length && depth > 0) {
        if (source[end] === "{") depth++;
        if (source[end] === "}") depth--;
        end++;
      }
    } else {
      const next = source.slice(start).search(/\n\s*(@|fun\s|\})/);
      end = next < 0 ? source.length : start + next;
    }
    found.push({ name, line: lineOf(source, match.index ?? 0), body: source.slice(start, end) });
  }
  return found;
}

export function lintTestSource(file: string, source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = source.split("\n");
  for (const rule of lineRules) {
    if (rule.when && !rule.when(source)) continue;
    lines.forEach((text, index) => {
      if (rule.pattern.test(text) && !/^\s*\/\//.test(text))
        findings.push({
          file,
          line: index + 1,
          rule: rule.rule,
          severity: rule.severity,
          message: rule.message,
        });
    });
  }
  for (const test of testFunctions(source)) {
    if (!ASSERTION.test(test.body))
      findings.push({
        file,
        line: test.line,
        rule: "no-assertion",
        severity: "error",
        message: `Test ${test.name} asserts nothing observable; it can only fail by crashing.`,
      });
  }
  if (usesComposeRule(source) && /\/src\/test/.test(`/${file}`) && !/@RunWith\s*\(/.test(source))
    findings.push({
      file,
      line: 1,
      rule: "missing-runner",
      severity: "warning",
      message:
        "Local Compose test without @RunWith(RobolectricTestRunner::class) or AndroidJUnit4; it will not get an Android environment.",
    });
  return findings.sort((a, b) => a.line - b.line);
}

export const countIgnores = (source: string) =>
  source.split("\n").filter((line) => /^\s*@(org\.junit\.)?Ignore\b/.test(line)).length;

export const countTests = (source: string) => testFunctions(source).length;
