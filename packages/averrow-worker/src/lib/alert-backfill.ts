/**
 * Claim-time alert backfill — synthesize the last N days of brand-signal
 * alerts from source tables (threats, lookalike_domains, ct_certificates,
 * social_profiles, app_store_listings, dark_web_mentions, spam_trap_captures)
 * for a brand that was just claimed by an organization.
 *
 * Why this exists: NX2 added a tier gate to createAlert so we don't
 * materialize alert rows for the ~76K passively-tracked brands (D1
 * row growth was unbounded). When a tenant claims a brand, the tier
 * flips to 'customer' but historical signals never produced alert
 * rows — without backfill the tenant's signals page would be empty
 * until the next scanner tick.
 *
 * Idempotency: every insert checks (brand_id, source_type, source_id,
 * alert_type) before INSERTing. Safe to re-run for the same brand any
 * number of times — duplicates are skipped.
 *
 * The helper bypasses the tier gate via `bypassTierGate: true`. This is
 * the only sanctioned bypass in the codebase; do not set the flag elsewhere.
 */

import type { Env } from "../types";
import { createAlert } from "./alerts";
import type { CreateAlertParams } from "./alerts";
import { clearsLookalikeAlertFloor } from "./lookalike-alert-policy";
import type { PageThreatLevel } from "./page-phishing-scorer";

export interface BackfillSummary {
  brand_id: string;
  since_days: number;
  scanned: number;        // total rows considered across all sources
  created: number;        // alerts inserted
  skipped_duplicate: number;
  errors: number;
  by_source: Record<string, { scanned: number; created: number; skipped: number; errors: number }>;
  duration_ms: number;
}

const SOURCES = [
  'threat',                  // threats table
  'lookalike_scanner',       // lookalike_domains table
  'ct_certificate',          // ct_certificates table
  'social_profile',          // social_profiles table (classification != 'official'/'legitimate')
  'app_store_listing',       // app_store_listings table
  'dark_web_mention',        // dark_web_mentions table
  'spam_trap',               // spam_trap_captures table
] as const;

type SourceType = typeof SOURCES[number];

function emptyBucket() {
  return { scanned: 0, created: 0, skipped: 0, errors: 0 };
}

export async function backfillAlertsForBrand(
  env: Env,
  brandId: string,
  sinceDays: number = 90,
): Promise<BackfillSummary> {
  const start = Date.now();
  const summary: BackfillSummary = {
    brand_id: brandId,
    since_days: sinceDays,
    scanned: 0,
    created: 0,
    skipped_duplicate: 0,
    errors: 0,
    by_source: Object.fromEntries(SOURCES.map(s => [s, emptyBucket()])) as BackfillSummary['by_source'],
    duration_ms: 0,
  };

  const sinceWindow = `-${sinceDays} days`;

  // Resolve a userId for the alert ownership. Alerts have a user_id NOT NULL
  // column — we use the first staff member of any org claiming this brand.
  // Falls back to the platform's owner user. Without a sensible userId the
  // alerts page filter (WHERE user_id = ?) would hide the backfill output.
  const owner = await env.DB.prepare(`
    SELECT om.user_id
      FROM org_brands ob
      JOIN org_members om ON om.org_id = ob.org_id
     WHERE ob.brand_id = ?
       AND om.role IN ('owner', 'admin', 'analyst')
     ORDER BY om.role = 'owner' DESC, om.role = 'admin' DESC, om.created_at ASC
     LIMIT 1
  `).bind(brandId).first<{ user_id: string }>();
  if (!owner?.user_id) {
    // No org owner resolvable; nothing to backfill to.
    summary.duration_ms = Date.now() - start;
    return summary;
  }
  const userId = owner.user_id;

  // ─── threats → threat_feed_match / phishing_detected ─────────────────
  await runSource(env, summary, 'threat', async () => {
    const rows = await env.DB.prepare(`
      SELECT id, threat_type, severity, source_feed, indicator, created_at
        FROM threats
       WHERE target_brand_id = ?
         AND created_at >= datetime('now', ?)
         AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 200
    `).bind(brandId, sinceWindow).all<{
      id: string; threat_type: string; severity: string;
      source_feed: string; indicator: string; created_at: string;
    }>();
    summary.by_source.threat!.scanned = rows.results.length;
    summary.scanned += rows.results.length;
    for (const r of rows.results) {
      const alertType = r.threat_type === 'phishing' ? 'phishing_detected' : 'threat_feed_match';
      await insertOnce(env, userId, {
        brandId,
        alertType,
        severity: normalizeSeverity(r.severity),
        title: `${alertType === 'phishing_detected' ? 'Phishing' : 'Threat feed match'}: ${r.indicator}`,
        summary: `${r.source_feed} reported ${r.threat_type} indicator ${r.indicator}`,
        sourceType: 'threat',
        sourceId: r.id,
        details: { feed: r.source_feed, threat_type: r.threat_type, indicator: r.indicator, observed_at: r.created_at },
      }, summary, 'threat');
    }
  });

  // ─── lookalike_domains → lookalike_domain_active ─────────────────────
  //
  // THE THIRD PRODUCER of this alert type, and until now the only one
  // that did not go through `lib/lookalike-alert-policy.ts`. It filed at
  // a hardcoded `medium` with no `registered` filter, so claiming a
  // brand the widened seeder had touched could file up to 100 MEDIUM
  // alerts — for domains that were not even registered — straight past
  // the HIGH floor both scanner paths respect, and with
  // `bypassTierGate: true` so `createAlert`'s own gate could not stop
  // them either. The policy module's docstring claimed "ONE definition,
  // imported by BOTH producers"; this is the import that makes it true.
  //
  // WHAT SEVERITY DOES A BACKFILLED ROW DESERVE? Not a fresh judgement,
  // and not a constant. `lookalike_domains.threat_level` is the level
  // the scanner ALREADY composited for this row — Haiku's read plus the
  // mail+web and BIMI boosts, plus any monotonic page escalation
  // `applyEscalation` wrote later. Reusing it makes the backfill file
  // exactly what the live producers would have filed, which is the whole
  // premise of claim-time backfill: these alerts are missing only
  // because the NX2 tier gate declined them while the brand was
  // `tracked`. Composing a NEW severity here would be a second opinion
  // nobody asked for, and a constant is how the floor got bypassed.
  //
  // NO EXEMPTION from the floor. The floor's argument is queue
  // arithmetic (see its docstring), and a claim-time burst of up to 100
  // rows into a tenant's brand-new signals page is the single worst
  // place to spend it: the backfill lands in one batch, the alerts can
  // never be auto-cleared, and a MEDIUM lookalike is precisely the
  // finding the floor decided does not earn permanent manual work. Rows
  // below the floor still arrive on the tenant's domains surface with
  // their persisted verdict — the data is the deliverable, the alert is
  // the notification.
  await runSource(env, summary, 'lookalike_scanner', async () => {
    const rows = await env.DB.prepare(`
      SELECT id, domain, permutation_type, threat_level, created_at
        FROM lookalike_domains
       WHERE brand_id = ?
         AND registered = 1
         AND created_at >= datetime('now', ?)
       ORDER BY created_at DESC
       LIMIT 100
    `).bind(brandId, sinceWindow).all<{
      id: string; domain: string; permutation_type: string | null;
      threat_level: string | null; created_at: string;
    }>();
    summary.by_source.lookalike_scanner!.scanned = rows.results.length;
    summary.scanned += rows.results.length;
    for (const r of rows.results) {
      const level = normalizeThreatLevel(r.threat_level);
      if (!clearsLookalikeAlertFloor(level)) {
        // Withheld, not dropped: the row keeps its verdict and stays
        // reachable by the page-analysis producer, which can raise the
        // alert later if the page turns out to be phishing. Counted as
        // `skipped` — the bucket already means "considered, no row
        // written", which is what happened.
        summary.skipped_duplicate++;
        summary.by_source.lookalike_scanner!.skipped++;
        continue;
      }
      await insertOnce(env, userId, {
        brandId,
        alertType: 'lookalike_domain_active',
        severity: normalizeSeverity(level),
        title: `Lookalike domain registered: ${r.domain}`,
        summary: `Lookalike ${r.permutation_type ?? 'variant'} of your brand domain detected.`,
        sourceType: 'lookalike_scanner',
        sourceId: r.id,
        details: {
          lookalike_domain: r.domain,
          permutation_type: r.permutation_type,
          threat_level: level,
          observed_at: r.created_at,
          // Distinguishes this producer from the other two inside the
          // same alert type, the same way the page pass marks its own.
          discovered_by: 'claim_backfill',
        },
      }, summary, 'lookalike_scanner');
    }
  });

  // ─── ct_certificates → ct_certificate_issued ─────────────────────────
  await runSource(env, summary, 'ct_certificate', async () => {
    const rows = await env.DB.prepare(`
      SELECT id, common_name, issuer_name, not_before
        FROM ct_certificates
       WHERE brand_id = ?
         AND not_before >= datetime('now', ?)
       ORDER BY not_before DESC
       LIMIT 100
    `).bind(brandId, sinceWindow).all<{
      id: string; common_name: string; issuer_name: string | null; not_before: string;
    }>();
    summary.by_source.ct_certificate!.scanned = rows.results.length;
    summary.scanned += rows.results.length;
    for (const r of rows.results) {
      await insertOnce(env, userId, {
        brandId,
        alertType: 'ct_certificate_issued',
        severity: 'high',
        title: `Certificate issued: ${r.common_name}`,
        summary: `Certificate issued by ${r.issuer_name ?? 'unknown CA'} for ${r.common_name}.`,
        sourceType: 'ct_certificate',
        sourceId: r.id,
        details: { common_name: r.common_name, issuer: r.issuer_name, not_before: r.not_before },
      }, summary, 'ct_certificate');
    }
  });

  // ─── social_profiles (impersonation/suspicious) → social_impersonation ──
  await runSource(env, summary, 'social_profile', async () => {
    const rows = await env.DB.prepare(`
      SELECT id, platform, handle, classification, classification_confidence, classified_at
        FROM social_profiles
       WHERE brand_id = ?
         AND classification IN ('suspicious', 'impersonation')
         AND COALESCE(classified_at, '') >= datetime('now', ?)
       ORDER BY classified_at DESC
       LIMIT 100
    `).bind(brandId, sinceWindow).all<{
      id: string; platform: string; handle: string;
      classification: string; classification_confidence: number | null; classified_at: string;
    }>();
    summary.by_source.social_profile!.scanned = rows.results.length;
    summary.scanned += rows.results.length;
    for (const r of rows.results) {
      await insertOnce(env, userId, {
        brandId,
        alertType: 'social_impersonation',
        severity: r.classification === 'impersonation' ? 'high' : 'medium',
        title: `Social impersonation: ${r.platform} @${r.handle}`,
        summary: `AI classified @${r.handle} on ${r.platform} as ${r.classification}.`,
        sourceType: 'social_profile',
        sourceId: r.id,
        details: {
          platform: r.platform, handle: r.handle,
          classification: r.classification, confidence: r.classification_confidence,
        },
      }, summary, 'social_profile');
    }
  });

  // ─── app_store_listings → app_store_impersonation ────────────────────
  await runSource(env, summary, 'app_store_listing', async () => {
    const rows = await env.DB.prepare(`
      SELECT id, store, app_name, developer_name, first_seen
        FROM app_store_listings
       WHERE matched_brand_id = ?
         AND first_seen >= datetime('now', ?)
         AND impersonation_verdict IN ('suspicious', 'impersonation')
       ORDER BY first_seen DESC
       LIMIT 50
    `).bind(brandId, sinceWindow).all<{
      id: string; store: string; app_name: string;
      developer_name: string | null; first_seen: string;
    }>();
    summary.by_source.app_store_listing!.scanned = rows.results.length;
    summary.scanned += rows.results.length;
    for (const r of rows.results) {
      await insertOnce(env, userId, {
        brandId,
        alertType: 'app_store_impersonation',
        severity: 'high',
        title: `App store impersonation: ${r.app_name} (${r.store})`,
        summary: `App "${r.app_name}" on ${r.store} by ${r.developer_name ?? 'unknown'} flagged as impersonation.`,
        sourceType: 'app_store_listing',
        sourceId: r.id,
        details: { store: r.store, app_name: r.app_name, developer: r.developer_name, first_seen: r.first_seen },
      }, summary, 'app_store_listing');
    }
  });

  // ─── dark_web_mentions → dark_web_mention ────────────────────────────
  await runSource(env, summary, 'dark_web_mention', async () => {
    const rows = await env.DB.prepare(`
      SELECT id, source, severity, snippet, observed_at
        FROM dark_web_mentions
       WHERE brand_id = ?
         AND observed_at >= datetime('now', ?)
       ORDER BY observed_at DESC
       LIMIT 50
    `).bind(brandId, sinceWindow).all<{
      id: string; source: string; severity: string;
      snippet: string | null; observed_at: string;
    }>();
    summary.by_source.dark_web_mention!.scanned = rows.results.length;
    summary.scanned += rows.results.length;
    for (const r of rows.results) {
      await insertOnce(env, userId, {
        brandId,
        alertType: 'dark_web_mention',
        severity: normalizeSeverity(r.severity),
        title: `Dark web mention on ${r.source}`,
        summary: r.snippet ? r.snippet.slice(0, 200) : `Mention observed on ${r.source}.`,
        sourceType: 'dark_web_mention',
        sourceId: r.id,
        details: { source: r.source, observed_at: r.observed_at },
      }, summary, 'dark_web_mention');
    }
  });

  // ─── spam_trap_captures → brand_threat (impersonation email) ────────
  // The spam-trap producer fires only a notification today (see NX1),
  // not an alert. Backfill DOES create alert rows here so the tenant
  // sees the impersonation history in the Signals tab.
  await runSource(env, summary, 'spam_trap', async () => {
    const rows = await env.DB.prepare(`
      SELECT id, from_address, spoofed_domain, severity, captured_at
        FROM spam_trap_captures
       WHERE spoofed_brand_id = ?
         AND captured_at >= datetime('now', ?)
       ORDER BY captured_at DESC
       LIMIT 100
    `).bind(brandId, sinceWindow).all<{
      id: string; from_address: string | null; spoofed_domain: string | null;
      severity: string; captured_at: string;
    }>();
    summary.by_source.spam_trap!.scanned = rows.results.length;
    summary.scanned += rows.results.length;
    for (const r of rows.results) {
      await insertOnce(env, userId, {
        brandId,
        alertType: 'phishing_detected',
        severity: normalizeSeverity(r.severity),
        title: `Spam trap: ${r.spoofed_domain ?? 'brand'} spoofed`,
        summary: `Spoofed email from ${r.from_address ?? 'unknown'} captured in honeypot.`,
        sourceType: 'spam_trap',
        sourceId: String(r.id),
        details: { from: r.from_address, spoofed_domain: r.spoofed_domain, captured_at: r.captured_at },
      }, summary, 'spam_trap');
    }
  });

  summary.duration_ms = Date.now() - start;
  return summary;
}

// ─── Helpers ───────────────────────────────────────────────────────

async function runSource(
  _env: Env,
  summary: BackfillSummary,
  source: SourceType,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // Per-source failure shouldn't kill the whole backfill — log and
    // increment the source's error counter so the diagnostics endpoint
    // surfaces it. Most likely cause: a source table doesn't exist in
    // this environment yet (e.g. dark_web_mentions on a fresh DB).
    summary.errors++;
    summary.by_source[source]!.errors++;
    console.error(`[alert-backfill] source=${source} error:`, err);
  }
}

async function insertOnce(
  env: Env,
  userId: string,
  params: Omit<CreateAlertParams, 'userId' | 'bypassTierGate'>,
  summary: BackfillSummary,
  source: SourceType,
): Promise<void> {
  try {
    // Idempotency: NX2 doesn't add a UNIQUE constraint on (brand_id,
    // source_type, source_id, alert_type) because the table has
    // historical rows we can't guarantee are clean. Code-side dedup
    // keeps backfill safe to re-run for the same brand without
    // requiring a migration.
    const existing = await env.DB.prepare(
      `SELECT 1 FROM alerts
        WHERE brand_id = ? AND source_type = ? AND source_id = ? AND alert_type = ?
        LIMIT 1`
    ).bind(params.brandId, params.sourceType ?? null, params.sourceId ?? null, params.alertType)
     .first<{ '1': number }>();
    if (existing) {
      summary.skipped_duplicate++;
      summary.by_source[source]!.skipped++;
      return;
    }
    const id = await createAlert(env.DB, { ...params, userId, bypassTierGate: true });
    if (id) {
      summary.created++;
      summary.by_source[source]!.created++;
    }
  } catch (err) {
    summary.errors++;
    summary.by_source[source]!.errors++;
    console.error(`[alert-backfill] insertOnce source=${source} error:`, err);
  }
}

// AlertSeverity is 'critical' | 'high' | 'medium' | 'low' — no 'info'
// tier exists for alerts (intentional; alerts are higher-stakes than
// notifications). Source-table severities that say 'info' map to 'low'
// rather than failing the type check.
/**
 * `lookalike_domains.threat_level` as a `PageThreatLevel`.
 *
 * The column is free TEXT with a `'LOW'` DEFAULT, so an unrecognised or
 * NULL value must land somewhere. LOW is the right floor-side default:
 * an unassessed row has produced no finding, and defaulting UP would
 * file an alert on the strength of a missing value.
 */
function normalizeThreatLevel(raw: string | null | undefined): PageThreatLevel {
  const v = (raw ?? '').toUpperCase();
  return v === 'CRITICAL' || v === 'HIGH' || v === 'MEDIUM' ? v : 'LOW';
}

function normalizeSeverity(s: string | null | undefined): 'critical' | 'high' | 'medium' | 'low' {
  const v = (s ?? '').toLowerCase();
  if (v === 'critical' || v === 'high' || v === 'medium' || v === 'low') return v;
  if (v === 'info') return 'low';
  // Default for unknown severity strings: medium. Conservative — won't
  // page the operator (high+critical) but stays visible in the inbox.
  return 'medium';
}
