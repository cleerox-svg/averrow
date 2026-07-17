// Averrow — Geopolitical Campaign API Endpoints

import { json } from "../lib/cors";
import { checkCostGuard } from "../lib/haiku";
import { runSyncAgent } from "../lib/agentRunner";
import {
  geoCampaignAssessmentAgent,
  type GeoCampaignAssessmentInput,
  type GeoCampaignAssessmentOutput,
} from "../agents/geo-campaign-assessment";
import type { Env } from "../types";

// ─── Types ──────────────────────────────────────────────────────

interface GeopoliticalCampaign {
  id: string;
  name: string;
  conflict: string;
  status: string;
  threat_actors: string;
  adversary_countries: string;
  adversary_asns: string;
  target_countries: string;
  target_sectors: string;
  target_brands: string;
  ttps: string;
  escalation_rules: string;
  ioc_sources: string;
  known_iocs: string;
  start_date: string;
  end_date: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val) as T; }
  catch { return fallback; }
}

// GET /api/campaigns/geo — List all geopolitical campaigns
export async function handleListGeopoliticalCampaigns(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = "SELECT * FROM geopolitical_campaigns";
    const params: unknown[] = [];
    if (status) {
      query += " WHERE status = ?";
      params.push(status);
    }
    query += " ORDER BY start_date DESC";

    const rows = await env.DB.prepare(query).bind(...params).all<GeopoliticalCampaign>();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/geo/:slug — Full geopolitical campaign detail
export async function handleGetGeopoliticalCampaign(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT * FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<GeopoliticalCampaign>();

    if (!campaign) {
      return json({ success: false, error: "Geopolitical campaign not found" }, 404, origin);
    }

    return json({ success: true, data: campaign }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/geo/:slug/threats — Live threat count from adversary countries
export async function handleGeoCampaignThreats(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT adversary_countries, adversary_asns, start_date FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<Pick<GeopoliticalCampaign, "adversary_countries" | "adversary_asns" | "start_date">>();

    if (!campaign) {
      return json({ success: false, error: "Campaign not found" }, 404, origin);
    }

    const countries = parseJson<string[]>(campaign.adversary_countries, []);
    const asns = parseJson<string[]>(campaign.adversary_asns, []);

    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Build dynamic WHERE conditions for adversary countries and ASNs
    const conditions: string[] = [`t.created_at >= ?`];
    const params: unknown[] = [campaign.start_date];

    if (countries.length > 0) {
      const placeholders = countries.map(() => "?").join(",");
      conditions.push(`(t.country_code IN (${placeholders}))`);
      params.push(...countries);
    }
    if (asns.length > 0) {
      const asnPlaceholders = asns.map(() => "?").join(",");
      if (countries.length > 0) {
        // Amend last condition to be OR with ASN
        const lastCondition = conditions.pop();
        conditions.push(`(${lastCondition?.replace(/^\(/, "").replace(/\)$/, "")} OR t.asn IN (${asnPlaceholders}))`);
      } else {
        conditions.push(`t.asn IN (${asnPlaceholders})`);
      }
      params.push(...asns);
    }

    // If neither countries nor ASNs, return empty
    if (countries.length === 0 && asns.length === 0) {
      return json({ success: true, data: { threats: [], total: 0 } }, 200, origin);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const [threats, total] = await Promise.all([
      env.DB.prepare(`
        SELECT t.id, t.threat_type, t.severity, t.status, t.malicious_domain, t.malicious_url,
               t.ip_address, t.asn, t.country_code, t.hosting_provider_id,
               t.target_brand_id, b.name AS brand_name,
               t.first_seen, t.last_seen, t.created_at
        FROM threats t LEFT JOIN brands b ON b.id = t.target_brand_id
        ${where}
        ORDER BY t.created_at DESC LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM threats t ${where}`).bind(...params).first<{ n: number }>(),
    ]);

    return json({ success: true, data: { threats: threats.results, total: total?.n ?? 0 } }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/geo/:slug/timeline — Attack timeline (first seen → now)
export async function handleGeoCampaignTimeline(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT adversary_countries, adversary_asns, start_date FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<Pick<GeopoliticalCampaign, "adversary_countries" | "adversary_asns" | "start_date">>();

    if (!campaign) {
      return json({ success: false, error: "Campaign not found" }, 404, origin);
    }

    const countries = parseJson<string[]>(campaign.adversary_countries, []);
    const asns = parseJson<string[]>(campaign.adversary_asns, []);

    if (countries.length === 0 && asns.length === 0) {
      return json({ success: true, data: { labels: [], values: [], by_type: {} } }, 200, origin);
    }

    // Build adversary filter
    const filters: string[] = [];
    const params: unknown[] = [campaign.start_date];
    if (countries.length > 0) {
      filters.push(`t.country_code IN (${countries.map(() => "?").join(",")})`);
      params.push(...countries);
    }
    if (asns.length > 0) {
      filters.push(`t.asn IN (${asns.map(() => "?").join(",")})`);
      params.push(...asns);
    }
    const adversaryFilter = filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0];

    const rows = await env.DB.prepare(`
      SELECT date(t.created_at) AS period,
             COUNT(*) AS count,
             SUM(CASE WHEN t.threat_type = 'phishing' THEN 1 ELSE 0 END) AS phishing,
             SUM(CASE WHEN t.threat_type = 'credential_harvesting' THEN 1 ELSE 0 END) AS credential_harvesting,
             SUM(CASE WHEN t.threat_type = 'malware_distribution' THEN 1 ELSE 0 END) AS malware,
             SUM(CASE WHEN t.threat_type = 'typosquatting' THEN 1 ELSE 0 END) AS typosquatting,
             SUM(CASE WHEN t.threat_type = 'impersonation' THEN 1 ELSE 0 END) AS impersonation
      FROM threats t
      WHERE t.created_at >= ? AND ${adversaryFilter}
      GROUP BY date(t.created_at)
      ORDER BY period ASC
    `).bind(...params).all();

    const results = rows.results as Array<{
      period: string; count: number;
      phishing: number; credential_harvesting: number; malware: number;
      typosquatting: number; impersonation: number;
    }>;

    return json({
      success: true,
      data: {
        labels: results.map(r => r.period),
        values: results.map(r => r.count),
        by_type: {
          phishing: results.map(r => r.phishing),
          credential_harvesting: results.map(r => r.credential_harvesting),
          malware: results.map(r => r.malware),
          typosquatting: results.map(r => r.typosquatting),
          impersonation: results.map(r => r.impersonation),
        },
      },
    }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/geo/:slug/brands — Targeted brands heat map data
export async function handleGeoCampaignBrands(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT adversary_countries, adversary_asns, start_date FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<Pick<GeopoliticalCampaign, "adversary_countries" | "adversary_asns" | "start_date">>();

    if (!campaign) {
      return json({ success: false, error: "Campaign not found" }, 404, origin);
    }

    const countries = parseJson<string[]>(campaign.adversary_countries, []);
    const asns = parseJson<string[]>(campaign.adversary_asns, []);

    if (countries.length === 0 && asns.length === 0) {
      return json({ success: true, data: [] }, 200, origin);
    }

    const filters: string[] = [];
    const params: unknown[] = [campaign.start_date];
    if (countries.length > 0) {
      filters.push(`t.country_code IN (${countries.map(() => "?").join(",")})`);
      params.push(...countries);
    }
    if (asns.length > 0) {
      filters.push(`t.asn IN (${asns.map(() => "?").join(",")})`);
      params.push(...asns);
    }
    const adversaryFilter = filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0];

    const rows = await env.DB.prepare(`
      SELECT b.id, b.name, b.sector, b.canonical_domain,
             COUNT(t.id) AS threat_count,
             SUM(CASE WHEN t.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
             SUM(CASE WHEN t.severity = 'high' THEN 1 ELSE 0 END) AS high_count,
             MIN(t.first_seen) AS first_targeted,
             MAX(t.last_seen) AS last_targeted
      FROM threats t
      JOIN brands b ON b.id = t.target_brand_id
      WHERE t.created_at >= ? AND ${adversaryFilter}
        AND t.target_brand_id IS NOT NULL
      GROUP BY b.id
      ORDER BY threat_count DESC
      LIMIT 50
    `).bind(...params).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/geo/:slug/asns — ASN cluster analysis
export async function handleGeoCampaignAsns(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT adversary_countries, adversary_asns, start_date FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<Pick<GeopoliticalCampaign, "adversary_countries" | "adversary_asns" | "start_date">>();

    if (!campaign) {
      return json({ success: false, error: "Campaign not found" }, 404, origin);
    }

    const countries = parseJson<string[]>(campaign.adversary_countries, []);
    const asns = parseJson<string[]>(campaign.adversary_asns, []);

    if (countries.length === 0 && asns.length === 0) {
      return json({ success: true, data: [] }, 200, origin);
    }

    const filters: string[] = [];
    const params: unknown[] = [campaign.start_date];
    if (countries.length > 0) {
      filters.push(`t.country_code IN (${countries.map(() => "?").join(",")})`);
      params.push(...countries);
    }
    if (asns.length > 0) {
      filters.push(`t.asn IN (${asns.map(() => "?").join(",")})`);
      params.push(...asns);
    }
    const adversaryFilter = filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0];

    const rows = await env.DB.prepare(`
      SELECT t.asn,
             COALESCE(hp.name, t.hosting_provider_id, 'Unknown') AS provider_name,
             t.country_code,
             COUNT(*) AS threat_count,
             COUNT(DISTINCT t.ip_address) AS unique_ips,
             COUNT(DISTINCT t.malicious_domain) AS unique_domains,
             MIN(t.first_seen) AS first_seen,
             MAX(t.last_seen) AS last_seen
      FROM threats t
      LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE t.created_at >= ? AND ${adversaryFilter}
        AND t.asn IS NOT NULL
      GROUP BY t.asn
      ORDER BY threat_count DESC
      LIMIT 30
    `).bind(...params).all();

    // Mark known adversary ASNs
    const knownAdversaryAsns = new Set(asns);
    const enriched = (rows.results as Array<Record<string, unknown>>).map(row => ({
      ...row,
      is_known_adversary: knownAdversaryAsns.has(row.asn as string),
    }));

    return json({ success: true, data: enriched }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/geo/:slug/attack-types — Attack type breakdown
export async function handleGeoCampaignAttackTypes(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT adversary_countries, adversary_asns, start_date FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<Pick<GeopoliticalCampaign, "adversary_countries" | "adversary_asns" | "start_date">>();

    if (!campaign) {
      return json({ success: false, error: "Campaign not found" }, 404, origin);
    }

    const countries = parseJson<string[]>(campaign.adversary_countries, []);
    const asns = parseJson<string[]>(campaign.adversary_asns, []);

    if (countries.length === 0 && asns.length === 0) {
      return json({ success: true, data: [] }, 200, origin);
    }

    const filters: string[] = [];
    const params: unknown[] = [campaign.start_date];
    if (countries.length > 0) {
      filters.push(`t.country_code IN (${countries.map(() => "?").join(",")})`);
      params.push(...countries);
    }
    if (asns.length > 0) {
      filters.push(`t.asn IN (${asns.map(() => "?").join(",")})`);
      params.push(...asns);
    }
    const adversaryFilter = filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0];

    const rows = await env.DB.prepare(`
      SELECT t.threat_type,
             COUNT(*) AS count,
             SUM(CASE WHEN t.severity = 'critical' THEN 1 ELSE 0 END) AS critical,
             SUM(CASE WHEN t.severity = 'high' THEN 1 ELSE 0 END) AS high,
             SUM(CASE WHEN t.severity = 'medium' THEN 1 ELSE 0 END) AS medium,
             SUM(CASE WHEN t.severity = 'low' THEN 1 ELSE 0 END) AS low
      FROM threats t
      WHERE t.created_at >= ? AND ${adversaryFilter}
      GROUP BY t.threat_type
      ORDER BY count DESC
    `).bind(...params).all();

    return json({ success: true, data: rows.results }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/campaigns/geo/:slug/stats — Aggregate stats for the campaign
export async function handleGeoCampaignStats(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT adversary_countries, adversary_asns, start_date FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<Pick<GeopoliticalCampaign, "adversary_countries" | "adversary_asns" | "start_date">>();

    if (!campaign) {
      return json({ success: false, error: "Campaign not found" }, 404, origin);
    }

    const countries = parseJson<string[]>(campaign.adversary_countries, []);
    const asns = parseJson<string[]>(campaign.adversary_asns, []);

    if (countries.length === 0 && asns.length === 0) {
      return json({
        success: true,
        data: {
          total_threats: 0, threats_24h: 0, threats_7d: 0,
          brands_targeted: 0, unique_ips: 0, unique_domains: 0,
          critical_count: 0, high_count: 0,
        },
      }, 200, origin);
    }

    const filters: string[] = [];
    const params: unknown[] = [campaign.start_date];
    if (countries.length > 0) {
      filters.push(`t.country_code IN (${countries.map(() => "?").join(",")})`);
      params.push(...countries);
    }
    if (asns.length > 0) {
      filters.push(`t.asn IN (${asns.map(() => "?").join(",")})`);
      params.push(...asns);
    }
    const adversaryFilter = filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0];
    const baseWhere = `t.created_at >= ? AND ${adversaryFilter}`;

    const stats = await env.DB.prepare(`
      SELECT COUNT(*) AS total_threats,
             SUM(CASE WHEN t.created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS threats_24h,
             SUM(CASE WHEN t.created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS threats_7d,
             COUNT(DISTINCT t.target_brand_id) AS brands_targeted,
             COUNT(DISTINCT t.ip_address) AS unique_ips,
             COUNT(DISTINCT t.malicious_domain) AS unique_domains,
             SUM(CASE WHEN t.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
             SUM(CASE WHEN t.severity = 'high' THEN 1 ELSE 0 END) AS high_count
      FROM threats t
      WHERE ${baseWhere}
    `).bind(...params).first();

    return json({ success: true, data: stats }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/campaigns/geo/:slug/assessment — AI intelligence assessment
export async function handleGeoCampaignAssessment(request: Request, env: Env, slug: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const campaign = await env.DB.prepare(
      "SELECT * FROM geopolitical_campaigns WHERE id = ? OR conflict = ?"
    ).bind(slug, slug).first<GeopoliticalCampaign & { notes?: string }>();

    if (!campaign) {
      return json({ success: false, error: "Campaign not found" }, 404, origin);
    }

    // User-initiated assessment — bypass daily cost guard (critical=true)
    const guardMsg = await checkCostGuard(env, true);
    if (guardMsg) {
      return json({ success: false, error: guardMsg }, 429, origin);
    }

    const countries = parseJson<string[]>(campaign.adversary_countries, []);
    const asns = parseJson<string[]>(campaign.adversary_asns, []);
    const threatActors = parseJson<string[]>(campaign.threat_actors, []);
    const ttps = parseJson<string[]>(campaign.ttps, []);
    const targetBrands = parseJson<string[]>(campaign.target_brands, []);

    // Fetch threat stats from adversary infrastructure
    let threatStats = { total: 0, week: 0, critical: 0 };
    if (countries.length > 0 || asns.length > 0) {
      const filters: string[] = [];
      const params: unknown[] = [campaign.start_date];
      if (countries.length > 0) {
        filters.push(`t.country_code IN (${countries.map(() => "?").join(",")})`);
        params.push(...countries);
      }
      if (asns.length > 0) {
        filters.push(`t.asn IN (${asns.map(() => "?").join(",")})`);
        params.push(...asns);
      }
      const adversaryFilter = filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0];

      const stats = await env.DB.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN t.created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS week,
               SUM(CASE WHEN t.severity = 'critical' THEN 1 ELSE 0 END) AS critical
        FROM threats t
        WHERE t.created_at >= ? AND ${adversaryFilter}
      `).bind(...params).first<{ total: number; week: number; critical: number }>();

      if (stats) {
        threatStats = { total: stats.total ?? 0, week: stats.week ?? 0, critical: stats.critical ?? 0 };
      }
    }

    // Fetch attack type breakdown
    let attackTypes: string[] = [];
    if (countries.length > 0 || asns.length > 0) {
      const filters: string[] = [];
      const params: unknown[] = [campaign.start_date];
      if (countries.length > 0) {
        filters.push(`t.country_code IN (${countries.map(() => "?").join(",")})`);
        params.push(...countries);
      }
      if (asns.length > 0) {
        filters.push(`t.asn IN (${asns.map(() => "?").join(",")})`);
        params.push(...asns);
      }
      const adversaryFilter = filters.length > 1 ? `(${filters.join(" OR ")})` : filters[0];

      const rows = await env.DB.prepare(`
        SELECT t.threat_type, COUNT(*) AS count
        FROM threats t
        WHERE t.created_at >= ? AND ${adversaryFilter}
        GROUP BY t.threat_type ORDER BY count DESC LIMIT 5
      `).bind(...params).all();

      attackTypes = (rows.results as Array<{ threat_type: string; count: number }>)
        .map(r => `${r.threat_type.replace(/_/g, " ")} (${r.count})`);
    }

    const daysActive = Math.floor((Date.now() - new Date(campaign.start_date).getTime()) / (1000 * 60 * 60 * 24));

    const agentInput: GeoCampaignAssessmentInput = {
      campaignName: campaign.name,
      status: campaign.status,
      startDate: campaign.start_date,
      daysActive,
      countries,
      asns,
      threatActors,
      ttps,
      targetBrands,
      attackTypes,
      threatStats,
      notes:
        typeof (campaign as unknown as Record<string, unknown>).notes === "string"
          ? ((campaign as unknown as Record<string, unknown>).notes as string)
          : "",
    };

    const { data, error } = await runSyncAgent<GeoCampaignAssessmentOutput>(env, geoCampaignAssessmentAgent, agentInput);
    if (!data?.assessment) {
      return json({ success: false, error: error || "Assessment generation failed" }, 502, origin);
    }

    return json({
      success: true,
      data: {
        assessment: data.assessment,
        tokens_used: data.tokensUsed,
        generated_at: new Date().toISOString(),
      },
    }, 200, origin);
  } catch {
    return json({ success: false, error: "Assessment generation failed" }, 500, origin);
  }
}
