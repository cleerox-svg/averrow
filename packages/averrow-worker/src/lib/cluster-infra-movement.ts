// NEXUS infrastructure-movement pivot trigger (S2.4 / D5b).
//
// `pivot_detected` is the platform's ONLY live event-driven dispatch edge
// (nexus → Observer, dispatched by processAgentEvents in the orchestrator).
// Historically it fired on ONE condition: DORMANCY — an ASN cluster whose
// activity dropped >80% run-over-run (agents/nexus.ts + workflows/nexusRun.ts,
// the ASN lane). D5b adds a SECOND, purely ADDITIVE trigger on the OPPOSITE
// signal: a cluster GAINING new infrastructure between runs (new IPs / ASNs
// / cert-serials) — the register-then-move / expand pattern.
//
// It is emitted with the SAME event_type ('pivot_detected') + target_agent
// ('observer') as dormancy. The two are distinguished ONLY by
// payload_json.kind ('dormancy' | 'infra_movement'). Because Observer wakes
// to run its full aggregate briefing and NEVER reads the event payload
// (agents/observer.ts execute() destructures only { env, runId }), no
// dispatch wiring changes and the details shape stays backward-compatible.
//
// ── Scope: BRIDGE-KIND clusters only (true agent<->workflow parity) ──────
// Movement is detected ONLY over cert-serial / cert-SAN / per-IP clusters —
// the SPECIFIC-evidence, operator-level kinds (BRIDGE_KINDS, reused from
// lib/cluster-components). Two reasons, both load-bearing:
//   1. PARITY. These are the only kinds whose ids are byte-identical
//      DETERMINISTIC natural keys in BOTH nexus paths. The workflow's ASN
//      lane still mints crypto.randomUUID() ids (a fresh infrastructure_-
//      clusters row every run), so an ASN cluster's stored fingerprint
//      could never persist across runs there — movement would be dead in
//      the LIVE (workflow) path. This is the same divergence D5a's
//      component layer sidesteps by deriving labels from bridge clusters
//      only. Restricting to bridge kinds makes the shared helper behave
//      IDENTICALLY in both paths.
//   2. SIGNAL. A cert/IP cluster gaining a new hosting IP or ASN is
//      operator-level "moved infra", not shared-hosting co-tenancy noise
//      (the /24 / registrar over-merge trap). Detection quality over volume.
//
// ── Flood control (the critical part — this is the ONE live edge) ────────
// Dormancy (>80% drop) is RARE; infra growth is COMMON (active operators
// gain infra every run), so naive movement emission would flood Observer
// every NEXUS run. FOUR guards, each fail-safe toward UNDER-emit:
//   (a) PRIOR-SNAPSHOT REQUIRED — a cluster with no stored fingerprint
//       (first observation) NEVER emits; it only records its baseline.
//   (b) SIGNIFICANCE GATE — movement fires only on meaningful growth:
//       >=1 new ASN OR >=MIN_NEW_IPS new IPs OR >=MIN_NEW_SERIALS new
//       cert-serials, AND confidence_score > CONFIDENCE_FLOOR (mirrors the
//       dormancy pivot's `confidence > 40`). Hub clusters (brand fan-out >
//       HUB_FANOUT_THRESHOLD) are excluded entirely — a shared-infra hub's
//       churn is not one operator moving.
//   (c) PER-CLUSTER COOLDOWN — a cluster that emitted movement is not
//       re-emitted within COOLDOWN_HOURS (24h); last_movement_pivot_at
//       gates it. The baseline fingerprint still advances every run, so
//       after the cooldown expires only NEW growth since then can fire.
//   (d) PER-RUN HARD CAP — at most MAX_MOVEMENT_EVENTS_PER_RUN (5) movement
//       events per run, highest-significance first. Excess candidates are
//       dropped (their baseline still advances → fail-safe under-emit). This
//       is strictly more conservative than the pre-existing uncapped
//       dormancy loop; it caps this trigger's fan-in per run, not the total
//       events Observer may receive across triggers/runs.
//
// ── Idempotent, deterministic, no AI ─────────────────────────────────────
// A rerun over unchanged data finds an empty new-element set for every
// cluster, emits nothing, and writes 0 fingerprint rows (diff-write). The
// diff is a pure set operation. No AI tokens. Bounded: reads the cluster
// table (hundreds of rows) + ONE grouped aggregate over member threats via
// the cluster_id index; never a per-threat scan.

import type { D1Database } from '@cloudflare/workers-types';
import {
  classifyClusterKind,
  isBridgeKind,
  DEFAULT_HUB_FANOUT_THRESHOLD,
} from './cluster-components';

// ─── Tunable thresholds (all flagged for operator confirm — S2.4 report) ─

/** A single new IP is noise; this many NEW distinct IPs in one interval is
 *  meaningful expansion of an operator's hosting footprint. */
export const DEFAULT_MIN_NEW_IPS = 3;
/** New cert-serials are rarer / stronger evidence (a new TLS cert = new
 *  infra), so a lower bar than IPs. */
export const DEFAULT_MIN_NEW_SERIALS = 2;
/** A NEW ASN appearing among a cert/IP cluster's members = the operator
 *  moved to new hosting — the canonical register-then-move signal; a single
 *  one is enough. */
export const DEFAULT_MIN_NEW_ASNS = 1;
/** Mirrors the dormancy pivot's `confidence > 40` significance floor. */
export const DEFAULT_CONFIDENCE_FLOOR = 40;
/** Per-cluster re-emit cooldown. */
export const DEFAULT_COOLDOWN_HOURS = 24;
/** Hard cap on movement events per NEXUS run — protects the one live edge. */
export const DEFAULT_MAX_EVENTS_PER_RUN = 5;
/** Cap on stored fingerprint elements PER DIMENSION. A bridge cluster with
 *  more distinct IPs/serials than this is hub-scale and is hub-excluded
 *  first; the cap is a defensive ceiling on stored-set size only. */
export const DEFAULT_MAX_FINGERPRINT_ELEMENTS = 256;
/** IN-list chunk size for the member-infra aggregate — keeps bound params
 *  per statement well under SQLite's 999-variable ceiling. */
const MEMBER_QUERY_CHUNK = 400;

// ─── Fingerprint model ────────────────────────────────────────────────────

/** A cluster's bounded, sorted infra element set. Compact keys keep the
 *  stored JSON small: a=ASNs, i=IPs, s=cert-serials. */
export interface InfraFingerprint {
  a: string[];
  i: string[];
  s: string[];
}

export interface MovementThresholds {
  minNewIps?: number;
  minNewSerials?: number;
  minNewAsns?: number;
  confidenceFloor?: number;
  cooldownHours?: number;
  maxEventsPerRun?: number;
  maxFingerprintElements?: number;
  hubFanoutThreshold?: number;
}

// ─── Pure core (no I/O, no clock injected as arg — unit-testable) ─────────

/** Dedupe, drop empties, sort, and cap a raw element list. Deterministic:
 *  same multiset → same array. */
export function normalizeElements(raw: Iterable<string | null | undefined>, cap: number): string[] {
  const set = new Set<string>();
  for (const v of raw) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) set.add(t);
    }
  }
  const sorted = [...set].sort();
  return sorted.length > cap ? sorted.slice(0, cap) : sorted;
}

/** Distinct-count a dimension BEFORE capping — used to detect the over-cap
 *  condition (F1: a truncated set is a lexicographic WINDOW, not the full
 *  set, so low-end membership churn could slide a previously-above-cap
 *  element into the kept range and be mis-diffed as "new" → phantom
 *  movement). We never diff a truncated dimension; see `overCap` below. */
function distinctCount(raw: Iterable<string | null | undefined>): number {
  const set = new Set<string>();
  for (const v of raw) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) set.add(t);
    }
  }
  return set.size;
}

/** Build a fingerprint from raw per-dimension element lists. */
export function buildFingerprint(
  asns: Iterable<string | null | undefined>,
  ips: Iterable<string | null | undefined>,
  serials: Iterable<string | null | undefined>,
  cap: number = DEFAULT_MAX_FINGERPRINT_ELEMENTS,
): InfraFingerprint {
  return {
    a: normalizeElements(asns, cap),
    i: normalizeElements(ips, cap),
    s: normalizeElements(serials, cap),
  };
}

/** Build a fingerprint AND report whether ANY dimension's true distinct
 *  count exceeded the cap. When `overCap` is true the fingerprint is a
 *  truncated window and MUST NOT be diffed for movement (F1) — the I/O
 *  layer records the baseline but skips emission for that cluster. */
export function buildFingerprintWithOverCap(
  asns: Iterable<string | null | undefined>,
  ips: Iterable<string | null | undefined>,
  serials: Iterable<string | null | undefined>,
  cap: number = DEFAULT_MAX_FINGERPRINT_ELEMENTS,
): { fp: InfraFingerprint; overCap: boolean } {
  // Materialize once so we can both count-distinct and normalize without
  // re-consuming an iterator.
  const aArr = [...asns];
  const iArr = [...ips];
  const sArr = [...serials];
  const overCap =
    distinctCount(aArr) > cap || distinctCount(iArr) > cap || distinctCount(sArr) > cap;
  return { fp: buildFingerprint(aArr, iArr, sArr, cap), overCap };
}

export function serializeFingerprint(fp: InfraFingerprint): string {
  return JSON.stringify(fp);
}

/** Parse a stored fingerprint. Returns null for null/blank/malformed input
 *  (treated as "no prior snapshot" — fail safe, no movement). */
export function parseFingerprint(json: string | null | undefined): InfraFingerprint | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const arr = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string') : [];
    return { a: arr(o.a), i: arr(o.i), s: arr(o.s) };
  } catch {
    return null;
  }
}

export interface NewElements {
  newAsns: string[];
  newIps: string[];
  newSerials: string[];
}

/** Elements present in `current` but absent from `prior` — the ADDITIONS
 *  only. Removals (aged-out / churned infra) are deliberately ignored: this
 *  trigger is about GAINING infra, not losing it. */
export function diffNewElements(prior: InfraFingerprint, current: InfraFingerprint): NewElements {
  const missing = (cur: string[], old: string[]): string[] => {
    const seen = new Set(old);
    return cur.filter((x) => !seen.has(x));
  };
  return {
    newAsns: missing(current.a, prior.a),
    newIps: missing(current.i, prior.i),
    newSerials: missing(current.s, prior.s),
  };
}

export interface MovementDecisionInput {
  prior: InfraFingerprint | null;
  current: InfraFingerprint;
  confidenceScore: number;
  /** ISO string of the last movement emit, or null if never. */
  lastMovementPivotAt: string | null;
  /** Current wall-clock in ms (injected for testability). */
  nowMs: number;
  /** F1: true when `current` is a TRUNCATED (over-cap) window rather than
   *  the full distinct set. Such a fingerprint must not be diffed — low-end
   *  churn in a >cap dimension could manufacture phantom "new" elements. */
  overCap?: boolean;
  thresholds?: MovementThresholds;
}

export interface MovementDecision {
  emit: boolean;
  reason:
    | 'over_cap'
    | 'no_prior_snapshot'
    | 'below_confidence_floor'
    | 'in_cooldown'
    | 'insufficient_growth'
    | 'movement';
  newElements: NewElements;
  /** Total new distinct elements — used to rank candidates under the cap. */
  significance: number;
}

/**
 * Pure movement decision for ONE cluster. All four fail-safe guards live
 * here (except the per-run cap, which is a cross-cluster concern applied by
 * the I/O layer) so they are directly unit-testable. Mirrors the
 * lib/alert-triage.ts decide-fn pattern — no I/O, no ambient clock.
 */
export function decideInfraMovement(input: MovementDecisionInput): MovementDecision {
  const t = input.thresholds ?? {};
  const minNewIps = t.minNewIps ?? DEFAULT_MIN_NEW_IPS;
  const minNewSerials = t.minNewSerials ?? DEFAULT_MIN_NEW_SERIALS;
  const minNewAsns = t.minNewAsns ?? DEFAULT_MIN_NEW_ASNS;
  const confidenceFloor = t.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const cooldownHours = t.cooldownHours ?? DEFAULT_COOLDOWN_HOURS;

  // Guard (F1): an over-cap (truncated-window) fingerprint is never diffed.
  // Treat it like a hub — record the baseline, emit nothing. Under-emit is
  // the safe direction; a genuinely huge dimension can never manufacture
  // phantom growth from a lexicographic window slide.
  if (input.overCap) {
    return { emit: false, reason: 'over_cap', newElements: emptyNew(), significance: 0 };
  }

  // Guard (a): a first observation has no baseline — record only, never emit.
  if (input.prior === null) {
    return { emit: false, reason: 'no_prior_snapshot', newElements: emptyNew(), significance: 0 };
  }

  const newElements = diffNewElements(input.prior, input.current);
  const significance =
    newElements.newAsns.length + newElements.newIps.length + newElements.newSerials.length;

  // Guard (b1): significance floor on cluster confidence (mirrors dormancy).
  if (input.confidenceScore <= confidenceFloor) {
    return { emit: false, reason: 'below_confidence_floor', newElements, significance };
  }

  // Guard (c): per-cluster cooldown.
  if (input.lastMovementPivotAt) {
    const last = Date.parse(input.lastMovementPivotAt);
    if (!Number.isNaN(last) && input.nowMs - last < cooldownHours * 3_600_000) {
      return { emit: false, reason: 'in_cooldown', newElements, significance };
    }
  }

  // Guard (b2): meaningful-growth gate.
  const grew =
    newElements.newAsns.length >= minNewAsns ||
    newElements.newIps.length >= minNewIps ||
    newElements.newSerials.length >= minNewSerials;
  if (!grew) {
    return { emit: false, reason: 'insufficient_growth', newElements, significance };
  }

  return { emit: true, reason: 'movement', newElements, significance };
}

function emptyNew(): NewElements {
  return { newAsns: [], newIps: [], newSerials: [] };
}

// ─── I/O orchestration (thin wrapper — SQL + diff-writes + emit) ──────────

interface ClusterRow {
  id: string;
  cluster_name: string | null;
  brand_ids: string | null;
  agent_notes: string | null;
  confidence_score: number | null;
  infra_fingerprint: string | null;
  last_movement_pivot_at: string | null;
}

interface MemberInfraRow {
  cluster_id: string;
  asns: string | null;
  ips: string | null;
  serials: string | null;
}

export interface InfraMovementResult {
  clustersRead: number;
  bridgeClustersConsidered: number;
  hubExcluded: number;
  candidates: number;
  emitted: number;
  suppressedNoBaseline: number;
  suppressedCooldown: number;
  suppressedLowConfidence: number;
  suppressedInsufficient: number;
  /** F1: bridge clusters whose fingerprint was over-cap (truncated window)
   *  and therefore NOT diffed for movement this run. */
  overCapSkipped: number;
  cappedOut: number;
  fingerprintsWritten: number;
}

/**
 * Compute each bridge cluster's current infra fingerprint from its member
 * threats, diff it against the stored one, emit `pivot_detected`
 * (kind='infra_movement') for the most significant genuine expansions
 * (subject to all four flood guards), and overwrite the stored fingerprint.
 *
 * Idempotent — a rerun over unchanged data emits nothing and writes 0 rows.
 * Called IDENTICALLY from agents/nexus.ts and workflows/nexusRun.ts so the
 * two dispatch paths never diverge (mirrors groupClusterComponents).
 */
export async function detectClusterInfraMovement(
  db: D1Database,
  nowMs: number = Date.now(),
  thresholds: MovementThresholds = {},
): Promise<InfraMovementResult> {
  const hubThreshold = thresholds.hubFanoutThreshold ?? DEFAULT_HUB_FANOUT_THRESHOLD;
  const cap = thresholds.maxFingerprintElements ?? DEFAULT_MAX_FINGERPRINT_ELEMENTS;
  const maxEvents = thresholds.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;

  const result: InfraMovementResult = {
    clustersRead: 0,
    bridgeClustersConsidered: 0,
    hubExcluded: 0,
    candidates: 0,
    emitted: 0,
    suppressedNoBaseline: 0,
    suppressedCooldown: 0,
    suppressedLowConfidence: 0,
    suppressedInsufficient: 0,
    overCapSkipped: 0,
    cappedOut: 0,
    fingerprintsWritten: 0,
  };

  // 1. Read cluster rows (bounded by cluster-row count) and keep only
  //    bridge-kind clusters within the hub fan-out threshold.
  const rows = (await db.prepare(
    `SELECT id, cluster_name, brand_ids, agent_notes, confidence_score,
            infra_fingerprint, last_movement_pivot_at
       FROM infrastructure_clusters`,
  ).all<ClusterRow>()).results ?? [];
  result.clustersRead = rows.length;

  const bridgeRows: ClusterRow[] = [];
  for (const row of rows) {
    const kind = classifyClusterKind(row.id, row.agent_notes);
    if (!isBridgeKind(kind)) continue;
    result.bridgeClustersConsidered++;
    if (safeArrayLength(row.brand_ids) > hubThreshold) {
      result.hubExcluded++;
      continue;
    }
    bridgeRows.push(row);
  }

  if (bridgeRows.length === 0) return result;

  // 2. Grouped aggregate over member threats (rides the cluster_id index).
  //    CHUNKED so the bound-parameter count per statement stays well under
  //    SQLite's 999-variable ceiling: bridge clusters carry persistent
  //    deterministic ids and ACCUMULATE across runs, so the population can
  //    grow past a single IN list over time. Chunking processes every
  //    cluster (no fail-safe drop needed here).
  const ids = bridgeRows.map((r) => r.id);
  const memberById = new Map<string, MemberInfraRow>();
  for (let off = 0; off < ids.length; off += MEMBER_QUERY_CHUNK) {
    const chunk = ids.slice(off, off + MEMBER_QUERY_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const memberRows = (await db.prepare(
      `SELECT cluster_id,
              GROUP_CONCAT(DISTINCT asn)             AS asns,
              GROUP_CONCAT(DISTINCT ip_address)      AS ips,
              GROUP_CONCAT(DISTINCT ssl_cert_serial) AS serials
         FROM threats
        WHERE cluster_id IN (${placeholders})
        GROUP BY cluster_id`,
    ).bind(...chunk).all<MemberInfraRow>()).results ?? [];
    for (const m of memberRows) memberById.set(m.cluster_id, m);
  }

  // 3. Per-cluster diff + decision. Collect emit candidates; stage all
  //    fingerprint writes (diff-filtered) regardless of emit.
  interface Candidate {
    row: ClusterRow;
    decision: MovementDecision;
    current: InfraFingerprint;
  }
  const emitCandidates: Candidate[] = [];
  const fingerprintWrites: Array<{ id: string; fp: string }> = [];

  for (const row of bridgeRows) {
    const member = memberById.get(row.id);
    const { fp: current, overCap } = buildFingerprintWithOverCap(
      splitConcat(member?.asns),
      splitConcat(member?.ips),
      splitConcat(member?.serials),
      cap,
    );
    const prior = parseFingerprint(row.infra_fingerprint);

    const decision = decideInfraMovement({
      prior,
      current,
      confidenceScore: row.confidence_score ?? 0,
      lastMovementPivotAt: row.last_movement_pivot_at ?? null,
      nowMs,
      overCap,
      thresholds,
    });

    switch (decision.reason) {
      case 'over_cap': result.overCapSkipped++; break;
      case 'no_prior_snapshot': result.suppressedNoBaseline++; break;
      case 'below_confidence_floor': result.suppressedLowConfidence++; break;
      case 'in_cooldown': result.suppressedCooldown++; break;
      case 'insufficient_growth': result.suppressedInsufficient++; break;
      case 'movement': emitCandidates.push({ row, decision, current }); break;
    }

    // Diff-write: only stage when the serialized fingerprint actually
    // changed (idempotent — steady state writes nothing).
    const serialized = serializeFingerprint(current);
    if (serialized !== (row.infra_fingerprint ?? null)) {
      fingerprintWrites.push({ id: row.id, fp: serialized });
    }
  }

  result.candidates = emitCandidates.length;

  // 4. Flood guard (d): rank by significance and hard-cap per run.
  //    Deterministic ordering: significance desc, confidence desc, id asc.
  emitCandidates.sort((a, b) => {
    if (b.decision.significance !== a.decision.significance) {
      return b.decision.significance - a.decision.significance;
    }
    const ca = a.row.confidence_score ?? 0;
    const cb = b.row.confidence_score ?? 0;
    if (cb !== ca) return cb - ca;
    return a.row.id.localeCompare(b.row.id);
  });
  const toEmit = emitCandidates.slice(0, maxEvents);
  result.cappedOut = emitCandidates.length - toEmit.length;

  // 5. Emit pivot_detected (kind='infra_movement') + stamp cooldown. Same
  //    event_type + target_agent='observer' as dormancy — no new wiring.
  const nowIso = new Date(nowMs).toISOString();
  for (const cand of toEmit) {
    const { row, decision } = cand;
    try {
      await db.prepare(
        `INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority)
         VALUES (?, 'pivot_detected', 'nexus', 'observer', ?, 1)`,
      ).bind(
        crypto.randomUUID(),
        JSON.stringify({
          kind: 'infra_movement',
          cluster_id: row.id,
          cluster_name: row.cluster_name ?? null,
          new_asns: decision.newElements.newAsns.length,
          new_ips: decision.newElements.newIps.length,
          new_serials: decision.newElements.newSerials.length,
        }),
      ).run();
      await db.prepare(
        `UPDATE infrastructure_clusters SET last_movement_pivot_at = ? WHERE id = ?`,
      ).bind(nowIso, row.id).run();
      result.emitted++;
    } catch {
      // Non-fatal: skip this cluster's emit, keep processing the rest.
      continue;
    }
  }

  // 6. Overwrite fingerprints (baseline always advances — even for capped-out
  //    candidates, so a flood can't re-fire the same growth next run).
  for (const w of fingerprintWrites) {
    try {
      await db.prepare(
        `UPDATE infrastructure_clusters SET infra_fingerprint = ?, infra_fingerprint_at = ? WHERE id = ?`,
      ).bind(w.fp, nowIso, w.id).run();
      result.fingerprintsWritten++;
    } catch {
      continue;
    }
  }

  return result;
}

// ─── helpers ──────────────────────────────────────────────────────────────

/** Split a GROUP_CONCAT result into raw elements (comma-separated). */
function splitConcat(v: string | null | undefined): string[] {
  if (!v) return [];
  return v.split(',');
}

function safeArrayLength(json: string | null): number {
  if (!json) return 0;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}
