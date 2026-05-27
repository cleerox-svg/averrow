/**
 * Brand scoring — Health (defensive posture) + Exposure (offensive pressure)
 *
 * Per the v3 architecture decision (.claude/plans/v3.md §9.6 + research
 * synthesis), brand scoring splits into TWO orthogonal dimensions:
 *
 *   brand_health_score   — 0-100, higher = better defensive posture
 *                          (email auth, official social/app presence,
 *                          monitoring engagement)
 *   brand_exposure_score — 0-100, higher = worse offensive pressure
 *                          (active threats, impersonations, dark web,
 *                          lookalikes, open takedowns)
 *
 * No major DRP vendor publishes this two-axis decomposition (per the
 * Phase 2 research). It's a Averrow differentiator. The legacy single
 * `exposure_score` column (mixing defense + offense) is kept in sync
 * for backward-compatible read paths until callers migrate over.
 *
 * Per-brand recompute: `computeBrandExposureScore(env, brandId)` —
 * unchanged signature; existing 5 callers (analyst, brands handler,
 * dark-web/social/app-store scanners) trigger this on signal changes.
 *
 * Daily batch: `computeBrandScoresBatch(env)` — efficient at scale
 * via one aggregate query per signal category, grouped by brand_id.
 * Writes columns + a brand_score_snapshots row per brand per day.
 */

import type { Env } from "../types";

const WEIGHTS = {
  threat_activity: 0.24,       // active threats targeting this brand
  email_security: 0.16,        // SPF/DKIM/DMARC posture
  social_risk: 0.20,           // social impersonation risk
  domain_risk: 0.12,           // lookalike domains
  campaign_association: 0.08,  // linked to active campaigns
  app_store_risk: 0.10,        // mobile-app impersonation (iOS; Google Play later)
  dark_web_risk: 0.10,         // paste-archive mentions (Telegram / HIBP / Flare later)
};

export interface BrandExposureResult {
  exposure_score: number;
  social_risk_score: number;
  domain_risk_score: number;
  threat_score: number;
  email_score: number;
  campaign_score: number;
  app_store_score: number;
  dark_web_score: number;
  brand_health_score?: number;     // v3: defense-only score
  brand_exposure_score?: number;   // v3: offense-only score
  brand_health_grade?: string;     // v3: A+..F derived from brand_health_score
}

export async function computeBrandExposureScore(
  env: Env,
  brandId: string,
): Promise<BrandExposureResult> {
  // 1. Threat activity score (0-100, higher = more threats = worse)
  const threatCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id = ? AND status = 'active'"
  ).bind(brandId).first<{ n: number }>();
  const threatScore = Math.min(100, (threatCount?.n || 0) * 5); // 20+ threats = max

  // 2. Email security score (invert grade: A=0, F=100)
  const emailGrade = await env.DB.prepare(`
    SELECT email_security_grade FROM brands WHERE id = ?
  `).bind(brandId).first<{ email_security_grade: string | null }>();

  const gradeScores: Record<string, number> = {
    'A+': 0, 'A': 10, 'A-': 15, 'B+': 20, 'B': 30, 'B-': 35,
    'C+': 40, 'C': 50, 'C-': 55, 'D+': 60, 'D': 75, 'D-': 80, 'F': 100,
  };
  const emailScore = gradeScores[emailGrade?.email_security_grade || ''] ?? 50;

  // 3. Social risk score (0-100)
  const socialProfiles = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN classification = 'impersonation' AND status = 'active' THEN 1 ELSE 0 END) AS impersonations,
      SUM(CASE WHEN classification = 'suspicious' AND status = 'active' THEN 1 ELSE 0 END) AS suspicious
    FROM social_profiles WHERE brand_id = ?
  `).bind(brandId).first<{ impersonations: number; suspicious: number }>();
  const socialScore = Math.min(100,
    (socialProfiles?.impersonations || 0) * 25 +
    (socialProfiles?.suspicious || 0) * 10
  );

  // 4. Domain risk (lookalike domains)
  const lookalikes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM lookalike_domains WHERE brand_id = ? AND status = 'active'"
  ).bind(brandId).first<{ n: number }>();
  const domainScore = Math.min(100, (lookalikes?.n || 0) * 5);

  // 5. Campaign association
  const campaigns = await env.DB.prepare(
    "SELECT COUNT(DISTINCT t.campaign_id) AS n FROM threats t WHERE t.target_brand_id = ? AND t.campaign_id IS NOT NULL AND t.status = 'active'"
  ).bind(brandId).first<{ n: number }>();
  const campaignScore = Math.min(100, (campaigns?.n || 0) * 20);

  // 6. App-store risk — mobile-app impersonations (iOS; Play later).
  //    Single query; table may have no rows for new brands.
  const appStoreCounts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN classification = 'impersonation' AND status = 'active' THEN 1 ELSE 0 END) AS impersonations,
      SUM(CASE WHEN classification = 'suspicious'   AND status = 'active' THEN 1 ELSE 0 END) AS suspicious
    FROM app_store_listings WHERE brand_id = ?
  `).bind(brandId).first<{ impersonations: number; suspicious: number }>();
  const appStoreScore = Math.min(100,
    (appStoreCounts?.impersonations || 0) * 25 +
    (appStoreCounts?.suspicious || 0) * 10
  );

  // 7. Dark-web risk — paste-archive mentions (Telegram / HIBP / Flare later).
  //    Confirmed weighs heavier than suspicious; severity already filters the
  //    feed before rows land here, so we don't double-weight by severity.
  const darkWebCounts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN classification = 'confirmed'  AND status = 'active' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN classification = 'suspicious' AND status = 'active' THEN 1 ELSE 0 END) AS suspicious
    FROM dark_web_mentions WHERE brand_id = ?
  `).bind(brandId).first<{ confirmed: number; suspicious: number }>();
  const darkWebScore = Math.min(100,
    (darkWebCounts?.confirmed || 0) * 20 +
    (darkWebCounts?.suspicious || 0) * 5
  );

  // Weighted composite (legacy — mixes defense + offense)
  const composite = Math.round(
    threatScore * WEIGHTS.threat_activity +
    emailScore * WEIGHTS.email_security +
    socialScore * WEIGHTS.social_risk +
    domainScore * WEIGHTS.domain_risk +
    campaignScore * WEIGHTS.campaign_association +
    appStoreScore * WEIGHTS.app_store_risk +
    darkWebScore * WEIGHTS.dark_web_risk
  );

  // ─── v3 split: Brand Health (defense) vs Brand Exposure (offense) ───
  //
  // Brand Health = inverted email score (defense is GOOD when email
  // posture is GOOD — emailScore in this function uses a 0=A+ to
  // 100=F scale, so we invert) plus a small monitoring-engagement
  // bonus when the brand is being actively scanned.
  const brandRow = await env.DB.prepare(`
    SELECT monitoring_status, official_handles, official_apps
    FROM brands WHERE id = ?
  `).bind(brandId).first<{
    monitoring_status: string | null;
    official_handles: string | null;
    official_apps: string | null;
  }>();

  const officialSocialCount = countJsonEntries(brandRow?.official_handles);
  const officialAppCount    = countJsonEntries(brandRow?.official_apps);

  const healthFromEmail = 100 - emailScore;                                    // higher = better
  const healthFromSocials = Math.min(20, officialSocialCount * 5);             // 0-20
  const healthFromApps    = Math.min(10, officialAppCount * 5);                // 0-10
  const healthFromActive  = brandRow?.monitoring_status === 'active' ? 10 : 0; // 0-10

  // Re-weight email contribution to 60 max so socials/apps/active can
  // top up to 100 (60 + 20 + 10 + 10 = 100). Linear remap from 0-100 → 0-60.
  const emailContribution = Math.round((healthFromEmail / 100) * 60);
  const brandHealthScore  = Math.min(100,
    emailContribution + healthFromSocials + healthFromApps + healthFromActive,
  );
  const brandHealthGrade  = scoreToGrade(brandHealthScore);

  // Brand Exposure = the offense-only weighted composite (re-normalized
  // to drop the email_security weight since that belongs to Health now).
  const offenseDenom =
    WEIGHTS.threat_activity +
    WEIGHTS.social_risk +
    WEIGHTS.domain_risk +
    WEIGHTS.campaign_association +
    WEIGHTS.app_store_risk +
    WEIGHTS.dark_web_risk;
  const brandExposureScore = Math.round((
    threatScore   * WEIGHTS.threat_activity +
    socialScore   * WEIGHTS.social_risk +
    domainScore   * WEIGHTS.domain_risk +
    campaignScore * WEIGHTS.campaign_association +
    appStoreScore * WEIGHTS.app_store_risk +
    darkWebScore  * WEIGHTS.dark_web_risk
  ) / offenseDenom);

  // Single UPDATE that writes both legacy + v3 columns. Existing callers
  // reading exposure_score keep working; new callers (BrandDetail v3 Risk
  // tab in PR8) read brand_health_score + brand_exposure_score.
  await env.DB.prepare(`
    UPDATE brands SET
      exposure_score = ?,
      social_risk_score = ?,
      domain_risk_score = ?,
      brand_health_score = ?,
      brand_exposure_score = ?,
      brand_health_grade = ?,
      brand_health_updated_at = datetime('now'),
      brand_exposure_updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    composite, socialScore, domainScore,
    brandHealthScore, brandExposureScore, brandHealthGrade,
    brandId,
  ).run();

  return {
    exposure_score: composite,
    social_risk_score: socialScore,
    domain_risk_score: domainScore,
    threat_score: threatScore,
    email_score: emailScore,
    campaign_score: campaignScore,
    app_store_score: appStoreScore,
    dark_web_score: darkWebScore,
    brand_health_score: brandHealthScore,
    brand_exposure_score: brandExposureScore,
    brand_health_grade: brandHealthGrade,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function scoreToGrade(score: number): string {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// official_handles is stored as JSON object {"twitter":"@x","linkedin":"y"};
// official_apps is stored as JSON array. Count matches either shape.
function countJsonEntries(json: string | null | undefined): number {
  if (!json) return 0;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.length;
    if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed).length;
    return 0;
  } catch {
    return 0;
  }
}

// ─── Daily batch + snapshot ────────────────────────────────────────
//
// Recomputes scores for ALL brands and writes a row per brand per
// day to brand_score_snapshots. The Risk tab + Intel tab + "improving
// brands" mover list all read this table.
//
// Scope decision: the original implementation scored only 'monitored'
// and 'customer' tier brands, on the rationale that tracked brands
// have no signal worth snapshotting. The product requirement evolved
// — scores are used to evaluate the entire brand catalog (current
// customers, prospects, and the long tail alike), so the tier filter
// has been removed. Brands with no signal land at zeroed-out scores,
// which is itself a valid display state (flat-zero sparkline =
// "no risk detected").
//
// At ~78K brands the prior serial loop would run ~3 hours and exceed
// the Workers wall-clock cap. Replaced with concurrent waves of 20
// and a 12-min budget; counters are race-free because JS is
// single-threaded between awaits (same pattern as the AbuseIPDB,
// sentinel, and curator refactors).
//
// When the budget is hit, the loop exits cleanly and reports
// `budget_hit: true` so the orchestrator log surfaces deferred work.
// Snapshots are upserted, so a partial run on day N just leaves
// fewer-than-78K rows for that day — harmless to the sparkline /
// mover-list queries which gracefully handle gaps.

const BATCH_CONCURRENCY = 20;
const BATCH_WALLTIME_MS = 12 * 60_000;

export interface BatchScoreSummary {
  scanned: number;
  scored: number;
  skipped: number;
  errors: number;
  duration_ms: number;
  budget_hit: boolean;
}

export async function computeBrandScoresBatch(env: Env): Promise<BatchScoreSummary> {
  const start = Date.now();
  const summary: BatchScoreSummary = {
    scanned: 0, scored: 0, skipped: 0, errors: 0,
    duration_ms: 0, budget_hit: false,
  };

  // Score the full brand catalog. Exclude only the trash bin
  // (deleted/merged rows). canonical_domain IS NULL brands stay
  // included — their email_score path returns the default and the
  // signal-side queries still run cleanly.
  const targets = await env.DB.prepare(`
    SELECT id FROM brands
    WHERE COALESCE(monitoring_status, '') NOT IN ('deleted', 'merged')
  `).all<{ id: string }>();
  summary.scanned = targets.results.length;

  const today = new Date().toISOString().slice(0, 10);

  // Counters incremented inside the wave closures; race-free because
  // JS is single-threaded between awaits.
  let scored = 0;
  let errors = 0;

  const scoreOne = async (id: string): Promise<void> => {
    try {
      const result = await computeBrandExposureScore(env, id);

      // Snapshot — single UPSERT per brand per day. Inputs JSON
      // captures the breakdown so weight tuning is replayable.
      await env.DB.prepare(`
        INSERT INTO brand_score_snapshots
          (brand_id, snapshot_day, brand_health_score, brand_exposure_score, brand_health_grade,
           health_inputs_json, exposure_inputs_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(brand_id, snapshot_day) DO UPDATE SET
          brand_health_score = excluded.brand_health_score,
          brand_exposure_score = excluded.brand_exposure_score,
          brand_health_grade = excluded.brand_health_grade,
          health_inputs_json = excluded.health_inputs_json,
          exposure_inputs_json = excluded.exposure_inputs_json
        WHERE brand_score_snapshots.brand_health_score   IS NOT excluded.brand_health_score
           OR brand_score_snapshots.brand_exposure_score IS NOT excluded.brand_exposure_score
           OR brand_score_snapshots.brand_health_grade   IS NOT excluded.brand_health_grade
           OR brand_score_snapshots.health_inputs_json   IS NOT excluded.health_inputs_json
           OR brand_score_snapshots.exposure_inputs_json IS NOT excluded.exposure_inputs_json
      `).bind(
        id, today,
        result.brand_health_score ?? null,
        result.brand_exposure_score ?? null,
        result.brand_health_grade ?? null,
        JSON.stringify({
          email: result.email_score,
        }),
        JSON.stringify({
          threats:    result.threat_score,
          social:     result.social_risk_score,
          domain:     result.domain_risk_score,
          campaigns:  result.campaign_score,
          app_store:  result.app_store_score,
          dark_web:   result.dark_web_score,
        }),
      ).run();

      scored++;
    } catch {
      errors++;
    }
  };

  for (let i = 0; i < targets.results.length; i += BATCH_CONCURRENCY) {
    if (Date.now() - start > BATCH_WALLTIME_MS) {
      summary.budget_hit = true;
      break;
    }
    const wave = targets.results.slice(i, i + BATCH_CONCURRENCY);
    await Promise.all(wave.map(({ id }) => scoreOne(id)));
  }

  summary.scored = scored;
  summary.errors = errors;
  summary.skipped = summary.scanned - summary.scored - summary.errors;
  summary.duration_ms = Date.now() - start;
  return summary;
}
