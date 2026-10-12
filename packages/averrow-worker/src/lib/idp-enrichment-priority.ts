// IdP-first enrichment slices for the quota-bound enrichment feeds.
//
// VirusTotal (10/run), SecLookup (100/run) and Pulsedive (8/run) each pick
// their per-run batch by severity, so IdP-impersonation threats
// (threats.technique IN IDP_FAMILY_TECHNIQUES, lib/idp-impersonation.ts) —
// often `medium` CertStream/feed rows — waited behind the whole backlog, and
// VT/Pulsedive (critical/high only) never saw them at all. VT is also the
// only writer of domain_created_at (NRD age), so those rows had no age.
//
// Each feed now reads a RESERVED SLICE of IdP-family rows first, regardless
// of severity, then fills the rest of its batch with its unchanged selector:
//   VT 3 of 10, SecLookup 20 of 100, Pulsedive 3 of 8.
// A reserved slice (not a full first tier) so a burst of IdP rows can never
// starve the severity-ordered queue.
//
// Each slice reads through a dedicated partial index (migration 0291) whose
// predicate is `<flag> = 0 AND technique IS NOT NULL` — `technique` is NULL
// on almost every threat, and the query's `technique IN (…)` implies
// `technique IS NOT NULL`, so the index holds only unchecked technique-
// tagged rows and the slice reads ~only pending IdP rows of the window.
// EXPLAIN pinned in test/idp-enrichment-priority.test.ts.
//
// Best-effort: a failing slice read (e.g. index not yet migrated) returns
// [] and the feed proceeds exactly as before.

import { IDP_FAMILY_TECHNIQUES } from "./idp-impersonation";

export const IDP_SLICE_VIRUSTOTAL = 3;
export const IDP_SLICE_SECLOOKUP = 20;
export const IDP_SLICE_PULSEDIVE = 3;

const FAMILY_PH = IDP_FAMILY_TECHNIQUES.map(() => "?").join(", ");

/** VT slice. Binds: ...IDP_FAMILY_TECHNIQUES, limit. */
export const IDP_VT_SLICE_SQL = `
      SELECT DISTINCT malicious_domain FROM threats INDEXED BY idx_threats_idp_vt_pending
      WHERE vt_checked = 0
        AND technique IS NOT NULL
        AND malicious_domain IS NOT NULL
        AND technique IN (${FAMILY_PH})
        AND malicious_domain != ''
        AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT ?`;

/** SecLookup slice. Binds: ...IDP_FAMILY_TECHNIQUES, limit. */
export const IDP_SECLOOKUP_SLICE_SQL = `
      SELECT id, malicious_domain, ip_address FROM threats INDEXED BY idx_threats_idp_seclookup_pending
      WHERE seclookup_checked = 0
        AND technique IS NOT NULL
        AND technique IN (${FAMILY_PH})
        AND (malicious_domain IS NOT NULL OR ip_address IS NOT NULL)
        AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT ?`;

/** Pulsedive slice. Binds: ...IDP_FAMILY_TECHNIQUES, limit. */
export const IDP_PULSEDIVE_SLICE_SQL = `
      SELECT id, COALESCE(malicious_domain, ip_address) AS indicator
      FROM threats INDEXED BY idx_threats_idp_pulsedive_pending
      WHERE pulsedive_checked = 0
        AND technique IS NOT NULL
        AND technique IN (${FAMILY_PH})
        AND (malicious_domain IS NOT NULL OR ip_address IS NOT NULL)
        AND created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC
      LIMIT ?`;

/** Run one slice query; [] on limit 0 or any error (never throws). */
export async function readIdpSlice<T>(db: D1Database, sql: string, limit: number): Promise<T[]> {
  if (limit <= 0) return [];
  try {
    const r = await db.prepare(sql).bind(...IDP_FAMILY_TECHNIQUES, limit).all<T>();
    return r.results ?? [];
  } catch (err) {
    console.error("[idp-enrichment-priority] slice read failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** IdP slice first, then the regular selector's rows (deduped by `key`),
 *  capped at `cap`. */
export function mergeIdpFirst<T>(idp: readonly T[], rest: readonly T[], key: (row: T) => string, cap: number): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const row of [...idp, ...rest]) {
    if (out.length >= cap) break;
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}
