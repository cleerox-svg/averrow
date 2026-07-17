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
//   * a stable id prefix `tat_otxinherit_` (queryable, dedup key)
//   * `metadata.inherited = true` + `metadata.inherit_origin = 'otx'`
//   * confidence 'low' -- strictly weaker than the 'medium' the direct
//     OTX pulse attribution carries (never higher than the source).

import type { D1Database } from '@cloudflare/workers-types';
import { recordAttribution, type AttributionSource } from './otx-attribution';

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

// ─── I/O orchestration ───────────────────────────────────────────────

export interface InheritResult {
  /** Clusters that had >=1 OTX-attributed member (candidate set). */
  clusters_scanned: number;
  /** Clusters skipped because members named >=2 distinct OTX actors. */
  clusters_ambiguous: number;
  /** Clusters skipped because a cluster-level actor already disagrees. */
  clusters_conflict_skipped: number;
  /** Clusters that produced >=1 inherited member attribution. */
  clusters_inherited: number;
  /** Un-attributed member rows given an inherited attribution. */
  members_attributed: number;
  /** Clusters whose cluster-level actor_id was set from the inheritance. */
  clusters_actor_set: number;
}

interface DiscoveryRow {
  cluster_id: string;
  actor_id: string;
  actor_name: string | null;
}

// Bound total inherited writes per invocation so a large first-run
// backlog can't blow the worker's wall-clock budget. Hourly cadence
// (attributor post-pass) drains the remainder; idempotency makes every
// re-run cheap (already-attributed members drop out of the candidate
// member scan, so drained clusters cost ~0).
const MAX_MEMBER_WRITES_PER_RUN = 5000;
// SQLite bound-parameter ceiling is 999; stay well under it for IN(...).
const IN_CHUNK = 800;

/**
 * Inherit single-actor OTX attributions from cluster members onto their
 * un-attributed siblings. Idempotent: reruns write 0 new rows.
 *
 * Efficiency: candidate discovery is a single grouped join over the
 * OTX-attribution index (no per-cluster N+1); member selection for the
 * winning clusters is chunked IN(...) queries. No full scan of threats.
 */
export async function inheritOtxActorsToClusters(
  db: D1Database,
): Promise<InheritResult> {
  const result: InheritResult = {
    clusters_scanned: 0,
    clusters_ambiguous: 0,
    clusters_conflict_skipped: 0,
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
  for (const chunk of chunkArray(winners, IN_CHUNK)) {
    const rows = await db.prepare(`
      SELECT id, actor_id
      FROM infrastructure_clusters
      WHERE id IN (${placeholders(chunk.length)})
    `).bind(...chunk).all<{ id: string; actor_id: string | null }>();
    for (const r of rows.results ?? []) clusterActor.set(r.id, r.actor_id);
  }

  // Drop clusters whose cluster-level actor already names someone else.
  const eligible: string[] = [];
  for (const clusterId of winners) {
    const existing = clusterActor.get(clusterId) ?? null;
    const decision = chosen.get(clusterId)!;
    if (existing !== null && existing !== decision.actor_id) {
      result.clusters_conflict_skipped++;
      continue;
    }
    eligible.push(clusterId);
  }
  if (eligible.length === 0) return result;

  // Step 3 — pull un-attributed members for eligible clusters. A member
  // is "un-attributed" when it has no threat_attributions row at all;
  // this guarantees we never stack a conflicting second attribution on
  // a threat that's already been attributed by any source.
  const membersByCluster = new Map<string, string[]>();
  for (const chunk of chunkArray(eligible, IN_CHUNK)) {
    const rows = await db.prepare(`
      SELECT t.id AS threat_id, t.cluster_id AS cluster_id
      FROM threats t
      WHERE t.cluster_id IN (${placeholders(chunk.length)})
        AND NOT EXISTS (
          SELECT 1 FROM threat_attributions ta WHERE ta.threat_id = t.id
        )
    `).bind(...chunk).all<{ threat_id: string; cluster_id: string }>();
    for (const r of rows.results ?? []) {
      const list = membersByCluster.get(r.cluster_id) ?? [];
      list.push(r.threat_id);
      membersByCluster.set(r.cluster_id, list);
    }
  }

  // Step 4 — write inherited attribution rows + optionally stamp the
  // cluster-level actor. Deterministic id keeps this idempotent
  // (INSERT OR IGNORE inside recordAttribution); the cluster stamp is
  // guarded on actor_id being null so it never overrides a real
  // classification and is a no-op on rerun.
  let writeBudget = MAX_MEMBER_WRITES_PER_RUN;
  for (const clusterId of eligible) {
    if (writeBudget <= 0) break;
    const decision = chosen.get(clusterId)!;
    const members = membersByCluster.get(clusterId) ?? [];

    let wroteForCluster = 0;
    for (const threatId of members) {
      if (writeBudget <= 0) break;
      await recordAttribution(db, {
        id: `tat_otxinherit_${clusterId}_${threatId}`,
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
      });
      wroteForCluster++;
      result.members_attributed++;
      writeBudget--;
    }

    if (wroteForCluster > 0) result.clusters_inherited++;

    // Stamp the cluster-level actor when it has none yet. Bounded to the
    // null case so a Haiku classification is never clobbered.
    if ((clusterActor.get(clusterId) ?? null) === null) {
      const upd = await db.prepare(`
        UPDATE infrastructure_clusters
           SET actor_id = ?
         WHERE id = ?
           AND actor_id IS NULL
      `).bind(decision.actor_id, clusterId).run();
      if (upd.meta.changes && upd.meta.changes > 0) result.clusters_actor_set++;
    }
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
