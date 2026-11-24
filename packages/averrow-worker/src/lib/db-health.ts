// Averrow — Databases page collector (A4)
//
// Builds the DatabasesPayload served by GET /api/databases (staff) and
// GET /api/internal/databases, and the `databases` block of
// platform-diagnostics. Sources, none of them a D1 table scan:
//   - sizes ............ lib/db-sizes.ts (CF D1 REST list, else PRAGMA)
//   - size history ..... KV `db_size_history:<store>` (lib/db-inventory.ts,
//                        one point a day) → growth via least-squares fit
//   - reads / writes ... CF GraphQL d1AnalyticsAdaptiveGroups (lib/d1-budget.ts
//                        helpers), per database id → store, resolved ONLY
//                        against this deploy env's ids (CF usage is
//                        account-wide: staging/dev databases share the account)
//   - overloads, jobs .. Analytics Engine per-store meter points
//                        (lib/analytics.ts point shape v2, lib/d1-meter.ts)
//   - top tables ....... KV `db_inventory:<store>` (lib/db-inventory.ts)
// Every section is fail-soft: a section that fails leaves its fields null /
// empty and adds `<section>_error` at the top level.
//
// Caching: the window-independent part is cachedValue `databases.base.v2`
// (10 min, single-flight); the window-dependent AE edges are
// `databases.edges.v1.<window>` (10 min, single-flight).

import type { Env } from "../types";
import { cachedValue } from "./cached-value";
import {
  computeBillingCycle,
  fetchBillingCycleMetrics,
  fetchD1HourlyMetrics,
  fetchRecentWindowMetrics,
  hourlyWindowStart,
  toHourLabel,
  BILLING_CYCLE_PLAN_CEILING,
  type D1DatabaseUsageRow,
} from "./d1-budget";
import {
  DB_REGISTRY,
  D1_DB_CAP_BYTES,
  deployEnvOf,
  hasStore,
  type DeployEnv,
  type StoreId,
} from "./db-registry";
import { getDatabaseSizes, type DbSizeRow } from "./db-sizes";
import { readInventory, readSizeHistory, type DbInventory, type SizePoint } from "./db-inventory";
import { telemetryRouteState, type TelemetryRoute, type TelemetryRouteSource, type TelemetryRouteState } from "./db-route";

// ─── Contract types (scratchpad CONTRACT.md v1) ──────────────────────

export type DbWindow = "1h" | "24h" | "cycle";
export type DbStatus = "healthy" | "warning" | "overloaded" | "unknown";
export type EdgeKind = "agent" | "feed" | "cron" | "workflow" | "http";

export interface DbTopTable {
  name: string;
  rows_estimate: number | null;
  bytes: number | null;
  estimate_divergent?: boolean;
}

export interface DbJob {
  source: string;
  kind: EdgeKind;
  rows_read: number;
  rows_written: number;
  overloads: number | null;
}

export interface DbHourly {
  hour: string;
  rows_read: number;
  rows_written: number;
  overloads: number | null;
}

export interface DatabaseCard {
  store: StoreId;
  name: string;
  binding: string;
  role: string;
  label: string;
  status: DbStatus;
  status_reasons: string[];
  size_bytes: number | null;
  cap_bytes: number;
  size_source: "cf_api" | "pragma" | null;
  tables: number | null;
  growth_bytes_per_day: number | null;
  days_to_cap: number | null;
  size_history: Array<{ date: string; bytes: number }>;
  reads_6h: number | null;
  writes_6h: number | null;
  reads_24h: number | null;
  writes_24h: number | null;
  reads_cycle: number | null;
  writes_cycle: number | null;
  hourly: DbHourly[];
  overloads_24h: number | null;
  top_tables: DbTopTable[];
  top_jobs: DbJob[];
  note: string | null;
  /**
   * telemetry store only: which DB serves the telemetry cluster right now
   * (lib/db-route.ts). 'core' until the cut-over flag is flipped.
   */
  route?: TelemetryRoute;
  /**
   * telemetry store only: where that route came from (a real KV flag, the
   * last known value, the environment's cold default, or unset).
   */
  route_source?: TelemetryRouteSource;
}

export interface DbEdge {
  source: string;
  kind: EdgeKind;
  store: StoreId;
  rows_read: number;
  rows_written: number;
  queries: number;
  overloads: number | null;
}

export interface DatabasesPayload {
  generated_at: string;
  window: DbWindow;
  summary: {
    /** Registry stores bound in this environment. */
    live: number;
    proposed: number;
    total_bytes: number | null;
    largest_share_pct: number | null;
    cycle_rows_read: number | null;
    cycle_pct_of_plan: number | null;
    /**
     * The current Cloudflare billing cycle (00:00 UTC on the 18th to the end
     * of the 17th). Lets the UI turn `reads_cycle` / `writes_cycle` into a
     * per-day average and compare the last 24h against it. Optional: a base
     * payload cached (10 min, `databases.base.v2`) before this field shipped
     * lacks it.
     */
    cycle?: { start: string; end: string; days_total: number };
    overloads_24h: number | null;
    /**
     * What overload counts cover: only statements issued through the D1
     * meter (agent / cron / feed / workflow / job layers). HTTP handlers are
     * not metered yet, so their rejections are not in any overload count.
     */
    overloads_scope: "metered_jobs";
    /** The thresholds the server's status rules use — render the same lines. */
    thresholds: {
      warn_size_fraction: number;
      critical_size_fraction: number;
      warn_days_to_cap: number;
      overloaded_min: number;
    };
  };
  databases: DatabaseCard[];
  proposed: Array<{ name: string; role: string; description: string }>;
  edges: DbEdge[];
  [sectionError: `${string}_error`]: string | undefined;
}

// ─── Static presentation per store ──────────────────────────────────

export const STORE_LABELS: Record<StoreId, string> = {
  core: "CORE",
  audit: "COMPLIANCE",
  geo: "REFERENCE",
  dnsq: "WORK QUEUE",
  telemetry: "TELEMETRY",
  archive: "ARCHIVE",
};

/**
 * Stores whose role means a billing cycle with zero writes is suspicious.
 * geo is excluded: it is written only when MaxMind ships a changed release.
 * audit is excluded: it is append-only and written only on rare staff
 * actions (logins, approvals, role changes) — prod had multi-day gaps with
 * a healthy writer (2026-11-10 → 11-17), so a quiet cycle start is normal.
 * telemetry and archive are excluded until their writers exist (telemetry:
 * add it when the route flag is flipped to 'telemetry').
 */
export const STORES_EXPECTING_WRITES: ReadonlySet<StoreId> = new Set<StoreId>(["core", "dnsq"]);

/**
 * Databases planned but not yet created. Empty since averrow-telemetry and
 * averrow-archive became live stores (the UI renders no proposed section
 * for an empty list).
 */
export const PROPOSED_DATABASES: DatabasesPayload["proposed"] = [];

// ─── Status / growth rules (pure, exported for tests) ───────────────

export const OVERLOADED_MIN = 5;
export const WARN_SIZE_FRACTION = 0.5;
/** Size at which the status reason says "critical" (status stays `warning`). */
export const CRITICAL_SIZE_FRACTION = 0.8;
export const WARN_DAYS_TO_CAP = 180;
export const GROWTH_FIT_POINTS = 14;
export const GROWTH_MIN_POINTS = 3;

/**
 * Least-squares bytes/day over the newest GROWTH_FIT_POINTS daily points
 * (x = days since the first point, from the date). null with < 3 points
 * or when every point is the same day.
 */
export function fitGrowth(history: readonly SizePoint[]): number | null {
  const pts = [...history]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-GROWTH_FIT_POINTS)
    .map((p) => ({ x: Date.parse(`${p.date}T00:00:00Z`) / 86_400_000, y: p.bytes }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < GROWTH_MIN_POINTS) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return null;
  return Math.round(sxy / sxx);
}

/** Days until `cap` at `growth` bytes/day; null when unknown or not growing. */
export function daysToCap(size: number | null, growth: number | null, cap: number): number | null {
  if (size == null || growth == null || growth <= 0) return null;
  return Math.max(0, Math.round((cap - size) / growth));
}

export function classifyStatus(input: {
  store: StoreId;
  size_bytes: number | null;
  cap_bytes: number;
  days_to_cap: number | null;
  overloads_24h: number | null;
  writes_cycle: number | null;
}): { status: DbStatus; reasons: string[] } {
  const reasons: string[] = [];
  const o = input.overloads_24h;
  if (o != null && o >= OVERLOADED_MIN) {
    return { status: "overloaded", reasons: [`${o} overload rejections in the last 24 h`] };
  }
  if (input.size_bytes != null && input.size_bytes >= input.cap_bytes * WARN_SIZE_FRACTION) {
    const pct = Math.round((input.size_bytes / input.cap_bytes) * 100);
    const critical = input.size_bytes >= input.cap_bytes * CRITICAL_SIZE_FRACTION;
    reasons.push(`${critical ? "Critical: size" : "Size"} is ${pct}% of the ${Math.round(input.cap_bytes / 1024 ** 3)} GB cap`);
  }
  if (input.days_to_cap != null && input.days_to_cap < WARN_DAYS_TO_CAP) {
    reasons.push(`Reaches the cap in about ${input.days_to_cap} days at the current growth`);
  }
  if (o != null && o >= 1) {
    reasons.push(`${o} overload rejection${o === 1 ? "" : "s"} in the last 24 h`);
  }
  if (input.writes_cycle === 0 && STORES_EXPECTING_WRITES.has(input.store)) {
    reasons.push("No writes this billing cycle");
  }
  if (reasons.length > 0) return { status: "warning", reasons };
  if (input.size_bytes == null) return { status: "unknown", reasons: ["Size not measured"] };
  return { status: "healthy", reasons: [] };
}

/** One-line operator hint for a card, or null. */
export function noteFor(store: StoreId, card: { writes_cycle: number | null; size_bytes: number | null; bound: boolean }): string | null {
  if (!card.bound) return "Not bound in this environment";
  if (card.writes_cycle === 0 && STORES_EXPECTING_WRITES.has(store)) {
    return "No writes this billing cycle — check its writers";
  }
  if (card.size_bytes == null) return "Size not measured — check the CF API token's D1 read scope";
  return null;
}

/**
 * `agent:navigator:bg` → { kind: 'agent', source: 'navigator' }.
 * `job:<name>` (a handler-dispatched scheduled job metered on its own, e.g.
 * job:db_inventory) maps to kind 'cron'.
 */
export function parseEndpointLabel(label: string): { kind: EdgeKind; source: string } {
  const m = /^(agent|feed|cron|workflow|http|job):(.*)$/.exec(label);
  if (!m) return { kind: "http", source: label };
  const kind: EdgeKind = m[1] === "job" ? "cron" : (m[1] as EdgeKind);
  const source = (m[2] ?? "").replace(/:bg$/, "");
  return { kind, source };
}

// ─── Analytics Engine SQL ───────────────────────────────────────────

const AE_TIMEOUT_MS = 8_000;

async function aeSql<T>(env: Env, sql: string): Promise<T[]> {
  const token = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID;
  if (!token || !accountId) throw new Error("setup_required: CF_API_TOKEN + CF_ACCOUNT_ID");
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: sql,
      signal: AbortSignal.timeout(AE_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`ae_sql_http_${res.status}`);
  const body = (await res.json()) as { data?: T[] };
  return body.data ?? [];
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const isStoreId = (v: unknown): v is StoreId =>
  typeof v === "string" && DB_REGISTRY.some((s) => s.id === v);

/** AE `toDateTime` literal for a Date (computed by us, never request input). */
const aeTime = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

function windowStart(window: DbWindow, now: Date): Date {
  if (window === "1h") return new Date(now.getTime() - 3_600_000);
  if (window === "24h") return new Date(now.getTime() - 86_400_000);
  return new Date(computeBillingCycle(now).start);
}

interface StoreOverloads {
  /** hour label → store → overloads */
  hourly: Map<string, Map<StoreId, number>>;
  total: Map<StoreId, number>;
  /** False when no per-store point exists in the window (meter not live yet). */
  hasData: boolean;
}

async function fetchStoreOverloads(env: Env, now: Date): Promise<StoreOverloads> {
  const start = aeTime(hourlyWindowStart(24, now));
  const rows = await aeSql<{ hour: string; store: string; overloads: unknown }>(env, `
    SELECT
      toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
      blob2 AS store,
      SUM(_sample_interval * double4) AS overloads
    FROM trust_radar_d1_reads
    WHERE timestamp >= toDateTime('${start}') AND blob2 != ''
    GROUP BY hour, store
    ORDER BY hour ASC
    LIMIT 2000
  `);
  const out: StoreOverloads = { hourly: new Map(), total: new Map(), hasData: false };
  for (const r of rows) {
    if (!isStoreId(r.store)) continue;
    out.hasData = true;
    const hour = toHourLabel(String(r.hour));
    const v = n(r.overloads);
    const h = out.hourly.get(hour) ?? new Map<StoreId, number>();
    h.set(r.store, (h.get(r.store) ?? 0) + v);
    out.hourly.set(hour, h);
    out.total.set(r.store, (out.total.get(r.store) ?? 0) + v);
  }
  return out;
}

export async function fetchEdges(env: Env, window: DbWindow, now: Date = new Date()): Promise<DbEdge[]> {
  const start = aeTime(windowStart(window, now));
  const rows = await aeSql<{
    endpoint: string; store: string; rows_read: unknown; rows_written: unknown; queries: unknown; overloads: unknown;
  }>(env, `
    SELECT
      blob1 AS endpoint,
      blob2 AS store,
      SUM(_sample_interval * double1) AS rows_read,
      SUM(_sample_interval * double2) AS rows_written,
      SUM(_sample_interval * double3) AS queries,
      SUM(_sample_interval * double4) AS overloads
    FROM trust_radar_d1_reads
    WHERE timestamp >= toDateTime('${start}') AND blob2 != ''
    GROUP BY endpoint, store
    ORDER BY rows_read DESC
    LIMIT 2000
  `);
  // Fold `:bg` tails into their source (contract), keyed (kind, source, store).
  const byKey = new Map<string, DbEdge>();
  for (const r of rows) {
    if (!isStoreId(r.store)) continue;
    const { kind, source } = parseEndpointLabel(String(r.endpoint));
    const key = `${kind}\u0000${source}\u0000${r.store}`;
    const e = byKey.get(key) ?? { source, kind, store: r.store, rows_read: 0, rows_written: 0, queries: 0, overloads: 0 };
    e.rows_read += n(r.rows_read);
    e.rows_written += n(r.rows_written);
    e.queries += n(r.queries);
    e.overloads = (e.overloads ?? 0) + n(r.overloads);
    byKey.set(key, e);
  }
  return Array.from(byKey.values()).sort((a, b) => b.rows_read - a.rows_read || b.rows_written - a.rows_written);
}

// ─── Base (window-independent) build ────────────────────────────────

interface UsageByStore {
  reads: Map<StoreId, number>;
  writes: Map<StoreId, number>;
}

/**
 * Store for a D1 database id in THIS deploy env only. CF usage is
 * account-wide, and the registry lists prod + staging + dev ids per store, so
 * a cross-env lookup would add staging/dev traffic to the prod card. null env
 * (unrecognised ENVIRONMENT) maps nothing.
 */
export function storeForEnvDatabaseId(deployEnv: DeployEnv | null, databaseId: string): StoreId | null {
  if (!deployEnv) return null;
  const needle = databaseId.toLowerCase();
  const spec = DB_REGISTRY.find((s) => s.databaseId[deployEnv]?.toLowerCase() === needle);
  return spec ? spec.id : null;
}

function usageByStore(deployEnv: DeployEnv | null, rows: readonly D1DatabaseUsageRow[]): UsageByStore {
  const out: UsageByStore = { reads: new Map(), writes: new Map() };
  for (const r of rows) {
    const store = storeForEnvDatabaseId(deployEnv, r.database_id);
    if (!store) continue;
    out.reads.set(store, (out.reads.get(store) ?? 0) + n(r.rows_read));
    out.writes.set(store, (out.writes.get(store) ?? 0) + n(r.rows_written));
  }
  return out;
}

/**
 * A section error safe to show every staff viewer: a fixed category, never
 * upstream text (CF GraphQL bodies / error messages). The full text goes to
 * the Worker log.
 */
export function classifySectionError(section: string, err: unknown): string {
  const msg = errText(err);
  const name = err instanceof Error ? err.name : "";
  console.warn(`[db-health] section ${section} failed: ${msg}`);
  if (/setup_required/.test(msg)) return "setup_required";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|timeout/i.test(msg)) return "timeout";
  const ae = /^ae_sql_http_(\d{3})$/.exec(msg);
  if (ae) return `ae_sql_http_${ae[1]}`;
  const gql = /CF GraphQL HTTP (\d{3})/.exec(msg);
  if (gql) return `cf_graphql_http_${gql[1]}`;
  if (CF_GRAPHQL_SECTIONS.has(section)) return "cf_graphql_error";
  if (section === "overloads" || section === "edges") return "ae_sql_error";
  return "internal_error";
}

const CF_GRAPHQL_SECTIONS: ReadonlySet<string> = new Set(["usage_6h", "usage_24h", "usage_cycle", "hourly"]);

/** Window-independent payload; `top_jobs` / `edges` are filled per window. */
export type DatabasesBase = Omit<DatabasesPayload, "window" | "edges">;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Value of a usage map for a store: null when the section failed. */
function usageOf(map: Map<StoreId, number> | null, store: StoreId): number | null {
  if (!map) return null;
  return map.get(store) ?? 0;
}

export async function buildDatabasesBase(env: Env, now: Date = new Date()): Promise<DatabasesBase> {
  const errors: Record<string, string> = {};
  const deployEnv = deployEnvOf(env);
  const section = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      errors[`${name}_error`] = classifySectionError(name, e);
      return null;
    }
  };

  const sizes = await section("sizes", async () => (await getDatabaseSizes(env)).databases);

  const history = await section("size_history", async () => {
    const m = new Map<StoreId, SizePoint[]>();
    for (const s of DB_REGISTRY) m.set(s.id, await readSizeHistory(env, s.id));
    return m;
  });

  const inventory = await section("inventory", async () => {
    const m = new Map<StoreId, DbInventory | null>();
    for (const s of DB_REGISTRY) m.set(s.id, await readInventory(env, s.id));
    return m;
  });

  // CF GraphQL usage — each fetcher reports failure in-band; surface it.
  const usage = async (name: string, fetcher: () => Promise<{ per_database: D1DatabaseUsageRow[]; setup_required: boolean; error?: string }>) =>
    section(name, async () => {
      const r = await fetcher();
      if (r.setup_required) throw new Error("setup_required: CF_API_TOKEN + CF_ACCOUNT_ID");
      if (r.error) throw new Error(r.error);
      return usageByStore(deployEnv, r.per_database);
    });
  const u6 = await usage("usage_6h", () => fetchRecentWindowMetrics(env, 6, now));
  const u24 = await usage("usage_24h", () => fetchRecentWindowMetrics(env, 24, now));
  let cycleRowsRead: number | null = null;
  const uCycle = await section("usage_cycle", async () => {
    const r = await fetchBillingCycleMetrics(env, now);
    if (r.setup_required) throw new Error("setup_required: CF_API_TOKEN + CF_ACCOUNT_ID");
    if (r.error) throw new Error(r.error);
    // Account-wide on purpose: the plan ceiling is account-wide.
    cycleRowsRead = r.rows_read_cycle;
    return usageByStore(deployEnv, r.per_database);
  });

  const hourlyUsage = await section("hourly", async () => {
    const r = await fetchD1HourlyMetrics(env, 24, now);
    if (r.setup_required) throw new Error("setup_required: CF_API_TOKEN + CF_ACCOUNT_ID");
    if (r.error) throw new Error(r.error);
    const m = new Map<string, Map<StoreId, { r: number; w: number }>>();
    for (const h of r.hours) {
      const per = new Map<StoreId, { r: number; w: number }>();
      for (const d of h.per_database) {
        const store = storeForEnvDatabaseId(deployEnv, d.database_id);
        if (!store) continue;
        const cur = per.get(store) ?? { r: 0, w: 0 };
        cur.r += n(d.rows_read);
        cur.w += n(d.rows_written);
        per.set(store, cur);
      }
      m.set(toHourLabel(h.hour), per);
    }
    return m;
  });

  const overloads = await section("overloads", () => fetchStoreOverloads(env, now));
  const overloadsKnown = overloads?.hasData === true;

  // The 24 hour labels, oldest first (same buckets as d1_hourly).
  const firstHour = hourlyWindowStart(24, now).getTime();
  const hourLabels = Array.from({ length: 24 }, (_, i) => toHourLabel(new Date(firstHour + i * 3_600_000).toISOString()));

  const databases: DatabaseCard[] = DB_REGISTRY.map((spec) => {
    const size: DbSizeRow | undefined = sizes?.find((r) => r.store === spec.id);
    const hist = history?.get(spec.id) ?? [];
    const inv = inventory?.get(spec.id) ?? null;
    const sizeBytes = size?.sizeBytes ?? null;
    const cap = size?.capBytes ?? D1_DB_CAP_BYTES;
    const growth = fitGrowth(hist);
    const dtc = daysToCap(sizeBytes, growth, cap);
    const writesCycle = usageOf(uCycle?.writes ?? null, spec.id);
    const overloads24 = overloadsKnown ? overloads!.total.get(spec.id) ?? 0 : null;
    const { status, reasons } = classifyStatus({
      store: spec.id, size_bytes: sizeBytes, cap_bytes: cap, days_to_cap: dtc,
      overloads_24h: overloads24, writes_cycle: writesCycle,
    });
    return {
      store: spec.id,
      name: size?.name ?? (deployEnv ? spec.databaseName[deployEnv] : null) ?? spec.databaseName.prod ?? spec.binding,
      binding: spec.binding,
      role: spec.role,
      label: STORE_LABELS[spec.id],
      status,
      status_reasons: reasons,
      size_bytes: sizeBytes,
      cap_bytes: cap,
      size_source: size?.source ?? null,
      tables: size?.tables ?? inv?.table_count ?? null,
      growth_bytes_per_day: growth,
      days_to_cap: dtc,
      size_history: hist.slice(-90),
      reads_6h: usageOf(u6?.reads ?? null, spec.id),
      writes_6h: usageOf(u6?.writes ?? null, spec.id),
      reads_24h: usageOf(u24?.reads ?? null, spec.id),
      writes_24h: usageOf(u24?.writes ?? null, spec.id),
      reads_cycle: usageOf(uCycle?.reads ?? null, spec.id),
      writes_cycle: writesCycle,
      hourly: hourlyUsage
        ? hourLabels.map((hour) => {
            const v = hourlyUsage.get(hour)?.get(spec.id);
            return {
              hour,
              rows_read: v?.r ?? 0,
              rows_written: v?.w ?? 0,
              overloads: overloadsKnown ? overloads!.hourly.get(hour)?.get(spec.id) ?? 0 : null,
            };
          })
        : [],
      overloads_24h: overloads24,
      top_tables: (inv?.tables ?? []).slice(0, 10).map((t) => ({
        name: t.name,
        rows_estimate: t.rows_estimate,
        bytes: t.bytes,
        ...(t.estimate_divergent ? { estimate_divergent: true } : {}),
      })),
      top_jobs: [],
      note: noteFor(spec.id, { writes_cycle: writesCycle, size_bytes: sizeBytes, bound: hasStore(env, spec.id) }),
    };
  });

  const measured = databases.map((d) => d.size_bytes).filter((b): b is number => b != null);
  const totalBytes = measured.length > 0 ? measured.reduce((s, b) => s + b, 0) : null;
  const largest = measured.length > 0 ? Math.max(...measured) : null;
  const cycleRead: number | null = cycleRowsRead;
  const { start: cycleStart, end: cycleEnd, days_total: cycleDays } = computeBillingCycle(now);
  return {
    generated_at: now.toISOString(),
    summary: {
      live: DB_REGISTRY.filter((s) => hasStore(env, s.id)).length,
      proposed: PROPOSED_DATABASES.length,
      total_bytes: totalBytes,
      largest_share_pct: totalBytes && largest != null ? Math.round((largest / totalBytes) * 1000) / 10 : null,
      cycle_rows_read: cycleRead,
      cycle_pct_of_plan: cycleRead != null ? Math.round((cycleRead / BILLING_CYCLE_PLAN_CEILING) * 1000) / 10 : null,
      cycle: { start: cycleStart, end: cycleEnd, days_total: cycleDays },
      overloads_24h: overloadsKnown ? databases.reduce((s, d) => s + (d.overloads_24h ?? 0), 0) : null,
      overloads_scope: "metered_jobs",
      thresholds: {
        warn_size_fraction: WARN_SIZE_FRACTION,
        critical_size_fraction: CRITICAL_SIZE_FRACTION,
        warn_days_to_cap: WARN_DAYS_TO_CAP,
        overloaded_min: OVERLOADED_MIN,
      },
    },
    databases,
    proposed: PROPOSED_DATABASES,
    ...errors,
  };
}

/** Compose the base with one window's edges (top 8 jobs per store). */
export function composePayload(base: DatabasesBase, window: DbWindow, edges: DbEdge[] | null, edgesError?: string): DatabasesPayload {
  const list = edges ?? [];
  const databases = base.databases.map((d) => ({
    ...d,
    top_jobs: list
      .filter((e) => e.store === d.store)
      .sort((a, b) => b.rows_read - a.rows_read || b.rows_written - a.rows_written)
      .slice(0, 8)
      .map((e) => ({ source: e.source, kind: e.kind, rows_read: e.rows_read, rows_written: e.rows_written, overloads: e.overloads })),
  }));
  const out: DatabasesPayload = { ...base, window, databases, edges: list };
  if (edgesError) out.edges_error = edgesError;
  return out;
}

export const TELEMETRY_NOT_IN_USE_NOTE = "Not yet in use — writes still go to core";

/**
 * Stamp the live telemetry route onto the telemetry card (applied after the
 * 10-min base cache, so a flag flip shows within the route's 60 s cache).
 * While bound but routed to core, the card says it is not in use yet.
 */
export function applyTelemetryRoute(payload: DatabasesPayload, state: TelemetryRouteState): DatabasesPayload {
  return {
    ...payload,
    databases: payload.databases.map((d) => {
      if (d.store !== "telemetry") return d;
      // Never hide a real problem note (e.g. size not measured) behind the route note.
      const note = d.note ?? (state.bound && state.route === "core" ? TELEMETRY_NOT_IN_USE_NOTE : null);
      return { ...d, route: state.route, ...(state.source ? { route_source: state.source } : {}), note };
    }),
  };
}

export const DATABASES_CACHE_TTL_S = 600;
/** TTL for a base payload with any `<section>_error` (e.g. CF API blip). */
export const DATABASES_DEGRADED_TTL_S = 60;
export const DATABASES_BASE_CACHE_KEY = "databases.base.v2";
export const databasesEdgesCacheKey = (w: DbWindow): string => `databases.edges.v1.${w}`;
const SINGLE_FLIGHT = { lockTtlSeconds: 60, waitMs: 10_000 };

export function parseDbWindow(raw: string | null): DbWindow | null {
  if (raw == null || raw === "") return "24h";
  return raw === "1h" || raw === "24h" || raw === "cycle" ? raw : null;
}

/** The cached DatabasesPayload for a window. Never throws for a section failure. */
export async function getDatabasesPayload(env: Env, window: DbWindow): Promise<DatabasesPayload> {
  const base = await cachedValue<DatabasesBase>(env, DATABASES_BASE_CACHE_KEY, DATABASES_CACHE_TTL_S,
    () => buildDatabasesBase(env), {
      // A section failed → cache briefly so a transient error heals fast.
      ttlFor: (b) => (Object.keys(b).some((k) => k.endsWith("_error")) ? DATABASES_DEGRADED_TTL_S : DATABASES_CACHE_TTL_S),
      singleFlight: SINGLE_FLIGHT,
    });
  let edges: DbEdge[] | null = null;
  let edgesError: string | undefined;
  try {
    edges = await cachedValue<DbEdge[]>(env, databasesEdgesCacheKey(window), DATABASES_CACHE_TTL_S,
      () => fetchEdges(env, window), { singleFlight: SINGLE_FLIGHT });
  } catch (e) {
    edgesError = classifySectionError("edges", e);
  }
  const payload = composePayload(base, window, edges, edgesError);
  return applyTelemetryRoute(payload, await telemetryRouteState(env));
}
