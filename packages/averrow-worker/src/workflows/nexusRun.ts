import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types';
import { updateProviderTrends } from '../lib/provider-trends';
import { groupClusterComponents } from '../lib/cluster-components';
import { detectClusterInfraMovement } from '../lib/cluster-infra-movement';
import { notRetiredClusterSql } from '../lib/cluster-status';
// Shared with agents/nexus.ts — both paths upsert the same
// `infrastructure_clusters` rows, so the lanes are ONE implementation.
import {
  runCertSerialLane,
  runCertSanLane,
  runPerIpLane,
  runSubnetLane,
  runRegistrarLane,
  runAsnLane,
  retireNonOperationalLaneClusters,
} from '../lib/nexus-threat-lanes';

type NexusWorkflowParams = {
  forceRefresh?: boolean;
};

export class NexusWorkflow extends WorkflowEntrypoint<Env, NexusWorkflowParams> {
  /**
   * Workflow entrypoint. Delegates to `execute()` and records any terminal
   * failure to `agent_activity_log` before rethrowing (rethrow preserved so
   * Cloudflare still marks the instance `errored`).
   *
   * Why this wrapper exists: the Workflow path deliberately does NOT write
   * `agent_runs` (lib/workflow-dispatch.ts header), so a run that threw left
   * NO trace anywhere. `agent_mesh.stalled[]` only covers `agent_runs` rows
   * stuck in 'running', and platform-diagnostics infers a workflow agent's
   * health from `workflow_dispatched` vs `batch_complete` counts — so a run
   * that started and died read as "dispatched / running / 0 failed / no
   * last_error" indefinitely. That structural blind spot is how the
   * 2026-09 tail outage went unnoticed. This row is the missing surface.
   *
   * NOTE: `handlers/diagnostics.ts` filters its workflow rollup on
   * event_type IN ('workflow_dispatched','batch_complete',
   * 'workflow_dispatch_failed','workflow_cooldown_skip') — add
   * 'workflow_failed' there so it lands in `agent_mesh.per_agent.last_error`.
   */
  async run(event: WorkflowEvent<NexusWorkflowParams>, step: WorkflowStep) {
    try {
      return await this.execute(event, step);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.env.DB.prepare(`
          INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
          VALUES (?, 'nexus', 'workflow_failed', ?, ?, 'critical')
        `).bind(
          crypto.randomUUID(),
          `NEXUS Workflow terminated before completion: ${message.slice(0, 400)}`,
          JSON.stringify({ error: message.slice(0, 1000), triggered_by: 'workflow' }),
        ).run();
      } catch {
        // The audit write must never mask the original failure.
      }
      throw err;
    }
  }

  private async execute(event: WorkflowEvent<NexusWorkflowParams>, step: WorkflowStep) {
    // Step 1: Count (non-retired) clusters before run
    const before = await step.do('count-before', async () => {
      const result = await this.env.DB.prepare(
        `SELECT COUNT(*) as count FROM infrastructure_clusters WHERE ${notRetiredClusterSql()}`
      ).first<{ count: number }>();
      return { clusters_before: result?.count ?? 0 };
    });

    await step.do('log-start', async () => {
      await this.env.DB.prepare(`
        INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
        VALUES (?, 'nexus', 'started', ?, ?, 'info')
      `).bind(
        crypto.randomUUID(),
        `NEXUS Workflow started — ${before.clusters_before} existing clusters`,
        JSON.stringify({ clusters_before: before.clusters_before, triggered_by: 'workflow' })
      ).run();
    });

    // Steps 1a-2: the six threats-table lanes, MOST-SPECIFIC FIRST
    // (cert-serial → cert-SAN → per-IP → /24 → registrar → ASN). Every
    // stamp carries a `cluster_id IS NULL` guard, so step order is
    // precedence — do not reorder. The lane bodies live in
    // lib/nexus-threat-lanes.ts and are the SAME functions agents/nexus.ts
    // calls, so the workflow and the manual-fallback agent upsert identical
    // rows (ids, names, confidence, country_counts, stamp predicates) — see
    // test/nexus-lane-parity.test.ts. Each step is retry-idempotent:
    // deterministic ids + ON CONFLICT DO UPDATE + the cluster_id IS NULL
    // stamp. Pure SQL, no AI.
    const laneRetries = { retries: { limit: 2, delay: '5 seconds' } } as const;
    const certSerialLane = await step.do('cert-serial-correlation', laneRetries, async () => {
      const r = await runCertSerialLane(this.env.DB);
      return { clustersWritten: r.clustersWritten, serialsAnalyzed: r.analyzed };
    });
    const certSanLane = await step.do('cert-san-correlation', laneRetries, async () => {
      const r = await runCertSanLane(this.env.DB);
      return { clustersWritten: r.clustersWritten, sanSetsAnalyzed: r.analyzed };
    });
    const perIpLane = await step.do('per-ip-correlation', laneRetries, async () => {
      const r = await runPerIpLane(this.env.DB);
      return { clustersWritten: r.clustersWritten, ipsAnalyzed: r.analyzed };
    });
    const subnetLane = await step.do('subnet24-correlation', laneRetries, async () => {
      const r = await runSubnetLane(this.env.DB);
      return { clustersWritten: r.clustersWritten, subnetsAnalyzed: r.analyzed };
    });
    const registrarLane = await step.do('registrar-correlation', laneRetries, async () => {
      const r = await runRegistrarLane(this.env.DB);
      return { clustersWritten: r.clustersWritten, registrarsAnalyzed: r.analyzed };
    });

    // Step 2: ASN correlation (RUNS LAST — mops up only unclaimed threats;
    // emits dormancy pivot_detected → Observer). The per-cluster detail the
    // agent path turns into outputs is dropped here: step results are
    // persisted and must stay small.
    const correlation = await step.do('asn-correlation', laneRetries, async () => {
      const r = await runAsnLane(this.env.DB);
      return {
        clustersWritten: r.clustersWritten,
        pivotsDetected: r.pivotsDetected,
        accelerating: r.accelerating,
        asnsAnalyzed: r.analyzed,
      };
    });

    // Step 2a: retire ASN / per-IP rows the reworked lanes no longer emit
    // (shared-infra ASN-only, IP-reputation, hub IPs, malformed-ASN keys) so
    // they stop reaching readers. Before the component post-pass so retired
    // rows never group. Idempotent (only active/dormant rows are touched).
    const retired = await step.do('retire-non-operational', laneRetries, async () => {
      return await retireNonOperationalLaneClusters(this.env.DB);
    });

    // Step 2b: Connected-components grouping post-pass (S2.4 / D5a).
    // Runs AFTER every per-key stamping lane above so it groups the
    // fully-populated infrastructure_clusters rows. Uses SPECIFIC-evidence
    // bridges only (cert-serial / cert-SAN / per-IP); ASN / /24 / registrar
    // clusters receive a component_id but never bridge. Stamps
    // infrastructure_clusters.component_id; does NOT touch
    // threats.cluster_id or the `asns` array (component grouping is a
    // separate label, kept out of the Attributor's asns.length>=3 gate).
    // Kept in lockstep with agents/nexus.ts's post-pass — the SAME helper
    // (lib/cluster-components.groupClusterComponents) is called identically
    // in both paths so component_id never diverges by dispatch source.
    // Retry-idempotent: diff-writes only, a rerun over unchanged data
    // writes 0 rows. Pure SQL/deterministic, no AI.
    const components = await step.do('component-grouping', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      return await groupClusterComponents(this.env.DB);
    });

    // Step 2c: Infrastructure-movement pivot trigger (S2.4 / D5b). Additive
    // SECOND `pivot_detected` trigger alongside the ASN-lane DORMANCY pivot
    // in step 2: fires when a bridge-kind cluster (cert-serial / cert-SAN /
    // per-IP) GAINS new infra vs its last-run fingerprint (register-then-
    // move / expand). Same event_type + target_agent='observer',
    // discriminated by payload_json.kind='infra_movement' — no new dispatch
    // wiring. Flood-controlled (prior-snapshot required, significance +
    // confidence floor, 24h per-cluster cooldown, per-run hard cap). Kept in
    // lockstep with agents/nexus.ts's post-pass — the SAME helper
    // (lib/cluster-infra-movement.detectClusterInfraMovement) is called
    // identically in both paths so movement never diverges by dispatch
    // source. Idempotent diff, no AI.
    const movement = await step.do('infra-movement', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      return await detectClusterInfraMovement(this.env.DB);
    });

    // Step 3: Update hosting provider trends
    const providers = await step.do('update-provider-trends', async () => {
      // Phase 2 D1 migration: read aggregates from threat_cube_provider
      // instead of GROUP BY scanning the full threats table. Mirrors
      // the cartographer aggregateProviderStats migration in PR-B
      // (#1278). The cube is hour-bucketed with denormalized severity
      // + threat_type, so summing across 7d / 30d slices is bounded
      // by the cube row count, not the threats count.
      //
      // Note: total_count + active_count don't exist as a clean
      // slice in the cube (active_threat_count is a separate
      // pre-computed column on hosting_providers, maintained by
      // cartographer Phase 5). We pull the rolling-window inflows
      // from the cube and leave active/total to cartographer's own
      // path — re-running them here would duplicate work and the
      // pre-computed columns are already fresh.
      //
      // Delegates to lib/provider-trends.ts which adds a diff-filter
      // step: read current trend_7d/trend_30d and skip the UPDATE
      // when the values match. Halved the per-tick UPDATE count in
      // the 2026-05-20 write-budget audit.
      const result = await updateProviderTrends(this.env.DB);
      return {
        providers_updated: result.providers_updated,
        providers_zeroed: result.providers_zeroed,
      };
    });

    // Aggregate cluster counts across all lanes for the completion log.
    const laneMeta = {
      cert_serial_clusters: certSerialLane.clustersWritten,
      serials_analyzed: certSerialLane.serialsAnalyzed,
      cert_san_clusters: certSanLane.clustersWritten,
      san_sets_analyzed: certSanLane.sanSetsAnalyzed,
      per_ip_clusters: perIpLane.clustersWritten,
      ips_analyzed: perIpLane.ipsAnalyzed,
      subnet24_clusters: subnetLane.clustersWritten,
      subnets_analyzed: subnetLane.subnetsAnalyzed,
      registrar_clusters: registrarLane.clustersWritten,
      registrars_analyzed: registrarLane.registrarsAnalyzed,
      retired_rows_scanned: retired.rowsScanned,
      retired_shared_infra: retired.markedSharedInfra,
      retired_superseded: retired.markedSuperseded,
      // Surfaced so every batch_complete records the infrastructure_clusters
      // row count the tail steps had to read — the leading indicator for the
      // unbounded-growth failure this run used to die of.
      component_clusters_read: components.clustersRead,
      components_formed: components.componentsFormed,
      component_clusters_grouped: components.clustersGrouped,
      component_ids_written: components.componentIdsWritten,
      component_ids_cleared: components.componentIdsCleared,
      components_skipped_over_cap: components.componentsSkippedOverCap,
      leaves_skipped_multi_component: components.leavesSkippedMultiComponent,
      infra_movement_emitted: movement.emitted,
      infra_movement_candidates: movement.candidates,
      infra_movement_over_cap_skipped: movement.overCapSkipped,
      infra_movement_capped_out: movement.cappedOut,
      infra_movement_fingerprints_written: movement.fingerprintsWritten,
    };
    const totalClustersWritten =
      correlation.clustersWritten + certSerialLane.clustersWritten +
      certSanLane.clustersWritten + perIpLane.clustersWritten +
      subnetLane.clustersWritten + registrarLane.clustersWritten;

    // Step 4: Log completion
    await step.do('log-complete', async () => {
      await this.env.DB.prepare(`
        INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
        VALUES (?, 'nexus', 'batch_complete', ?, ?, 'info')
      `).bind(
        crypto.randomUUID(),
        `NEXUS complete — ${totalClustersWritten} clusters written (${certSerialLane.clustersWritten} cert-serial, ${certSanLane.clustersWritten} cert-SAN, ${perIpLane.clustersWritten} per-IP, ${correlation.clustersWritten} ASN, ${subnetLane.clustersWritten} /24, ${registrarLane.clustersWritten} registrar), ${components.componentsFormed} components (${components.clustersGrouped} clusters grouped), ${correlation.pivotsDetected} dormancy pivots, ${movement.emitted} infra-movement pivots, ${providers.providers_updated} providers updated, ${providers.providers_zeroed} providers zeroed`,
        JSON.stringify({ ...correlation, ...laneMeta, ...providers })
      ).run();

      await this.env.DB.prepare(`
        INSERT INTO agent_events (id, event_type, source_agent, payload_json, priority, status)
        VALUES (?, 'nexus_complete', 'nexus', ?, 2, 'pending')
      `).bind(
        crypto.randomUUID(),
        JSON.stringify({ ...correlation, ...laneMeta, ...providers })
      ).run();
    });

    return { ...correlation, ...laneMeta, ...providers };
  }
}
