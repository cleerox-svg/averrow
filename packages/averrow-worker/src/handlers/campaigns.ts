// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Campaign API Endpoints

import { json } from "../lib/cors";
import { clampQuery, buildPrefix } from "../lib/search-prefix";
import type { Campaign, Env } from "../types";

// GET /api/campaigns (with status filter)
export async function handleListCampaignsV2(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    // Optional prefix search over campaign name — powers the unified-search
    // palette's "view all" for a campaign term. Same prefix-anchored,
    // NOCASE-index-backed discipline as GET /api/search (idx_campaigns_name,
    // migration 0236); never a leading wildcard.
    const q = clampQuery(url.searchParams.get("q") ?? "");

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) { conditions.push("c.status = ?"); params.push(status); }
    if (q.length >= 2) { conditions.push("c.name LIKE ? ESCAPE '\\'"); params.push(buildPrefix(q)); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    const rows = await env.DB.prepare(`
      SELECT c.id, c.name, c.status, c.threat_count, c.brand_count, c.provider_count,
             c.attack_pattern, c.first_seen, c.last_seen
      FROM campaigns c ${where}
      ORDER BY c.last_seen DESC LIMIT ? OFFSET ?
    `).bind(...params).all();

    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM campaigns c ${where}`)
      .bind(...params.slice(0, -2)).first<{ n: number }>();

    return json({ success: true, data: rows.results, total: total?.n ?? 0 }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/stats
export async function handleCampaignStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const stats = await env.DB.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS active_count,
             SUM(CASE WHEN c.status = 'dormant' THEN 1 ELSE 0 END) AS dormant_count,
             SUM(CASE WHEN c.status = 'disrupted' THEN 1 ELSE 0 END) AS disrupted_count,
             SUM(c.threat_count) AS active_threats,
             (SELECT COUNT(DISTINCT t.target_brand_id) FROM threats t WHERE t.campaign_id IS NOT NULL AND t.target_brand_id IS NOT NULL) AS brands_affected
      FROM campaigns c
    `).first();

    return json({ success: true, data: stats }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/:id
export async function handleGetCampaign(request: Request, env: Env, campaignId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT * FROM campaigns WHERE id = ?",
    ).bind(campaignId).first<Campaign>();

    if (!campaign) return json({ success: false, error: "Campaign not found" }, 404, origin);

    const [brandBreakdown, providerBreakdown, liveStats] = await Promise.all([
      env.DB.prepare(`
        SELECT target_brand_id AS brand_id, b.name AS brand_name, COUNT(*) AS count
        FROM threats t LEFT JOIN brands b ON b.id = t.target_brand_id
        WHERE t.campaign_id = ? AND t.target_brand_id IS NOT NULL
        GROUP BY target_brand_id ORDER BY count DESC
        LIMIT 100
      `).bind(campaignId).all(),
      env.DB.prepare(`
        SELECT t.hosting_provider_id AS provider_id,
               COALESCE(hp.name, t.hosting_provider_id) AS provider_name,
               COUNT(*) AS count
        FROM threats t
        LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
        WHERE t.campaign_id = ? AND t.hosting_provider_id IS NOT NULL
        GROUP BY t.hosting_provider_id ORDER BY count DESC
        LIMIT 100
      `).bind(campaignId).all(),
      env.DB.prepare(`
        SELECT COUNT(*) AS threat_count,
               COUNT(DISTINCT target_brand_id) AS brand_count,
               COUNT(DISTINCT hosting_provider_id) AS provider_count,
               COUNT(DISTINCT malicious_domain) AS domain_count,
               COUNT(DISTINCT ip_address) AS ip_count
        FROM threats WHERE campaign_id = ?
      `).bind(campaignId).first(),
    ]);

    return json({
      success: true,
      data: {
        ...campaign,
        threat_count: liveStats?.threat_count ?? campaign.threat_count ?? 0,
        brand_count: liveStats?.brand_count ?? campaign.brand_count ?? 0,
        provider_count: liveStats?.provider_count ?? campaign.provider_count ?? 0,
        domain_count: liveStats?.domain_count ?? 0,
        ip_count: liveStats?.ip_count ?? 0,
        brand_breakdown: brandBreakdown.results,
        provider_breakdown: providerBreakdown.results,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/:id/threats
export async function handleCampaignThreats(request: Request, env: Env, campaignId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const rows = await env.DB.prepare(`
      SELECT t.id, t.threat_type, t.severity, t.status, t.malicious_domain, t.malicious_url,
             t.ip_address, t.country_code, t.hosting_provider_id,
             t.target_brand_id, b.name AS brand_name,
             t.first_seen, t.last_seen, t.created_at
      FROM threats t LEFT JOIN brands b ON b.id = t.target_brand_id
      WHERE t.campaign_id = ?
      ORDER BY t.created_at DESC LIMIT ? OFFSET ?
    `).bind(campaignId, limit, offset).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/:id/infrastructure
export async function handleCampaignInfrastructure(request: Request, env: Env, campaignId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const [domains, ips, providers] = await Promise.all([
      env.DB.prepare(`
        SELECT DISTINCT malicious_domain AS domain, ip_address, hosting_provider_id
        FROM threats WHERE campaign_id = ? AND malicious_domain IS NOT NULL
        LIMIT 100
      `).bind(campaignId).all(),
      env.DB.prepare(`
        SELECT DISTINCT ip_address, COUNT(*) AS domain_count, hosting_provider_id, country_code
        FROM threats WHERE campaign_id = ? AND ip_address IS NOT NULL
        GROUP BY ip_address ORDER BY domain_count DESC LIMIT 50
      `).bind(campaignId).all(),
      env.DB.prepare(`
        SELECT DISTINCT t.hosting_provider_id AS provider_id,
               COALESCE(hp.name, t.hosting_provider_id) AS provider_name,
               COUNT(*) AS threat_count
        FROM threats t
        LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
        WHERE t.campaign_id = ? AND t.hosting_provider_id IS NOT NULL
        GROUP BY t.hosting_provider_id ORDER BY threat_count DESC
      `).bind(campaignId).all(),
    ]);

    return json({
      success: true,
      data: { domains: domains.results, ips: ips.results, providers: providers.results },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/:id/brands
export async function handleCampaignBrands(request: Request, env: Env, campaignId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(`
      SELECT b.id, b.name, b.sector, COUNT(t.id) AS threat_count
      FROM threats t JOIN brands b ON b.id = t.target_brand_id
      WHERE t.campaign_id = ?
      GROUP BY b.id ORDER BY threat_count DESC
      LIMIT 100
    `).bind(campaignId).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/:id/timeline
export async function handleCampaignTimeline(request: Request, env: Env, campaignId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? "7d";
    let bucket = "strftime('%Y-%m-%dT%H:00', created_at)";
    let since = "datetime('now', '-7 days')";
    if (period === "24h") { since = "datetime('now', '-1 day')"; }
    else if (period === "30d") { since = "datetime('now', '-30 days')"; bucket = "date(created_at)"; }
    else if (period === "90d") { since = "datetime('now', '-90 days')"; bucket = "date(created_at)"; }

    const rows = await env.DB.prepare(`
      SELECT ${bucket} AS period, COUNT(*) AS count,
             SUM(CASE WHEN threat_type = 'phishing' THEN 1 ELSE 0 END) AS phishing,
             SUM(CASE WHEN threat_type = 'typosquatting' THEN 1 ELSE 0 END) AS typosquatting
      FROM threats WHERE campaign_id = ? AND created_at >= ${since}
      GROUP BY ${bucket} ORDER BY period ASC
    `).bind(campaignId).all();

    const results = rows.results as Array<{ period: string; count: number }>;
    const labels = results.map(r => r.period);
    const values = results.map(r => r.count);

    return json({ success: true, data: { labels, values } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
