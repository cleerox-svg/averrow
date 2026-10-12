import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";

/**
 * Cloudflare Radar — Internet bot traffic (feed key `cf_radar_bots`).
 *
 * Daily pull of eight Radar endpoints into `bot_traffic_snapshots`
 * (migration 0290) and `radar_country_snapshots` (migration 0292), served
 * by GET /api/bot-traffic:
 *
 *   1. /radar/http/summary/BOT_CLASS            → bot_share (latest 24h)   REQUIRED
 *   2. /radar/http/timeseries_groups/BOT_CLASS  → bot_share 28d backfill   optional
 *   3. /radar/http/top/locations?botClass=LIKELY_AUTOMATED (limit=100)
 *                                               → top_location (top 10)    optional
 *   4. /radar/http/top/ases?botClass=…          → top_asn                   optional
 *   5. /radar/bots/summary/BOT_CATEGORY         → bot_category              optional
 *   6. /radar/http/top/locations?botClass=LIKELY_HUMAN (limit=100)
 *                                               → bot_density (with #1+#3)  optional
 *   7. /radar/attacks/layer7/top/locations/origin (7d) → attack_origin      optional
 *   8. /radar/attacks/layer7/top/locations/target (7d) → attack_target      optional
 *
 * #1–#5 write bot_traffic_snapshots; #6–#8 write radar_country_snapshots.
 * bot_density is derived, not fetched: computeBotDensity combines the
 * global bot share (#1) with the bot (#3) and human (#6) location shares.
 * It is skipped when #3 or #6 is unavailable (the failed endpoint is what
 * gets counted), and an empty derivation counts as `bot_density: empty result`.
 *
 * Failure contract:
 *   - Token: CF_RADAR_API_TOKEN (dedicated, read-only) if set, else the
 *     shared CF_API_TOKEN. Neither set → throw, so runFeed records a failed pull
 *     (never a quiet success).
 *   - #1 failing for any reason (incl. HTTP 401/403, which carries the
 *     "lacks Radar Read permission" message) → throw.
 *   - #2–#8 failing for any reason (incl. 401/403), or returning HTTP 200
 *     with zero usable rows → the rest is still written; each such
 *     endpoint counts as one itemsError (surfaces as records_rejected) and
 *     its message is returned in FeedResult.warning, which runFeed
 *     persists to feed_pull_history.error_message on the success row.
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
  return `bot_traffic:v3:${days}`;
}

/** How many of the (limit=100) bot top-locations rows are stored as `top_location`. */
export const TOP_LOCATIONS_STORED = 10;
/** Countries below this share (%) of all HTTP traffic are excluded from bot_density (noise floor). */
export const BOT_DENSITY_MIN_TRAFFIC_PCT = 0.1;
/**
 * Safety cap on bot_density rows per snapshot. Every qualifying country is
 * stored (both inputs are top-100 lists, so the intersection can't exceed
 * this); consumers slice their own top-N.
 */
export const BOT_DENSITY_MAX_ROWS = 100;

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

/**
 * #3 / #6 — `result.top_0: [{ clientCountryAlpha2, clientCountryName, value }]`.
 * Used for both the bot (#3) and human (#6) lists.
 */
export function parseTopLocations(payload: unknown): RankedDim[] {
  return parseCountryRows(payload, "clientCountryAlpha2", "clientCountryName");
}

/** Shared country-list parser: upper-cased alpha-2 key, name fallback = code, dupes/NaN dropped. */
function parseCountryRows(payload: unknown, codeField: string, nameField: string): RankedDim[] {
  const out: Array<Omit<RankedDim, "rank">> = [];
  const seen = new Set<string>();
  for (const row of topRows(payload)) {
    if (!isRecord(row)) continue;
    const rawCode = row[codeField];
    const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
    const pct = parsePct(row.value);
    if (!code || pct === null || seen.has(code)) continue;
    seen.add(code);
    const rawName = row[nameField];
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : code;
    out.push({ dim_key: code, label: name, value_pct: round4(pct) });
  }
  return rankRows(out);
}

/** #7 — `result.top_0: [{ originCountryAlpha2, originCountryName, rank, value }]`. */
export function parseAttackOrigins(payload: unknown): RankedDim[] {
  return parseCountryRows(payload, "originCountryAlpha2", "originCountryName");
}

/** #8 — `result.top_0: [{ targetCountryAlpha2, targetCountryName, rank, value }]`. */
export function parseAttackTargets(payload: unknown): RankedDim[] {
  return parseCountryRows(payload, "targetCountryAlpha2", "targetCountryName");
}

export interface BotDensityRow {
  code: string;
  name: string;
  /** % of the country's own HTTP traffic that is likely automated. */
  bot_pct: number;
  /** The country's share (%) of all HTTP traffic. */
  traffic_pct: number;
  rank: number;
}

/**
 * Per-country bot density from two location shares and the global bot share.
 *
 *   b   = global bot share (fraction 0..1, from the BOT_CLASS summary)
 *   B_c = country's share of bot traffic   (botList value_pct / 100)
 *   H_c = country's share of human traffic (humanList value_pct / 100)
 *   traffic_c = b·B_c + (1−b)·H_c          (country's share of all traffic)
 *   bot_pct_c = 100·b·B_c / traffic_c
 *
 * Only countries present in BOTH lists with traffic_pct ≥
 * BOT_DENSITY_MIN_TRAFFIC_PCT (compared after 4-dp rounding) are kept —
 * a country missing from one top-100 list has an unknown share, not zero.
 * Sorted by bot_pct desc (ties: traffic_pct desc, then code), capped
 * at BOT_DENSITY_MAX_ROWS, ranked 1..N. A non-finite b → []; b is clamped to
 * [0, 1], so b = 0 / 1 give 0 % / 100 % without NaN or Infinity.
 */
export function computeBotDensity(b: number, botList: RankedDim[], humanList: RankedDim[]): BotDensityRow[] {
  if (!Number.isFinite(b)) return [];
  const bf = Math.min(1, Math.max(0, b));
  const human = new Map<string, number>();
  for (const r of humanList) {
    if (Number.isFinite(r.value_pct) && !human.has(r.dim_key)) human.set(r.dim_key, r.value_pct);
  }

  const out: Array<Omit<BotDensityRow, "rank">> = [];
  const seen = new Set<string>();
  for (const r of botList) {
    if (seen.has(r.dim_key)) continue;
    const hPct = human.get(r.dim_key);
    if (hPct === undefined || !Number.isFinite(r.value_pct)) continue;
    seen.add(r.dim_key);
    const botTraffic = bf * Math.max(0, r.value_pct) / 100;
    const traffic = botTraffic + (1 - bf) * Math.max(0, hPct) / 100;
    const trafficPct = round4(100 * traffic);
    if (!(traffic > 0) || trafficPct < BOT_DENSITY_MIN_TRAFFIC_PCT) continue;
    out.push({
      code: r.dim_key,
      name: r.label ?? r.dim_key,
      bot_pct: round4((100 * botTraffic) / traffic),
      traffic_pct: trafficPct,
    });
  }

  out.sort((x, y) =>
    y.bot_pct - x.bot_pct || y.traffic_pct - x.traffic_pct || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
  return out.slice(0, BOT_DENSITY_MAX_ROWS).map((r, i) => ({ ...r, rank: i + 1 }));
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

export type RadarTokenName = "CF_RADAR_API_TOKEN" | "CF_API_TOKEN";

/**
 * Prefer the dedicated read-only Radar token; fall back to the shared
 * worker-wide CF_API_TOKEN so existing deployments keep working.
 */
export function resolveRadarToken(
  env: Pick<Env, "CF_RADAR_API_TOKEN" | "CF_API_TOKEN">,
): { token: string | undefined; tokenName: RadarTokenName } {
  // Trim: a whitespace-only secret (easy to paste via `wrangler secret put`)
  // must not shadow a working shared token.
  const radar = env.CF_RADAR_API_TOKEN?.trim();
  if (radar) return { token: radar, tokenName: "CF_RADAR_API_TOKEN" };
  return { token: env.CF_API_TOKEN?.trim() || undefined, tokenName: "CF_API_TOKEN" };
}

/** 401/403 from Radar. Fatal only on the required summary endpoint (#1). */
export class RadarAuthError extends Error {
  constructor(status: number, tokenName: RadarTokenName) {
    super(`CF Radar: ${tokenName} lacks Radar Read permission (HTTP ${status})`);
    this.name = "RadarAuthError";
  }
}

async function radarGet(token: string, tokenName: RadarTokenName, path: string): Promise<unknown> {
  const res = await fetch(`${RADAR_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new RadarAuthError(res.status, tokenName);
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
  // limit=100 feeds bot_density; only the top TOP_LOCATIONS_STORED are stored as top_location.
  locations: "/http/top/locations?botClass=LIKELY_AUTOMATED&dateRange=1d&limit=100&format=JSON",
  ases: "/http/top/ases?botClass=LIKELY_AUTOMATED&dateRange=1d&limit=10&format=JSON",
  categories: "/bots/summary/BOT_CATEGORY?dateRange=1d&format=JSON",
  humanLocations: "/http/top/locations?botClass=LIKELY_HUMAN&dateRange=1d&limit=100&format=JSON",
  attackOrigins: "/attacks/layer7/top/locations/origin?dateRange=7d&limit=10&format=JSON",
  attackTargets: "/attacks/layer7/top/locations/target?dateRange=7d&limit=10&format=JSON",
} as const;

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Feed module ────────────────────────────────────────────────

export const cf_radar_bots: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { token, tokenName } = resolveRadarToken(ctx.env);
    if (!token) {
      throw new Error(
        "CF Radar: neither CF_RADAR_API_TOKEN nor CF_API_TOKEN is configured (requires Radar Read permission)",
      );
    }

    const [
      summaryR, seriesR, locationsR, asesR, categoriesR,
      humanLocationsR, attackOriginsR, attackTargetsR,
    ] = await Promise.allSettled([
      radarGet(token, tokenName, PATHS.summary),
      radarGet(token, tokenName, PATHS.series),
      radarGet(token, tokenName, PATHS.locations),
      radarGet(token, tokenName, PATHS.ases),
      radarGet(token, tokenName, PATHS.categories),
      radarGet(token, tokenName, PATHS.humanLocations),
      radarGet(token, tokenName, PATHS.attackOrigins),
      radarGet(token, tokenName, PATHS.attackTargets),
    ]);

    // #1 is required. A 401/403 here surfaces as-is (the token message);
    // auth failures on #2–#8 are ordinary optional failures below.
    if (summaryR.status === "rejected") {
      if (summaryR.reason instanceof RadarAuthError) throw summaryR.reason;
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
    const upsertCountry = db.prepare(
      `INSERT INTO radar_country_snapshots (snapshot_date, metric, country_code, label, rank, value_pct, traffic_pct, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(snapshot_date, metric, country_code) DO UPDATE SET
         label = excluded.label,
         rank = excluded.rank,
         value_pct = excluded.value_pct,
         traffic_pct = excluded.traffic_pct,
         fetched_at = excluded.fetched_at`,
    );
    const clearCountryMetric = db.prepare(
      "DELETE FROM radar_country_snapshots WHERE snapshot_date = ? AND metric = ?",
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
      const parsed = parseBotClassSeries(seriesPayload);
      if (parsed.length === 0) failures.push("timeseries: empty result");
      const days = parsed.filter((d) => d.date !== snapshotDate);
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

    // #3–#8 — replace that date's rows for the metric so a shrinking
    // top-N doesn't leave stale ranks behind. Only cleared when the
    // endpoint succeeded AND parsed to at least one row; a failed or
    // empty fetch leaves the previous rows intact.
    //
    // Parse an optional ranked endpoint; null = failed or empty (already
    // recorded in `failures`).
    const parseOptional = (
      r: PromiseSettledResult<unknown>,
      name: string,
      parse: (p: unknown) => RankedDim[],
    ): { payload: unknown; rows: RankedDim[] } | null => {
      const payload = optional(r, name);
      if (payload === null) return null;
      const rows = parse(payload);
      if (rows.length === 0) {
        failures.push(`${name}: empty result`);
        return null;
      }
      return { payload, rows };
    };

    // #3 is fetched at limit=100 (bot_density input); only the top
    // TOP_LOCATIONS_STORED are stored, re-ranked contiguously by the parser.
    const botLocations = parseOptional(locationsR, "top_locations", parseTopLocations);
    const ranked: Array<[{ rows: RankedDim[] } | null, string]> = [
      [botLocations ? { rows: botLocations.rows.slice(0, TOP_LOCATIONS_STORED) } : null, "top_location"],
      [parseOptional(asesR, "top_ases", parseTopAses), "top_asn"],
      [parseOptional(categoriesR, "bot_categories", parseCategorySummary), "bot_category"],
    ];
    for (const [parsed, metric] of ranked) {
      if (!parsed) continue;
      stmts.push(clearMetric.bind(snapshotDate, metric));
      for (const row of parsed.rows) {
        stmts.push(upsert.bind(snapshotDate, metric, row.dim_key, row.label, row.rank, row.value_pct));
        rowsWritten++;
      }
    }

    // #6 + derived bot_density (radar_country_snapshots). Skipped when
    // either location list is unavailable — that endpoint's failure is
    // already counted, so density adds no second error for it.
    const humanLocations = parseOptional(humanLocationsR, "human_locations", parseTopLocations);
    if (botLocations && humanLocations) {
      const density = computeBotDensity(share.bot_pct / 100, botLocations.rows, humanLocations.rows);
      if (density.length === 0) {
        failures.push("bot_density: empty result");
      } else {
        stmts.push(clearCountryMetric.bind(snapshotDate, "bot_density"));
        for (const d of density) {
          stmts.push(upsertCountry.bind(snapshotDate, "bot_density", d.code, d.name, d.rank, d.bot_pct, d.traffic_pct));
          rowsWritten++;
        }
      }
    }

    // #7–#8 — 7-day attack windows; dated by their own meta.dateRange
    // endTime, falling back to the summary's snapshot date.
    const attacks: Array<[PromiseSettledResult<unknown>, string, string, (p: unknown) => RankedDim[]]> = [
      [attackOriginsR, "attack_origins", "attack_origin", parseAttackOrigins],
      [attackTargetsR, "attack_targets", "attack_target", parseAttackTargets],
    ];
    for (const [r, name, metric, parse] of attacks) {
      const parsed = parseOptional(r, name, parse);
      if (!parsed) continue;
      const date = parseSnapshotDate(parsed.payload) ?? snapshotDate;
      stmts.push(clearCountryMetric.bind(date, metric));
      for (const row of parsed.rows) {
        stmts.push(upsertCountry.bind(date, metric, row.dim_key, row.label, row.rank, row.value_pct, null));
        rowsWritten++;
      }
    }

    await db.batch(stmts);

    // Drop cached API responses so the page reflects the new snapshot
    // without waiting out the 1h TTL. Best-effort.
    await Promise.all(
      BOT_TRAFFIC_CACHE_DAYS.map((d) => ctx.env.CACHE.delete(botTrafficCacheKey(d)).catch(() => undefined)),
    );

    return {
      itemsFetched: rowsWritten,
      itemsNew: 0, // never trigger Sentinel — no threats are created
      itemsDuplicate: 0,
      itemsError: failures.length,
      ...(failures.length > 0
        ? { warning: `partial pull (${failures.length} endpoint(s) failed): ${failures.join(" | ")}`.slice(0, 1000) }
        : {}),
    };
  },
};
