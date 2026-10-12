// Averrow — Internet bot traffic (Cloudflare Radar)
//
// GET /api/bot-traffic?days=7|30|90  (staff; default 30)
//
// Reads bot_traffic_snapshots (migration 0290), written once a day by the
// cf_radar_bots feed (feeds/cf_radar_bots.ts). Small table (≈2 rows/day
// for bot_share + ≈35 rows/day for the ranked metrics), every query is
// served by the (metric, snapshot_date) index or the PK. KV-cached 1h; the
// feed drops these keys after each successful write.

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { botTrafficCacheKey } from "../feeds/cf_radar_bots";
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
  last_fetch: { status: string | null; last_success_at: string | null; last_error: string | null };
}

/** `null` → invalid (400). Absent → default 30. */
export function parseBotTrafficDays(raw: string | null): number | null {
  if (raw === null || raw === "") return DEFAULT_DAYS;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return ALLOWED_DAYS.has(n) ? n : null;
}

interface ShareRow { snapshot_date: string; dim_key: string; value_pct: number; fetched_at: string }
interface RankedRow { dim_key: string; label: string | null; rank: number | null; value_pct: number }

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
  SELECT dim_key, label, rank, value_pct
    FROM bot_traffic_snapshots
   WHERE metric = ?1
     AND snapshot_date = (SELECT MAX(snapshot_date) FROM bot_traffic_snapshots WHERE metric = ?1)
   ORDER BY rank ASC, value_pct DESC`;

async function loadBotTraffic(session: D1DatabaseSession, days: number): Promise<BotTrafficData> {
  const [seriesRes, latestRes, locRes, asnRes, catRes, statusRow, pullRow] = await Promise.all([
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
  ]);

  const latestPivot = pivotBotShare(latestRes.results)[0];

  return {
    source: "cloudflare_radar",
    latest: latestPivot
      ? {
          snapshot_date: latestPivot.date,
          bot_pct: latestPivot.bot_pct,
          human_pct: latestPivot.human_pct,
          fetched_at: latestPivot.fetched_at,
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
    last_fetch: {
      status: pullRow?.status ?? null,
      last_success_at: statusRow?.last_successful_pull ?? null,
      last_error: statusRow?.last_error ?? null,
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
