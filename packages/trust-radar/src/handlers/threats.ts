// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Wave 2A: migrated read handlers to D1 Sessions API (read replicas)
import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from '../lib/db';
import { enrichThreatsGeo } from "../lib/geoip";
import type { Env, UpdateThreatBody } from "../types";
import type { OrgScope } from "../middleware/auth";

// ─── List threats with filtering ────────────────────────────────
export async function handleListThreats(request: Request, env: Env, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const severity = url.searchParams.get("severity");
    const type = url.searchParams.get("type");
    const status = url.searchParams.get("status");
    const source = url.searchParams.get("source");
    const search = url.searchParams.get("q");
    const country = url.searchParams.get("country");
    const brandId = url.searchParams.get("brand_id");

    // Whitelisted server-side sort (shared with the tenant endpoint so the
    // shared <ThreatsTable> behaves identically). Severity ranks critical
    // highest so dir=desc puts critical first.
    const SORT_COLUMNS: Record<string, string> = {
      severity:   "CASE t.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END",
      last_seen:  "t.last_seen", first_seen: "t.first_seen", brand: "b.name",
      type: "t.threat_type", status: "t.status", confidence: "t.confidence_score",
      target: "t.malicious_domain", source: "t.source_feed", country: "t.country_code",
    };
    const sortParam = url.searchParams.get("sort") ?? "severity";
    const dir = (url.searchParams.get("dir") ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const sortCol = SORT_COLUMNS[sortParam] ?? SORT_COLUMNS.severity;

    // KV cache: threats list with complex JOINs — cache for 5 minutes.
    const scopeHash = scope ? scope.brand_ids.slice(0, 3).join(",") : "global";
    const cacheKey = `threats_list:${severity ?? ""}:${type ?? ""}:${status ?? ""}:${source ?? ""}:${country ?? ""}:${brandId ?? ""}:${search ?? ""}:${sortParam}:${dir}:${limit}:${offset}:${scopeHash}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return attachBookmark(json(JSON.parse(cached), 200, origin), session);

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Org scope filtering — use t. prefix for aliased query
    if (scope) {
      if (scope.brand_ids.length === 0) {
        return attachBookmark(json({ success: true, data: { threats: [], total: 0 } }, 200, origin), session);
      }
      const placeholders = scope.brand_ids.map(() => "?").join(", ");
      conditions.push(`t.target_brand_id IN (${placeholders})`);
      params.push(...scope.brand_ids);
    }

    if (severity) { conditions.push("t.severity = ?"); params.push(severity); }
    if (type) { conditions.push("t.threat_type = ?"); params.push(type); }
    if (status) { conditions.push("t.status = ?"); params.push(status); }
    if (source) { conditions.push("t.source_feed = ?"); params.push(source); }
    if (country) { conditions.push("t.country_code = ?"); params.push(country); }
    if (brandId) {
      conditions.push("t.target_brand_id = ?");
      params.push(brandId);
      // Exclude domains the brand explicitly owns so we don't surface
      // their own infrastructure as threats targeting them.
      conditions.push("t.malicious_domain NOT IN (SELECT domain FROM brand_safe_domains WHERE brand_id = ?)");
      params.push(brandId);
    }
    if (search) {
      // Exact id match in the OR so a pivot can deep-link a specific threat
      // (e.g. Alert→source threat) via ?q=<threat_id>; the LIKEs keep the
      // indicator search (domain/url/ip/ioc) intact.
      conditions.push("(t.malicious_domain LIKE ? OR t.malicious_url LIKE ? OR t.ip_address LIKE ? OR t.ioc_value LIKE ? OR t.id = ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, search);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit, offset);

    let rows: D1Result;
    try {
      rows = await session.prepare(
        `SELECT t.id, t.threat_type, t.severity, t.confidence_score, t.status, t.source_feed,
                t.ioc_value, t.malicious_domain, t.malicious_url, t.ip_address, t.asn,
                t.country_code, t.target_brand_id, t.hosting_provider_id, t.campaign_id,
                t.cluster_id, t.registrar, t.registration_date,
                t.vt_checked, t.vt_malicious, t.vt_reputation,
                t.gsb_checked, t.gsb_flagged, t.gsb_threat_type,
                t.surbl_checked, t.surbl_listed,
                t.greynoise_checked, t.greynoise_classification,
                t.seclookup_checked, t.seclookup_risk_score,
                t.abuseipdb_checked, t.abuseipdb_score, t.abuseipdb_reports,
                t.first_seen, t.last_seen, t.created_at, t.lat, t.lng,
                t.saas_technique_id,
                st.name        AS saas_technique_name,
                st.phase       AS saas_technique_phase,
                st.phase_label AS saas_technique_phase_label,
                st.severity    AS saas_technique_severity,
                hp.name AS hosting_provider,
                b.name AS brand_name,
                tai.threat_actor_id AS actor_id,
                ta.name AS actor_name
         FROM threats t
         LEFT JOIN brands b ON b.id = t.target_brand_id
         LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
         LEFT JOIN saas_techniques st ON st.id = t.saas_technique_id
         LEFT JOIN (SELECT asn, threat_actor_id FROM threat_actor_infrastructure GROUP BY asn) tai ON tai.asn = t.asn
         LEFT JOIN threat_actors ta ON ta.id = tai.threat_actor_id
         ${where}
         ORDER BY ${sortCol} ${dir}, t.created_at DESC LIMIT ? OFFSET ?`
      ).bind(...params).all();
    } catch {
      // Fallback if threat_actor_infrastructure or saas_techniques tables don't exist
      rows = await session.prepare(
        `SELECT t.id, t.threat_type, t.severity, t.confidence_score, t.status, t.source_feed,
                t.ioc_value, t.malicious_domain, t.malicious_url, t.ip_address, t.asn,
                t.country_code, t.target_brand_id, t.hosting_provider_id, t.campaign_id,
                t.cluster_id, t.registrar, t.registration_date,
                t.vt_checked, t.vt_malicious, t.vt_reputation,
                t.gsb_checked, t.gsb_flagged, t.gsb_threat_type,
                t.surbl_checked, t.surbl_listed,
                t.greynoise_checked, t.greynoise_classification,
                t.seclookup_checked, t.seclookup_risk_score,
                t.abuseipdb_checked, t.abuseipdb_score, t.abuseipdb_reports,
                t.first_seen, t.last_seen, t.created_at, t.lat, t.lng,
                NULL AS saas_technique_id,
                NULL AS saas_technique_name,
                NULL AS saas_technique_phase,
                NULL AS saas_technique_phase_label,
                NULL AS saas_technique_severity,
                NULL AS hosting_provider,
                b.name AS brand_name,
                NULL AS actor_id,
                NULL AS actor_name
         FROM threats t
         LEFT JOIN brands b ON b.id = t.target_brand_id
         ${where}
         ORDER BY ${sortCol} ${dir}, t.created_at DESC LIMIT ? OFFSET ?`
      ).bind(...params).all();
    }

    const countParams = params.slice(0, -2);
    const total = await session.prepare(
      `SELECT COUNT(*) as cnt FROM threats t ${where}`
    ).bind(...countParams).first<{ cnt: number }>();

    const data = { success: true, data: { threats: rows.results, total: total?.cnt ?? 0 } };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Threats catalog aggregate ───────────────────────────────────
// Slice-aware narrative numbers powering /threats Intel surface.
// Honors the same filters as handleListThreats so aggregates match
// what the operator sees in the list. Cached 5min via cachedValue.
export async function handleThreatsAggregate(request: Request, env: Env, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const { threatAggregate } = await import('../lib/threat-aggregates');
    const data = await threatAggregate(env, {
      severity: url.searchParams.get("severity") ?? undefined,
      type:     url.searchParams.get("type") ?? undefined,
      status:   url.searchParams.get("status") ?? undefined,
      source:   url.searchParams.get("source") ?? undefined,
      search:   url.searchParams.get("q") ?? undefined,
      brand_id: url.searchParams.get("brand_id") ?? undefined,
      actor_id: url.searchParams.get("actor_id") ?? undefined,
      country:  url.searchParams.get("country") ?? undefined,
      since:    url.searchParams.get("since") ?? undefined,
    }, scope);
    return attachBookmark(json({ success: true, data }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Threat stats for dashboard ─────────────────────────────────
export async function handleThreatStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    // KV cache: threat stats fires 11+ parallel queries — cache for 5 minutes.
    const cacheKey = "threat_stats";
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    const [
      summary, last24h, today, yesterday,
      feedIngestionsToday, byType, bySource, bySeverity,
      byCountry, recentThreats, topOriginsToday,
    ] = await Promise.all([
      session.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
          SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high,
          SUM(CASE WHEN severity = 'medium' THEN 1 ELSE 0 END) as medium,
          SUM(CASE WHEN severity = 'low' THEN 1 ELSE 0 END) as low,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'remediated' THEN 1 ELSE 0 END) as remediated,
          COUNT(DISTINCT source_feed) as sources,
          COUNT(DISTINCT threat_type) as types
        FROM threats
      `).first(),
      session.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
          SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high
        FROM threats WHERE created_at >= datetime('now', '-24 hours')
      `).first(),
      session.prepare(`
        SELECT
          COUNT(*) as threats_flagged,
          COUNT(DISTINCT country_code) as countries_active,
          SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical_today,
          SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high_today
        FROM threats WHERE created_at >= date('now', 'start of day')
      `).first<{ threats_flagged: number; countries_active: number; critical_today: number; high_today: number }>(),
      session.prepare(`
        SELECT
          COUNT(*) as threats_flagged,
          COUNT(DISTINCT country_code) as countries_active
        FROM threats WHERE created_at >= date('now', '-1 day', 'start of day') AND created_at < date('now', 'start of day')
      `).first<{ threats_flagged: number; countries_active: number }>(),
      session.prepare(
        "SELECT COALESCE(SUM(records_ingested), 0) as items_today FROM feed_pull_history WHERE started_at >= date('now', 'start of day') AND status = 'success'"
      ).first<{ items_today: number }>(),
      // Cube swaps (cost-sweep 2026-05-16): each of these used to
      // GROUP BY against the raw threats table (~355K rows scanned
      // per call). Switched to the corresponding cube — pre-aggregated
      // hourly rolling, ~10-100× smaller scan footprint.
      session.prepare(
        `SELECT threat_type, SUM(threat_count) AS count
           FROM threat_cube_status
          GROUP BY threat_type ORDER BY count DESC LIMIT 10`
      ).all(),
      session.prepare(
        `SELECT source_feed, SUM(threat_count) AS count
           FROM threat_cube_status
          GROUP BY source_feed ORDER BY count DESC LIMIT 10`
      ).all(),
      session.prepare(
        `SELECT severity, SUM(threat_count) AS count
           FROM threat_cube_status
          GROUP BY severity`
      ).all(),
      session.prepare(
        `SELECT country_code, SUM(threat_count) AS count
           FROM threat_cube_geo
          WHERE country_code != ''
          GROUP BY country_code ORDER BY count DESC LIMIT 30`
      ).all(),
      session.prepare(`
        SELECT id, threat_type, severity, source_feed, malicious_domain, ioc_value,
               ip_address, country_code, lat, lng, created_at
        FROM threats ORDER BY created_at DESC LIMIT 20
      `).all(),
      session.prepare(`
        SELECT country_code, SUM(threat_count) AS count
          FROM threat_cube_geo
         WHERE country_code != ''
           AND hour_bucket >= strftime('%Y-%m-%d %H:00', 'now', 'start of day')
         GROUP BY country_code ORDER BY count DESC LIMIT 10
      `).all(),
    ]);

    // Hosting provider breakdown — cube-backed (cost-sweep 2026-05-16).
    // The threats-table JOIN was ~250K rows/call; cube_provider scans
    // ~5K rows by hosting_provider_id × hour.
    let byProvider: unknown[] = [];
    try {
      const providerRows = await session.prepare(`
        SELECT hp.name AS hosting_provider,
               SUM(tcp.threat_count) AS count,
               SUM(CASE WHEN tcp.severity = 'critical' THEN tcp.threat_count ELSE 0 END) AS critical,
               SUM(CASE WHEN tcp.severity = 'high'     THEN tcp.threat_count ELSE 0 END) AS high
          FROM threat_cube_provider tcp
          JOIN hosting_providers hp ON hp.id = tcp.hosting_provider_id
         GROUP BY hp.name ORDER BY count DESC LIMIT 20
      `).all();
      byProvider = providerRows.results;
    } catch { /* cube may not be populated yet */ }

    const dailyStats = {
      scansToday: feedIngestionsToday?.items_today ?? 0,
      scansYesterday: 0,
      threatsFlagged: today?.threats_flagged ?? 0,
      threatsYesterday: yesterday?.threats_flagged ?? 0,
      countriesActive: today?.countries_active ?? 0,
      countriesYesterday: yesterday?.countries_active ?? 0,
    };

    const data = {
      success: true,
      data: {
        summary, last24h, dailyStats,
        byType: byType.results, bySource: bySource.results,
        bySeverity: bySeverity.results, byCountry: byCountry.results,
        byProvider,
        recentThreats: recentThreats.results,
        topOriginsToday: topOriginsToday.results,
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Get single threat ──────────────────────────────────────────
export async function handleGetThreat(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const threat = await session.prepare("SELECT * FROM threats WHERE id = ?").bind(id).first();
    if (!threat) return attachBookmark(json({ success: false, error: "Threat not found" }, 404, origin), session);
    return attachBookmark(json({ success: true, data: threat }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Update threat status ───────────────────────────────────────
export async function handleUpdateThreat(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as UpdateThreatBody;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status) { updates.push("status = ?"); values.push(body.status); }
    if (body.severity) { updates.push("severity = ?"); values.push(body.severity); }
    if (body.confidence_score != null) { updates.push("confidence_score = ?"); values.push(body.confidence_score); }

    if (updates.length === 0) return json({ success: false, error: "No valid fields" }, 400, origin);

    updates.push("last_seen = datetime('now')");
    values.push(id);

    await env.DB.prepare(`UPDATE threats SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── List briefings (v1 compat stub) ────────────────────────────
export async function handleListBriefings(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const rows = await session.prepare(
      `SELECT id, type, report_date, report_data, generated_at, trigger, emailed
       FROM threat_briefings ORDER BY generated_at DESC LIMIT 20`
    ).all();
    return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
  } catch {
    // Table may not exist in v2
    return attachBookmark(json({ success: true, data: [] }, 200, origin), session);
  }
}

// ─── Get briefing detail (v1 compat stub) ───────────────────────
export async function handleGetBriefing(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const briefing = await session.prepare("SELECT * FROM threat_briefings WHERE id = ?").bind(id).first();
    if (!briefing) return attachBookmark(json({ success: false, error: "Briefing not found" }, 404, origin), session);
    return attachBookmark(json({ success: true, data: briefing }, 200, origin), session);
  } catch {
    return attachBookmark(json({ success: false, error: "Not available in v2" }, 410, origin), session);
  }
}

// ─── Social IOCs (v1 compat stub) ───────────────────────────────
export async function handleListSocialIOCs(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const platform = url.searchParams.get("platform");

    let query = `SELECT id, platform, author, post_url, ioc_type, ioc_value, confidence, context, tags, verified, captured_at, created_at
                 FROM social_iocs`;
    const params: unknown[] = [];
    if (platform) { query += " WHERE platform = ?"; params.push(platform); }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = await session.prepare(query).bind(...params).all();
    return attachBookmark(json({ success: true, data: { iocs: rows.results, stats: {} } }, 200, origin), session);
  } catch {
    return attachBookmark(json({ success: true, data: { iocs: [], stats: {} } }, 200, origin), session);
  }
}

// ─── GeoIP Enrichment ─────────────────────────────────────────
export async function handleEnrichGeo(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const result = await enrichThreatsGeo(env.DB);
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Full enrichment pipeline trigger ─────────────────────────
export async function handleEnrichAll(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { runEnrichmentPipeline } = await import("../lib/enrichment");
    const result = await runEnrichmentPipeline(env);
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Geo clusters for Observatory map ─────────────────────────
export async function handleGeoClusters(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const rows = await session.prepare(`
      SELECT country_code, COUNT(*) AS threat_count,
             AVG(lat) AS lat, AVG(lng) AS lng,
             COUNT(DISTINCT target_brand_id) AS brands_targeted,
             COUNT(DISTINCT hosting_provider_id) AS provider_count,
             MIN(CASE
               WHEN severity = 'critical' THEN 'critical'
               WHEN severity = 'high' THEN 'high'
               WHEN severity = 'medium' THEN 'medium'
               ELSE 'low'
             END) AS top_severity
      FROM threats
      WHERE country_code IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL
      GROUP BY country_code
      ORDER BY threat_count DESC
      LIMIT 50
    `).all();

    // Top threat_type per country — cube-backed (cost-sweep 2026-05-16).
    // threat_cube_geo has (country_code, threat_type, threat_count) so
    // SUM is exact; saves a full-corpus scan on every map render.
    const topTypeRows = await session.prepare(`
      SELECT country_code, threat_type
      FROM (
        SELECT country_code, threat_type, SUM(threat_count) AS cnt
        FROM threat_cube_geo
        WHERE country_code != ''
        GROUP BY country_code, threat_type
        ORDER BY country_code, cnt DESC
      )
      GROUP BY country_code
    `).all<{ country_code: string; threat_type: string }>();
    const topTypeByCountry = new Map(topTypeRows.results.map(r => [r.country_code, r.threat_type]));

    // Add computed intensity and top_threat_type
    const maxCount = Math.max(...rows.results.map((r: Record<string, unknown>) => (r.threat_count as number) || 1), 1);
    const enriched = rows.results.map((r: Record<string, unknown>) => ({
      ...r,
      intensity: Math.min(1, (r.threat_count as number) / maxCount),
      top_threat_type: topTypeByCountry.get(r.country_code as string) ?? null,
      country: r.country_code,
    }));

    return attachBookmark(json({ success: true, data: enriched }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Brand HQ coordinates for attack flow arc targets ─────────
const BRAND_HQ_COORDS: Record<string, [number, number]> = {
  'paypal.com':        [37.3790, -121.9687],
  'stripe.com':        [37.7749, -122.4194],
  'visa.com':          [37.4419, -122.1430],
  'mastercard.com':    [40.7549,  -73.9840],
  'google.com':        [37.4220, -122.0841],
  'microsoft.com':     [47.6423, -122.1391],
  'apple.com':         [37.3346, -122.0090],
  'amazon.com':        [47.6062, -122.3321],
  'meta.com':          [37.4847, -122.1477],
  'facebook.com':      [37.4847, -122.1477],
  'netflix.com':       [37.2585, -121.9626],
  'twitter.com':       [37.7749, -122.4194],
  'shopify.com':       [45.4215,  -75.6972],
  'ebay.com':          [37.3861, -122.0839],
  'allegro.pl':        [52.4064,   16.9252],
  'docusign.com':      [37.3890, -122.0554],
  'salesforce.com':    [37.7749, -122.4194],
  'okta.com':          [37.7749, -122.4194],
  'cloudflare.com':    [37.7749, -122.4194],
  'instagram.com':     [37.4847, -122.1477],
  'linkedin.com':      [37.3861, -122.0839],
  'tiktok.com':        [37.3861, -122.0839],
  'roblox.com':        [37.5630, -122.0530],
  'github.com':        [37.7820, -122.3918],
  'walmart.com':       [36.3729,  -94.2088],
  'target.com':        [44.8600,  -93.3420],
  'chase.com':         [40.7549,  -73.9840],
  'wellsfargo.com':    [37.7749, -122.4194],
  'bankofamerica.com': [35.2271,  -80.8431],
  'att.com':           [32.7767,  -96.7970],
  'verizon.com':       [40.7128,  -74.0060],
  'files.fm':          [56.9460,   24.1059],
  'zdnet.com':         [40.7128,  -74.0060],
  'jd.com':            [39.9042,  116.4074],
  'lowes.com':         [35.5276,  -80.8504],
};

function getFlowBrandHQ(domain: string | null, brandName?: string | null): [number, number] | null {
  if (!domain) return null;
  const clean = domain.replace(/^www\./, '').toLowerCase();
  if (BRAND_HQ_COORDS[clean]) return BRAND_HQ_COORDS[clean];
  for (const [key, coords] of Object.entries(BRAND_HQ_COORDS)) {
    const keyBase = key.split('.')[0] ?? '';
    const cleanBase = clean.split('.')[0] ?? '';
    if (cleanBase && keyBase && (clean.includes(keyBase) || key.includes(cleanBase))) return coords;
  }
  return null;
}

// ─── Attack flows for Observatory arc overlay ─────────────────
export async function handleAttackFlows(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));

    const rows = await session.prepare(`
      SELECT t.country_code AS origin_country,
             t.lat AS origin_lat, t.lng AS origin_lng,
             t.threat_type,
             b.canonical_domain AS target_name,
             b.name AS brand_name,
             COUNT(*) AS volume
      FROM threats t
      JOIN brands b ON b.id = t.target_brand_id
      WHERE t.lat IS NOT NULL
        AND t.lng IS NOT NULL
        AND t.target_brand_id IS NOT NULL
        AND t.status = 'active'
        AND t.threat_type IN ('phishing', 'credential_harvesting',
                              'typosquatting', 'impersonation', 'c2',
                              'malware_distribution')
        AND b.canonical_domain NOT LIKE '%.net'
        AND b.canonical_domain NOT LIKE '%1x1%'
        AND b.canonical_domain NOT LIKE '%1e1%'
        AND b.name NOT LIKE '1%'
        AND LENGTH(b.name) > 4
        AND b.threat_count >= 5
      GROUP BY t.country_code, t.target_brand_id, t.threat_type
      ORDER BY volume DESC
      LIMIT ?
    `).bind(limit).all();

    const flows = rows.results
      .map((r: Record<string, unknown>) => {
        const coords = getFlowBrandHQ(r.target_name as string | null, r.brand_name as string | null);
        if (!coords) return null;
        const [target_lat, target_lng] = coords;
        const jitter = () => (Math.random() - 0.5) * 0.8;
        return {
          origin_lat: r.origin_lat,
          origin_lng: r.origin_lng,
          target_lat: target_lat + jitter(),
          target_lng: target_lng + jitter(),
          volume: r.volume,
          origin_country: r.origin_country,
          target_name: r.target_name,
          threat_type: r.threat_type ?? 'phishing',
        };
      })
      .filter(Boolean);

    return attachBookmark(json({ success: true, data: flows }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Recent threats for live polling ──────────────────────────
export async function handleRecentThreats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "20", 10));

    const rows = await session.prepare(`
      SELECT id, threat_type, severity, source_feed, malicious_domain,
             ip_address, country_code, lat, lng, created_at
      FROM threats
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(limit).all();

    return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Daily snapshot trigger ───────────────────────────────────
export async function handleDailySnapshots(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { generateDailySnapshots } = await import("../lib/snapshots");
    const result = await generateDailySnapshots(env.DB);
    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
