// Defensive JSON parsing for API columns that store JSON as TEXT (e.g.
// operations.countries, geo-campaign target_sectors). A malformed value must
// degrade to an empty/fallback value, never throw during render.

/** Parse JSON, returning `fallback` for null/empty/invalid input. */
export function safeJsonParse<T>(val: string | null | undefined, fallback: T): T {
  if (val == null || val === '') return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

/** Parse a JSON array of strings. Non-arrays, bad JSON and non-string members are dropped. */
export function parseStringArray(val: string | null | undefined): string[] {
  const parsed = safeJsonParse<unknown>(val, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === 'string');
}
