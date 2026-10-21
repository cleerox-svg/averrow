// OTX actor -> cluster attribution inheritance.
//
// OTX writes NAMED per-threat actors (feeds/otx_alienvault.ts ->
// recordOtxAttribution, source='otx'). But nothing propagates a named
// actor from one member threat up to its whole infrastructure cluster,
// so a cluster with one OTX-named member and dozens of un-named
// siblings stays effectively "unknown" at the cluster level.
//
// This module fixes that with pure SQL (zero AI tokens): when a
// cluster's OTX-attributed members all point at the SAME actor, we
// inherit that actor onto the cluster's un-attributed siblings.
//
// Conservative by design -- a wrong attribution is worse than none:
//   * exactly ONE distinct OTX actor among members  -> inherit it
//   * two or more distinct OTX actors (disagreement) -> skip (no guess)
//   * no OTX-named actor among members               -> skip
//
// Provenance: the `source` column carries a hard CHECK constraint
// (migration 0135) limiting it to 'otx' | 'nexus' | 'manual' | 'news',
// so inherited rows cannot take a bespoke source string without an
// unsafe table rebuild. We reuse 'nexus' (cluster-scoped inference,
// same convention the attributor's own member fan-out uses) and make
// inherited rows unambiguously identifiable by:
//   * a stable id prefix `tat_otxinherit_` (queryable) + a SHA-256 of
//     (cluster, threat) — see inheritedAttributionId
//   * `metadata.inherited = true` + `metadata.inherit_origin = 'otx'`
//   * confidence 'low' -- strictly weaker than the 'medium' the direct
//     OTX pulse attribution carries (never higher than the source).

import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import { recordAttributionStmt, type AttributionSource } from './otx-attribution';
import { isRetiredCluster } from './cluster-status';
import { hashToken } from './hash';

// ─── Pure decision function (no I/O, no clock) ───────────────────────

/** One OTX-sourced attribution observed among a cluster's members. */
export interface MemberOtxAttribution {
  actor_id: string;
  actor_name: string | null;
}

export interface InheritedActorDecision {
  actor_id: string;
  actor_name: string | null;
  /** Never higher than the source ('otx' rows are 'medium'). */
  confidence: 'low';
  /** CHECK-constrained; 'nexus' = cluster-scoped inference. */
  source: AttributionSource;
}

/**
 * Given the OTX-sourced attributions of a cluster's members, return the
 * single actor to inherit onto the cluster's un-attributed members, or
 * null when it's ambiguous. Deterministic and side-effect-free so it's
 * trivially unit-testable (mirrors lib/alert-triage.ts's decide* fns).
 *
 *   0 distinct OTX actors -> null (nothing to inherit)
 *   1 distinct OTX actor  -> inherit it
 *   >=2 distinct OTX actors -> null (members disagree; don't guess)
 */
export function decideInheritedActor(
  memberAttributions: MemberOtxAttribution[],
): InheritedActorDecision | null {
  // Collapse to distinct actor_ids, keeping the first non-null name seen.
  const distinct = new Map<string, string | null>();
  for (const m of memberAttributions) {
    if (!m.actor_id) continue;
    const existing = distinct.get(m.actor_id);
    if (existing === undefined || (existing === null && m.actor_name)) {
      distinct.set(m.actor_id, m.actor_name ?? null);
    }
  }
  if (distinct.size !== 1) return null;
  const entry = [...distinct.entries()][0];
  if (!entry) return null;
  const [actor_id, actor_name] = entry;
  return { actor_id, actor_name, confidence: 'low', source: 'nexus' };
}

/** Fixed prefix of every inherited row id (queryable provenance). */
export const INHERITED_ID_PREFIX = 'tat_otxinherit_';

/**
 * Deterministic, unique, bounded id for one inherited member row:
 * `tat_otxinherit_` + hex SHA-256 of `${clusterId}|${threatId}` (79 chars).
 *
 * The id used to be `tat_otxinherit_${clusterId}_${threatId}`, which
 * recordAttributionStmt clips to 100 chars. Prod live cluster ids reach 77
 * chars (2026-10-21: 70 of 314 live clusters are >48) and threat ids reach
 * 36 (UUIDs), so for a long cluster id every member clipped to the SAME id:
 * INSERT OR IGNORE kept one row and dropped the rest forever. A digest is
 * fixed-length regardless of either input, so it can't collide that way.
 * Rows written under the old scheme stay valid: the member read excludes a
 * threat that has ANY attribution row, whatever its id.
 */
export async function inheritedAttributionId(clusterId: string, threatId: string): Promise<string> {
  return INHERITED_ID_PREFIX + (await hashToken(`${clusterId}|${threatId}`));
}

// ─── I/O orchestration ───────────────────────────────────────────────

export interface InheritResult {
  /** Clusters that had >=1 OTX-attributed member (candidate set). */
  clusters_scanned: number;
  /** Clusters skipped because members named >=2 distinct OTX actors. */
  clusters_ambiguous: number;
  /** Clusters skipped because a cluster-level actor already disagrees. */
  clusters_conflict_skipped: number;
  /** Clusters skipped because their row is retired (superseded / shared_infra). */
  clusters_retired_skipped: number;
  /** Clusters that produced >=1 inherited member attribution. */
  clusters_inherited: number;
  /** Un-attributed member rows given an inherited attribution. */
  members_attributed: number;
  /** Clusters whose cluster-level actor_id was set from the inheritance. */
  clusters_actor_set: number;
  /**
   * Why the write step stopped before reaching every eligible cluster:
   * 'write_cap' (MAX_MEMBER_WRITES_PER_RUN reached) or 'deadline' (wall-
   * clock budget). null = every eligible cluster was processed. Either
   * non-null value means a backlog remains for the next run.
   */
  stopped_reason: 'write_cap' | 'deadline' | null;
}

interface DiscoveryRow {
  cluster_id: string;
  actor_id: string;
  actor_name: string | null;
}

// Bound total inherited writes per invocation so a large backlog can't
// blow the worker's wall-clock / subrequest budget. The attributor's
// cadence (orchestrator hour % 4 === 1, plus FC stall recovery) drains the
// remainder; idempotency makes every re-run cheap (already-attributed
// members drop out of the member read, so drained clusters cost ~0).
export const MAX_MEMBER_WRITES_PER_RUN = 5000;
// Statements per db.batch() round-trip in the write step. 5,000 member
// rows = 50 round-trips (was 5,000 sequential awaits). Each statement
// binds 9 params, well under D1's 100-per-statement cap.
export const WRITE_BATCH = 100;
// Default wall-clock budget for the whole pass. The attributor shares its
// host invocation (the hourly orchestrator tick, or FC's waitUntil) with
// many other agents, so it must finish in well under a minute or two and
// leave the rest for the next run rather than be killed mid-loop.
export const DEFAULT_INHERIT_BUDGET_MS = 90_000;

export interface InheritOptions {
  /** Cap on member rows written this call (default MAX_MEMBER_WRITES_PER_RUN). */
  maxMemberWrites?: number;
  /** Wall-clock budget for the call, ms (default DEFAULT_INHERIT_BUDGET_MS). */
  budgetMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}
// D1 caps bound parameters at 100 per statement (NOT SQLite's 999). The
// former 800 here failed the attributor in prod once >100 clusters won the
// inheritance decision ("too many SQL variables at offset 281" = the 101st
// `?` of the Step 2 lookup) and auto-paused it 2026-07-21. Each IN(...)
// below binds only the chunk, so 90 leaves headroom like the repo's other
// *_CHUNK = 90 constants (lib/cluster-retirement.ts, lib/provider-trends.ts).
const IN_CHUNK = 90;

/**
 * Inherit single-actor OTX attributions from cluster members onto their
 * un-attributed siblings. Idempotent: reruns write 0 new rows.
 *
 * Efficiency: candidate discovery is a single grouped join over the
 * OTX-attribution index (no per-cluster N+1). Per eligible cluster: one
 * indexed member read LIMITed to the remaining write budget, then
 * ceil(rows / WRITE_BATCH) batched writes. D1 round-trips per call are
 * bounded by ~2 + eligible/IN_CHUNK + eligible + cap/WRITE_BATCH + eligible
 * (≈120 at prod size), not by member count. No full scan of threats.
 */
export async function inheritOtxActorsToClusters(
  db: D1Database,
  opts: InheritOptions = {},
): Promise<InheritResult> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? DEFAULT_INHERIT_BUDGET_MS);
  const maxMemberWrites = opts.maxMemberWrites ?? MAX_MEMBER_WRITES_PER_RUN;
  const result: InheritResult = {
    stopped_reason: null,
    clusters_scanned: 0,
    clusters_ambiguous: 0,
    clusters_conflict_skipped: 0,
    clusters_retired_skipped: 0,
    clusters_inherited: 0,
    members_attributed: 0,
    clusters_actor_set: 0,
  };

  // Step 1 — discovery. One grouped join yields, per (cluster, actor),
  // the distinct OTX actors present among that cluster's members.
  // Driven from threat_attributions filtered on source (idx_attribution_source),
  // joined to threats on the PK (t.id = ta.threat_id) — not a threats scan.
  const discovery = await db.prepare(`
    SELECT t.cluster_id AS cluster_id,
           ta.actor_id  AS actor_id,
           act.name     AS actor_name
    FROM threat_attributions ta
    JOIN threats t ON t.id = ta.threat_id
    LEFT JOIN threat_actors act ON act.id = ta.actor_id
    WHERE ta.source = 'otx'
      AND ta.actor_id IS NOT NULL
      AND t.cluster_id IS NOT NULL
    GROUP BY t.cluster_id, ta.actor_id
    ORDER BY t.cluster_id
  `).all<DiscoveryRow>();

  // Group discovery rows by cluster, then run the pure decider.
  const byCluster = new Map<string, MemberOtxAttribution[]>();
  for (const row of discovery.results ?? []) {
    const list = byCluster.get(row.cluster_id) ?? [];
    list.push({ actor_id: row.actor_id, actor_name: row.actor_name });
    byCluster.set(row.cluster_id, list);
  }
  result.clusters_scanned = byCluster.size;

  // Winning clusters -> chosen actor (deterministic order for stable
  // per-run progress under the member-write cap).
  const chosen = new Map<string, InheritedActorDecision>();
  for (const clusterId of [...byCluster.keys()].sort()) {
    const decision = decideInheritedActor(byCluster.get(clusterId)!);
    if (!decision) {
      result.clusters_ambiguous++;
      continue;
    }
    chosen.set(clusterId, decision);
  }
  if (chosen.size === 0) return result;

  // Step 2 — fetch current cluster-level actor_id for winning clusters
  // to (a) skip clusters whose existing actor disagrees with the
  // inheritance and (b) know whether to set actor_id afterwards.
  const winners = [...chosen.keys()];
  const clusterActor = new Map<string, string | null>();
  const retiredClusters = new Set<string>();
  for (const chunk of chunkArray(winners, IN_CHUNK)) {
    // Not filtered with notRetiredClusterSql() on purpose: the row is read so
    // a retired cluster is counted in clusters_retired_skipped and dropped
    // below (isRetiredCluster). Retired rows (retired_reason superseded / shared_infra — see
    // lib/cluster-status.ts) are not operations: never inherit onto them or
    // fan an actor out to their members.
    const rows = await db.prepare(`
      SELECT id, actor_id, retired_reason
      FROM infrastructure_clusters
      WHERE id IN (${placeholders(chunk.length)})
    `).bind(...chunk).all<{ id: string; actor_id: string | null; retired_reason: string | null }>();
    for (const r of rows.results ?? []) {
      if (isRetiredCluster(r.retired_reason)) retiredClusters.add(r.id);
      clusterActor.set(r.id, r.actor_id);
    }
  }

  // Drop retired clusters, and clusters whose cluster-level actor already
  // names someone else.
  const eligible: string[] = [];
  for (const clusterId of winners) {
    if (retiredClusters.has(clusterId)) {
      result.clusters_retired_skipped++;
      continue;
    }
    const existing = clusterActor.get(clusterId) ?? null;
    const decision = chosen.get(clusterId)!;
    if (existing !== null && existing !== decision.actor_id) {
      result.clusters_conflict_skipped++;
      continue;
    }
    eligible.push(clusterId);
  }
  if (eligible.length === 0) return result;

  // Steps 3 + 4 — per eligible cluster, in sorted order (stable progress
  // under the cap, run to run): read at most the remaining write budget of
  // its un-attributed members, then write their inherited rows plus the
  // cluster-level actor stamp in db.batch() chunks of WRITE_BATCH.
  //
  // A member is "un-attributed" when it has no threat_attributions row at
  // all, so we never stack a conflicting second attribution on a threat any
  // source already attributed. Deterministic ids + INSERT OR IGNORE keep
  // this idempotent; the cluster stamp is guarded on actor_id IS NULL so it
  // never overrides a real classification and is a no-op on rerun.
  //
  // Prod 2026-10-21: this step used to read every eligible member at once
  // (~44K rows; one ASN cluster alone has 33K) and await one INSERT per
  // member. At ~170ms per D1 round-trip the 5,000-row cap needed ~14
  // minutes, so both attributor runs died with their host invocation
  // mid-loop (agent_runs left 'partial' with completed_at NULL). Now the
  // read is LIMITed to the budget, writes cost one round-trip per
  // WRITE_BATCH rows, and a wall-clock budget stops the pass cleanly
  // between round-trips. The remainder drains on later runs.
  let writeBudget = maxMemberWrites;
  for (const clusterId of eligible) {
    if (writeBudget <= 0) {
      result.stopped_reason = 'write_cap';
      break;
    }
    if (now() >= deadline) {
      result.stopped_reason = 'deadline';
      break;
    }
    const decision = chosen.get(clusterId)!;

    const rows = await db.prepare(`
      SELECT t.id AS threat_id
      FROM threats t
      WHERE t.cluster_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM threat_attributions ta WHERE ta.threat_id = t.id
        )
      LIMIT ?
    `).bind(clusterId, writeBudget).all<{ threat_id: string }>();
    const members = (rows.results ?? []).map((r) => r.threat_id);

    const stmts: D1PreparedStatement[] = [];
    // Cluster-level actor stamp goes first in the cluster's first batch, so
    // a deadline stop mid-cluster still leaves the cluster named.
    const stampActor = (clusterActor.get(clusterId) ?? null) === null;
    if (stampActor) {
      stmts.push(db.prepare(`
        UPDATE infrastructure_clusters
           SET actor_id = ?
         WHERE id = ?
           AND actor_id IS NULL
      `).bind(decision.actor_id, clusterId));
    }
    const ids = await Promise.all(members.map((threatId) => inheritedAttributionId(clusterId, threatId)));
    members.forEach((threatId, idx) => {
      stmts.push(recordAttributionStmt(db, {
        id: ids[idx]!,
        threatId,
        actorId: decision.actor_id,
        source: decision.source,
        sourcePulseId: clusterId,
        sourcePulseName: decision.actor_name,
        actorNameRaw: decision.actor_name,
        confidence: decision.confidence,
        metadata: {
          inherited: true,
          inherit_origin: 'otx',
          cluster_id: clusterId,
          actor_name: decision.actor_name,
        },
      }));
    });

    let wroteForCluster = 0;
    for (let i = 0; i < stmts.length; i += WRITE_BATCH) {
      if (i > 0 && now() >= deadline) {
        result.stopped_reason = 'deadline';
        break;
      }
      const slice = stmts.slice(i, i + WRITE_BATCH);
      const res = await db.batch(slice);
      const hasStamp = i === 0 && stampActor;
      res.forEach((r, k) => {
        const changed = (r?.meta?.changes ?? 0) > 0;
        if (hasStamp && k === 0) {
          if (changed) result.clusters_actor_set++;
        } else if (changed) {
          wroteForCluster++;
        }
      });
    }

    if (wroteForCluster > 0) result.clusters_inherited++;
    result.members_attributed += wroteForCluster;
    // Charge the cap by rows actually written (meta.changes), not rows
    // attempted: an ignored insert (id collision, or a concurrent writer that
    // attributed the threat between our read and write) costs no D1 write,
    // and charging it would let a cluster whose inserts keep being ignored
    // eat the whole per-run cap and starve every cluster sorted after it.
    // The wall-clock deadline still bounds a run that writes little.
    writeBudget -= wroteForCluster;
    if (result.stopped_reason === 'deadline') break;
  }

  return result;
}

// ─── helpers ─────────────────────────────────────────────────────────

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
