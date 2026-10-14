// Averrow — Observatory Phase B lens endpoints (B4)
//
//   GET /api/observatory/operations-geo — NEXUS operations + components
//   GET /api/observatory/movements      — pivot_detected migration trails
//   GET /api/observatory/providers-geo  — hosting providers by active threats
//   GET /api/observatory/overindex      — our country share vs Radar's
//   GET /api/observatory/campaigns-geo  — curated geopolitical campaigns
//   GET /api/observatory/timeline       — severity time series (cube-served)
//   GET /api/observatory/actors         — threat-actor list / detail
//   GET /api/observatory/takedowns-geo  — takedown outcomes by country/provider (B5)
//   GET /api/observatory/velocity-nodes — fast-weaponization map nodes (B5)
//
// Auth: every route is wrapped in requireStaff at the route layer
// (routes/dashboard.ts), exactly like the Phase A observatory routes. The
// `cv:observatory_lens.*` cache keys are therefore staff-audience only.
// Takedown effectiveness is narrower — `manage_takedowns` (super_admin,
// admin, analyst): takedowns-geo is gated on it at the route layer, and
// providers-geo keeps its takedown data in a separate cache entry that only
// flag holders read (see §3).
//
// Contract:
//   - Envelope `{ success: true, data, meta: { generated_at, period? } }`.
//     `generated_at` is when the payload was COMPUTED (it rides inside the
//     cached value), not when it was served.
//   - Invalid `period` (and the other enumerated params) → 400. Absent or
//     empty → the default. `limit` is clamped, never rejected (same rule as
//     parseObservatoryLimit).
//   - Every response is cached via cachedValue under a key that encodes
//     every canonicalised param; 400/404 paths never mint a key.
//   - No request-time GROUP BY / COUNT over `threats`: aggregates come from
//     the threat cubes, pre-computed hosting_providers columns, or small
//     side tables (clusters by index, threat_attributions by actor index).

import { json } from "../lib/cors";
import { getDbContext, getReadSession, attachBookmark } from "../lib/db";
import { newTally, addToTally, recordD1Reads, type D1Tally } from "../lib/analytics";
import { cachedValue } from "../lib/cached-value";
import { classifyClusterKind, isBridgeKind, type ClusterKind } from "../lib/cluster-components";
import {
  OBSERVATORY_PERIODS,
  type ObservatoryPeriod,
  parseObservatoryLimit,
  snappedWindowStart,
  buildSourceFilter,
  parseObservatorySourceFeed,
  sourceFeedCacheSegment,
  SEVERITY_RANK,
} from "./observatory";
import { getCountryCentroid } from "../lib/country-centroids";
import { rollupWindowStartDay } from "../lib/takedown-outcome-rollup";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { roleHasPermission } from "../lib/role-permissions";

type ReadSession = ReturnType<typeof getReadSession>;

/** Response TTLs (seconds). */
export const LENS_TTL_S = {
  operationsGeo: 900,
  movements: 900,
  providersGeo: 900,
  overindex: 1800,
  campaignsGeo: 3600,
  timelineShort: 300, // 24h
  timeline: 900,
  actors: 900,
  takedownsGeo: 3600,
  velocityNodes: 900,
} as const;

/** Max entries kept per JSON array field (countries, asns) in a response. */
export const LENS_ARRAY_CAP = 20;
/** D1 bind ceiling per statement (100) minus headroom. */
export const LENS_MAX_BINDS = 99;

const CACHE_NS = "observatory_lens";

// ── Shared plumbing ───────────────────────────────────────────────────────────

interface LensMeta {
  generated_at: string;
  period?: ObservatoryPeriod;
  [extra: string]: unknown;
}

interface LensEnvelope<T> {
  success: true;
  data: T;
  meta: LensMeta;
}

/** Thrown inside a compute to answer with a non-200 WITHOUT caching. */
export class LensHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function badRequest(request: Request, error: string): Response {
  return json({ success: false, error }, 400, request.headers.get("Origin"));
}

type LensCompute<T> = (session: ReadSession, tally: D1Tally) => Promise<{ data: T; meta?: Record<string, unknown> }>;

/**
 * Compute-or-read one cached lens envelope. cachedValue only writes after
 * `compute` resolves, so a LensHttpError thrown from inside it (e.g. 404
 * unknown actor) never mints a key.
 */
function lensEnvelope<T>(
  env: Env,
  key: string,
  ttl: number,
  period: ObservatoryPeriod | undefined,
  session: ReadSession,
  tally: D1Tally,
  compute: LensCompute<T>,
): Promise<LensEnvelope<T>> {
  return cachedValue<LensEnvelope<T>>(env, key, ttl, async () => {
    const r = await compute(session, tally);
    const meta: LensMeta = { generated_at: new Date().toISOString(), ...(r.meta ?? {}) };
    if (period) meta.period = period;
    return { success: true, data: r.data, meta };
  });
}

function lensErrorResponse(err: unknown, origin: string | null, session: ReadSession): Response {
  if (err instanceof LensHttpError) {
    return attachBookmark(json({ success: false, error: err.message }, err.status, origin), session);
  }
  return attachBookmark(json({ success: false, error: "An internal error occurred" }, 500, origin), session);
}

/** Run a lens compute behind cachedValue and answer with the envelope. */
async function serveLens<T>(
  request: Request,
  env: Env,
  label: string,
  key: string,
  ttl: number,
  period: ObservatoryPeriod | undefined,
  compute: LensCompute<T>,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const session = getReadSession(env, getDbContext(request));
  const tally = newTally();
  try {
    const payload = await lensEnvelope(env, key, ttl, period, session, tally, compute);
    recordD1Reads(env, label, tally);
    return attachBookmark(json(payload, 200, origin), session);
  } catch (err) {
    recordD1Reads(env, label, tally);
    return lensErrorResponse(err, origin, session);
  }
}

/**
 * Strict period: absent / empty → `fallback`; an allow-listed value → that
 * value; anything else → null (the caller answers 400). Unlike the Phase A
 * parseObservatoryPeriod, garbage is rejected, not canonicalised.
 */
export function parseLensPeriod(
  raw: string | null,
  allowed: readonly ObservatoryPeriod[] = OBSERVATORY_PERIODS,
  fallback: ObservatoryPeriod = "7d",
): ObservatoryPeriod | null {
  if (raw === null || raw === "") return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as ObservatoryPeriod) : null;
}

/**
 * Parse a JSON-array TEXT column into a deduped string list, capped. Any
 * malformed / non-array / non-string content degrades to [] (or is skipped
 * element-wise) — a bad row must never 500 the endpoint.
 */
export function parseJsonStringArray(raw: unknown, cap: number = LENS_ARRAY_CAP): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  return dedupeStrings(Array.isArray(v) ? v : [], cap);
}

function dedupeStrings(values: readonly unknown[], cap: number, map: (s: string) => string | null = (s) => s): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of values) {
    if (typeof x !== "string") continue;
    const s = map(x.trim());
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** ISO-2 country code (upper-case), or null. The 'XX' unknown sentinel → null. */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" ? c : null;
}

/** Canonical ASN string `AS<digits>` (hosting_providers.asn form), or null. */
export function normalizeAsn(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim().toUpperCase();
  if (/^\d+$/.test(a)) return `AS${a}`;
  return /^AS\d+$/.test(a) ? a : null;
}

function countryList(values: readonly unknown[], cap = LENS_ARRAY_CAP): string[] {
  return dedupeStrings(values, cap, (s) => normalizeCountry(s));
}

function asnList(values: readonly unknown[], cap = LENS_ARRAY_CAP): string[] {
  return dedupeStrings(values, cap, (s) => normalizeAsn(s));
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

function severitySums(severityCol: string, countExpr: string): string {
  return SEVERITY_RANK.map(
    (s) => `SUM(CASE WHEN LOWER(${severityCol}) = '${s}' THEN ${countExpr} ELSE 0 END) AS ${s}`,
  ).join(",\n        ");
}

// ── 1. GET /api/observatory/operations-geo ────────────────────────────────────
//
//   status  active (default) | all      — anything else → 400
//   limit   1..50, default 25
//
// Operations are the top-N infrastructure_clusters by threat_count
// (idx_clusters_threat_count, migration 0298). Components group the RETURNED
// operations by component_id (S2.4 connected-components label).
//
// Edges: the component layer stores only the label, not the union-find
// edges, so edges are drawn as a STAR from the component's hub — its
// representative bridge cluster (component_id = `component_<bridge id>`) when
// that cluster is among the returned operations, else the first returned
// bridge-kind member, else the first member. `kind` is the bridge kind
// (cert_serial | cert_san | per_ip) of the hub when the hub is a bridge;
// otherwise the representative's kind. A cert representative that is not
// among the returned operations is resolved by one extra PK lookup (its
// agent_notes cluster_type disambiguates serial vs SAN — the id prefix
// `cluster_cert_` is shared); when it can't be resolved (row gone /
// notes unreadable) `kind` is null rather than a guessed cert_serial.
// ASN, /24 and registrar clusters never bridge (lib/cluster-components.ts).
export const OPERATIONS_GEO_DEFAULT_LIMIT = 25;
export const OPERATIONS_GEO_MAX_LIMIT = 50;

type BridgeKind = "cert_serial" | "cert_san" | "per_ip";

export interface OperationGeo {
  id: string;
  name: string | null;
  component_id: string | null;
  kind: ClusterKind;
  status: string | null;
  confidence_score: number | null;
  threat_count: number;
  actor: { id: string; name: string } | null;
  countries: string[];
  asns: string[];
  last_seen: string | null;
  last_movement_pivot_at: string | null;
}

export interface ComponentEdge {
  a: string;
  b: string;
  /** null when the representative's bridge kind could not be resolved. */
  kind: BridgeKind | null;
  shared_asns: string[];
}

export interface ComponentGeo {
  component_id: string;
  operation_ids: string[];
  countries: string[];
  edges: ComponentEdge[];
}

interface OperationRow {
  id: string;
  cluster_name: string | null;
  component_id: string | null;
  status: string | null;
  confidence_score: number | null;
  threat_count: number | null;
  countries: string | null;
  asns: string | null;
  last_seen: string | null;
  last_movement_pivot_at: string | null;
  cluster_type: string | null;
  actor_id: string | null;
  actor_name: string | null;
}

/** Cluster kind from id + the (already-extracted) cert cluster_type. */
function kindOf(id: string, clusterType: string | null): ClusterKind {
  return classifyClusterKind(id, clusterType ? JSON.stringify({ cluster_type: clusterType }) : null);
}

function asBridgeKind(kind: ClusterKind): BridgeKind | null {
  return isBridgeKind(kind) ? (kind as BridgeKind) : null;
}

/** Representative cluster id of a component (`component_<rep id>`), or "". */
export function componentRepId(componentId: string): string {
  return componentId.startsWith("component_") ? componentId.slice("component_".length) : "";
}

/**
 * Bridge kind of a representative from its id alone, or null when the id
 * cannot decide it: cert reps (`cluster_cert_`) need agent_notes to tell
 * serial from SAN, and a non-bridge id has no bridge kind.
 */
function repKindFromId(repId: string): BridgeKind | null {
  if (repId === "" || repId.startsWith("cluster_cert_")) return null;
  return asBridgeKind(classifyClusterKind(repId, null));
}

/**
 * Pure: build components + star edges from shaped operations.
 * `repKinds` carries the resolved kind of representatives that are NOT among
 * `ops` (see the handler's extra lookup); without an entry a cert rep's kind
 * is null, never guessed.
 */
export function buildComponents(
  ops: readonly OperationGeo[],
  repKinds: ReadonlyMap<string, ClusterKind> = new Map(),
): ComponentGeo[] {
  const byComponent = new Map<string, OperationGeo[]>();
  for (const op of ops) {
    if (!op.component_id) continue;
    const list = byComponent.get(op.component_id) ?? [];
    list.push(op);
    byComponent.set(op.component_id, list);
  }
  const out: ComponentGeo[] = [];
  for (const [componentId, members] of byComponent) {
    const repId = componentRepId(componentId);
    const hub =
      members.find((m) => m.id === repId) ??
      members.find((m) => isBridgeKind(m.kind)) ??
      members[0]!;
    const resolvedRep = repKinds.get(repId);
    const edgeKind: BridgeKind | null =
      asBridgeKind(hub.kind) ??
      (resolvedRep !== undefined ? asBridgeKind(resolvedRep) : repKindFromId(repId));
    const edges: ComponentEdge[] = [];
    const hubAsns = new Set(hub.asns);
    for (const m of members) {
      if (m.id === hub.id) continue;
      edges.push({ a: hub.id, b: m.id, kind: edgeKind, shared_asns: m.asns.filter((x) => hubAsns.has(x)) });
    }
    out.push({
      component_id: componentId,
      operation_ids: members.map((m) => m.id),
      countries: countryList(members.flatMap((m) => m.countries)),
      edges,
    });
  }
  return out;
}

/**
 * Cert representatives the pure builder can't classify: components with ≥2
 * returned members (edges exist), no bridge-kind member returned, and a
 * `cluster_cert_` representative outside the returned set.
 */
export function unresolvedCertReps(ops: readonly OperationGeo[]): string[] {
  const byComponent = new Map<string, OperationGeo[]>();
  for (const op of ops) {
    if (!op.component_id) continue;
    const list = byComponent.get(op.component_id) ?? [];
    list.push(op);
    byComponent.set(op.component_id, list);
  }
  const out: string[] = [];
  for (const [componentId, members] of byComponent) {
    const repId = componentRepId(componentId);
    if (members.length < 2 || !repId.startsWith("cluster_cert_")) continue;
    if (members.some((m) => m.id === repId || isBridgeKind(m.kind))) continue;
    out.push(repId);
  }
  return out;
}

function shapeOperation(r: OperationRow): OperationGeo {
  return {
    id: r.id,
    name: r.cluster_name ?? null,
    component_id: r.component_id ?? null,
    kind: kindOf(r.id, r.cluster_type),
    status: r.status ?? null,
    confidence_score: r.confidence_score ?? null,
    threat_count: num(r.threat_count),
    actor: r.actor_id && r.actor_name ? { id: r.actor_id, name: r.actor_name } : null,
    countries: countryList(parseJsonStringArray(r.countries, Number.MAX_SAFE_INTEGER)),
    asns: asnList(parseJsonStringArray(r.asns, Number.MAX_SAFE_INTEGER)),
    last_seen: r.last_seen ?? null,
    last_movement_pivot_at: r.last_movement_pivot_at ?? null,
  };
}

export async function handleObservatoryOperationsGeo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus === null || rawStatus === "" ? "active" : rawStatus;
  if (status !== "active" && status !== "all") return badRequest(request, "status must be active or all");
  const limit = parseObservatoryLimit(url.searchParams.get("limit"), OPERATIONS_GEO_DEFAULT_LIMIT, OPERATIONS_GEO_MAX_LIMIT);

  return serveLens(request, env, "observatory_operations_geo",
    `${CACHE_NS}.operations_geo:${status}:${limit}`, LENS_TTL_S.operationsGeo, undefined,
    async (session, tally) => {
      const where = status === "active" ? "WHERE c.status = 'active'" : "";
      const rows = await session.prepare(`
        SELECT c.id, c.cluster_name, c.component_id, c.status, c.confidence_score,
               c.threat_count, c.countries, c.asns, c.last_seen, c.last_movement_pivot_at,
               CASE WHEN c.id LIKE 'cluster_cert_%' AND json_valid(c.agent_notes)
                    THEN json_extract(c.agent_notes, '$.cluster_type') END AS cluster_type,
               c.actor_id, a.name AS actor_name
        FROM infrastructure_clusters c
        LEFT JOIN threat_actors a ON a.id = c.actor_id
        ${where}
        ORDER BY c.threat_count DESC, c.id
        LIMIT ?
      `).bind(limit).all<OperationRow>();
      addToTally(tally, rows.meta);
      const operations = (rows.results ?? []).map(shapeOperation);
      // Resolve cert representatives outside the returned set by PK (at
      // most one per component, ≤50 → one statement in practice).
      const repKinds = new Map<string, ClusterKind>();
      for (const ids of chunk(unresolvedCertReps(operations), LENS_MAX_BINDS)) {
        const r = await session.prepare(`
          SELECT id,
                 CASE WHEN json_valid(agent_notes) THEN json_extract(agent_notes, '$.cluster_type') END AS cluster_type
          FROM infrastructure_clusters
          WHERE id IN (${placeholders(ids.length)})
        `).bind(...ids).all<{ id: string; cluster_type: string | null }>();
        addToTally(tally, r.meta);
        // Only a row with a readable cluster_type is resolved; anything
        // else stays unresolved → kind null (never a defaulted cert_serial).
        for (const row of r.results ?? []) {
          if (typeof row.cluster_type === "string" && row.cluster_type !== "") {
            repKinds.set(row.id, kindOf(row.id, row.cluster_type));
          }
        }
      }
      return { data: { operations, components: buildComponents(operations, repKinds) } };
    });
}

// ── 2. GET /api/observatory/movements ─────────────────────────────────────────
//
//   period  24h | 7d (default) | 30d | 90d  — anything else → 400
//   limit   1..100, default 50
//
// pivot_detected events (agent_events, idx_agent_events_type_created —
// migration 0298) in the snapped window, newest first. payload_v 2 carries
// ASN lists (lib/cluster-infra-movement.ts):
//   infra_movement  from = prev_asn_list, to = new_asn_list
//   dormancy        from = [prev_asn ?? asn], to = [] (the cluster went dark)
// v1 infra_movement payloads carry no lists → from/to empty (counts still
// come from the v1 keys); v1 dormancy payloads carry `asn`, so their `from`
// is filled like v2. ASN → country via hosting_providers.asn (≤99 binds per IN query).
export const MOVEMENTS_DEFAULT_LIMIT = 50;
export const MOVEMENTS_MAX_LIMIT = 100;

export interface MovementEndpoint {
  asns: string[];
  countries: string[];
}

export interface Movement {
  id: string;
  kind: "infra_movement" | "dormancy";
  cluster_id: string | null;
  cluster_name: string | null;
  at: string;
  from: MovementEndpoint;
  to: MovementEndpoint;
  counts: { new_asns: number; new_ips: number; new_serials: number };
  payload_v: number;
}

interface PivotRow {
  id: string;
  created_at: string;
  payload_json: string | null;
}

interface ParsedPivot {
  id: string;
  at: string;
  kind: "infra_movement" | "dormancy";
  cluster_id: string | null;
  cluster_name: string | null;
  fromAsns: string[];
  toAsns: string[];
  counts: Movement["counts"];
  payload_v: number;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Pure: one pivot_detected row → movement minus country resolution. */
export function parsePivotRow(row: PivotRow): ParsedPivot {
  const p = parsePayload(row.payload_json);
  const kind = p.kind === "infra_movement" ? "infra_movement" : "dormancy";
  const payload_v = typeof p.payload_v === "number" && Number.isFinite(p.payload_v) ? p.payload_v : 1;
  let fromAsns: string[] = [];
  let toAsns: string[] = [];
  if (kind === "infra_movement") {
    // Only v2 infra_movement payloads carry the ASN lists.
    if (payload_v >= 2) {
      fromAsns = asnList(Array.isArray(p.prev_asn_list) ? p.prev_asn_list : []);
      toAsns = asnList(Array.isArray(p.new_asn_list) ? p.new_asn_list : []);
    }
  } else {
    // Dormancy has carried `asn` since v1 (v2 adds `prev_asn` = `asn`), so
    // the origin ASN is available regardless of payload version.
    fromAsns = asnList([p.prev_asn ?? p.asn]);
  }
  return {
    id: row.id,
    at: row.created_at,
    kind,
    cluster_id: str(p.cluster_id),
    cluster_name: str(p.cluster_name),
    fromAsns,
    toAsns,
    counts: {
      new_asns: kind === "infra_movement" ? num(p.new_asns) : 0,
      new_ips: kind === "infra_movement" ? num(p.new_ips) : 0,
      new_serials: kind === "infra_movement" ? num(p.new_serials) : 0,
    },
    payload_v,
  };
}

export async function handleObservatoryMovements(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const period = parseLensPeriod(url.searchParams.get("period"));
  if (!period) return badRequest(request, "invalid period");
  const limit = parseObservatoryLimit(url.searchParams.get("limit"), MOVEMENTS_DEFAULT_LIMIT, MOVEMENTS_MAX_LIMIT);

  return serveLens(request, env, "observatory_movements",
    `${CACHE_NS}.movements:${period}:${limit}`, LENS_TTL_S.movements, period,
    async (session, tally) => {
      const rows = await session.prepare(`
        SELECT id, created_at, payload_json
        FROM agent_events
        WHERE event_type = 'pivot_detected' AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(snappedWindowStart(period), limit).all<PivotRow>();
      addToTally(tally, rows.meta);
      const parsed = (rows.results ?? []).map(parsePivotRow);

      // Cluster names the payload didn't carry (v1 / dormancy without name).
      const nameless = [...new Set(parsed.filter((m) => !m.cluster_name && m.cluster_id).map((m) => m.cluster_id as string))];
      const names = new Map<string, string>();
      for (const ids of chunk(nameless, LENS_MAX_BINDS)) {
        const r = await session.prepare(
          `SELECT id, cluster_name FROM infrastructure_clusters WHERE id IN (${placeholders(ids.length)})`,
        ).bind(...ids).all<{ id: string; cluster_name: string | null }>();
        addToTally(tally, r.meta);
        for (const row of r.results ?? []) if (row.cluster_name) names.set(row.id, row.cluster_name);
      }

      const asns = [...new Set(parsed.flatMap((m) => [...m.fromAsns, ...m.toAsns]))];
      const asnCountry = new Map<string, string>();
      for (const ids of chunk(asns, LENS_MAX_BINDS)) {
        const r = await session.prepare(
          `SELECT asn, country FROM hosting_providers WHERE asn IN (${placeholders(ids.length)})`,
        ).bind(...ids).all<{ asn: string; country: string | null }>();
        addToTally(tally, r.meta);
        for (const row of r.results ?? []) {
          const c = normalizeCountry(row.country);
          if (c) asnCountry.set(row.asn, c);
        }
      }
      const endpoint = (list: string[]): MovementEndpoint => ({
        asns: list,
        countries: countryList(list.map((a) => asnCountry.get(a) ?? null)),
      });

      const data: Movement[] = parsed.map((m) => ({
        id: m.id,
        kind: m.kind,
        cluster_id: m.cluster_id,
        cluster_name: m.cluster_name ?? (m.cluster_id ? names.get(m.cluster_id) ?? null : null),
        at: m.at,
        from: endpoint(m.fromAsns),
        to: endpoint(m.toAsns),
        counts: m.counts,
        payload_v: m.payload_v,
      }));
      return { data };
    });
}

// ── 3. GET /api/observatory/providers-geo ─────────────────────────────────────
//
//   limit        1..200, default 100
//   bulletproof  0 (default, every provider) | 1 (is_bulletproof only) → else 400
//
// Pre-computed hosting_providers columns only, ordered by
// active_threat_count DESC (idx_providers_active_threats). No id tie-break:
// it would defeat the index and force a full sort of ~12.8K rows per miss.
//
// `takedown` — {share, median_hours, n} from takedown_outcome_daily
// (dim='provider', last 90 days), matched on hosting_providers.id ==
// rollup `key` (the source threat's hosting_provider_id — the rollup never
// keys on the free-text takedown_requests.provider_name, which names the
// abuse contact, not the host). null when the provider has no submitted
// takedown in the window. See foldTakedownCells for share / median_hours.
//
// RBAC: takedown effectiveness is `manage_takedowns` data (same gate as
// /api/admin/takedowns/metrics and /api/observatory/takedowns-geo). The
// route is requireStaff, so the takedown data lives in a SEPARATE cache
// entry from the provider list:
//   cv:observatory_lens.providers_geo_base:<limit>:bp<0|1>  — no takedown field
//   cv:observatory_lens.providers_geo_takedown:90d          — [id, takedown][]
// Every caller reads the base; only a `manage_takedowns` holder reads the
// takedown entry, and it is merged per response. A caller without the flag
// gets `takedown: null` on every row (shape unchanged) and never causes the
// rollup to be read. The handler defaults to NO takedown when called
// without an AuthContext (fail closed).
export const PROVIDERS_GEO_DEFAULT_LIMIT = 100;
export const PROVIDERS_GEO_MAX_LIMIT = 200;
const PROVIDERS_GEO_TAKEDOWN_DAYS = 90;

interface ProviderRow {
  id: string;
  name: string;
  asn: string | null;
  country: string | null;
  active_threat_count: number | null;
  total_threat_count: number | null;
  trend_7d: number | null;
  trend_30d: number | null;
  is_bulletproof: number | null;
  reputation_score: number | null;
}

interface ProviderGeoBase {
  id: string;
  name: string;
  asn: string | null;
  country: string | null;
  active_threat_count: number;
  total_threat_count: number;
  trend_7d: number;
  trend_30d: number;
  is_bulletproof: boolean;
  reputation_score: number | null;
}

type ProviderTakedown = NonNullable<ReturnType<typeof providerTakedown>>;

export async function handleObservatoryProvidersGeo(
  request: Request,
  env: Env,
  ctx?: Pick<AuthContext, "role">,
): Promise<Response> {
  const url = new URL(request.url);
  const rawBp = url.searchParams.get("bulletproof");
  const bp = rawBp === null || rawBp === "" ? "0" : rawBp;
  if (bp !== "0" && bp !== "1") return badRequest(request, "bulletproof must be 0 or 1");
  const limit = parseObservatoryLimit(url.searchParams.get("limit"), PROVIDERS_GEO_DEFAULT_LIMIT, PROVIDERS_GEO_MAX_LIMIT);
  const canSeeTakedowns = ctx ? roleHasPermission(ctx.role, "manage_takedowns") : false;

  const origin = request.headers.get("Origin");
  const session = getReadSession(env, getDbContext(request));
  const tally = newTally();
  try {
    const base = await lensEnvelope<ProviderGeoBase[]>(env,
      `${CACHE_NS}.providers_geo_base:${limit}:bp${bp}`, LENS_TTL_S.providersGeo, undefined, session, tally,
      async (s, t) => {
        const where = bp === "1" ? "WHERE is_bulletproof = 1" : "";
        const rows = await s.prepare(`
          SELECT id, name, asn, country, active_threat_count, total_threat_count,
                 trend_7d, trend_30d, is_bulletproof, reputation_score
          FROM hosting_providers
          ${where}
          ORDER BY active_threat_count DESC
          LIMIT ?
        `).bind(limit).all<ProviderRow>();
        addToTally(t, rows.meta);
        const data = (rows.results ?? []).map((r): ProviderGeoBase => ({
          id: r.id,
          name: r.name,
          asn: r.asn ?? null,
          country: normalizeCountry(r.country),
          active_threat_count: num(r.active_threat_count),
          total_threat_count: num(r.total_threat_count),
          trend_7d: num(r.trend_7d),
          trend_30d: num(r.trend_30d),
          is_bulletproof: r.is_bulletproof === 1,
          reputation_score: r.reputation_score ?? null,
        }));
        return { data };
      });

    let takedowns: Map<string, ProviderTakedown> | null = null;
    if (canSeeTakedowns) {
      // One read of the provider rollup window (≤90 days × the few providers
      // that ever had a threat-sourced takedown), folded in JS. Cached as
      // pairs (not an object) so a provider id can never collide with an
      // Object.prototype key.
      const td = await lensEnvelope<Array<[string, ProviderTakedown]>>(env,
        `${CACHE_NS}.providers_geo_takedown:${PROVIDERS_GEO_TAKEDOWN_DAYS}d`, LENS_TTL_S.providersGeo, undefined,
        session, tally,
        async (s, t) => {
          const res = await s.prepare(TAKEDOWN_ROLLUP_READ_SQL)
            .bind("provider", rollupWindowStartDay(new Date(), PROVIDERS_GEO_TAKEDOWN_DAYS))
            .all<TakedownRollupRow>();
          addToTally(t, res.meta);
          const pairs: Array<[string, ProviderTakedown]> = [];
          for (const [id, agg] of foldTakedownCells(res.results ?? [])) {
            const v = providerTakedown(agg);
            if (v) pairs.push([id, v]);
          }
          return { data: pairs };
        });
      takedowns = new Map(td.data);
    }

    // `takedown` is always set explicitly (never spread from the cached base),
    // so a non-holder can only ever see null here.
    const data = base.data.map((p) => ({ ...p, takedown: takedowns?.get(p.id) ?? null }));
    recordD1Reads(env, "observatory_providers_geo", tally);
    return attachBookmark(json({ ...base, data }, 200, origin), session);
  } catch (err) {
    recordD1Reads(env, "observatory_providers_geo", tally);
    return lensErrorResponse(err, origin, session);
  }
}

// ── 4. GET /api/observatory/overindex ─────────────────────────────────────────
//
//   period  7d (default) | 30d   — anything else (incl. 24h/90d) → 400
//
// Our side: threat_cube_geo SUM(threat_count) per country over the snapped
// window (the geo cube holds ACTIVE, geolocated threats only); 'XX' excluded
// from both the rows and the share denominator.
// Radar side: the latest radar_country_snapshots 'attack_origin' snapshot
// (Radar's top-10 L7 attack origins, 7d range). Shares are FRACTIONS (0..1);
// Radar's value_pct is divided by 100. radar_share is null for a country
// outside Radar's top list; ratio = our_share / radar_share when
// radar_share > 0, else null. Rows: every country we see + every Radar
// country, ordered by our_count DESC, country_code.
const OVERINDEX_PERIODS: readonly ObservatoryPeriod[] = ["7d", "30d"];

export interface OverindexRow {
  country_code: string;
  our_count: number;
  our_share: number;
  radar_share: number | null;
  ratio: number | null;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Pure: join our per-country counts with Radar's per-country %. */
export function computeOverindex(
  ours: ReadonlyArray<{ country_code: string; n: number }>,
  radar: ReadonlyArray<{ country_code: string; value_pct: number }>,
): OverindexRow[] {
  const counts = new Map<string, number>();
  for (const r of ours) {
    const c = normalizeCountry(r.country_code);
    if (c) counts.set(c, (counts.get(c) ?? 0) + num(r.n));
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const radarShare = new Map<string, number>();
  for (const r of radar) {
    const c = normalizeCountry(r.country_code);
    if (c && Number.isFinite(r.value_pct)) radarShare.set(c, r.value_pct / 100);
  }
  const countries = new Set<string>([...counts.keys(), ...radarShare.keys()]);
  const rows: OverindexRow[] = [];
  for (const c of countries) {
    const our_count = counts.get(c) ?? 0;
    const our_share = total > 0 ? our_count / total : 0;
    const rs = radarShare.has(c) ? (radarShare.get(c) as number) : null;
    rows.push({
      country_code: c,
      our_count,
      our_share: round(our_share, 4),
      radar_share: rs === null ? null : round(rs, 4),
      ratio: rs !== null && rs > 0 ? round(our_share / rs, 2) : null,
    });
  }
  rows.sort((a, b) => b.our_count - a.our_count || a.country_code.localeCompare(b.country_code));
  return rows;
}

export async function handleObservatoryOverindex(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const period = parseLensPeriod(url.searchParams.get("period"), OVERINDEX_PERIODS);
  if (!period) return badRequest(request, "period must be 7d or 30d");

  return serveLens(request, env, "observatory_overindex",
    `${CACHE_NS}.overindex:${period}`, LENS_TTL_S.overindex, period,
    async (session, tally) => {
      const [ours, radar] = await Promise.all([
        session.prepare(`
          SELECT country_code, SUM(threat_count) AS n
          FROM threat_cube_geo
          WHERE hour_bucket >= ? AND country_code != 'XX'
          GROUP BY country_code
        `).bind(snappedWindowStart(period)).all<{ country_code: string; n: number }>(),
        session.prepare(`
          SELECT snapshot_date, country_code, value_pct
          FROM radar_country_snapshots
          WHERE metric = 'attack_origin'
            AND snapshot_date = (
              SELECT MAX(snapshot_date) FROM radar_country_snapshots WHERE metric = 'attack_origin'
            )
        `).all<{ snapshot_date: string; country_code: string; value_pct: number }>(),
      ]);
      addToTally(tally, ours.meta);
      addToTally(tally, radar.meta);
      const radarRows = radar.results ?? [];
      return {
        data: computeOverindex(ours.results ?? [], radarRows),
        meta: { radar_snapshot_date: radarRows[0]?.snapshot_date ?? null },
      };
    });
}

// ── 5. GET /api/observatory/campaigns-geo ─────────────────────────────────────
//
// Curated geopolitical_campaigns. NOTE: the production table has NO `slug`
// column (it predates the tracked migrations; 0064's CREATE TABLE IF NOT
// EXISTS never ran there), so `slug` is the row id — which the existing
// /api/campaigns/geo/:slug route resolves (`WHERE id = ? OR conflict = ?`).
// Selecting `slug` would 500 in production.
export const CAMPAIGNS_GEO_ROW_LIMIT = 200;

interface CampaignRow {
  id: string;
  name: string;
  conflict: string | null;
  status: string | null;
  threat_actors: string | null;
  adversary_countries: string | null;
  target_countries: string | null;
  start_date: string | null;
}

export async function handleObservatoryCampaignsGeo(request: Request, env: Env): Promise<Response> {
  return serveLens(request, env, "observatory_campaigns_geo",
    `${CACHE_NS}.campaigns_geo`, LENS_TTL_S.campaignsGeo, undefined,
    async (session, tally) => {
      const rows = await session.prepare(`
        SELECT id, name, conflict, status, threat_actors,
               adversary_countries, target_countries, start_date
        FROM geopolitical_campaigns
        ORDER BY start_date DESC, id
        LIMIT ${CAMPAIGNS_GEO_ROW_LIMIT}
      `).all<CampaignRow>();
      addToTally(tally, rows.meta);
      const data = (rows.results ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.id,
        status: r.status ?? null,
        conflict: r.conflict ?? null,
        adversary_countries: countryList(parseJsonStringArray(r.adversary_countries, Number.MAX_SAFE_INTEGER)),
        target_countries: countryList(parseJsonStringArray(r.target_countries, Number.MAX_SAFE_INTEGER)),
        threat_actors: parseJsonStringArray(r.threat_actors),
        start_date: r.start_date ?? null,
        curated: true as const,
      }));
      return { data };
    });
}

// ── 6. GET /api/observatory/timeline ──────────────────────────────────────────
//
//   period       24h | 7d (default) | 30d | 90d → else 400
//   source_feed  same canonicalisation as Phase A (absent / '' / all → all)
//   country      optional ISO-2 (case-insensitive) with a known centroid
//                (lib/country-centroids.ts) → else 400; 'XX' (unknown) → 400
//   velocity     optional very_fast | fast | all → else 400 (B5). When set
//                the series comes from threat_cube_velocity instead: `total`
//                = fast-weaponized active threats, plus `very_fast` / `fast`
//                per point; the severity fields stay in the shape but are 0
//                (the velocity cube has no severity dimension). The cube has
//                no source_feed dimension either, so velocity + a source_feed
//                other than all → 400.
//
// Buckets: 24h → 24×1h, 7d → 168×1h, 30d → 120×6h, 90d → 90×1d. Buckets are
// aligned to UTC boundaries (hour / 00-06-12-18 / midnight) and the LAST
// bucket is the one holding the current hour, so the window is the Phase A
// snapped window re-snapped to a bucket boundary (exactly N points, never a
// partial extra point). Missing buckets are zero-filled.
// Source: threat_cube_status (status='active') without `country`;
// threat_cube_geo (active + geolocated) with it — both ACTIVE-only so the two
// series are comparable.
const HOUR_MS = 3_600_000;

export interface TimelineSpec {
  bucket: "1h" | "6h" | "1d";
  bucketMs: number;
  points: number;
}

export const TIMELINE_SPECS: Record<ObservatoryPeriod, TimelineSpec> = {
  "24h": { bucket: "1h", bucketMs: HOUR_MS, points: 24 },
  "7d": { bucket: "1h", bucketMs: HOUR_MS, points: 168 },
  "30d": { bucket: "6h", bucketMs: 6 * HOUR_MS, points: 120 },
  "90d": { bucket: "1d", bucketMs: 24 * HOUR_MS, points: 90 },
};

export interface TimelinePoint {
  t: string;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** First bucket start (epoch ms) for a period, aligned to the bucket size. */
export function timelineStartMs(spec: TimelineSpec, now: Date = new Date()): number {
  const lastStart = Math.floor(now.getTime() / spec.bucketMs) * spec.bucketMs;
  return lastStart - (spec.points - 1) * spec.bucketMs;
}

/** 'YYYY-MM-DD HH:00:00' (cube hour_bucket form) for an epoch ms. */
function toHourBucket(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

interface TimelineRow {
  hour_bucket: string;
  total: number | null;
  critical: number | null;
  high: number | null;
  medium: number | null;
  low: number | null;
}

/** Pure: fold hourly cube rows into N zero-filled buckets. */
export function bucketTimeline(rows: readonly TimelineRow[], spec: TimelineSpec, startMs: number): TimelinePoint[] {
  const points: TimelinePoint[] = Array.from({ length: spec.points }, (_, k) => ({
    t: new Date(startMs + k * spec.bucketMs).toISOString(),
    total: 0, critical: 0, high: 0, medium: 0, low: 0,
  }));
  for (const r of rows) {
    const ms = Date.parse(`${r.hour_bucket.replace(" ", "T")}Z`);
    if (!Number.isFinite(ms)) continue;
    const k = Math.floor((ms - startMs) / spec.bucketMs);
    if (k < 0 || k >= spec.points) continue;
    const p = points[k]!;
    p.total += num(r.total);
    p.critical += num(r.critical);
    p.high += num(r.high);
    p.medium += num(r.medium);
    p.low += num(r.low);
  }
  return points;
}

export async function handleObservatoryTimeline(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const period = parseLensPeriod(url.searchParams.get("period"));
  if (!period) return badRequest(request, "invalid period");
  const rawCountry = url.searchParams.get("country");
  let country: string | null = null;
  if (rawCountry !== null && rawCountry !== "") {
    const c = rawCountry.trim().toUpperCase();
    // normalizeCountry rejects non-ISO-2 and the 'XX' sentinel; the centroid
    // check rejects syntactically valid but unknown codes, so a garbage
    // code can't mint its own cache key.
    if (normalizeCountry(c) === null || getCountryCentroid(c) === null) {
      return badRequest(request, "country must be a known ISO-3166 alpha-2 code");
    }
    country = c;
  }
  const source = parseObservatorySourceFeed(url.searchParams.get("source_feed"));
  if (!source.ok) return badRequest(request, "invalid source_feed (expected all, feeds or spam_trap)");
  const feed = source.feed;
  const spec = TIMELINE_SPECS[period];
  const ttl = period === "24h" ? LENS_TTL_S.timelineShort : LENS_TTL_S.timeline;
  const rawVelocity = url.searchParams.get("velocity");
  if (rawVelocity !== null && rawVelocity !== "") {
    const velocity = parseVelocityFlag(rawVelocity);
    if (!velocity) return badRequest(request, "velocity must be very_fast, fast or all");
    if (feed !== null) return badRequest(request, "source_feed is not supported with velocity");
    return serveLens(request, env, "observatory_timeline",
      `${CACHE_NS}.timeline:${period}:all:${country ?? "all"}:v:${velocity}`, ttl, period,
      async (session, tally) => {
        const startMs = timelineStartMs(spec);
        const binds: unknown[] = [toHourBucket(startMs)];
        let where = "hour_bucket >= ?";
        if (country) { where += " AND country_code = ?"; binds.push(country); }
        if (velocity !== "all") { where += " AND flag = ?"; binds.push(velocity); }
        const rows = await session.prepare(`
          SELECT hour_bucket, SUM(threat_count) AS total,
            SUM(CASE WHEN flag = 'very_fast' THEN threat_count ELSE 0 END) AS very_fast,
            SUM(CASE WHEN flag = 'fast' THEN threat_count ELSE 0 END) AS fast
          FROM threat_cube_velocity
          WHERE ${where}
          GROUP BY hour_bucket
        `).bind(...binds).all<VelocityTimelineRow>();
        addToTally(tally, rows.meta);
        return {
          data: { bucket: spec.bucket, points: bucketVelocityTimeline(rows.results ?? [], spec, startMs) },
          meta: { source_feed: "all", country, velocity },
        };
      });
  }

  return serveLens(request, env, "observatory_timeline",
    `${CACHE_NS}.timeline:${period}:${sourceFeedCacheSegment(feed)}:${country ?? "all"}`, ttl, period,
    async (session, tally) => {
      const startMs = timelineStartMs(spec);
      const src = buildSourceFilter(feed);
      const stmt = country
        ? session.prepare(`
            SELECT hour_bucket, SUM(threat_count) AS total,
              ${severitySums("severity", "threat_count")}
            FROM threat_cube_geo
            WHERE hour_bucket >= ? AND country_code = ?${src.sql}
            GROUP BY hour_bucket
          `).bind(toHourBucket(startMs), country, ...src.params)
        : session.prepare(`
            SELECT hour_bucket, SUM(threat_count) AS total,
              ${severitySums("severity", "threat_count")}
            FROM threat_cube_status
            WHERE hour_bucket >= ? AND status = 'active'${src.sql}
            GROUP BY hour_bucket
          `).bind(toHourBucket(startMs), ...src.params);
      const rows = await stmt.all<TimelineRow>();
      addToTally(tally, rows.meta);
      return {
        data: { bucket: spec.bucket, points: bucketTimeline(rows.results ?? [], spec, startMs) },
        meta: { source_feed: sourceFeedCacheSegment(feed), country },
      };
    });
}

// ── 7. GET /api/observatory/actors ────────────────────────────────────────────
//
//   (no actor_id)  → list [{id,name,cluster_count,infra_count}], ≤500 rows,
//                    cluster_count DESC, infra_count DESC, name
//   actor_id=<id>  → detail {actor, infrastructure[], clusters[], attributions}
//                    400 unless ^[A-Za-z0-9_.:-]{1,128}$; 404 unknown (never
//                    cached). Detail keys are `actors:detail:<id>`, a separate
//                    namespace from the list key `actors:list`, so
//                    `actor_id=list` can never collide with the list.
//
// Every per-actor read is index-backed: idx_clusters_actor,
// idx_tai_actor, idx_attribution_actor (all present in prod).
export const ACTORS_LIST_LIMIT = 500;
export const ACTOR_INFRA_LIMIT = 200;
export const ACTOR_CLUSTERS_LIMIT = 100;
/** Actor ids are slug / prefixed-id shaped; anything else is rejected. */
export const ACTOR_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

interface ActorRow {
  id: string;
  name: string;
  aliases: string | null;
  affiliation: string | null;
  country_code: string | null;
  capability: string | null;
  attribution_confidence: string | null;
  status: string | null;
  description: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

/** Aliases are a JSON array on most rows, comma-separated text on some. */
export function aliasList(raw: string | null): string[] {
  if (!raw || raw.trim() === "") return [];
  if (raw.trim().startsWith("[")) return parseJsonStringArray(raw);
  return dedupeStrings(raw.split(","), LENS_ARRAY_CAP);
}

export async function handleObservatoryActors(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const actorId = url.searchParams.get("actor_id");

  if (actorId === null || actorId === "") {
    return serveLens(request, env, "observatory_actors",
      `${CACHE_NS}.actors:list`, LENS_TTL_S.actors, undefined,
      async (session, tally) => {
        const rows = await session.prepare(`
          SELECT a.id, a.name,
            (SELECT COUNT(*) FROM infrastructure_clusters c WHERE c.actor_id = a.id) AS cluster_count,
            (SELECT COUNT(*) FROM threat_actor_infrastructure i WHERE i.threat_actor_id = a.id) AS infra_count
          FROM threat_actors a
          ORDER BY cluster_count DESC, infra_count DESC, a.name, a.id
          LIMIT ${ACTORS_LIST_LIMIT}
        `).all<{ id: string; name: string; cluster_count: number; infra_count: number }>();
        addToTally(tally, rows.meta);
        const data = (rows.results ?? []).map((r) => ({
          id: r.id, name: r.name, cluster_count: num(r.cluster_count), infra_count: num(r.infra_count),
        }));
        return { data };
      });
  }

  if (!ACTOR_ID_RE.test(actorId)) return badRequest(request, "invalid actor_id");

  return serveLens(request, env, "observatory_actor_detail",
    `${CACHE_NS}.actors:detail:${actorId}`, LENS_TTL_S.actors, undefined,
    async (session, tally) => {
      tally.queries += 1; // .first() exposes no meta
      const actor = await session.prepare(`
        SELECT id, name, aliases, affiliation, country_code, capability,
               attribution_confidence, status, description, first_seen, last_seen
        FROM threat_actors WHERE id = ? LIMIT 1
      `).bind(actorId).first<ActorRow>();
      if (!actor) throw new LensHttpError(404, "Actor not found");

      const [infra, clusters, attributions] = await Promise.all([
        session.prepare(`
          SELECT asn, country_code, hosting_provider, confidence, last_observed
          FROM threat_actor_infrastructure
          WHERE threat_actor_id = ?
          ORDER BY last_observed DESC
          LIMIT ${ACTOR_INFRA_LIMIT}
        `).bind(actorId).all<{
          asn: string | null; country_code: string | null; hosting_provider: string | null;
          confidence: string; last_observed: string;
        }>(),
        session.prepare(`
          SELECT id, countries, asns, confidence_score
          FROM infrastructure_clusters
          WHERE actor_id = ?
          ORDER BY threat_count DESC, id
          LIMIT ${ACTOR_CLUSTERS_LIMIT}
        `).bind(actorId).all<{ id: string; countries: string | null; asns: string | null; confidence_score: number | null }>(),
        session.prepare(`
          SELECT confidence, source, COUNT(*) AS n
          FROM threat_attributions
          WHERE actor_id = ?
          GROUP BY confidence, source
        `).bind(actorId).all<{ confidence: string; source: string; n: number }>(),
      ]);
      addToTally(tally, infra.meta);
      addToTally(tally, clusters.meta);
      addToTally(tally, attributions.meta);

      const by_confidence: Record<string, number> = {};
      const by_source: Record<string, number> = {};
      for (const r of attributions.results ?? []) {
        by_confidence[r.confidence] = (by_confidence[r.confidence] ?? 0) + num(r.n);
        by_source[r.source] = (by_source[r.source] ?? 0) + num(r.n);
      }

      return {
        data: {
          actor: {
            id: actor.id,
            name: actor.name,
            aliases: aliasList(actor.aliases),
            affiliation: actor.affiliation ?? null,
            country_code: normalizeCountry(actor.country_code),
            capability: actor.capability ?? null,
            attribution_confidence: actor.attribution_confidence ?? null,
            status: actor.status ?? null,
            description: actor.description ?? null,
            first_seen: actor.first_seen ?? null,
            last_seen: actor.last_seen ?? null,
          },
          infrastructure: (infra.results ?? []).map((r) => ({
            asn: normalizeAsn(r.asn) ?? r.asn ?? null,
            country_code: normalizeCountry(r.country_code),
            hosting_provider: r.hosting_provider ?? null,
            confidence: r.confidence,
            last_observed: r.last_observed,
          })),
          clusters: (clusters.results ?? []).map((r) => ({
            id: r.id,
            countries: countryList(parseJsonStringArray(r.countries, Number.MAX_SAFE_INTEGER)),
            asns: asnList(parseJsonStringArray(r.asns, Number.MAX_SAFE_INTEGER)),
            confidence_score: r.confidence_score ?? null,
          })),
          attributions: { by_confidence, by_source },
        },
      };
    });
}

// ── Phase B (B5) shared: velocity flag + takedown rollup folding ──────────────

export type VelocityFilter = "very_fast" | "fast" | "all";

/** very_fast | fast | all → that value; anything else → null (400). */
export function parseVelocityFlag(raw: string): VelocityFilter | null {
  return raw === "very_fast" || raw === "fast" || raw === "all" ? raw : null;
}

interface VelocityTimelineRow {
  hour_bucket: string;
  total: number | null;
  very_fast: number | null;
  fast: number | null;
}

export interface VelocityTimelinePoint extends TimelinePoint {
  very_fast: number;
  fast: number;
}

/** Pure: fold hourly velocity-cube rows into N zero-filled buckets. */
export function bucketVelocityTimeline(
  rows: readonly VelocityTimelineRow[],
  spec: TimelineSpec,
  startMs: number,
): VelocityTimelinePoint[] {
  const base = bucketTimeline(
    rows.map((r) => ({ hour_bucket: r.hour_bucket, total: r.total, critical: 0, high: 0, medium: 0, low: 0 })),
    spec, startMs,
  );
  const points: VelocityTimelinePoint[] = base.map((p) => ({ ...p, very_fast: 0, fast: 0 }));
  for (const r of rows) {
    const ms = Date.parse(`${r.hour_bucket.replace(" ", "T")}Z`);
    if (!Number.isFinite(ms)) continue;
    const k = Math.floor((ms - startMs) / spec.bucketMs);
    if (k < 0 || k >= spec.points) continue;
    points[k]!.very_fast += num(r.very_fast);
    points[k]!.fast += num(r.fast);
  }
  return points;
}

// takedown_outcome_daily window read: (dim, day) range on
// idx_takedown_outcome_dim_day (0299). Binds: dim, first day.
export const TAKEDOWN_ROLLUP_READ_SQL = `
  SELECT day, key, submitted, taken_down, refused, expired, pending, median_hours
  FROM takedown_outcome_daily
  WHERE dim = ? AND day >= ?
`;

export interface TakedownRollupRow {
  day: string;
  key: string;
  submitted: number | null;
  taken_down: number | null;
  refused: number | null;
  expired: number | null;
  pending: number | null;
  median_hours: number | null;
}

export interface TakedownAgg {
  key: string;
  submitted: number;
  taken_down: number;
  refused: number;
  expired: number;
  pending: number;
  /** taken_down / (taken_down + refused + expired); null when none resolved. */
  share: number | null;
  /** Weighted median of the daily medians (weight = that day's taken_down). */
  median_hours: number | null;
}

/** Weighted median: the smallest value whose cumulative weight reaches half. */
export function weightedMedian(pairs: ReadonlyArray<{ value: number; weight: number }>): number | null {
  const xs = pairs.filter((p) => Number.isFinite(p.value) && p.weight > 0).sort((a, b) => a.value - b.value);
  const total = xs.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return null;
  let cum = 0;
  for (const p of xs) {
    cum += p.weight;
    if (cum * 2 >= total) return round(p.value, 2);
  }
  return round(xs[xs.length - 1]!.value, 2);
}

/**
 * Pure: fold daily rollup cells into one aggregate per key. Counts sum.
 * `median_hours` over a multi-day window is the taken_down-weighted median
 * of the per-day medians — the rollup stores one median per day, not the
 * raw durations, so this is an approximation of the true window median
 * (exact when every day holds ≤1 takedown).
 */
export function foldTakedownCells(rows: readonly TakedownRollupRow[]): Map<string, TakedownAgg> {
  const acc = new Map<string, TakedownAgg & { medians: Array<{ value: number; weight: number }> }>();
  for (const r of rows) {
    if (typeof r.key !== "string" || r.key === "") continue;
    let a = acc.get(r.key);
    if (!a) {
      a = { key: r.key, submitted: 0, taken_down: 0, refused: 0, expired: 0, pending: 0, share: null, median_hours: null, medians: [] };
      acc.set(r.key, a);
    }
    a.submitted += num(r.submitted);
    a.taken_down += num(r.taken_down);
    a.refused += num(r.refused);
    a.expired += num(r.expired);
    a.pending += num(r.pending);
    if (typeof r.median_hours === "number" && Number.isFinite(r.median_hours)) {
      a.medians.push({ value: r.median_hours, weight: Math.max(1, num(r.taken_down)) });
    }
  }
  const out = new Map<string, TakedownAgg>();
  for (const [k, { medians, ...a }] of acc) {
    const resolved = a.taken_down + a.refused + a.expired;
    out.set(k, { ...a, share: resolved > 0 ? round(a.taken_down / resolved, 4) : null, median_hours: weightedMedian(medians) });
  }
  return out;
}

/** providers-geo `takedown` field: null when the provider had no submission. */
export function providerTakedown(a: TakedownAgg | undefined): { share: number | null; median_hours: number | null; n: number } | null {
  if (!a || a.submitted <= 0) return null;
  return { share: a.share, median_hours: a.median_hours, n: a.submitted };
}

// ── 8. GET /api/observatory/takedowns-geo ─────────────────────────────────────
//
//   period  30d (default) | 90d          → else 400
//   by      country (default) | provider  → else 400
//
// Source: takedown_outcome_daily (migration 0299; rebuilt daily at the UTC
// hour-0 cube_healer tick from takedown_requests — lib/takedown-outcome-
// rollup.ts). The window is whole UTC days: today and the previous N-1.
// Rows: [{key, label, country, lat, lng, submitted, taken_down, refused,
// expired, pending, share, median_hours}], submitted DESC, key; ≤200 rows.
//   key     ISO-2 (by=country) | hosting_providers.id (by=provider) | 'unknown'
//           (not threat-sourced, or the threat lacks country/provider)
//   label   country code | provider name ('Unknown' / the id when unnamed)
//   country by=country → key; by=provider → the provider's country; null
//   lat/lng that country's centroid, or null (never drawn at [0,0])
//   share   taken_down / (taken_down + refused + expired), null when nothing
//           resolved — the SUCCESS share, not the volume share (volume share
//           is submitted / Σsubmitted, derivable client-side)
//   median_hours  see foldTakedownCells
export const TAKEDOWNS_GEO_ROW_LIMIT = 200;
const TAKEDOWN_PERIODS: readonly ObservatoryPeriod[] = ["30d", "90d"];

export async function handleObservatoryTakedownsGeo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const period = parseLensPeriod(url.searchParams.get("period"), TAKEDOWN_PERIODS, "30d");
  if (!period) return badRequest(request, "period must be 30d or 90d");
  const rawBy = url.searchParams.get("by");
  const by = rawBy === null || rawBy === "" ? "country" : rawBy;
  if (by !== "country" && by !== "provider") return badRequest(request, "by must be country or provider");

  return serveLens(request, env, "observatory_takedowns_geo",
    `${CACHE_NS}.takedowns_geo:${period}:${by}`, LENS_TTL_S.takedownsGeo, period,
    async (session, tally) => {
      const days = period === "90d" ? 90 : 30;
      const windowStart = rollupWindowStartDay(new Date(), days);
      const res = await session.prepare(TAKEDOWN_ROLLUP_READ_SQL).bind(by, windowStart).all<TakedownRollupRow>();
      addToTally(tally, res.meta);
      const aggs = [...foldTakedownCells(res.results ?? []).values()]
        .filter((a) => a.submitted > 0)
        .sort((a, b) => b.submitted - a.submitted || a.key.localeCompare(b.key))
        .slice(0, TAKEDOWNS_GEO_ROW_LIMIT);

      // Provider labels: PK lookups, ≤99 binds per statement.
      const providers = new Map<string, { name: string | null; country: string | null }>();
      if (by === "provider") {
        const ids = aggs.map((a) => a.key).filter((k) => k !== "unknown");
        for (const part of chunk(ids, LENS_MAX_BINDS)) {
          const pr = await session.prepare(
            `SELECT id, name, country FROM hosting_providers WHERE id IN (${placeholders(part.length)})`,
          ).bind(...part).all<{ id: string; name: string | null; country: string | null }>();
          addToTally(tally, pr.meta);
          for (const p of pr.results ?? []) providers.set(p.id, { name: p.name, country: p.country });
        }
      }

      const data = aggs.map((a) => {
        let label: string;
        let country: string | null;
        if (a.key === "unknown") {
          label = "Unknown";
          country = null;
        } else if (by === "country") {
          label = a.key;
          country = normalizeCountry(a.key);
        } else {
          const p = providers.get(a.key);
          label = p?.name ?? a.key;
          country = normalizeCountry(p?.country ?? null);
        }
        const c = country ? getCountryCentroid(country) : null;
        return {
          key: a.key,
          label,
          country,
          lat: c ? c[1] : null,
          lng: c ? c[0] : null,
          submitted: a.submitted,
          taken_down: a.taken_down,
          refused: a.refused,
          expired: a.expired,
          pending: a.pending,
          share: a.share,
          median_hours: a.median_hours,
        };
      });
      return { data, meta: { by, window_start_day: windowStart } };
    });
}

// ── 9. GET /api/observatory/velocity-nodes ────────────────────────────────────
//
//   period  24h | 7d (default) | 30d | 90d → else 400
//   flag    very_fast | fast | all (default, both) → else 400
//
// Source: threat_cube_velocity (migration 0300; ACTIVE threats whose
// weaponization_flag is very_fast/fast, per created_at hour × country),
// summed over the Phase A snapped window. One node per country, placed at
// the country centroid (precision 'country'); 'XX' / unknown-centroid
// countries are dropped and their count reported in meta.dropped_no_centroid.
// Shape = /nodes (lat, lng, threat_count, top_severity, critical, high,
// medium, low, country_code, top_threat_type) + very_fast, fast, precision.
// The velocity cube has no severity / threat_type dimension, so the severity
// counts are 0 and top_severity / top_threat_type are null. Ordered
// threat_count DESC, country_code.
const VELOCITY_NODES_SQL = (withFlag: boolean) => `
  SELECT country_code,
    SUM(CASE WHEN flag = 'very_fast' THEN threat_count ELSE 0 END) AS very_fast,
    SUM(CASE WHEN flag = 'fast' THEN threat_count ELSE 0 END) AS fast
  FROM threat_cube_velocity
  WHERE hour_bucket >= ?${withFlag ? " AND flag = ?" : ""}
  GROUP BY country_code
`;

export interface VelocityNode {
  lat: number;
  lng: number;
  threat_count: number;
  top_severity: null;
  critical: 0;
  high: 0;
  medium: 0;
  low: 0;
  country_code: string;
  top_threat_type: null;
  very_fast: number;
  fast: number;
  precision: "country";
}

/** Pure: per-country velocity counts → centroid-placed nodes. */
export function shapeVelocityNodes(
  rows: ReadonlyArray<{ country_code: string | null; very_fast: number | null; fast: number | null }>,
): { nodes: VelocityNode[]; dropped: number } {
  const nodes: VelocityNode[] = [];
  let dropped = 0;
  for (const r of rows) {
    const veryFast = num(r.very_fast);
    const fast = num(r.fast);
    const total = veryFast + fast;
    if (total <= 0) continue;
    const cc = normalizeCountry(r.country_code);
    const c = cc ? getCountryCentroid(cc) : null;
    if (!cc || !c) { dropped += total; continue; }
    nodes.push({
      lat: c[1], lng: c[0], threat_count: total,
      top_severity: null, critical: 0, high: 0, medium: 0, low: 0,
      country_code: cc, top_threat_type: null,
      very_fast: veryFast, fast, precision: "country",
    });
  }
  nodes.sort((a, b) => b.threat_count - a.threat_count || a.country_code.localeCompare(b.country_code));
  return { nodes, dropped };
}

export async function handleObservatoryVelocityNodes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const period = parseLensPeriod(url.searchParams.get("period"));
  if (!period) return badRequest(request, "invalid period");
  const rawFlag = url.searchParams.get("flag");
  const flag = rawFlag === null || rawFlag === "" ? "all" : parseVelocityFlag(rawFlag);
  if (!flag) return badRequest(request, "flag must be very_fast, fast or all");

  return serveLens(request, env, "observatory_velocity_nodes",
    `${CACHE_NS}.velocity_nodes:${period}:${flag}`, LENS_TTL_S.velocityNodes, period,
    async (session, tally) => {
      const withFlag = flag !== "all";
      const stmt = session.prepare(VELOCITY_NODES_SQL(withFlag));
      const bound = withFlag
        ? stmt.bind(snappedWindowStart(period), flag)
        : stmt.bind(snappedWindowStart(period));
      const res = await bound.all<{ country_code: string | null; very_fast: number | null; fast: number | null }>();
      addToTally(tally, res.meta);
      const { nodes, dropped } = shapeVelocityNodes(res.results ?? []);
      return { data: nodes, meta: { flag, dropped_no_centroid: dropped } };
    });
}
