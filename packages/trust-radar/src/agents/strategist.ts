/**
 * Strategist Agent — Campaign correlation & clustering intelligence.
 *
 * Runs every 6 hours. Identifies threat campaigns by correlating
 * shared infrastructure (IPs, ASNs, registrars, timing patterns).
 * Creates/updates campaign records in the campaigns table.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { generateCampaignName, checkCostGuard } from "../lib/haiku";
import { createNotification } from "../lib/notifications";
import { evaluateCampaignSignificance } from "../lib/campaign-significance";
import { createBrandAlertsForCampaign } from "../lib/alert-fanout";

export const strategistAgent: AgentModule = {
  name: "strategist",
  displayName: "Strategist",
  description: "Campaign correlation & clustering intelligence",
  color: "#8A8F9C",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 480,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 5_000_000 },
  reads: [
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "campaigns" },
    { kind: "d1_table", name: "hosting_providers" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [
    { kind: "d1_table", name: "agent_outputs" },
    { kind: "d1_table", name: "campaigns" },
    { kind: "d1_table", name: "threats" },
  ],
  outputs: [{ type: "correlation" }, { type: "diagnostic" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 8,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;
    const callCtx = { agentId: "strategist", runId };

    // Cost guard: strategist naming is non-critical
    const blocked = await checkCostGuard(env, false);
    if (blocked) {
      console.warn(`[strategist] ${blocked}`);
      return { itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, output: { skipped: true, reason: blocked } };
    }

    let itemsProcessed = 0;
    let itemsCreated = 0;
    let itemsUpdated = 0;
    const outputs: AgentOutputEntry[] = [];

    // ─── Strategy 1: IP-based clustering ────────────────────────
    // Find IPs hosting 3+ active threats (likely infrastructure)
    const ipClusters = await env.DB.prepare(
      `SELECT ip_address, COUNT(*) as threat_count,
              GROUP_CONCAT(DISTINCT source_feed) as sources,
              GROUP_CONCAT(DISTINCT threat_type) as types
       FROM threats
       WHERE ip_address IS NOT NULL AND status = 'active' AND campaign_id IS NULL
       GROUP BY ip_address
       HAVING COUNT(*) >= 3
       ORDER BY threat_count DESC LIMIT 20`
    ).all<{
      ip_address: string; threat_count: number;
      sources: string; types: string;
    }>();

    // ── Pre-batch context for all IP clusters ──────────────────────
    // Fetch domains, brands, and providers for all cluster IPs in 3 queries
    // instead of 3 queries × N clusters inside the loop.
    const allClusterIps = ipClusters.results.map(c => c.ip_address);
    const ipPlaceholders = allClusterIps.map(() => '?').join(',');

    // Initialize maps empty; only populate when there are IPs to query.
    // Avoids type-assertion hacks: maps remain empty [] on zero-IP runs.
    const ipDomainsMap = new Map<string, string[]>();
    const ipBrandsMap = new Map<string, string[]>();
    const ipProvidersMap = new Map<string, string[]>();

    if (allClusterIps.length > 0) {
      const [domainsRes, brandsRes, providersRes] = await Promise.all([
        env.DB.prepare(
          `SELECT ip_address, malicious_domain FROM threats
           WHERE ip_address IN (${ipPlaceholders}) AND status = 'active' AND malicious_domain IS NOT NULL
           GROUP BY ip_address, malicious_domain`
        ).bind(...allClusterIps).all<{ ip_address: string; malicious_domain: string }>(),
        env.DB.prepare(
          `SELECT DISTINCT t.ip_address, b.name FROM threats t
           JOIN brands b ON b.id = t.target_brand_id
           WHERE t.ip_address IN (${ipPlaceholders}) AND t.status = 'active'`
        ).bind(...allClusterIps).all<{ ip_address: string; name: string }>(),
        env.DB.prepare(
          `SELECT DISTINCT t.ip_address, COALESCE(hp.name, t.hosting_provider_id) AS name
           FROM threats t LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
           WHERE t.ip_address IN (${ipPlaceholders}) AND t.hosting_provider_id IS NOT NULL`
        ).bind(...allClusterIps).all<{ ip_address: string; name: string }>(),
      ]);

      for (const r of domainsRes.results) {
        const arr = ipDomainsMap.get(r.ip_address) ?? [];
        arr.push(r.malicious_domain);
        ipDomainsMap.set(r.ip_address, arr);
      }
      for (const r of brandsRes.results) {
        const arr = ipBrandsMap.get(r.ip_address) ?? [];
        arr.push(r.name);
        ipBrandsMap.set(r.ip_address, arr);
      }
      for (const r of providersRes.results) {
        const arr = ipProvidersMap.get(r.ip_address) ?? [];
        arr.push(r.name);
        ipProvidersMap.set(r.ip_address, arr);
      }
    }

    for (const cluster of ipClusters.results) {
      itemsProcessed++;

      // Check if a campaign already exists for this IP
      const existing = await env.DB.prepare(
        `SELECT id FROM campaigns WHERE attack_pattern LIKE ?`
      ).bind(`%${cluster.ip_address}%`).first<{ id: string }>();

      let campaignId: string;

      if (existing) {
        campaignId = existing.id;
        // Get old count before update
        const oldCount = await env.DB.prepare(
          `SELECT threat_count FROM campaigns WHERE id = ?`
        ).bind(campaignId).first<{ threat_count: number }>();
        // Update existing campaign
        await env.DB.prepare(
          `UPDATE campaigns SET
             last_seen = datetime('now'),
             threat_count = (SELECT COUNT(*) FROM threats WHERE campaign_id = ?),
             status = 'active'
           WHERE id = ?`
        ).bind(campaignId, campaignId).run();
        itemsUpdated++;
        // Get new count and notify on escalation
        const newCount = await env.DB.prepare(
          `SELECT name, threat_count FROM campaigns WHERE id = ?`
        ).bind(campaignId).first<{ name: string; threat_count: number }>();
        const addedThreats = (newCount?.threat_count ?? 0) - (oldCount?.threat_count ?? 0);
        if (addedThreats > 0 && newCount) {
          try {
            await createNotification(env, {
              // N1: explicit super_admin audience — campaign escalation is
              // intelligence the operator acts on, not tenant brand business.
              audience: 'super_admin',
              type: 'campaign_escalation',
              severity: 'medium',
              title: `Campaign growing: ${newCount.name}`,
              message: `${addedThreats} new threats added to campaign`,
              link: `/campaigns/${campaignId}`,
              metadata: { campaign_id: campaignId },
            });
          } catch (e) {
            console.error(`[strategist] escalation notification error:`, e);
          }

          // NX4: re-check significance on escalation. The "spike" branch
          // is the relevant one here — a campaign that just 3x'd is the
          // canonical "growing fast" signal we want to surface to the
          // affected tenants. Volume + wide-net branches re-trigger when
          // already-significant campaigns add more threats; the fanout
          // helper is idempotent so re-firing is safe.
          try {
            const tcAgoRow = await env.DB.prepare(
              `SELECT COUNT(*) AS n FROM threats
                WHERE campaign_id = ?
                  AND created_at < datetime('now', '-24 hours')`
            ).bind(campaignId).first<{ n: number }>();
            const bcRow = await env.DB.prepare(
              `SELECT brand_count_at_first_detection AS n FROM campaigns WHERE id = ?`
            ).bind(campaignId).first<{ n: number }>();
            const sigEsc = evaluateCampaignSignificance({
              threat_count: newCount.threat_count,
              threat_count_24h_ago: tcAgoRow?.n ?? 0,
              brand_count_at_first_detection: bcRow?.n ?? 0,
            });
            if (sigEsc.significant) {
              await createBrandAlertsForCampaign(env, {
                campaign_id: campaignId,
                campaign_name: newCount.name,
                threat_count: newCount.threat_count,
                reasons: sigEsc.reasons,
              });
            }
          } catch (e) {
            console.error(`[strategist] escalation fanout error:`, e);
          }
        }
      } else {
        // Create new campaign — use pre-fetched context maps (no per-IP DB calls)
        campaignId = crypto.randomUUID();
        const fallbackName = `IP-cluster-${cluster.ip_address.replace(/\./g, "-")}`;

        const campDomainsList = (ipDomainsMap.get(cluster.ip_address) ?? []).slice(0, 10);
        const campBrandsList  = (ipBrandsMap.get(cluster.ip_address) ?? []).slice(0, 5);
        const campProvidersList = (ipProvidersMap.get(cluster.ip_address) ?? []).slice(0, 3);

        // Generate AI name at creation time (fall back to technical ID if Haiku fails)
        let name = fallbackName;
        const nameResult = await generateCampaignName(env, callCtx, {
          domains: campDomainsList,
          target_brands: campBrandsList,
          threat_types: cluster.types ? cluster.types.split(",") : [],
          providers: campProvidersList,
          threat_count: cluster.threat_count,
          ip_count: 1,
        });
        if (nameResult.success && nameResult.data?.name) {
          name = nameResult.data.name;
        }

        // NX4: snapshot brand_count_at_first_detection for the
        // significance rule. Counts distinct brands among threats sharing
        // this campaign's IP — same scope as the upcoming threats-table
        // assignment a few lines below.
        const brandCountRow = await env.DB.prepare(`
          SELECT COUNT(DISTINCT target_brand_id) AS n
            FROM threats
           WHERE ip_address = ?
             AND target_brand_id IS NOT NULL
             AND status = 'active'
        `).bind(cluster.ip_address).first<{ n: number }>();
        const brandCountAtFirst = brandCountRow?.n ?? 0;

        // description stores the technical ID; name gets the AI name (or fallback)
        await env.DB.prepare(
          `INSERT INTO campaigns (id, name, description, threat_count, attack_pattern, status, brand_count_at_first_detection)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`
        ).bind(
          campaignId, name, fallbackName, cluster.threat_count,
          JSON.stringify({
            type: "shared_ip",
            ip: cluster.ip_address,
            sources: cluster.sources,
            threat_types: cluster.types,
          }),
          brandCountAtFirst,
        ).run();
        itemsCreated++;

        outputs.push({
          type: "correlation",
          summary: `New campaign detected: "${name}" — ${cluster.threat_count} threats sharing IP ${cluster.ip_address}`,
          severity: cluster.threat_count >= 10 ? "high" : "medium",
          details: {
            ip: cluster.ip_address,
            threat_count: cluster.threat_count,
            sources: cluster.sources.split(","),
            ai_name: name,
          },
        });

        // Notify: new campaign identified
        try {
          await createNotification(env, {
            // N1: explicit super_admin audience — "new campaign identified"
            // is intel for the operator. NX4 fans out per-brand tenant
            // alerts when the campaign passes the significance threshold.
            audience: 'super_admin',
            type: 'agent_milestone',
            severity: 'medium',
            title: 'New campaign identified',
            message: `Strategist found: ${name}`,
            link: `/campaigns/${campaignId}`,
            metadata: { campaign_id: campaignId },
          });
        } catch (e) {
          console.error(`[strategist] notification error:`, e);
        }

        // NX4: tenant fan-out. New campaigns can be significant on
        // first detection via the "wide net" branch (>=10 brands) or
        // the volume branch (>=20 threats). Spike branch is moot here
        // (no 24h-ago baseline at creation). Fanout helper is itself
        // tier-gated + idempotent — safe to call unconditionally past
        // the significance check.
        const sigNew = evaluateCampaignSignificance({
          threat_count: cluster.threat_count,
          threat_count_24h_ago: 0,
          brand_count_at_first_detection: brandCountAtFirst,
        });
        if (sigNew.significant) {
          try {
            await createBrandAlertsForCampaign(env, {
              campaign_id: campaignId,
              campaign_name: name,
              threat_count: cluster.threat_count,
              reasons: sigNew.reasons,
            });
          } catch (e) {
            console.error('[strategist] campaign fanout error:', e);
          }
        }
      }

      // Assign unlinked threats to this campaign
      await env.DB.prepare(
        `UPDATE threats SET campaign_id = ?
         WHERE ip_address = ? AND campaign_id IS NULL AND status = 'active'`
      ).bind(campaignId, cluster.ip_address).run();
    }

    // ─── Strategy 2: Domain-pattern clustering ──────────────────
    // Find domains with similar patterns (same registrar + recent creation)
    const registrarClusters = await env.DB.prepare(
      `SELECT registrar, COUNT(*) as threat_count
       FROM threats
       WHERE registrar IS NOT NULL AND status = 'active' AND campaign_id IS NULL
         AND created_at >= datetime('now', '-7 days')
       GROUP BY registrar
       HAVING COUNT(*) >= 5
       ORDER BY threat_count DESC LIMIT 10`
    ).all<{ registrar: string; threat_count: number }>();

    // ── Pre-batch context for all registrar clusters ───────────────
    const allRegistrars = registrarClusters.results.map(c => c.registrar);
    const regPlaceholders = allRegistrars.map(() => '?').join(',');

    const regDomainsMap = new Map<string, string[]>();
    const regBrandsMap = new Map<string, string[]>();

    if (allRegistrars.length > 0) {
      const [regDomainsRes, regBrandsRes] = await Promise.all([
        env.DB.prepare(
          `SELECT DISTINCT registrar, malicious_domain FROM threats
           WHERE registrar IN (${regPlaceholders}) AND status = 'active' AND malicious_domain IS NOT NULL
             AND created_at >= datetime('now', '-7 days')`
        ).bind(...allRegistrars).all<{ registrar: string; malicious_domain: string }>(),
        env.DB.prepare(
          `SELECT DISTINCT t.registrar, b.name FROM threats t
           JOIN brands b ON b.id = t.target_brand_id
           WHERE t.registrar IN (${regPlaceholders}) AND t.status = 'active'
             AND t.created_at >= datetime('now', '-7 days')`
        ).bind(...allRegistrars).all<{ registrar: string; name: string }>(),
      ]);

      for (const r of regDomainsRes.results) {
        const arr = regDomainsMap.get(r.registrar) ?? [];
        arr.push(r.malicious_domain);
        regDomainsMap.set(r.registrar, arr);
      }
      for (const r of regBrandsRes.results) {
        const arr = regBrandsMap.get(r.registrar) ?? [];
        arr.push(r.name);
        regBrandsMap.set(r.registrar, arr);
      }
    }

    for (const cluster of registrarClusters.results) {
      itemsProcessed++;

      const campaignId = crypto.randomUUID();
      const fallbackName = `Registrar-cluster-${cluster.registrar.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 30)}`;

      // Use pre-fetched context maps (no per-registrar DB calls)
      const regDomainsList = (regDomainsMap.get(cluster.registrar) ?? []).slice(0, 10);
      const regBrandsList  = (regBrandsMap.get(cluster.registrar) ?? []).slice(0, 5);

      let name = fallbackName;
      const nameResult = await generateCampaignName(env, callCtx, {
        domains: regDomainsList,
        target_brands: regBrandsList,
        threat_types: [],
        providers: [cluster.registrar],
        threat_count: cluster.threat_count,
      });
      if (nameResult.success && nameResult.data?.name) {
        name = nameResult.data.name;
      }

      // NX4: snapshot brand_count_at_first_detection for the
      // significance rule. Counts distinct brands among threats
      // sharing this registrar — same scope as the threats-table
      // assignment immediately below.
      const regBrandCountRow = await env.DB.prepare(`
        SELECT COUNT(DISTINCT target_brand_id) AS n
          FROM threats
         WHERE registrar = ?
           AND target_brand_id IS NOT NULL
           AND status = 'active'
           AND created_at >= datetime('now', '-7 days')
      `).bind(cluster.registrar).first<{ n: number }>();
      const regBrandCountAtFirst = regBrandCountRow?.n ?? 0;

      await env.DB.prepare(
        `INSERT INTO campaigns (id, name, description, threat_count, attack_pattern, status, brand_count_at_first_detection)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      ).bind(
        campaignId, name, fallbackName, cluster.threat_count,
        JSON.stringify({ type: "shared_registrar", registrar: cluster.registrar }),
        regBrandCountAtFirst,
      ).run();

      await env.DB.prepare(
        `UPDATE threats SET campaign_id = ?
         WHERE registrar = ? AND campaign_id IS NULL AND status = 'active'
           AND created_at >= datetime('now', '-7 days')`
      ).bind(campaignId, cluster.registrar).run();

      itemsCreated++;

      outputs.push({
        type: "correlation",
        summary: `Registrar campaign: "${name}" — ${cluster.threat_count} threats via ${cluster.registrar}`,
        severity: "medium",
        details: { registrar: cluster.registrar, count: cluster.threat_count, ai_name: name },
      });

      // NX4: tenant fan-out for new registrar-cluster campaigns —
      // same gating as the IP-cluster path above.
      const regSig = evaluateCampaignSignificance({
        threat_count: cluster.threat_count,
        threat_count_24h_ago: 0,
        brand_count_at_first_detection: regBrandCountAtFirst,
      });
      if (regSig.significant) {
        try {
          await createBrandAlertsForCampaign(env, {
            campaign_id: campaignId,
            campaign_name: name,
            threat_count: cluster.threat_count,
            reasons: regSig.reasons,
          });
        } catch (e) {
          console.error('[strategist] registrar-campaign fanout error:', e);
        }
      }
    }

    // ─── Update campaign brand/provider counts ──────────────────
    await env.DB.prepare(`
      UPDATE campaigns SET
        brand_count = COALESCE(
          (SELECT COUNT(DISTINCT target_brand_id) FROM threats WHERE campaign_id = campaigns.id AND target_brand_id IS NOT NULL), 0
        ),
        provider_count = COALESCE(
          (SELECT COUNT(DISTINCT hosting_provider_id) FROM threats WHERE campaign_id = campaigns.id AND hosting_provider_id IS NOT NULL), 0
        )
    `).run();

    // Mark stale campaigns as dormant
    await env.DB.prepare(`
      UPDATE campaigns SET status = 'dormant'
      WHERE status = 'active'
        AND last_seen < datetime('now', '-30 days')
    `).run();

    // ─── Retroactive rename: fix campaigns with technical names ───
    const technicalCampaigns = await env.DB.prepare(
      `SELECT id, name, attack_pattern FROM campaigns
       WHERE name LIKE 'IP-cluster-%' OR name LIKE 'Registrar-cluster-%'
       LIMIT 5`
    ).all<{ id: string; name: string; attack_pattern: string | null }>();

    // Pre-fetch context for all technical campaigns to avoid N+1
    const techCampIds = technicalCampaigns.results.map(c => c.id);
    const techCampDomainsMap = new Map<string, string[]>();
    const techCampBrandsMap = new Map<string, string[]>();
    const techCampProvidersMap = new Map<string, string[]>();
    const techCampTypesMap = new Map<string, string[]>();
    const techCampCountMap = new Map<string, number>();

    if (techCampIds.length > 0) {
      const placeholders = techCampIds.map(() => '?').join(',');

      const [domainsRes, brandsRes, providersRes, typesRes, countsRes] = await Promise.all([
        env.DB.prepare(
          `SELECT campaign_id, malicious_domain FROM threats WHERE campaign_id IN (${placeholders}) AND malicious_domain IS NOT NULL GROUP BY campaign_id, malicious_domain`
        ).bind(...techCampIds).all<{ campaign_id: string; malicious_domain: string }>(),
        env.DB.prepare(
          `SELECT DISTINCT t.campaign_id, b.name FROM threats t JOIN brands b ON b.id = t.target_brand_id WHERE t.campaign_id IN (${placeholders})`
        ).bind(...techCampIds).all<{ campaign_id: string; name: string }>(),
        env.DB.prepare(
          `SELECT DISTINCT t.campaign_id, COALESCE(hp.name, t.hosting_provider_id) AS name FROM threats t LEFT JOIN hosting_providers hp ON hp.id = t.hosting_provider_id WHERE t.campaign_id IN (${placeholders}) AND t.hosting_provider_id IS NOT NULL`
        ).bind(...techCampIds).all<{ campaign_id: string; name: string }>(),
        env.DB.prepare(
          `SELECT DISTINCT campaign_id, threat_type FROM threats WHERE campaign_id IN (${placeholders}) AND threat_type IS NOT NULL`
        ).bind(...techCampIds).all<{ campaign_id: string; threat_type: string }>(),
        env.DB.prepare(
          `SELECT campaign_id, COUNT(*) as n FROM threats WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id`
        ).bind(...techCampIds).all<{ campaign_id: string; n: number }>(),
      ]);

      for (const row of domainsRes.results) {
        const arr = techCampDomainsMap.get(row.campaign_id) ?? [];
        arr.push(row.malicious_domain);
        techCampDomainsMap.set(row.campaign_id, arr);
      }
      for (const row of brandsRes.results) {
        const arr = techCampBrandsMap.get(row.campaign_id) ?? [];
        arr.push(row.name);
        techCampBrandsMap.set(row.campaign_id, arr);
      }
      for (const row of providersRes.results) {
        const arr = techCampProvidersMap.get(row.campaign_id) ?? [];
        arr.push(row.name);
        techCampProvidersMap.set(row.campaign_id, arr);
      }
      for (const row of typesRes.results) {
        const arr = techCampTypesMap.get(row.campaign_id) ?? [];
        arr.push(row.threat_type);
        techCampTypesMap.set(row.campaign_id, arr);
      }
      for (const row of countsRes.results) {
        techCampCountMap.set(row.campaign_id, row.n);
      }
    }

    let renameSuccessCount = 0;
    let renameFailCount = 0;
    let firstRenameResult: { campaign: string; success: boolean; newName?: string; error?: string } | null = null;

    for (const camp of technicalCampaigns.results) {
      const campDomains = (techCampDomainsMap.get(camp.id) ?? []).slice(0, 10);
      const campBrands = (techCampBrandsMap.get(camp.id) ?? []).slice(0, 5);
      const campProviders = (techCampProvidersMap.get(camp.id) ?? []).slice(0, 3);
      const campTypes = (techCampTypesMap.get(camp.id) ?? []).slice(0, 5);
      const campCount = techCampCountMap.get(camp.id) ?? 0;

      const nameResult = await generateCampaignName(env, callCtx, {
        domains: campDomains,
        target_brands: campBrands,
        threat_types: campTypes,
        providers: campProviders,
        threat_count: campCount,
      });

      if (!firstRenameResult) {
        firstRenameResult = {
          campaign: camp.name,
          success: nameResult.success,
          newName: nameResult.data?.name,
          error: nameResult.error,
        };
      }

      if (nameResult.success && nameResult.data?.name) {
        await env.DB.prepare(
          `UPDATE campaigns SET name = ?, description = ? WHERE id = ?`
        ).bind(nameResult.data.name, camp.name, camp.id).run();
        itemsUpdated++;
        renameSuccessCount++;
      } else {
        renameFailCount++;
      }
    }

    // Emit diagnostic output for rename telemetry
    outputs.push({
      type: "diagnostic",
      summary: `Retroactive rename: ${technicalCampaigns.results.length} candidates, ${renameSuccessCount} renamed, ${renameFailCount} failed`,
      severity: renameFailCount > 0 ? "medium" : technicalCampaigns.results.length > 0 ? "info" : "info",
      details: {
        campaigns_needing_rename: technicalCampaigns.results.length,
        rename_success: renameSuccessCount,
        rename_failed: renameFailCount,
        first_rename_attempt: firstRenameResult,
      },
    });

    // Always produce at least one output for diagnostics
    if (outputs.length === 0) {
      // Count eligible threats for clustering
      const eligibleIp = await env.DB.prepare(
        `SELECT COUNT(DISTINCT ip_address) as n FROM threats WHERE ip_address IS NOT NULL AND status = 'active' AND campaign_id IS NULL`
      ).first<{ n: number }>();
      const eligibleReg = await env.DB.prepare(
        `SELECT COUNT(DISTINCT registrar) as n FROM threats WHERE registrar IS NOT NULL AND status = 'active' AND campaign_id IS NULL AND created_at >= datetime('now', '-7 days')`
      ).first<{ n: number }>();
      const totalCampaigns = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM campaigns`
      ).first<{ n: number }>();

      outputs.push({
        type: "correlation",
        summary: `Strategist: ${ipClusters.results.length} IP clusters (need 3+), ${registrarClusters.results.length} registrar clusters (need 5+). ${totalCampaigns?.n ?? 0} total campaigns.`,
        severity: "info",
        details: {
          ipClustersFound: ipClusters.results.length,
          registrarClustersFound: registrarClusters.results.length,
          eligibleUniqueIPs: eligibleIp?.n ?? 0,
          eligibleUniqueRegistrars: eligibleReg?.n ?? 0,
          totalCampaigns: totalCampaigns?.n ?? 0,
          campaignsCreated: itemsCreated,
          campaignsUpdated: itemsUpdated,
        },
      });
    }

    // ─── Coordination detection via Haiku ─────────────────────────
    let coordinationFound = 0;
    try {
      const activeCampaigns = await env.DB.prepare(
        `SELECT c.id, c.name, c.threat_count,
                GROUP_CONCAT(DISTINCT t.target_brand_id) as brand_ids,
                GROUP_CONCAT(DISTINCT t.hosting_provider_id) as provider_ids
         FROM campaigns c
         LEFT JOIN threats t ON t.campaign_id = c.id
         WHERE c.status = 'active'
         GROUP BY c.id
         ORDER BY c.threat_count DESC LIMIT 20`
      ).all<{ id: string; name: string; threat_count: number; brand_ids: string | null; provider_ids: string | null }>();

      if (activeCampaigns.results.length >= 5) {
        const blocked = await checkCostGuard(env, false);
        if (!blocked) {
          const campaignSummary = activeCampaigns.results.map(c => ({
            id: c.id, name: c.name, threats: c.threat_count,
            brands: c.brand_ids?.split(',').filter(Boolean).length ?? 0,
            providers: c.provider_ids?.split(',').filter(Boolean).length ?? 0,
          }));

          const { callHaikuRaw } = await import("../lib/haiku");
          const coordResult = await callHaikuRaw(env, callCtx,
            "You detect coordinated phishing attack patterns. Reply ONLY with valid JSON array, no markdown.",
            `Given these active phishing campaigns with their target brands and hosting providers:\n${JSON.stringify(campaignSummary)}\nIdentify any that appear coordinated (same actor, infrastructure reuse, timing patterns). Reply JSON array: [{campaign_ids: string[], coordination_type: string, confidence: "high"|"medium", evidence: string}]. Empty array if none.`,
            512,
          );

          if (coordResult.success && coordResult.text) {
            const jsonMatch = coordResult.text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const coordinations = JSON.parse(jsonMatch[0]) as Array<{
                campaign_ids: string[]; coordination_type: string; confidence: string; evidence: string;
              }>;
              for (const coord of coordinations) {
                if (coord.confidence !== 'high' && coord.confidence !== 'medium') continue;
                coordinationFound++;
                outputs.push({
                  type: "correlation",
                  summary: `**Coordinated Attack Detected** — ${coord.coordination_type}: ${coord.campaign_ids.length} campaigns appear linked. ${coord.evidence}`,
                  severity: "high",
                  details: {
                    campaign_ids: coord.campaign_ids,
                    coordination_type: coord.coordination_type,
                    confidence: coord.confidence,
                  },
                });
                // Store as agent_output type='correlation'
                await env.DB.prepare(
                  `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at)
                   VALUES (?, 'strategist', 'correlation', ?, 'high', ?, datetime('now'))`
                ).bind(
                  crypto.randomUUID(),
                  `Coordinated: ${coord.coordination_type} — ${coord.campaign_ids.length} campaigns`,
                  JSON.stringify(coord),
                ).run();
              }
            }
          }
        }
      }
    } catch (coordErr) {
      console.error("[strategist] coordination detection error:", coordErr);
    }

    return {
      itemsProcessed,
      itemsCreated,
      itemsUpdated,
      output: {
        ipClusters: ipClusters.results.length,
        registrarClusters: registrarClusters.results.length,
        campaignsCreated: itemsCreated,
        campaignsUpdated: itemsUpdated,
      },
      agentOutputs: outputs,
    };
  },
};
