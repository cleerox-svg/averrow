/**
 * Attributor Agent — NEXUS cluster attribution bookkeeping + OTX inheritance.
 *
 * AI Strategy Phase 1 (#6, docs/AI_STRATEGY_2026-10.md): the former
 * Haiku "name the APT behind this cluster" call was REMOVED. It resolved
 * 0.4% of clusters (1,325 of 1,330 "unknown") and, worse, every non-
 * "unknown" answer minted a `threat_actors` row from a model guess over
 * generic ASN/country signals. Actor NAMING now comes exclusively from
 * specific evidence:
 *
 *   * OTX pulse attribution (lib/otx-attribution.ts, written by the OTX
 *     feed), propagated to cluster siblings by
 *     `inheritOtxActorsToClusters` (lib/cluster-attribution-inherit.ts,
 *     pure SQL, conservative — one distinct OTX actor or nothing).
 *   * A human, via the Attribution Backlog (handlers/admin/attribution.ts).
 *
 * Per run the agent:
 *   1. Pulls up to CLUSTER_BATCH pending clusters (status='active',
 *      actor_id IS NULL, outside the RETRY_COOLDOWN_DAYS window) and
 *      stamps `attribution_attempted_at` so the backlog's
 *      attempted/never-attempted split stays meaningful.
 *   2. Runs the OTX → cluster inheritance post-pass.
 *
 * It never sets `actor_id` from free text and never calls
 * `recordAttribution` itself.
 *
 * Schedule (per CLAUDE.md): orchestrator at hour % 4 === 1, one hour
 * after NEXUS (hour % 4 === 0).
 */

import type { AgentModule, AgentResult, AgentContext } from "../lib/agentRunner";
import { inheritOtxActorsToClusters } from "../lib/cluster-attribution-inherit";

const CLUSTER_BATCH = 25;
const RETRY_COOLDOWN_DAYS = 7;

/** Free-text fields `clusterHasActorHint` scans. */
export interface ClusterHintFields {
  cluster_name: string | null;
  agent_notes: string | null;
  nexus_brief: string | null;
}

/**
 * RANKING HINT ONLY — never an attribution.
 *
 * True when a known actor name/alias appears in the cluster's free-text
 * fields. Those fields carry ATTACKER-CONTROLLED text: NEXUS embeds
 * upstream strings verbatim (e.g. an app-store `developer_name` lands in
 * `cluster_name` / `agent_notes`, see agents/nexus.ts), so whoever runs a
 * kit could plant "Lazarus" in a developer name and steer naming. This
 * helper may therefore only be used to ORDER clusters in the Attribution
 * Backlog (handlers/admin/attribution.ts) for human review. It must never
 * set `infrastructure_clusters.actor_id` or call `recordAttribution`.
 */
export function clusterHasActorHint(
  cluster: ClusterHintFields,
  knownActorNeedles: string[],
): boolean {
  const haystack = [
    cluster.cluster_name,
    cluster.agent_notes,
    cluster.nexus_brief,
  ].filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return false;
  for (const needle of knownActorNeedles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}

/**
 * Lowercased actor names + aliases, filtered to substrings that won't
 * false-match common English words. Short or generic tokens (<4 chars,
 * or in STOPWORDS) are dropped so a name like "Sand" doesn't match
 * every cluster talking about a "sandbox".
 */
const STOPWORDS = new Set([
  "the", "and", "team", "group", "actor", "dragon", "spider", "panda", "bear",
  "kitten", "rat", "snake", "lion", "tiger", "wolf", "fox", "eagle", "hawk",
]);

export function buildActorNeedles(rows: Array<{ name: string; aliases: string | null }>): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const tokens: string[] = [];
    if (row.name) tokens.push(row.name);
    if (row.aliases) {
      try {
        const v: unknown = JSON.parse(row.aliases);
        if (Array.isArray(v)) for (const a of v) if (typeof a === "string") tokens.push(a);
      } catch {
        // Plain comma-separated string
        for (const a of row.aliases.split(",")) tokens.push(a);
      }
    }
    for (const raw of tokens) {
      const n = raw.trim().toLowerCase();
      if (n.length < 4) continue;
      if (STOPWORDS.has(n)) continue;
      out.add(n);
    }
  }
  return [...out];
}

export const attributorAgent: AgentModule = {
  name: "attributor",
  displayName: "ATTRIBUTOR",
  description: "Cluster attribution bookkeeping + OTX actor inheritance onto NEXUS clusters (rules, no AI)",
  color: "#9333ea",
  trigger: "scheduled",
  requiresApproval: false,
  // 60 declared → 90-min ceiling. Kept from the Haiku era; the rules-only
  // run is a bounded stamp batch + one SQL inheritance pass.
  stallThresholdMinutes: 60,
  parallelMax: 1,
  // No AI calls since AI Strategy Phase 1 — pure SQL. Cap=0 surfaces regressions.
  costGuard: "exempt",
  budget: { monthlyTokenCap: 0 },
  // AGENT_STANDARD §10: declarations reflect the SQL extractable from
  // THIS file. The OTX inheritance reads/writes (threats,
  // threat_attributions, threat_actors) live in
  // lib/cluster-attribution-inherit.ts and are tracked by that file's
  // own declaration scope, not duplicated here.
  reads: [
    { kind: "d1_table", name: "infrastructure_clusters" },
  ],
  writes: [
    { kind: "d1_table", name: "infrastructure_clusters" },
  ],
  outputs: [{ type: "classification" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 11,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;

    // Pull pending clusters: status='active', actor_id IS NULL, and either
    // never attempted OR last attempt was more than RETRY_COOLDOWN_DAYS ago.
    const pending = await env.DB.prepare(`
      SELECT id
      FROM infrastructure_clusters
      WHERE status = 'active'
        AND actor_id IS NULL
        AND (attribution_attempted_at IS NULL OR attribution_attempted_at < datetime('now', ?))
      ORDER BY threat_count DESC, last_seen DESC
      LIMIT ?
    `).bind(`-${RETRY_COOLDOWN_DAYS} days`, CLUSTER_BATCH).all<{ id: string }>();

    const clusters = pending.results ?? [];

    // Stamp the attempt so the cluster cools down and the Attribution
    // Backlog's attempted/never-attempted split stays meaningful. No
    // naming happens here — see the header.
    if (clusters.length > 0) {
      const stamp = env.DB.prepare(
        `UPDATE infrastructure_clusters
            SET attribution_attempted_at = datetime('now')
          WHERE id = ?`,
      );
      await env.DB.batch(clusters.map((c) => stamp.bind(c.id)));
    }

    // OTX → cluster inheritance (pure SQL, no AI). The only automated
    // path that names an actor onto a cluster.
    const inherited = await inheritOtxActorsToClusters(env.DB);

    return {
      itemsProcessed: clusters.length,
      itemsCreated: inherited.members_attributed,
      itemsUpdated: inherited.clusters_actor_set,
      output: {
        pending_clusters: clusters.length,
        attempted_stamped: clusters.length,
        otx_inheritance: inherited,
      },
    };
  },
};
