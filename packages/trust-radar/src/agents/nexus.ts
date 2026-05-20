/**
 * NEXUS Agent — Infrastructure Correlation Engine (v1, SQL-only).
 *
 * Runs every 4 hours (Flight Control will trigger more often later).
 * Finds patterns humans can't see — clustering threats by ASN, subnet,
 * temporal window, and cross-brand targeting.
 *
 * SQL does correlation. AI does narrative. Never pay AI to do what GROUP BY can do.
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

// ─── NEXUS core correlation logic ─────────────────────────────────

export async function runNexus(db: D1Database, env: Env): Promise<{
  clustersWritten: number;
  providersUpdated: number;
  pivotsDetected: number;
  outputs: AgentOutputEntry[];
}> {
  const outputs: AgentOutputEntry[] = [];
  let clustersWritten = 0;
  let pivotsDetected = 0;

  // --- Correlation 1: ASN + threat_type clustering ---
  const asnClusters = await db.prepare(`
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
      -- Pivot detection: activity in last 7d vs previous 7d
      SUM(CASE WHEN first_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d,
      SUM(CASE WHEN first_seen < datetime('now', '-7 days') AND first_seen >= datetime('now', '-14 days') THEN 1 ELSE 0 END) as prev_7d
    FROM threats
    WHERE asn IS NOT NULL
    GROUP BY asn, threat_type
    HAVING threats >= 10
    ORDER BY threats DESC
    LIMIT 100
  `).all<{
    asn: string;
    threat_type: string;
    campaigns: number;
    brands: number;
    threats: number;
    countries: string | null;
    brand_ids: string | null;
    provider_ids: string | null;
    first_seen: string | null;
    last_seen: string | null;
    last_7d: number;
    prev_7d: number;
  }>();

  // --- Write clusters ---
  for (const cluster of asnClusters.results) {
    const isPivoting = cluster.prev_7d > 10 && cluster.last_7d < cluster.prev_7d * 0.2;
    const isAccelerating = cluster.last_7d > cluster.prev_7d * 1.5;

    // Confidence: more campaigns + brands + types = higher confidence
    const confidence = Math.min(100,
      (cluster.campaigns * 10) +
      (cluster.brands * 5) +
      (cluster.threats > 100 ? 20 : cluster.threats > 50 ? 10 : 5)
    );

    // Deterministic id derived from the cluster's natural key
    // (asn + threat_type, the GROUP BY of the SELECT above). Earlier
    // versions used `crypto.randomUUID()` which produced a fresh row
    // on every NEXUS run — audit C3 (2026-05-06) found 6 near-identical
    // "CA AS13335 malware distribution cluster" rows surfacing in the
    // Campaigns view as a result.
    const clusterId = `cluster_asn_${slugifyKey(cluster.asn)}_${slugifyKey(cluster.threat_type)}`;
    const clusterName = generateClusterName(cluster);

    try {
      await db.prepare(`
        INSERT INTO infrastructure_clusters (
          id, cluster_name, asns, countries, attack_types, brand_ids,
          campaign_ids, hosting_provider_ids, threat_count, confidence_score,
          first_detected, last_seen, status, agent_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cluster_name = excluded.cluster_name,
          countries = excluded.countries,
          brand_ids = excluded.brand_ids,
          hosting_provider_ids = excluded.hosting_provider_ids,
          threat_count = excluded.threat_count,
          confidence_score = excluded.confidence_score,
          last_seen = excluded.last_seen,
          status = excluded.status,
          agent_notes = excluded.agent_notes
      `).bind(
        clusterId,
        clusterName,
        JSON.stringify([cluster.asn]),
        JSON.stringify((cluster.countries ?? '').split(',').filter(Boolean)),
        JSON.stringify([cluster.threat_type]),
        JSON.stringify((cluster.brand_ids ?? '').split(',').filter(Boolean)),
        JSON.stringify([]), // campaign_ids not aggregated with GROUP_CONCAT here
        JSON.stringify((cluster.provider_ids ?? '').split(',').filter(Boolean)),
        cluster.threats,
        confidence,
        cluster.first_seen,
        cluster.last_seen,
        isPivoting ? 'dormant' : 'active',
        isPivoting ? 'PIVOT DETECTED: activity dropped >80% in last 7 days'
          : isAccelerating ? 'ACCELERATING: activity up >50% vs prior week'
          : null
      ).run();
      clustersWritten++;
    } catch (err) {
      console.error(`[nexus] cluster write error for ${clusterName}:`, err);
      continue;
    }

    // Update threats with cluster_id
    try {
      await db.prepare(`
        UPDATE threats SET cluster_id = ?
        WHERE asn = ? AND threat_type = ? AND cluster_id IS NULL
      `).bind(clusterId, cluster.asn, cluster.threat_type).run();
    } catch (err) {
      console.error(`[nexus] cluster_id update error:`, err);
    }

    // Emit pivot alert to Observer
    if (isPivoting && confidence > 40) {
      pivotsDetected++;
      try {
        await db.prepare(`
          INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority)
          VALUES (?, 'pivot_detected', 'nexus', 'observer', ?, 1)
        `).bind(
          crypto.randomUUID(),
          JSON.stringify({ cluster_id: clusterId, asn: cluster.asn, cluster_name: clusterName })
        ).run();
      } catch (err) {
        console.error('[nexus] pivot event emit error:', err);
      }

      outputs.push({
        type: "correlation",
        summary: `PIVOT DETECTED: ${clusterName} — activity dropped >80% in 7 days (was ${cluster.prev_7d}, now ${cluster.last_7d})`,
        severity: "high",
        details: {
          cluster_id: clusterId,
          asn: cluster.asn,
          prev_7d: cluster.prev_7d,
          last_7d: cluster.last_7d,
          confidence,
        },
      });
    }

    // Report accelerating clusters
    if (isAccelerating && cluster.last_7d > 20) {
      outputs.push({
        type: "correlation",
        summary: `ACCELERATING: ${clusterName} — ${cluster.last_7d} threats in 7d (up from ${cluster.prev_7d})`,
        severity: cluster.last_7d > 50 ? "high" : "medium",
        details: {
          cluster_id: clusterId,
          asn: cluster.asn,
          last_7d: cluster.last_7d,
          prev_7d: cluster.prev_7d,
          confidence,
        },
      });

      // B2 — intel_predictive: a high-confidence accelerating cluster
      // with identified brands is the canonical predictive signal.
      // Fire one intel_predictive per affected brand; routing in
      // createNotification fans this only to subscribers per N3.
      // group_key=intel_predictive:<brand_id> ensures one fire per
      // brand per registry dedup window (12h).
      if (confidence >= 70 && cluster.brand_ids) {
        const brandIds = cluster.brand_ids.split(',').filter(Boolean);
        const lookalikeCount = cluster.threats;
        const predictedWindow = `next 7 days (cluster accelerating ${cluster.last_7d}/${cluster.prev_7d})`;
        for (const bid of brandIds) {
          try {
            const row = await db.prepare(
              'SELECT name FROM brands WHERE id = ?'
            ).bind(bid).first<{ name: string }>();
            await emitIntelNotification(env, 'intel_predictive',
              renderIntelPredictive({
                brand_id: bid,
                brand_name: row?.name ?? bid,
                asn: String(cluster.asn),
                lookalike_count: lookalikeCount,
                cluster_id: clusterId,
                predicted_window: predictedWindow,
              })
            );
          } catch { /* notification failures never break NEXUS */ }
        }
      }
    }
  }

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
  try {
    const result = await updateProviderTrends(db);
    providersUpdated = result.providers_updated;
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

  // --- Per-IP fan-out clustering (PR-D from 2026-05-16 audit) ---
  //
  // Audit finding: 244,563 active threats (70%) have no campaign,
  // including IPs like 76.223.54.146 (900 brands hit) that are pure
  // mass-impersonation infrastructure. Existing Nexus clustering
  // groups by (asn, threat_type) so these per-IP fan-outs got
  // absorbed into wide ASN clusters and lost the IP-pivot signal.
  //
  // Rule: same active IP across ≥5 active threats AND ≥3 distinct
  // brands ⇒ stable cluster id `cluster_ip_<ip>`. ON CONFLICT updates
  // counts so the cluster stays current across runs. Limited to top
  // 30 by threat_count per cycle (4h cadence) so a sudden surge of
  // 1000+ qualifying IPs can't blow up the write budget.
  //
  // Bounded D1 cost: one GROUP BY scan + N writes (insert-or-merge) per 4h cycle.
  // No AI. Cluster rows feed Attribution Backlog (PR-B) where
  // operators can route them for human attribution.
  try {
    const ipFanout = await db.prepare(`
      SELECT ip_address,
             COUNT(*)                          AS threat_count,
             COUNT(DISTINCT target_brand_id)   AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT asn)        AS asns,
             GROUP_CONCAT(DISTINCT country_code) AS countries,
             GROUP_CONCAT(DISTINCT threat_type) AS attack_types,
             MIN(first_seen)                   AS first_seen,
             MAX(first_seen)                   AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ip_address IS NOT NULL
         AND ip_address NOT IN ('', '0.0.0.0')
         AND target_brand_id IS NOT NULL
       GROUP BY ip_address
      HAVING brand_count >= 3 AND threat_count >= 5
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 30
    `).all<{
      ip_address: string;
      threat_count: number;
      brand_count: number;
      brand_ids: string | null;
      asns: string | null;
      countries: string | null;
      attack_types: string | null;
      first_seen: string;
      last_seen: string;
    }>();

    for (const row of ipFanout.results) {
      const ipSafe = row.ip_address.replace(/[^0-9a-f.:]/gi, '');
      const clusterId = `cluster_ip_${ipSafe}`;
      const clusterName =
        `IP ${row.ip_address} mass-impersonation (${row.brand_count} brands, ${row.threat_count} threats)`;
      const brandIds  = (row.brand_ids  ?? '').split(',').filter(Boolean);
      const asns      = (row.asns       ?? '').split(',').filter(Boolean);
      const countries = (row.countries  ?? '').split(',').filter(Boolean);
      const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
      // Confidence scales with brand fan-out — diversity is the
      // signal here, not raw threat volume.
      const confidence = Math.min(100,
        (row.brand_count >= 100 ? 90 : row.brand_count >= 25 ? 75 : row.brand_count >= 10 ? 60 : 40),
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
            asns = excluded.asns,
            countries = excluded.countries,
            attack_types = excluded.attack_types,
            brand_ids = excluded.brand_ids,
            threat_count = excluded.threat_count,
            confidence_score = excluded.confidence_score,
            last_seen = excluded.last_seen,
            agent_notes = excluded.agent_notes
        `).bind(
          clusterId,
          clusterName,
          JSON.stringify(asns),
          JSON.stringify(countries),
          JSON.stringify(attackTypes),
          JSON.stringify(brandIds),
          JSON.stringify([]),
          JSON.stringify([]),
          row.threat_count,
          confidence,
          row.first_seen,
          row.last_seen,
          `Per-IP fan-out: ${row.ip_address} hosts threats against ${row.brand_count} brands across ${asns.length} ASNs. Mass-impersonation infrastructure.`,
        ).run();

        // Link the underlying threats to this cluster so the
        // Attribution Backlog drill-down + threat-actor pages can
        // surface them under the IP-pivot cluster instead of
        // orphan/no-cluster status.
        await db.prepare(
          `UPDATE threats SET cluster_id = ?
            WHERE ip_address = ? AND status = 'active' AND cluster_id IS NULL`,
        ).bind(clusterId, row.ip_address).run();
      } catch (err) {
        console.warn(
          `[nexus] per-IP cluster upsert failed for ${row.ip_address}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.warn('[nexus] per-IP fan-out pass skipped:', err instanceof Error ? err.message : String(err));
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
        pivots_detected: pivotsDetected,
        app_store_clusters: appStoreClustersWritten,
        dark_web_clusters: darkWebClustersWritten,
      })
    ).run();
  } catch (err) {
    console.error('[nexus] completion event error:', err);
  }

  outputs.push({
    type: "diagnostic",
    summary: `NEXUS: ${clustersWritten} clusters written (${asnClusters.results.length} ASN groups analyzed, ${appStoreClustersWritten} app-store dev clusters, ${darkWebClustersWritten} dark-web actor clusters), ${providersUpdated} providers trend-updated, ${pivotsDetected} pivots detected`,
    severity: pivotsDetected > 0 ? "high" : "info",
    details: {
      clusters_written: clustersWritten,
      providers_updated: providersUpdated,
      pivots_detected: pivotsDetected,
      asn_clusters_analyzed: asnClusters.results.length,
      app_store_clusters: appStoreClustersWritten,
      dark_web_clusters: darkWebClustersWritten,
    },
  });

  return { clustersWritten, providersUpdated, pivotsDetected, outputs };
}

function generateClusterName(cluster: { countries?: string | null; threat_type?: string | null; asn?: string | null }): string {
  const country = cluster.countries?.split(',')?.[0] ?? 'Unknown';
  const type = cluster.threat_type?.replace(/_/g, ' ') ?? 'threat';
  const asnRaw = cluster.asn ?? '';
  const asn = asnRaw.replace(/^AS\d+\s*/, '').trim() || asnRaw;
  return `${country} ${asn} ${type} cluster`.trim();
}

// Sanitize a natural-key part for use inside a deterministic cluster
// id. Keeps lowercase alphanumerics + dashes; collapses everything
// else to underscores; bounds length to keep id strings reasonable.
function slugifyKey(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

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
  reads: [
    { kind: "d1_table", name: "app_store_listings" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "dark_web_mentions" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [
    { kind: "d1_table", name: "agent_events" },
    { kind: "d1_table", name: "agent_runs" },
    { kind: "d1_table", name: "infrastructure_clusters" },
    { kind: "d1_table", name: "threats" },
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
        pivots_detected: result.pivotsDetected,
      },
      agentOutputs: result.outputs,
    };
  },
};
