import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types';

type NexusWorkflowParams = {
  forceRefresh?: boolean;
};

export class NexusWorkflow extends WorkflowEntrypoint<Env, NexusWorkflowParams> {
  async run(event: WorkflowEvent<NexusWorkflowParams>, step: WorkflowStep) {
    // Step 1: Count clusters before run
    const before = await step.do('count-before', async () => {
      const result = await this.env.DB.prepare(
        'SELECT COUNT(*) as count FROM infrastructure_clusters'
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

    // Step 2: Run ASN correlation — the core NEXUS query
    const correlation = await step.do('asn-correlation', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const asnClusters = await this.env.DB.prepare(`
        SELECT
          asn,
          threat_type,
          COUNT(DISTINCT campaign_id) as campaigns,
          COUNT(DISTINCT target_brand_id) as brands,
          COUNT(*) as threats,
          GROUP_CONCAT(DISTINCT country_code) as countries,
          GROUP_CONCAT(DISTINCT target_brand_id) as brand_ids,
          GROUP_CONCAT(DISTINCT hosting_provider_id) as provider_ids,
          MIN(first_seen) as first_seen,
          MAX(first_seen) as last_seen,
          SUM(CASE WHEN first_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d,
          SUM(CASE WHEN first_seen < datetime('now', '-7 days') AND first_seen >= datetime('now', '-14 days') THEN 1 ELSE 0 END) as prev_7d
        FROM threats
        WHERE asn IS NOT NULL
        GROUP BY asn, threat_type
        HAVING threats >= 10
        ORDER BY threats DESC
        LIMIT 100
      `).all<Record<string, unknown>>();

      let clustersWritten = 0;
      let pivotsDetected = 0;
      let accelerating = 0;

      for (const cluster of asnClusters.results) {
        const prev7d = cluster.prev_7d as number;
        const last7d = cluster.last_7d as number;
        const threats = cluster.threats as number;
        const campaigns = cluster.campaigns as number;
        const brands = cluster.brands as number;
        const asn = cluster.asn as string;
        const threatType = cluster.threat_type as string;
        const countries = cluster.countries as string | null;
        const brandIds = cluster.brand_ids as string | null;
        const providerIds = cluster.provider_ids as string | null;
        const firstSeen = cluster.first_seen as string;
        const lastSeen = cluster.last_seen as string;

        const isPivoting = prev7d > 10 && last7d < prev7d * 0.2;
        const isAccelerating = last7d > prev7d * 1.5;
        const confidence = Math.min(
          100,
          campaigns * 10 + brands * 5 + (threats > 100 ? 20 : threats > 50 ? 10 : 5)
        );

        const clusterId = crypto.randomUUID();
        const asnParts = (asn ?? '').split(' ');
        const asnNum = asnParts[0] ?? asn;
        const orgName = asnParts.slice(1).join(' ') || asn;
        const clusterName = `${orgName} ${threatType} cluster`;

        try {
          await this.env.DB.prepare(`
            INSERT INTO infrastructure_clusters (
              id, cluster_name, asns, countries, attack_types, brand_ids,
              campaign_ids, hosting_provider_ids, threat_count, confidence_score,
              first_detected, last_seen, status, agent_notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `).bind(
            clusterId, clusterName,
            JSON.stringify([asn]),
            JSON.stringify((countries ?? '').split(',').filter(Boolean)),
            JSON.stringify([threatType]),
            JSON.stringify((brandIds ?? '').split(',').filter(Boolean)),
            JSON.stringify([]),
            JSON.stringify((providerIds ?? '').split(',').filter(Boolean)),
            threats, confidence,
            firstSeen, lastSeen,
            isPivoting ? 'dormant' : 'active',
            isPivoting ? 'PIVOT DETECTED: activity dropped >80% in last 7 days'
              : isAccelerating ? 'ACCELERATING: activity up >50% vs prior week'
              : null
          ).run();
          clustersWritten++;

          await this.env.DB.prepare(
            `UPDATE threats SET cluster_id = ? WHERE asn = ? AND threat_type = ? AND cluster_id IS NULL`
          ).bind(clusterId, asn, threatType).run();

        } catch { continue; }

        if (isPivoting && confidence > 40) {
          pivotsDetected++;
          await this.env.DB.prepare(`
            INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority)
            VALUES (?, 'pivot_detected', 'nexus', 'observer', ?, 1)
          `).bind(crypto.randomUUID(), JSON.stringify({ cluster_id: clusterId, asn })).run();
        }

        if (isAccelerating) accelerating++;
      }

      return { clustersWritten, pivotsDetected, accelerating, asnsAnalyzed: asnClusters.results.length };
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
      const agg = await this.env.DB.prepare(`
        SELECT
          hosting_provider_id,
          SUM(CASE WHEN hour_bucket >= datetime('now', '-7 days')
                   THEN threat_count ELSE 0 END) as count_7d,
          SUM(CASE WHEN hour_bucket >= datetime('now', '-30 days')
                   THEN threat_count ELSE 0 END) as count_30d
        FROM threat_cube_provider
        WHERE hour_bucket >= datetime('now', '-30 days')
        GROUP BY hosting_provider_id
      `).all<{
        hosting_provider_id: string;
        count_7d: number;
        count_30d: number;
      }>();

      // Update providers in batches of 20 to stay well under CPU limit.
      // active/total updates removed — pre-computed columns are
      // maintained by cartographer Phase 5 (handlers/admin.ts:1309).
      let updated = 0;
      const BATCH = 20;
      for (let i = 0; i < agg.results.length; i += BATCH) {
        const chunk = agg.results.slice(i, i + BATCH);
        const stmts = chunk.map(r =>
          this.env.DB.prepare(`
            UPDATE hosting_providers SET
              trend_7d = ?,
              trend_30d = ?
            WHERE id = ?
          `).bind(r.count_7d, r.count_30d, r.hosting_provider_id)
        );
        await this.env.DB.batch(stmts);
        updated += chunk.length;
      }

      return { providers_updated: updated };
    });

    // Step 4: Log completion
    await step.do('log-complete', async () => {
      await this.env.DB.prepare(`
        INSERT INTO agent_activity_log (id, agent_id, event_type, message, metadata_json, severity)
        VALUES (?, 'nexus', 'batch_complete', ?, ?, 'info')
      `).bind(
        crypto.randomUUID(),
        `NEXUS complete — ${correlation.clustersWritten} clusters written, ${correlation.pivotsDetected} pivots, ${providers.providers_updated} providers updated`,
        JSON.stringify({ ...correlation, ...providers })
      ).run();

      await this.env.DB.prepare(`
        INSERT INTO agent_events (id, event_type, source_agent, payload_json, priority, status)
        VALUES (?, 'nexus_complete', 'nexus', ?, 2, 'pending')
      `).bind(
        crypto.randomUUID(),
        JSON.stringify({ ...correlation, ...providers })
      ).run();
    });

    return { ...correlation, ...providers };
  }
}
