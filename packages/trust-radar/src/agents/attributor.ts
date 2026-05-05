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
  first_detected: string | null;
  last_seen: string | null;
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
  stallThresholdMinutes: 20,
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
             threat_count, confidence_score, agent_notes, first_detected, last_seen
      FROM infrastructure_clusters
      WHERE status = 'active'
        AND actor_id IS NULL
        AND (attribution_attempted_at IS NULL OR attribution_attempted_at < ${cooldownExpr})
      ORDER BY threat_count DESC, last_seen DESC
      LIMIT ?
    `).bind(CLUSTER_BATCH).all<ClusterRow>();

    const clusters = pending.results ?? [];
    if (clusters.length === 0) {
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { pending_clusters: 0 },
      };
    }

    let attributed = 0;
    let unresolved = 0;
    let errors = 0;
    let attributionRowsWritten = 0;

    for (const cluster of clusters) {
      try {
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

    return {
      itemsProcessed: clusters.length,
      itemsCreated: attributionRowsWritten,
      itemsUpdated: attributed,
      output: {
        attributed_clusters: attributed,
        unresolved_clusters: unresolved,
        errors,
        attribution_rows_written: attributionRowsWritten,
      },
    };
  },
};
