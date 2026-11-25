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

function lineOf(source: string, index: number) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

const blank = (text: string) => text.replace(/[^\n]/g, " ");

/**
 * Blank out comments and string literals, keeping every newline and offset, so rules only see
 * code. Handles //, nested-free block comments, "...", """...""" and char literals.
 */
export function stripCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const token =
      /^\/\/[^\n]*/.exec(rest) ??
      /^\/\*[\s\S]*?(\*\/|$)/.exec(rest) ??
      /^"""[\s\S]*?("""|$)/.exec(rest) ??
      /^"(\\.|[^"\\\n])*"?/.exec(rest) ??
      /^'(\\.|[^'\\\n])'/.exec(rest);
    if (token) {
      const text = token[0];
      const quoted = text.startsWith('"') || text.startsWith("'");
      out += quoted ? `${text[0]}${blank(text.slice(1, -1))}${text.at(-1)}` : blank(text);
      i += text.length;
    } else {
      out += source[i];
      i++;
    }
  }
  return out;
}

const OPENERS: Record<string, string> = { "(": ")", "{": "}", "[": "]" };

/** End of an expression body: the first newline at depth zero not followed by a continuation. */
function expressionEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source[i] ?? "";
    if (c in OPENERS) depth++;
    else if (")}]".includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (
      c === "\n" &&
      depth === 0 &&
      !/^\s*(\.|\?\.|&&|\|\||\+|-|\*|\/|\?:|=)/.test(source.slice(i + 1))
    )
      return i;
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

/** Every `fun name(...)` with its body; `code` must already be stripped. */
function functions(code: string): KotlinFunction[] {
  const found: KotlinFunction[] = [];
  for (const match of code.matchAll(/\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(`[^`]+`|\w+)\s*\(/g)) {
    let i = (match.index ?? 0) + match[0].length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      if (code[i] === ")") depth--;
      i++;
    }
    const open = code.slice(i).search(/[{=\n]/);
    const start = i + open;
    if (open < 0 || code[start] === "\n") continue;
    const end = code[start] === "{" ? blockEnd(code, start) : expressionEnd(code, start + 1);
    const before = code.slice(0, match.index ?? 0);
    const annotations =
      /((?:@[\w.]+(?:\([^)]*\))?\s*)*)(?:(?:public|private|internal|override|suspend|open)\s+)*$/.exec(
        before,
      )?.[1] ?? "";
    found.push({
      name: (match[1] ?? "").replaceAll("`", ""),
      line: lineOf(code, match.index ?? 0),
      header: annotations,
      body: code.slice(start, end),
      isTest: /@(org\.junit\.)?Test\b/.test(annotations),
    });
  }
  return found;
}

/** Find `@Test fun name(...)` functions with their bodies, ignoring comments and strings. */
export const testFunctions = (source: string) =>
  functions(stripCode(source)).filter((f) => f.isTest);

/** Helpers in the same file that assert, directly or through another helper. */
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

export const countTests = (source: string) => testFunctions(source).length;
