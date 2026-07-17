/**
 * Attributor Agent — NEXUS cluster → threat actor classification.
 *
 * Phase C of the Threat Actors rebuild. Reads infrastructure_clusters
 * that NEXUS produced (or refreshed) but that the attributor hasn't
 * processed yet, summarizes each one's distinguishing signals (ASNs,
 * countries, threat types, top targeted brands, agent_notes), and asks
 * Haiku "is this a known APT/cybercrime group? if yes, name it."
 *
 * For clusters Haiku resolves to a known actor:
 *   1. Upsert the actor in `threat_actors` (canonical name + source='nexus')
 *   2. Persist `infrastructure_clusters.actor_id` so subsequent runs skip
 *      the cluster (no repeat AI cost).
 *   3. Write a `threat_attributions` row (source='nexus') for every
 *      threat in the cluster — same pattern as OTX, so the
 *      threat-actor list/detail handlers surface NEXUS-derived activity
 *      alongside OTX without code branching.
 *
 * For clusters Haiku declines to attribute ("unknown"):
 *   * Record `attribution_attempted_at = now()` so we don't re-pay the
 *     classification cost for at least 7 days.
 *
 * Schedule (per CLAUDE.md):
 *   * Triggered by orchestrator at hour % 4 === 1 (one hour after
 *     NEXUS, which runs at hour % 4 === 0). Runs to completion via
 *     `ctx.waitUntil` since it's bounded — at most CLUSTER_BATCH
 *     active clusters per run.
 *
 * Cost guard: enforced. Uses ~1 Haiku call per cluster (≤ CLUSTER_BATCH
 * per run). Capped via the standard checkCostGuard pre-flight.
 */

import type { AgentModule, AgentResult, AgentContext } from "../lib/agentRunner";
import { callHaikuRaw, checkCostGuard } from "../lib/haiku";
import {
  upsertActorByName,
  recordAttribution,
  canonicalActorName,
} from "../lib/otx-attribution";
import { inheritOtxActorsToClusters } from "../lib/cluster-attribution-inherit";

const CLUSTER_BATCH = 25;
const RETRY_COOLDOWN_DAYS = 7;

interface ClusterRow {
  id: string;
  cluster_name: string | null;
  asns: string | null;            // JSON array
  countries: string | null;        // JSON array
  attack_types: string | null;     // JSON array
  brand_ids: string | null;        // JSON array
  threat_count: number;
  confidence_score: number | null;
  agent_notes: string | null;
  nexus_brief: string | null;
  first_detected: string | null;
  last_seen: string | null;
}

/**
 * PR-D (2026-05-16 audit fix): cheap pre-filter before paying for
 * Haiku. The audit found 1,325 of 1,330 clusters Haiku saw came back
 * "unknown" (0.4% resolution) — most clusters carry generic ASN/
 * country profiles that match many actors. Pre-filtering to clusters
 * whose notes/brief contain a known actor name (or whose
 * infrastructure footprint is rare/distinctive) cuts AI cost ~80%
 * while improving resolution rate.
 *
 * Returns true when the cluster is worth sending to Haiku.
 */
function clusterShouldHitHaiku(
  cluster: ClusterRow,
  knownActorNeedles: string[],
): boolean {
  // Rule 1 — name presence: any known actor name or alias appears
  // in the free-text fields. NEXUS occasionally drops actor handles
  // (e.g. "APT28", "Lazarus") into agent_notes / nexus_brief from
  // upstream OTX pulses or seed attribution.
  const haystack = [
    cluster.cluster_name,
    cluster.agent_notes,
    cluster.nexus_brief,
  ].filter(Boolean).join(" ").toLowerCase();
  for (const needle of knownActorNeedles) {
    if (haystack.includes(needle)) return true;
  }

  // Rule 2 — rare/distinctive footprint: clusters spanning many
  // ASNs or countries are operator-curated worth investigating
  // even without a name hint. Tunable thresholds.
  const asns = safeParseArray(cluster.asns);
  const countries = safeParseArray(cluster.countries);
  if (asns.length >= 3) return true;
  if (countries.length >= 4) return true;

  return false;
}

/**
 * Lowercased actor names + aliases, filtered to substrings that won't
 * false-match common English words. Short or generic tokens (≤3 chars,
 * or in STOPWORDS) are dropped so a name like "Sand" doesn't match
 * every cluster talking about a "sandbox".
 */
const STOPWORDS = new Set([
  "the", "and", "team", "group", "actor", "dragon", "spider", "panda", "bear",
  "kitten", "rat", "snake", "lion", "tiger", "wolf", "fox", "eagle", "hawk",
]);

function buildActorNeedles(rows: Array<{ name: string; aliases: string | null }>): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    const tokens: string[] = [];
    if (row.name) tokens.push(row.name);
    if (row.aliases) {
      try {
        const v = JSON.parse(row.aliases);
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

const SYSTEM_PROMPT = `You are a threat-intelligence analyst classifying infrastructure clusters by responsible actor.

Given a cluster summary (ASNs, countries, attack types, target brands, status notes), respond with ONE of:
  * The canonical name of a well-known threat actor / APT / cybercrime group (e.g. "APT28", "Lazarus Group", "FIN7", "MuddyWater")
  * The single token "unknown" if the signals are too generic or conflicting to attribute

Reply with ONLY the name or "unknown" — no prose, no explanation, no punctuation. Maximum 32 characters.`;

function buildUserPrompt(c: ClusterRow): string {
  const asns = safeParseArray(c.asns);
  const countries = safeParseArray(c.countries);
  const attackTypes = safeParseArray(c.attack_types);
  const brandIds = safeParseArray(c.brand_ids);

  return [
    `Cluster: ${c.cluster_name ?? c.id}`,
    `Threat count: ${c.threat_count}`,
    asns.length     ? `ASNs: ${asns.slice(0, 8).join(", ")}` : "",
    countries.length ? `Countries: ${countries.slice(0, 8).join(", ")}` : "",
    attackTypes.length ? `Attack types: ${attackTypes.join(", ")}` : "",
    brandIds.length ? `Targeted brands: ${brandIds.slice(0, 8).join(", ")}` : "",
    c.agent_notes  ? `Notes: ${c.agent_notes.slice(0, 200)}` : "",
  ].filter(Boolean).join("\n");
}

function safeParseArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export const attributorAgent: AgentModule = {
  name: "attributor",
  displayName: "ATTRIBUTOR",
  description: "Classifies NEXUS infrastructure clusters by responsible threat actor (Haiku)",
  color: "#9333ea",
  trigger: "scheduled",
  requiresApproval: false,
  // Bumped 20→60 on 2026-05-12. Attributor pulls unattributed
  // infrastructure_clusters, runs Haiku classification per cluster,
  // writes threat_attributions + caches actor_id on the cluster.
  // Cold runs across many clusters with Haiku rate limits cross 50
  // min — 20-min threshold (50-min ceiling with buffer) was tripping
  // legitimate work. 60 declared → 90-min ceiling.
  stallThresholdMinutes: 60,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 50_000_000 },
  // AGENT_STANDARD §10: declarations reflect the SQL extractable from
  // THIS file. The actor + attribution writes happen via helpers in
  // lib/otx-attribution.ts and are tracked by that file's own
  // declaration scope, not duplicated here.
  reads: [
    { kind: "d1_table", name: "infrastructure_clusters" },
    { kind: "d1_table", name: "threats" },
    // PR-D (2026-05-16 audit): pre-Haiku name-presence gate reads
    // the known-actors catalog once per run to build a substring
    // needle list. Skips Haiku for clusters whose notes/brief
    // don't mention any known name — was 99.6% wasted AI cost.
    { kind: "d1_table", name: "threat_actors" },
  ],
  writes: [
    { kind: "d1_table", name: "infrastructure_clusters" },
  ],
  outputs: [{ type: "classification" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 11,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;
    const callCtx = { agentId: "attributor", runId };

    const guard = await checkCostGuard(env, false);
    if (guard) {
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { skipped: true, reason: `cost guard: ${guard}` },
      };
    }

    // Pull pending clusters: status='active', actor_id IS NULL, and either
    // never attempted OR last attempt was more than RETRY_COOLDOWN_DAYS ago.
    const cooldownExpr = `datetime('now', '-${RETRY_COOLDOWN_DAYS} days')`;
    const pending = await env.DB.prepare(`
      SELECT id, cluster_name, asns, countries, attack_types, brand_ids,
             threat_count, confidence_score, agent_notes, nexus_brief,
             first_detected, last_seen
      FROM infrastructure_clusters
      WHERE status = 'active'
        AND actor_id IS NULL
        AND (attribution_attempted_at IS NULL OR attribution_attempted_at < ${cooldownExpr})
      ORDER BY threat_count DESC, last_seen DESC
      LIMIT ?
    `).bind(CLUSTER_BATCH).all<ClusterRow>();

    const clusters = pending.results ?? [];
    if (clusters.length === 0) {
      // No clusters need Haiku classification, but the OTX -> cluster
      // inheritance post-pass is pure SQL and independent of the Haiku
      // queue, so it still runs to propagate named actors onto
      // un-attributed cluster siblings.
      const inherited = await inheritOtxActorsToClusters(env.DB);
      return {
        itemsProcessed: inherited.members_attributed,
        itemsCreated: inherited.members_attributed,
        itemsUpdated: inherited.clusters_actor_set,
        output: { pending_clusters: 0, otx_inheritance: inherited },
      };
    }

    // PR-D (2026-05-16 audit fix): cheap pre-filter — load the
    // active threat_actors catalog once and build a substring needle
    // list. Each cluster is checked against the catalog before we
    // pay for Haiku. Audit baseline: 99.6% "unknown" responses; the
    // gate keeps the 0.4% signal path while skipping the wasted
    // AI calls. Skipped clusters still get attribution_attempted_at
    // stamped so they cool down for RETRY_COOLDOWN_DAYS and don't
    // re-enter the queue immediately.
    const actorRows = await env.DB.prepare(
      `SELECT name, aliases FROM threat_actors WHERE status = 'active'`
    ).all<{ name: string; aliases: string | null }>();
    const actorNeedles = buildActorNeedles(actorRows.results ?? []);

    let attributed = 0;
    let unresolved = 0;
    let errors = 0;
    let attributionRowsWritten = 0;
    let gated = 0;

    for (const cluster of clusters) {
      try {
        // Cheap pre-filter — skip Haiku for clusters without a name
        // match or distinctive footprint. Still stamps the attempt
        // timestamp so the cluster cools down — operator can find it
        // in the Attribution Backlog admin queue (PR-B) if they want
        // to manually attribute.
        if (!clusterShouldHitHaiku(cluster, actorNeedles)) {
          await env.DB.prepare(
            `UPDATE infrastructure_clusters
                SET attribution_attempted_at = datetime('now')
              WHERE id = ?`
          ).bind(cluster.id).run();
          gated++;
          continue;
        }

        const userMessage = buildUserPrompt(cluster);
        const haikuResult = await callHaikuRaw(env, callCtx, SYSTEM_PROMPT, userMessage, 24);

        // Always stamp the attempt timestamp so we cool down even on
        // explicit "unknown" classifications. Cluster gets re-attempted
        // after RETRY_COOLDOWN_DAYS — by then NEXUS may have refreshed
        // the cluster with new threat data that lets Haiku resolve it.
        await env.DB.prepare(
          `UPDATE infrastructure_clusters
              SET attribution_attempted_at = datetime('now')
            WHERE id = ?`
        ).bind(cluster.id).run();

        if (!haikuResult.success || !haikuResult.text) {
          errors++;
          continue;
        }

        const raw = haikuResult.text.trim().replace(/[.,;!?"']+$/g, "");
        if (!raw || raw.toLowerCase() === "unknown" || raw.length > 64) {
          unresolved++;
          continue;
        }

        // Resolve to canonical name when possible; otherwise persist the
        // raw Haiku output so first-seen names don't get dropped.
        const resolvedName = canonicalActorName(raw) ?? raw;

        // Pick the cluster's most-frequent country for the actor's
        // country_code — ASN/country lists are JSON arrays already
        // sorted by frequency from NEXUS.
        const countries = safeParseArray(cluster.countries);
        const country = countries[0] ?? null;

        const actorId = await upsertActorByName(env.DB, resolvedName, "nexus", country);
        if (!actorId) {
          unresolved++;
          continue;
        }

        await env.DB.prepare(
          `UPDATE infrastructure_clusters SET actor_id = ? WHERE id = ?`
        ).bind(actorId, cluster.id).run();

        // Fan out the attribution to every threat in the cluster.
        // Bounded — clusters carry ≤ a few thousand threats; each
        // batched insert is cheap.
        const threats = await env.DB.prepare(
          `SELECT id FROM threats WHERE cluster_id = ?`
        ).bind(cluster.id).all<{ id: string }>();

        for (const t of threats.results ?? []) {
          await recordAttribution(env.DB, {
            id: `tat_nexus_${cluster.id}_${t.id}`,
            threatId: t.id,
            actorId,
            source: "nexus",
            sourcePulseId: cluster.id,
            sourcePulseName: cluster.cluster_name ?? null,
            actorNameRaw: raw,
            confidence: "medium",
            metadata: {
              cluster_id: cluster.id,
              asns: safeParseArray(cluster.asns),
              countries,
              attack_types: safeParseArray(cluster.attack_types),
            },
          });
          attributionRowsWritten++;
        }

        attributed++;
      } catch (err) {
        console.error(`[attributor] cluster ${cluster.id} failed:`, err);
        errors++;
      }
    }

    // Post-pass: propagate OTX-named actors from attributed cluster
    // members onto their un-attributed siblings (pure SQL, no AI). Runs
    // after the Haiku work so this run's fresh cluster actor stamps are
    // already in place; the pass is idempotent, so re-runs write 0 rows.
    const inherited = await inheritOtxActorsToClusters(env.DB);

    return {
      itemsProcessed: clusters.length,
      itemsCreated: attributionRowsWritten + inherited.members_attributed,
      itemsUpdated: attributed + inherited.clusters_actor_set,
      output: {
        attributed_clusters: attributed,
        unresolved_clusters: unresolved,
        gated_clusters: gated,
        errors,
        attribution_rows_written: attributionRowsWritten,
        actor_needles: actorNeedles.length,
        otx_inheritance: inherited,
      },
    };
  },
};
