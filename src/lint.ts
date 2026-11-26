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
  /** Lines matching this are exempt, e.g. the documented remedy for the rule. */
  readonly except?: RegExp;
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
    except: /\brunTest\s*\([^)]*[sS]cheduler/,
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
  /\.assert\w*\s*\(|\b(assert|verify|check|expect|ensure|should)\w*\s*[({]|\bfail\s*\(|\.should\w*\s*\(|\bawaitItem\s*\(|\bwaitUntil\w*\s*\(/;

interface KotlinFunction {
  readonly name: string;
  readonly line: number;
  readonly header: string;
  readonly body: string;
  readonly isTest: boolean;
}

function offsets(text: string, chars: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < text.length; i++) if (chars.includes(text.charAt(i))) found.push(i);
  return found;
}

function countBefore(sorted: readonly number[], index: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((sorted[mid] ?? 0) < index) low = mid + 1;
    else high = mid;
  }
  return low;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/**
 * Blank out comments and string literals, keeping every newline and offset, so rules only see
 * code. Handles //, nested-free block comments, "...", """...""" and char literals.
 */
export const stripCode = (source: string): string =>
  source.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"""[\s\S]*?(?:"""|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])'/g,
    (text) =>
      text.startsWith('"') || text.startsWith("'")
        ? `${text[0]}${blank(text.slice(1, -1))}${text.at(-1)}`
        : blank(text),
  );

const OPENERS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

const CONTINUATION = /\s*(\.|\?\.|&&|\|\||\+|-|\*|\/|\?:|=)/y;
const continues = (source: string, at: number) => {
  CONTINUATION.lastIndex = at;
  return CONTINUATION.test(source);
};

/** End of an expression body: the first newline at depth zero not followed by a continuation. */
function expressionEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i] ?? "";
    if (c in OPENERS) depth++;
    else if (")}]".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (c === "\n" && depth === 0 && !continues(source, i + 1)) return i;
  }
  return source.length;
}

function blockEnd(source: string, start: number): number {
  let depth = 1;
  let end = start + 1;
  while (end < source.length && depth > 0) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  return end;
}

/** A body may start on a later line; a newline followed by anything else means no body. */
const BODY_START = /[{=]|\n(?![ \t\r\n]*[{=])/g;
const ANNOTATIONS =
  /((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:(?:public|private|internal|override|suspend|open)\s+)*$/;

function closeParen(code: string, from: number): number {
  let i = from;
  for (let depth = 1; i < code.length && depth > 0; i++) {
    if (code[i] === "(") depth++;
    if (code[i] === ")") depth--;
  }
  return i;
}

/** Every `fun name(...)` with its body; `code` must already be stripped. */
function functions(code: string): KotlinFunction[] {
  const newlines = offsets(code, "\n");
  const boundaries = offsets(code, "{};");
  const found: KotlinFunction[] = [];
  for (const match of code.matchAll(/\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(`[^`]+`|\w+)\s*\(/g)) {
    const at = match.index ?? 0;
    BODY_START.lastIndex = closeParen(code, at + match[0].length);
    const start = BODY_START.exec(code)?.index ?? -1;
    if (start < 0 || code[start] === "\n") continue;
    const end = code[start] === "{" ? blockEnd(code, start) : expressionEnd(code, start + 1);
    const boundary = boundaries[countBefore(boundaries, at) - 1] ?? -1;
    const header = ANNOTATIONS.exec(code.slice(boundary + 1, at))?.[1] ?? "";
    found.push({
      name: (match[1] ?? "").replaceAll("`", ""),
      line: countBefore(newlines, at) + 1,
      header,
      body: code.slice(start, end),
      isTest: /@(org\.junit\.)?Test\b/.test(header),
    });
  }
  return found;
}

export const testFunctions = (source: string) =>
  functions(stripCode(source)).filter((f) => f.isTest);

function assertingHelpers(all: readonly KotlinFunction[]): Set<string> {
  const helpers = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const f of all) {
      if (f.isTest || helpers.has(f.name)) continue;
      if (asserts(f.body, helpers)) {
        helpers.add(f.name);
        changed = true;
      }
    }
  }
  return helpers;
}

const asserts = (body: string, helpers: ReadonlySet<string>) =>
  ASSERTION.test(body) || [...helpers].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(body));

export function lintTestSource(file: string, source: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const code = stripCode(source);
  const lines = code.split("\n");
  for (const rule of lineRules) {
    if (rule.when && !rule.when(code)) continue;
    lines.forEach((text, index) => {
      if (rule.pattern.test(text) && !(rule.except?.test(text) ?? false))
        findings.push({
          file,
          line: index + 1,
          rule: rule.rule,
          severity: rule.severity,
          message: rule.message,
        });
    });
  }
  const all = functions(code);
  const helpers = assertingHelpers(all);
  for (const test of all.filter((f) => f.isTest)) {
    if (!/\bexpected\s*=/.test(test.header) && !asserts(test.body, helpers))
      findings.push({
        file,
        line: test.line,
        rule: "no-assertion",
        severity: "error",
        message: `Test ${test.name} asserts nothing observable; it can only fail by crashing.`,
      });
  }
  if (usesComposeRule(code) && /\/src\/test/.test(`/${file}`) && !/@RunWith\s*\(/.test(code))
    findings.push({
      file,
      line: 1,
      rule: "missing-runner",
      severity: "warning",
      message:
        "Local Compose test without @RunWith(RobolectricTestRunner::class) or AndroidJUnit4; it will not get an Android environment.",
    });
  return findings.toSorted((a, b) => a.line - b.line);
}

export const countIgnores = (source: string) =>
  stripCode(source)
    .split("\n")
    .filter((line) => /^\s*@(org\.junit\.)?Ignore\b/.test(line)).length;
