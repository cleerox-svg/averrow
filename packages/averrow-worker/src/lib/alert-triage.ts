// Averrow — Alert auto-triage (Tier 1 + Tier 1.5 + lookalike official-domain)
//
// Conservative rule-based pass that auto-dismisses alerts where the
// existing evidence is strong enough that a human doesn't need to
// look. Reduces the operator queue without using AI tokens — every
// decision is deterministic, replayable from the source row, and
// reversible (operator can flip status back to 'new' at any time).
//
// Five independent rule families dispatched by alert_type /
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
//   4. EXECUTIVE IMPERSONATION (alert_type='executive_impersonation'):
//      mirror of (2) against the executive's own official_handles. See
//      `decideExecutiveImpersonationTriage`.
//
//   5. LOOKALIKE DOMAIN (alert_type='lookalike_domain_active' — every
//      producer, including the confirmed-new-registration alert — and
//      'typosquat_bimi'): the alerted domain is in the TRUSTED
//      official-domain set (lib/safeDomains.ts), or a non-shared-hosting
//      subdomain of a trusted key, and was not newly registered. An
//      untrusted match is kept with an "unverified" staff note. See
//      `decideLookalikeRegistrationTriage`.
//
// Every decision stamps a stable, machine-readable `reason` into
// `alerts.resolution_notes` so the dismissal trail is auditable.
// The rules err heavily toward keeping ambiguous alerts open —
// false-dismiss is the bigger risk; false-keep is just operator
// noise.

import type { D1Database } from '@cloudflare/workers-types';
import { isNewlyRegistered, NRD_MAX_AGE_DAYS } from './domain-age';
import { normalizeHandleForPlatform } from './handle-normalize';
import {
  loadOfficialDomainMatches,
  normalizeHost,
  officialDomainNote,
  resolveOfficialDomain,
  type OfficialDomainRow,
} from './safeDomains';
import { IDP_FAMILY_TECHNIQUES } from './idp-impersonation';

export type AutoTriageDecision =
  | { action: 'dismiss'; reason: string }
  /** `note`: optional internal annotation for the caller to record on a
   *  kept alert (lookalike rule: possible-owner, unverified). */
  | { action: 'keep'; reason: string; note?: string };

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
  /** threats.technique. An IdP-family technique (IDP_FAMILY_TECHNIQUES)
   *  makes reputation evidence inapplicable — see the guard in
   *  decideThreatAutoTriage. Optional so non-threat snapshots omit it. */
  technique?: string | null;
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
  // IdP-impersonation guard. An abused IdP tenant (acme-sso.okta.com) rides
  // the vendor's clean reputation, so VT/GSB/GreyNoise/SecLookup read clean
  // by construction; IdP lookalikes and device-code/OAuth-consent lures are
  // likewise fresh or ride Microsoft's own endpoints. Clean reputation is
  // not evidence of safety for any of the family — keep for a human.
  if (snapshot.technique && IDP_FAMILY_TECHNIQUES.includes(snapshot.technique)) {
    return { action: 'keep', reason: 'idp_impersonation_reputation_not_applicable' };
  }
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
           domain_age_days,
           technique
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

// ─── Lookalike-domain alerts (official-domain rule) ──────────────

/** Alert types the official-domain rule applies to. The new-registration
 *  alert (PR #1793) is `lookalike_domain_active` with `details.
 *  new_registration = true`, so it is covered by the first entry — and
 *  refused by the rule's new-registration guard. */
export const LOOKALIKE_TRIAGE_ALERT_TYPES: ReadonlySet<string> = new Set([
  'lookalike_domain_active',
  'typosquat_bimi',
]);

/** The fields lookalike producers write into `details` that this rule
 *  reads. The checker / page pass / claim backfill use `lookalike_domain`;
 *  the phantom matcher and the BIMI alert use `domain`. */
export interface LookalikeAlertDetails {
  lookalike_domain?: string;
  domain?: string;
  /** Set by the checker on a confirmed new registration (PR #1793). */
  new_registration?: boolean;
  /** ISO date of the confirmed registration, when known. */
  registered_at?: string;
  /** Domain age in whole days, when a producer knows it. */
  domain_age_days?: number;
  /** Phantom matcher (lib/phantom-matcher.ts): which feed observed the
   *  predicted domain. `'nrd'` = it is in the newly-registered-domain
   *  feed, i.e. a registration event — treated as newly registered. */
  matched_source?: string;
}

/** The alerted host from a lookalike alert's details, or null. */
export function lookalikeAlertDomain(details: LookalikeAlertDetails | null): string | null {
  if (!details) return null;
  const raw = typeof details.lookalike_domain === 'string' && details.lookalike_domain
    ? details.lookalike_domain
    : typeof details.domain === 'string' ? details.domain : '';
  const host = normalizeHost(raw);
  return host || null;
}

export interface LookalikeTriageContext {
  /** Rows `loadOfficialDomainMatches` returned (may cover a whole batch). */
  officialRows: readonly OfficialDomainRow[];
  /** `lookalike_domains.registration_evidence` for the alerted row
   *  ('nrd' | 'observed' = a confirmed recent registration). */
  registrationEvidence?: string | null;
  /** Clock for the `registered_at` age check. Defaults to Date.now(). */
  nowMs?: number;
}

/** Days since `details.registered_at`, or `details.domain_age_days`. */
function lookalikeDomainAgeDays(details: LookalikeAlertDetails, nowMs: number): number | null {
  if (typeof details.domain_age_days === 'number' && Number.isFinite(details.domain_age_days)) {
    return details.domain_age_days;
  }
  if (typeof details.registered_at === 'string' && details.registered_at) {
    const t = Date.parse(details.registered_at.replace(' ', 'T'));
    if (Number.isFinite(t)) return Math.floor((nowMs - t) / 86_400_000);
  }
  return null;
}

/**
 * Decide auto-triage for a lookalike-domain alert. PURE — the caller
 * passes the lookup results.
 *
 * DISMISS only when the alerted domain (lowercase, no trailing dot, www.
 * ignored) is in the TRUSTED official-domain set (lib/safeDomains.ts —
 * a heuristic: staff-entered safe domains, or the canonical domain of a
 * customer / manual / curated / Tranco top-20,000 brand, never of an
 * ai_attributed / public_assess / self_service brand), either exactly or
 * as a subdomain of a trusted key that is not shared hosting. Example:
 * zoom.com flagged as a lookalike of zoom.us.
 *
 * NEVER dismiss a newly registered domain — an established brand's
 * official domain cannot have been registered in the last
 * NRD_MAX_AGE_DAYS: `details.new_registration`, a phantom-matcher
 * `details.matched_source === 'nrd'`, a non-null row
 * `registration_evidence`, or a known age <= NRD_MAX_AGE_DAYS all keep.
 *
 * An UNTRUSTED exact match keeps the alert and returns a `note` naming
 * the possible owner as unverified, for the caller to record.
 *
 * Dismiss reasons start with `auto:` like every rule here
 * (lib/notification-cleanup.ts matches `auto:%`).
 */
export function decideLookalikeRegistrationTriage(
  details: LookalikeAlertDetails | null,
  ctx: LookalikeTriageContext,
): AutoTriageDecision {
  if (!details) return { action: 'keep', reason: 'lookalike_details_missing' };
  const host = lookalikeAlertDomain(details);
  if (!host) return { action: 'keep', reason: 'lookalike_domain_missing' };

  const { trusted, possible } = resolveOfficialDomain(host, ctx.officialRows);
  const match = trusted ?? possible;
  if (!match) return { action: 'keep', reason: 'not_an_official_domain' };
  const brand = match.brand_name ?? match.brand_id;

  const age = lookalikeDomainAgeDays(details, ctx.nowMs ?? Date.now());
  const newlyRegistered =
    details.new_registration === true ||
    details.matched_source === 'nrd' ||
    (ctx.registrationEvidence != null && ctx.registrationEvidence !== '') ||
    isNewlyRegistered(age);
  if (newlyRegistered) {
    return {
      action: 'keep',
      reason: 'newly_registered_domain',
      note: `${host} matches the official domain of ${brand} (${match.official_domain}) but was newly registered — not dismissed; verify ownership`,
    };
  }

  if (!trusted) {
    return {
      action: 'keep',
      reason: 'unverified_official_domain_match',
      note: `possible official domain of ${brand} (${match.official_domain}) — unverified`,
    };
  }
  return { action: 'dismiss', reason: officialDomainNote(host, trusted) };
}

/**
 * Registration evidence per DOMAIN, from `lookalike_domains` (indexed on
 * domain, migration 0282). Evidence is a property of the domain, not of
 * the brand that generated the permutation: if ANY brand's row for the
 * domain carries a confirmed registration ('nrd' | 'observed'), the domain
 * was newly registered and no brand's alert on it may be dismissed.
 * Chunked at 99 binds. Keyed by domain; the value is the first non-null
 * evidence seen, or null when no row has any.
 */
export async function loadLookalikeRegistrationEvidence(
  db: D1Database,
  domains: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = Array.from(new Set(domains));
  for (let i = 0; i < unique.length; i += 99) {
    const chunk = unique.slice(i, i + 99);
    const res = await db.prepare(
      `SELECT domain, registration_evidence
         FROM lookalike_domains
        WHERE domain IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<{ domain: string; registration_evidence: string | null }>();
    for (const r of res.results ?? []) {
      if (out.get(r.domain) == null) out.set(r.domain, r.registration_evidence ?? null);
    }
  }
  return out;
}

/**
 * Full lookalike decision for one alert, with the lookups. The official
 * lookup is one indexed statement; the registration-evidence read only
 * happens when the first pass would dismiss.
 */
export async function decideLookalikeAlert(
  db: D1Database,
  details: LookalikeAlertDetails | null,
): Promise<AutoTriageDecision> {
  const host = lookalikeAlertDomain(details);
  const officialRows = host ? await loadOfficialDomainMatches(db, [host]) : [];
  const first = decideLookalikeRegistrationTriage(details, { officialRows });
  if (first.action !== 'dismiss' || !host) return first;
  const ev = await loadLookalikeRegistrationEvidence(db, [host]);
  return decideLookalikeRegistrationTriage(details, {
    officialRows,
    registrationEvidence: ev.get(host) ?? null,
  });
}

/**
 * Side effects of a lookalike decision, after the alert row is written.
 *
 *   dismiss  -> the alert brand's `lookalike_domains` row for the domain
 *               goes `status='benign'` with `status_reason`, and is
 *               PARKED (check_due_at NULL, last_check_failed_at NULL — the
 *               un-park sweep only re-admits rows with a failure stamp).
 *               Sparrow skips benign rows, so no takedown is drafted.
 *               Only a `monitoring` row is changed: an analyst's
 *               confirmed_threat / taken_down / benign is never overwritten.
 *   keep + note -> written to `alerts.staff_notes` (internal, stripped
 *               from tenant reads) only when it is empty, so a human
 *               note is never overwritten.
 *
 * Idempotent: both writes are guarded.
 */
export async function applyLookalikeTriageEffects(
  db: D1Database,
  input: { alertId: string; brandId: string; details: LookalikeAlertDetails | null; decision: AutoTriageDecision },
): Promise<void> {
  const host = lookalikeAlertDomain(input.details);
  if (!host) return;
  if (input.decision.action === 'dismiss') {
    await markLookalikeRowBenign(db, input.brandId, host, input.decision.reason);
  } else if (input.decision.note) {
    await db.prepare(
      `UPDATE alerts SET staff_notes = ?, updated_at = datetime('now')
        WHERE id = ? AND (staff_notes IS NULL OR staff_notes = '')`,
    ).bind(input.decision.note, input.alertId).run();
  }
}

/** Set one lookalike row benign + parked (see applyLookalikeTriageEffects). */
export async function markLookalikeRowBenign(
  db: D1Database,
  brandId: string,
  domain: string,
  reason: string,
): Promise<number> {
  const res = await db.prepare(
    `UPDATE lookalike_domains
        SET status = 'benign',
            status_reason = ?,
            check_due_at = NULL,
            last_check_failed_at = NULL,
            updated_at = datetime('now')
      WHERE brand_id = ? AND domain = ? AND status = 'monitoring'`,
  ).bind(reason, brandId, domain).run();
  return res.meta?.changes ?? 0;
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
 *   - 'executive_impersonation' → exec official-handle + score-threshold
 *   - 'lookalike_domain_active' / 'typosquat_bimi'
 *                              → alerted domain is in the TRUSTED official-domain
 *                                set and not newly registered (dismiss also sets
 *                                the lookalike row benign + parked)
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

  // Pre-load official-domain rows for the lookalike alerts in the batch
  // (one indexed statement per 33 distinct lookup keys), then the
  // registration evidence of just the ones that would dismiss.
  const lookalikeAlerts = rows.results
    .filter((r) => LOOKALIKE_TRIAGE_ALERT_TYPES.has(r.alert_type) && r.source_type !== 'threat')
    .map((r) => {
      const details = parseDetails<LookalikeAlertDetails>(r.details);
      return { alert: r, details, host: lookalikeAlertDomain(details) };
    });
  const officialRows = await loadOfficialDomainMatches(
    db,
    lookalikeAlerts.map((a) => a.host).filter((h): h is string => typeof h === 'string'),
  );
  const evidenceDomains = lookalikeAlerts
    .filter((a) => a.host && decideLookalikeRegistrationTriage(a.details, { officialRows }).action === 'dismiss')
    .map((a) => a.host as string);
  const registrationEvidence = await loadLookalikeRegistrationEvidence(db, evidenceDomains);

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
    let lookalikeEffects: { details: LookalikeAlertDetails | null } | null = null;

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
    } else if (LOOKALIKE_TRIAGE_ALERT_TYPES.has(alert.alert_type)) {
      const details = parseDetails<LookalikeAlertDetails>(alert.details);
      const host = lookalikeAlertDomain(details);
      decision = decideLookalikeRegistrationTriage(details, {
        officialRows,
        registrationEvidence: host ? registrationEvidence.get(host) ?? null : null,
      });
      lookalikeEffects = { details };
    }

    let alertDismissed = false;
    if (decision.action === 'dismiss') {
      const upd = await db.prepare(`
        UPDATE alerts
        SET status = 'false_positive',
            resolved_at = datetime('now'),
            resolution_notes = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'new'
      `).bind(decision.reason, alert.id).run();
      alertDismissed = (upd.meta?.changes ?? 0) > 0;
      dismissed += 1;
      trackType(typeKey, 'dismissed');
    } else {
      kept += 1;
      trackType(typeKey, 'kept');
    }

    // Lookalike side effects AFTER the alert write, same order as
    // createAlert (lib/alerts.ts). Both writes are guarded, so a re-run
    // is a no-op. A dismissal only marks the lookalike row benign when
    // THIS call actually dismissed the alert — if a human moved it out of
    // 'new' between the SELECT and the UPDATE, their decision stands and
    // the row is left alone.
    if (lookalikeEffects && (decision.action !== 'dismiss' || alertDismissed)) {
      await applyLookalikeTriageEffects(db, {
        alertId: alert.id, brandId: alert.brand_id, details: lookalikeEffects.details, decision,
      });
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
