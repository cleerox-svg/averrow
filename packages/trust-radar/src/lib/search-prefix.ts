// Shared prefix-search discipline for the unified staff search
// (handlers/search.ts) and any list endpoint that wants the same
// prefix-anchored, index-friendly matching (e.g. campaigns `?q=`).
//
// Extracted so the escape/clamp rules live in exactly one place and can't
// drift between call sites. Every consumer pairs the returned prefix with
// `LIKE ? ESCAPE '\\'` against a `COLLATE NOCASE` index, so the pattern is
// a bounded index range scan, never a leading-wildcard full-table scan.

/**
 * Trim a raw query term and length-clamp it to 64 chars.
 *
 * The clamp runs before the term is used in a KV cache key or bound to a
 * statement: it keeps the cache key under KV's key-size limit so an
 * oversized term can't overflow it and silently bypass the cache.
 */
export function clampQuery(raw: string): string {
  return raw.trim().slice(0, 64);
}

/**
 * Turn a clamped term into an anchored `term%` prefix with its LIKE
 * metacharacters (`\`, `%`, `_`) escaped, so a literal `%`/`_` in the
 * user term matches itself instead of acting as a wildcard. Pair with
 * `ESCAPE '\\'` on the LIKE clause. Escaping a metachar-free term is a
 * no-op, so ordinary queries keep the plain anchored `term%` shape.
 */
export function buildPrefix(clamped: string): string {
  const escaped = clamped.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return escaped + "%";
}
