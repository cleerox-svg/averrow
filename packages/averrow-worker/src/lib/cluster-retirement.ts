/**
 * Legacy NEXUS cluster retirement — dry-run report + bounded threat re-point.
 *
 * Background: before 2026-09-11 the NEXUS workflow's ASN lane minted
 * `crypto.randomUUID()` ids on every run, so each (asn, threat_type) group
 * accreted ~768 copies — 76,667 rows (70,318 active + 6,349 dormant at the
 * 2026-10-14 audit) whose ids do NOT start `cluster_`, with frozen counts,
 * 1,708 malformed asn strings, 91 carrying an actor_id (including spurious
 * nation-state attributions on Cloudflare clusters) and ≥880 threats whose
 * `cluster_id` still points at one of them.
 *
 * Retirement is in three parts:
 *   1. migrations/0303 flips every legacy row to status='superseded'
 *      (actor_id, counts and notes are left intact — flip status back to
 *      undo). Every reader excludes it (lib/cluster-status.ts).
 *   2. NEXUS itself (lib/nexus-threat-lanes.ts retireNonOperationalLaneClusters)
 *      supersedes stable `cluster_asn_*` rows keyed on a malformed ASN and
 *      parks ASN / per-IP / subnet rows that are not operator evidence as
 *      'shared_infra' (status flip only — undone by flipping it back).
 *   3. This module moves THREATS off retired rows, in bounded batches driven
 *      by `POST /api/internal/nexus/cluster-retirement` (dry-run by default):
 *        - a legacy / superseded ASN row maps to the stable id the current
 *          lane generates for the same group, `cluster_asn_<asn>_<type>`
 *          (asns[0] normalised + attack_types[0]); the threat is re-pointed
 *          there when that row exists and is operational;
 *        - otherwise (shared-infra ASN, IP-reputation type, unparseable row,
 *          target missing or retired) the threat is RELEASED (cluster_id =
 *          NULL) so the next NEXUS run can let a specific lane claim it.
 *      This is deliberately not in the migration: it writes the threats
 *      table, which is large, and needs per-batch bounds.
 *      The UPDATE overwrites threats.cluster_id, so it is NOT reversible by
 *      itself: every moved threat is first recorded in `cluster_repoint_log`
 *      (migration 0305: threat_id, old_cluster_id, new_cluster_id, run_at),
 *      in the same db.batch as the move, so the re-point can be undone from
 *      that table (`UPDATE threats SET cluster_id = l.old_cluster_id FROM
 *      cluster_repoint_log l WHERE threats.id = l.threat_id AND
 *      threats.cluster_id IS l.new_cluster_id`). Each applied (non-dry-run)
 *      call also writes one audit_log row with its counts (index.ts route).
 *
 * Legacy-id predicate: an id that does not start with `cluster_` is exactly
 * `id < 'cluster_' OR id >= 'cluster`'` ('`' is the code point after '_'),
 * which, unlike `NOT LIKE 'cluster\_%'`, is two index RANGE seeks — on the
 * PRIMARY KEY for infrastructure_clusters and on idx (cluster_id,
 * created_at) for threats. Rows already moved fall out of the range, so
 * every batch makes progress and a rerun after completion is a no-op.
 */

import { asnClusterId, IP_REPUTATION_THREAT_TYPES } from "./nexus-threat-lanes";
import { asnKey, isSharedInfraAsn } from "./shared-infra-asns";
import { SHARED_INFRA_CLUSTER_STATUS, SUPERSEDED_CLUSTER_STATUS, isRetiredClusterStatus } from "./cluster-status";

/** Legacy (non-`cluster_`) predicate over infrastructure_clusters.id. */
export const LEGACY_CLUSTER_ID_SQL = "(id < 'cluster_' OR id >= 'cluster`')";
/** Same predicate over threats.cluster_id ('' is "no cluster", not legacy). */
export const LEGACY_THREAT_CLUSTER_SQL =
  "((cluster_id > '' AND cluster_id < 'cluster_') OR cluster_id >= 'cluster`')";

/** D1 statements bind at most 100 parameters. */
const IN_CHUNK = 90;
const REPORT_MAPPING_CAP = 2000;

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

function firstJsonElement(v: string | null | undefined): unknown {
  if (!v) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed[0] ?? null;
  } catch { /* malformed → undeterminable */ }
  return null;
}

function firstJsonString(v: string | null | undefined): string | null {
  const first = firstJsonElement(v);
  return typeof first === "string" && first !== "" ? first : null;
}

/** asns[0] as a canonical `AS<digits>` key — a JSON number (`[13335]`) counts. */
function firstJsonAsn(v: string | null | undefined): string | null {
  return asnKey(firstJsonElement(v));
}

export type LegacyMappingReason =
  | "mapped"          // stable id computed; still needs the target-status check
  | "shared_infra"    // ASN is shared infrastructure → release
  | "ip_reputation"   // scanning / malicious_ip → release
  | "unparseable";    // no usable asn / type → release

/**
 * The stable id a legacy / superseded ASN row maps to — the id the CURRENT
 * ASN lane generates for the same (normalised asn, threat_type) group — or
 * null with the reason the threats should be released instead. Pure.
 */
export function legacyTargetClusterId(
  asnsJson: string | null | undefined,
  attackTypesJson: string | null | undefined,
): { target: string | null; reason: LegacyMappingReason } {
  const asn = firstJsonAsn(asnsJson);
  const type = firstJsonString(attackTypesJson);
  if (asn === null || type === null) return { target: null, reason: "unparseable" };
  if (isSharedInfraAsn(asn)) return { target: null, reason: "shared_infra" };
  if (IP_REPUTATION_THREAT_TYPES.includes(type)) return { target: null, reason: "ip_reputation" };
  return { target: asnClusterId(asn, type), reason: "mapped" };
}

export type RepointAction = "repoint" | "release";

export interface RepointPlanEntry {
  cluster_id: string;
  action: RepointAction;
  target: string | null;
  reason: LegacyMappingReason | "target_missing" | "target_retired" | "retired_shared_infra";
}

/**
 * Resolve each source cluster row to repoint/release. A mapped target is
 * only used when that row exists and is operational. Bounded IN() reads.
 */
async function planForRows(
  db: D1Database,
  rows: Array<{ id: string; asns: string | null; attack_types: string | null; status: string | null }>,
): Promise<RepointPlanEntry[]> {
  const prelim = rows.map((r) => {
    // A shared_infra row's threats are always released: the row's own key
    // is not operator evidence, so there is nothing to re-point them to.
    if (r.status === SHARED_INFRA_CLUSTER_STATUS) {
      return { id: r.id, target: null, reason: "retired_shared_infra" as const };
    }
    const m = legacyTargetClusterId(r.asns, r.attack_types);
    return { id: r.id, target: m.target, reason: m.reason };
  });
  const targets = [...new Set(prelim.map((p) => p.target).filter((t): t is string => t !== null))];
  const targetStatus = new Map<string, string | null>();
  for (const ids of chunk(targets, IN_CHUNK)) {
    const res = await db.prepare(
      `SELECT id, status FROM infrastructure_clusters WHERE id IN (${ph(ids.length)})`,
    ).bind(...ids).all<{ id: string; status: string | null }>();
    for (const r of res.results ?? []) targetStatus.set(r.id, r.status);
  }
  return prelim.map((p): RepointPlanEntry => {
    if (p.target === null) return { cluster_id: p.id, action: "release", target: null, reason: p.reason };
    if (!targetStatus.has(p.target)) {
      return { cluster_id: p.id, action: "release", target: null, reason: "target_missing" };
    }
    if (isRetiredClusterStatus(targetStatus.get(p.target))) {
      return { cluster_id: p.id, action: "release", target: null, reason: "target_retired" };
    }
    return { cluster_id: p.id, action: "repoint", target: p.target, reason: "mapped" };
  });
}

async function loadClusterRows(
  db: D1Database,
  ids: string[],
): Promise<Array<{ id: string; asns: string | null; attack_types: string | null; status: string | null }>> {
  const out: Array<{ id: string; asns: string | null; attack_types: string | null; status: string | null }> = [];
  for (const part of chunk(ids, IN_CHUNK)) {
    const res = await db.prepare(
      `SELECT id, asns, attack_types, status FROM infrastructure_clusters WHERE id IN (${ph(part.length)})`,
    ).bind(...part).all<{ id: string; asns: string | null; attack_types: string | null; status: string | null }>();
    out.push(...(res.results ?? []));
  }
  // A threat can reference a cluster id with no row at all (deleted by the
  // 0143 dedup, etc.) — plan it as unparseable → release.
  const seen = new Set(out.map((r) => r.id));
  for (const id of ids) if (!seen.has(id)) out.push({ id, asns: null, attack_types: null, status: null });
  return out;
}

async function threatCountsByCluster(db: D1Database, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const part of chunk(ids, IN_CHUNK)) {
    const res = await db.prepare(
      `SELECT cluster_id, COUNT(*) AS n FROM threats
        WHERE cluster_id IN (${ph(part.length)}) GROUP BY cluster_id`,
    ).bind(...part).all<{ cluster_id: string; n: number }>();
    for (const r of res.results ?? []) counts.set(r.cluster_id, r.n);
  }
  return counts;
}

// ─── Dry-run report ───────────────────────────────────────────────────

export interface LegacyClusterReport {
  legacy_rows: {
    total: number;
    by_status: Record<string, number>;
    actor_linked: number;
    attributor_processed: number;
  };
  legacy_threat_refs: { threats: number; distinct_cluster_ids: number };
  mapping: {
    clusters_evaluated: number;
    truncated: boolean;
    clusters: Record<string, number>;
    threats: Record<string, number>;
  };
  retired_stable_rows: { superseded: number; shared_infra: number; threats_referencing: number };
}

/**
 * Read-only. Everything here is bounded: GROUP BYs over the
 * infrastructure_clusters PK range (not threats), and threats reads are
 * index range seeks on (cluster_id, created_at) restricted to legacy /
 * retired ids. Mapping coverage evaluates at most REPORT_MAPPING_CAP
 * distinct legacy ids (`truncated` says when more exist).
 */
export async function legacyClusterReport(db: D1Database): Promise<LegacyClusterReport> {
  const statusRows = (await db.prepare(
    `SELECT status, COUNT(*) AS n,
            SUM(CASE WHEN actor_id IS NOT NULL THEN 1 ELSE 0 END) AS actor_linked,
            SUM(CASE WHEN attribution_attempted_at IS NOT NULL THEN 1 ELSE 0 END) AS attempted
       FROM infrastructure_clusters
      WHERE ${LEGACY_CLUSTER_ID_SQL}
      GROUP BY status`,
  ).all<{ status: string | null; n: number; actor_linked: number; attempted: number }>()).results ?? [];

  const byStatus: Record<string, number> = {};
  let total = 0, actorLinked = 0, attempted = 0;
  for (const r of statusRows) {
    byStatus[r.status ?? "null"] = r.n;
    total += r.n;
    actorLinked += r.actor_linked ?? 0;
    attempted += r.attempted ?? 0;
  }

  const refs = await db.prepare(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT cluster_id) AS ids FROM threats WHERE ${LEGACY_THREAT_CLUSTER_SQL}`,
  ).first<{ n: number; ids: number }>();

  const refRows = (await db.prepare(
    `SELECT cluster_id, COUNT(*) AS n FROM threats
      WHERE ${LEGACY_THREAT_CLUSTER_SQL}
      GROUP BY cluster_id
      LIMIT ?`,
  ).bind(REPORT_MAPPING_CAP + 1).all<{ cluster_id: string; n: number }>()).results ?? [];
  const truncated = refRows.length > REPORT_MAPPING_CAP;
  const evaluated = refRows.slice(0, REPORT_MAPPING_CAP);
  const plan = await planForRows(db, await loadClusterRows(db, evaluated.map((r) => r.cluster_id)));
  const threatsById = new Map(evaluated.map((r) => [r.cluster_id, r.n]));
  const mapClusters: Record<string, number> = {};
  const mapThreats: Record<string, number> = {};
  for (const p of plan) {
    const k = p.action === "repoint" ? "repoint" : `release_${p.reason}`;
    mapClusters[k] = (mapClusters[k] ?? 0) + 1;
    mapThreats[k] = (mapThreats[k] ?? 0) + (threatsById.get(p.cluster_id) ?? 0);
  }

  const retired = await listRetiredStableRows(db);
  let retiredThreats = 0;
  for (const n of (await threatCountsByCluster(db, retired.map((r) => r.id))).values()) retiredThreats += n;

  return {
    legacy_rows: { total, by_status: byStatus, actor_linked: actorLinked, attributor_processed: attempted },
    legacy_threat_refs: { threats: refs?.n ?? 0, distinct_cluster_ids: refs?.ids ?? 0 },
    mapping: { clusters_evaluated: evaluated.length, truncated, clusters: mapClusters, threats: mapThreats },
    retired_stable_rows: {
      superseded: retired.filter((r) => r.status === SUPERSEDED_CLUSTER_STATUS).length,
      shared_infra: retired.filter((r) => r.status === SHARED_INFRA_CLUSTER_STATUS).length,
      threats_referencing: retiredThreats,
    },
  };
}

/**
 * Retired rows with a STABLE (`cluster_`) id — superseded malformed-ASN rows
 * and shared_infra rows. PK range over the stable ids (a few thousand at
 * most); `+status` keeps the planner off idx_clusters_status, which would
 * walk the ~76K superseded legacy rows first.
 */
async function listRetiredStableRows(
  db: D1Database,
): Promise<Array<{ id: string; asns: string | null; attack_types: string | null; status: string | null }>> {
  return (await db.prepare(
    `SELECT id, asns, attack_types, status FROM infrastructure_clusters
      WHERE id >= 'cluster_' AND id < 'cluster\`'
        AND +status IN ('${SUPERSEDED_CLUSTER_STATUS}', '${SHARED_INFRA_CLUSTER_STATUS}')
      ORDER BY id`,
  ).all<{ id: string; asns: string | null; attack_types: string | null; status: string | null }>()).results ?? [];
}

// ─── Bounded re-point / release batch ─────────────────────────────────

export const RETIREMENT_DEFAULT_MAX_CLUSTERS = 50;
export const RETIREMENT_MAX_CLUSTERS = 90;
export const RETIREMENT_DEFAULT_MAX_THREATS = 5000;
export const RETIREMENT_MAX_THREATS = 20000;

export interface RetirementBatchOptions {
  dryRun: boolean;
  /** Source cluster ids handled per phase per call. */
  maxClusters?: number;
  /** Threat rows moved per call across both phases. */
  maxThreats?: number;
}

export interface RetirementBatchResult {
  dry_run: boolean;
  legacy: {
    cluster_ids: number;
    repoint: number;
    release: number;
    threats_repointed: number;
    threats_released: number;
  };
  retired_stable: {
    cluster_ids: number;
    repoint: number;
    release: number;
    threats_repointed: number;
    threats_released: number;
  };
  /** First entries of this batch's plan (dry run: what WOULD happen). */
  plan_sample: Array<RepointPlanEntry & { threats: number }>;
  /** True when nothing is left to move (never true for a dry run that found work). */
  done: boolean;
}

export function parseRetirementParams(sp: URLSearchParams): RetirementBatchOptions {
  // Dry run unless the caller explicitly opts out — this writes threats.
  const dryRun = sp.get("dry_run") !== "0" && sp.get("dry_run") !== "false";
  const num = (k: string, dflt: number, max: number): number => {
    const n = parseInt(sp.get(k) ?? "", 10);
    return Number.isFinite(n) ? Math.max(1, Math.min(max, n)) : dflt;
  };
  return {
    dryRun,
    maxClusters: num("max_clusters", RETIREMENT_DEFAULT_MAX_CLUSTERS, RETIREMENT_MAX_CLUSTERS),
    maxThreats: num("max_threats", RETIREMENT_DEFAULT_MAX_THREATS, RETIREMENT_MAX_THREATS),
  };
}

/**
 * One bounded batch. Phase 1: threats pointing at LEGACY (non-`cluster_`)
 * ids. Phase 2: threats pointing at retired STABLE rows (superseded
 * malformed-ASN rows, shared_infra rows). Each source id is moved by ONE
 * db.batch (atomic) of two statements:
 *   1. `INSERT INTO cluster_repoint_log SELECT id, cluster_id, <target>, now
 *      FROM threats WHERE cluster_id = ? LIMIT <remaining budget>` — an index
 *      seek on (cluster_id, created_at) recording exactly what will move;
 *   2. `UPDATE threats SET cluster_id = <target> WHERE cluster_id = ? AND id
 *      IN (SELECT threat_id FROM cluster_repoint_log WHERE old_cluster_id = ?
 *      AND run_at = <this call>)` — moves exactly the rows this call logged,
 *      and never overwrites a concurrent NEXUS stamp.
 * Idempotent: moved threats leave the source set; a rerun after completion
 * writes nothing and reports done. The per-phase counters (cluster_ids /
 * repoint / release) count only source ids actually handled this call — an
 * id skipped because the threat budget ran out is left for the next call
 * and is not counted (dry runs evaluate every planned id).
 */
export async function runClusterRetirementBatch(
  db: D1Database,
  opts: RetirementBatchOptions,
): Promise<RetirementBatchResult> {
  const maxClusters = Math.max(1, Math.min(RETIREMENT_MAX_CLUSTERS, opts.maxClusters ?? RETIREMENT_DEFAULT_MAX_CLUSTERS));
  let budget = Math.max(1, Math.min(RETIREMENT_MAX_THREATS, opts.maxThreats ?? RETIREMENT_DEFAULT_MAX_THREATS));
  const result: RetirementBatchResult = {
    dry_run: opts.dryRun,
    legacy: { cluster_ids: 0, repoint: 0, release: 0, threats_repointed: 0, threats_released: 0 },
    retired_stable: { cluster_ids: 0, repoint: 0, release: 0, threats_repointed: 0, threats_released: 0 },
    plan_sample: [],
    done: false,
  };

  // Phase 1 — legacy ids still referenced by threats.
  const legacyIds = ((await db.prepare(
    `SELECT DISTINCT cluster_id FROM threats WHERE ${LEGACY_THREAT_CLUSTER_SQL} LIMIT ?`,
  ).bind(maxClusters).all<{ cluster_id: string }>()).results ?? []).map((r) => r.cluster_id);
  const legacyPlan = await planForRows(db, await loadClusterRows(db, legacyIds));

  // Phase 2 — retired stable rows that still have threats.
  const retiredRows = await listRetiredStableRows(db);
  const retiredCounts = await threatCountsByCluster(db, retiredRows.map((r) => r.id));
  const retiredWithThreats = retiredRows.filter((r) => (retiredCounts.get(r.id) ?? 0) > 0).slice(0, maxClusters);
  const retiredPlan = await planForRows(db, retiredWithThreats);

  const legacyCounts = await threatCountsByCluster(db, legacyIds);
  const phases: Array<{ plan: RepointPlanEntry[]; counts: Map<string, number>; out: RetirementBatchResult["legacy"] }> = [
    { plan: legacyPlan, counts: legacyCounts, out: result.legacy },
    { plan: retiredPlan, counts: retiredCounts, out: result.retired_stable },
  ];

  // One run_at per call (ms precision): the UPDATE moves exactly the rows
  // THIS call logged, even if an undo put earlier-logged threats back.
  const runAt = new Date().toISOString().replace("T", " ").slice(0, 23);
  for (const { plan, counts, out } of phases) {
    for (const entry of plan) {
      // Budget exhausted: leave this id for the next call, uncounted.
      if (!opts.dryRun && budget <= 0) continue;
      const n = counts.get(entry.cluster_id) ?? 0;
      out.cluster_ids++;
      if (entry.action === "repoint") out.repoint++;
      else out.release++;
      if (result.plan_sample.length < 25) result.plan_sample.push({ ...entry, threats: n });
      if (opts.dryRun) {
        if (entry.action === "repoint") out.threats_repointed += n;
        else out.threats_released += n;
        continue;
      }
      const [, upd] = await db.batch([
        db.prepare(
          `INSERT INTO cluster_repoint_log (threat_id, old_cluster_id, new_cluster_id, run_at)
           SELECT id, cluster_id, ?, ? FROM threats WHERE cluster_id = ? LIMIT ?`,
        ).bind(entry.target, runAt, entry.cluster_id, budget),
        db.prepare(
          `UPDATE threats SET cluster_id = ?
            WHERE cluster_id = ?
              AND id IN (SELECT threat_id FROM cluster_repoint_log
                          WHERE old_cluster_id = ? AND run_at = ?)`,
        ).bind(entry.target, entry.cluster_id, entry.cluster_id, runAt),
      ]);
      const moved = Number(upd?.meta?.changes ?? 0);
      budget -= moved;
      if (entry.action === "repoint") out.threats_repointed += moved;
      else out.threats_released += moved;
    }
  }

  if (opts.dryRun) {
    result.done = legacyIds.length === 0 && retiredWithThreats.length === 0;
  } else {
    // Re-probe instead of inferring from counters: done means no source
    // threat is left in either phase.
    const left = await db.prepare(
      `SELECT 1 AS x FROM threats WHERE ${LEGACY_THREAT_CLUSTER_SQL} LIMIT 1`,
    ).first<{ x: number }>();
    const retiredLeft = [...(await threatCountsByCluster(db, retiredRows.map((r) => r.id))).values()].some((n) => n > 0);
    result.done = !left && !retiredLeft;
  }
  return result;
}
