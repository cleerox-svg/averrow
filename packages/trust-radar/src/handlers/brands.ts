// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Brand API Endpoints

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { runSyncAgent } from "../lib/agentRunner";
import { brandAnalysisAgent } from "../agents/brand-analysis";
import type { BrandAnalysisOutput } from "../agents/brand-analysis";
import { brandDeepScanAgent } from "../agents/brand-deep-scan";
import type { BrandDeepScanOutput } from "../agents/brand-deep-scan";
import { discoverSocialProfiles } from "../lib/social-discovery";
import { socialAiAssessorAgent, type SocialAiAssessorInput, type SocialAiAssessorOutput } from "../agents/social-ai-assessor";
import { logger } from "../lib/logger";
import { computeBrandExposureScore } from "../lib/brand-scoring";
import { generateBrandKeywords } from "../lib/brand-utils";
import { getBrandById, getBrandByDomain, getBrandThreatCount } from "../db/brands";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { Env } from "../types";
import type { OrgScope } from "../middleware/auth";

// GET /api/brands/movers
//
// "Brand Movers" data for the unified Home — top 5 brands with the
// largest positive delta in active threat count over the last 7 days
// ("rising"), and top 5 with the largest negative delta ("falling").
//
// Source: daily_snapshots(date, entity_type='brand', entity_id, active_threats).
// Anchored on MAX(date) rather than date('now') so the query keeps
// working if the daily snapshot job hasn't run yet today (the table
// is rebuilt at 00:00 UTC by generateDailySnapshots() each day).
//
// Both lists are computed in a single round-trip: one CTE pair builds
// today/-7d active_threats per brand, then we LEFT JOIN brands and
// run two filters (delta > 0 / delta < 0) over the same projected
// rows. Cached in KV for 5 min — daily-grain data, no need for finer.
export async function handleBrandMovers(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const cacheKey = "brand_movers:v1";
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "brand_movers", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();

    // Single SQL — projects (brand row + today_count + week_ago_count + delta_7d)
    // for every brand that had non-zero active threats on either anchor day.
    // We then split rising/falling client-side from the same row set so we
    // only pay one round-trip.
    const rows = await session.prepare(`
      WITH anchor AS (
        SELECT MAX(date) AS today_date
        FROM daily_snapshots
        WHERE entity_type = 'brand'
      ),
      today_snap AS (
        SELECT entity_id AS brand_id, active_threats AS today_count
        FROM daily_snapshots, anchor
        WHERE entity_type = 'brand' AND date = anchor.today_date
      ),
      week_ago_snap AS (
        SELECT entity_id AS brand_id, active_threats AS week_ago_count
        FROM daily_snapshots, anchor
        WHERE entity_type = 'brand' AND date = date(anchor.today_date, '-7 days')
      )
      SELECT
        b.id, b.name, b.canonical_domain, b.logo_url, b.email_security_grade,
        b.threat_count,
        COALESCE(t.today_count, 0) AS today_count,
        COALESCE(w.week_ago_count, 0) AS week_ago_count,
        COALESCE(t.today_count, 0) - COALESCE(w.week_ago_count, 0) AS delta_7d
      FROM brands b
      LEFT JOIN today_snap t     ON t.brand_id = b.id
      LEFT JOIN week_ago_snap w  ON w.brand_id = b.id
      WHERE COALESCE(t.today_count, 0) + COALESCE(w.week_ago_count, 0) > 0
    `).all<{
      id: string; name: string; canonical_domain: string;
      logo_url: string | null; email_security_grade: string | null;
      threat_count: number;
      today_count: number; week_ago_count: number; delta_7d: number;
    }>();
    tally.queries += 1;

    const all = rows.results ?? [];
    const rising = all
      .filter(r => r.delta_7d > 0)
      .sort((a, b) => b.delta_7d - a.delta_7d)
      .slice(0, 5);
    const falling = all
      .filter(r => r.delta_7d < 0)
      .sort((a, b) => a.delta_7d - b.delta_7d)
      .slice(0, 5);

    const data = {
      success: true,
      data: { rising, falling },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    recordD1Reads(env, "brand_movers", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/stats
export async function handleBrandStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    // KV cache: brand stats rarely change — cache for 2 minutes
    const cacheKey = "brand_stats";
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "brand_stats", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const total = await session.prepare("SELECT COUNT(*) AS n FROM brands").first<{ n: number }>();

    const newThisWeek = await session.prepare(
      "SELECT COUNT(*) AS n FROM brands WHERE first_seen >= datetime('now', '-7 days')"
    ).first<{ n: number }>();

    const fastestRising = await session.prepare(`
      SELECT b.name, COUNT(t.id) AS cnt
      FROM brands b
      JOIN threats t ON t.target_brand_id = b.id AND t.created_at >= datetime('now', '-1 day')
      GROUP BY b.id ORDER BY cnt DESC LIMIT 1
    `).first<{ name: string; cnt: number }>();

    const topType = await session.prepare(`
      SELECT threat_type, COUNT(*) AS cnt, ROUND(COUNT(*) * 100.0 / MAX(1, (SELECT COUNT(*) FROM threats)), 1) AS pct
      FROM threats GROUP BY threat_type ORDER BY cnt DESC LIMIT 1
    `).first<{ threat_type: string; cnt: number; pct: number }>();

    const data = {
      success: true,
      data: {
        total_tracked: total?.n ?? 0,
        new_this_week: newThisWeek?.n ?? 0,
        fastest_rising: fastestRising?.name ?? null,
        fastest_rising_pct: fastestRising?.cnt ?? 0,
        top_threat_type: topType?.threat_type ?? null,
        top_threat_type_pct: topType?.pct ?? 0,
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 });
    // 4 sequential .first() queries — meta isn't exposed.
    tally.queries += 4;
    recordD1Reads(env, "brand_stats", tally);
    return attachBookmark(json(data, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands?tab=under_attack|watchlist|all&q=search&sort=threats|name|recent&limit=50&offset=0
export async function handleListBrands(request: Request, env: Env, scope?: OrgScope | null): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const search = url.searchParams.get("q");
    const sector = url.searchParams.get("sector");
    const tab = url.searchParams.get("tab") ?? "all";
    const sort = url.searchParams.get("sort") ?? "threats";

    // KV cache: brand list is the heaviest query (JOINs + sparkline subquery).
    // Cache for 5 minutes. Default page loads (no search, no sector filter, page 1)
    // use a short cache key that Navigator pre-warms. Filtered/paginated views use a
    // full-dimension key — cache hit rate is lower but still avoids repeated cold queries.
    const scopeHash = scope ? scope.brand_ids.slice(0, 3).join(",") : "global";
    const isDefaultView = !search && !sector && offset === 0;
    const cacheKey = isDefaultView
      ? `brand_list:${tab}:${sort}:${limit}:${scopeHash}`
      : `brand_list:${tab}:${sort}:${limit}:${offset}:${search ?? ""}:${sector ?? ""}:${scopeHash}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      recordD1Reads(env, "brand_list", newTally());
      return attachBookmark(json(JSON.parse(cached), 200, origin), session);
    }

    const tally = newTally();
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Org scope filtering — only show brands assigned to the user's org
    if (scope) {
      if (scope.brand_ids.length === 0) {
        return attachBookmark(json({ success: true, data: [], total: 0, tabs: { under_attack: 0, watchlist: 0, all: 0 } }, 200, origin), session);
      }
      const placeholders = scope.brand_ids.map(() => "?").join(", ");
      conditions.push(`b.id IN (${placeholders})`);
      params.push(...scope.brand_ids);
    }

    // Tab filtering
    if (tab === "under_attack") {
      conditions.push("EXISTS (SELECT 1 FROM threats WHERE target_brand_id = b.id AND status = 'active' LIMIT 1)");
    } else if (tab === "watchlist") {
      conditions.push("mb.brand_id IS NOT NULL");
    }

    if (search) { conditions.push("(b.name LIKE ? OR b.canonical_domain LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    if (sector) { conditions.push("b.sector = ?"); params.push(sector); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const sortClause = sort === "name" ? "b.name ASC" :
      sort === "recent" ? "b.last_threat_seen DESC NULLS LAST" :
      "b.threat_count DESC";

    params.push(limit, offset);

    // Use pre-computed columns on brands table instead of JOINing 113K threats.
    // brands.threat_count and brands.last_threat_seen are maintained by
    // cartographer, handleAddMonitoredBrand, and handleBrandDeepScan.
    const rows = await session.prepare(`
      SELECT b.id, b.name, b.canonical_domain, b.sector, b.source, b.first_seen,
             b.official_handles, b.email_security_grade,
             b.exposure_score,
             b.social_risk_score,
             b.logo_url,
             b.threat_count,
             b.last_threat_seen,
             CASE WHEN mb.brand_id IS NOT NULL THEN 1 ELSE 0 END AS is_monitored,
             COALESCE(sp_imp.imp_count, 0) AS social_impersonation_count
      FROM brands b
      LEFT JOIN monitored_brands mb ON mb.brand_id = b.id
      LEFT JOIN (
        SELECT brand_id, COUNT(*) AS imp_count
        FROM social_profiles
        WHERE classification = 'impersonation' AND status = 'active'
        GROUP BY brand_id
      ) sp_imp ON sp_imp.brand_id = b.id
      ${where}
      ORDER BY ${sortClause}
      LIMIT ? OFFSET ?
    `).bind(...params).all();
    addToTally(tally, rows.meta);

    // Sparklines via brand cube — single bulk query instead of N correlated subqueries.
    // Fetches 14-day daily counts for all returned brand IDs from threat_cube_brand,
    // then merges into each result row as threat_history: number[].
    const brandIds = (rows.results as Array<{ id: string }>).map(r => r.id);
    const sparkMap = new Map<string, number[]>();
    if (brandIds.length > 0) {
      try {
        const placeholders = brandIds.map(() => '?').join(',');
        const sparkRows = await session.prepare(`
          SELECT target_brand_id, date(hour_bucket) as day, SUM(threat_count) as daily_count
          FROM threat_cube_brand
          WHERE hour_bucket >= datetime('now', '-14 days')
            AND target_brand_id IN (${placeholders})
          GROUP BY target_brand_id, date(hour_bucket)
          ORDER BY target_brand_id, day ASC
        `).bind(...brandIds).all<{ target_brand_id: string; day: string; daily_count: number }>();
        addToTally(tally, sparkRows.meta);
        for (const row of sparkRows.results) {
          if (!sparkMap.has(row.target_brand_id)) sparkMap.set(row.target_brand_id, []);
          sparkMap.get(row.target_brand_id)!.push(row.daily_count);
        }
      } catch {
        // Cube table may not exist yet (pre-migration) — degrade gracefully
      }
    }
    const resultsWithSparklines = (rows.results as Array<Record<string, unknown>>).map(r => ({
      ...r,
      threat_history: sparkMap.get(r.id as string) ?? [],
    }));

    // Total count + tab counts — run in parallel
    const scopeFilter = scope && scope.brand_ids.length > 0
      ? { clause: `AND target_brand_id IN (${scope.brand_ids.map(() => "?").join(", ")})`, params: scope.brand_ids }
      : { clause: "", params: [] as string[] };
    const brandScopeFilter = scope && scope.brand_ids.length > 0
      ? { clause: `WHERE id IN (${scope.brand_ids.map(() => "?").join(", ")})`, params: scope.brand_ids }
      : { clause: "", params: [] as string[] };
    const mbScopeFilter = scope && scope.brand_ids.length > 0
      ? { clause: `WHERE brand_id IN (${scope.brand_ids.map(() => "?").join(", ")})`, params: scope.brand_ids }
      : { clause: "", params: [] as string[] };

    const [underAttackCount, watchlistCount, allCount] = await Promise.all([
      session.prepare(
        `SELECT COUNT(DISTINCT target_brand_id) AS n FROM threats WHERE status = 'active' AND target_brand_id IS NOT NULL ${scopeFilter.clause}`
      ).bind(...scopeFilter.params).first<{ n: number }>(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM monitored_brands ${mbScopeFilter.clause}`
      ).bind(...mbScopeFilter.params).first<{ n: number }>(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM brands ${brandScopeFilter.clause}`
      ).bind(...brandScopeFilter.params).first<{ n: number }>(),
    ]);
    // 3 .first() count queries — meta unavailable, but the
    // `under_attack` one scans active threats (200K+ rows) and is the
    // single most expensive read in this handler.
    tally.queries += 3;

    const total = allCount;

    const result = {
      success: true,
      data: resultsWithSparklines,
      total: total?.n ?? 0,
      tabs: {
        under_attack: underAttackCount?.n ?? 0,
        watchlist: watchlistCount?.n ?? 0,
        all: allCount?.n ?? 0,
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 300 });
    recordD1Reads(env, "brand_list", tally);
    return attachBookmark(json(result, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/top-targeted
export async function handleTopTargetedBrands(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(20, parseInt(url.searchParams.get("limit") ?? "10", 10));
    const period = url.searchParams.get("period") ?? "30d";

    let since = "datetime('now', '-30 days')";
    if (period === "7d") since = "datetime('now', '-7 days')";
    else if (period === "90d") since = "datetime('now', '-90 days')";
    else if (period === "1y") since = "datetime('now', '-1 year')";

    const rows = await session.prepare(`
      SELECT b.id, b.name, b.sector, b.canonical_domain,
             b.official_handles, b.email_security_grade,
             b.exposure_score,
             b.social_risk_score,
             COUNT(t.id) AS threat_count,
             COALESCE(sp_imp.imp_count, 0) AS social_impersonation_count
      FROM brands b
      JOIN threats t ON t.target_brand_id = b.id AND t.created_at >= ${since}
      LEFT JOIN (
        SELECT brand_id, COUNT(*) AS imp_count
        FROM social_profiles
        WHERE classification = 'impersonation' AND status = 'active'
        GROUP BY brand_id
      ) sp_imp ON sp_imp.brand_id = b.id
      GROUP BY b.id
      ORDER BY threat_count DESC
      LIMIT ?
    `).bind(limit).all();

    return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/monitored
export async function handleMonitoredBrands(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const rows = await session.prepare(`
      SELECT b.id, b.name, b.canonical_domain, b.sector, b.first_seen,
             b.official_handles, b.email_security_grade,
             b.exposure_score,
             b.social_risk_score,
             COUNT(t.id) AS threat_count,
             MAX(t.created_at) AS last_threat_seen,
             COALESCE(sp_imp.imp_count, 0) AS social_impersonation_count
      FROM monitored_brands mb
      JOIN brands b ON b.id = mb.brand_id
      LEFT JOIN threats t ON t.target_brand_id = b.id AND t.status = 'active'
      LEFT JOIN (
        SELECT brand_id, COUNT(*) AS imp_count
        FROM social_profiles
        WHERE classification = 'impersonation' AND status = 'active'
        GROUP BY brand_id
      ) sp_imp ON sp_imp.brand_id = b.id
      GROUP BY b.id
      ORDER BY threat_count DESC
    `).all();

    return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// POST /api/brands/monitor
export async function handleAddMonitoredBrand(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => null) as {
      domain?: string; name?: string | null; sector?: string | null;
      reason?: string | null; notes?: string | null;
      official_handles?: Record<string, string>;
      aliases?: string[];
      brand_keywords?: string[];
      website_url?: string;
    } | null;

    if (!body?.domain) return json({ success: false, error: "domain required" }, 400, origin);

    const domain = body.domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    const brandName = body.name || domain.split(".")[0]!.charAt(0).toUpperCase() + domain.split(".")[0]!.slice(1);

    // Find existing brand by canonical_domain, or create one
    const existingBrand = await getBrandByDomain(env, domain);
    let currentBrandId: string;

    if (existingBrand) {
      currentBrandId = existingBrand.id;
    } else {
      currentBrandId = `brand_${domain.replace(/[^a-z0-9]+/g, "_")}`;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO brands (id, name, canonical_domain, sector, first_seen, threat_count)
         VALUES (?, ?, ?, ?, datetime('now'), 0)`
      ).bind(currentBrandId, brandName, domain, body.sector ?? null).run();
    }

    // Insert into monitored_brands (PK is brand_id + tenant_id)
    await env.DB.prepare(
      `INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, notes, status)
       VALUES (?, '__internal__', ?, ?, 'active')`
    ).bind(currentBrandId, userId, body.notes ?? null).run();

    // ─── Auto-add canonical domain to safe domains allowlist ───
    await env.DB.prepare(
      `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
       VALUES (?, ?, ?, ?, 'auto_detected')`
    ).bind(crypto.randomUUID(), currentBrandId, domain, userId).run();
    // Also add www variant
    await env.DB.prepare(
      `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
       VALUES (?, ?, ?, ?, 'auto_detected')`
    ).bind(crypto.randomUUID(), currentBrandId, "www." + domain, userId).run();
    // Also add wildcard for all subdomains
    await env.DB.prepare(
      `INSERT OR IGNORE INTO brand_safe_domains (id, brand_id, domain, added_by, source)
       VALUES (?, ?, ?, ?, 'auto_detected')`
    ).bind(crypto.randomUUID(), currentBrandId, "*." + domain, userId).run();

    // ─── Populate social monitoring fields if provided ───
    const socialDomain = domain;
    const socialBrandName = brandName;
    const keywords = body.brand_keywords ?? generateBrandKeywords(socialDomain, socialBrandName);
    const handles = body.official_handles ?? {};
    const aliases = body.aliases ?? [];

    const socialUpdates: string[] = [];
    const socialValues: unknown[] = [];

    if (Object.keys(handles).length > 0) {
      socialUpdates.push("official_handles = ?");
      socialValues.push(JSON.stringify(handles));
    }
    if (aliases.length > 0) {
      socialUpdates.push("aliases = ?");
      socialValues.push(JSON.stringify(aliases));
    }
    if (keywords.length > 0) {
      socialUpdates.push("brand_keywords = ?");
      socialValues.push(JSON.stringify(keywords));
    }
    if (body.website_url) {
      socialUpdates.push("website_url = ?");
      socialValues.push(body.website_url);
    }

    if (socialUpdates.length > 0) {
      socialValues.push(currentBrandId);
      await env.DB.prepare(
        `UPDATE brands SET ${socialUpdates.join(", ")} WHERE id = ?`
      ).bind(...socialValues).run();
    }

    // Create brand_monitor_schedule entries for each platform with a handle
    for (const platform of Object.keys(handles)) {
      const schedId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO brand_monitor_schedule (id, brand_id, monitor_type, platform, check_interval_hours, enabled)
        VALUES (?, ?, 'social', ?, 24, 1)
        ON CONFLICT (brand_id, monitor_type, platform) DO UPDATE SET enabled = 1
      `).bind(schedId, currentBrandId, platform).run();
    }

    // ─── Auto-discover social profiles from brand website (non-fatal) ───
    try {
      const discovered = await discoverSocialProfiles(`https://${domain}`);
      if (discovered.length > 0) {
        const discoveredHandles: Record<string, string> = {};
        for (const profile of discovered) {
          const profileId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT OR IGNORE INTO social_profiles
              (id, brand_id, platform, handle, profile_url, classification,
               classified_by, classification_confidence, status)
            VALUES (?, ?, ?, ?, ?, 'official', 'auto_discovery', ?, 'active')
          `).bind(profileId, currentBrandId, profile.platform, profile.handle,
                  profile.profileUrl, profile.confidence).run();

          if (!discoveredHandles[profile.platform]) {
            discoveredHandles[profile.platform] = profile.handle;
          }
        }

        // Merge with any user-provided handles (user input takes priority)
        const existingHandles = handles;
        const merged = { ...discoveredHandles, ...existingHandles };
        await env.DB.prepare(
          "UPDATE brands SET official_handles = ?, website_url = COALESCE(website_url, ?) WHERE id = ?"
        ).bind(JSON.stringify(merged), `https://${domain}`, currentBrandId).run();

        // Create monitor schedules for discovered platforms
        for (const platform of Object.keys(discoveredHandles)) {
          if (!existingHandles[platform]) {
            const schedId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO brand_monitor_schedule (id, brand_id, monitor_type, platform, check_interval_hours, enabled)
              VALUES (?, ?, 'social', ?, 24, 1)
              ON CONFLICT (brand_id, monitor_type, platform) DO UPDATE SET enabled = 1
            `).bind(schedId, currentBrandId, platform).run();
          }
        }

        logger.info("brand_social_discovery", {
          brand_id: currentBrandId, domain, discovered: discovered.length,
          platforms: [...new Set(discovered.map(d => d.platform))],
        });
      }
    } catch (err) {
      logger.error("brand_social_discovery_error", {
        brand_id: currentBrandId, domain,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ─── Step A: Retroactive domain-based threat linking (free, no AI) ───
    const keyword = domain.split(".")[0]!; // e.g. "docusign.com" → "docusign"
    const hyphenated = keyword.includes("-") ? keyword : keyword.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    // Build LIKE patterns: exact keyword and hyphenated variant
    const patterns: string[] = [`%${keyword}%`];
    if (hyphenated !== keyword) patterns.push(`%${hyphenated}%`);
    // Also try splitting on common word boundaries: "docusign" → "docu-sign" won't match
    // but "docu-sign" domain → keyword "docu-sign" will match via the first pattern

    // Match threats by URL containing keyword or canonical_domain
    const likeClause = patterns.map(() => "malicious_url LIKE ?").join(" OR ");
    const domainLikeClause = `malicious_domain LIKE ? OR malicious_url LIKE ?`;
    const linkQuery = `UPDATE threats SET target_brand_id = ? WHERE target_brand_id IS NULL AND (${likeClause} OR ${domainLikeClause}) `;
    const bindValues = [currentBrandId, ...patterns, `%${domain}%`, `%${domain}%`];

    const linkResult = await env.DB.prepare(linkQuery).bind(...bindValues).run();
    const threatsLinked = linkResult.meta?.changes ?? 0;

    // Update brand aggregate counts
    if (threatsLinked > 0) {
      await env.DB.prepare(
        `UPDATE brands SET
           threat_count = (SELECT COUNT(*) FROM threats WHERE target_brand_id = ?),
           last_threat_seen = (SELECT MAX(created_at) FROM threats WHERE target_brand_id = ?)
         WHERE id = ?`
      ).bind(currentBrandId, currentBrandId, currentBrandId).run();
    }

    await audit(env, { action: "brand_monitor_add", userId, resourceType: "brand", resourceId: currentBrandId, details: { domain, reason: body.reason, threats_linked: threatsLinked }, request });

    // ─── Auto-enrich new brand: Sessions A + B (best-effort) ────────
    // Session A: logo + HQ geo. Session B: sector (Haiku) + RDAP.
    // Runs inline (ExecutionContext not plumbed here) but every sub-call
    // has a short timeout and Promise.allSettled — worst case ~8s.
    try {
      const { enrichBrand, fetchRdap } = await import("../lib/brand-enricher");
      const { brandEnricherAgent } = await import("../agents/brand-enricher");
      type SectorResult = { sector: string; aiSucceeded: boolean };

      const apiKey = env.ANTHROPIC_API_KEY;
      const [enrichRes, rdapRes, sectorRes] = await Promise.allSettled([
        enrichBrand(domain, env.CACHE, env),
        fetchRdap(domain),
        // Phase 3.7 of agent audit: sector classification is a sync
        // agent now. Wrapped in runSyncAgent for the agent_runs row +
        // standard input/output schema validation.
        apiKey
          ? runSyncAgent<SectorResult>(env, brandEnricherAgent, { domain, brandName })
          : Promise.resolve(null),
      ]);

      const enrichment = enrichRes.status === "fulfilled" ? enrichRes.value : null;
      const rdapData   = rdapRes.status === "fulfilled"   ? rdapRes.value   : null;
      const sectorVal  = sectorRes.status === "fulfilled" && sectorRes.value && "data" in sectorRes.value
        ? sectorRes.value.data?.sector ?? null
        : null;

      await env.DB.prepare(`
        UPDATE brands SET
          logo_url             = COALESCE(logo_url, ?),
          website_url          = COALESCE(website_url, ?),
          hq_lat               = COALESCE(hq_lat, ?),
          hq_lng               = COALESCE(hq_lng, ?),
          hq_country           = COALESCE(hq_country, ?),
          hq_ip                = COALESCE(hq_ip, ?),
          sector               = COALESCE(sector, ?),
          registrar            = COALESCE(registrar, ?),
          registered_at        = COALESCE(registered_at, ?),
          expires_at           = COALESCE(expires_at, ?),
          registrant_country   = COALESCE(registrant_country, ?),
          enriched_at          = datetime('now'),
          sector_classified_at = datetime('now')
        WHERE id = ?
      `).bind(
        enrichment?.logo_url    ?? null,
        enrichment?.website_url ?? null,
        enrichment?.hq_lat      ?? null,
        enrichment?.hq_lng      ?? null,
        enrichment?.hq_country  ?? null,
        enrichment?.hq_ip       ?? null,
        sectorVal,
        rdapData?.registrar          ?? null,
        rdapData?.registered_at      ?? null,
        rdapData?.expires_at         ?? null,
        rdapData?.registrant_country ?? null,
        currentBrandId,
      ).run();
    } catch { /* enrichment is best-effort — never block brand creation */ }

    return json({ success: true, data: { brand_id: currentBrandId, domain, name: brandName, threats_linked: threatsLinked, message: threatsLinked > 0 ? `Found ${threatsLinked} existing threats matching this brand` : "No existing threats matched" } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// DELETE /api/brands/monitor/:id
export async function handleRemoveMonitoredBrand(request: Request, env: Env, brandId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    await env.DB.prepare("DELETE FROM monitored_brands WHERE brand_id = ?").bind(brandId).run();
    await audit(env, { action: "brand_monitor_remove", userId, resourceType: "brand", resourceId: brandId, request });
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/brands/:id
export async function handleGetBrand(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const brand = await getBrandById(env, brandId);
    if (!brand) return attachBookmark(json({ success: false, error: "Brand not found" }, 404, origin), session);

    const [stats, providers] = await Promise.all([
      session.prepare(`
        SELECT COUNT(*) AS total_threats,
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_threats,
               SUM(CASE WHEN threat_type = 'phishing' THEN 1 ELSE 0 END) AS phishing,
               SUM(CASE WHEN threat_type = 'typosquatting' THEN 1 ELSE 0 END) AS typosquatting,
               SUM(CASE WHEN threat_type = 'impersonation' THEN 1 ELSE 0 END) AS impersonation,
               SUM(CASE WHEN threat_type = 'credential_harvesting' THEN 1 ELSE 0 END) AS credential,
               COUNT(DISTINCT CASE WHEN country_code IS NOT NULL AND country_code NOT IN ('XX','PRIV') THEN country_code END) AS countries,
               COUNT(DISTINCT hosting_provider_id) AS provider_count
        FROM threats WHERE target_brand_id = ?
      `).bind(brandId).first(),
      session.prepare(`
        SELECT hosting_provider_id AS provider_id, COUNT(*) AS count
        FROM threats WHERE target_brand_id = ? AND hosting_provider_id IS NOT NULL
        GROUP BY hosting_provider_id ORDER BY count DESC LIMIT 10
      `).bind(brandId).all(),
    ]);

    return attachBookmark(json({ success: true, data: { ...brand, stats, top_providers: providers.results } }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/:id/threats
export async function handleBrandThreats(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const threatType = url.searchParams.get("threat_type");
    const typeClause = threatType ? " AND threat_type = ?" : "";
    const typeBind: unknown[] = threatType ? [threatType] : [];

    const rows = await session.prepare(`
      SELECT id, threat_type, severity, status, malicious_domain, malicious_url,
             ip_address, country_code, hosting_provider_id, campaign_id,
             source_feed, confidence_score,
             first_seen, last_seen, created_at
      FROM threats WHERE target_brand_id = ?
        AND malicious_domain NOT IN (SELECT domain FROM brand_safe_domains WHERE brand_id = ?)
        ${typeClause}
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).bind(brandId, brandId, ...typeBind, limit, offset).all();

    // TODO: migrate to getThreatsByBrand() from db/threats.ts when safe-domain filtering is supported there
    const total = await session.prepare(
      `SELECT COUNT(*) AS n FROM threats WHERE target_brand_id = ?
         AND malicious_domain NOT IN (SELECT domain FROM brand_safe_domains WHERE brand_id = ?)
         ${typeClause}`
    ).bind(brandId, brandId, ...typeBind).first<{ n: number }>();

    return attachBookmark(json({ success: true, data: rows.results, total: total?.n ?? 0 }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/:id/threats/locations
export async function handleBrandThreatLocations(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const rows = await session.prepare(`
      SELECT country_code, COUNT(*) AS count,
             AVG(CAST(lat AS REAL)) AS lat, AVG(CAST(lng AS REAL)) AS lng
      FROM threats
      WHERE target_brand_id = ? AND country_code IS NOT NULL AND country_code NOT IN ('XX','PRIV')
      GROUP BY country_code
      ORDER BY count DESC
    `).bind(brandId).all();

    // Split into mappable (has lat/lng) and count-only
    const mappable = rows.results.filter((r: Record<string, unknown>) => r.lat != null && r.lng != null);
    const totalCountries = rows.results.length;

    return attachBookmark(json({ success: true, data: mappable, totalCountries }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/:id/threats/timeline
export async function handleBrandThreatTimeline(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? "7d";

    let bucket = "strftime('%Y-%m-%dT%H:00', created_at)";
    let since = "datetime('now', '-7 days')";
    if (period === "24h") { since = "datetime('now', '-1 day')"; }
    else if (period === "30d") { since = "datetime('now', '-30 days')"; bucket = "date(created_at)"; }
    else if (period === "90d") { since = "datetime('now', '-90 days')"; bucket = "date(created_at)"; }

    const rows = await session.prepare(`
      SELECT ${bucket} AS period, COUNT(*) AS count,
             SUM(CASE WHEN threat_type = 'phishing' THEN 1 ELSE 0 END) AS phishing,
             SUM(CASE WHEN threat_type = 'typosquatting' THEN 1 ELSE 0 END) AS typosquatting,
             SUM(CASE WHEN threat_type = 'impersonation' THEN 1 ELSE 0 END) AS impersonation
      FROM threats WHERE target_brand_id = ? AND created_at >= ${since}
      GROUP BY ${bucket} ORDER BY period ASC
    `).bind(brandId).all();

    // Reshape to {labels, values} for frontend chart compatibility
    const results = rows.results as Array<{ period: string; count: number; phishing: number; typosquatting: number; impersonation: number }>;
    const labels = results.map(r => r.period);
    const values = results.map(r => r.count);

    return attachBookmark(json({
      success: true,
      data: {
        labels,
        values,
        series: [
          { name: "Phishing", values: results.map(r => r.phishing) },
          { name: "Typosquatting", values: results.map(r => r.typosquatting) },
          { name: "Impersonation", values: results.map(r => r.impersonation) },
        ],
      },
    }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/:id/providers
export async function handleBrandProviders(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const rows = await session.prepare(`
      SELECT t.hosting_provider_id AS provider_id,
             COALESCE(hp.name, t.hosting_provider_id) AS name,
             COUNT(*) AS threat_count,
             SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active_count
      FROM threats t
      LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE t.target_brand_id = ? AND t.hosting_provider_id IS NOT NULL
      GROUP BY t.hosting_provider_id ORDER BY threat_count DESC LIMIT 20
    `).bind(brandId).all();

    return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/:id/campaigns
export async function handleBrandCampaigns(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const rows = await session.prepare(`
      SELECT DISTINCT c.id, c.name, c.status, c.threat_count, c.first_seen, c.last_seen
      FROM campaigns c
      JOIN threats t ON t.campaign_id = c.id
      WHERE t.target_brand_id = ?
      ORDER BY c.last_seen DESC
    `).bind(brandId).all();

    return attachBookmark(json({ success: true, data: rows.results }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// GET /api/brands/:id/analysis
export async function handleGetBrandAnalysis(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const brand = await getBrandById(env, brandId);
    if (!brand) return attachBookmark(json({ success: false, error: "Brand not found" }, 404, origin), session);

    // Return cached analysis if fresh (< 6 hours old)
    if (brand.threat_analysis && brand.analysis_updated_at) {
      const age = Date.now() - new Date(brand.analysis_updated_at).getTime();
      if (age < 6 * 60 * 60 * 1000) {
        const parsed = JSON.parse(brand.threat_analysis);
        return attachBookmark(json({ success: true, data: { ...parsed, cached: true, updated_at: brand.analysis_updated_at } }, 200, origin), session);
      }
    }

    return attachBookmark(json({
      success: true,
      data: brand.threat_analysis ? { ...JSON.parse(brand.threat_analysis), cached: true, stale: true, updated_at: brand.analysis_updated_at } : null,
    }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// POST /api/brands/:id/analysis — generate or refresh AI analysis
export async function handleGenerateBrandAnalysis(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brand = await getBrandById(env, brandId);
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    // Gather threat data for the brand
    const [stats, providerRows, campaignRows, domainRows] = await Promise.all([
      env.DB.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN threat_type = 'phishing' THEN 1 ELSE 0 END) AS phishing,
               SUM(CASE WHEN threat_type = 'typosquatting' THEN 1 ELSE 0 END) AS typosquatting,
               SUM(CASE WHEN threat_type = 'impersonation' THEN 1 ELSE 0 END) AS impersonation,
               SUM(CASE WHEN threat_type = 'credential_harvesting' THEN 1 ELSE 0 END) AS credential,
               SUM(CASE WHEN threat_type = 'malware_distribution' THEN 1 ELSE 0 END) AS malware
        FROM threats WHERE target_brand_id = ?
      `).bind(brandId).first<Record<string, number>>(),
      env.DB.prepare(`
        SELECT COALESCE(hp.name, t.hosting_provider_id) AS name
        FROM threats t LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
        WHERE t.target_brand_id = ? AND t.hosting_provider_id IS NOT NULL
        GROUP BY t.hosting_provider_id ORDER BY COUNT(*) DESC LIMIT 10
      `).bind(brandId).all<{ name: string }>(),
      env.DB.prepare(`
        SELECT DISTINCT c.name FROM campaigns c JOIN threats t ON t.campaign_id = c.id
        WHERE t.target_brand_id = ? ORDER BY c.threat_count DESC LIMIT 5
      `).bind(brandId).all<{ name: string }>(),
      env.DB.prepare(`
        SELECT DISTINCT malicious_domain FROM threats
        WHERE target_brand_id = ? AND malicious_domain IS NOT NULL LIMIT 10
      `).bind(brandId).all<{ malicious_domain: string }>(),
    ]);

    const threatTypes: Record<string, number> = {};
    if (stats) {
      for (const [k, v] of Object.entries(stats)) {
        if (k !== "total" && v > 0) threatTypes[k] = v;
      }
    }

    // Phase 3.3 of agent audit: brand-analysis is now a sync agent.
    // The agent owns input validation (sanitises brand name +
    // provider/domain/campaign lists), the AI call, output schema
    // validation, and a deterministic fallback. Handler stays
    // responsible for caching the result on the brands row.
    const agentRun = await runSyncAgent<BrandAnalysisOutput>(
      env,
      brandAnalysisAgent,
      {
        brandName: brand.name,
        threatCount: stats?.total ?? 0,
        providers: providerRows.results.map(r => r.name),
        domains: domainRows.results.map(r => r.malicious_domain),
        threatTypes,
        campaigns: campaignRows.results.map(r => r.name),
      },
    );

    if (agentRun.data) {
      // Persist in the same JSON shape the brand detail page already
      // expects (analysis / risk_level / key_findings — snake_case).
      const persisted = {
        analysis: agentRun.data.analysis,
        risk_level: agentRun.data.riskLevel,
        key_findings: agentRun.data.keyFindings,
      };
      await env.DB.prepare(
        "UPDATE brands SET threat_analysis = ?, analysis_updated_at = datetime('now') WHERE id = ?",
      ).bind(JSON.stringify(persisted), brandId).run();

      return json({
        success: true,
        data: { ...persisted, cached: false, updated_at: new Date().toISOString() },
      }, 200, origin);
    }

    return json({ success: false, error: agentRun.error ?? "Analysis generation failed" }, 500, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/brands/:id/deep-scan — AI-powered threat linking (user-triggered, costs tokens)
export async function handleBrandDeepScan(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brand = await getBrandById(env, brandId);
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    // Fetch up to 200 unlinked threats that haven't been AI-scored yet
    const unlinked = await env.DB.prepare(
      `SELECT id, malicious_url, malicious_domain FROM threats
       WHERE target_brand_id IS NULL
       ORDER BY created_at DESC LIMIT 200`
    ).all<{ id: string; malicious_url: string | null; malicious_domain: string | null }>();

    const threats = unlinked.results;
    if (!threats.length) {
      return json({ success: true, data: { scanned: 0, newly_linked: 0, message: "No unlinked threats to scan" } }, 200, origin);
    }

    // Phase 3.5 of agent audit: brand_deep_scan runs the entire
    // batch as one agent run (N internal AI calls, ONE agent_runs
    // row). The agent owns input validation, per-threat YES/NO
    // classification, and per-batch budget guard. Handler stays
    // responsible for D1 SQL — fetching unlinked threats and the
    // batch UPDATE on matches.
    const agentRun = await runSyncAgent<BrandDeepScanOutput>(
      env,
      brandDeepScanAgent,
      {
        brandName: brand.name,
        brandDomain: brand.canonical_domain,
        threats: threats.map((t) => ({
          id: t.id,
          url: t.malicious_url || t.malicious_domain || "",
        })).filter((t) => t.url.length > 0),
      },
    );

    const matchedIds = agentRun.data
      ? agentRun.data.matches.filter((m) => m.match).map((m) => m.id)
      : [];

    let newlyLinked = 0;
    if (matchedIds.length > 0) {
      // Batch update matched threats — single statement instead of N+1.
      // Chunked to stay under D1's bound-param limit (100 by default).
      const CHUNK = 80;
      for (let i = 0; i < matchedIds.length; i += CHUNK) {
        const chunk = matchedIds.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        await env.DB.prepare(
          `UPDATE threats SET target_brand_id = ? WHERE id IN (${placeholders})`
        ).bind(brandId, ...chunk).run();
      }
      newlyLinked = matchedIds.length;
    }

    // Update brand aggregate counts
    if (newlyLinked > 0) {
      await env.DB.prepare(
        `UPDATE brands SET
           threat_count = (SELECT COUNT(*) FROM threats WHERE target_brand_id = ?),
           last_threat_seen = (SELECT MAX(created_at) FROM threats WHERE target_brand_id = ?)
         WHERE id = ?`
      ).bind(brandId, brandId, brandId).run();
    }

    return json({ success: true, data: { scanned: threats.length, newly_linked: newlyLinked, message: newlyLinked > 0 ? `Found ${newlyLinked} additional threats` : "No new matches found" } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/brands/:id/clean-false-positives
export async function handleCleanFalsePositives(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { loadSafeDomainSet, isSafeDomain } = await import("../lib/safeDomains");
    const safeSet = await loadSafeDomainSet(env.DB);

    const threats = await env.DB.prepare(
      `SELECT id, malicious_domain FROM threats
       WHERE target_brand_id = ? AND status = 'active' AND malicious_domain IS NOT NULL`,
    ).bind(brandId).all<{ id: string; malicious_domain: string }>();

    // Collect IDs of safe-domain threats, then batch update in one statement.
    const safeIds = threats.results
      .filter(t => isSafeDomain(t.malicious_domain, safeSet))
      .map(t => t.id);

    if (safeIds.length > 0) {
      const placeholders = safeIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE threats SET status = 'remediated', confidence_score = 0 WHERE id IN (${placeholders})`
      ).bind(...safeIds).run();
    }

    return json({ success: true, data: { cleaned: safeIds.length, checked: threats.results.length } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Helpers ─────────────────────────────────────────────────

const SUPPORTED_PLATFORMS = ["twitter", "linkedin", "instagram", "tiktok", "github", "youtube"] as const;


// ─── PATCH /api/brands/:id/social-config — Update social monitoring config ───

export async function handleUpdateBrandSocialConfig(
  request: Request, env: Env, brandId: string, userId: string
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify brand exists and user has access (via monitored_brands or admin)
    const brand = await getBrandById(env, brandId);
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    const ownership = await env.DB.prepare(
      "SELECT brand_id FROM monitored_brands WHERE brand_id = ?"
    ).bind(brandId).first();
    const userRow = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first<{ role: string }>();
    const isAdmin = userRow?.role === "admin" || userRow?.role === "super_admin";

    if (!ownership && !isAdmin) {
      return json({ success: false, error: "Brand not in your monitored list" }, 403, origin);
    }

    const body = await request.json().catch(() => null) as {
      official_handles?: Record<string, string>;
      aliases?: string[];
      brand_keywords?: string[];
      executive_names?: string[];
      logo_url?: string;
      website_url?: string;
      monitoring_tier?: string;
    } | null;

    if (!body) return json({ success: false, error: "Request body is required" }, 400, origin);

    const VALID_TIERS = ["scan", "professional", "business", "enterprise"];

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.official_handles !== undefined) {
      // Validate platforms
      for (const platform of Object.keys(body.official_handles)) {
        if (!SUPPORTED_PLATFORMS.includes(platform as typeof SUPPORTED_PLATFORMS[number])) {
          return json({ success: false, error: `Unsupported platform: ${platform}` }, 400, origin);
        }
      }
      updates.push("official_handles = ?");
      values.push(JSON.stringify(body.official_handles));
    }
    if (body.aliases !== undefined) {
      updates.push("aliases = ?");
      values.push(JSON.stringify(body.aliases));
    }
    if (body.brand_keywords !== undefined) {
      updates.push("brand_keywords = ?");
      values.push(JSON.stringify(body.brand_keywords));
    }
    if (body.executive_names !== undefined) {
      updates.push("executive_names = ?");
      values.push(JSON.stringify(body.executive_names));
    }
    if (body.logo_url !== undefined) {
      updates.push("logo_url = ?");
      values.push(body.logo_url);
    }
    if (body.website_url !== undefined) {
      updates.push("website_url = ?");
      values.push(body.website_url);
    }
    if (body.monitoring_tier !== undefined) {
      if (!VALID_TIERS.includes(body.monitoring_tier)) {
        return json({ success: false, error: `Invalid monitoring_tier: ${body.monitoring_tier}` }, 400, origin);
      }
      updates.push("monitoring_tier = ?");
      values.push(body.monitoring_tier);
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No fields to update" }, 400, origin);
    }

    values.push(brandId);
    await env.DB.prepare(
      `UPDATE brands SET ${updates.join(", ")} WHERE id = ?`
    ).bind(...values).run();

    // Upsert brand_monitor_schedule entries for each platform with a handle
    if (body.official_handles) {
      for (const platform of Object.keys(body.official_handles)) {
        const handle = body.official_handles[platform];
        if (handle) {
          const schedId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO brand_monitor_schedule (id, brand_id, monitor_type, platform, check_interval_hours, enabled)
            VALUES (?, ?, 'social', ?, 24, 1)
            ON CONFLICT (brand_id, monitor_type, platform) DO UPDATE SET enabled = 1
          `).bind(schedId, brandId, platform).run();
        }
      }
    }

    await audit(env, {
      action: "brand_social_config_update",
      userId,
      resourceType: "brand",
      resourceId: brandId,
      details: { fields: Object.keys(body) },
      request,
    });

    const updated = await env.DB.prepare(
      `SELECT id, name, canonical_domain, official_handles, aliases, brand_keywords,
              executive_names, logo_url, website_url, monitoring_tier, monitoring_status,
              social_risk_score, domain_risk_score, email_grade, exposure_score,
              last_social_scan, next_social_scan
       FROM brands WHERE id = ?`
    ).bind(brandId).first();

    return json({ success: true, data: updated }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/brands/:id/social-config — Get social monitoring config ───

export async function handleGetBrandSocialConfig(
  request: Request, env: Env, brandId: string, userId: string
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const brand = await session.prepare(
      `SELECT id, name, canonical_domain, official_handles, aliases, brand_keywords,
              executive_names, logo_url, website_url, monitoring_tier, monitoring_status,
              social_risk_score, domain_risk_score, email_grade, exposure_score,
              last_social_scan, next_social_scan
       FROM brands WHERE id = ?`
    ).bind(brandId).first();

    if (!brand) return attachBookmark(json({ success: false, error: "Brand not found" }, 404, origin), session);

    // Fetch social_profiles for this brand
    const profiles = await session.prepare(
      "SELECT * FROM social_profiles WHERE brand_id = ? ORDER BY platform, handle"
    ).bind(brandId).all();

    // Fetch brand_monitor_schedule entries
    const schedule = await session.prepare(
      "SELECT * FROM brand_monitor_schedule WHERE brand_id = ? ORDER BY monitor_type, platform"
    ).bind(brandId).all();

    return attachBookmark(json({
      success: true,
      data: {
        ...brand,
        social_profiles: profiles.results,
        schedule: schedule.results,
      },
    }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── GET /api/brands/:id/social-profiles — Paginated social profiles ───

export async function handleGetBrandSocialProfiles(
  request: Request, env: Env, brandId: string, userId: string
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const ctx = getDbContext(request);
  const session = getReadSession(env, ctx);
  try {
    const brand = await getBrandById(env, brandId);
    if (!brand) return attachBookmark(json({ success: false, error: "Brand not found" }, 404, origin), session);

    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");
    const classification = url.searchParams.get("classification");
    const status = url.searchParams.get("status");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    let where = "WHERE brand_id = ?";
    const params: unknown[] = [brandId];

    if (platform) { where += " AND platform = ?"; params.push(platform); }
    if (classification) { where += " AND classification = ?"; params.push(classification); }
    if (status) { where += " AND status = ?"; params.push(status); }

    const [rows, countRow, classificationCounts, severityCounts] = await Promise.all([
      session.prepare(`
        SELECT * FROM social_profiles ${where}
        ORDER BY
          CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 4 END,
          created_at DESC
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset).all(),
      session.prepare(
        `SELECT COUNT(*) AS n FROM social_profiles ${where}`
      ).bind(...params).first<{ n: number }>(),
      session.prepare(
        "SELECT classification, COUNT(*) AS count FROM social_profiles WHERE brand_id = ? GROUP BY classification"
      ).bind(brandId).all(),
      session.prepare(
        "SELECT severity, COUNT(*) AS count FROM social_profiles WHERE brand_id = ? AND status = 'active' GROUP BY severity"
      ).bind(brandId).all(),
    ]);

    const classificationMap: Record<string, number> = {};
    for (const r of classificationCounts.results) {
      classificationMap[r.classification as string] = r.count as number;
    }
    const severityMap: Record<string, number> = {};
    for (const r of severityCounts.results) {
      severityMap[r.severity as string] = r.count as number;
    }

    return attachBookmark(json({
      success: true,
      data: rows.results,
      total: countRow?.n ?? 0,
      aggregates: {
        by_classification: classificationMap,
        by_severity: severityMap,
      },
    }, 200, origin), session);
  } catch (err) {
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}

// ─── PATCH /api/brands/:id/social-profiles/:profileId — Classify a social profile ───

export async function handleClassifySocialProfile(
  request: Request, env: Env, brandId: string, profileId: string, userId: string
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const profile = await env.DB.prepare(
      "SELECT id, brand_id, status FROM social_profiles WHERE id = ? AND brand_id = ?"
    ).bind(profileId, brandId).first();

    if (!profile) return json({ success: false, error: "Social profile not found" }, 404, origin);

    const body = await request.json().catch(() => null) as {
      classification?: string;
      status?: string;
    } | null;

    if (!body) return json({ success: false, error: "Request body is required" }, 400, origin);

    const VALID_CLASSIFICATIONS = ["official", "legitimate", "suspicious", "impersonation", "parked", "unknown"];
    const VALID_STATUSES = ["active", "resolved", "false_positive", "takedown_requested", "taken_down"];

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.classification !== undefined) {
      if (!VALID_CLASSIFICATIONS.includes(body.classification)) {
        return json({ success: false, error: `Invalid classification: ${body.classification}` }, 400, origin);
      }
      updates.push("classification = ?");
      values.push(body.classification);
      updates.push("classified_by = ?");
      values.push(userId);
    }

    if (body.status !== undefined) {
      if (!VALID_STATUSES.includes(body.status)) {
        return json({ success: false, error: `Invalid status: ${body.status}` }, 400, origin);
      }
      updates.push("status = ?");
      values.push(body.status);

      if (body.status === "false_positive" || body.status === "resolved") {
        updates.push("resolved_by = ?");
        values.push(userId);
        updates.push("resolved_at = datetime('now')");
      }
      if (body.status === "takedown_requested") {
        updates.push("takedown_requested_at = datetime('now')");
      }
      if (body.status === "taken_down") {
        updates.push("taken_down_at = datetime('now')");
      }
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No fields to update" }, 400, origin);
    }

    updates.push("updated_at = datetime('now')");
    values.push(profileId, brandId);

    await env.DB.prepare(
      `UPDATE social_profiles SET ${updates.join(", ")} WHERE id = ? AND brand_id = ?`
    ).bind(...values).run();

    await audit(env, {
      action: "social_profile_classify",
      userId,
      resourceType: "social_profile",
      resourceId: profileId,
      details: { brand_id: brandId, classification: body.classification, status: body.status },
      request,
    });

    const updated = await env.DB.prepare(
      "SELECT * FROM social_profiles WHERE id = ?"
    ).bind(profileId).first();

    return json({ success: true, data: updated }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/brands/:id/discover-social — Auto-discover social links from website ───

export async function handleDiscoverSocialLinks(
  request: Request, env: Env, brandId: string, userId: string
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brand = await getBrandById(env, brandId);
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    // Verify user monitors this brand or is admin
    const monitored = await env.DB.prepare(
      "SELECT 1 FROM monitored_brands WHERE brand_id = ? AND added_by = ?"
    ).bind(brandId, userId).first();
    const isAdmin = await env.DB.prepare(
      "SELECT 1 FROM users WHERE id = ? AND role IN ('admin', 'super_admin')"
    ).bind(userId).first();

    if (!monitored && !isAdmin) {
      return json({ success: false, error: "Not authorized for this brand" }, 403, origin);
    }

    const domain = brand.canonical_domain;
    let discovered = await discoverSocialProfiles(`https://${domain}`);

    // If primary domain fails, try www variant
    if (discovered.length === 0) {
      discovered = await discoverSocialProfiles(`https://www.${domain}`);
    }

    // Store discovered profiles
    let newProfilesCreated = 0;
    const handlesUpdate: Record<string, string> = {};

    for (const profile of discovered) {
      const profileId = crypto.randomUUID();

      const result = await env.DB.prepare(`
        INSERT INTO social_profiles
          (id, brand_id, platform, handle, profile_url, classification,
           classified_by, classification_confidence, status, last_checked)
        VALUES (?, ?, ?, ?, ?, 'official', 'auto_discovery', ?, 'active', datetime('now'))
        ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
          last_checked = datetime('now'),
          profile_url = excluded.profile_url
      `).bind(
        profileId, brand.id, profile.platform, profile.handle,
        profile.profileUrl, profile.confidence
      ).run();

      if (result.meta?.changes && result.meta.changes > 0) {
        newProfilesCreated++;
      }

      if (!handlesUpdate[profile.platform]) {
        handlesUpdate[profile.platform] = profile.handle;
      }
    }

    // Merge with existing handles (user input takes priority)
    const existingHandles = brand.official_handles
      ? JSON.parse(brand.official_handles) : {};
    const merged = { ...handlesUpdate, ...existingHandles };

    await env.DB.prepare(
      "UPDATE brands SET official_handles = ?, website_url = COALESCE(website_url, ?) WHERE id = ?"
    ).bind(JSON.stringify(merged), `https://${domain}`, brand.id).run();

    // Create monitor schedule entries for newly discovered platforms
    for (const platform of Object.keys(handlesUpdate)) {
      if (!existingHandles[platform]) {
        const schedId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO brand_monitor_schedule (id, brand_id, monitor_type, platform, check_interval_hours, enabled)
          VALUES (?, ?, 'social', ?, 24, 1)
          ON CONFLICT (brand_id, monitor_type, platform) DO UPDATE SET enabled = 1
        `).bind(schedId, brand.id, platform).run();
      }
    }

    await audit(env, {
      action: "brand_social_discovery",
      userId,
      resourceType: "brand",
      resourceId: brand.id,
      details: {
        domain,
        discovered: discovered.length,
        new_profiles: newProfilesCreated,
        platforms: [...new Set(discovered.map(d => d.platform))],
      },
      request,
    });

    logger.info("brand_social_discovery", {
      brand_id: brand.id, domain,
      discovered: discovered.length,
      new_profiles: newProfilesCreated,
      platforms: [...new Set(discovered.map(d => d.platform))],
    });

    return json({
      success: true,
      data: {
        discovered,
        new_profiles_created: newProfilesCreated,
        handles_updated: merged,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/brands/:id/social-profiles/:profileId/assess — On-demand AI re-assessment ───

export async function handleReassessSocialProfile(
  request: Request, env: Env, brandId: string, profileId: string, userId: string
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const profile = await env.DB.prepare(
      "SELECT * FROM social_profiles WHERE id = ? AND brand_id = ?"
    ).bind(profileId, brandId).first<{
      id: string; brand_id: string; platform: string; handle: string;
      profile_url: string | null; display_name: string | null; bio: string | null;
      followers_count: number | null; verified: number;
    }>();

    if (!profile) return json({ success: false, error: "Social profile not found" }, 404, origin);

    const brand = await getBrandById(env, brandId);
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    // Verify authorization
    const monitored = await env.DB.prepare(
      "SELECT 1 FROM monitored_brands WHERE brand_id = ? AND added_by = ?"
    ).bind(brandId, userId).first();
    const isAdmin = await env.DB.prepare(
      "SELECT 1 FROM users WHERE id = ? AND role IN ('admin', 'super_admin')"
    ).bind(userId).first();

    if (!monitored && !isAdmin) {
      return json({ success: false, error: "Not authorized for this brand" }, 403, origin);
    }

    // Gather cross-reference data
    const threats = await env.DB.prepare(
      "SELECT malicious_url, threat_type FROM threats WHERE target_brand_id = ? AND status = 'active' LIMIT 5"
    ).bind(brand.id).all<{ malicious_url: string; threat_type: string }>();

    const emailGrade = await env.DB.prepare(
      "SELECT grade FROM email_security_posture WHERE domain = ? ORDER BY scanned_at DESC LIMIT 1"
    ).bind(brand.canonical_domain).first<{ grade: string }>();

    const campaigns = await env.DB.prepare(
      "SELECT c.name FROM campaigns c JOIN threats t ON t.campaign_id = c.id WHERE t.target_brand_id = ? AND c.status = 'active' LIMIT 3"
    ).bind(brand.id).all<{ name: string }>();

    const lookalikes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lookalike_domains WHERE brand_id = ? AND status = 'active'"
    ).bind(brand.id).first<{ n: number }>();

    const otherSuspicious = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM social_profiles WHERE brand_id = ? AND classification IN ('suspicious','impersonation') AND status = 'active' AND id != ?"
    ).bind(brand.id, profileId).first<{ n: number }>();

    let brandAliases: string[] = [];
    let brandKeywords: string[] = [];
    let officialHandles: Record<string, string> = {};
    try { if (brand.aliases) brandAliases = JSON.parse(brand.aliases); } catch { /* */ }
    try { if (brand.brand_keywords) brandKeywords = JSON.parse(brand.brand_keywords); } catch { /* */ }
    try { if (brand.official_handles) officialHandles = JSON.parse(brand.official_handles); } catch { /* */ }

    const agentInput: SocialAiAssessorInput = {
      brandName: brand.name,
      brandDomain: brand.canonical_domain,
      brandAliases,
      brandKeywords,
      officialHandles,
      platform: profile.platform,
      handle: profile.handle,
      profileUrl: profile.profile_url || '',
      displayName: profile.display_name || null,
      bio: profile.bio || null,
      followersCount: profile.followers_count ?? null,
      verified: !!profile.verified,
      accountCreated: null,
      existingThreats: threats.results.map(t => `${t.threat_type}: ${t.malicious_url}`).slice(0, 10),
      emailSecurityGrade: emailGrade?.grade || null,
      activeCampaigns: campaigns.results.map(c => c.name).slice(0, 10),
      lookalikeDomainsFound: lookalikes?.n || 0,
      otherImpersonationProfiles: otherSuspicious?.n || 0,
    };

    const { data: assessment } = await runSyncAgent<SocialAiAssessorOutput>(env, socialAiAssessorAgent, agentInput);
    if (!assessment) {
      return json({ success: false, error: "AI assessment unavailable" }, 503, origin);
    }

    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE social_profiles SET
        ai_assessment = ?,
        ai_confidence = ?,
        ai_action = ?,
        ai_evidence_draft = ?,
        classification = CASE
          WHEN classified_by = 'manual' THEN classification
          ELSE ?
        END,
        classification_confidence = CASE
          WHEN classified_by = 'manual' THEN classification_confidence
          ELSE ?
        END,
        classification_reason = ?,
        impersonation_signals = ?,
        severity = CASE
          WHEN ? >= 0.9 THEN 'CRITICAL'
          WHEN ? >= 0.7 THEN 'HIGH'
          WHEN ? >= 0.4 THEN 'MEDIUM'
          ELSE 'LOW'
        END,
        ai_assessed_at = ?,
        updated_at = ?
      WHERE id = ? AND brand_id = ?
    `).bind(
      assessment.reasoning,
      assessment.confidence,
      assessment.action,
      assessment.evidenceDraft,
      assessment.classification,
      assessment.confidence,
      assessment.reasoning,
      JSON.stringify([...assessment.signals, ...assessment.crossCorrelations]),
      assessment.confidence, assessment.confidence, assessment.confidence,
      now,
      now,
      profileId, brandId,
    ).run();

    await audit(env, {
      action: "social_profile_ai_reassess",
      userId,
      resourceType: "social_profile",
      resourceId: profileId,
      details: {
        brand_id: brandId,
        classification: assessment.classification,
        confidence: assessment.confidence,
        action: assessment.action,
      },
      request,
    });

    const updated = await env.DB.prepare(
      "SELECT * FROM social_profiles WHERE id = ?"
    ).bind(profileId).first();

    return json({
      success: true,
      data: {
        profile: updated,
        assessment: {
          classification: assessment.classification,
          confidence: assessment.confidence,
          action: assessment.action,
          reasoning: assessment.reasoning,
          evidenceDraft: assessment.evidenceDraft,
          signals: assessment.signals,
          crossCorrelations: assessment.crossCorrelations,
        },
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/brands/:id/compute-score
export async function handleComputeBrandScore(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify brand exists
    const brand = await getBrandById(env, brandId);
    if (!brand) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    const result = await computeBrandExposureScore(env, brandId);

    return json({
      success: true,
      data: {
        brand_id: brandId,
        brand_name: brand.name,
        email_grade: brand.email_security_grade,
        ...result,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
