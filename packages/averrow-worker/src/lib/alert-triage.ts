// Averrow — Alert auto-triage (Tier 1 + Tier 1.5)
//
// Conservative rule-based pass that auto-dismisses alerts where the
// existing evidence is strong enough that a human doesn't need to
// look. Reduces the operator queue without using AI tokens — every
// decision is deterministic, replayable from the source row, and
// reversible (operator can flip status back to 'new' at any time).
//
// Three independent rule families dispatched by alert_type /
// source_type:
//
//   1. THREAT-SOURCED ALERTS (source_type='threat'): all reputation
//      sources cleared the IOC. See `decideThreatAutoTriage`.
//
//   2. SOCIAL IMPERSONATION (alert_type='social_impersonation'):
//      either the handle is on the brand's official_handles
//      allowlist (rule B), OR the impersonation score is below the
//      noise threshold (rule A, default 0.5). See
//      `decideSocialImpersonationTriage`.
//
//   3. APP STORE IMPERSONATION (alert_type='app_store_impersonation'):
//      either the developer matches the brand's official_apps
//      allowlist (rule B), OR the impersonation_score is below the
//      noise threshold (rule A, default 0.5). See
//      `decideAppStoreImpersonationTriage`.
//
// Every decision stamps a stable, machine-readable `reason` into
// `alerts.resolution_notes` so the dismissal trail is auditable.
// The rules err heavily toward keeping ambiguous alerts open —
// false-dismiss is the bigger risk; false-keep is just operator
// noise.

import type { D1Database } from '@cloudflare/workers-types';
import { isNewlyRegistered, NRD_MAX_AGE_DAYS } from './domain-age';
import { normalizeHandleForPlatform } from './handle-normalize';

export type AutoTriageDecision =
  | { action: 'dismiss'; reason: string }
  | { action: 'keep'; reason: string };

// ─── Threat-sourced alerts (Tier 1) ──────────────────────────────

export interface ThreatTriageSnapshot {
  vt_checked: number | null;
  vt_malicious: number | null;
  gsb_checked: number | null;
  gsb_flagged: number | null;
  greynoise_classification: string | null;
  seclookup_risk_score: number | null;
  ip_address: string | null;
  /** Domain age in whole days at detection time (D4 / NRD signal).
   *  NULL when VT had no WHOIS creation date. See lib/domain-age.ts. */
  domain_age_days: number | null;
  /**
   * Deterministic page-content credential-harvest flag (D6 / S2.4). 1
   * when lib/page-fetch.ts + page-phishing-scorer.ts observed a live
   * credential form posting to an off-domain endpoint on the suspect's
   * page. OPTIONAL / absent for threat-sourced snapshots — the threats
   * table has no page-analysis column, so this stays undefined there
   * and the guard below is a no-op for the threat flow (keeps `threats`
   * untouched this increment). Only lookalike-page analysis ever sets
   * it. See the guard in decideThreatAutoTriage. */
  page_credential_harvest?: number | null;
}

/**
 * Pure decision function — no I/O. Given the enrichment snapshot of
 * the underlying threat, decides whether the alert is safe enough to
 * auto-dismiss. Returns a `keep` decision (with reason) when any
 * single criterion fails.
 *
 * Conservative rule (ALL must hold):
 *   - VT consulted AND zero malicious detections
 *   - GSB consulted AND not flagged
 *   - GreyNoise either 'benign' or NULL (only checked when IP is set)
 *   - SecLookup risk score either NULL or below 30 (low band)
 *   - Domain is NOT newly registered (D4 / NRD guard, below)
 */
export function decideThreatAutoTriage(snapshot: ThreatTriageSnapshot): AutoTriageDecision {
  if (snapshot.vt_checked !== 1) return { action: 'keep', reason: 'vt_not_checked' };
  if ((snapshot.vt_malicious ?? 0) > 0) return { action: 'keep', reason: 'vt_flagged' };
  if (snapshot.gsb_checked !== 1) return { action: 'keep', reason: 'gsb_not_checked' };
  if ((snapshot.gsb_flagged ?? 0) > 0) return { action: 'keep', reason: 'gsb_flagged' };

  if (snapshot.ip_address) {
    const gn = snapshot.greynoise_classification;
    if (gn !== null && gn !== 'benign') {
      return { action: 'keep', reason: 'greynoise_not_benign' };
    }
  }

  if (snapshot.seclookup_risk_score !== null && snapshot.seclookup_risk_score >= 30) {
    return { action: 'keep', reason: 'seclookup_risk_score_high' };
  }

  // NRD guard (D4 / S2.4). A domain that every reputation feed cleared
  // but that was registered within NRD_MAX_AGE_DAYS of detection is the
  // classic false-negative: brand-new phishing infrastructure has no
  // reputation history yet, so VT/GSB/GreyNoise/SecLookup all read
  // "clean" precisely because the domain is too new to have been
  // reported. Withhold auto-dismissal and keep it for a human rather
  // than silently clearing a fresh impersonation domain. NULL age (VT
  // had no creation date) is NOT treated as an NRD — absence of
  // evidence, not evidence of youth. This only ever flips a would-be
  // dismissal to 'keep'; it never escalates severity, so the downside
  // of a false NRD flag is one extra alert in the human queue.
  if (isNewlyRegistered(snapshot.domain_age_days)) {
    return {
      action: 'keep',
      reason: `newly_registered_domain (age ${snapshot.domain_age_days}d <= ${NRD_MAX_AGE_DAYS}d)`,
    };
  }

  // Page-content credential-harvest guard (D6 / S2.4). Exactly like the
  // NRD guard above: only ever flips a would-be *dismiss* to 'keep',
  // never escalates severity. If the deterministic page fetcher observed
  // a live credential form exfiltrating to an off-domain endpoint, the
  // domain is actively phishing regardless of how clean every reputation
  // feed reads (fresh phishing infra has no reputation history yet), so
  // withhold auto-dismissal and leave it for a human. Scoped to
  // lookalike-page analysis — undefined/null for threat-sourced
  // snapshots, so the threats flow is unaffected this increment.
  if (snapshot.page_credential_harvest === 1) {
    return { action: 'keep', reason: 'page_credential_harvest_detected' };
  }

  return { action: 'dismiss', reason: 'auto: clean enrichment (vt+gsb+greynoise+seclookup)' };
}

/** @deprecated Renamed to `decideThreatAutoTriage`. Re-exported for callers
 *  that landed against the original Tier 1 module name. */
export const decideAutoTriage = decideThreatAutoTriage;

export async function loadThreatSnapshotForAlert(
  db: D1Database,
  sourceId: string,
): Promise<ThreatTriageSnapshot | null> {
  const row = await db.prepare(`
    SELECT vt_checked, vt_malicious,
           gsb_checked, gsb_flagged,
           greynoise_classification,
           seclookup_risk_score,
           ip_address,
           domain_age_days
    FROM threats
    WHERE id = ?
  `).bind(sourceId).first<ThreatTriageSnapshot>();
  return row ?? null;
}

// ─── Impersonation alerts (Tier 1.5) ─────────────────────────────

/** Default impersonation-score threshold below which we auto-dismiss
 *  (rule A). Scores 0.3-0.5 are mostly name-similarity noise without
 *  strong corroborating signals. Tunable per call site if needed. */
export const DEFAULT_IMPERSONATION_DISMISS_THRESHOLD = 0.5;

export interface BrandAllowlist {
  /** Brand display name (`brands.name`). Used for the brand-name
   *  match shortcut on app-store impersonation alerts where
   *  `details.developer_name` reduces to the brand name after
   *  stripping common company suffixes (Inc., Corp., Ltd., etc.). */
  name: string | null;
  /** brands.official_handles parsed: {"twitter":"@acme","linkedin":"acmecorp",...} */
  official_handles: Record<string, string> | null;
  /** brands.official_apps parsed: array of OfficialApp records */
  official_apps: Array<{
    platform?: string;
    app_id?: string;
    bundle_id?: string;
    developer_name?: string;
    developer_id?: string;
  }> | null;
}

export interface SocialImpersonationDetails {
  /** Lower-cased platform string ('twitter', 'instagram', etc.) */
  platform?: string;
  /** Handle as observed; may include a leading '@'. */
  handle?: string;
  /** Impersonation score 0.0-1.0 — higher = more likely impersonation. */
  score?: number;
  // Other fields (url, signals, check_type) ignored by the triage rule.
}

/**
 * Decide auto-triage for a social_impersonation alert.
 *
 *   Rule B (always-safe): handle matches the brand's official_handles
 *     entry for the same platform → dismiss.
 *   Rule A (low-confidence): impersonation score below threshold →
 *     dismiss.
 *
 * Otherwise keep open for human review. Both rules are independent;
 * either passing is sufficient to dismiss.
 */
export function decideSocialImpersonationTriage(
  details: SocialImpersonationDetails | null,
  allowlist: BrandAllowlist,
  threshold = DEFAULT_IMPERSONATION_DISMISS_THRESHOLD,
): AutoTriageDecision {
  if (!details) return { action: 'keep', reason: 'social_details_missing' };

  // Rule B — official handle match, normalized per the platform's own rules
  // so a dotted `jane.doe` matches an official `jane.doe` on Instagram but
  // does NOT spuriously match `janedoe` (bug #22). Guard against an empty
  // normalization on BOTH sides: an all-invalid-chars handle reduces to ''
  // for the platform, and '' === '' would be a false auto-dismiss on this
  // security-adjacent path (unreachable from the real probe, which only ever
  // yields valid >=2-char handles, but cheap defense-in-depth).
  if (allowlist.official_handles && details.platform && details.handle) {
    const platformKey = details.platform.toLowerCase();
    const officialRaw = allowlist.official_handles[platformKey];
    if (officialRaw) {
      const normOfficial = normalizeHandleForPlatform(officialRaw, platformKey);
      if (normOfficial !== '' && normOfficial === normalizeHandleForPlatform(details.handle, platformKey)) {
        return { action: 'dismiss', reason: 'auto: matches brand official handle' };
      }
    }
  }

  // Rule A — score below the dismiss threshold.
  const score = typeof details.score === 'number' ? details.score : 1;
  if (score < threshold) {
    return { action: 'dismiss', reason: `auto: low impersonation score (${score.toFixed(2)} < ${threshold})` };
  }

  return { action: 'keep', reason: 'high_impersonation_score' };
}

export interface AppStoreImpersonationDetails {
  /** Store identifier ('ios', 'google_play', etc.). */
  store?: string;
  app_id?: string;
  bundle_id?: string;
  app_name?: string;
  developer_name?: string;
  developer_id?: string;
  app_url?: string;
  /** Impersonation score 0.0-1.0 — higher = more likely impersonation. */
  impersonation_score?: number;
  // Other fields (signals, reason) ignored by the triage rule.
}

/**
 * Strip common company suffixes (Inc., Corp., Ltd., LLC, Co., GmbH,
 * Pty, etc.) and collapse whitespace so a developer_name like
 * "Adobe Inc." compares equal to a brand name like "Adobe".
 *
 * Conservative: only strips trailing tokens, never prefixes; never
 * removes words from inside the name. "Adobe Free Inc." stays as
 * "Adobe Free" (not "Adobe") so it doesn't accidentally match
 * "Adobe".
 */
export function normalizeCompanyName(raw: string): string {
  // Common corporate suffixes (lowercase, with and without trailing dot).
  const SUFFIX_TOKENS = new Set([
    'inc', 'inc.', 'incorporated',
    'corp', 'corp.', 'corporation',
    'ltd', 'ltd.', 'limited',
    'llc', 'llc.',
    'co', 'co.', 'company',
    'plc', 'plc.',
    'gmbh', 'gmbh.',
    'ag', 'ag.',
    'sa', 'sa.', 's.a.',
    'srl', 'srl.', 's.r.l.',
    'bv', 'bv.', 'b.v.',
    'pty', 'pty.',
    'oy', 'oy.',
    'kk', 'kk.', 'k.k.',
  ]);
  // Lowercase + trim once, then strip trailing punctuation.
  let s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  // Strip trailing comma+suffix patterns iteratively (handles
  // "Adobe Systems, Inc."). Compare each candidate suffix in two
  // forms — as-is and with internal dots removed — so "s.a", "s.a.",
  // and "sa" all collapse to the same SUFFIX_TOKENS hit.
  for (;;) {
    const stripped = s.replace(/[,.\s]+$/, '');
    const tokens = stripped.split(' ');
    const last = tokens[tokens.length - 1];
    if (last) {
      const lastNoDots = last.replace(/\./g, '');
      if (SUFFIX_TOKENS.has(last) || SUFFIX_TOKENS.has(lastNoDots)) {
        tokens.pop();
        s = tokens.join(' ').replace(/[,.\s]+$/, '');
        continue;
      }
    }
    s = stripped;
    break;
  }
  return s;
}

/**
 * Decide auto-triage for an app_store_impersonation alert.
 *
 *   Rule B (always-safe): app's bundle_id, app_id, developer_id, OR
 *     developer_name matches an entry in the brand's official_apps
 *     allowlist for the same store → dismiss. Also matches when
 *     `details.developer_name` reduces to `brand.name` after
 *     stripping common company suffixes (handles the very common
 *     case where a brand publishes apps under a "<BrandName> Inc."
 *     developer account but hasn't populated official_apps).
 *   Rule A (low-confidence): impersonation_score below threshold →
 *     dismiss.
 */
export function decideAppStoreImpersonationTriage(
  details: AppStoreImpersonationDetails | null,
  allowlist: BrandAllowlist,
  threshold = DEFAULT_IMPERSONATION_DISMISS_THRESHOLD,
): AutoTriageDecision {
  if (!details) return { action: 'keep', reason: 'app_store_details_missing' };

  // Rule B — official app allowlist match. Try the strongest
  // identifiers first (bundle_id, app_id, developer_id) and fall
  // back to a normalized developer_name match.
  if (allowlist.official_apps && Array.isArray(allowlist.official_apps)) {
    const store = details.store?.toLowerCase();
    const candidates = allowlist.official_apps.filter(
      (a) => !a.platform || !store || a.platform.toLowerCase() === store,
    );

    for (const off of candidates) {
      if (off.bundle_id && details.bundle_id && off.bundle_id.toLowerCase() === details.bundle_id.toLowerCase()) {
        return { action: 'dismiss', reason: 'auto: matches brand official bundle_id' };
      }
      if (off.app_id && details.app_id && String(off.app_id) === String(details.app_id)) {
        return { action: 'dismiss', reason: 'auto: matches brand official app_id' };
      }
      if (off.developer_id && details.developer_id && String(off.developer_id) === String(details.developer_id)) {
        return { action: 'dismiss', reason: 'auto: matches brand official developer_id' };
      }
      if (
        off.developer_name && details.developer_name &&
        off.developer_name.trim().toLowerCase() === details.developer_name.trim().toLowerCase()
      ) {
        return { action: 'dismiss', reason: 'auto: matches brand official developer' };
      }
    }
  }

  // Rule B+ — developer_name reduces to the brand's own name after
  // stripping company suffixes. Catches the "Adobe Inc." vs
  // brand_name "Adobe" case where the customer hasn't populated
  // official_apps. Conservative: only matches when the suffix-
  // stripped developer name equals the brand name exactly. Doesn't
  // do contains/prefix matching, so "Adobe Free Inc." (which
  // normalizes to "adobe free") does NOT match brand "Adobe".
  if (
    allowlist.name && details.developer_name &&
    normalizeCompanyName(details.developer_name) === normalizeCompanyName(allowlist.name)
  ) {
    return { action: 'dismiss', reason: 'auto: developer name matches brand name (suffix-normalized)' };
  }

  // Rule A — score below the dismiss threshold.
  const score = typeof details.impersonation_score === 'number' ? details.impersonation_score : 1;
  if (score < threshold) {
    return { action: 'dismiss', reason: `auto: low impersonation score (${score.toFixed(2)} < ${threshold})` };
  }

  return { action: 'keep', reason: 'high_impersonation_score' };
}

// ─── Executive impersonation alerts (Tier 1.5) ───────────────────

/** Details carried on an `executive_impersonation` alert. Mirrors the
 *  social-impersonation shape (the detector is HEAD-only, so the same
 *  three fields drive triage). */
export interface ExecutiveImpersonationDetails {
  /** Lower-cased platform string ('twitter', 'instagram', etc.). */
  platform?: string;
  /** Handle as observed; may include a leading '@'. */
  handle?: string;
  /** Impersonation score 0.0-1.0 — higher = more likely impersonation. */
  score?: number;
  // Other fields (url, signals) ignored by the triage rule.
}

/**
 * Allowlist for executive-impersonation triage — the EXECUTIVE's own
 * official handles (from the `org_executives` row), NOT the brand's.
 * A fake profile impersonating a named exec is safe to dismiss only
 * when it IS that exec's real, registered account.
 */
export interface ExecutiveAllowlist {
  /** org_executives.full_name. Reserved for a future name-match
   *  shortcut; unused by the current rules (kept for parity with
   *  BrandAllowlist and to avoid a signature change later). */
  full_name: string | null;
  /** org_executives.official_handles parsed:
   *  {"twitter":"@janedoe","linkedin":"jane-doe",...} */
  official_handles: Record<string, string> | null;
}

/**
 * Decide auto-triage for an `executive_impersonation` alert. Exact
 * structural mirror of `decideSocialImpersonationTriage`, but the
 * allowlist is the executive's official_handles rather than the
 * brand's.
 *
 *   Rule B (always-safe): handle matches the exec's official_handles
 *     entry for the same platform → dismiss.
 *   Rule A (low-confidence): impersonation score below threshold →
 *     dismiss.
 *
 * Otherwise keep open for human review. Both rules are independent;
 * either passing is sufficient to dismiss. Pure — no DB/env.
 */
export function decideExecutiveImpersonationTriage(
  details: ExecutiveImpersonationDetails | null,
  allowlist: ExecutiveAllowlist,
  threshold = DEFAULT_IMPERSONATION_DISMISS_THRESHOLD,
): AutoTriageDecision {
  if (!details) return { action: 'keep', reason: 'executive_details_missing' };

  // Rule B — official handle match, normalized per the platform's own rules
  // (bug #22) — identical to the social decider, keyed on the exec's handles.
  // Same empty-normalization guard: '' === '' must not auto-dismiss.
  if (allowlist.official_handles && details.platform && details.handle) {
    const platformKey = details.platform.toLowerCase();
    const officialRaw = allowlist.official_handles[platformKey];
    if (officialRaw) {
      const normOfficial = normalizeHandleForPlatform(officialRaw, platformKey);
      if (normOfficial !== '' && normOfficial === normalizeHandleForPlatform(details.handle, platformKey)) {
        return { action: 'dismiss', reason: 'auto: matches executive official handle' };
      }
    }
  }

  // Rule A — score below the dismiss threshold.
  const score = typeof details.score === 'number' ? details.score : 1;
  if (score < threshold) {
    return { action: 'dismiss', reason: `auto: low impersonation score (${score.toFixed(2)} < ${threshold})` };
  }

  return { action: 'keep', reason: 'high_impersonation_score' };
}

// ─── Brand allowlist loading ─────────────────────────────────────

/**
 * Bulk-load `official_handles` + `official_apps` for a set of
 * brand_ids in one query. Returns a Map keyed by brand_id with
 * parsed JSON. Brands without rows or with malformed JSON yield
 * an empty allowlist `{ name: null, official_handles: null, official_apps: null }`.
 */
export async function loadBrandAllowlists(
  db: D1Database,
  brandIds: string[],
): Promise<Map<string, BrandAllowlist>> {
  const result = new Map<string, BrandAllowlist>();
  if (brandIds.length === 0) return result;

  // De-dupe before binding to keep the IN-clause minimal even when
  // a batch contains many alerts for the same brand.
  const uniqueIds = Array.from(new Set(brandIds));
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT id, name, official_handles, official_apps
    FROM brands
    WHERE id IN (${placeholders})
  `).bind(...uniqueIds).all<{
    id: string;
    name: string | null;
    official_handles: string | null;
    official_apps: string | null;
  }>();

  for (const row of rows.results) {
    let handles: BrandAllowlist['official_handles'] = null;
    let apps: BrandAllowlist['official_apps'] = null;

    if (row.official_handles) {
      try {
        const parsed = JSON.parse(row.official_handles);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          handles = parsed as Record<string, string>;
        }
      } catch { /* malformed JSON — treat as empty */ }
    }

    if (row.official_apps) {
      try {
        const parsed = JSON.parse(row.official_apps);
        if (Array.isArray(parsed)) {
          apps = parsed as BrandAllowlist['official_apps'];
        }
      } catch { /* malformed JSON — treat as empty */ }
    }

    result.set(row.id, { name: row.name, official_handles: handles, official_apps: apps });
  }
  return result;
}

// ─── Executive allowlist loading ─────────────────────────────────

/**
 * Bulk-load `org_executives` (full_name + official_handles) for a set of
 * executive ids in one query. Returns a Map keyed by executive id with the
 * parsed `ExecutiveAllowlist`. Missing rows / malformed JSON yield an empty
 * allowlist `{ full_name: null, official_handles: null }`. Mirrors
 * `loadBrandAllowlists`, but keyed by executive_id (from alert
 * `details.executive_id`) rather than brand_id — a fake exec profile is
 * safe to dismiss only when it IS that exec's own registered account.
 */
export async function loadExecutiveAllowlists(
  db: D1Database,
  executiveIds: string[],
): Promise<Map<string, ExecutiveAllowlist>> {
  const result = new Map<string, ExecutiveAllowlist>();
  if (executiveIds.length === 0) return result;

  const uniqueIds = Array.from(new Set(executiveIds));
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT id, full_name, official_handles
    FROM org_executives
    WHERE id IN (${placeholders})
  `).bind(...uniqueIds).all<{
    id: string;
    full_name: string | null;
    official_handles: string | null;
  }>();

  for (const row of rows.results) {
    let handles: ExecutiveAllowlist['official_handles'] = null;
    if (row.official_handles) {
      try {
        const parsed = JSON.parse(row.official_handles);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          handles = parsed as Record<string, string>;
        }
      } catch { /* malformed JSON — treat as empty */ }
    }
    result.set(row.id, { full_name: row.full_name, official_handles: handles });
  }
  return result;
}

/**
 * Single-executive convenience loader for the real-time createAlert hook,
 * where only one alert (one executive_id) is in hand. Always returns a
 * usable allowlist — empty when the id is missing/malformed.
 */
export async function loadExecutiveAllowlist(
  db: D1Database,
  executiveId: string,
): Promise<ExecutiveAllowlist> {
  const map = await loadExecutiveAllowlists(db, [executiveId]);
  return map.get(executiveId) ?? { full_name: null, official_handles: null };
}

// ─── Backfill ────────────────────────────────────────────────────

export interface BackfillResult {
  scanned: number;
  dismissed: number;
  kept: number;
  no_threat: number;
  /** Breakdown by alert family for visibility post-deploy. */
  by_type: Record<string, { scanned: number; dismissed: number; kept: number }>;
}

interface AlertRow {
  id: string;
  brand_id: string;
  source_type: string | null;
  source_id: string | null;
  alert_type: string;
  details: string | null;
}

/**
 * Backfill pass over existing 'new' alerts. Processes a bounded
 * batch per call so the worker can run this from an admin endpoint
 * without busting CPU/wall budgets. Operators call repeatedly until
 * `scanned < limit` (queue drained). Idempotent — alerts whose
 * status moved out of 'new' are no-ops on re-run.
 *
 * Tier 1 + Tier 1.5: dispatches by alert_type:
 *   - 'threat'-sourced       → reputation-source check
 *   - 'social_impersonation' → official-handle + score-threshold
 *   - 'app_store_impersonation' → official-app + score-threshold
 *   - any other type         → skipped (counted as `kept` so
 *                              operators see the queue isn't being
 *                              ignored silently)
 */
export async function runAlertTriageBackfill(
  db: D1Database,
  opts?: { limit?: number; offset?: number; impersonationThreshold?: number },
): Promise<BackfillResult> {
  const limit = Math.min(1000, opts?.limit ?? 500);
  const offset = Math.max(0, opts?.offset ?? 0);
  const threshold = opts?.impersonationThreshold ?? DEFAULT_IMPERSONATION_DISMISS_THRESHOLD;

  // Pull ALL 'new' alerts in this window — not just threat-sourced —
  // so we can apply the alert_type-specific rule to each.
  //
  // OFFSET-paginated rather than re-querying status='new' from the
  // beginning each call. If a batch dismisses 0 alerts, the next
  // call MUST advance past the just-scanned set; otherwise the same
  // 500 alerts come back forever and the operator's loop never
  // exits. (Production caught this on the first backfill run —
  // 125K "kept" before manual intervention because nothing in the
  // queue was dismissing under the original Tier 1.5 rules and the
  // SQL had no progress marker.)
  const rows = await db.prepare(`
    SELECT id, brand_id, source_type, source_id, alert_type, details
    FROM alerts
    WHERE status = 'new'
    ORDER BY created_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all<AlertRow>();

  // Pre-load brand allowlists for the impersonation alerts in the
  // batch (one bulk query keeps it cheap regardless of batch size).
  const brandIdsForAllowlist = rows.results
    .filter((r) => r.alert_type === 'social_impersonation' || r.alert_type === 'app_store_impersonation')
    .map((r) => r.brand_id);
  const allowlists = await loadBrandAllowlists(db, brandIdsForAllowlist);

  // Pre-load executive allowlists for the exec-impersonation alerts in the
  // batch. These are keyed by details.executive_id (not brand_id), so parse
  // each alert's details once to collect the ids, then bulk-load.
  const executiveIdsForAllowlist = rows.results
    .filter((r) => r.alert_type === 'executive_impersonation')
    .map((r) => parseDetails<ExecutiveImpersonationDetails & { executive_id?: string }>(r.details)?.executive_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const executiveAllowlists = await loadExecutiveAllowlists(db, executiveIdsForAllowlist);

  let dismissed = 0;
  let kept = 0;
  let noThreat = 0;
  const byType: Record<string, { scanned: number; dismissed: number; kept: number }> = {};

  const trackType = (key: string, action: 'scanned' | 'dismissed' | 'kept') => {
    if (!byType[key]) byType[key] = { scanned: 0, dismissed: 0, kept: 0 };
    byType[key][action] += 1;
  };

  for (const alert of rows.results) {
    const typeKey = alert.alert_type ?? 'unknown';
    trackType(typeKey, 'scanned');

    let decision: AutoTriageDecision = { action: 'keep', reason: 'unhandled_alert_type' };

    if (alert.source_type === 'threat' && alert.source_id) {
      const snapshot = await loadThreatSnapshotForAlert(db, alert.source_id);
      if (!snapshot) {
        noThreat += 1;
        kept += 1;
        trackType(typeKey, 'kept');
        continue;
      }
      decision = decideThreatAutoTriage(snapshot);
    } else if (alert.alert_type === 'social_impersonation') {
      const details = parseDetails<SocialImpersonationDetails>(alert.details);
      const allow = allowlists.get(alert.brand_id) ?? { name: null, official_handles: null, official_apps: null };
      decision = decideSocialImpersonationTriage(details, allow, threshold);
    } else if (alert.alert_type === 'app_store_impersonation') {
      const details = parseDetails<AppStoreImpersonationDetails>(alert.details);
      const allow = allowlists.get(alert.brand_id) ?? { name: null, official_handles: null, official_apps: null };
      decision = decideAppStoreImpersonationTriage(details, allow, threshold);
    } else if (alert.alert_type === 'executive_impersonation') {
      const details = parseDetails<ExecutiveImpersonationDetails & { executive_id?: string }>(alert.details);
      const execId = details?.executive_id;
      const allow = (execId ? executiveAllowlists.get(execId) : undefined) ??
        { full_name: null, official_handles: null };
      decision = decideExecutiveImpersonationTriage(details, allow, threshold);
    }

    if (decision.action === 'dismiss') {
      await db.prepare(`
        UPDATE alerts
        SET status = 'false_positive',
            resolved_at = datetime('now'),
            resolution_notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'new'
      `).bind(decision.reason, alert.id).run();
      dismissed += 1;
      trackType(typeKey, 'dismissed');
    } else {
      kept += 1;
      trackType(typeKey, 'kept');
    }
  }

  return {
    scanned: rows.results.length,
    dismissed,
    kept,
    no_threat: noThreat,
    by_type: byType,
  };
}

function parseDetails<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return null;
  }
}
