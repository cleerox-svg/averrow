import type { FeedModule, FeedContext, FeedResult } from "./types";

/**
 * Cloudflare Radar — Internet bot traffic (feed key `cf_radar_bots`).
 *
 * Daily pull of five Radar endpoints into `bot_traffic_snapshots`
 * (migration 0290), served by GET /api/bot-traffic:
 *
 *   1. /radar/http/summary/BOT_CLASS            → bot_share (latest 24h)   REQUIRED
 *   2. /radar/http/timeseries_groups/BOT_CLASS  → bot_share 28d backfill   optional
 *   3. /radar/http/top/locations?botClass=…     → top_location              optional
 *   4. /radar/http/top/ases?botClass=…          → top_asn                   optional
 *   5. /radar/bots/summary/BOT_CATEGORY         → bot_category              optional
 *
 * Failure contract:
 *   - Missing CF_API_TOKEN, or HTTP 401/403 from ANY endpoint → throw, so
 *     runFeed records a failed pull (never a quiet success).
 *   - #1 failing for any reason → throw.
 *   - #2–#5 failing → the rest is still written; each failed endpoint
 *     counts as one itemsError (surfaces as records_rejected).
 *
 * Never writes `threats`, and always returns itemsNew = 0 so the
 * orchestrator's Sentinel trigger (runAllFeeds totalNew > 0) is untouched.
 *
 * `limitPerGroup` is deliberately NOT sent on #5: the SDK documents it as
 * "only supported on high-cardinality dimensions; otherwise the request is
 * rejected", and BOT_CATEGORY is low-cardinality.
 */

const RADAR_BASE = "https://api.cloudflare.com/client/v4/radar";
const FETCH_TIMEOUT_MS = 15_000;

/** Cache keys the read handler populates — dropped after a successful write. */
export const BOT_TRAFFIC_CACHE_DAYS = [7, 30, 90] as const;
export function botTrafficCacheKey(days: number): string {
  return `bot_traffic:v1:${days}`;
}

// ─── Parsed shapes ───────────────────────────────────────────────

export interface BotShare {
  bot_pct: number;
  human_pct: number;
}

export interface BotShareDay extends BotShare {
  date: string; // YYYY-MM-DD
}

export interface RankedDim {
  dim_key: string;
  label: string | null;
  rank: number;
  value_pct: number;
}

// ─── Pure parsing helpers (exported for tests) ──────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Radar returns percentages as strings; accept numbers too. NaN → null. */
export function parsePct(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

type BotClassKey = "bot" | "human";

/** Map a Radar bot-class key (`bot`, `LIKELY_AUTOMATED`, `human`, `LIKELY_HUMAN`, …) to ours. */
export function classifyBotClassKey(key: string): BotClassKey | null {
  const k = key.trim().toLowerCase();
  if (k === "bot" || k === "bots" || k === "likely_automated" || k === "automated") return "bot";
  if (k === "human" || k === "humans" || k === "likely_human") return "human";
  return null;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Combine optional bot/human values into a share. When only one side is
 * present, the other is its complement (bot classes are a 2-way split).
 */
function toShare(bot: number | null, human: number | null): BotShare | null {
  if (bot === null && human === null) return null;
  const b = bot ?? Math.max(0, 100 - (human as number));
  const h = human ?? Math.max(0, 100 - b);
  return { bot_pct: round4(b), human_pct: round4(h) };
}

/** Pull `result` out of a Radar envelope (`{ success, result }`), or accept a bare result. */
function resultOf(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.result)) return payload.result;
  return payload;
}

/**
 * Snapshot date (YYYY-MM-DD) from `result.meta.dateRange[0].endTime`,
 * or null when absent / malformed.
 */
export function parseSnapshotDate(payload: unknown): string | null {
  const result = resultOf(payload);
  if (!result || !isRecord(result.meta)) return null;
  const ranges = result.meta.dateRange;
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const first: unknown = ranges[0];
  if (!isRecord(first) || typeof first.endTime !== "string") return null;
  return toDatePart(first.endTime);
}

function toDatePart(ts: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(ts.trim());
  return m ? m[1]! : null;
}

/** #1 — `result.summary_0: { bot|LIKELY_AUTOMATED: "31.2", human|LIKELY_HUMAN: "68.8" }`. */
export function parseBotClassSummary(payload: unknown): BotShare | null {
  const result = resultOf(payload);
  if (!result || !isRecord(result.summary_0)) return null;
  let bot: number | null = null;
  let human: number | null = null;
  for (const [k, v] of Object.entries(result.summary_0)) {
    const cls = classifyBotClassKey(k);
    const pct = parsePct(v);
    if (cls === null || pct === null) continue;
    if (cls === "bot") bot = pct;
    else human = pct;
  }
  return toShare(bot, human);
}

/**
 * #2 — `result.serie_0: { timestamps: string[], <class>: string[] }`.
 * One entry per timestamp that yields a usable value; when a date repeats
 * (shouldn't at 1d aggregation) the last occurrence wins. Ascending by date.
 */
export function parseBotClassSeries(payload: unknown): BotShareDay[] {
  const result = resultOf(payload);
  if (!result || !isRecord(result.serie_0)) return [];
  const serie = result.serie_0;
  const timestamps = serie.timestamps;
  if (!Array.isArray(timestamps)) return [];

  let botArr: unknown[] | null = null;
  let humanArr: unknown[] | null = null;
  for (const [k, v] of Object.entries(serie)) {
    if (k === "timestamps" || !Array.isArray(v)) continue;
    const cls = classifyBotClassKey(k);
    if (cls === "bot") botArr = v;
    else if (cls === "human") humanArr = v;
  }
  if (!botArr && !humanArr) return [];

  const byDate = new Map<string, BotShare>();
  timestamps.forEach((ts: unknown, i: number) => {
    if (typeof ts !== "string") return;
    const date = toDatePart(ts);
    if (!date) return;
    const share = toShare(
      botArr ? parsePct(botArr[i]) : null,
      humanArr ? parsePct(humanArr[i]) : null,
    );
    if (share) byDate.set(date, share);
  });

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, s]) => ({ date, ...s }));
}

function topRows(payload: unknown): unknown[] {
  const result = resultOf(payload);
  if (!result || !Array.isArray(result.top_0)) return [];
  return result.top_0;
}

/** Re-rank 1..N in input order (Radar returns top_0 already sorted desc). */
function rankRows(rows: Array<Omit<RankedDim, "rank">>): RankedDim[] {
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** #3 — `result.top_0: [{ clientCountryAlpha2, clientCountryName, value }]`. */
export function parseTopLocations(payload: unknown): RankedDim[] {
  const out: Array<Omit<RankedDim, "rank">> = [];
  const seen = new Set<string>();
  for (const row of topRows(payload)) {
    if (!isRecord(row)) continue;
    const code = typeof row.clientCountryAlpha2 === "string" ? row.clientCountryAlpha2.trim().toUpperCase() : "";
    const pct = parsePct(row.value);
    if (!code || pct === null || seen.has(code)) continue;
    seen.add(code);
    const name = typeof row.clientCountryName === "string" && row.clientCountryName.trim()
      ? row.clientCountryName.trim()
      : code;
    out.push({ dim_key: code, label: name, value_pct: round4(pct) });
  }
  return rankRows(out);
}

/** #4 — `result.top_0: [{ clientASN, clientASName, value }]`. dim_key = ASN as text. */
export function parseTopAses(payload: unknown): RankedDim[] {
  const out: Array<Omit<RankedDim, "rank">> = [];
  const seen = new Set<string>();
  for (const row of topRows(payload)) {
    if (!isRecord(row)) continue;
    const asnRaw = row.clientASN;
    const asn = typeof asnRaw === "number" ? asnRaw : typeof asnRaw === "string" ? parseInt(asnRaw, 10) : NaN;
    const pct = parsePct(row.value);
    if (!Number.isInteger(asn) || asn < 0 || pct === null) continue;
    const key = String(asn);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof row.clientASName === "string" && row.clientASName.trim()
      ? row.clientASName.trim()
      : `AS${key}`;
    out.push({ dim_key: key, label: name, value_pct: round4(pct) });
  }
  return rankRows(out);
}

/**
 * #5 — `result.summary_0: { AI_CRAWLER: "40.1", SEARCH_ENGINE_CRAWLER: "30.2", other: "…" }`.
 * Keys are kept as Radar sends them except `other`, normalised to `OTHER`.
 * Sorted by value desc and ranked 1..N.
 */
export function parseCategorySummary(payload: unknown): RankedDim[] {
  const result = resultOf(payload);
  if (!result || !isRecord(result.summary_0)) return [];
  const byKey = new Map<string, number>();
  for (const [k, v] of Object.entries(result.summary_0)) {
    const key = k.trim().toLowerCase() === "other" ? "OTHER" : k.trim();
    const pct = parsePct(v);
    if (!key || pct === null) continue;
    byKey.set(key, round4(pct));
  }
  const sorted = [...byKey.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return rankRows(sorted.map(([dim_key, value_pct]) => ({ dim_key, label: null, value_pct })));
}

// ─── HTTP ────────────────────────────────────────────────────────

/** Auth failures abort the whole pull — they never degrade to "partial". */
export class RadarAuthError extends Error {
  constructor(status: number) {
    super(`CF Radar: CF_API_TOKEN lacks Radar Read permission (HTTP ${status})`);
    this.name = "RadarAuthError";
  }
}

async function radarGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${RADAR_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new RadarAuthError(res.status);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`CF Radar ${path.split("?")[0]}: HTTP ${res.status} — ${raw.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CF Radar ${path.split("?")[0]}: invalid JSON response`);
  }
  if (isRecord(parsed) && parsed.success === false) {
    const errs = Array.isArray(parsed.errors) ? JSON.stringify(parsed.errors).slice(0, 200) : "unknown error";
    throw new Error(`CF Radar ${path.split("?")[0]}: API error — ${errs}`);
  }
  return parsed;
}

const PATHS = {
  summary: "/http/summary/BOT_CLASS?dateRange=1d&format=JSON",
  series: "/http/timeseries_groups/BOT_CLASS?dateRange=28d&aggInterval=1d&format=JSON",
  locations: "/http/top/locations?botClass=LIKELY_AUTOMATED&dateRange=1d&limit=10&format=JSON",
  ases: "/http/top/ases?botClass=LIKELY_AUTOMATED&dateRange=1d&limit=10&format=JSON",
  categories: "/bots/summary/BOT_CATEGORY?dateRange=1d&format=JSON",
} as const;

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Feed module ────────────────────────────────────────────────

export const cf_radar_bots: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const token = ctx.env.CF_API_TOKEN;
    if (!token) {
      throw new Error("CF Radar: CF_API_TOKEN is not configured (requires Radar Read permission)");
    }

    const [summaryR, seriesR, locationsR, asesR, categoriesR] = await Promise.allSettled([
      radarGet(token, PATHS.summary),
      radarGet(token, PATHS.series),
      radarGet(token, PATHS.locations),
      radarGet(token, PATHS.ases),
      radarGet(token, PATHS.categories),
    ]);

    // Auth failures on ANY endpoint fail the pull outright.
    for (const r of [summaryR, seriesR, locationsR, asesR, categoriesR]) {
      if (r.status === "rejected" && r.reason instanceof RadarAuthError) throw r.reason;
    }

    // #1 is required.
    if (summaryR.status === "rejected") {
      const msg = summaryR.reason instanceof Error ? summaryR.reason.message : String(summaryR.reason);
      throw new Error(`CF Radar bot-class summary failed: ${msg}`);
    }
    const share = parseBotClassSummary(summaryR.value);
    if (!share) {
      throw new Error("CF Radar bot-class summary: no parsable bot/human values in result.summary_0");
    }
    const snapshotDate = parseSnapshotDate(summaryR.value) ?? utcToday();

    const db = ctx.env.DB;
    const upsert = db.prepare(
      `INSERT INTO bot_traffic_snapshots (snapshot_date, metric, dim_key, label, rank, value_pct, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(snapshot_date, metric, dim_key) DO UPDATE SET
         label = excluded.label,
         rank = excluded.rank,
         value_pct = excluded.value_pct,
         fetched_at = excluded.fetched_at`,
    );
    const clearMetric = db.prepare(
      "DELETE FROM bot_traffic_snapshots WHERE snapshot_date = ? AND metric = ?",
    );

    const stmts: D1PreparedStatement[] = [];
    let rowsWritten = 0;
    const failures: string[] = [];

    const optional = (r: PromiseSettledResult<unknown>, name: string): unknown => {
      if (r.status === "fulfilled") return r.value;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failures.push(`${name}: ${msg}`);
      return null;
    };

    // #2 — 28d backfill first, so the authoritative 24h summary (#1)
    // overwrites the series' (possibly partial) bucket for snapshotDate.
    const seriesPayload = optional(seriesR, "timeseries");
    if (seriesPayload !== null) {
      const days = parseBotClassSeries(seriesPayload).filter((d) => d.date !== snapshotDate);
      for (const d of days) {
        stmts.push(upsert.bind(d.date, "bot_share", "bot", null, null, d.bot_pct));
        stmts.push(upsert.bind(d.date, "bot_share", "human", null, null, d.human_pct));
        rowsWritten += 2;
      }
    }

    // #1
    stmts.push(upsert.bind(snapshotDate, "bot_share", "bot", null, null, share.bot_pct));
    stmts.push(upsert.bind(snapshotDate, "bot_share", "human", null, null, share.human_pct));
    rowsWritten += 2;

    // #3–#5 — replace that date's rows for the metric so a shrinking
    // top-N doesn't leave stale ranks behind. Only cleared when the
    // endpoint succeeded AND parsed to at least one row; a failed or
    // empty fetch leaves the previous rows intact.
    const ranked: Array<[PromiseSettledResult<unknown>, string, string, (p: unknown) => RankedDim[]]> = [
      [locationsR, "top_locations", "top_location", parseTopLocations],
      [asesR, "top_ases", "top_asn", parseTopAses],
      [categoriesR, "bot_categories", "bot_category", parseCategorySummary],
    ];
    for (const [r, name, metric, parse] of ranked) {
      const payload = optional(r, name);
      if (payload === null) continue;
      const rows = parse(payload);
      if (rows.length === 0) {
        failures.push(`${name}: empty result`);
        continue;
      }
      stmts.push(clearMetric.bind(snapshotDate, metric));
      for (const row of rows) {
        stmts.push(upsert.bind(snapshotDate, metric, row.dim_key, row.label, row.rank, row.value_pct));
        rowsWritten++;
      }
    }

    await db.batch(stmts);

    // Drop cached API responses so the page reflects the new snapshot
    // without waiting out the 1h TTL. Best-effort.
    await Promise.all(
      BOT_TRAFFIC_CACHE_DAYS.map((d) => ctx.env.CACHE.delete(botTrafficCacheKey(d)).catch(() => undefined)),
    );

    if (failures.length > 0) {
      console.warn(`[cf_radar_bots] partial pull (${failures.length} endpoint(s) failed): ${failures.join(" | ").slice(0, 800)}`);
    }

    return {
      itemsFetched: rowsWritten,
      itemsNew: 0, // never trigger Sentinel — no threats are created
      itemsDuplicate: 0,
      itemsError: failures.length,
    };
  },
};
