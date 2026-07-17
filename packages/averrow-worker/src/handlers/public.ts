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
import type { Env } from "../types";

// ─── GET /api/v1/public/stats ────────────────────────────────────

export async function handlePublicStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // ─── Cube-routed reads (Group 3 D1 read-budget remediation) ────
    // Threats aggregates here used to scan the threats table on every
    // anon homepage hit (~tens of thousands of rows × thousands of hits
    // per day). All "all-threats" counts now read the 30-day status
    // cube, country count reads the geo cube, provider count reads the
    // provider cube. Semantics shift from all-time to 30-day rolling —
    // intentional: stale-signal threats (>30 days old) aren't useful in
    // a freshness-sensitive headline. confidence_score breakdown is
    // dropped (no cube dimension) and replaced with classifiedToday=0.
    const todayBucket = new Date();
    todayBucket.setUTCHours(0, 0, 0, 0);
    const todayBucketStr = `${todayBucket.toISOString().slice(0, 10)} 00:00:00`;

    const [
      totalThreats, activeThreats, brandsMonitored, activeFeeds,
      campaigns, countries, threatsToday,
      latestInsight, providers, typeCounts,
      marketing,
    ] = await Promise.all([
      env.DB.prepare("SELECT COALESCE(SUM(threat_count), 0) AS n FROM threat_cube_status").first<{ n: number }>(),
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
      env.DB.prepare("SELECT summary FROM agent_outputs WHERE agent_id = 'observer' ORDER BY created_at DESC LIMIT 1").first<{ summary: string }>(),
      env.DB.prepare("SELECT COUNT(DISTINCT hosting_provider_id) AS n FROM threat_cube_provider").first<{ n: number }>(),
      env.DB.prepare(
        `SELECT threat_type, SUM(threat_count) AS count FROM threat_cube_status
         WHERE threat_type != 'unknown'
         GROUP BY threat_type ORDER BY count DESC`
      ).all<{ threat_type: string; count: number }>(),
      // Marketing homepage shape (formatted strings, KV-cached). Powers
      // averrow-marketing's build-time fetch (scripts/fetch-stats.mjs).
      getPublicStats(env),
    ]);

    return json({
      success: true,
      data: {
        total_threats: totalThreats?.n ?? 0,
        active_threats: activeThreats?.n ?? 0,
        brands_monitored: brandsMonitored?.n ?? 0,
        active_feeds: activeFeeds?.n ?? 0,
        threat_campaigns: campaigns?.n ?? 0,
        countries: countries?.n ?? 0,
        certificates_today: threatsToday?.n ?? 0,
        threats_classified_today: threatsToday?.n ?? 0,
        providers_mapped: providers?.n ?? 0,
        latest_insight_summary: latestInsight?.summary?.slice(0, 80) ?? "",
        threat_types: typeCounts?.results ?? [],
        // Legacy aliases
        brands_tracked: brandsMonitored?.n ?? 0,
        // ── Marketing homepage shape (formatted strings) ──
        // Added ADDITIVELY for averrow-marketing/scripts/fetch-stats.mjs.
        // agents_deployed is the registered-agent-registry count (stable 42),
        // NOT the 7d-active count, so the homepage matches the "42 in the
        // mesh" claim on /platform + /why-averrow. brands_monitored is a
        // NUMBER above (the legacy SPA public/app.js count-up animation does
        // arithmetic on it), so the marketing string form is exposed under
        // the distinct key brands_monitored_label — do not merge the two.
        agents_deployed: marketing.agents_deployed,
        feeds_protecting: marketing.feeds_protecting,
        threats_detected: marketing.threats_detected,
        brands_monitored_label: marketing.brands_monitored,
        uptime_label: marketing.uptime_label,
        detection_time_label: marketing.detection_time_label,
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

export async function handlePublicFeeds(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT fc.feed_name, fc.display_name, fc.description, fs.health_status,
              fs.records_ingested_today
       FROM feed_configs fc
       JOIN feed_status fs ON fc.feed_name = fs.feed_name
       WHERE fc.enabled = 1
       ORDER BY fs.records_ingested_today DESC`
    ).all<{
      feed_name: string; display_name: string; description: string;
      health_status: string; records_ingested_today: number;
    }>();

    return json({ success: true, data: rows.results }, 200, origin);
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

interface StoredAssessmentIntel {
  threat_count?: number;
  provider_count?: number;
  campaign_count?: number;
  threat_types?: { threat_type: string; count: number }[];
  is_monitored?: boolean;
  brand_name?: string;
}

/** H4(a): fetch the most recent completed assessment for a domain.
 *  `maxAgeModifier` is a SQLite datetime modifier (e.g. '-24 hours');
 *  pass null for "most recent, any age" (global-cap fallback). */
async function getRecentAssessment(
  env: Env,
  domain: string,
  maxAgeModifier: string | null,
): Promise<Record<string, unknown> | null> {
  const stmt = maxAgeModifier
    ? env.DB.prepare(
        `SELECT id, domain, trust_score, grade, summary_text, threat_intel_results, completed_at
         FROM assessments
         WHERE domain = ? AND completed_at IS NOT NULL AND completed_at >= datetime('now', ?)
         ORDER BY completed_at DESC LIMIT 1`,
      ).bind(domain, maxAgeModifier)
    : env.DB.prepare(
        `SELECT id, domain, trust_score, grade, summary_text, threat_intel_results, completed_at
         FROM assessments
         WHERE domain = ? AND completed_at IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      ).bind(domain);

  const row = await stmt.first<{
    id: string; domain: string; trust_score: number; grade: string;
    summary_text: string | null; threat_intel_results: string | null;
    completed_at: string;
  }>();
  if (!row) return null;

  let intel: StoredAssessmentIntel = {};
  try {
    intel = JSON.parse(row.threat_intel_results ?? "{}") as StoredAssessmentIntel;
  } catch { /* legacy rows may hold malformed JSON — fall back to defaults */ }

  const keyword = row.domain.split(".")[0] ?? row.domain;
  const fallbackBrand = keyword.charAt(0).toUpperCase() + keyword.slice(1);

  return {
    assessment_id: row.id,
    domain: row.domain,
    brand_name: intel.brand_name ?? fallbackBrand,
    trust_score: row.trust_score,
    grade: row.grade,
    threat_count: intel.threat_count ?? 0,
    provider_count: intel.provider_count ?? 0,
    campaign_count: intel.campaign_count ?? 0,
    threat_types: intel.threat_types ?? [],
    is_monitored: intel.is_monitored ?? false,
    assessment_text: row.summary_text ?? "",
    spam_trap: null,
    assessed_at: row.completed_at,
    cached: true,
  };
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

    // Validate domain format
    const domain = body.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
    if (!domain || !domain.includes(".") || domain.includes("@")) {
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

    // Store assessment
    const assessmentId = `assess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare(
      `INSERT INTO assessments (id, domain, trust_score, grade, summary_text, threat_intel_results, ip_address, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(
      assessmentId, domain, trustScore, grade, assessmentText,
      // is_monitored + brand_name ride along so the H4 cached-replay
      // path can reconstruct the full response shape from this row.
      JSON.stringify({ threat_count: threatCount, provider_count: providerCount, campaign_count: campaignCount, threat_types: threatTypes, is_monitored: isMonitored, brand_name: monitoredBrand?.name ?? brandName }),
      ip,
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
      data: {
        assessment_id: assessmentId,
        domain,
        brand_name: monitoredBrand?.name ?? brandName,
        trust_score: trustScore,
        grade,
        threat_count: threatCount,
        provider_count: providerCount,
        campaign_count: campaignCount,
        threat_types: threatTypes,
        is_monitored: isMonitored,
        assessment_text: assessmentText,
        spam_trap: spamTrapCount > 0 ? { emails_caught: spamTrapCount, unique_ips: spamTrapIps } : null,
        assessed_at: new Date().toISOString(),
      },
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
      domain?: string; trust_score?: number; grade?: string; assessment_id?: string;
    } | null;

    if (!body?.email || !body?.name || !body?.company) {
      return json({ success: false, error: "Email, name, and company are required" }, 400, origin);
    }

    // Validate business email
    const emailDomain = body.email.split("@")[1]?.toLowerCase();
    if (!emailDomain || FREEMAIL_DOMAINS.has(emailDomain)) {
      return json({ success: false, error: "Please use your business email address" }, 400, origin);
    }

    const assessmentId = body.assessment_id || `assess_placeholder_${Date.now()}`;
    const leadId = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // If no real assessment, create a placeholder
    if (!body.assessment_id) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO assessments (id, domain, trust_score, grade, ip_address) VALUES (?, ?, ?, ?, ?)`
      ).bind(assessmentId, body.domain || "", body.trust_score ?? 0, body.grade || "?", ip).run();
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

    const domain = body.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
    if (!domain || !domain.includes(".") || domain.includes("@")) {
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
        `INSERT OR IGNORE INTO assessments (id, domain, trust_score, grade, ip_address) VALUES (?, ?, 0, '?', ?)`
      ).bind(assessmentId, domain, ip).run();
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
