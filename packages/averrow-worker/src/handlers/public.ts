// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Averrow — Public API Endpoints (no auth required)
 * All endpoints rate-limited. No sensitive data exposed.
 */

import { json } from "../lib/cors";
import { runSyncAgent } from "../lib/agentRunner";
import { publicTrustCheckAgent } from "../agents/public-trust-check";
import type { PublicTrustCheckOutput } from "../agents/public-trust-check";
import { getPublicStats } from "../lib/public-stats";
import { getPublicProof } from "../lib/public-proof";
import { cachedValue } from "../lib/cached-value";
import { normalizePublicHostname } from "../lib/public-hostname";
import { computePublicPosture, publicPostureSummary } from "./brandScan";
import type { Env } from "../types";

// ─── GET /api/v1/public/stats ────────────────────────────────────
//
// Disclosure-register fixes (docs/DISCLOSURE_REGISTER.md L4/L12/L20, G1):
//   - ONE threat total. `total_threats` (number) and `threats_detected`
//     (formatted string) both come from the same all-time
//     `COUNT(*) FROM threats` (cachedCount `count.threats.total`, carried
//     on the PublicStats object), so they always agree. The old cube SUM
//     (threat_cube_status) under-counted: it only covers rebuilt buckets.
//   - `detection_time_label` ("<5min") removed — it was a hard-coded,
//     unmeasured constant.
//   - `threats_today` is the correctly named "threats first bucketed today"
//     count. `certificates_today` is kept ONLY as a deprecated alias because
//     the frozen legacy SPA (public/app.js) reads it; it is not a
//     certificate count.
//   - `latest_insight_summary` removed: it published 80 chars of internal
//     agent output that can name brands (customer-data risk). public/app.js
//     reads it defensively (falsy → generic tile).
//   - `proof` added — measured, cached aggregates (lib/public-proof.ts).

/** Base aggregates, one cachedValue so anonymous traffic (the legacy SPA
 *  re-polls every 60s) reaches D1 at most once per TTL. */
interface PublicStatsBase {
  active_threats: number;
  brands_monitored: number;
  active_feeds: number;
  threat_campaigns: number;
  countries: number;
  threats_today: number;
  providers_mapped: number;
  threat_types: Array<{ threat_type: string; count: number }>;
}

const PUBLIC_STATS_BASE_TTL_S = 300;

async function computePublicStatsBase(env: Env): Promise<PublicStatsBase> {
  const todayBucket = new Date();
  todayBucket.setUTCHours(0, 0, 0, 0);
  const todayBucketStr = `${todayBucket.toISOString().slice(0, 10)} 00:00:00`;

  const [
    activeThreats, brandsMonitored, activeFeeds,
    campaigns, countries, threatsToday, providers, typeCounts,
  ] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status WHERE status IN ('active', 'unknown')").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM monitored_brands WHERE status = 'active'").first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as n FROM feed_status
       WHERE health_status IN ('healthy', 'degraded')
       AND feed_name NOT IN (SELECT feed_name FROM feed_configs WHERE enabled = 0)`
    ).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as n FROM campaigns").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(DISTINCT country_code) AS n FROM threat_cube_geo WHERE country_code != 'XX'").first<{ n: number }>(),
    env.DB.prepare("SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status WHERE hour_bucket >= ?").bind(todayBucketStr).first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(DISTINCT hosting_provider_id) AS n FROM threat_cube_provider").first<{ n: number }>(),
    env.DB.prepare(
      `SELECT threat_type, SUM(threat_count) AS count FROM threat_cube_status
       WHERE threat_type != 'unknown'
       GROUP BY threat_type ORDER BY count DESC`
    ).all<{ threat_type: string; count: number }>(),
  ]);

  return {
    active_threats: activeThreats?.n ?? 0,
    brands_monitored: brandsMonitored?.n ?? 0,
    active_feeds: activeFeeds?.n ?? 0,
    threat_campaigns: campaigns?.n ?? 0,
    countries: countries?.n ?? 0,
    threats_today: threatsToday?.n ?? 0,
    providers_mapped: providers?.n ?? 0,
    threat_types: typeCounts?.results ?? [],
  };
}

export async function handlePublicStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const [base, marketing, proof] = await Promise.all([
      cachedValue<PublicStatsBase>(env, "public.v1_stats.base.v1", PUBLIC_STATS_BASE_TTL_S, () => computePublicStatsBase(env)),
      // Marketing homepage shape (formatted strings, KV-cached). Powers
      // averrow-marketing's build-time fetch (scripts/fetch-stats.mjs).
      getPublicStats(env),
      getPublicProof(env),
    ]);

    return json({
      success: true,
      data: {
        // The ONE threat total (all-time threats table count) — see header.
        total_threats: marketing.threats_total,
        active_threats: base.active_threats,
        brands_monitored: base.brands_monitored,
        active_feeds: base.active_feeds,
        threat_campaigns: base.threat_campaigns,
        countries: base.countries,
        threats_today: base.threats_today,
        threats_classified_today: base.threats_today,
        providers_mapped: base.providers_mapped,
        threat_types: base.threat_types,
        // Legacy aliases — read by the frozen legacy SPA (public/app.js).
        brands_tracked: base.brands_monitored,
        /** @deprecated Mislabelled: this is threats today, not
         *  certificates. Kept only because public/app.js reads it. */
        certificates_today: base.threats_today,
        // ── Marketing homepage shape (formatted strings) ──
        // brands_monitored is a NUMBER above (the legacy SPA count-up
        // animation does arithmetic on it), so the marketing string form
        // is exposed under brands_monitored_label. NOTE: that label is the
        // brand CATALOG size (incl. passive tier='tracked'), not monitored
        // coverage — use proof.monitored_brands / proof.brands_in_catalog.
        agents_deployed: marketing.agents_deployed,
        feeds_protecting: marketing.feeds_protecting,
        threats_detected: marketing.threats_detected,
        brands_monitored_label: marketing.brands_monitored,
        uptime_label: marketing.uptime_label,
        // Measured proof points (G1) — see lib/public-proof.ts.
        proof,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/v1/public/geo ──────────────────────────────────────

export async function handlePublicGeo(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT latitude as lat, longitude as lng,
              CASE WHEN confidence_score >= 80 THEN 'critical'
                   WHEN confidence_score >= 60 THEN 'high'
                   WHEN confidence_score >= 40 THEN 'medium'
                   ELSE 'low' END as severity
       FROM threats
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY created_at DESC LIMIT 500`
    ).all<{ lat: number; lng: number; severity: string }>();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/v1/public/feeds ────────────────────────────────────
//
// Disclosure register L19: this endpoint used to publish every enabled
// feed's name, vendor, description (method), health and per-feed daily
// volume — the source list for competitors and a coverage/blind-spot map
// for attackers (T3). It now returns aggregate counts only.
//
// Shape stays tolerable for the frozen legacy SPA (public/app.js
// loadFeeds): `data` is an EMPTY ARRAY, which the SPA treats as "nothing to
// render" (`if (!grid || !feeds.length) return`). The counts ride beside it.
// `by_category` groups on feed_configs.feed_type (generic: e.g. ingest /
// enrichment) — never on feed names.

export interface PublicFeedsSummary {
  total_sources: number;
  by_category: Record<string, number>;
}

export const PUBLIC_FEEDS_TTL_S = 3600;

/** Generic category allowlist. feed_type is free text on an admin-editable
 *  table, so anything outside the known generic values collapses to
 *  `other` rather than risk echoing a feed-specific label. */
const PUBLIC_FEED_CATEGORIES = new Set(["ingest", "enrichment", "social"]);

export function publicFeedCategory(feedType: string | null | undefined): string {
  const t = (feedType ?? "ingest").toLowerCase();
  return PUBLIC_FEED_CATEGORIES.has(t) ? t : "other";
}

export async function handlePublicFeeds(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const summary = await cachedValue<PublicFeedsSummary>(env, "public.feeds.summary.v1", PUBLIC_FEEDS_TTL_S, async () => {
      const rows = await env.DB.prepare(
        `SELECT feed_type AS category, COUNT(*) AS n
           FROM feed_configs
          WHERE enabled = 1
          GROUP BY feed_type`
      ).all<{ category: string | null; n: number }>();
      const by_category: Record<string, number> = {};
      let total = 0;
      for (const r of rows.results ?? []) {
        const cat = publicFeedCategory(r.category);
        by_category[cat] = (by_category[cat] ?? 0) + r.n;
        total += r.n;
      }
      return { total_sources: total, by_category };
    });

    return json({ success: true, data: [], ...summary }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/v1/public/assess ──────────────────────────────────

/** H4(b): global daily ceiling on paid public AI assessments.
 *  Configurable via env.PUBLIC_ASSESS_DAILY_CAP (string, optional —
 *  not declared in wrangler.toml [vars]); defaults to 200/day. */
const PUBLIC_ASSESS_DAILY_CAP_DEFAULT = 200;

/** H4(c): shared per-IP limiter (10/hour) for every entry point that
 *  can trigger a paid public assessment. Used by both
 *  POST /api/v1/public/assess and the homepage POST /assess form so
 *  they draw from the same KV bucket. Returns a 429 Response when
 *  limited, null when the request may proceed. */
export async function publicAssessIpLimit(request: Request, env: Env): Promise<Response | null> {
  const origin = request.headers.get("Origin");
  // L2: CF-Connecting-IP only — X-Forwarded-For is client-spoofable.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimitKey = `pub_assess_${ip}`;
  const currentCount = parseInt(await env.CACHE.get(rateLimitKey) || "0", 10);
  if (currentCount >= 10) {
    return json({ success: false, error: "Rate limit exceeded. Please try again in an hour." }, 429, origin);
  }
  await env.CACHE.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 3600 });
  return null;
}

/** Public-safe view of an assessment, stored as `assessments.score_breakdown`
 *  JSON under `public`. Email posture only (SPF / DMARC / MX) — no Averrow
 *  threat data, so replaying it can't act as a detection oracle. */
interface PublicAssessmentView {
  version: 1;
  brand_name: string;
  trust_score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  assessment_text: string;
  spf_policy: string | null;
  dmarc_policy: string | null;
}

function isPublicAssessmentView(v: unknown): v is PublicAssessmentView {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.trust_score === "number" && typeof o.grade === "string"
    && typeof o.assessment_text === "string" && typeof o.brand_name === "string";
}

function postureGrade(score: number): PublicAssessmentView["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function publicAssessResponse(
  assessmentId: string, domain: string, view: PublicAssessmentView, assessedAt: string, cached: boolean,
): Record<string, unknown> {
  return {
    assessment_id: assessmentId,
    domain,
    brand_name: view.brand_name,
    trust_score: view.trust_score,
    grade: view.grade,
    assessment_text: view.assessment_text,
    spf_policy: view.spf_policy,
    dmarc_policy: view.dmarc_policy,
    assessed_at: assessedAt,
    ...(cached ? { cached: true } : {}),
  };
}

/** H4(a): fetch the most recent completed assessment for a domain that
 *  carries a public-safe view (rows written before the 2026-10-05
 *  detection-oracle fix don't, and are never replayed publicly).
 *  `maxAgeModifier` is a SQLite datetime modifier (e.g. '-24 hours');
 *  pass null for "most recent, any age" (global-cap fallback). */
async function getRecentAssessment(
  env: Env,
  domain: string,
  maxAgeModifier: string | null,
): Promise<Record<string, unknown> | null> {
  const stmt = maxAgeModifier
    ? env.DB.prepare(
        `SELECT id, domain, score_breakdown, completed_at
         FROM assessments
         WHERE domain = ? AND completed_at IS NOT NULL AND completed_at >= datetime('now', ?)
           AND score_breakdown IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      ).bind(domain, maxAgeModifier)
    : env.DB.prepare(
        `SELECT id, domain, score_breakdown, completed_at
         FROM assessments
         WHERE domain = ? AND completed_at IS NOT NULL AND score_breakdown IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      ).bind(domain);

  const row = await stmt.first<{
    id: string; domain: string; score_breakdown: string | null; completed_at: string;
  }>();
  if (!row) return null;

  let view: unknown = null;
  try {
    view = (JSON.parse(row.score_breakdown ?? "{}") as { public?: unknown }).public;
  } catch { /* malformed JSON — treat as not replayable */ }
  if (!isPublicAssessmentView(view)) return null;

  return publicAssessResponse(row.id, row.domain, view, row.completed_at, true);
}

export async function handlePublicAssess(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Rate limit: 10 per IP per hour (shared bucket with POST /assess)
    const limited = await publicAssessIpLimit(request, env);
    if (limited) return limited;
    // L2: CF-Connecting-IP only — X-Forwarded-For is client-spoofable.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    const body = await request.json().catch(() => null) as { domain?: string } | null;
    if (!body?.domain) return json({ success: false, error: "domain required" }, 400, origin);

    // Validate domain format — strict hostname (stored + rendered back).
    const domain = normalizePublicHostname(body.domain, { stripWww: true });
    if (!domain) {
      return json({ success: false, error: "Please enter a valid domain (e.g. yourbrand.com)" }, 400, origin);
    }

    // H4(a): a recent assessment for this domain short-circuits the
    // paid agent run entirely — same answer, zero AI spend.
    const recent = await getRecentAssessment(env, domain, "-24 hours");
    if (recent) {
      return json({ success: true, data: recent }, 200, origin);
    }

    const keyword = domain.split(".")[0]!;
    const brandName = keyword.charAt(0).toUpperCase() + keyword.slice(1);

    // Check if this brand is monitored
    const monitoredBrand = await env.DB.prepare(
      `SELECT b.id, b.name FROM brands b
       JOIN monitored_brands mb ON mb.brand_id = b.id
       WHERE mb.status = 'active' AND (b.canonical_domain = ? OR b.name LIKE ?)
       LIMIT 1`
    ).bind(domain, `%${keyword}%`).first<{ id: string; name: string }>();

    let threatCount: number, providerCount: number, campaignCount: number;
    let isMonitored = false;
    let threatTypes: { threat_type: string; count: number }[] = [];

    if (monitoredBrand) {
      // Brand is monitored — show REAL data
      isMonitored = true;
      const [tc, pc, cc, tt] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) as c FROM threats WHERE target_brand_id = ?`
        ).bind(monitoredBrand.id).first<{ c: number }>(),
        env.DB.prepare(
          `SELECT COUNT(DISTINCT hosting_provider_id) as c FROM threats
           WHERE target_brand_id = ? AND hosting_provider_id IS NOT NULL`
        ).bind(monitoredBrand.id).first<{ c: number }>(),
        env.DB.prepare(
          `SELECT COUNT(DISTINCT campaign_id) as c FROM threats
           WHERE target_brand_id = ? AND campaign_id IS NOT NULL`
        ).bind(monitoredBrand.id).first<{ c: number }>(),
        // Cube swap (cost-sweep 2026-05-16): threat_cube_brand has
        // (target_brand_id, threat_type, threat_count) so SUM is exact;
        // saves a per-brand scan of threats on every public-assess call.
        env.DB.prepare(
          `SELECT threat_type, SUM(threat_count) AS count
             FROM threat_cube_brand
            WHERE target_brand_id = ? AND threat_type != ''
            GROUP BY threat_type ORDER BY count DESC`
        ).bind(monitoredBrand.id).all<{ threat_type: string; count: number }>(),
      ]);
      threatCount = tc?.c ?? 0;
      providerCount = pc?.c ?? 0;
      campaignCount = cc?.c ?? 0;
      threatTypes = tt?.results ?? [];
    } else {
      // Not monitored — keyword-based scan
      const [tc, pc, cc] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) as c FROM threats
           WHERE malicious_url LIKE ? OR malicious_domain LIKE ?`
        ).bind(`%${keyword}%`, `%${keyword}%`).first<{ c: number }>(),
        env.DB.prepare(
          `SELECT COUNT(DISTINCT hosting_provider_id) as c FROM threats
           WHERE (malicious_url LIKE ? OR malicious_domain LIKE ?) AND hosting_provider_id IS NOT NULL`
        ).bind(`%${keyword}%`, `%${keyword}%`).first<{ c: number }>(),
        env.DB.prepare(
          `SELECT COUNT(DISTINCT id) as c FROM campaigns
           WHERE name LIKE ? OR id IN (
             SELECT DISTINCT campaign_id FROM threats
             WHERE campaign_id IS NOT NULL AND (malicious_url LIKE ? OR malicious_domain LIKE ?)
           )`
        ).bind(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`).first<{ c: number }>(),
      ]);
      threatCount = tc?.c ?? 0;
      providerCount = pc?.c ?? 0;
      campaignCount = cc?.c ?? 0;
    }

    // Check spam trap data for this brand
    let spamTrapCount = 0;
    let spamTrapIps = 0;
    try {
      const trapData = await env.DB.prepare(`
        SELECT COUNT(*) as count, COUNT(DISTINCT sending_ip) as ips
        FROM spam_trap_captures
        WHERE spoofed_domain = ? AND captured_at > datetime('now', '-30 days')
      `).bind(domain).first<{ count: number; ips: number }>();
      spamTrapCount = trapData?.count ?? 0;
      spamTrapIps = trapData?.ips ?? 0;
    } catch { /* spam trap tables may not exist yet */ }

    // Trust score, grade, and assessment text now come from the
    // public_trust_check sync agent (Phase 3.1 of agent audit).
    // The agent owns input validation (rejects non-conforming
    // domains and brand names so prompt injection can't reach the
    // model), the AI call itself, output schema validation, and a
    // deterministic fallback if either path fails. Handler stays
    // responsible for the surrounding I/O — DB lookups, rate limits,
    // and storing the assessment row.

    // H4(b): global daily ceiling on paid AI runs. Counter increments
    // only here — i.e. only when an AI run is actually about to start.
    // When the cap is hit, fall back to the most recent stored
    // assessment for this domain (any age); otherwise 429.
    const dailyCap = parseInt(env.PUBLIC_ASSESS_DAILY_CAP ?? "", 10) || PUBLIC_ASSESS_DAILY_CAP_DEFAULT;
    const capKey = `public_assess:global:${new Date().toISOString().slice(0, 10)}`;
    const globalCount = parseInt(await env.CACHE.get(capKey) || "0", 10);
    if (globalCount >= dailyCap) {
      const fallback = await getRecentAssessment(env, domain, null);
      if (fallback) {
        return json({ success: true, data: fallback }, 200, origin);
      }
      return json({ success: false, error: "Daily assessment capacity reached. Please try again tomorrow." }, 429, origin);
    }
    // 48h TTL comfortably outlives the UTC-day window the key encodes.
    await env.CACHE.put(capKey, String(globalCount + 1), { expirationTtl: 172800 });

    const agentRun = await runSyncAgent<PublicTrustCheckOutput>(
      env,
      publicTrustCheckAgent,
      {
        domain,
        threatCount,
        providerCount,
        campaignCount,
        isMonitored,
        brandName,
        spamTrapCount,
        spamTrapIps,
      },
    );

    // Defence in depth — agent.execute() already throws on a
    // catastrophic schema failure (and runSyncAgent maps that to
    // status='failed' with data=null). If we get here without data,
    // synthesise a minimal deterministic response so the homepage
    // never gets a 500.
    const trustScore = agentRun.data?.trustScore ?? Math.max(0, 100 - threatCount * 2);
    const grade = (agentRun.data?.grade ?? (trustScore >= 90 ? "A" : trustScore >= 80 ? "B" : trustScore >= 70 ? "C" : trustScore >= 60 ? "D" : "F")) as "A" | "B" | "C" | "D" | "F";
    const assessmentText = agentRun.data?.assessmentText
      ?? `${brandName} threat landscape — ${threatCount} known threats across ${providerCount} hosting provider(s) and ${campaignCount} campaign(s). Continuous monitoring is recommended.`;

    // Public view (detection-oracle fix 2026-10-05): the anonymous caller
    // gets an email-posture score from public DNS only. The threat-derived
    // score/grade/text above stay on the row for staff (lead intel reads
    // trust_score/grade); none of it — nor threat/provider/campaign counts,
    // threat types, monitored status, the monitored brand's name or
    // spam-trap hits — is returned here.
    const posture = await computePublicPosture(domain);
    const publicView: PublicAssessmentView = {
      version: 1,
      brand_name: brandName,
      trust_score: posture.trustScore,
      grade: postureGrade(posture.trustScore),
      assessment_text: publicPostureSummary(brandName, posture.trustScore),
      spf_policy: posture.spfPolicy,
      dmarc_policy: posture.dmarcPolicy,
    };

    // Store assessment. The requester IP is used only for the KV rate-limit
    // key above and is never persisted (PR-E: no visitor IP in D1).
    const assessmentId = `assess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare(
      `INSERT INTO assessments (id, domain, trust_score, grade, summary_text, threat_intel_results, score_breakdown, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      assessmentId, domain, trustScore, grade, assessmentText,
      JSON.stringify({ threat_count: threatCount, provider_count: providerCount, campaign_count: campaignCount, threat_types: threatTypes, is_monitored: isMonitored, brand_name: monitoredBrand?.name ?? brandName, spam_trap_count: spamTrapCount, spam_trap_ips: spamTrapIps }),
      // The H4 cached-replay path rebuilds the public response from this.
      JSON.stringify({ public: publicView }),
    ).run();

    // ─── Auto-add brand if it doesn't exist (from public assessment) ───
    try {
      const existingBrand = await env.DB.prepare(
        "SELECT id FROM brands WHERE canonical_domain = ?"
      ).bind(domain).first<{ id: string }>();
      if (!existingBrand) {
        const brandId = `brand_${domain.replace(/[^a-z0-9]+/g, "_")}`;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO brands (id, name, canonical_domain, source, first_seen, threat_count)
           VALUES (?, ?, ?, 'public_assess', datetime('now'), 0)`
        ).bind(brandId, brandName, domain).run();
      }
    } catch { /* non-fatal — brand creation is best-effort */ }

    return json({
      success: true,
      data: publicAssessResponse(assessmentId, domain, publicView, new Date().toISOString(), false),
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/v1/public/leads ───────────────────────────────────

const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "protonmail.com", "aol.com", "mail.com", "yandex.com", "live.com",
]);

export async function handlePublicLeadCapture(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Rate limit (L2: CF-Connecting-IP only — XFF is client-spoofable)
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateLimitKey = `pub_lead_${ip}`;
    const currentCount = parseInt(await env.CACHE.get(rateLimitKey) || "0", 10);
    if (currentCount >= 5) {
      return json({ success: false, error: "Rate limit exceeded." }, 429, origin);
    }
    await env.CACHE.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 3600 });

    const body = await request.json().catch(() => null) as {
      email?: string; name?: string; company?: string; role?: string;
      domain?: string; assessment_id?: unknown;
      // trust_score / grade may still arrive from the legacy SPA; they are
      // ignored — a lead never carries a caller-supplied score.
    } | null;

    if (
      typeof body?.email !== "string" || typeof body.name !== "string" || typeof body.company !== "string"
      || !body.email || !body.name || !body.company
      || (body.role !== undefined && body.role !== null && typeof body.role !== "string")
    ) {
      return json({ success: false, error: "Email, name, and company are required" }, 400, origin);
    }

    // Validate business email
    const emailDomain = body.email.split("@")[1]?.toLowerCase();
    if (!emailDomain || FREEMAIL_DOMAINS.has(emailDomain)) {
      return json({ success: false, error: "Please use your business email address" }, 400, origin);
    }

    // Optional domain; when present it must be a real hostname (it is
    // stored on the placeholder assessments row).
    let leadDomain = "";
    if (body.domain !== undefined && body.domain !== null && body.domain !== "") {
      const normalized = normalizePublicHostname(body.domain, { stripWww: true });
      if (!normalized) {
        return json({ success: false, error: "Please enter a valid domain (e.g. yourbrand.com)" }, 400, origin);
      }
      leadDomain = normalized;
    }

    const leadId = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Link the lead to a REAL assessment row, resolved server-side:
    //   1. the caller's assessment_id, only if that row exists;
    //   2. else the latest completed assessment for the caller's domain;
    //   3. else a placeholder row with NO score/grade (never the caller's).
    // Caller-supplied trust_score / grade are never stored.
    let assessmentId: string | null = null;
    if (typeof body.assessment_id === "string" && body.assessment_id.length > 0 && body.assessment_id.length <= 128) {
      const existing = await env.DB.prepare(
        "SELECT id FROM assessments WHERE id = ?",
      ).bind(body.assessment_id).first<{ id: string }>();
      assessmentId = existing?.id ?? null;
    }
    if (!assessmentId && leadDomain) {
      const latest = await env.DB.prepare(
        `SELECT id FROM assessments
         WHERE domain = ? AND completed_at IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      ).bind(leadDomain).first<{ id: string }>();
      assessmentId = latest?.id ?? null;
    }
    if (!assessmentId) {
      assessmentId = `assess_placeholder_${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO assessments (id, domain, trust_score, grade) VALUES (?, ?, NULL, NULL)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(assessmentId, leadDomain).run();
    }

    await env.DB.prepare(
      `INSERT INTO leads (id, assessment_id, name, email, company, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(leadId, assessmentId, body.name, body.email, body.company, body.role ? `Role: ${body.role}` : null).run();

    return json({ success: true, data: { lead_id: leadId } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/v1/public/monitor ────────────────────────────────
// Customer self-service: submit a domain for monitoring (creates brand + optional monitor)

export async function handlePublicMonitor(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Rate limit: 5 per IP per hour (L2: CF-Connecting-IP only)
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateLimitKey = `pub_monitor_${ip}`;
    const currentCount = parseInt(await env.CACHE.get(rateLimitKey) || "0", 10);
    if (currentCount >= 5) {
      return json({ success: false, error: "Rate limit exceeded. Please try again in an hour." }, 429, origin);
    }
    await env.CACHE.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 3600 });

    const body = await request.json().catch(() => null) as {
      domain?: string;
      email?: string;
      company?: string;
    } | null;

    if (!body?.domain) return json({ success: false, error: "domain required" }, 400, origin);

    // Strict hostname — this creates a brands row from anonymous input.
    const domain = normalizePublicHostname(body.domain, { stripWww: true });
    if (!domain) {
      return json({ success: false, error: "Please enter a valid domain" }, 400, origin);
    }

    const keyword = domain.split(".")[0]!;
    const brandName = keyword.charAt(0).toUpperCase() + keyword.slice(1);

    // Find or create brand
    let brand = await env.DB.prepare(
      "SELECT id FROM brands WHERE canonical_domain = ?"
    ).bind(domain).first<{ id: string }>();

    if (!brand) {
      const brandId = `brand_${domain.replace(/[^a-z0-9]+/g, "_")}`;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO brands (id, name, canonical_domain, source, first_seen, threat_count)
         VALUES (?, ?, ?, 'self_service', datetime('now'), 0)`
      ).bind(brandId, brandName, domain).run();
      brand = { id: brandId };
    }

    // Auto-add to monitored_brands
    await env.DB.prepare(
      `INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, notes, status)
       VALUES (?, '__internal__', 'self_service', ?, 'active')`
    ).bind(brand.id, body.email ? `Self-service by ${body.email}` : "Self-service submission").run();

    // Count existing threats
    const threatCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM threats
       WHERE malicious_url LIKE ? OR malicious_domain LIKE ?`
    ).bind(`%${keyword}%`, `%${keyword}%`).first<{ n: number }>();

    // Store lead if email provided
    if (body.email && body.company) {
      const leadId = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const assessmentId = `assess_monitor_${Date.now()}`;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO assessments (id, domain, trust_score, grade) VALUES (?, ?, 0, '?')`
      ).bind(assessmentId, domain).run();
      await env.DB.prepare(
        `INSERT INTO leads (id, assessment_id, name, email, company, notes)
         VALUES (?, ?, ?, ?, ?, 'Self-service monitor request')`
      ).bind(leadId, assessmentId, body.company, body.email, body.company).run();
    }

    return json({
      success: true,
      data: {
        brand_id: brand.id,
        domain,
        brand_name: brandName,
        existing_threats: threatCount?.n ?? 0,
        monitoring: true,
        message: `${brandName} is now being monitored. We'll detect threats targeting this domain.`,
      },
    }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
