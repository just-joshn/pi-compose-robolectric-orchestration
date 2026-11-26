export type Category = "test" | "build" | "production" | "other";

export function categorize(path: string): Category {
  const p = path.replaceAll("\\", "/");
  if (/(^|\/)src\/(test|androidTest|sharedTest)[A-Za-z]*\/|(^|\/)robolectric\.properties$/.test(p))
    return "test";
  if (
    /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|libs\.versions\.toml|gradle-wrapper\.properties)$/.test(
      p,
    )
  )
    return "build";
  if (/(^|\/)src\/[A-Za-z]+\//.test(p)) return "production";
  return "other";
}

/** Kotlin source: the test inventory and lint rules parse Kotlin only. */
export const isSource = (path: string) => path.endsWith(".kt");
