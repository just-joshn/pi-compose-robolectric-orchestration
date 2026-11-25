export type CaseStatus = "passed" | "failed" | "skipped";

export interface TestCase {
  readonly className: string;
  readonly name: string;
  readonly status: CaseStatus;
  readonly seconds: number;
  readonly failureType?: string;
  readonly message?: string;
}

const unescape = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");

const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? unescape(match[1] ?? "") : undefined;
};

/** Parse the JUnit XML that Gradle writes to build/test-results/<task>/TEST-<class>.xml. */
export function parseJUnitXml(xml: string): TestCase[] {
  const cases: TestCase[] = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const tag = match[1] ?? "";
    const body = match[3] ?? "";
    const failure = /<(failure|error)\b([^>]*)>?/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const status: CaseStatus = failure ? "failed" : skipped ? "skipped" : "passed";
    const base = {
      className: attribute(tag, "classname") ?? "",
      name: attribute(tag, "name") ?? "",
      status,
      seconds: Number(attribute(tag, "time") ?? 0),
    };
    if (!failure) {
      cases.push(base);
      continue;
    }
    const failureTag = failure[2] ?? "";
    const message = attribute(failureTag, "message");
    const failureType = attribute(failureTag, "type");
    cases.push({
      ...base,
      ...(failureType === undefined ? {} : { failureType }),
      ...(message === undefined ? {} : { message: message.slice(0, 500) }),
    });
  }
  return cases;
}
