/**
 * NEXUS Agent — Infrastructure Correlation Engine (v1, SQL-only).
 *
 * Runs every 4 hours (Flight Control will trigger more often later).
 * Finds patterns humans can't see — clustering threats by ASN, subnet,
 * registrar, temporal window, and cross-brand targeting.
 *
 * SQL does correlation. AI does narrative. Never pay AI to do what GROUP BY can do.
 *
 * Lane run-order precedence (MOST-SPECIFIC FIRST — first lane to claim a
 * threat wins, because every stamping write carries a `cluster_id IS NULL`
 * guard):
 *   cert-serial → cert-SAN → per-IP fan-out → /24 subnet →
 *   registrar cohort → ASN (mops up leftovers).
 * The cert lanes are the most specific (shared certificate identity is
 * near-conclusive same-operator evidence) so they run FIRST; the ASN pass
 * executes LAST even though it is the oldest lane. Do not reorder.
 * The threats-table lanes themselves live in lib/nexus-threat-lanes.ts,
 * shared with workflows/nexusRun.ts (the live 4-hourly path).
 *
 * Outputs:
 * - infrastructure_clusters table rows
 * - hosting_providers trend_7d/30d/active counts updated
 * - pivot alerts emitted to agent_events for Observer
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import type { Env } from "../types";
import {
  emitIntelNotification,
  renderIntelPredictive,
} from "../lib/intel-templates";
import { updateProviderTrends } from "../lib/provider-trends";
import { groupClusterComponents } from "../lib/cluster-components";
import { detectClusterInfraMovement } from "../lib/cluster-infra-movement";
import { slugifyKey } from "../lib/cluster-naming";
// The six threats-table lanes + the retire pass are shared with
// workflows/nexusRun.ts — one implementation, so ids, names, confidence and
// stamp predicates can never diverge by dispatch source.
import {
  runCertSerialLane,
  runCertSanLane,
  runPerIpLane,
  runSubnetLane,
  runRegistrarLane,
  runAsnLane,
  retireNonOperationalLaneClusters,
  ASN_PREDICTIVE_MIN_CONFIDENCE,
  type LaneResult,
  type RetireResult,
} from "../lib/nexus-threat-lanes";

// ─── NEXUS core correlation logic ─────────────────────────────────

export async function runNexus(db: D1Database, env: Env): Promise<{
  clustersWritten: number;
  providersUpdated: number;
  providersZeroed: number;
  pivotsDetected: number;
  outputs: AgentOutputEntry[];
}> {
  const outputs: AgentOutputEntry[] = [];
  let clustersWritten = 0;
  let pivotsDetected = 0; // DORMANCY pivots only (F2 parity — movement is separate)
  let infraMovementPivots = 0; // S2.4/D5b infra-movement pivots (reported separately)

  // --- Correlation 2: Update hosting_providers trend data ---
  //
  // Mirrors workflows/nexusRun.ts:130-181 — reads pre-aggregated counts
  // from threat_cube_provider (bounded by cube row count, not by the
  // threats table). The previous version had four correlated subqueries
  // scanning the threats table per provider, which scaled linearly with
  // the threats row count and tipped over once threats reached ~275K:
  //
  //   2026-05-01 success @ 212s avg → 2026-05-12 success @ 667s
  //   → 2026-05-13 every cron run reaped at the 390min ceiling
  //
  // active_threat_count + total_threat_count are intentionally NOT
  // updated here. Those pre-computed columns are maintained by
  // cartographer Phase 5 (handlers/admin.ts:1309); duplicating the
  // work here was the original bug the cube migration in PR-B (#1278)
  // fixed for the workflow path. Same reasoning here.
  //
  // Delegates to lib/provider-trends.ts so the manual-fallback
  // path here and the canonical workflow at workflows/nexusRun.ts
  // share the same diff-filtered write helper. The helper drops
  // no-op writes (where new trend values match current); the
  // 2026-05-20 D1 write audit flagged the prior inline rewrite-
  // every-row path as the dominant inline write driver on the
  // platform.
  let providersUpdated = 0;
  let providersZeroed = 0;
  try {
    const result = await updateProviderTrends(db);
    providersUpdated = result.providers_updated;
    providersZeroed = result.providers_zeroed;
  } catch (err) {
    console.error('[nexus] provider trend update error:', err);
  }

  // --- Correlation 3: App-store developer clusters ---
  // Same developer_id (or developer_name when dev_id is null) pushing
  // impersonations against multiple brands = campaign. Skip silently if
  // the table is absent in this deployment.
  let appStoreClustersWritten = 0;
  try {
    const devClusters = await db.prepare(`
      SELECT
        store,
        COALESCE(developer_id, LOWER(TRIM(developer_name))) AS dev_key,
        MAX(developer_name) AS developer_name,
        MAX(developer_id) AS developer_id,
        COUNT(DISTINCT brand_id) AS brands,
        COUNT(*) AS rows_,
        GROUP_CONCAT(DISTINCT brand_id) AS brand_ids,
        MIN(first_seen) AS first_seen,
        MAX(COALESCE(last_checked, first_seen)) AS last_seen
      FROM app_store_listings
      WHERE status = 'active'
        AND classification IN ('impersonation', 'suspicious')
        AND COALESCE(developer_id, developer_name) IS NOT NULL
      GROUP BY store, dev_key
      HAVING brands >= 2 AND rows_ >= 2
      ORDER BY brands DESC, rows_ DESC
      LIMIT 50
    `).all<{
      store: string;
      dev_key: string;
      developer_name: string | null;
      developer_id: string | null;
      brands: number;
      rows_: number;
      brand_ids: string | null;
      first_seen: string | null;
      last_seen: string | null;
    }>();

    for (const cluster of devClusters.results) {
      // Deterministic id keyed on (store, dev_key) so re-runs update
      // the same row. See audit C3 + the asn cluster site above.
      const clusterId = `cluster_dev_${slugifyKey(cluster.store)}_${slugifyKey(cluster.dev_key)}`;
      const devLabel = cluster.developer_name ?? cluster.dev_key;
      const clusterName = `${cluster.store} dev "${devLabel}" (${cluster.brands} brands targeted)`;

      // Confidence scales with brands + row count — brand diversity matters most.
      const confidence = Math.min(100,
        (cluster.brands * 15) +
        (cluster.rows_ > 10 ? 20 : cluster.rows_ > 5 ? 10 : 5)
      );

      try {
        await db.prepare(`
          INSERT INTO infrastructure_clusters (
            id, cluster_name, asns, countries, attack_types, brand_ids,
            campaign_ids, hosting_provider_ids, threat_count, confidence_score,
            first_detected, last_seen, status, agent_notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
          ON CONFLICT(id) DO UPDATE SET
            cluster_name = excluded.cluster_name,
            brand_ids = excluded.brand_ids,
            threat_count = excluded.threat_count,
            confidence_score = excluded.confidence_score,
            last_seen = excluded.last_seen,
            agent_notes = excluded.agent_notes
        `).bind(
          clusterId,
          clusterName,
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify(['app_store_impersonation']),
          JSON.stringify((cluster.brand_ids ?? '').split(',').filter(Boolean)),
          JSON.stringify([]),
          JSON.stringify([]),
          cluster.rows_,
          confidence,
          cluster.first_seen,
          cluster.last_seen,
          JSON.stringify({
            cluster_type: 'app_store_developer',
            store: cluster.store,
            developer_id: cluster.developer_id,
            developer_name: cluster.developer_name,
            dev_key: cluster.dev_key,
            brands_targeted: cluster.brands,
            listings_count: cluster.rows_,
          }),
        ).run();
        appStoreClustersWritten++;
        clustersWritten++;
      } catch (err) {
        console.error(`[nexus] app-store cluster write error for ${clusterName}:`, err);
        continue;
      }

      outputs.push({
        type: "correlation",
        summary: `App-store campaign: ${clusterName} — ${cluster.rows_} listing(s) across ${cluster.brands} brands on ${cluster.store}.`,
        severity: cluster.brands >= 4 ? "high" : "medium",
        details: {
          cluster_id: clusterId,
          cluster_type: 'app_store_developer',
          store: cluster.store,
          developer_id: cluster.developer_id,
          developer_name: cluster.developer_name,
          brands_targeted: cluster.brands,
          listings: cluster.rows_,
          confidence,
        },
      });
    }
  } catch (err) {
    // app_store_listings missing → skip silently
    console.warn('[nexus] app-store cluster pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // --- Correlation 4: Dark-web actor clusters ---
  // Same source_author (or source_channel) posting brand mentions across
  // multiple brands = organized threat actor. Same structural approach.
  let darkWebClustersWritten = 0;
  try {
    const actorClusters = await db.prepare(`
      SELECT
        source,
        COALESCE(source_author, source_channel) AS actor_key,
        MAX(source_author) AS source_author,
        MAX(source_channel) AS source_channel,
        COUNT(DISTINCT brand_id) AS brands,
        COUNT(*) AS mentions,
        GROUP_CONCAT(DISTINCT brand_id) AS brand_ids,
        MIN(first_seen) AS first_seen,
        MAX(COALESCE(last_seen, first_seen)) AS last_seen
      FROM dark_web_mentions
      WHERE status = 'active'
        AND classification IN ('confirmed', 'suspicious')
        AND COALESCE(source_author, source_channel) IS NOT NULL
      GROUP BY source, actor_key
      HAVING brands >= 2 AND mentions >= 2
      ORDER BY brands DESC, mentions DESC
      LIMIT 50
    `).all<{
      source: string;
      actor_key: string;
      source_author: string | null;
      source_channel: string | null;
      brands: number;
      mentions: number;
      brand_ids: string | null;
      first_seen: string | null;
      last_seen: string | null;
    }>();

    for (const cluster of actorClusters.results) {
      // Deterministic id keyed on (source, actor_key). See asn cluster
      // comment above — audit C3.
      const clusterId = `cluster_actor_${slugifyKey(cluster.source)}_${slugifyKey(cluster.actor_key)}`;
      const actorLabel = cluster.source_author
        ?? cluster.source_channel
        ?? cluster.actor_key;
      const clusterName = `${cluster.source} actor "${actorLabel}" (${cluster.brands} brands)`;

      const confidence = Math.min(100,
        (cluster.brands * 15) +
        (cluster.mentions > 10 ? 20 : cluster.mentions > 5 ? 10 : 5)
      );

      try {
        await db.prepare(`
          INSERT INTO infrastructure_clusters (
            id, cluster_name, asns, countries, attack_types, brand_ids,
            campaign_ids, hosting_provider_ids, threat_count, confidence_score,
            first_detected, last_seen, status, agent_notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
          ON CONFLICT(id) DO UPDATE SET
            cluster_name = excluded.cluster_name,
            brand_ids = excluded.brand_ids,
            threat_count = excluded.threat_count,
            confidence_score = excluded.confidence_score,
            last_seen = excluded.last_seen,
            agent_notes = excluded.agent_notes
        `).bind(
          clusterId,
          clusterName,
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify(['dark_web_actor']),
          JSON.stringify((cluster.brand_ids ?? '').split(',').filter(Boolean)),
          JSON.stringify([]),
          JSON.stringify([]),
          cluster.mentions,
          confidence,
          cluster.first_seen,
          cluster.last_seen,
          JSON.stringify({
            cluster_type: 'dark_web_actor',
            source: cluster.source,
            source_author: cluster.source_author,
            source_channel: cluster.source_channel,
            actor_key: cluster.actor_key,
            brands_targeted: cluster.brands,
            mentions_count: cluster.mentions,
          }),
        ).run();
        darkWebClustersWritten++;
        clustersWritten++;
      } catch (err) {
        console.error(`[nexus] dark-web cluster write error for ${clusterName}:`, err);
        continue;
      }

      outputs.push({
        type: "correlation",
        summary: `Dark-web actor: ${clusterName} — ${cluster.mentions} mention(s) across ${cluster.brands} brands on ${cluster.source}.`,
        severity: cluster.brands >= 4 ? "high" : "medium",
        details: {
          cluster_id: clusterId,
          cluster_type: 'dark_web_actor',
          source: cluster.source,
          source_author: cluster.source_author,
          source_channel: cluster.source_channel,
          brands_targeted: cluster.brands,
          mentions: cluster.mentions,
          confidence,
        },
      });
    }
  } catch (err) {
    // dark_web_mentions missing → skip silently
    console.warn('[nexus] dark-web cluster pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // ══ Threats-table lanes, most-specific first ══════════════════════
  // The six lanes live in lib/nexus-threat-lanes.ts — the SAME functions
  // workflows/nexusRun.ts calls step-by-step, so the two dispatch paths
  // cannot drift (test/nexus-lane-parity.test.ts). Every stamp carries a
  // `cluster_id IS NULL` guard, so RUN ORDER is precedence:
  //   cert-serial → cert-SAN → per-IP → /24 subnet → registrar → ASN.
  // Keep it that way. The specific lanes are wrapped so one failing lane
  // doesn't stop the rest (historical agent behaviour); the ASN lane is
  // not, so a failing core query still fails the run.
  const laneOrNull = async (label: string, run: () => Promise<LaneResult>): Promise<LaneResult | null> => {
    try {
      return await run();
    } catch (err) {
      console.warn(`[nexus] ${label} pass skipped:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  };
  const certSerialLane = await laneOrNull('cert-serial', () => runCertSerialLane(db));
  const certSanLane = await laneOrNull('cert-SAN', () => runCertSanLane(db));
  const perIpLane = await laneOrNull('per-IP', () => runPerIpLane(db));
  const subnetLane = await laneOrNull('/24 subnet', () => runSubnetLane(db));
  const registrarLane = await laneOrNull('registrar', () => runRegistrarLane(db));
  for (const lane of [certSerialLane, certSanLane, perIpLane, subnetLane, registrarLane]) {
    clustersWritten += lane?.clustersWritten ?? 0;
  }

  // --- Lane: ASN + threat_type (RUNS LAST — mops up) ---
  const asnLane = await runAsnLane(db);
  clustersWritten += asnLane.clustersWritten;
  pivotsDetected = asnLane.pivotsDetected;

  // Retire stale ASN / per-IP rows the reworked lanes no longer emit
  // (shared-infra ASN-only, IP-reputation, hub IPs, malformed-ASN keys).
  // Runs before the component post-pass so retired rows never group.
  let retired: RetireResult | null = null;
  try {
    retired = await retireNonOperationalLaneClusters(db);
  } catch (err) {
    console.warn('[nexus] retire pass skipped:', err instanceof Error ? err.message : String(err));
  }

  for (const cluster of asnLane.clusters) {
    if (cluster.pivotEmitted) {
      outputs.push({
        type: "correlation",
        summary: `PIVOT DETECTED: ${cluster.clusterName} — activity dropped >80% in 7 days (was ${cluster.prev7d}, now ${cluster.last7d})`,
        severity: "high",
        details: {
          cluster_id: cluster.clusterId,
          asn: cluster.asn,
          prev_7d: cluster.prev7d,
          last_7d: cluster.last7d,
          confidence: cluster.confidence,
        },
      });
    }

    // Report accelerating clusters
    if (cluster.isAccelerating && cluster.last7d > 20) {
      outputs.push({
        type: "correlation",
        summary: `ACCELERATING: ${cluster.clusterName} — ${cluster.last7d} threats in 7d (up from ${cluster.prev7d})`,
        severity: cluster.last7d > 50 ? "high" : "medium",
        details: {
          cluster_id: cluster.clusterId,
          asn: cluster.asn,
          last_7d: cluster.last7d,
          prev_7d: cluster.prev7d,
          confidence: cluster.confidence,
        },
      });

      // B2 — intel_predictive: an accelerating cluster at the top of the
      // ASN confidence scale (ASN-only evidence is capped at
      // ASN_CONFIDENCE_CAP, so the gate is ASN_PREDICTIVE_MIN_CONFIDENCE,
      // not the old 70) with identified brands. One per affected brand;
      // group_key=intel_predictive:<brand_id> dedups per 12h window.
      if (cluster.confidence >= ASN_PREDICTIVE_MIN_CONFIDENCE && cluster.brandIds.length > 0) {
        const predictedWindow = `next 7 days (cluster accelerating ${cluster.last7d}/${cluster.prev7d})`;
        for (const bid of cluster.brandIds) {
          try {
            const row = await db.prepare(
              'SELECT name FROM brands WHERE id = ?'
            ).bind(bid).first<{ name: string }>();
            await emitIntelNotification(env, 'intel_predictive',
              renderIntelPredictive({
                brand_id: bid,
                brand_name: row?.name ?? bid,
                asn: cluster.asn,
                lookalike_count: cluster.threats,
                cluster_id: cluster.clusterId,
                predicted_window: predictedWindow,
              })
            );
          } catch { /* notification failures never break NEXUS */ }
        }
      }
    }
  }

  // ══ Post-pass: connected-components grouping (S2.4 / D5a) ═════════
  // Runs AFTER all six per-key lanes above have finished stamping
  // threats.cluster_id + writing infrastructure_clusters rows. Groups
  // those per-key clusters into transitive components using
  // SPECIFIC-evidence bridges only (cert-serial / cert-SAN / per-IP);
  // ASN / /24 / registrar clusters receive a component_id but never
  // bridge. Stamps `infrastructure_clusters.component_id`; does NOT
  // touch threats.cluster_id or the `asns` array. Kept in lockstep with
  // workflows/nexusRun.ts's `component-grouping` step — the SAME helper
  // is called identically in both paths so component_id never diverges
  // by dispatch source. Pure SQL/deterministic, no AI.
  try {
    const comp = await groupClusterComponents(db);
    outputs.push({
      type: "diagnostic",
      summary: `NEXUS components: ${comp.componentsFormed} component(s) grouping ${comp.clustersGrouped} clusters (${comp.componentIdsWritten} labels written, ${comp.componentIdsCleared} cleared, ${comp.componentsSkippedOverCap} skipped over size-cap)`,
      severity: "info",
      details: {
        components_formed: comp.componentsFormed,
        clusters_grouped: comp.clustersGrouped,
        component_ids_written: comp.componentIdsWritten,
        component_ids_cleared: comp.componentIdsCleared,
        bridges_seeked: comp.bridgesSeeked,
        bridges_skipped_hub: comp.bridgesSkippedHub,
        components_skipped_over_cap: comp.componentsSkippedOverCap,
        leaves_skipped_multi_component: comp.leavesSkippedMultiComponent,
      },
    });
  } catch (err) {
    console.warn('[nexus] component grouping post-pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // ══ Post-pass: infrastructure-movement pivot trigger (S2.4 / D5b) ═════
  // Additive SECOND `pivot_detected` trigger (alongside the ASN-lane
  // DORMANCY pivot above). Fires when a bridge-kind cluster (cert-serial /
  // cert-SAN / per-IP) GAINS new infra (IPs / ASNs / cert-serials) vs its
  // last-run fingerprint — the register-then-move / expand pattern. Same
  // event_type + target_agent='observer', discriminated by
  // payload_json.kind='infra_movement'; no new dispatch wiring. Heavily
  // flood-controlled (prior-snapshot required, significance + confidence
  // floor, 24h per-cluster cooldown, per-run hard cap). Kept in lockstep
  // with workflows/nexusRun.ts — the SAME helper is called identically in
  // both paths, so movement behavior never diverges by dispatch source.
  // Idempotent diff, no AI.
  try {
    const mv = await detectClusterInfraMovement(db);
    infraMovementPivots = mv.emitted;
    outputs.push({
      type: "diagnostic",
      summary: `NEXUS infra-movement: ${mv.emitted} pivot(s) emitted from ${mv.candidates} candidate(s) over ${mv.bridgeClustersConsidered} bridge cluster(s) (${mv.suppressedNoBaseline} no-baseline, ${mv.suppressedCooldown} cooldown, ${mv.overCapSkipped} over-cap, ${mv.cappedOut} capped, ${mv.fingerprintsWritten} fingerprints written)`,
      severity: mv.emitted > 0 ? "high" : "info",
      details: {
        emitted: mv.emitted,
        candidates: mv.candidates,
        bridge_clusters_considered: mv.bridgeClustersConsidered,
        hub_excluded: mv.hubExcluded,
        suppressed_no_baseline: mv.suppressedNoBaseline,
        suppressed_cooldown: mv.suppressedCooldown,
        suppressed_low_confidence: mv.suppressedLowConfidence,
        suppressed_insufficient: mv.suppressedInsufficient,
        over_cap_skipped: mv.overCapSkipped,
        capped_out: mv.cappedOut,
        fingerprints_written: mv.fingerprintsWritten,
      },
    });
    // F2/parity: keep `pivotsDetected` DORMANCY-only (mirrors the workflow
    // path, which reports movement as a SEPARATE field). Conflating the two
    // would make cross-dispatch-source diagnostics diverge.
  } catch (err) {
    console.warn('[nexus] infra-movement post-pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // --- Emit completion event ---
  try {
    await db.prepare(`
      INSERT INTO agent_events (id, event_type, source_agent, payload_json)
      VALUES (?, 'nexus_complete', 'nexus', ?)
    `).bind(
      crypto.randomUUID(),
      JSON.stringify({
        clusters_written: clustersWritten,
        providers_updated: providersUpdated,
        providers_zeroed: providersZeroed,
        pivots_detected: pivotsDetected,
        infra_movement_pivots: infraMovementPivots,
        app_store_clusters: appStoreClustersWritten,
        dark_web_clusters: darkWebClustersWritten,
      })
    ).run();
  } catch (err) {
    console.error('[nexus] completion event error:', err);
  }

  outputs.push({
    type: "diagnostic",
    summary: `NEXUS: ${clustersWritten} clusters written (${asnLane.analyzed} ASN groups analyzed, ${appStoreClustersWritten} app-store dev clusters, ${darkWebClustersWritten} dark-web actor clusters), ${retired?.markedSharedInfra ?? 0} retired as shared-infra, ${retired?.markedSuperseded ?? 0} superseded, ${providersUpdated} providers trend-updated, ${providersZeroed} trend-zeroed, ${pivotsDetected} dormancy pivots, ${infraMovementPivots} infra-movement pivots`,
    severity: pivotsDetected > 0 || infraMovementPivots > 0 ? "high" : "info",
    details: {
      clusters_written: clustersWritten,
      providers_updated: providersUpdated,
      providers_zeroed: providersZeroed,
      pivots_detected: pivotsDetected,
      infra_movement_pivots: infraMovementPivots,
      asn_clusters_analyzed: asnLane.analyzed,
      cert_serial_clusters: certSerialLane?.clustersWritten ?? 0,
      cert_san_clusters: certSanLane?.clustersWritten ?? 0,
      per_ip_clusters: perIpLane?.clustersWritten ?? 0,
      subnet24_clusters: subnetLane?.clustersWritten ?? 0,
      registrar_clusters: registrarLane?.clustersWritten ?? 0,
      asn_clusters: asnLane.clustersWritten,
      retired_shared_infra: retired?.markedSharedInfra ?? 0,
      retired_superseded: retired?.markedSuperseded ?? 0,
      app_store_clusters: appStoreClustersWritten,
      dark_web_clusters: darkWebClustersWritten,
    },
  });

  return { clustersWritten, providersUpdated, providersZeroed, pivotsDetected, outputs };
}

// Cluster naming lives in lib/cluster-naming.ts and the threats-table lanes
// in lib/nexus-threat-lanes.ts, so workflows/nexusRun.ts computes the SAME
// ids, names and confidence — both paths upsert the same rows.

// ─── Agent Module Definition ──────────────────────────────────────

export const nexusAgent: AgentModule = {
  name: "nexus",
  displayName: "NEXUS",
  description: "Infrastructure correlation engine — clusters threats by ASN, subnet, and temporal patterns",
  color: "#00d4ff",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 360,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 10_000_000 },
  // threat_cube_provider read and hosting_providers write moved
  // out of this file in 2026-05-20 (PR-BJ Phase 1B) — both happen
  // via lib/provider-trends.updateProviderTrends() now. The
  // cartographer agent already declares the same pair, so the
  // ARCHITECT manifest still surfaces them on the platform map.
  // Same for the threats-table lanes (2026-10-14): their SQL — threats
  // read + cluster_id stamp — moved to lib/nexus-threat-lanes.ts, shared
  // with workflows/nexusRun.ts, so `threats` is no longer extracted from
  // (or declared by) this file; the agent still reads/stamps threats
  // through that module.
  reads: [
    { kind: "d1_table", name: "app_store_listings" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "dark_web_mentions" },
  ],
  writes: [
    { kind: "d1_table", name: "agent_events" },
    { kind: "d1_table", name: "agent_runs" },
    { kind: "d1_table", name: "infrastructure_clusters" },
  ],
  outputs: [{ type: "correlation" }, { type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 4,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;
    const startedAt = new Date().toISOString();

    const result = await runNexus(env.DB, env);

    // Log run to agent_runs (handled by agentRunner, but also log to agent_events)
    try {
      await env.DB.prepare(`
        INSERT INTO agent_runs (id, agent_id, started_at, completed_at, status, records_processed)
        VALUES (?, 'nexus', ?, datetime('now'), 'success', ?)
      `).bind(crypto.randomUUID(), startedAt, result.clustersWritten).run();
    } catch {
      // agentRunner already tracks this — ignore duplicate
    }

    return {
      itemsProcessed: result.clustersWritten + result.providersUpdated,
      itemsCreated: result.clustersWritten,
      itemsUpdated: result.providersUpdated,
      output: {
        clusters_written: result.clustersWritten,
        providers_updated: result.providersUpdated,
        providers_zeroed: result.providersZeroed,
        pivots_detected: result.pivotsDetected,
      },
      agentOutputs: result.outputs,
    };
  },
};
