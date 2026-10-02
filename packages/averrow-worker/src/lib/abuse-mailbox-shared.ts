// Averrow — Abuse Mailbox shared helpers
//
// Small pieces used by more than one abuse-mailbox module (rules pass, AI
// classifier, determination delivery, cron gate). Pure — no I/O.

/** SPF/DKIM/DMARC verdicts as parsed at intake (abuse-mailbox-iocs.ts). */
export interface AuthTriple {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

/**
 * How far back the automated responder may email a reporter, and the
 * boundary of the determination sweeper. Rows older than this are
 * backlog: the rules pass still classifies them, but no promotion,
 * notification or email ever follows (a determination days late would
 * confuse the reporter, and promotion/alerts on stale intel mislead).
 * SQLite datetime modifier — bind it, never interpolate.
 */
export const ABUSE_RESPONSE_LOOKBACK = "-2 days";

/**
 * SQL expression: 1 when the row was a forward-AS-ATTACHMENT (the handler
 * stores the inner message's headers under `_forwarded_inner`), else 0.
 * instr() rather than json_* because the stored JSON can be truncated
 * (capJson) and SQLite's JSON functions throw on malformed input.
 */
export const IS_ATTACHMENT_FORWARD_SQL =
  `CASE WHEN instr(COALESCE(raw_headers, ''), '"_forwarded_inner":') > 0 THEN 1 ELSE 0 END`;

export function parseJsonSafe<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

/** An auth verdict that counts as a failure for the rules review codes and
 *  the determination's auth bullet. */
export function isAuthFail(v: string | null | undefined): boolean {
  return v === "fail" || v === "softfail" || v === "permerror";
}
