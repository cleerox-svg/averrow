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
// Conservative by design -- a wrong attribution is worse than none. A
// cluster inherits (cluster actor_id stamp AND member rows) only when ALL
// of the policy rules in decideInheritedActor hold (2026-10-21 threat-intel
// review: every one of the 34 then-winning clusters was indefensible --
// 22 ASN-lane, 9 /24, 1 registrar, and the per-IP / subnet ones sat on
// multi-tenant hosting/parking even though their `asns` column read `[]`):
//   1. lane     -- specific-evidence clusters only (cert-serial, cert-SAN,
//                  per-IP: isBridgeKind(classifyClusterKind(...)), the same
//                  taxonomy the component post-pass uses). ASN, /24,
//                  registrar, app-store, dark-web and unknown ids never
//                  inherit: co-membership there is not evidence of one
//                  operator (the ASN lane disagrees with itself 63% of the
//                  time when >= 2 members carry OTX actors).
//   2. multi-tenant -- no member threat sits on a MULTI_TENANT_ASNS network,
//                  checked on each member's own threats.asn (the cluster
//                  `asns` column is not trusted: NULL-asn members leave it
//                  `[]`).
//   3. quorum   -- >= INHERIT_MIN_OTX_MEMBERS distinct OTX-attributed
//                  members, all naming ONE actor (>= 2 actors = ambiguous).
//   4. coverage -- OTX-attributed members >= INHERIT_MIN_OTX_COVERAGE of
//                  the cluster's members.
//   5. size     -- cluster members <= INHERIT_MAX_CLUSTER_MEMBERS.
//
// Inherited rows written before this policy (tat_otxinherit_*, and the
// cluster actor_id stamps they produced) were revoked by migration 0309
// (owner decision 2026-10-22); backups live in threat_attributions_revoked /
// cluster_actor_revocations (restore recipe in the migration header). This
// module only writes rows that pass the policy.
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
import { classifyClusterKind, isBridgeKind } from './cluster-components';
import { asnKeySql, MULTI_TENANT_ASNS } from './shared-infra-asns';

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

// ─── Inheritance policy thresholds ──────────────────────────────────

/** Rule 3: distinct OTX-attributed members required (all one actor). */
export const INHERIT_MIN_OTX_MEMBERS = 2;
/** Rule 4: OTX-attributed members / cluster members must be >= this. */
export const INHERIT_MIN_OTX_COVERAGE = 0.1;
/** Rule 5: clusters with more members than this never inherit. */
export const INHERIT_MAX_CLUSTER_MEMBERS = 250;

/** Why a cluster did not inherit (one counter per reason in InheritResult). */
export type InheritSkipReason = 'lane' | 'ambiguous' | 'quorum' | 'size' | 'multitenant' | 'coverage';

/** Member counts measured SQL-side over at most INHERIT_MAX_CLUSTER_MEMBERS + 1 rows. */
export interface ClusterMemberStats {
  /** Members read, capped at INHERIT_MAX_CLUSTER_MEMBERS + 1 (enough to fail rule 5). */
  memberCount: number;
  /** Of those, members whose own threats.asn normalises into MULTI_TENANT_ASNS. */
  multiTenantMembers: number;
}

export interface InheritPolicyInput {
  clusterId: string;
  /** infrastructure_clusters.agent_notes (JSON-object form; null otherwise). */
  agentNotes: string | null;
  /** Distinct (actor) OTX attributions among the cluster's members. */
  memberAttributions: MemberOtxAttribution[];
  /** Distinct member threats carrying an OTX attribution. */
  otxMemberCount: number;
  /** Omitted until measured — rules 2/4/5 need it (see needs_member_stats). */
  memberStats?: ClusterMemberStats | null;
}

export type InheritVerdict =
  | { status: 'inherit'; decision: InheritedActorDecision }
  | { status: 'skip'; reason: InheritSkipReason }
  /** Rules 1 and 3 pass; measure ClusterMemberStats and decide again. */
  | { status: 'needs_member_stats' };

/**
 * Collapse a cluster's OTX attributions to the single actor they agree on,
 * or null when there is none (0 actors) or they disagree (>= 2 actors).
 * Keeps the first non-null name seen for the actor.
 */
export function singleOtxActor(
  memberAttributions: MemberOtxAttribution[],
): InheritedActorDecision | null {
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

/**
 * The inheritance policy (see the header), as a pure, deterministic
 * function. Rules are checked in a fixed order and the first that fails is
 * the reported skip reason: lane, ambiguous, quorum, then — once member
 * stats are supplied — size, multitenant, coverage. Size precedes
 * multitenant because the stats query reads at most
 * INHERIT_MAX_CLUSTER_MEMBERS + 1 members, so its multi-tenant count is
 * complete only for a cluster that passes the size rule.
 */
export function decideInheritedActor(input: InheritPolicyInput): InheritVerdict {
  // Rule 1 — specific-evidence lane only.
  if (!isBridgeKind(classifyClusterKind(input.clusterId, input.agentNotes))) {
    return { status: 'skip', reason: 'lane' };
  }
  // Rule 3 — one agreeing actor, named by >= INHERIT_MIN_OTX_MEMBERS members.
  const distinctActors = new Set(input.memberAttributions.map((m) => m.actor_id).filter(Boolean));
  if (distinctActors.size >= 2) return { status: 'skip', reason: 'ambiguous' };
  const decision = singleOtxActor(input.memberAttributions);
  if (!decision || input.otxMemberCount < INHERIT_MIN_OTX_MEMBERS) {
    return { status: 'skip', reason: 'quorum' };
  }
  const stats = input.memberStats;
  if (!stats) return { status: 'needs_member_stats' };
  // Rule 5 — size backstop.
  if (stats.memberCount > INHERIT_MAX_CLUSTER_MEMBERS) return { status: 'skip', reason: 'size' };
  // Rule 2 — no member on multi-tenant hosting / parking.
  if (stats.multiTenantMembers > 0) return { status: 'skip', reason: 'multitenant' };
  // Rule 4 — coverage. A division (not otx >= n * 0.1, where 30 * 0.1 is
  // 3.0000000000000004) so exactly 10% passes.
  if (stats.memberCount <= 0 || input.otxMemberCount / stats.memberCount < INHERIT_MIN_OTX_COVERAGE) {
    return { status: 'skip', reason: 'coverage' };
  }
  return { status: 'inherit', decision };
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
  /** Policy rule 1: not a specific-evidence (cert / per-IP) cluster. */
  clusters_skipped_lane: number;
  /** Policy rule 2: a member threat sits on a multi-tenant ASN. */
  clusters_skipped_multitenant: number;
  /** Policy rule 3: fewer than INHERIT_MIN_OTX_MEMBERS OTX-attributed members. */
  clusters_skipped_quorum: number;
  /** Policy rule 4: OTX-attributed members below INHERIT_MIN_OTX_COVERAGE. */
  clusters_skipped_coverage: number;
  /** Policy rule 5: more than INHERIT_MAX_CLUSTER_MEMBERS members. */
  clusters_skipped_size: number;
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
  /** Distinct member threats carrying an OTX row for this actor. */
  otx_members: number;
}

type SkipCounter =
  | 'clusters_skipped_lane' | 'clusters_ambiguous' | 'clusters_skipped_quorum'
  | 'clusters_skipped_size' | 'clusters_skipped_multitenant' | 'clusters_skipped_coverage';

const SKIP_COUNTER: Record<InheritSkipReason, SkipCounter> = {
  lane: 'clusters_skipped_lane',
  ambiguous: 'clusters_ambiguous',
  quorum: 'clusters_skipped_quorum',
  size: 'clusters_skipped_size',
  multitenant: 'clusters_skipped_multitenant',
  coverage: 'clusters_skipped_coverage',
};

const MULTI_TENANT_ASN_LIST: readonly string[] = [...MULTI_TENANT_ASNS];

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
 * Inherit OTX attributions from cluster members onto their un-attributed
 * siblings for clusters that pass the inheritance policy
 * (decideInheritedActor). Idempotent: reruns write 0 new rows.
 *
 * Efficiency: candidate discovery is a single grouped join over the
 * OTX-attribution index (no per-cluster N+1); cluster rows are read in
 * IN_CHUNK chunks. Per specific-lane, single-actor, quorate cluster: one
 * member-stats read bounded at INHERIT_MAX_CLUSTER_MEMBERS + 1 rows. Per
 * eligible cluster: one indexed member read LIMITed to the remaining write
 * budget, then ceil(rows / WRITE_BATCH) batched writes. D1 round-trips per
 * call are bounded by 1 + scanned/IN_CHUNK + candidates + eligible +
 * cap/WRITE_BATCH + eligible, not by member count. No full scan of threats.
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
    clusters_skipped_lane: 0,
    clusters_skipped_multitenant: 0,
    clusters_skipped_quorum: 0,
    clusters_skipped_coverage: 0,
    clusters_skipped_size: 0,
    clusters_conflict_skipped: 0,
    clusters_retired_skipped: 0,
    clusters_inherited: 0,
    members_attributed: 0,
    clusters_actor_set: 0,
  };

  // Step 1 — discovery. One grouped join yields, per (cluster, actor),
  // how many distinct member threats carry that OTX actor.
  // Driven from threat_attributions filtered on source (idx_attribution_source),
  // joined to threats on the PK (t.id = ta.threat_id) — not a threats scan.
  const discovery = await db.prepare(`
    SELECT t.cluster_id          AS cluster_id,
           ta.actor_id           AS actor_id,
           act.name              AS actor_name,
           COUNT(DISTINCT t.id)  AS otx_members
    FROM threat_attributions ta
    JOIN threats t ON t.id = ta.threat_id
    LEFT JOIN threat_actors act ON act.id = ta.actor_id
    WHERE ta.source = 'otx'
      AND ta.actor_id IS NOT NULL
      AND t.cluster_id IS NOT NULL
    GROUP BY t.cluster_id, ta.actor_id
    ORDER BY t.cluster_id
  `).all<DiscoveryRow>();

  const byCluster = new Map<string, { attributions: MemberOtxAttribution[]; otxMembers: number }>();
  for (const row of discovery.results ?? []) {
    const entry = byCluster.get(row.cluster_id) ?? { attributions: [], otxMembers: 0 };
    entry.attributions.push({ actor_id: row.actor_id, actor_name: row.actor_name });
    // Summed across actors; only read when exactly one actor is present,
    // where it is exactly that actor's distinct member count.
    entry.otxMembers += Number(row.otx_members ?? 0);
    byCluster.set(row.cluster_id, entry);
  }
  result.clusters_scanned = byCluster.size;
  if (byCluster.size === 0) return result;

  // Step 2 — read each candidate cluster's row: retirement, the current
  // cluster-level actor (conflict check + whether to stamp) and agent_notes
  // (classifyClusterKind needs it to tell cert-serial from cert-SAN).
  // Not filtered with notRetiredClusterSql() on purpose: the row is read so
  // a retired cluster is counted in clusters_retired_skipped and dropped
  // below (isRetiredCluster). Retired rows (retired_reason superseded /
  // shared_infra — see lib/cluster-status.ts) are not operations: never
  // inherit onto them or fan an actor out to their members. agent_notes is
  // projected to its JSON-object form only (the per-IP / ASN lanes write a
  // free-text string that classifyClusterKind ignores) — same projection as
  // groupClusterComponents.
  const scannedIds = [...byCluster.keys()].sort();
  const clusterActor = new Map<string, string | null>();
  const clusterNotes = new Map<string, string | null>();
  const retiredClusters = new Set<string>();
  for (const chunk of chunkArray(scannedIds, IN_CHUNK)) {
    const rows = await db.prepare(`
      SELECT id, actor_id, retired_reason,
             CASE WHEN substr(ltrim(agent_notes, ' ' || char(9) || char(10) || char(13)), 1, 1) = '{'
                  THEN agent_notes END AS agent_notes
      FROM infrastructure_clusters
      WHERE id IN (${placeholders(chunk.length)})
    `).bind(...chunk).all<{ id: string; actor_id: string | null; retired_reason: string | null; agent_notes: string | null }>();
    for (const r of rows.results ?? []) {
      if (isRetiredCluster(r.retired_reason)) retiredClusters.add(r.id);
      clusterActor.set(r.id, r.actor_id);
      clusterNotes.set(r.id, r.agent_notes);
    }
  }

  // Step 3 — the policy. First pass decides rules 1 and 3 from what is
  // already in hand; only survivors cost a member-stats read.
  const chosen = new Map<string, InheritedActorDecision>();
  const policyInput = (clusterId: string, memberStats?: ClusterMemberStats): InheritPolicyInput => {
    const entry = byCluster.get(clusterId)!;
    return {
      clusterId,
      agentNotes: clusterNotes.get(clusterId) ?? null,
      memberAttributions: entry.attributions,
      otxMemberCount: entry.otxMembers,
      memberStats,
    };
  };
  const apply = (clusterId: string, verdict: InheritVerdict): boolean => {
    if (verdict.status === 'skip') {
      result[SKIP_COUNTER[verdict.reason]]++;
      return false;
    }
    if (verdict.status === 'inherit') {
      // Never override a cluster-level actor that names someone else.
      const existing = clusterActor.get(clusterId) ?? null;
      if (existing !== null && existing !== verdict.decision.actor_id) {
        result.clusters_conflict_skipped++;
        return false;
      }
      chosen.set(clusterId, verdict.decision);
    }
    return true;
  };

  const needStats: string[] = [];
  for (const clusterId of scannedIds) {
    if (retiredClusters.has(clusterId)) {
      result.clusters_retired_skipped++;
      continue;
    }
    const verdict = decideInheritedActor(policyInput(clusterId));
    if (verdict.status === 'needs_member_stats') needStats.push(clusterId);
    else apply(clusterId, verdict);
  }

  // Member stats: one bounded read per surviving cluster. The inner LIMIT
  // (INHERIT_MAX_CLUSTER_MEMBERS + 1) caps rows read at 251 however large
  // the cluster is — just enough to fail the size rule — and it seeks
  // idx_threats_cluster_recent (cluster_id, created_at). Each member's OWN
  // threats.asn is normalised with asnKeySql (the cluster `asns` column is
  // not trusted). Binds: 27 multi-tenant ASNs + 2, under D1's 100.
  for (const clusterId of needStats) {
    if (now() >= deadline) {
      result.stopped_reason = 'deadline';
      return result;
    }
    const stats = await db.prepare(`
      SELECT COUNT(*) AS member_count,
             COALESCE(SUM(CASE WHEN ${asnKeySql('m.asn')} IN (${placeholders(MULTI_TENANT_ASN_LIST.length)})
                               THEN 1 ELSE 0 END), 0) AS multi_tenant_members
        FROM (SELECT t.asn AS asn FROM threats t WHERE t.cluster_id = ? LIMIT ?) m
    `).bind(...MULTI_TENANT_ASN_LIST, clusterId, INHERIT_MAX_CLUSTER_MEMBERS + 1)
      .first<{ member_count: number; multi_tenant_members: number }>();
    apply(clusterId, decideInheritedActor(policyInput(clusterId, {
      memberCount: Number(stats?.member_count ?? 0),
      multiTenantMembers: Number(stats?.multi_tenant_members ?? 0),
    })));
  }

  const eligible = [...chosen.keys()].sort();
  if (eligible.length === 0) return result;

  // Steps 4 + 5 — per eligible cluster, in sorted order (stable progress
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
