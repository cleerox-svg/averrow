// Averrow — Internet bot traffic (Cloudflare Radar)
//
// GET /api/bot-traffic?days=7|30|90  (staff; default 30)
//
// Reads bot_traffic_snapshots (migration 0290) and radar_country_snapshots
// (migration 0292), both written once a day by the cf_radar_bots feed
// (feeds/cf_radar_bots.ts). Small tables (≈2 rows/day for bot_share,
// ≈35 rows/day for the ranked bot metrics, ≤120 rows/day for the country
// metrics); every query is served by the (metric, snapshot_date) index or
// the PK. KV-cached 1h; the feed drops these keys after each successful write.

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { botTrafficCacheKey, type BotDensityBound } from "../feeds/cf_radar_bots";
import type { Env } from "../types";

const ALLOWED_DAYS = new Set([7, 30, 90]);
const DEFAULT_DAYS = 30;
const CACHE_TTL_S = 3600;
const FEED_NAME = "cf_radar_bots";

export interface BotTrafficData {
  source: "cloudflare_radar";
  latest: { snapshot_date: string; bot_pct: number; human_pct: number; fetched_at: string } | null;
  series: Array<{ date: string; bot_pct: number; human_pct: number }>;
  top_locations: Array<{ code: string; name: string; pct: number; rank: number }>;
  top_asns: Array<{ asn: number; name: string; pct: number; rank: number }>;
  categories: Array<{ category: string; pct: number }>;
  /** Top countries by share (%) of all layer-7 attacks, origin = client IP country (7d window). */
  attack_origins: Array<{ code: string; name: string; pct: number; rank: number }>;
  /** Top countries by share (%) of all layer-7 attacks, target = attacked zone's billing country (7d window). */
  attack_targets: Array<{ code: string; name: string; pct: number; rank: number }>;
  /**
   * Every stored country (≤100) ranked by bot_pct desc: bot_pct = % of the
   * country's own HTTP traffic that is likely automated, traffic_pct = its
   * share (%) of all HTTP traffic. Consumers slice their own top-N.
   * bound: null = exact (country in both Radar top-100 lists); 'lower' /
   * 'upper' = bot_pct is a lower / upper bound (country in only the bot /
   * human list) and traffic_pct is a midpoint estimate.
   */
  bot_density: Array<{
    code: string;
    name: string;
    bot_pct: number;
    traffic_pct: number;
    bound: BotDensityBound | null;
    rank: number;
  }>;
  /**
   * Global bot share (%) on as_of.bot_density's snapshot_date — the same
   * day the density rows were derived from — so countries compare against
   * a matching baseline. null when no density rows or no bot_share row
   * for that date.
   */
  bot_density_global_pct: number | null;
  last_fetch: { status: string | null; last_success_at: string | null; last_error: string | null };
  /**
   * The snapshot_date (YYYY-MM-DD) each section was read from. Each ranked
   * section reads its own metric's latest date, so after a partial pull
   * they can differ from bot_share (= latest.snapshot_date). null = no rows.
   */
  as_of: {
    bot_share: string | null;
    top_locations: string | null;
    top_asns: string | null;
    categories: string | null;
    attack_origins: string | null;
    attack_targets: string | null;
    bot_density: string | null;
  };
}

const SQLITE_TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]00:?00)?$/;

/**
 * Normalise a SQLite `datetime('now')` value (`YYYY-MM-DD HH:MM:SS`, UTC)
 * — or an ISO-8601 UTC string — to `YYYY-MM-DDTHH:MM:SSZ`. Anything else
 * (null, unexpected format) is returned unchanged.
 */
export function toIsoUtc(ts: string | null): string | null {
  if (ts === null) return null;
  const m = SQLITE_TS_RE.exec(ts.trim());
  return m ? `${m[1]}T${m[2]}Z` : ts;
}

/** `null` → invalid (400). Absent → default 30. */
export function parseBotTrafficDays(raw: string | null): number | null {
  if (raw === null || raw === "") return DEFAULT_DAYS;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return ALLOWED_DAYS.has(n) ? n : null;
}

interface ShareRow { snapshot_date: string; dim_key: string; value_pct: number; fetched_at: string }
interface RankedRow { snapshot_date: string; dim_key: string; label: string | null; rank: number | null; value_pct: number }
interface CountryRow {
  snapshot_date: string;
  country_code: string;
  label: string | null;
  rank: number | null;
  value_pct: number;
  traffic_pct: number | null;
  bound: string | null;
}

function toBound(v: string | null): BotDensityBound | null {
  return v === "lower" || v === "upper" ? v : null;
}

/** Pivot bot/human rows into one entry per date (ascending). Missing side = complement. */
export function pivotBotShare(rows: ShareRow[]): Array<{ date: string; bot_pct: number; human_pct: number; fetched_at: string }> {
  const byDate = new Map<string, { bot: number | null; human: number | null; fetched_at: string }>();
  for (const r of rows) {
    const e = byDate.get(r.snapshot_date) ?? { bot: null, human: null, fetched_at: r.fetched_at };
    if (r.dim_key === "bot") e.bot = r.value_pct;
    else if (r.dim_key === "human") e.human = r.value_pct;
    if (r.fetched_at > e.fetched_at) e.fetched_at = r.fetched_at;
    byDate.set(r.snapshot_date, e);
  }
  const out: Array<{ date: string; bot_pct: number; human_pct: number; fetched_at: string }> = [];
  for (const [date, e] of byDate) {
    if (e.bot === null && e.human === null) continue;
    const bot = e.bot ?? Math.max(0, 100 - (e.human as number));
    const human = e.human ?? Math.max(0, 100 - bot);
    out.push({ date, bot_pct: bot, human_pct: human, fetched_at: e.fetched_at });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const RANKED_SQL = `
  SELECT snapshot_date, dim_key, label, rank, value_pct
    FROM bot_traffic_snapshots
   WHERE metric = ?1
     AND snapshot_date = (SELECT MAX(snapshot_date) FROM bot_traffic_snapshots WHERE metric = ?1)
   ORDER BY rank ASC, value_pct DESC`;

const COUNTRY_SQL = `
  SELECT snapshot_date, country_code, label, rank, value_pct, traffic_pct, bound
    FROM radar_country_snapshots
   WHERE metric = ?1
     AND snapshot_date = (SELECT MAX(snapshot_date) FROM radar_country_snapshots WHERE metric = ?1)
   ORDER BY rank ASC, value_pct DESC`;

function toCountryShare(rows: CountryRow[]): Array<{ code: string; name: string; pct: number; rank: number }> {
  return rows.map((r, i) => ({
    code: r.country_code,
    name: r.label ?? r.country_code,
    pct: r.value_pct,
    rank: r.rank ?? i + 1,
  }));
}

async function loadBotTraffic(session: D1DatabaseSession, days: number): Promise<BotTrafficData> {
  const [
    seriesRes, latestRes, locRes, asnRes, catRes, statusRow, pullRow,
    originRes, targetRes, densityRes, densityShareRes,
  ] = await Promise.all([
    session.prepare(
      `SELECT snapshot_date, dim_key, value_pct, fetched_at
         FROM bot_traffic_snapshots
        WHERE metric = 'bot_share'
          AND snapshot_date > date('now', ?)
        ORDER BY snapshot_date ASC`,
    ).bind(`-${days} days`).all<ShareRow>(),
    // Latest independently of the window, so a stalled feed still shows
    // its last known value rather than null.
    session.prepare(
      `SELECT snapshot_date, dim_key, value_pct, fetched_at
         FROM bot_traffic_snapshots
        WHERE metric = 'bot_share'
          AND snapshot_date = (SELECT MAX(snapshot_date) FROM bot_traffic_snapshots WHERE metric = 'bot_share')`,
    ).all<ShareRow>(),
    session.prepare(RANKED_SQL).bind("top_location").all<RankedRow>(),
    session.prepare(RANKED_SQL).bind("top_asn").all<RankedRow>(),
    session.prepare(RANKED_SQL).bind("bot_category").all<RankedRow>(),
    session.prepare(
      "SELECT last_successful_pull, last_error FROM feed_status WHERE feed_name = ?",
    ).bind(FEED_NAME).first<{ last_successful_pull: string | null; last_error: string | null }>(),
    // Latest FINISHED pull — an in-flight row sits at status='partial'
    // with completed_at NULL (runFeed seeds it that way).
    session.prepare(
      `SELECT status FROM feed_pull_history
        WHERE feed_name = ? AND completed_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
    ).bind(FEED_NAME).first<{ status: string }>(),
    session.prepare(COUNTRY_SQL).bind("attack_origin").all<CountryRow>(),
    session.prepare(COUNTRY_SQL).bind("attack_target").all<CountryRow>(),
    session.prepare(COUNTRY_SQL).bind("bot_density").all<CountryRow>(),
    // bot_share for the bot_density snapshot date (both dims, pivoted like
    // `latest` so a lone human row still yields the complement).
    session.prepare(
      `SELECT snapshot_date, dim_key, value_pct, fetched_at
         FROM bot_traffic_snapshots
        WHERE metric = 'bot_share'
          AND snapshot_date = (SELECT MAX(snapshot_date) FROM radar_country_snapshots WHERE metric = 'bot_density')`,
    ).all<ShareRow>(),
  ]);

  // bot_density is stored ranked by bot_pct desc; re-sort defensively and
  // drop any row without traffic_pct (every writer sets it for this metric).
  const density = densityRes.results
    .filter((r): r is CountryRow & { traffic_pct: number } => r.traffic_pct !== null)
    .sort((a, b) => b.value_pct - a.value_pct || b.traffic_pct - a.traffic_pct)
    .map((r, i) => ({
      code: r.country_code,
      name: r.label ?? r.country_code,
      bot_pct: r.value_pct,
      traffic_pct: r.traffic_pct,
      bound: toBound(r.bound),
      rank: i + 1,
    }));
  const densityShare = pivotBotShare(densityShareRes.results)[0];

  const latestPivot = pivotBotShare(latestRes.results)[0];

  return {
    source: "cloudflare_radar",
    latest: latestPivot
      ? {
          snapshot_date: latestPivot.date,
          bot_pct: latestPivot.bot_pct,
          human_pct: latestPivot.human_pct,
          fetched_at: toIsoUtc(latestPivot.fetched_at) ?? latestPivot.fetched_at,
        }
      : null,
    series: pivotBotShare(seriesRes.results).map(({ date, bot_pct, human_pct }) => ({ date, bot_pct, human_pct })),
    top_locations: locRes.results.map((r, i) => ({
      code: r.dim_key,
      name: r.label ?? r.dim_key,
      pct: r.value_pct,
      rank: r.rank ?? i + 1,
    })),
    top_asns: asnRes.results
      .map((r, i) => ({
        asn: parseInt(r.dim_key, 10),
        name: r.label ?? `AS${r.dim_key}`,
        pct: r.value_pct,
        rank: r.rank ?? i + 1,
      }))
      .filter((r) => Number.isFinite(r.asn)),
    categories: catRes.results
      .map((r) => ({ category: r.dim_key, pct: r.value_pct }))
      .sort((a, b) => b.pct - a.pct),
    attack_origins: toCountryShare(originRes.results),
    attack_targets: toCountryShare(targetRes.results),
    bot_density: density,
    bot_density_global_pct: densityShare?.bot_pct ?? null,
    last_fetch: {
      status: pullRow?.status ?? null,
      last_success_at: toIsoUtc(statusRow?.last_successful_pull ?? null),
      last_error: statusRow?.last_error ?? null,
    },
    as_of: {
      bot_share: latestPivot?.date ?? null,
      top_locations: locRes.results[0]?.snapshot_date ?? null,
      top_asns: asnRes.results[0]?.snapshot_date ?? null,
      categories: catRes.results[0]?.snapshot_date ?? null,
      attack_origins: originRes.results[0]?.snapshot_date ?? null,
      attack_targets: targetRes.results[0]?.snapshot_date ?? null,
      bot_density: densityRes.results[0]?.snapshot_date ?? null,
    },
  };
}

// GET /api/bot-traffic
export async function handleBotTraffic(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const days = parseBotTrafficDays(new URL(request.url).searchParams.get("days"));
  if (days === null) {
    return json({ success: false, error: "days must be one of 7, 30, 90" }, 400, origin);
  }

  const cacheKey = botTrafficCacheKey(days);
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      return json({ success: true, data: JSON.parse(cached) as BotTrafficData }, 200, origin);
    }
  } catch {
    // KV transient — fall through to D1.
  }

  const session = getReadSession(env, getDbContext(request));
  try {
    const data = await loadBotTraffic(session, days);
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL_S });
    } catch {
      // Non-fatal: serve uncached.
    }
    return attachBookmark(json({ success: true, data }, 200, origin), session);
  } catch (err) {
    console.error("[bot-traffic] query failed:", err);
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
