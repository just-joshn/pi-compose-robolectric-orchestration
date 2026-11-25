export type FileCategory = "test" | "build" | "production" | "other";

const TEST_SOURCE_SET = /(^|\/)src\/(test|androidTest|sharedTest)[A-Za-z]*\//;
const PRODUCTION_SOURCE_SET = /(^|\/)src\/[A-Za-z]+\//;
const BUILD_FILE =
  /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|libs\.versions\.toml|gradle-wrapper\.properties)$/;

/** Classify a repository-relative path by what a workflow phase may change. */
export function categorize(relativePath: string): FileCategory {
  const path = relativePath.replaceAll("\\", "/");
  if (TEST_SOURCE_SET.test(path)) return "test";
  if (BUILD_FILE.test(path)) return "build";
  if (/(^|\/)robolectric\.properties$/.test(path)) return "test";
  if (PRODUCTION_SOURCE_SET.test(path)) return "production";
  return "other";
}

export const isLocalTestPath = (relativePath: string) =>
  /(^|\/)src\/test[A-Za-z]*\//.test(relativePath.replaceAll("\\", "/"));

export const isKotlinOrJava = (path: string) => /\.(kt|java)$/.test(path);
