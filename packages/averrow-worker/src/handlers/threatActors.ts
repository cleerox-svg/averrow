// Averrow — Threat Actor API Handlers

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import { cachedValue } from "../lib/cached-value";
import type { Env } from "../types";

// Helper: safely query a table that may not exist, returning a fallback
async function safeQuery<T>(session: D1Database, stmt: D1PreparedStatement, fallback: T): Promise<T> {
  try {
    const result = await stmt.first<T>();
    return result ?? fallback;
  } catch {
    return fallback;
  }
}

async function safeQueryAll(_db: D1Database, stmt: D1PreparedStatement): Promise<{ results: Record<string, unknown>[] }> {
  try {
    return await stmt.all();
  } catch {
    return { results: [] };
  }
}

// GET /api/threat-actors?country=IR&status=active&attribution=IRGC&limit=50&offset=0
export async function handleListThreatActors(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const country = url.searchParams.get("country");
    const status = url.searchParams.get("status");
    const attribution = url.searchParams.get("affiliation") ?? url.searchParams.get("attribution");
    const search = url.searchParams.get("q");

    // KV cache — 5 min TTL. Key includes all filter dimensions.
    const cacheKey = `threat_actors:${limit}:${offset}:${country ?? ""}:${status ?? ""}:${attribution ?? ""}:${search ?? ""}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "threat_actors_list", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }
    const tally = newTally();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (country) {
      conditions.push("ta.country_code = ?");
      params.push(country.toUpperCase());
    }
    if (status) {
      conditions.push("ta.status = ?");
      params.push(status);
    }
    if (attribution) {
      conditions.push("ta.affiliation = ?");
      params.push(attribution);
    }
    if (search) {
      conditions.push("(ta.name LIKE ? OR ta.aliases LIKE ? OR ta.description LIKE ?)");
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Column names from actual DB schema (migration 0063), aliased to the
    // shape the frontend expects. target_sectors and active_campaigns are
    // derived/NULL for now (not stored as columns).
    //
    // last_seen falls back to:
    //   1. The most recent threat_attributions.observed_at for this actor
    //      (Phase B — direct OTX/NEXUS/news attribution)
    //   2. ta.last_seen (Sentinel ASN-based bump)
    //   3. ta.first_seen (initial seed)
    // so the card footer always has a date to render and the freshest
    // signal wins.
    const selectCols = `ta.id, ta.name, ta.aliases,
          ta.affiliation AS attribution,
          ta.country_code AS country,
          ta.primary_ttps AS ttps,
          ta.capability,
          ta.description,
          ta.first_seen,
          COALESCE(
            (SELECT MAX(att.observed_at) FROM threat_attributions att WHERE att.actor_id = ta.id),
            ta.last_seen,
            ta.first_seen
          ) AS last_seen,
          ta.status, ta.attribution_confidence,
          ta.created_at, ta.updated_at,
          NULL AS target_sectors,
          NULL AS active_campaigns`;

    // Sort: active actors first, then by most recent signal (Sentinel
    // bumps last_seen on ASN hits), alphabetical as a stable tiebreaker.
    const orderBy = `ORDER BY
          CASE ta.status WHEN 'active' THEN 0 ELSE 1 END,
          COALESCE(ta.last_seen, ta.first_seen) DESC,
          ta.name`;

    // Run count + list + sparkline data in parallel — each with its own
    // catch so one broken query doesn't take down the whole response.
    const countPromise = session.prepare(
      `SELECT COUNT(*) AS total FROM threat_actors ta ${where}`
    ).bind(...params).first<{ total: number }>().catch((err) => {
      console.error('[threatActors] count query failed:', err);
      return null;
    });

    // Main query. If the join-count subqueries fail (tables missing), fall
    // back to a basic query with 0 counts. Includes attribution counts from
    // threat_attributions (Phase B) so the UI can sort/filter actors by
    // recent OTX/NEXUS/news activity instead of static seed dates.
    const rowsPromise = session.prepare(`
      SELECT ${selectCols},
        (SELECT COUNT(*) FROM threat_actor_infrastructure tai WHERE tai.threat_actor_id = ta.id) AS infra_count,
        (SELECT COUNT(*) FROM threat_actor_targets tat WHERE tat.threat_actor_id = ta.id) AS target_count,
        (SELECT COUNT(*) FROM threat_attributions att
           WHERE att.actor_id = ta.id
             AND att.observed_at >= datetime('now', '-7 days'))
          AS attribution_count_7d,
        (SELECT COUNT(*) FROM threat_attributions att WHERE att.actor_id = ta.id)
          AS attribution_count_total
      FROM threat_actors ta
      ${where}
      ${orderBy}
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all().catch(async (err) => {
      console.error('[threatActors] main query with joins failed, trying fallback:', err);
      try {
        return await session.prepare(`
          SELECT ${selectCols},
                 0 AS infra_count, 0 AS target_count,
                 0 AS attribution_count_7d, 0 AS attribution_count_total
          FROM threat_actors ta
          ${where}
          ${orderBy}
          LIMIT ? OFFSET ?
        `).bind(...params, limit, offset).all();
      } catch (err2) {
        console.error('[threatActors] fallback query also failed:', err2);
        return { results: [] as Record<string, unknown>[], meta: undefined as unknown, success: false } as unknown as D1Result;
      }
    });

    // Sparkline: 14-day daily threat counts per actor via ASN infrastructure join.
    // Result row count is small (~98 rows max for the actors that have
    // matching ASNs in the 14-day window), but the JOIN scans ~14 days of
    // `threats` (≈ 50K rows) on every call regardless of the page filters
    // — the data is global, not paginated. The 2026-05-23 diagnostic
    // attributed 185K rows/request × 46 requests/24h = ~8.5M rows/24h to
    // this single endpoint, making it the 3rd-largest read source.
    //
    // PR-CC (priority 4 of the diagnostics walk-through): wrap with
    // cachedValue at 1800s (30 min) using a fixed key — the sparkline is
    // filter-independent, so every list-call across countries / status /
    // attribution shares the cached value. A 30-min lag is invisible on
    // a 14-day-window visualization (each day is one bar of a sparkline;
    // the most-recent bar updates within the same UTC day either way).
    // Falls through to compute on KV errors via cachedValue's contract,
    // so the cache is purely a perf optimization — never a correctness
    // dependency.
    const sparklinePromise = cachedValue<{ threat_actor_id: string; day: string; cnt: number }[]>(
      env,
      'threat_actor_sparkline_14d',
      1800,
      async () => {
        const r = await session.prepare(`
          SELECT tai.threat_actor_id,
                 date(t.created_at) AS day,
                 COUNT(*) AS cnt
          FROM threats t
          JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
          WHERE t.created_at >= datetime('now', '-14 days')
            AND t.asn IS NOT NULL
          GROUP BY tai.threat_actor_id, date(t.created_at)
        `).all<{ threat_actor_id: string; day: string; cnt: number }>();
        if (r.meta) addToTally(tally, r.meta);
        return r.results;
      },
    ).catch((err) => {
      console.error('[threatActors] sparkline query failed:', err);
      return [] as { threat_actor_id: string; day: string; cnt: number }[];
    });

    const [countResult, rows, sparklineRows] = await Promise.all([countPromise, rowsPromise, sparklinePromise]);
    // .first() doesn't expose meta on countResult; .all() rows have meta.
    // sparklineRows is now a bare array (compute() inside cachedValue
    // handles its own meta accounting) — no `meta` field to check here.
    if (rows && 'meta' in rows) addToTally(tally, rows.meta);
    tally.queries += 1; // count query

    // Pivot sparkline rows into per-actor 14-day arrays (oldest first)
    const sparkMap = new Map<string, number[]>();
    const today = new Date();
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const byActor = new Map<string, Map<string, number>>();
    for (const row of sparklineRows) {
      if (!byActor.has(row.threat_actor_id)) byActor.set(row.threat_actor_id, new Map());
      byActor.get(row.threat_actor_id)!.set(row.day, row.cnt);
    }
    for (const [actorId, dayMap] of byActor) {
      sparkMap.set(actorId, days.map(d => dayMap.get(d) ?? 0));
    }

    // Attach threat_history to each actor row
    const enriched = (rows.results as Record<string, unknown>[]).map(r => ({
      ...r,
      threat_history: sparkMap.get(r.id as string) ?? [],
    }));

    const data = {
      success: true,
      data: enriched,
      total: countResult?.total ?? 0,
    };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    recordD1Reads(env, "threat_actors_list", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "Failed to list threat actors" }, 500, origin), session);
  }
}

// GET /api/threat-actors/stats
export async function handleThreatActorStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    // KV cache — 5 min TTL.
    const cacheKey = "threat_actor_stats";
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "threat_actor_stats", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }
    const tally = newTally();

    // Run all 6 queries in parallel
    const [total, active, byCountry, byAttribution, totalInfra, totalTargets] = await Promise.all([
      session.prepare("SELECT COUNT(*) AS n FROM threat_actors").first<{ n: number }>(),
      session.prepare("SELECT COUNT(*) AS n FROM threat_actors WHERE status = 'active'").first<{ n: number }>(),
      session.prepare(`
        SELECT country_code AS country, COUNT(*) AS count
        FROM threat_actors
        GROUP BY country_code
        ORDER BY count DESC
        LIMIT 10
      `).all(),
      session.prepare(`
        SELECT affiliation AS attribution, COUNT(*) AS count
        FROM threat_actors
        WHERE affiliation IS NOT NULL
        GROUP BY affiliation
        ORDER BY count DESC
      `).all(),
      // These tables may not exist if migration 0063 partially failed
      safeQuery(session as unknown as D1Database,
        session.prepare("SELECT COUNT(*) AS n FROM threat_actor_infrastructure"),
        { n: 0 }
      ),
      safeQuery(session as unknown as D1Database,
        session.prepare("SELECT COUNT(DISTINCT brand_id) AS n FROM threat_actor_targets WHERE brand_id IS NOT NULL"),
        { n: 0 }
      ),
    ]);
    addToTally(tally, byCountry.meta);
    addToTally(tally, byAttribution.meta);
    tally.queries += 4; // total, active, totalInfra, totalTargets via .first()/safeQuery

    const data = {
      success: true,
      data: {
        total: total?.n ?? 0,
        active: active?.n ?? 0,
        by_country: byCountry.results,
        by_attribution: byAttribution.results,
        tracked_infrastructure: totalInfra.n ?? 0,
        targeted_brands: totalTargets.n ?? 0,
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    recordD1Reads(env, "threat_actor_stats", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "Failed to get threat actor stats" }, 500, origin), session);
  }
}

// GET /api/threat-actors/:id
export async function handleGetThreatActor(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const actor = await env.DB.prepare(`
      SELECT id, name, aliases,
             affiliation AS attribution,
             country_code AS country,
             primary_ttps AS ttps,
             capability,
             description,
             first_seen,
             COALESCE(last_seen, first_seen) AS last_seen,
             status, attribution_confidence,
             created_at, updated_at,
             NULL AS target_sectors,
             NULL AS active_campaigns
      FROM threat_actors WHERE id = ?
    `).bind(id).first();
    if (!actor) {
      return json({ success: false, error: "Threat actor not found" }, 404, origin);
    }

    // These tables may not exist — gracefully fall back to empty arrays
    const infrastructure = await safeQueryAll(env.DB,
      env.DB.prepare(
        "SELECT * FROM threat_actor_infrastructure WHERE threat_actor_id = ? ORDER BY last_observed DESC"
      ).bind(id)
    );

    const targets = await safeQueryAll(env.DB,
      env.DB.prepare(`
        SELECT tat.*, b.name AS brand_name, b.canonical_domain
        FROM threat_actor_targets tat
        LEFT JOIN brands b ON b.id = tat.brand_id
        WHERE tat.threat_actor_id = ?
        ORDER BY tat.last_targeted DESC
      `).bind(id)
    );

    // Count threats from this actor's known infrastructure
    const infraAsns = infrastructure.results
      .map((r) => (r as Record<string, unknown>).asn as string | null)
      .filter((a): a is string => a !== null);

    let linkedThreats = 0;
    if (infraAsns.length > 0) {
      const placeholders = infraAsns.map(() => "?").join(",");
      const result = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE asn IN (${placeholders})`
      ).bind(...infraAsns).first<{ n: number }>();
      linkedThreats = result?.n ?? 0;
    }

    // Recent attribution timeline — last 12 rows from threat_attributions
    // for this actor across all sources (OTX / NEXUS / news). Drives the
    // detail page's "Recent Activity" section.
    const recentAttributions = await safeQueryAll(env.DB,
      env.DB.prepare(`
        SELECT id, threat_id, source, source_pulse_name, confidence,
               actor_name_raw, observed_at
        FROM threat_attributions
        WHERE actor_id = ?
        ORDER BY observed_at DESC
        LIMIT 12
      `).bind(id)
    );

    // News articles that mentioned this actor — pulls from news_articles
    // by JSON-matching the extracted actors[] array. Phase D's news-watcher
    // writes the raw extraction blob; we filter client-side here on the
    // actor's name + aliases. Cap at 5 most-recent geopolitical-flagged
    // articles for the detail-page sidebar.
    const aliasesRaw = (actor as Record<string, unknown>).aliases as string | null;
    const actorNames = [
      (actor as Record<string, unknown>).name as string,
      ...(aliasesRaw ? safeParseJsonArray(aliasesRaw) : []),
    ].filter(Boolean);

    let newsMentions: unknown[] = [];
    if (actorNames.length > 0) {
      // SQLite has no native JSON-array-contains; the extraction JSON
      // stores actors as a quoted string within the blob, so a LIKE
      // match on the name (with quote padding) is reliable enough.
      // Build a single OR of LIKEs against extracted.
      const likeClauses = actorNames.map(() => `extracted LIKE ?`).join(" OR ");
      const likeBinds = actorNames.map((n) => `%"${n}"%`);
      const articles = await safeQueryAll(env.DB,
        env.DB.prepare(`
          SELECT id, source_feed, article_url, title, excerpt,
                 published_at, ingested_at, is_geopolitical
          FROM news_articles
          WHERE extract_status = 'ok' AND (${likeClauses})
          ORDER BY ingested_at DESC
          LIMIT 5
        `).bind(...likeBinds)
      );
      newsMentions = articles.results;
    }

    return json({
      success: true,
      data: {
        ...actor,
        infrastructure: infrastructure.results,
        targets: targets.results,
        linked_threat_count: linkedThreats,
        recent_attributions: recentAttributions.results,
        news_mentions: newsMentions,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "Failed to get threat actor" }, 500, origin);
  }
}

function safeParseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// GET /api/threat-actors/by-brand/:brandId
export async function handleThreatActorsByBrand(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await safeQueryAll(env.DB,
      env.DB.prepare(`
        SELECT ta.id, ta.name, ta.aliases,
               ta.affiliation AS attribution,
               ta.country_code AS country,
               ta.primary_ttps AS ttps,
               ta.capability,
               ta.description,
               ta.first_seen,
               COALESCE(ta.last_seen, ta.first_seen) AS last_seen,
               ta.status,
               ta.created_at, ta.updated_at,
               NULL AS target_sectors,
               NULL AS active_campaigns,
               tat.context, tat.first_targeted, tat.last_targeted
        FROM threat_actors ta
        JOIN threat_actor_targets tat ON tat.threat_actor_id = ta.id
        WHERE tat.brand_id = ?
        ORDER BY ta.name
      `).bind(brandId)
    );

    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "Failed to get threat actors for brand" }, 500, origin);
  }
}

// GET /api/threat-actors/:id/threats
//
// Surfaces threats linked to this actor from two complementary signals:
//   1. threat_attributions — direct per-threat attributions written by
//      the OTX feed (Phase B) when a pulse names this actor as adversary
//      or carries an APT-tagged identifier.
//   2. threat_actor_infrastructure — ASN-based co-occurrence: any
//      threat from an ASN we've attributed to this actor.
//
// The two lists are unioned by threat id so a single threat that hit
// both signals shows up once. Sorted most-recent first.
export async function handleThreatActorThreats(request: Request, env: Env, actorId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Pull this actor's tracked ASNs (may be empty for actors discovered
    // by OTX that don't have hand-curated infrastructure).
    const infraAsns = await safeQueryAll(env.DB,
      env.DB.prepare(
        "SELECT DISTINCT asn FROM threat_actor_infrastructure WHERE threat_actor_id = ? AND asn IS NOT NULL"
      ).bind(actorId)
    );
    const asns = infraAsns.results
      .map(r => (r as Record<string, unknown>).asn as string)
      .filter(Boolean);

    // Build the WHERE clause from whichever signals have rows. We always
    // include the threat_attributions check; ASN match is conditional.
    // Both clauses join via DISTINCT t.id at the outer query.
    const asnPlaceholders = asns.length > 0 ? asns.map(() => "?").join(",") : "";
    const asnClause = asns.length > 0 ? `OR t.asn IN (${asnPlaceholders})` : "";

    // Bind list: actor_id (for threat_attributions match), then asns
    // (zero or more), then limit + offset on the main query. count
    // query reuses the first N+1 binds (no limit/offset).
    const filterBinds: unknown[] = [actorId, ...asns];

    const countResult = await env.DB.prepare(`
      SELECT COUNT(DISTINCT t.id) AS total
      FROM threats t
      LEFT JOIN threat_attributions ta ON ta.threat_id = t.id
      WHERE ta.actor_id = ?
            ${asnClause}
    `).bind(...filterBinds).first<{ total: number }>();

    const threats = await env.DB.prepare(`
      SELECT DISTINCT t.*, b.name AS brand_name,
             ta.source AS attribution_source,
             ta.confidence AS attribution_confidence,
             ta.source_pulse_name AS attribution_pulse_name
      FROM threats t
      LEFT JOIN threat_attributions ta ON ta.threat_id = t.id AND ta.actor_id = ?
      LEFT JOIN brands b ON b.id = t.target_brand_id
      WHERE ta.actor_id = ?
            ${asnClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(actorId, ...filterBinds, limit, offset).all();

    return json({
      success: true,
      data: threats.results,
      total: countResult?.total ?? 0,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "Failed to get threat actor threats" }, 500, origin);
  }
}
