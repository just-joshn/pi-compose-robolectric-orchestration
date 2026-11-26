export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((v) => typeof v === "string");

export const isArrayOf = <T>(value: unknown, item: (v: unknown) => v is T): value is T[] =>
  Array.isArray(value) && value.every(item);

export const isOneOf = <T>(value: unknown, values: readonly T[]): value is T =>
  values.some((v) => v === value);

export const isString = (value: unknown): value is string => typeof value === "string";
