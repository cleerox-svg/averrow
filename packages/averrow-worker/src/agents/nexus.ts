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

// ─── NEXUS core correlation logic ─────────────────────────────────

export async function runNexus(db: D1Database, env: Env): Promise<{
  clustersWritten: number;
  providersUpdated: number;
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

  // ══ Threats-table lanes, most-specific first ══════════════════════
  // The six passes below all stamp threats.cluster_id with the
  // `cluster_id IS NULL` guard, so RUN ORDER is precedence: whichever
  // lane claims a threat first owns it. Order is deliberately:
  //   cert-serial → cert-SAN → per-IP fan-out → /24 subnet →
  //   registrar cohort → ASN (last).
  // Keep it that way. The cert lanes are the MOST specific (a shared
  // certificate identity is near-conclusive same-operator evidence), so
  // they run FIRST and the coarser lanes only mop up what's left.

  // --- Lane C1: SSL cert-serial clustering (2026-07 threat-intel spec) ---
  //
  // One certificate serial reused across >= 2 impersonation domains is
  // among the strongest same-operator signals there is — a serial is
  // minted per issuance, so reuse means the same requester. Cluster on
  // the serial ALONE (never on issuer: Let's Encrypt issues to every
  // phishing domain on earth — that is the ASN over-merge trap reborn).
  //
  // Filter mirrors lanes A/B: active + non-null/non-empty key +
  // target_brand_id NOT NULL (so threat_count parity + brand fan-out are
  // consistent). HAVING floor is >= 2 distinct malicious_domain. No
  // upper over-merge cap — a serial genuinely reused across 500 domains
  // IS one operator, so we keep every qualifying group. Pure SQL, no AI.
  // Runs FIRST so the stamp claims these before any coarser lane.
  try {
    const certSerialClusters = await db.prepare(`
      SELECT ssl_cert_serial,
             COUNT(*)                               AS threat_count,
             COUNT(DISTINCT malicious_domain)       AS domain_count,
             COUNT(DISTINCT target_brand_id)        AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT asn)             AS asns,
             GROUP_CONCAT(DISTINCT country_code)    AS countries,
             GROUP_CONCAT(DISTINCT threat_type)     AS attack_types,
             MAX(ssl_cert_issuer)                   AS issuer,
             MIN(first_seen)                        AS first_seen,
             MAX(first_seen)                        AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ssl_cert_serial IS NOT NULL
         AND ssl_cert_serial != ''
         AND target_brand_id IS NOT NULL
       GROUP BY ssl_cert_serial
      HAVING COUNT(DISTINCT malicious_domain) >= 2
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 50
    `).all<{
      ssl_cert_serial: string;
      threat_count: number;
      domain_count: number;
      brand_count: number;
      brand_ids: string | null;
      asns: string | null;
      countries: string | null;
      attack_types: string | null;
      issuer: string | null;
      first_seen: string;
      last_seen: string;
    }>();

    for (const row of certSerialClusters.results) {
      const clusterId = `cluster_cert_${slugifyKey(row.ssl_cert_serial)}`;
      const clusterName =
        `SSL cert ${row.ssl_cert_serial.slice(0, 24)} reuse (${row.brand_count} brands, ${row.domain_count} domains)`;
      const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
      const asns        = (row.asns       ?? '').split(',').filter(Boolean);
      const countries   = (row.countries  ?? '').split(',').filter(Boolean);
      const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
      // HIGH confidence: serial reuse is a top-tier infra signal. 80 base
      // + brand fan-out bonus, capped 100. No upper cap on group size.
      const confidence = Math.min(100,
        80 + (row.brand_count >= 10 ? 20 : row.brand_count >= 5 ? 10 : 5),
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
          JSON.stringify({
            cluster_type: 'ssl_cert_serial',
            ssl_cert_serial: row.ssl_cert_serial,
            ssl_cert_issuer: row.issuer,
            brands_targeted: row.brand_count,
            domains_count: row.domain_count,
            threats_count: row.threat_count,
          }),
        ).run();
        clustersWritten++;

        // MANDATORY member stamp — predicate MIRRORS the SELECT filter
        // exactly (the parity bug caught in lanes A/B). cluster_id IS NULL
        // means coarser lanes only claim what this lane leaves behind.
        await db.prepare(
          `UPDATE threats SET cluster_id = ?
            WHERE ssl_cert_serial = ? AND status = 'active'
              AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
        ).bind(clusterId, row.ssl_cert_serial).run();
      } catch (err) {
        console.warn(
          `[nexus] cert-serial cluster upsert failed for ${row.ssl_cert_serial}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.warn('[nexus] cert-serial pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // --- Lane C2: SSL SAN-set clustering (2026-07 threat-intel spec) ---
  //
  // One SAN set (hashed cross-source-consistently at ingest into
  // ssl_san_hash) reused across >= 2 impersonation domains means the same
  // cert template was minted for multiple domains — same operator. Runs
  // AFTER the serial pass so a serial-identified cluster keeps its tighter
  // grouping; this lane mops up SAN-set matches the serial pass didn't
  // claim (cluster_id IS NULL stamp guard). Same filters, floor, and HIGH
  // confidence as C1. Pure SQL, no AI.
  try {
    const certSanClusters = await db.prepare(`
      SELECT ssl_san_hash,
             COUNT(*)                               AS threat_count,
             COUNT(DISTINCT malicious_domain)       AS domain_count,
             COUNT(DISTINCT target_brand_id)        AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT asn)             AS asns,
             GROUP_CONCAT(DISTINCT country_code)    AS countries,
             GROUP_CONCAT(DISTINCT threat_type)     AS attack_types,
             MAX(ssl_cert_issuer)                   AS issuer,
             MIN(first_seen)                        AS first_seen,
             MAX(first_seen)                        AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ssl_san_hash IS NOT NULL
         AND ssl_san_hash != ''
         AND target_brand_id IS NOT NULL
       GROUP BY ssl_san_hash
      HAVING COUNT(DISTINCT malicious_domain) >= 2
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 50
    `).all<{
      ssl_san_hash: string;
      threat_count: number;
      domain_count: number;
      brand_count: number;
      brand_ids: string | null;
      asns: string | null;
      countries: string | null;
      attack_types: string | null;
      issuer: string | null;
      first_seen: string;
      last_seen: string;
    }>();

    for (const row of certSanClusters.results) {
      const clusterId = `cluster_cert_${slugifyKey(row.ssl_san_hash)}`;
      const clusterName =
        `SSL SAN-set ${row.ssl_san_hash.slice(0, 12)} reuse (${row.brand_count} brands, ${row.domain_count} domains)`;
      const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
      const asns        = (row.asns       ?? '').split(',').filter(Boolean);
      const countries   = (row.countries  ?? '').split(',').filter(Boolean);
      const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
      const confidence = Math.min(100,
        80 + (row.brand_count >= 10 ? 20 : row.brand_count >= 5 ? 10 : 5),
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
          JSON.stringify({
            cluster_type: 'ssl_san_hash',
            ssl_san_hash: row.ssl_san_hash,
            ssl_cert_issuer: row.issuer,
            brands_targeted: row.brand_count,
            domains_count: row.domain_count,
            threats_count: row.threat_count,
          }),
        ).run();
        clustersWritten++;

        // MANDATORY member stamp — predicate MIRRORS the SELECT filter.
        await db.prepare(
          `UPDATE threats SET cluster_id = ?
            WHERE ssl_san_hash = ? AND status = 'active'
              AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
        ).bind(clusterId, row.ssl_san_hash).run();
      } catch (err) {
        console.warn(
          `[nexus] cert-SAN cluster upsert failed for ${row.ssl_san_hash}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.warn('[nexus] cert-SAN pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // --- Lane: Per-IP fan-out clustering (PR-D from 2026-05-16 audit) ---
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

  // --- Lane A: /24 subnet clustering (2026-07 threat-intel spec) ---
  //
  // Groups active threats by their IPv4 /24 prefix. The prefix key lives
  // on the ip_subnet24 generated column (migration 0235), which reproduces
  // the historical rtrim(ip_address,'0123456789') derivation for qualifying
  // IPv4 rows — e.g. "76.223.54.146" → "76.223.54." — and is NULL for
  // NULL / IPv6 / '' / '0.0.0.0'. Catches actors who spread mass-
  // impersonation across a contiguous block of IPs in one subnet — a
  // signal the per-IP lane (single IP) and the ASN lane (whole provider)
  // both miss. Runs AFTER per-IP so a single hot IP keeps its own tighter
  // cluster; this lane mops up the rest of the /24 via the
  // `cluster_id IS NULL` stamping guard.
  //
  // ip_subnet24 is index-backed (idx_threats_subnet24, partial on
  // IS NOT NULL). The grouping scan rides the index and the per-cluster
  // stamp below is an equality seek instead of the former full-table
  // scan — the perf point of migration 0235.
  //
  // CDN guard: hosting_providers has NO is_cdn column, so we exclude the
  // well-known CDN/cloud ASNs by literal (Cloudflare AS13335, Fastly
  // AS54113, CloudFront AS16509, Akamai AS20940, Google AS15169) — a /24
  // on a shared CDN is co-tenancy noise, not one operator's campaign.
  //
  // Guards: distinct_ips >= 2 distinguishes this from the per-IP lane;
  // brand_count <= 150 is the over-merge guard — a group that big is
  // skipped entirely rather than emitted as a low-confidence blob (that
  // just re-pollutes the Attributor queue — the ASN-coarseness lesson).
  // Bounded: one GROUP BY scan + <=50 upserts. No AI.
  try {
    const subnetClusters = await db.prepare(`
      SELECT ip_subnet24                         AS subnet24,
             COUNT(*)                            AS threat_count,
             COUNT(DISTINCT ip_address)          AS distinct_ips,
             COUNT(DISTINCT target_brand_id)     AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT asn)          AS asns,
             GROUP_CONCAT(DISTINCT country_code) AS countries,
             GROUP_CONCAT(DISTINCT threat_type)  AS attack_types,
             MIN(first_seen)                     AS first_seen,
             MAX(first_seen)                     AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ip_subnet24 IS NOT NULL
         AND target_brand_id IS NOT NULL
         AND (asn IS NULL OR asn NOT IN ('AS13335','AS54113','AS16509','AS20940','AS15169'))
       GROUP BY ip_subnet24
      HAVING distinct_ips >= 2 AND brand_count >= 3 AND threat_count >= 8 AND brand_count <= 150
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 50
    `).all<{
      subnet24: string;
      threat_count: number;
      distinct_ips: number;
      brand_count: number;
      brand_ids: string | null;
      asns: string | null;
      countries: string | null;
      attack_types: string | null;
      first_seen: string;
      last_seen: string;
    }>();

    for (const row of subnetClusters.results) {
      // Global over-merge guard: skip mega-groups outright (HAVING
      // already caps at 150; belt-and-braces for clarity).
      if (row.brand_count > 150) continue;

      const clusterId = `cluster_subnet_${slugifyKey(row.subnet24)}`;
      const clusterName =
        `Subnet ${row.subnet24}0/24 (${row.brand_count} brands, ${row.distinct_ips} IPs, ${row.threat_count} threats)`;
      const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
      const asns        = (row.asns       ?? '').split(',').filter(Boolean);
      const countries   = (row.countries  ?? '').split(',').filter(Boolean);
      const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
      // Confidence scales on brand fan-out like the per-IP lane but one
      // notch lower — a /24 is looser evidence than a single shared IP.
      const confidence = Math.min(100,
        (row.brand_count >= 100 ? 75 : row.brand_count >= 25 ? 60 : row.brand_count >= 10 ? 45 : 30),
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
          JSON.stringify({
            cluster_type: 'subnet_24',
            subnet24: row.subnet24,
            distinct_ips: row.distinct_ips,
            brands_targeted: row.brand_count,
            threats_count: row.threat_count,
            asn_count: asns.length,
          }),
        ).run();
        clustersWritten++;

        // MANDATORY: stamp members so the Attributor produces
        // attributions. Only claims threats not already owned by the
        // per-IP lane (cluster_id IS NULL). Keys on the same ip_subnet24
        // generated column the grouping used, so the stamp key matches the
        // group key exactly — but now as an index equality seek instead of
        // a full-table scan (migration 0235).
        await db.prepare(
          `UPDATE threats SET cluster_id = ?
            WHERE ip_subnet24 = ? AND status = 'active'
              AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
        ).bind(clusterId, row.subnet24).run();
      } catch (err) {
        console.warn(
          `[nexus] /24 subnet cluster upsert failed for ${row.subnet24}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.warn('[nexus] /24 subnet pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // --- Lane B: registrar temporal-cohort clustering (2026-07 spec) ---
  //
  // HIGHEST over-merge risk — registrar ALONE must NEVER be a cluster
  // key (it's the ASN-coarseness trap reborn: "GoDaddy" is not a
  // campaign). Guards are mandatory, not optional:
  //   (1) 14-day temporal cohort — only cluster domains registered in
  //       the same burst;
  //   (2) mega-registrar denylist — the commodity registrars everyone
  //       uses carry no signal;
  //   (3) brand_count cap of 60 (over-merge guard — skip, don't emit);
  //   (4) concentration check — a cohort smeared across many /24s is
  //       noise, so skip when distinct_subnets > 5.
  //
  // Attributor-cost guard: a registrar cohort spanning >=3 ASNs would
  // trip the Attributor's asns.length>=3 auto-Haiku gate
  // (agents/attributor.ts:92). We TRUNCATE the written asns array to its
  // single top entry so a loose registrar cluster never spends a Haiku
  // call. Confidence is capped low (<=50) — corroborating evidence, not
  // a primary signal. Bounded: one GROUP BY scan + <=25 upserts. No AI.
  try {
    const registrarClusters = await db.prepare(`
      SELECT registrar,
             COUNT(*)                            AS threat_count,
             COUNT(DISTINCT target_brand_id)     AS brand_count,
             COUNT(DISTINCT rtrim(ip_address,'0123456789')) AS distinct_subnets,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT asn)          AS asns,
             GROUP_CONCAT(DISTINCT country_code) AS countries,
             GROUP_CONCAT(DISTINCT threat_type)  AS attack_types,
             MIN(first_seen)                     AS first_seen,
             MAX(first_seen)                     AS last_seen
        FROM threats
       WHERE status = 'active'
         AND registrar IS NOT NULL
         AND target_brand_id IS NOT NULL
         AND first_seen >= datetime('now','-14 days')
         AND lower(registrar) NOT IN ('godaddy.com, llc','namecheap, inc.','tucows domains inc.','google llc',
             'cloudflare, inc.','network solutions, llc','name.com, inc.','gname.com pte. ltd.','publicdomainregistry.com')
       GROUP BY registrar
      HAVING threat_count >= 8 AND brand_count >= 3 AND brand_count <= 60
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 25
    `).all<{
      registrar: string;
      threat_count: number;
      brand_count: number;
      distinct_subnets: number;
      brand_ids: string | null;
      asns: string | null;
      countries: string | null;
      attack_types: string | null;
      first_seen: string;
      last_seen: string;
    }>();

    for (const row of registrarClusters.results) {
      // Global over-merge guard (HAVING already caps brand_count at 60)
      // + concentration check: a cohort spread across many subnets is
      // noise, not one operation — skip entirely.
      if (row.brand_count > 60) continue;
      if (row.distinct_subnets > 5) continue;

      const clusterId = `cluster_registrar_${slugifyKey(row.registrar)}`;
      const clusterName =
        `Registrar cohort "${row.registrar}" (${row.brand_count} brands, ${row.threat_count} threats, 14d)`;
      const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
      const asnsAll     = (row.asns       ?? '').split(',').filter(Boolean);
      const countries   = (row.countries  ?? '').split(',').filter(Boolean);
      const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
      // Attributor-cost guard: truncate WRITTEN ASNs to the top entry so
      // this lane can never trip the asns.length>=3 auto-Haiku gate.
      const asnsWritten = asnsAll.slice(0, 1);
      // Confidence capped low — corroborating evidence, not primary.
      const confidence = Math.min(50,
        (row.brand_count >= 25 ? 45 : row.brand_count >= 10 ? 35 : 25),
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
          JSON.stringify(asnsWritten),
          JSON.stringify(countries),
          JSON.stringify(attackTypes),
          JSON.stringify(brandIds),
          JSON.stringify([]),
          JSON.stringify([]),
          row.threat_count,
          confidence,
          row.first_seen,
          row.last_seen,
          JSON.stringify({
            cluster_type: 'registrar_cohort',
            registrar: row.registrar,
            brands_targeted: row.brand_count,
            threats_count: row.threat_count,
            distinct_subnets: row.distinct_subnets,
            asn_count_observed: asnsAll.length,
            window_days: 14,
          }),
        ).run();
        clustersWritten++;

        // MANDATORY: stamp members within the same 14-day window so the
        // Attributor produces attributions. cluster_id IS NULL means it
        // only claims threats not already owned by a more-specific lane.
        await db.prepare(
          `UPDATE threats SET cluster_id = ?
            WHERE registrar = ? AND status = 'active'
              AND target_brand_id IS NOT NULL
              AND first_seen >= datetime('now','-14 days') AND cluster_id IS NULL`,
        ).bind(clusterId, row.registrar).run();
      } catch (err) {
        console.warn(
          `[nexus] registrar cluster upsert failed for ${row.registrar}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    console.warn('[nexus] registrar pass skipped:', err instanceof Error ? err.message : String(err));
  }

  // --- Lane: ASN + threat_type clustering (RUNS LAST — mops up) ---
  //
  // The oldest lane, deliberately executed AFTER the per-IP, /24, and
  // registrar lanes. Its stamping keeps `AND cluster_id IS NULL`, so it
  // only claims threats no more-specific lane already owns. This is the
  // coarsest key (whole provider), hence lowest precedence.
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

    // Update threats with cluster_id — mops up only threats not already
    // claimed by the more-specific per-IP / /24 / registrar lanes.
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
          JSON.stringify({ kind: 'dormancy', cluster_id: clusterId, asn: cluster.asn, cluster_name: clusterName })
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
    summary: `NEXUS: ${clustersWritten} clusters written (${asnClusters.results.length} ASN groups analyzed, ${appStoreClustersWritten} app-store dev clusters, ${darkWebClustersWritten} dark-web actor clusters), ${providersUpdated} providers trend-updated, ${pivotsDetected} dormancy pivots, ${infraMovementPivots} infra-movement pivots`,
    severity: pivotsDetected > 0 || infraMovementPivots > 0 ? "high" : "info",
    details: {
      clusters_written: clustersWritten,
      providers_updated: providersUpdated,
      pivots_detected: pivotsDetected,
      infra_movement_pivots: infraMovementPivots,
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
