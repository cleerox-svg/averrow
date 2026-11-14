// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Wave 2A: migrated read handlers to D1 Sessions API (read replicas)
import { json } from "../lib/cors";
import { withDnsblVerdicts } from "../lib/dnsbl-verdict";
import { getDbContext, getReadSession, attachBookmark } from '../lib/db';
import { enrichThreatsGeo } from "../lib/geoip";
import { scopeCacheSegment } from "../lib/scope-cache-key";
import { cachedCount, THREATS_TOTAL_TTL_S } from "../lib/cached-count";
import type { Env, UpdateThreatBody } from "../types";
import type { OrgScope } from "../middleware/auth";

/** TTL of the per-slice filtered total — the list cache's 5 minutes. */
export const THREAT_LIST_FILTERED_TOTAL_TTL_S = 300;

/**
 * cachedCount key for a filtered /api/threats total: every filter that
 * shapes the WHERE plus the org-scope segment, and nothing else (sort,
 * dir, limit and offset don't change the count). Each filter value is
 * encodeURIComponent'd so a ':' inside a value can't shift it into the next
 * segment (brand_id='x:y' vs brand_id='x' + q='y' would otherwise collide
 * and share a count). The scope segment stays last and unescaped — it is
 * `global` or `org:<id>:<digest>` from scopeCacheSegment.
 */
export function threatListTotalKey(
  f: {
    severity: string | null; type: string | null; status: string | null; source: string | null;
    country: string | null; brandId: string | null; search: string | null;
  },
  scopeHash: string,
): string {
  const values = [f.severity, f.type, f.status, f.source, f.country, f.brandId, f.search]
    .map((v) => encodeURIComponent(v ?? ""));
  return ["count.threats.list", ...values, scopeHash].join(":");
}

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
    // `severity` must stay identical to the expression index in migration
    // 0318 (idx_threats_severity_rank_created) — the default page load
    // depends on it to avoid a full-table sort.
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
    const scopeHash = await scopeCacheSegment(scope);
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

    // The unfiltered total is a full-table COUNT(*) (~1.5M rows) and the
    // default page load always asks for it; share the platform-wide cached
    // counter instead (CLAUDE.md §8 "Counter cache"). Filtered totals stay
    // live — they ride the filter's index.
    // NOTE: the unfiltered total is therefore APPROXIMATE — it can lag the
    // real row count by up to THREATS_TOTAL_TTL_S (6h). Fine for a
    // pagination total on a catalog of millions; don't reuse it where an
    // exact count matters.
    // A filtered total depends only on the slice (filters + scope), not on
    // sort/limit/offset, but the list cache key above carries all three, so
    // paging or re-sorting one slice used to re-run the same COUNT(*) each
    // time (a broad filter such as status=active walks most of the index).
    // Share it per slice for the list cache's 5 minutes.
    const countParams = params.slice(0, -2);
    const total = where
      ? await cachedCount(env, threatListTotalKey({ severity, type, status, source, country, brandId, search }, scopeHash),
          THREAT_LIST_FILTERED_TOTAL_TTL_S, async () =>
            (await session.prepare(
              `SELECT COUNT(*) as cnt FROM threats t ${where}`
            ).bind(...countParams).first<{ cnt: number }>())?.cnt ?? 0)
      : await cachedCount(env, 'count.threats.total', THREATS_TOTAL_TTL_S, async () => {
          const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM threats`).first<{ n: number }>();
          return r?.n ?? 0;
        });

    // SURBL / DBL "not listed" is not evidence (lib/dnsbl-verdict.ts).
    const data = { success: true, data: { threats: (rows.results ?? []).map(withDnsblVerdicts), total } };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── Threats catalog aggregate ───────────────────────────────────
// Slice-aware narrative numbers powering /threats Intel surface.
// Honors the same filters as handleListThreats so aggregates match
// what the operator sees in the list. Cached 30min via cachedValue (THREAT_AGGREGATE_TTL_S;
// unfiltered slice 3h + single-flight). Reads go through the read-replica session.
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
    }, scope, session);
    return attachBookmark(json({ success: true, data }, 200, origin), session);
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
    return attachBookmark(json({ success: true, data: withDnsblVerdicts(threat) }, 200, origin), session);
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
