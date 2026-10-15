// Averrow — Observatory event rail (Intel Feed redesign: headline bar + rail)
//
//   GET /api/observatory/events?period=1h|24h|7d&kinds=a,b&limit=1..100
//
// A typed, newest-first list of things that HAPPENED in the period, each a
// plain sentence that leads with who is affected, plus per-kind counts for
// the headline bar. Platform-health telemetry (agent_runs / agent_activity_log
// run summaries, feed pulls, cube heals) is deliberately never a source.
//
// Auth: requireStaff at the route layer (routes/dashboard.ts), like every
// observatory route. The `takedown` kind is `manage_takedowns` data (same
// gate as /api/observatory/takedowns-geo and /api/admin/takedowns/metrics):
// for a caller without the flag it is dropped BEFORE any read, its count is
// absent from counts_by_kind, it is listed in meta.omitted_kinds, and the
// cache key carries the role class so the two audiences never share an entry.
//
// Params (400 on anything outside the allow-list; never a KV key for a 400):
//   period  1h (default) | 24h | 7d. Absent / empty → 1h.
//   kinds   comma list ⊆ EVENT_KINDS. Absent / empty → every kind. Order and
//           duplicates don't matter (canonicalised for the key).
//   limit   1..100, default 40 — clamped, never rejected (same rule as
//           parseObservatoryLimit on the sibling routes).
//
// Window: [top of the current UTC hour − N hours, now], so `1h` covers the
// current partial hour plus the previous full hour. Hour-snapped like every
// Phase A/B observatory read, because the critical source reads the hourly
// cubes and the sources must agree on one window.
//
// Sources (each a bounded, indexed read — plans pinned in
// test/observatory-events.test.ts; no request-time GROUP BY over `threats`):
//   critical   threat_cube_brand (severity 'critical', monitored/customer
//              brands — MONITORED_BRAND_PREDICATE_SQL) grouped by brand, then
//              threat_cube_arcs for the top-`limit` brands' country split
//              (dominant country, centroid, newest last_seen).
//   operation  agent_events pivot_detected (dormancy + infra_movement), joined
//              to LIVE infrastructure_clusters (retired_reason IS NULL) for the
//              name and country_counts; pivots on retired/missing clusters are
//              dropped. Bursts on one cluster are grouped.
//   fast       threats whose weaponization_flag is very_fast, CREATED in the
//              window, through the velocity partial index
//              (idx_threats_velocity_fast_created via VELOCITY_SOURCE_FILTER).
//              There is no stamp timestamp — the flag is written after ingest
//              by cube_healer's ≤500-row page — so a threat flagged after its
//              created hour has left the window never appears here.
//   lookalike  lookalike_domains whose first_seen (the confirmed
//              registration date — registration_evidence 'nrd' | 'observed')
//              falls in the window, status != 'benign'. NRD-dated rows carry
//              the registry date (list date − 1 day), so they surface on 24h /
//              7d rather than 1h.
//   takedown   takedown_requests that reached status 'taken_down' in the window
//              (resolved_at, stamped by the ops PATCH), with submit → takedown
//              hours. Partial index idx_takedown_taken_down_resolved (0307).
//   actor      threat_attributions written by the two cluster-level attribution
//              paths (source 'nexus' = OTX → cluster inheritance, 'manual' =
//              the admin attribute route; source_pulse_id = cluster id) whose
//              FIRST row for that (cluster, actor) is in the window — later
//              member fan-out on an already-linked cluster is not a new event.
//              The cluster must still be live and still carry that actor_id.
//              (infrastructure_clusters.attribution_attempted_at is NOT used:
//              the attributor stamps it on every pending cluster without naming
//              anyone, and OTX inheritance sets actor_id without stamping it.)
//   spike      countries whose share of our geolocated active threats is
//              ≥ SPIKE_MIN_RATIO × their Radar attack-origin share, with at
//              least SPIKE_MIN_COUNT threats (computeOverindex, the /overindex
//              lens's logic). 1h / 24h read the geo cube over the window;
//              7d reuses the /overindex?period=7d lens response and its cache.
//
// Response:
//   { success: true,
//     data: ObservatoryEvent[]            (newest first, ≤ limit),
//     counts_by_kind: { [kind]: number }  (records per requested + permitted
//                                          kind in the period, pre-limit),
//     meta: { generated_at, period, window_start, kinds, limit,
//             omitted_kinds, capped_kinds, failed_kinds } }
// A source that throws is isolated: its kind lands in meta.failed_kinds and
// the rest of the rail still renders. capped_kinds lists sources whose read
// hit its row cap (their counts are lower bounds).
//
// Caching: cachedValue, EVENTS_TTL_S, key
//   observatory_events.<period>:<kinds|all>:<limit>:<any|td|notd>
// (role segment only varies when `takedown` was requested). Navigator warms
// the default `period=1h&limit=40` as a takedown-permitted caller.

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { newTally, addToTally, recordD1Reads, type D1Tally } from "../lib/analytics";
import { cachedValue } from "../lib/cached-value";
import { MONITORED_BRAND_PREDICATE_SQL } from "../lib/monitored-brands";
import { VELOCITY_SOURCE_FILTER } from "../lib/cube-builder";
import { notRetiredClusterSql } from "../lib/cluster-status";
import { getCountryCentroid } from "../lib/country-centroids";
import { countryName } from "../lib/country-name";
import { roleHasPermission } from "../lib/role-permissions";
import { parseObservatoryLimit } from "./observatory";
import {
  computeOverindex,
  handleObservatoryOverindex,
  normalizeCountry,
  parsePivotRow,
  LENS_MAX_BINDS,
  type OverindexRow,
} from "./observatoryLenses";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

type ReadSession = ReturnType<typeof getReadSession>;

// ── Contract ──────────────────────────────────────────────────────────────────

export const EVENT_KINDS = ["critical", "operation", "fast", "lookalike", "takedown", "actor", "spike"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_PERIODS = ["1h", "24h", "7d"] as const;
export type EventPeriod = (typeof EVENT_PERIODS)[number];

const PERIOD_HOURS: Record<EventPeriod, number> = { "1h": 1, "24h": 24, "7d": 168 };

export const EVENTS_DEFAULT_PERIOD: EventPeriod = "1h";
export const EVENTS_DEFAULT_LIMIT = 40;
export const EVENTS_MAX_LIMIT = 100;
/** KV freshness (seconds). The rail is near-live; 60s is the spec ceiling. */
export const EVENTS_TTL_S = 60;
/** Row cap on every per-row source read (pivots, fast, lookalikes, takedowns, attributions). */
export const EVENTS_SOURCE_ROW_CAP = 500;
/** Row cap on the critical (brand × threat_type) cube fold. */
export const EVENTS_CRITICAL_GROUP_CAP = 2000;
/** Spike gate: our share ≥ this multiple of Radar's share … */
export const SPIKE_MIN_RATIO = 3;
/** … and at least this many of our threats from the country in the window. */
export const SPIKE_MIN_COUNT = 20;
/** Max title length; longer titles are cut at a word boundary with an ellipsis. */
export const TITLE_MAX = 90;
/** Bind ceiling per statement (100) minus headroom — one bind reserved for the window. */
const IN_CHUNK = LENS_MAX_BINDS - 1;

export const EVENTS_CACHE_NS = "observatory_events";

export type EventSeverity = "critical" | "high" | "medium" | "low" | "info";
export type EventEntityType = "brand" | "operation" | "domain" | "country" | "actor" | "provider";

export interface ObservatoryEvent {
  /** Stable + unique: `${kind}:${source pk}` or `${kind}:brand:${brand id}` / group key. */
  id: string;
  kind: EventKind;
  severity: EventSeverity;
  title: string;
  entity: { type: EventEntityType; id: string | null; name: string };
  place: { country_code: string | null; country_name: string | null; lat: number | null; lng: number | null };
  /** Records this item stands for (> 1 when grouped). */
  count: number;
  occurred_at: string;
  /** Producing agent / surface, for the rail's small "via" line. */
  source: string;
  /** Observatory lens id + optional `sel` value (url-state.ts `kind:id`). */
  target: { lens: string; select?: string };
}

export interface EventsEnvelope {
  success: true;
  data: ObservatoryEvent[];
  counts_by_kind: Partial<Record<EventKind, number>>;
  meta: {
    generated_at: string;
    period: EventPeriod;
    window_start: string;
    kinds: EventKind[];
    limit: number;
    omitted_kinds: EventKind[];
    capped_kinds: EventKind[];
    failed_kinds: EventKind[];
  };
}

// ── Params + cache key (pure) ────────────────────────────────────────────────

export type EventsParams =
  | { ok: true; period: EventPeriod; kinds: EventKind[]; allKinds: boolean; limit: number }
  | { ok: false; error: string };

export function parseEventsParams(url: URL): EventsParams {
  const rawPeriod = url.searchParams.get("period");
  let period: EventPeriod = EVENTS_DEFAULT_PERIOD;
  if (rawPeriod !== null && rawPeriod !== "") {
    if (!(EVENT_PERIODS as readonly string[]).includes(rawPeriod)) {
      return { ok: false, error: "period must be 1h, 24h or 7d" };
    }
    period = rawPeriod as EventPeriod;
  }

  const rawKinds = url.searchParams.get("kinds");
  let kinds: EventKind[] = [...EVENT_KINDS];
  if (rawKinds !== null && rawKinds.trim() !== "") {
    const wanted = new Set<string>();
    for (const part of rawKinds.split(",")) {
      const k = part.trim();
      if (k === "") continue;
      if (!(EVENT_KINDS as readonly string[]).includes(k)) {
        return { ok: false, error: `kinds must be a comma list of ${EVENT_KINDS.join(", ")}` };
      }
      wanted.add(k);
    }
    if (wanted.size === 0) return { ok: false, error: `kinds must be a comma list of ${EVENT_KINDS.join(", ")}` };
    kinds = EVENT_KINDS.filter((k) => wanted.has(k));
  }

  const limit = parseObservatoryLimit(url.searchParams.get("limit"), EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT);
  return { ok: true, period, kinds, allKinds: kinds.length === EVENT_KINDS.length, limit };
}

/** Role class for the key: only matters when `takedown` was requested. */
export function eventsRoleSegment(kinds: readonly EventKind[], canTakedowns: boolean): "any" | "td" | "notd" {
  if (!kinds.includes("takedown")) return "any";
  return canTakedowns ? "td" : "notd";
}

/** cachedValue key (the helper prefixes `cv:`). */
export function eventsCacheKey(
  period: EventPeriod,
  kinds: readonly EventKind[],
  limit: number,
  canTakedowns: boolean,
): string {
  const all = kinds.length === EVENT_KINDS.length;
  const kindsSeg = all ? "all" : EVENT_KINDS.filter((k) => kinds.includes(k)).join(",");
  return `${EVENTS_CACHE_NS}.${period}:${kindsSeg}:${limit}:${eventsRoleSegment(kinds, canTakedowns)}`;
}

/** 'YYYY-MM-DD HH:00:00' — top of the current UTC hour minus the period. */
export function eventsWindowStart(period: EventPeriod, now: Date = new Date()): string {
  const top = new Date(now.getTime());
  top.setUTCMinutes(0, 0, 0);
  return new Date(top.getTime() - PERIOD_HOURS[period] * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
}

// ── Copy helpers (pure) ───────────────────────────────────────────────────────

/** Cut at a word boundary with an ellipsis; a single over-long word is kept whole. */
export function fitTitle(s: string, max: number = TITLE_MAX): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(" ", max - 1);
  if (cut <= 0) return t;
  return `${t.slice(0, cut).replace(/[\s·,:;—-]+$/, "")}…`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** 0.4 → "within an hour", 1 → "1 hour", 11 → "11 hours", 72 → "3 days". */
export function durationPhrase(hours: number): string {
  if (hours < 1) return "within an hour";
  const h = Math.round(hours);
  if (h < 48) return `${h} ${plural(h, "hour", "hours")}`;
  const d = Math.round(h / 24);
  return `${d} ${plural(d, "day", "days")}`;
}

const THREAT_TYPE_NOUNS: Record<string, [string, string]> = {
  phishing: ["phishing page", "phishing pages"],
  phishing_link: ["phishing link", "phishing links"],
  credential_harvesting: ["credential-harvesting page", "credential-harvesting pages"],
  malware_distribution: ["malware site", "malware sites"],
  malware: ["malware site", "malware sites"],
  c2: ["command-and-control server", "command-and-control servers"],
  typosquatting: ["typosquat domain", "typosquat domains"],
  impersonation: ["impersonation site", "impersonation sites"],
  scam: ["scam site", "scam sites"],
};

/** "a new phishing page" / "12 new phishing pages" / "3 new critical threats". */
export function threatNoun(n: number, threatType: string | null): string {
  const pair = threatType ? THREAT_TYPE_NOUNS[threatType] : undefined;
  const [one, many] = pair ?? ["critical threat", "critical threats"];
  return n === 1 ? `a new ${one}` : `${n} new ${many}`;
}

/** " · Netherlands" (all), " · mostly Netherlands" (≥ half), " · 4 countries", or "". */
export function countrySuffix(byCountry: ReadonlyMap<string, number>): string {
  let total = 0;
  let topCc: string | null = null;
  let topN = 0;
  for (const [cc, n] of byCountry) {
    total += n;
    if (n > topN || (n === topN && topCc !== null && cc < topCc)) {
      topCc = cc;
      topN = n;
    }
  }
  if (!topCc || total <= 0) return "";
  const name = countryName(topCc);
  if (byCountry.size === 1) return ` · ${name}`;
  if (topN / total >= 0.5) return ` · mostly ${name}`;
  return ` · ${byCountry.size} countries`;
}

/** Operation name for copy: never the raw id; "Operation " prefixed once. */
export function operationLabel(name: string | null): string {
  const n = (name ?? "").trim();
  if (n === "") return "An unnamed operation";
  return /^operation\b/i.test(n) ? n : `Operation ${n}`;
}

/** Bare host for copy: URL → hostname, `www.` kept as given. */
export function displayHost(value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v === "") return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      return new URL(v).hostname || v;
    } catch {
      return v;
    }
  }
  return v;
}

// ── Shaping helpers (pure) ────────────────────────────────────────────────────

/** 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD' / ISO → ISO-8601 UTC, or null. */
export function toIsoUtc(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  const norm = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t) ? `${t.replace(" ", "T")}Z`
      : t;
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function hoursBetween(from: string | null, to: string | null): number | null {
  const a = toIsoUtc(from);
  const b = toIsoUtc(to);
  if (!a || !b) return null;
  const h = (Date.parse(b) - Date.parse(a)) / 3_600_000;
  return Number.isFinite(h) && h >= 0 ? h : null;
}

type Place = ObservatoryEvent["place"];

const NO_PLACE: Place = { country_code: null, country_name: null, lat: null, lng: null };

/** Place from a country (+ optional precise point); centroid when no point. */
export function placeFor(cc: string | null | undefined, lat?: number | null, lng?: number | null): Place {
  const code = normalizeCountry(cc ?? null);
  const hasPoint = typeof lat === "number" && Number.isFinite(lat) && typeof lng === "number" && Number.isFinite(lng);
  if (!code) return hasPoint ? { ...NO_PLACE, lat: lat as number, lng: lng as number } : NO_PLACE;
  const c = getCountryCentroid(code);
  return {
    country_code: code,
    country_name: countryName(code),
    lat: hasPoint ? (lat as number) : c ? c[1] : null,
    lng: hasPoint ? (lng as number) : c ? c[0] : null,
  };
}

/** Top country of a cluster: country_counts {CC: n} first, else countries[0]. */
export function dominantClusterCountry(countryCounts: string | null, countries: string | null): string | null {
  if (countryCounts) {
    try {
      const v: unknown = JSON.parse(countryCounts);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        let best: string | null = null;
        let bestN = -1;
        for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
          const cc = normalizeCountry(k);
          if (!cc || typeof n !== "number" || !Number.isFinite(n)) continue;
          if (n > bestN || (n === bestN && best !== null && cc < best)) {
            best = cc;
            bestN = n;
          }
        }
        if (best) return best;
      }
    } catch {
      /* fall through */
    }
  }
  if (countries) {
    try {
      const v: unknown = JSON.parse(countries);
      if (Array.isArray(v)) {
        for (const x of v) {
          const cc = typeof x === "string" ? normalizeCountry(x) : null;
          if (cc) return cc;
        }
      }
    } catch {
      /* none */
    }
  }
  return null;
}

const SEVERITY_ORDER: readonly EventSeverity[] = ["critical", "high", "medium", "low", "info"];

function normalizeSeverity(raw: string | null | undefined, fallback: EventSeverity): EventSeverity {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "critical" || s === "high" || s === "medium" || s === "low" || s === "info" ? s : fallback;
}

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Newest first; ties by kind order then id (deterministic). */
export function sortEvents(events: ObservatoryEvent[]): ObservatoryEvent[] {
  const rank = (k: EventKind) => EVENT_KINDS.indexOf(k);
  return events.sort((a, b) =>
    b.occurred_at.localeCompare(a.occurred_at) || rank(a.kind) - rank(b.kind) || a.id.localeCompare(b.id));
}

// ── Source results ────────────────────────────────────────────────────────────

interface SourceResult {
  events: ObservatoryEvent[];
  /** Records the kind stands for in the period (sum of `count`, pre-limit). */
  total: number;
  capped: boolean;
}

interface SourceCtx {
  session: ReadSession;
  tally: D1Tally;
  windowStart: string;
  limit: number;
  period: EventPeriod;
  env: Env;
}

async function all<T>(ctx: SourceCtx, sql: string, binds: unknown[]): Promise<T[]> {
  const r = await ctx.session.prepare(sql).bind(...binds).all<T>();
  addToTally(ctx.tally, r.meta);
  return r.results ?? [];
}

function sumCounts(events: readonly ObservatoryEvent[]): number {
  return events.reduce((a, e) => a + e.count, 0);
}

// ── 1. critical ───────────────────────────────────────────────────────────────

export interface CriticalBrandRow { brand_id: string; brand_name: string | null; threat_type: string; n: number; last_hour: string }
export interface CriticalCountryRow { brand_id: string; country_code: string; n: number; last_seen: string | null; lat: number | null; lng: number | null }

export const CRITICAL_BRANDS_SQL = `
  SELECT c.target_brand_id AS brand_id, b.name AS brand_name, c.threat_type AS threat_type,
         SUM(c.threat_count) AS n, MAX(c.hour_bucket) AS last_hour
  FROM threat_cube_brand c
  JOIN brands b ON b.id = c.target_brand_id
  WHERE c.hour_bucket >= ? AND c.severity = 'critical' AND ${MONITORED_BRAND_PREDICATE_SQL}
  GROUP BY c.target_brand_id, c.threat_type
  LIMIT ?`;

export const criticalCountriesSql = (n: number) => `
  SELECT target_brand_id AS brand_id, country_code, SUM(threat_count) AS n, MAX(last_seen) AS last_seen,
         SUM(CASE WHEN source_lat IS NOT NULL AND source_lng IS NOT NULL THEN source_lat * threat_count END)
           / SUM(CASE WHEN source_lat IS NOT NULL AND source_lng IS NOT NULL THEN threat_count END) AS lat,
         SUM(CASE WHEN source_lat IS NOT NULL AND source_lng IS NOT NULL THEN source_lng * threat_count END)
           / SUM(CASE WHEN source_lat IS NOT NULL AND source_lng IS NOT NULL THEN threat_count END) AS lng
  FROM threat_cube_arcs
  WHERE target_brand_id IN (${placeholders(n)}) AND hour_bucket >= ? AND severity = 'critical'
  GROUP BY target_brand_id, country_code`;

interface CriticalGroup { brand_id: string; brand_name: string; n: number; last_hour: string; types: Map<string, number> }

/** Pure: brand cube rows → per-brand groups, newest hour first then volume. */
export function foldCriticalBrands(rows: readonly CriticalBrandRow[]): CriticalGroup[] {
  const by = new Map<string, CriticalGroup>();
  for (const r of rows) {
    const n = num(r.n);
    if (n <= 0 || !r.brand_id) continue;
    const g = by.get(r.brand_id) ?? { brand_id: r.brand_id, brand_name: r.brand_name?.trim() || "An unnamed brand", n: 0, last_hour: r.last_hour, types: new Map() };
    g.n += n;
    if (r.last_hour > g.last_hour) g.last_hour = r.last_hour;
    g.types.set(r.threat_type, (g.types.get(r.threat_type) ?? 0) + n);
    by.set(r.brand_id, g);
  }
  return [...by.values()].sort((a, b) => b.last_hour.localeCompare(a.last_hour) || b.n - a.n || a.brand_id.localeCompare(b.brand_id));
}

/** Pure: one brand group (+ its arcs country split) → event. */
export function buildCriticalEvent(g: CriticalGroup, countries: readonly CriticalCountryRow[]): ObservatoryEvent {
  const byCountry = new Map<string, number>();
  let lastSeen: string | null = null;
  let top: CriticalCountryRow | null = null;
  for (const c of countries) {
    const cc = normalizeCountry(c.country_code);
    const n = num(c.n);
    if (c.last_seen && (!lastSeen || c.last_seen > lastSeen)) lastSeen = c.last_seen;
    if (!cc || n <= 0) continue;
    byCountry.set(cc, (byCountry.get(cc) ?? 0) + n);
    if (!top || n > num(top.n)) top = c;
  }
  // Single dominant type → its noun; a mix reads "critical threats".
  const types = [...g.types.entries()].filter(([, n]) => n > 0);
  const type = types.length === 1 ? types[0]![0] : null;
  const topCc = top ? normalizeCountry(top.country_code) : null;
  return {
    id: `critical:${g.brand_id}`,
    kind: "critical",
    severity: "critical",
    title: fitTitle(`${g.brand_name} targeted by ${threatNoun(g.n, type)}${countrySuffix(byCountry)}`),
    entity: { type: "brand", id: g.brand_id, name: g.brand_name },
    place: top ? placeFor(top.country_code, top.lat, top.lng) : NO_PLACE,
    count: g.n,
    occurred_at: toIsoUtc(lastSeen) ?? toIsoUtc(g.last_hour) ?? new Date().toISOString(),
    source: "sentinel",
    target: topCc ? { lens: "threats", select: `country:${topCc}` } : { lens: "threats" },
  };
}

async function criticalSource(ctx: SourceCtx): Promise<SourceResult> {
  const rows = await all<CriticalBrandRow>(ctx, CRITICAL_BRANDS_SQL, [ctx.windowStart, EVENTS_CRITICAL_GROUP_CAP]);
  const groups = foldCriticalBrands(rows);
  // Only the top-`limit` brands can reach the response; split just those.
  const shown = groups.slice(0, ctx.limit);
  const byBrand = new Map<string, CriticalCountryRow[]>();
  for (const ids of chunk(shown.map((g) => g.brand_id), IN_CHUNK)) {
    const r = await all<CriticalCountryRow>(ctx, criticalCountriesSql(ids.length), [...ids, ctx.windowStart]);
    for (const row of r) byBrand.set(row.brand_id, [...(byBrand.get(row.brand_id) ?? []), row]);
  }
  return {
    events: shown.map((g) => buildCriticalEvent(g, byBrand.get(g.brand_id) ?? [])),
    total: groups.reduce((a, g) => a + g.n, 0),
    capped: rows.length >= EVENTS_CRITICAL_GROUP_CAP,
  };
}

// ── 2. operation ──────────────────────────────────────────────────────────────

export const PIVOTS_SQL = `
  SELECT id, created_at, payload_json
  FROM agent_events
  WHERE event_type = 'pivot_detected' AND created_at >= ?
  ORDER BY created_at DESC
  LIMIT ?`;

export interface LiveClusterRow {
  id: string;
  cluster_name: string | null;
  actor_id: string | null;
  country_counts: string | null;
  countries: string | null;
  actor_name?: string | null;
}

export const liveClustersSql = (n: number) => `
  SELECT c.id, c.cluster_name, c.actor_id, c.country_counts, c.countries, a.name AS actor_name
  FROM infrastructure_clusters c
  LEFT JOIN threat_actors a ON a.id = c.actor_id
  WHERE c.id IN (${placeholders(n)}) AND ${notRetiredClusterSql("c")}`;

async function liveClusters(ctx: SourceCtx, ids: readonly string[]): Promise<Map<string, LiveClusterRow>> {
  const out = new Map<string, LiveClusterRow>();
  for (const part of chunk([...new Set(ids)], LENS_MAX_BINDS)) {
    for (const r of await all<LiveClusterRow>(ctx, liveClustersSql(part.length), part)) out.set(r.id, r);
  }
  return out;
}

export interface PivotInput { id: string; created_at: string; payload_json: string | null }

/** Pure: pivots (newest first) + live clusters → grouped operation events. */
export function buildOperationEvents(pivots: readonly PivotInput[], clusters: ReadonlyMap<string, LiveClusterRow>): ObservatoryEvent[] {
  interface G { clusterId: string; kind: "infra_movement" | "dormancy"; newest: PivotInput; n: number; ips: number; asns: number; serials: number }
  const groups = new Map<string, G>();
  for (const p of pivots) {
    const parsed = parsePivotRow(p);
    if (!parsed.cluster_id || !clusters.has(parsed.cluster_id)) continue; // retired / gone
    const key = `${parsed.cluster_id}:${parsed.kind}`;
    const g = groups.get(key) ?? { clusterId: parsed.cluster_id, kind: parsed.kind, newest: p, n: 0, ips: 0, asns: 0, serials: 0 };
    g.n += 1;
    g.ips += parsed.counts.new_ips;
    g.asns += parsed.counts.new_asns;
    g.serials += parsed.counts.new_serials;
    if (p.created_at > g.newest.created_at) g.newest = p;
    groups.set(key, g);
  }
  const out: ObservatoryEvent[] = [];
  for (const g of groups.values()) {
    const c = clusters.get(g.clusterId)!;
    const label = operationLabel(c.cluster_name);
    let title: string;
    if (g.kind === "dormancy") {
      title = `${label} went quiet · activity down over 80%`;
    } else {
      const parts: string[] = [];
      if (g.ips > 0) parts.push(`${g.ips} new ${plural(g.ips, "IP", "IPs")}`);
      if (g.asns > 0) parts.push(`${g.asns} new ${plural(g.asns, "network", "networks")}`);
      if (g.serials > 0) parts.push(`${g.serials} new ${plural(g.serials, "certificate", "certificates")}`);
      title = parts.length === 0 ? `${label} shifted its infrastructure`
        : `${label} moved to ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`}`;
    }
    out.push({
      id: `operation:${g.clusterId}:${g.kind}`,
      kind: "operation",
      severity: g.kind === "infra_movement" ? "high" : "medium",
      title: fitTitle(title),
      entity: { type: "operation", id: g.clusterId, name: c.cluster_name?.trim() || label },
      place: placeFor(dominantClusterCountry(c.country_counts, c.countries)),
      count: g.n,
      occurred_at: toIsoUtc(g.newest.created_at) ?? new Date().toISOString(),
      source: "nexus",
      target: { lens: "movement", select: `move:${g.newest.id}` },
    });
  }
  return out;
}

async function operationSource(ctx: SourceCtx): Promise<SourceResult> {
  const pivots = await all<PivotInput>(ctx, PIVOTS_SQL, [ctx.windowStart, EVENTS_SOURCE_ROW_CAP]);
  const ids = pivots.map((p) => parsePivotRow(p).cluster_id).filter((x): x is string => !!x);
  const clusters = await liveClusters(ctx, ids);
  const events = buildOperationEvents(pivots, clusters);
  return { events, total: sumCounts(events), capped: pivots.length >= EVENTS_SOURCE_ROW_CAP };
}

// ── 3. fast ───────────────────────────────────────────────────────────────────

// VELOCITY_SOURCE_FILTER (status active + flag IN very_fast/fast) is written
// verbatim so the partial index idx_threats_velocity_fast_created (0300) is
// usable; the extra `= 'very_fast'` narrows on the index's own column.
// INDEXED BY: implying the partial WHERE is not enough — without
// sqlite_stat1 the planner takes idx_threats_status_created (status,
// created_at DESC), the same seek but over EVERY active threat in the window
// instead of only the flagged ones (pinned in test/observatory-events.test.ts).
export const FAST_SQL = `
  SELECT id, malicious_domain, malicious_url, target_brand_id, country_code, lat, lng,
         weaponization_hours, created_at
  FROM threats INDEXED BY idx_threats_velocity_fast_created
  WHERE created_at >= ?${VELOCITY_SOURCE_FILTER} AND weaponization_flag = 'very_fast'
  ORDER BY created_at DESC
  LIMIT ?`;

export interface FastRow {
  id: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  target_brand_id: string | null;
  country_code: string | null;
  lat: number | null;
  lng: number | null;
  weaponization_hours: number | null;
  created_at: string;
}

export const brandNamesSql = (n: number) => `SELECT id, name FROM brands WHERE id IN (${placeholders(n)})`;

async function brandNames(ctx: SourceCtx, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk([...new Set(ids)], LENS_MAX_BINDS)) {
    for (const r of await all<{ id: string; name: string | null }>(ctx, brandNamesSql(part.length), part)) {
      if (r.name && r.name.trim() !== "") out.set(r.id, r.name.trim());
    }
  }
  return out;
}

/** Split rows into per-brand bursts (≥ 2 rows on one named brand) and singles. Input newest-first. */
function burstsByBrand<T>(rows: readonly T[], brandOf: (r: T) => string | null, names: ReadonlyMap<string, string>): { groups: Array<{ brandId: string; rows: T[] }>; singles: T[] } {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const b = brandOf(r);
    if (b && names.has(b)) by.set(b, [...(by.get(b) ?? []), r]);
  }
  const groups: Array<{ brandId: string; rows: T[] }> = [];
  const grouped = new Set<T>();
  for (const [brandId, rs] of by) {
    if (rs.length < 2) continue;
    groups.push({ brandId, rows: rs });
    for (const r of rs) grouped.add(r);
  }
  return { groups, singles: rows.filter((r) => !grouped.has(r)) };
}

/** Dominant country of a set of located rows (+ the first row in it, for a point). */
function dominantPlace<T extends { country_code: string | null; lat: number | null; lng: number | null }>(rows: readonly T[]): Place {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const cc = normalizeCountry(r.country_code);
    if (cc) counts.set(cc, (counts.get(cc) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [cc, n] of counts) if (!best || n > (counts.get(best) ?? 0) || (n === counts.get(best) && cc < best)) best = cc;
  if (!best) return NO_PLACE;
  const first = rows.find((r) => normalizeCountry(r.country_code) === best);
  return placeFor(best, first?.lat ?? null, first?.lng ?? null);
}

/** Pure: very_fast rows (newest first) + brand names → events. */
export function buildFastEvents(rows: readonly FastRow[], names: ReadonlyMap<string, string>): ObservatoryEvent[] {
  const usable = rows.filter((r) => displayHost(r.malicious_domain ?? r.malicious_url) !== null);
  const { groups, singles } = burstsByBrand(usable, (r) => r.target_brand_id, names);
  const out: ObservatoryEvent[] = [];
  for (const g of groups) {
    const brand = names.get(g.brandId)!;
    const maxH = Math.max(...g.rows.map((r) => num(r.weaponization_hours)));
    const place = dominantPlace(g.rows);
    const cc = place.country_code;
    out.push({
      id: `fast:brand:${g.brandId}`,
      kind: "fast",
      severity: "high",
      title: fitTitle(`${brand} targeted by ${g.rows.length} domains that went live ${maxH < 1 ? "within an hour" : `within ${durationPhrase(maxH)}`} of registration`),
      entity: { type: "brand", id: g.brandId, name: brand },
      place,
      count: g.rows.length,
      occurred_at: toIsoUtc(g.rows[0]!.created_at) ?? new Date().toISOString(),
      source: "sentinel",
      target: cc ? { lens: "threats", select: `country:${cc}` } : { lens: "threats" },
    });
  }
  for (const r of singles) {
    const host = displayHost(r.malicious_domain ?? r.malicious_url)!;
    const h = num(r.weaponization_hours);
    const cc = normalizeCountry(r.country_code);
    out.push({
      id: `fast:${r.id}`,
      kind: "fast",
      severity: "high",
      title: fitTitle(h < 1 ? `${host} went live within an hour of registration` : `${host} went live ${durationPhrase(h)} after registration`),
      entity: { type: "domain", id: r.id, name: host },
      place: placeFor(r.country_code, r.lat, r.lng),
      count: 1,
      occurred_at: toIsoUtc(r.created_at) ?? new Date().toISOString(),
      source: "sentinel",
      target: cc ? { lens: "threats", select: `country:${cc}` } : { lens: "threats" },
    });
  }
  return out;
}

async function fastSource(ctx: SourceCtx): Promise<SourceResult> {
  const rows = await all<FastRow>(ctx, FAST_SQL, [ctx.windowStart, EVENTS_SOURCE_ROW_CAP]);
  const names = await brandNames(ctx, rows.map((r) => r.target_brand_id).filter((x): x is string => !!x));
  const events = buildFastEvents(rows, names);
  return { events, total: sumCounts(events), capped: rows.length >= EVENTS_SOURCE_ROW_CAP };
}

// ── 4. lookalike ──────────────────────────────────────────────────────────────

export const LOOKALIKES_SQL = `
  SELECT ld.id, ld.domain, ld.brand_id, b.name AS brand_name, ld.first_seen, ld.threat_level
  FROM lookalike_domains ld
  LEFT JOIN brands b ON b.id = ld.brand_id
  WHERE ld.first_seen >= ? AND ld.registration_evidence IN ('nrd', 'observed') AND ld.status != 'benign'
  ORDER BY ld.first_seen DESC
  LIMIT ?`;

export interface LookalikeRow {
  id: string;
  domain: string;
  brand_id: string | null;
  brand_name: string | null;
  first_seen: string;
  threat_level: string | null;
}

/** Pure: lookalike rows (newest first) → events. */
export function buildLookalikeEvents(rows: readonly LookalikeRow[]): ObservatoryEvent[] {
  const names = new Map<string, string>();
  for (const r of rows) if (r.brand_id && r.brand_name?.trim()) names.set(r.brand_id, r.brand_name.trim());
  const { groups, singles } = burstsByBrand(rows, (r) => r.brand_id, names);
  const out: ObservatoryEvent[] = [];
  for (const g of groups) {
    const brand = names.get(g.brandId)!;
    const newest = g.rows[0]!;
    out.push({
      id: `lookalike:brand:${g.brandId}`,
      kind: "lookalike",
      severity: g.rows.reduce<EventSeverity>((s, r) => {
        const v = normalizeSeverity(r.threat_level, "medium");
        return SEVERITY_ORDER.indexOf(v) < SEVERITY_ORDER.indexOf(s) ? v : s;
      }, "low"),
      title: fitTitle(`${brand} has ${g.rows.length} new lookalikes registered, incl. ${newest.domain}`),
      entity: { type: "brand", id: g.brandId, name: brand },
      place: NO_PLACE,
      count: g.rows.length,
      occurred_at: toIsoUtc(newest.first_seen) ?? new Date().toISOString(),
      source: "lookalike_scanner",
      target: { lens: "threats" },
    });
  }
  for (const r of singles) {
    const brand = r.brand_id ? names.get(r.brand_id) ?? null : null;
    out.push({
      id: `lookalike:${r.id}`,
      kind: "lookalike",
      severity: normalizeSeverity(r.threat_level, "medium"),
      title: fitTitle(brand ? `${brand} has a new lookalike registered: ${r.domain}` : `New lookalike registered: ${r.domain}`),
      entity: { type: "domain", id: r.id, name: r.domain },
      place: NO_PLACE,
      count: 1,
      occurred_at: toIsoUtc(r.first_seen) ?? new Date().toISOString(),
      source: "lookalike_scanner",
      target: { lens: "threats" },
    });
  }
  return out;
}

async function lookalikeSource(ctx: SourceCtx): Promise<SourceResult> {
  const rows = await all<LookalikeRow>(ctx, LOOKALIKES_SQL, [ctx.windowStart, EVENTS_SOURCE_ROW_CAP]);
  const events = buildLookalikeEvents(rows);
  return { events, total: sumCounts(events), capped: rows.length >= EVENTS_SOURCE_ROW_CAP };
}

// ── 5. takedown (manage_takedowns only) ───────────────────────────────────────

// INDEXED BY the partial (resolved_at) WHERE status = 'taken_down' index
// (migration 0307): left to itself the planner takes idx_takedown_status —
// every taken-down row ever, plus a sort. Migrations apply before the Worker
// deploys (deploy-radar.yml), so the index exists whenever this runs.
export const TAKEDOWNS_SQL = `
  SELECT tr.id, tr.target_value, tr.brand_id, b.name AS brand_name, tr.source_type, tr.source_id,
         tr.requested_at, tr.submitted_at, tr.created_at, tr.resolved_at
  FROM takedown_requests tr INDEXED BY idx_takedown_taken_down_resolved
  LEFT JOIN brands b ON b.id = tr.brand_id
  WHERE tr.status = 'taken_down' AND tr.resolved_at >= ?
  ORDER BY tr.resolved_at DESC
  LIMIT ?`;

export interface TakedownRow {
  id: string;
  target_value: string | null;
  brand_id: string | null;
  brand_name: string | null;
  source_type: string | null;
  source_id: string | null;
  requested_at: string | null;
  submitted_at: string | null;
  created_at: string | null;
  resolved_at: string;
}

export interface TakedownThreatRow { id: string; country_code: string | null; lat: number | null; lng: number | null; hosting_provider_id: string | null }

export const takedownThreatsSql = (n: number) =>
  `SELECT id, country_code, lat, lng, hosting_provider_id FROM threats WHERE id IN (${placeholders(n)})`;

/** Submit → takedown hours (submitted_at, else requested_at, else created_at). */
export function takedownHours(r: Pick<TakedownRow, "submitted_at" | "requested_at" | "created_at" | "resolved_at">): number | null {
  return hoursBetween(r.submitted_at ?? r.requested_at ?? r.created_at, r.resolved_at);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Pure: taken-down rows (newest first) + source threats → events. */
export function buildTakedownEvents(rows: readonly TakedownRow[], threats: ReadonlyMap<string, TakedownThreatRow>): ObservatoryEvent[] {
  const usable = rows.filter((r) => displayHost(r.target_value) !== null);
  const names = new Map<string, string>();
  for (const r of usable) if (r.brand_id && r.brand_name?.trim()) names.set(r.brand_id, r.brand_name.trim());
  const threatOf = (r: TakedownRow) => (r.source_type === "threat" && r.source_id ? threats.get(r.source_id) ?? null : null);
  const located = (r: TakedownRow) => {
    const t = threatOf(r);
    return { country_code: t?.country_code ?? null, lat: t?.lat ?? null, lng: t?.lng ?? null };
  };
  const targetFor = (t: TakedownThreatRow | null): ObservatoryEvent["target"] =>
    t?.hosting_provider_id ? { lens: "hosting", select: `provider:${t.hosting_provider_id}` } : { lens: "hosting" };

  const { groups, singles } = burstsByBrand(usable, (r) => r.brand_id, names);
  const out: ObservatoryEvent[] = [];
  for (const g of groups) {
    const brand = names.get(g.brandId)!;
    const med = median(g.rows.map(takedownHours).filter((h): h is number => h !== null));
    out.push({
      id: `takedown:brand:${g.brandId}`,
      kind: "takedown",
      severity: "info",
      title: fitTitle(`${brand} had ${g.rows.length} takedowns completed${med === null ? "" : ` · median ${durationPhrase(med)}`}`),
      entity: { type: "brand", id: g.brandId, name: brand },
      place: dominantPlace(g.rows.map(located)),
      count: g.rows.length,
      occurred_at: toIsoUtc(g.rows[0]!.resolved_at) ?? new Date().toISOString(),
      source: "sparrow",
      target: targetFor(threatOf(g.rows[0]!)),
    });
  }
  for (const r of singles) {
    const host = displayHost(r.target_value)!;
    const h = takedownHours(r);
    const t = threatOf(r);
    out.push({
      id: `takedown:${r.id}`,
      kind: "takedown",
      severity: "info",
      title: fitTitle(h === null ? `${host} taken down` : h < 1 ? `${host} taken down within an hour` : `${host} taken down after ${durationPhrase(h)}`),
      entity: { type: "domain", id: r.id, name: host },
      place: t ? placeFor(t.country_code, t.lat, t.lng) : NO_PLACE,
      count: 1,
      occurred_at: toIsoUtc(r.resolved_at) ?? new Date().toISOString(),
      source: "sparrow",
      target: targetFor(t),
    });
  }
  return out;
}

async function takedownSource(ctx: SourceCtx): Promise<SourceResult> {
  const rows = await all<TakedownRow>(ctx, TAKEDOWNS_SQL, [ctx.windowStart, EVENTS_SOURCE_ROW_CAP]);
  const ids = [...new Set(rows.filter((r) => r.source_type === "threat" && r.source_id).map((r) => r.source_id as string))];
  const threats = new Map<string, TakedownThreatRow>();
  for (const part of chunk(ids, LENS_MAX_BINDS)) {
    for (const t of await all<TakedownThreatRow>(ctx, takedownThreatsSql(part.length), part)) threats.set(t.id, t);
  }
  const events = buildTakedownEvents(rows, threats);
  return { events, total: sumCounts(events), capped: rows.length >= EVENTS_SOURCE_ROW_CAP };
}

// ── 6. actor ──────────────────────────────────────────────────────────────────

// First link of (cluster, actor) in the window: the NOT EXISTS probe is
// keyed on the cluster (idx_attribution_pulse) and stops at the first older
// row, so it reads at most the window's own rows for that cluster. The unary
// `+` on its other terms keeps the planner off idx_attribution_actor
// (actor_id, observed_at), which would walk EVERY older attribution of that
// actor — OTX rows included — to prove a new link has no history.
export const ACTOR_LINKS_SQL = `
  SELECT ta.source_pulse_id AS cluster_id, ta.actor_id AS actor_id, MAX(ta.observed_at) AS at,
         MIN(ta.source) AS source, COUNT(*) AS n
  FROM threat_attributions ta
  WHERE ta.source IN ('nexus', 'manual') AND ta.observed_at >= ?
    AND ta.source_pulse_id IS NOT NULL AND ta.actor_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM threat_attributions o
      WHERE o.source_pulse_id = ta.source_pulse_id AND +o.actor_id = ta.actor_id
        AND +o.source IN ('nexus', 'manual') AND +o.observed_at < ?
    )
  GROUP BY ta.source_pulse_id, ta.actor_id
  LIMIT ?`;

export interface ActorLinkRow { cluster_id: string; actor_id: string; at: string; source: string; n: number }

/** Pure: first links + live clusters → events (cluster must still carry the actor). */
export function buildActorEvents(links: readonly ActorLinkRow[], clusters: ReadonlyMap<string, LiveClusterRow>): ObservatoryEvent[] {
  const out: ObservatoryEvent[] = [];
  for (const l of links) {
    const c = clusters.get(l.cluster_id);
    if (!c || c.actor_id !== l.actor_id) continue; // retired, gone, dismissed or re-attributed
    const actorName = c.actor_name?.trim();
    if (!actorName) continue;
    out.push({
      id: `actor:${l.cluster_id}:${l.actor_id}`,
      kind: "actor",
      severity: "high",
      title: fitTitle(`${operationLabel(c.cluster_name)} linked to ${actorName}`),
      entity: { type: "actor", id: l.actor_id, name: actorName },
      place: placeFor(dominantClusterCountry(c.country_counts, c.countries)),
      count: 1,
      occurred_at: toIsoUtc(l.at) ?? new Date().toISOString(),
      source: l.source === "manual" ? "manual" : "attributor",
      target: { lens: "actors", select: `actor:${l.actor_id}` },
    });
  }
  return out;
}

async function actorSource(ctx: SourceCtx): Promise<SourceResult> {
  const links = await all<ActorLinkRow>(ctx, ACTOR_LINKS_SQL, [ctx.windowStart, ctx.windowStart, EVENTS_SOURCE_ROW_CAP]);
  const clusters = await liveClusters(ctx, links.map((l) => l.cluster_id));
  const events = buildActorEvents(links, clusters);
  return { events, total: sumCounts(events), capped: links.length >= EVENTS_SOURCE_ROW_CAP };
}

// ── 7. spike ──────────────────────────────────────────────────────────────────

// Same reads as /overindex (handlers/observatoryLenses.ts) over this window;
// `GROUP BY +country_code` keeps the planner on the idx_cube_geo_hour range.
export const SPIKE_GEO_SQL = `
  SELECT country_code, SUM(threat_count) AS n
  FROM threat_cube_geo
  WHERE hour_bucket >= ? AND country_code != 'XX'
  GROUP BY +country_code`;

export const SPIKE_RADAR_SQL = `
  SELECT country_code, value_pct
  FROM radar_country_snapshots
  WHERE metric = 'attack_origin'
    AND snapshot_date = (SELECT MAX(snapshot_date) FROM radar_country_snapshots WHERE metric = 'attack_origin')`;

/** Pure: over-index rows → spike events (ratio + volume gates). */
export function buildSpikeEvents(rows: readonly OverindexRow[], occurredAt: string): ObservatoryEvent[] {
  const out: ObservatoryEvent[] = [];
  for (const r of rows) {
    if (r.ratio === null || r.ratio < SPIKE_MIN_RATIO || r.our_count < SPIKE_MIN_COUNT) continue;
    const place = placeFor(r.country_code);
    const name = place.country_name ?? r.country_code;
    out.push({
      id: `spike:${r.country_code}`,
      kind: "spike",
      severity: r.ratio >= 5 ? "high" : "medium",
      title: fitTitle(`${name} at ${r.ratio.toFixed(1)}× its usual share of attack traffic`),
      entity: { type: "country", id: r.country_code, name },
      place,
      count: r.our_count,
      occurred_at: occurredAt,
      source: "cloudflare_radar",
      target: { lens: "baseline", select: `country:${r.country_code}` },
    });
  }
  return out;
}

async function spikeSource(ctx: SourceCtx): Promise<SourceResult> {
  let rows: OverindexRow[];
  if (ctx.period === "7d") {
    // Reuse the /overindex lens (same computation, its own 1800s cache).
    const res = await handleObservatoryOverindex(new Request("https://averrow.com/api/observatory/overindex?period=7d"), ctx.env);
    if (!res.ok) throw new Error(`overindex lens answered ${res.status}`);
    const body = (await res.json()) as { data?: OverindexRow[] };
    rows = Array.isArray(body.data) ? body.data : [];
  } else {
    const [ours, radar] = await Promise.all([
      all<{ country_code: string; n: number }>(ctx, SPIKE_GEO_SQL, [ctx.windowStart]),
      all<{ country_code: string; value_pct: number }>(ctx, SPIKE_RADAR_SQL, []),
    ]);
    rows = computeOverindex(ours, radar);
  }
  // "As of this hour": the window's newest hour bucket.
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const events = buildSpikeEvents(rows, now.toISOString());
  return { events, total: sumCounts(events), capped: false };
}

// ── Handler ───────────────────────────────────────────────────────────────────

const SOURCES: Record<EventKind, (ctx: SourceCtx) => Promise<SourceResult>> = {
  critical: criticalSource,
  operation: operationSource,
  fast: fastSource,
  lookalike: lookalikeSource,
  takedown: takedownSource,
  actor: actorSource,
  spike: spikeSource,
};

/** Kinds this caller may see: takedown needs manage_takedowns; no ctx → none (fail closed). */
export function permittedKinds(kinds: readonly EventKind[], canTakedowns: boolean): { kinds: EventKind[]; omitted: EventKind[] } {
  if (canTakedowns || !kinds.includes("takedown")) return { kinds: [...kinds], omitted: [] };
  return { kinds: kinds.filter((k) => k !== "takedown"), omitted: ["takedown"] };
}

export async function handleObservatoryEvents(
  request: Request,
  env: Env,
  ctx?: Pick<AuthContext, "role">,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const params = parseEventsParams(new URL(request.url));
  if (!params.ok) return json({ success: false, error: params.error }, 400, origin);

  const canTakedowns = ctx ? roleHasPermission(ctx.role, "manage_takedowns") : false;
  const { kinds, omitted } = permittedKinds(params.kinds, canTakedowns);
  const key = eventsCacheKey(params.period, params.kinds, params.limit, canTakedowns);

  const session = getReadSession(env, getDbContext(request));
  const tally = newTally();
  try {
    const payload = await cachedValue<EventsEnvelope>(env, key, EVENTS_TTL_S, async () => {
      const windowStart = eventsWindowStart(params.period);
      const sctx: SourceCtx = { session, tally, windowStart, limit: params.limit, period: params.period, env };
      const settled = await Promise.allSettled(kinds.map((k) => SOURCES[k](sctx)));
      const events: ObservatoryEvent[] = [];
      const counts: Partial<Record<EventKind, number>> = {};
      const capped: EventKind[] = [];
      const failed: EventKind[] = [];
      settled.forEach((s, i) => {
        const kind = kinds[i]!;
        if (s.status === "rejected") {
          failed.push(kind);
          return;
        }
        events.push(...s.value.events);
        counts[kind] = s.value.total;
        if (s.value.capped) capped.push(kind);
      });
      return {
        success: true,
        data: sortEvents(events).slice(0, params.limit),
        counts_by_kind: counts,
        meta: {
          generated_at: new Date().toISOString(),
          period: params.period,
          window_start: toIsoUtc(windowStart) ?? windowStart,
          kinds,
          limit: params.limit,
          omitted_kinds: omitted,
          capped_kinds: capped,
          failed_kinds: failed,
        },
      };
    });
    recordD1Reads(env, "observatory_events", tally);
    return attachBookmark(json(payload, 200, origin), session);
  } catch {
    recordD1Reads(env, "observatory_events", tally);
    return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
  }
}
