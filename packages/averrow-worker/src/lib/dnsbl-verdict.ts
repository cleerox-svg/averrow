/**
 * How API responses present a DNS-blocklist verdict (SURBL, Spamhaus DBL).
 *
 * The rule: a listing is evidence; "not listed" is NOT evidence. Surface
 * `*_listed` as listed (true / 1) when the stored flag says listed, and
 * otherwise as null (unknown) — never false / 0.
 *
 * Why: until 2026-11-14 both feeds read a refused or failed lookup as
 * "not listed". Spamhaus answers Cloudflare's public resolver with the
 * error code 127.255.255.254, and SURBL answers it with SERVFAIL, so every
 * row those feeds processed carries `*_checked = 1, *_listed = 0`, a false
 * "clean". The rows are deliberately not rewritten (both feeds are now
 * disabled, migration 0326); readers stop presenting the 0 as a verdict
 * instead. A real listing (`*_listed = 1`) was a genuine 127.0.x.y answer
 * and stays trustworthy.
 *
 * Keys and value types are unchanged: boolean fields stay boolean | null
 * (`dnsblListedFlag`), raw numeric row fields stay number | null
 * (`withDnsblVerdicts`), so existing clients keep parsing the response.
 */

type FlagValue = number | boolean | null | undefined;

const isListed = (v: unknown): boolean => v === 1 || v === true || v === "1";

/** Boolean-typed field: true when listed, otherwise null (unknown). */
export function dnsblListedFlag(listed: FlagValue): true | null {
  return isListed(listed) ? true : null;
}

/** Numeric (raw D1 row) field: 1 when listed, otherwise null (unknown). */
export function dnsblListedRowValue(listed: unknown): 1 | null {
  return isListed(listed) ? 1 : null;
}

/**
 * Apply the rule to a raw threats row (or a list of them) in a response:
 * rewrites `surbl_listed` / `dbl_listed` where the key is present and
 * leaves every other column untouched.
 */
export function withDnsblVerdicts<T>(row: T): T {
  if (row === null || typeof row !== "object") return row;
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  if ("surbl_listed" in out) out.surbl_listed = dnsblListedRowValue(out.surbl_listed);
  if ("dbl_listed" in out) out.dbl_listed = dnsblListedRowValue(out.dbl_listed);
  return out as T;
}
