// NEXUS connected-components grouping layer (S2.4 / D5a).
//
// The six NEXUS lanes (cert-serial → cert-SAN → per-IP → /24 → registrar
// → ASN) each stamp `threats.cluster_id` under a first-wins
// `cluster_id IS NULL` guard and write per-key `infrastructure_clusters`
// rows with deterministic natural-key ids. A single operator routinely
// spans MORE than one per-key cluster: their domains share a cert serial
// (one `cluster_cert_*`) AND park on a shared IP (one `cluster_ip_*`).
// This post-pass groups those per-key clusters into transitive COMPONENTS
// and stamps a `component_id` on each grouped cluster row.
//
// It NEVER touches `threats.cluster_id` (the first-wins stamp is
// untouched), never widens `asns` (which feeds the Attributor's
// asns.length>=3 auto-Haiku gate — component grouping is a SEPARATE
// label, deliberately kept out of attribution), and uses ZERO AI tokens.
//
// ── Edge model: SPECIFIC EVIDENCE ONLY ──────────────────────────────
// Two clusters are bridged into one component iff a threat is a member
// of one and shares the SPECIFIC key of the other, where the bridging
// cluster is a cert-serial, cert-SAN, or per-IP cluster. ASN, /24-subnet,
// and registrar clusters are mop-up lanes: they can RECEIVE a
// component_id when a specific edge pulls them in, but they NEVER act as
// a bridge. Gluing separate operators together through a shared /24 or
// "GoDaddy" is the over-merge trap this layer must avoid.
//
// ── Hard invariant: a receive-only cluster is a LEAF, never a connector ─
// The graph has exactly TWO roles:
//   * BRIDGE NODES — cert-serial / cert-SAN / per-IP clusters within the
//     hub fan-out threshold. Only these participate in union-find, and
//     only ever union with OTHER bridge nodes (two bridge clusters merge
//     iff one's specific key is present in the other's membership).
//   * LEAVES — every mop-up cluster (ASN / /24 / registrar / app-store /
//     dark-web / unknown) AND any hub-excluded bridge-kind cluster. A
//     leaf NEVER unions anything. It only RECEIVES a component_id, and
//     only when every bridge node that references it resolves to exactly
//     ONE component. If a leaf is referenced by bridge nodes in ≥2
//     distinct components (a /24 or hub shared across operators), it is
//     left NULL — it must never become the glue that transitively merges
//     two operators. This is the core correctness invariant; violating it
//     is the exact over-merge the layer forbids.
//
// ── Guards (all fail SAFE toward UNDER-merge) ────────────────────────
//   * Hub-exclusion: a specific cluster whose brand fan-out exceeds the
//     hub threshold (one IP hosting hundreds of brands = shared-infra
//     hub, not one operator) does NOT act as a bridge. It keeps its own
//     cluster but glues nothing.
//   * Size cap: if a component would exceed maxComponentSize distinct
//     clusters, we DON'T merge it — every member is left on its per-key
//     cluster (component_id NULL). Over-merge is worse than under-merge.
//
// ── Deterministic, stable component_id ───────────────────────────────
// component_id = `component_<min bridge-cluster id>` where the min is
// taken over the component's BRIDGE (specific) clusters only, tie-broken
// lexicographically. Two properties this buys us:
//   1. Stability under membership drift — the id churns only if the
//      lexicographically-minimal bridge cluster leaves the component, a
//      genuine topology change (the randomUUID-churn lesson: never mint
//      random ids).
//   2. agent↔workflow parity — bridge clusters (cert-serial/cert-SAN/
//      per-IP) carry byte-identical deterministic ids in BOTH the
//      agents/nexus.ts and workflows/nexusRun.ts lanes, whereas the
//      workflow's ASN lane still mints `crypto.randomUUID()` ids. Deriving
//      the label from bridge clusters ONLY means an ASN mop-up member with
//      a per-run-random id can never become the representative and split
//      component_id by dispatch source. This is a deliberate refinement of
//      the "min member cluster_id" wording — see the S2.4 report.

import type { D1Database } from '@cloudflare/workers-types';

// ─── Cluster taxonomy ─────────────────────────────────────────────────

export type ClusterKind =
  // SPECIFIC evidence — bridge-eligible
  | 'cert_serial'
  | 'cert_san'
  | 'per_ip'
  // mop-up / non-infra — receive a component_id but never bridge
  | 'subnet'
  | 'registrar'
  | 'asn'
  | 'app_store'
  | 'dark_web'
  | 'other';

/** The three specific kinds that may act as a bridge edge. */
export const BRIDGE_KINDS: ReadonlySet<ClusterKind> = new Set<ClusterKind>([
  'cert_serial',
  'cert_san',
  'per_ip',
]);

export function isBridgeKind(kind: ClusterKind): boolean {
  return BRIDGE_KINDS.has(kind);
}

// ─── Pure decision core (no I/O, no clock, unit-testable) ─────────────

export interface ComponentClusterInput {
  id: string;
  kind: ClusterKind;
  /** Brand fan-out = length of the cluster's brand_ids array. Drives
   *  hub-exclusion. */
  brandFanout: number;
}

/**
 * One candidate bridge discovered by the I/O layer: a specific cluster
 * plus the set of cluster ids that share a member threat with it (found
 * via that cluster's specific key — its cert serial, SAN hash, or IP).
 * `linkedClusterIds` may include `bridgeId` itself (its own members) —
 * harmless self-unions.
 */
export interface BridgeGroup {
  bridgeId: string;
  linkedClusterIds: string[];
}

export interface ComponentOptions {
  hubFanoutThreshold?: number;
  maxComponentSize?: number;
}

// Defaults — see the S2.4 report for the rationale behind each number.
//
// HUB_FANOUT_THRESHOLD aligns with the existing /24 lane's
// `brand_count <= 150` over-merge guard in nexus.ts: a shared key above
// that fan-out is treated as mass-impersonation hub infrastructure, not a
// single operator, so it must not glue distinct operators together.
export const DEFAULT_HUB_FANOUT_THRESHOLD = 150;
// MAX_COMPONENT_SIZE caps a component at 25 distinct per-key clusters.
// Real single-operator infra spans a handful of certs + IPs, not dozens;
// a runaway component is a signal that a hub slipped past the fan-out
// guard, so we fail safe and DON'T merge rather than emit a blob.
export const DEFAULT_MAX_COMPONENT_SIZE = 25;

export interface ComponentResult {
  /** clusterId → componentId, ONLY for clusters in a MERGED component
   *  (size >= 2 and within the size cap). Singletons and over-cap
   *  components are absent — their component_id is NULL. */
  componentByCluster: Map<string, string>;
  stats: {
    componentsFormed: number;
    clustersGrouped: number;
    bridgesApplied: number;
    bridgesSkippedHub: number;
    bridgesSkippedIneligible: number;
    componentsSkippedOverCap: number;
    /** Leaves referenced by bridge nodes in ≥2 distinct components and
     *  therefore left NULL rather than used as glue — the over-merge
     *  guard. */
    leavesSkippedMultiComponent: number;
  };
}

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    this.add(x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression.
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

/**
 * Union-find over cluster membership using SPECIFIC-evidence bridges only.
 * Pure and deterministic: same inputs → same `componentByCluster`
 * (Map iteration order is not relied on; ids are always re-derived by
 * lexicographic min over bridge clusters). Mirrors the
 * lib/alert-triage.ts / lib/cluster-attribution-inherit.ts decide-fn
 * pattern — no I/O, trivially unit-testable.
 *
 * Two-role graph (see the module header's hard invariant):
 *   - BRIDGE NODES (bridge kind AND fan-out within the hub threshold)
 *     are the ONLY union-find participants and union ONLY with each
 *     other. A mop-up or hub cluster is never a union node, so it can
 *     never transitively connect two operators.
 *   - LEAVES (mop-up clusters + hub-excluded bridge-kind clusters)
 *     attach to a component only when every bridge node that references
 *     them resolves to a single component; a leaf shared across ≥2
 *     components is left NULL.
 */
export function computeComponents(
  clusters: ComponentClusterInput[],
  bridges: BridgeGroup[],
  options: ComponentOptions = {},
): ComponentResult {
  const hubThreshold = options.hubFanoutThreshold ?? DEFAULT_HUB_FANOUT_THRESHOLD;
  const maxSize = options.maxComponentSize ?? DEFAULT_MAX_COMPONENT_SIZE;

  const stats = {
    componentsFormed: 0,
    clustersGrouped: 0,
    bridgesApplied: 0,
    bridgesSkippedHub: 0,
    bridgesSkippedIneligible: 0,
    componentsSkippedOverCap: 0,
    leavesSkippedMultiComponent: 0,
  };

  const byId = new Map<string, ComponentClusterInput>();
  for (const c of clusters) byId.set(c.id, c);

  // A cluster is a BRIDGE NODE (an internal union-find node) iff it is a
  // bridge kind AND within the hub fan-out threshold. Everything else —
  // mop-up kinds AND hub-excluded bridge-kind clusters — is a LEAF.
  const isBridgeNode = (id: string): boolean => {
    const info = byId.get(id);
    return info !== undefined && isBridgeKind(info.kind) && info.brandFanout <= hubThreshold;
  };

  // Union-find spans ONLY bridge nodes — a leaf id is never added, so it
  // can never sit on a union path between two bridges.
  const uf = new UnionFind();
  for (const c of clusters) if (isBridgeNode(c.id)) uf.add(c.id);

  // leafId → set of bridge-node ids that reference it (resolved to roots
  // after all unions settle).
  const leafLinkers = new Map<string, Set<string>>();

  // Apply bridges in deterministic (sorted) order so union-by-rank
  // tie-breaks are stable across runs.
  const orderedBridges = [...bridges].sort((a, b) => a.bridgeId.localeCompare(b.bridgeId));
  for (const bridge of orderedBridges) {
    const info = byId.get(bridge.bridgeId);
    // Enforce eligibility in the PURE fn (not just the I/O layer) so
    // hub-exclusion and mop-up-not-a-bridge are directly unit-testable.
    if (!info || !isBridgeKind(info.kind)) {
      stats.bridgesSkippedIneligible++;
      continue;
    }
    if (info.brandFanout > hubThreshold) {
      stats.bridgesSkippedHub++;
      continue;
    }
    let acted = false;
    for (const linked of bridge.linkedClusterIds) {
      if (linked === bridge.bridgeId) continue;
      if (!byId.has(linked)) continue; // unknown cluster id — ignore
      if (isBridgeNode(linked)) {
        // Bridge↔bridge: a real specific-evidence merge.
        uf.union(bridge.bridgeId, linked);
        acted = true;
      } else {
        // Leaf: record the linker; attach later iff single-component.
        const set = leafLinkers.get(linked) ?? new Set<string>();
        set.add(bridge.bridgeId);
        leafLinkers.set(linked, set);
        acted = true;
      }
    }
    if (acted) stats.bridgesApplied++;
  }

  // Group bridge nodes by their component root.
  const membersByRoot = new Map<string, string[]>();
  for (const c of clusters) {
    if (!isBridgeNode(c.id)) continue;
    const root = uf.find(c.id);
    const list = membersByRoot.get(root) ?? [];
    list.push(c.id);
    membersByRoot.set(root, list);
  }

  // Attach each leaf to a component ONLY if all its bridge-node linkers
  // resolve to exactly one component root. A leaf spanning ≥2 components
  // is the shared-infra glue we must NOT follow — leave it NULL.
  for (const [leafId, linkers] of leafLinkers) {
    const roots = new Set<string>();
    for (const linker of linkers) roots.add(uf.find(linker));
    if (roots.size !== 1) {
      stats.leavesSkippedMultiComponent++;
      continue;
    }
    const root = [...roots][0]!;
    membersByRoot.get(root)?.push(leafId);
  }

  const componentByCluster = new Map<string, string>();
  for (const members of membersByRoot.values()) {
    if (members.length < 2) continue; // lone bridge, no leaves → no component

    if (members.length > maxSize) {
      // Fail SAFE: an over-cap component is far more likely a hub that
      // slipped the fan-out guard than a real 25+-cluster operator.
      // Leave every member on its per-key cluster (component_id NULL).
      stats.componentsSkippedOverCap++;
      continue;
    }

    // Representative = lexicographically-min BRIDGE-NODE id. Every
    // component has ≥1 bridge node (leaves only attach to bridge-node
    // roots), so this is always well-defined and always a deterministic
    // natural-key id — never a leaf (which may be a workflow random-UUID
    // ASN row). The min-member fallback is defensive only.
    const bridgeMembers = members.filter((id) => isBridgeNode(id));
    const pool = bridgeMembers.length > 0 ? bridgeMembers : members;
    const rep = pool.reduce((min, id) => (id < min ? id : min), pool[0]!);
    const componentId = `component_${rep}`;

    for (const id of members) componentByCluster.set(id, componentId);
    stats.componentsFormed++;
    stats.clustersGrouped += members.length;
  }

  return { componentByCluster, stats };
}

// ─── I/O orchestration (thin wrapper — SQL + diff-writes) ─────────────

/** Fixed column whitelist for bridge-key lookups — never interpolated
 *  from data, so the threats query stays a bound prepared statement. */
const BRIDGE_KEY_COLUMN: Record<'cert_serial' | 'cert_san' | 'per_ip', string> = {
  cert_serial: 'ssl_cert_serial',
  cert_san: 'ssl_san_hash',
  per_ip: 'ip_address',
};

// Defensive ceiling on index-seek queries per invocation. The specific
// cluster population is naturally small (cert/SAN/per-IP lanes are
// LIMIT 50/50/30 per run), but bound it so accumulated rows can never
// blow the worker budget. Bridges are processed in sorted-id order so
// progress is deterministic if the ceiling is ever hit.
//
// LOW-note (tail-starvation): the cut is a STATIC lexicographic sort, so
// if the accumulated cert/IP bridge population ever exceeds this ceiling,
// the same high-sorting tail is skipped on EVERY run — those clusters
// stay permanently un-bridged (permanent under-merge). This is fail-safe
// (under-merge, never over-merge) and the ceiling is ~10x the natural
// per-run population, so it is a theoretical concern only. If it ever
// bites, replace the static sort with a rotating KV cursor over
// bridgeCandidates (same pattern as lib/dns-queue-reconciler.ts) so every
// bridge is eventually seeked across runs.
const MAX_BRIDGE_SEEKS = 500;

interface ClusterRow {
  id: string;
  brand_ids: string | null;
  agent_notes: string | null;
  component_id: string | null;
}

export interface GroupComponentsResult {
  clustersRead: number;
  bridgesSeeked: number;
  componentsFormed: number;
  clustersGrouped: number;
  componentIdsWritten: number;
  componentIdsCleared: number;
  bridgesSkippedHub: number;
  componentsSkippedOverCap: number;
  leavesSkippedMultiComponent: number;
}

/**
 * Read the current cluster rows, discover specific-evidence bridges via
 * index-backed equality seeks on the threats table, run the pure
 * union-find, and diff-write `component_id` onto `infrastructure_clusters`.
 *
 * Idempotent — a rerun over unchanged data writes 0 rows. Bounded by the
 * cluster-row count (hundreds) plus <=MAX_BRIDGE_SEEKS index seeks; it
 * never scans or writes the threats table (reads only, via the
 * ssl_cert_serial / ssl_san_hash / ip_address indexes).
 */
export async function groupClusterComponents(
  db: D1Database,
  options: ComponentOptions = {},
): Promise<GroupComponentsResult> {
  const hubThreshold = options.hubFanoutThreshold ?? DEFAULT_HUB_FANOUT_THRESHOLD;

  // 1. Read all cluster rows (bounded by cluster-row count).
  const rows = (await db.prepare(
    `SELECT id, brand_ids, agent_notes, component_id
       FROM infrastructure_clusters`,
  ).all<ClusterRow>()).results ?? [];

  const clusters: ComponentClusterInput[] = [];
  const currentComponent = new Map<string, string | null>();
  // Specific clusters we can bridge from: id → { kind, column, keyValue }.
  const bridgeCandidates: Array<{
    id: string;
    kind: 'cert_serial' | 'cert_san' | 'per_ip';
    column: string;
    keyValue: string;
    fanout: number;
  }> = [];

  for (const row of rows) {
    const fanout = safeArrayLength(row.brand_ids);
    const kind = classifyClusterKind(row.id, row.agent_notes);
    clusters.push({ id: row.id, kind, brandFanout: fanout });
    currentComponent.set(row.id, row.component_id ?? null);

    if (kind === 'cert_serial' || kind === 'cert_san' || kind === 'per_ip') {
      // Hub-exclusion at the source: skip the seek for hub bridges (the
      // pure fn also enforces this, belt-and-braces).
      if (fanout > hubThreshold) continue;
      const keyValue = extractBridgeKey(kind, row.id, row.agent_notes);
      if (keyValue) {
        bridgeCandidates.push({
          id: row.id,
          kind,
          column: BRIDGE_KEY_COLUMN[kind],
          keyValue,
          fanout,
        });
      }
    }
  }

  // 2. Discover bridges via index-backed equality seeks (deterministic
  //    order; ceiling-bounded).
  bridgeCandidates.sort((a, b) => a.id.localeCompare(b.id));
  const bridges: BridgeGroup[] = [];
  let bridgesSeeked = 0;
  for (const cand of bridgeCandidates) {
    if (bridgesSeeked >= MAX_BRIDGE_SEEKS) break;
    bridgesSeeked++;
    const linked = (await db.prepare(
      `SELECT DISTINCT cluster_id
         FROM threats
        WHERE ${cand.column} = ?
          AND cluster_id IS NOT NULL
          AND cluster_id != ''`,
    ).bind(cand.keyValue).all<{ cluster_id: string }>()).results ?? [];
    const linkedIds = linked.map((r) => r.cluster_id).filter(Boolean);
    if (linkedIds.length > 0) {
      bridges.push({ bridgeId: cand.id, linkedClusterIds: linkedIds });
    }
  }

  // 3. Pure union-find.
  const { componentByCluster, stats } = computeComponents(clusters, bridges, options);

  // 4. Diff-write: set new labels, clear stale ones (drift). Bounded by
  //    the cluster-row count; only rows whose component_id actually
  //    changes are written, so a steady-state rerun writes nothing.
  let written = 0;
  let cleared = 0;
  for (const row of rows) {
    const desired = componentByCluster.get(row.id) ?? null;
    const current = currentComponent.get(row.id) ?? null;
    if (desired === current) continue;
    await db.prepare(
      `UPDATE infrastructure_clusters SET component_id = ? WHERE id = ?`,
    ).bind(desired, row.id).run();
    if (desired === null) cleared++;
    else written++;
  }

  return {
    clustersRead: rows.length,
    bridgesSeeked,
    componentsFormed: stats.componentsFormed,
    clustersGrouped: stats.clustersGrouped,
    componentIdsWritten: written,
    componentIdsCleared: cleared,
    bridgesSkippedHub: stats.bridgesSkippedHub,
    componentsSkippedOverCap: stats.componentsSkippedOverCap,
    leavesSkippedMultiComponent: stats.leavesSkippedMultiComponent,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────

/** Classify a cluster by its natural-key id prefix; cert clusters
 *  (shared `cluster_cert_` prefix) are disambiguated serial-vs-SAN by the
 *  agent_notes cluster_type. Unknown / workflow-random-UUID ids → 'other'
 *  (receive-only, never a bridge). */
export function classifyClusterKind(id: string, agentNotes: string | null): ClusterKind {
  if (id.startsWith('cluster_cert_')) {
    const t = parseClusterType(agentNotes);
    if (t === 'ssl_san_hash') return 'cert_san';
    // ssl_cert_serial or unknown-but-cert-prefixed → treat as serial.
    return 'cert_serial';
  }
  if (id.startsWith('cluster_ip_')) return 'per_ip';
  if (id.startsWith('cluster_subnet_')) return 'subnet';
  if (id.startsWith('cluster_registrar_')) return 'registrar';
  if (id.startsWith('cluster_asn_')) return 'asn';
  if (id.startsWith('cluster_dev_')) return 'app_store';
  if (id.startsWith('cluster_actor_')) return 'dark_web';
  return 'other';
}

/** Resolve the bridge key value for a specific cluster. cert clusters
 *  store the key in agent_notes JSON; per-IP clusters carry a plain-string
 *  agent_notes, so the IP is parsed from the deterministic id. */
export function extractBridgeKey(
  kind: 'cert_serial' | 'cert_san' | 'per_ip',
  id: string,
  agentNotes: string | null,
): string | null {
  if (kind === 'per_ip') {
    // LOW-note: the per-IP cluster id is built as `cluster_ip_<ip>` where
    // <ip> is char-stripped at write time (nexus.ts: replace non
    // [0-9a-f.:]). For any ip_address containing stripped chars — an IPv6
    // zone id ("fe80::1%eth0") or stray whitespace — this reconstructed
    // key won't equality-match the raw threats.ip_address, so that per-IP
    // cluster simply doesn't bridge. Under-merge / fail-safe; well-formed
    // v4 and plain v6 addresses are unaffected (identity transform).
    const ip = id.slice('cluster_ip_'.length);
    return ip.length > 0 ? ip : null;
  }
  const notes = parseNotesObject(agentNotes);
  if (!notes) return null;
  const field = kind === 'cert_serial' ? 'ssl_cert_serial' : 'ssl_san_hash';
  const v = notes[field];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseClusterType(agentNotes: string | null): string | null {
  const obj = parseNotesObject(agentNotes);
  const t = obj?.cluster_type;
  return typeof t === 'string' ? t : null;
}

function parseNotesObject(agentNotes: string | null): Record<string, unknown> | null {
  if (!agentNotes) return null;
  const trimmed = agentNotes.trim();
  if (!trimmed.startsWith('{')) return null; // per-IP writes a plain string
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
