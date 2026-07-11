import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { Env } from '../types';
import { updateProviderTrends } from '../lib/provider-trends';

type NexusWorkflowParams = {
  forceRefresh?: boolean;
};

// Sanitize a natural-key part for use inside a deterministic cluster id.
// Kept in lockstep with the identical helper in agents/nexus.ts so the
// /24 + registrar lanes here upsert the same rows as the manual-fallback
// agent path. Keeps lowercase alphanumerics + dashes; collapses the rest
// to underscores; bounds length.
function slugifyKey(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

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

    // Step 1a-i: SSL cert-serial lane (2026-07 threat-intel spec) — the
    // MOST-specific lane, so it runs FIRST of the threats-stamping lanes.
    // One certificate serial reused across >= 2 impersonation domains is
    // near-conclusive same-operator evidence. Cluster on the serial ALONE
    // (never issuer — Let's Encrypt = every phishing domain, the ASN
    // over-merge trap). Kept in lockstep with agents/nexus.ts Lane C1.
    // Retry-idempotent: deterministic id + ON CONFLICT DO UPDATE + the
    // cluster_id IS NULL stamp. Pure SQL, no AI.
    const certSerialLane = await step.do('cert-serial-correlation', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const serialClusters = await this.env.DB.prepare(`
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

      let clustersWritten = 0;
      for (const row of serialClusters.results) {
        const clusterId = `cluster_cert_${slugifyKey(row.ssl_cert_serial)}`;
        const clusterName =
          `SSL cert ${row.ssl_cert_serial.slice(0, 24)} reuse (${row.brand_count} brands, ${row.domain_count} domains)`;
        const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
        const asns        = (row.asns       ?? '').split(',').filter(Boolean);
        const countries   = (row.countries  ?? '').split(',').filter(Boolean);
        const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
        const confidence = Math.min(100,
          80 + (row.brand_count >= 10 ? 20 : row.brand_count >= 5 ? 10 : 5),
        );

        try {
          await this.env.DB.prepare(`
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
            clusterId, clusterName,
            JSON.stringify(asns),
            JSON.stringify(countries),
            JSON.stringify(attackTypes),
            JSON.stringify(brandIds),
            JSON.stringify([]),
            JSON.stringify([]),
            row.threat_count, confidence,
            row.first_seen, row.last_seen,
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

          // MANDATORY stamp — predicate mirrors the SELECT filter exactly.
          await this.env.DB.prepare(
            `UPDATE threats SET cluster_id = ?
              WHERE ssl_cert_serial = ? AND status = 'active'
                AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
          ).bind(clusterId, row.ssl_cert_serial).run();
        } catch { continue; }
      }
      return { clustersWritten, serialsAnalyzed: serialClusters.results.length };
    });

    // Step 1a-ii: SSL SAN-set lane — runs after the serial lane so a
    // serial-identified cluster keeps its tighter grouping; this lane
    // mops up SAN-set matches (cross-source-consistent ssl_san_hash) the
    // serial lane didn't claim. Kept in lockstep with agents/nexus.ts
    // Lane C2. Same filters, floor, HIGH confidence. Pure SQL, no AI.
    const certSanLane = await step.do('cert-san-correlation', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const sanClusters = await this.env.DB.prepare(`
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

      let clustersWritten = 0;
      for (const row of sanClusters.results) {
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
          await this.env.DB.prepare(`
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
            clusterId, clusterName,
            JSON.stringify(asns),
            JSON.stringify(countries),
            JSON.stringify(attackTypes),
            JSON.stringify(brandIds),
            JSON.stringify([]),
            JSON.stringify([]),
            row.threat_count, confidence,
            row.first_seen, row.last_seen,
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

          // MANDATORY stamp — predicate mirrors the SELECT filter exactly.
          await this.env.DB.prepare(
            `UPDATE threats SET cluster_id = ?
              WHERE ssl_san_hash = ? AND status = 'active'
                AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
          ).bind(clusterId, row.ssl_san_hash).run();
        } catch { continue; }
      }
      return { clustersWritten, sanSetsAnalyzed: sanClusters.results.length };
    });

    // Step 1a-iii: Per-IP fan-out lane (PR-D from 2026-05-16 audit) —
    // runs AFTER the two cert lanes (a cert-identified cluster keeps its
    // tighter grouping) and BEFORE the /24 subnet lane. This is the slot
    // that was MISSING from the workflow: single hot IPs (one IP hitting
    // many brands) have distinct_ips == 1, so they fall through the /24
    // lane's distinct_ips >= 2 guard and would otherwise land in the coarse
    // ASN mop-up, losing the IP-pivot signal. Ported byte-for-byte from
    // agents/nexus.ts so the workflow upserts the same rows as the
    // manual-fallback agent path.
    //
    // Rule: same active IP across >= 5 active threats AND >= 3 distinct
    // brands ⇒ stable id `cluster_ip_<ip>`. Top 30 by threat_count per
    // cycle bounds the write budget. Confidence scales with brand fan-out
    // (diversity is the signal, not raw volume). Note the agent_notes here
    // is a plain human string (not the JSON blob the cert/subnet lanes
    // write) and the threats stamp intentionally omits the
    // target_brand_id predicate — both match the agent path exactly.
    // Retry-idempotent: deterministic id + ON CONFLICT DO UPDATE + the
    // cluster_id IS NULL stamp. Pure SQL, no AI.
    const perIpLane = await step.do('per-ip-correlation', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const ipFanout = await this.env.DB.prepare(`
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

      let clustersWritten = 0;
      for (const row of ipFanout.results) {
        const ipSafe = row.ip_address.replace(/[^0-9a-f.:]/gi, '');
        const clusterId = `cluster_ip_${ipSafe}`;
        const clusterName =
          `IP ${row.ip_address} mass-impersonation (${row.brand_count} brands, ${row.threat_count} threats)`;
        const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
        const asns        = (row.asns       ?? '').split(',').filter(Boolean);
        const countries   = (row.countries  ?? '').split(',').filter(Boolean);
        const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
        // Confidence scales with brand fan-out — diversity is the
        // signal here, not raw threat volume.
        const confidence = Math.min(100,
          (row.brand_count >= 100 ? 90 : row.brand_count >= 25 ? 75 : row.brand_count >= 10 ? 60 : 40),
        );

        try {
          await this.env.DB.prepare(`
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
            clusterId, clusterName,
            JSON.stringify(asns),
            JSON.stringify(countries),
            JSON.stringify(attackTypes),
            JSON.stringify(brandIds),
            JSON.stringify([]),
            JSON.stringify([]),
            row.threat_count, confidence,
            row.first_seen, row.last_seen,
            `Per-IP fan-out: ${row.ip_address} hosts threats against ${row.brand_count} brands across ${asns.length} ASNs. Mass-impersonation infrastructure.`,
          ).run();
          clustersWritten++;

          // MANDATORY stamp — mirrors the agent-path predicate exactly
          // (no target_brand_id filter here, unlike the cert/subnet lanes).
          await this.env.DB.prepare(
            `UPDATE threats SET cluster_id = ?
              WHERE ip_address = ? AND status = 'active' AND cluster_id IS NULL`,
          ).bind(clusterId, row.ip_address).run();
        } catch { continue; }
      }
      return { clustersWritten, ipsAnalyzed: ipFanout.results.length };
    });

    // Step 1b: /24 subnet lane (2026-07 threat-intel spec) — runs
    // BEFORE the ASN pass so the coarse ASN lane only mops up threats
    // no more-specific lane already claimed (cluster_id IS NULL guard).
    // Kept in lockstep with agents/nexus.ts Lane A. The /24 key lives on
    // the ip_subnet24 generated column (migration 0235) — index-backed via
    // idx_threats_subnet24 — so the grouping scan and the per-cluster stamp
    // seek no longer wrap the column in rtrim() and no longer full-scan the
    // threats table. CDN guard uses an ASN denylist literal set
    // (hosting_providers has no is_cdn column): Cloudflare AS13335, Fastly
    // AS54113, CloudFront AS16509, Akamai AS20940, Google AS15169. Pure SQL
    // grouping + bounded upserts, no AI.
    const subnetLane = await step.do('subnet24-correlation', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const subnetClusters = await this.env.DB.prepare(`
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

      let clustersWritten = 0;
      for (const row of subnetClusters.results) {
        // Over-merge guard: skip mega-groups outright rather than emit a
        // low-confidence blob (HAVING already caps at 150).
        if (row.brand_count > 150) continue;

        const clusterId = `cluster_subnet_${slugifyKey(row.subnet24)}`;
        const clusterName =
          `Subnet ${row.subnet24}0/24 (${row.brand_count} brands, ${row.distinct_ips} IPs, ${row.threat_count} threats)`;
        const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
        const asns        = (row.asns       ?? '').split(',').filter(Boolean);
        const countries   = (row.countries  ?? '').split(',').filter(Boolean);
        const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
        const confidence = Math.min(100,
          (row.brand_count >= 100 ? 75 : row.brand_count >= 25 ? 60 : row.brand_count >= 10 ? 45 : 30),
        );

        try {
          await this.env.DB.prepare(`
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
            clusterId, clusterName,
            JSON.stringify(asns),
            JSON.stringify(countries),
            JSON.stringify(attackTypes),
            JSON.stringify(brandIds),
            JSON.stringify([]),
            JSON.stringify([]),
            row.threat_count, confidence,
            row.first_seen, row.last_seen,
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

          // MANDATORY stamp — only claims threats not already owned.
          // Keys on ip_subnet24 (index equality seek, migration 0235).
          await this.env.DB.prepare(
            `UPDATE threats SET cluster_id = ?
              WHERE ip_subnet24 = ? AND status = 'active'
                AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
          ).bind(clusterId, row.subnet24).run();
        } catch { continue; }
      }
      return { clustersWritten, subnetsAnalyzed: subnetClusters.results.length };
    });

    // Step 1c: registrar temporal-cohort lane (2026-07 spec) — HIGHEST
    // over-merge risk, so guards are mandatory: 14-day cohort +
    // mega-registrar denylist + brand_count cap + concentration check.
    // Written ASNs are truncated to the top entry so a loose cohort
    // never trips the Attributor's asns.length>=3 auto-Haiku gate.
    // Runs before the ASN pass. Kept in lockstep with agents/nexus.ts
    // Lane B. Pure SQL, no AI.
    const registrarLane = await step.do('registrar-correlation', { retries: { limit: 2, delay: '5 seconds' } }, async () => {
      const registrarClusters = await this.env.DB.prepare(`
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

      let clustersWritten = 0;
      for (const row of registrarClusters.results) {
        // Over-merge + concentration guards: skip mega-cohorts and
        // cohorts smeared across many subnets.
        if (row.brand_count > 60) continue;
        if (row.distinct_subnets > 5) continue;

        const clusterId = `cluster_registrar_${slugifyKey(row.registrar)}`;
        const clusterName =
          `Registrar cohort "${row.registrar}" (${row.brand_count} brands, ${row.threat_count} threats, 14d)`;
        const brandIds    = (row.brand_ids  ?? '').split(',').filter(Boolean);
        const asnsAll     = (row.asns       ?? '').split(',').filter(Boolean);
        const countries   = (row.countries  ?? '').split(',').filter(Boolean);
        const attackTypes = (row.attack_types ?? '').split(',').filter(Boolean);
        // Attributor-cost guard: truncate written ASNs to the top entry.
        const asnsWritten = asnsAll.slice(0, 1);
        const confidence = Math.min(50,
          (row.brand_count >= 25 ? 45 : row.brand_count >= 10 ? 35 : 25),
        );

        try {
          await this.env.DB.prepare(`
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
            clusterId, clusterName,
            JSON.stringify(asnsWritten),
            JSON.stringify(countries),
            JSON.stringify(attackTypes),
            JSON.stringify(brandIds),
            JSON.stringify([]),
            JSON.stringify([]),
            row.threat_count, confidence,
            row.first_seen, row.last_seen,
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

          // MANDATORY stamp within the same 14-day window.
          await this.env.DB.prepare(
            `UPDATE threats SET cluster_id = ?
              WHERE registrar = ? AND status = 'active'
                AND target_brand_id IS NOT NULL
                AND first_seen >= datetime('now','-14 days') AND cluster_id IS NULL`,
          ).bind(clusterId, row.registrar).run();
        } catch { continue; }
      }
      return { clustersWritten, registrarsAnalyzed: registrarClusters.results.length };
    });

    // Step 2: Run ASN correlation — the core NEXUS query (RUNS LAST of
    // the threats-stamping lanes; keeps `cluster_id IS NULL` so it only
    // mops up threats the /24 + registrar lanes above didn't claim).
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
      //
      // Delegates to lib/provider-trends.ts which adds a diff-filter
      // step: read current trend_7d/trend_30d and skip the UPDATE
      // when the values match. Halved the per-tick UPDATE count in
      // the 2026-05-20 write-budget audit.
      const result = await updateProviderTrends(this.env.DB);
      return { providers_updated: result.providers_updated };
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
        `NEXUS complete — ${totalClustersWritten} clusters written (${certSerialLane.clustersWritten} cert-serial, ${certSanLane.clustersWritten} cert-SAN, ${perIpLane.clustersWritten} per-IP, ${correlation.clustersWritten} ASN, ${subnetLane.clustersWritten} /24, ${registrarLane.clustersWritten} registrar), ${correlation.pivotsDetected} pivots, ${providers.providers_updated} providers updated`,
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
