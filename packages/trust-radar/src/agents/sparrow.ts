/**
 * Sparrow Agent — Takedown Agent.
 *
 * Runs every 6 hours (staggered at minute 15-20 after cartographer).
 * Four phases:
 *   A) Scan unprocessed spam trap captures for malicious URLs
 *   B) Auto-create takedown request drafts from malicious URL scan results
 *   C) Auto-create takedown request drafts from impersonation social profiles
 *   D) AI evidence assembly for unenriched takedown drafts
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { scanUnprocessedCaptures } from "../lib/url-scanner";

export const sparrowAgent: AgentModule = {
  name: "sparrow",
  displayName: "Sparrow",
  description: "Takedown agent — scans URLs, auto-creates takedowns, assembles evidence, resolves providers",
  color: "#28A050",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 480,
  parallelMax: 1,
  costGuard: "enforced",
  // Includes evidence-assembler internal AI calls (Phase 4.6 will
  // split that into a separate sync agent with its own budget).
  budget: { monthlyTokenCap: 5_000_000 },
  reads: [
    { kind: "d1_table", name: "app_store_listings" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "dark_web_mentions" },
    { kind: "d1_table", name: "org_brands" },
    { kind: "d1_table", name: "social_mentions" },
    { kind: "d1_table", name: "social_profiles" },
    { kind: "d1_table", name: "takedown_authorizations" },
    { kind: "d1_table", name: "takedown_evidence" },
    { kind: "d1_table", name: "takedown_providers" },
    { kind: "d1_table", name: "takedown_requests" },
    { kind: "d1_table", name: "takedown_submissions" },
    { kind: "d1_table", name: "url_scan_results" },
  ],
  writes: [
    { kind: "d1_table", name: "takedown_evidence" },
    { kind: "d1_table", name: "takedown_requests" },
    { kind: "d1_table", name: "url_scan_results" },
  ],
  outputs: [{ type: "insight" }, { type: "diagnostic" }],
  status: "active",
  category: "response",
  pipelinePosition: 7,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;

    let itemsProcessed = 0;
    let itemsCreated = 0;
    const outputs: AgentOutputEntry[] = [];

    // ── Phase A: Scan unprocessed spam trap captures ──────────────
    const scanResults = await scanUnprocessedCaptures(env, 20);
    itemsProcessed += scanResults.captures_processed;

    if (scanResults.malicious_found > 0) {
      outputs.push({
        type: "diagnostic",
        summary: `Scanned ${scanResults.captures_processed} captures: ${scanResults.urls_scanned} URLs checked, ${scanResults.malicious_found} malicious found`,
        severity: "info",
        details: scanResults,
      });
    }

    // ── Phase B: Auto-create takedowns from malicious URL scan results ──
    const urlTakedowns = await createTakedownsFromMaliciousUrls(env);
    itemsCreated += urlTakedowns;

    // ── Phase C: Auto-create takedowns from impersonation social profiles ──
    const socialTakedowns = await createTakedownsFromImpersonations(env);
    itemsCreated += socialTakedowns;

    // ── Phase C2: Auto-create takedowns from app-store impersonations ──
    const appStoreTakedowns = await createTakedownsFromAppStoreImpersonations(env);
    itemsCreated += appStoreTakedowns;

    // ── Phase C3: Auto-create takedowns from confirmed dark-web mentions ──
    const darkWebTakedowns = await createTakedownsFromDarkWebMentions(env);
    itemsCreated += darkWebTakedowns;

    if (urlTakedowns > 0 || socialTakedowns > 0 || appStoreTakedowns > 0 || darkWebTakedowns > 0) {
      const totalNew = urlTakedowns + socialTakedowns + appStoreTakedowns + darkWebTakedowns;
      outputs.push({
        type: "insight",
        summary: `Created ${totalNew} takedown drafts (${urlTakedowns} URL, ${socialTakedowns} social, ${appStoreTakedowns} app-store, ${darkWebTakedowns} dark-web)`,
        severity: totalNew > 5 ? "high" : "medium",
        details: {
          url_takedowns: urlTakedowns,
          social_takedowns: socialTakedowns,
          app_store_takedowns: appStoreTakedowns,
          dark_web_takedowns: darkWebTakedowns,
        },
      });
    }

    // ── Phase D: AI evidence assembly for unenriched takedowns ────
    const unenrichedTakedowns = await env.DB.prepare(`
      SELECT id FROM takedown_requests
      WHERE status = 'draft'
        AND id NOT IN (
          SELECT takedown_id FROM takedown_evidence WHERE evidence_type = 'ai_report'
        )
      ORDER BY priority_score DESC
      LIMIT 3
    `).all<{ id: string }>();

    let evidenceAssembled = 0;
    for (const td of unenrichedTakedowns.results || []) {
      try {
        const { assembleEvidence } = await import("../lib/evidence-assembler");
        await assembleEvidence(env, td.id);
        evidenceAssembled++;
      } catch (err) {
        console.error(`[Sparrow] Evidence assembly failed for ${td.id}: ${err}`);
      }
    }

    if (evidenceAssembled > 0) {
      itemsCreated += evidenceAssembled;
      outputs.push({
        type: "diagnostic",
        summary: `Assembled AI evidence for ${evidenceAssembled} takedown request(s)`,
        severity: "info",
        details: { evidence_assembled: evidenceAssembled },
      });
    }

    // ── Phase D2: Attach social evidence to existing takedown drafts ──
    let socialEvidenceAttached = 0;
    try {
      const takedownsNeedingSocialEvidence = await env.DB.prepare(`
        SELECT tr.id, tr.brand_id, tr.source_id, tr.source_type
        FROM takedown_requests tr
        WHERE tr.status = 'draft'
          AND tr.brand_id IS NOT NULL
          AND tr.id NOT IN (
            SELECT takedown_id FROM takedown_evidence WHERE evidence_type = 'social_mention'
          )
        ORDER BY tr.priority_score DESC
        LIMIT 10
      `).all<{ id: string; brand_id: string; source_id: string | null; source_type: string | null }>();

      for (const td of takedownsNeedingSocialEvidence.results) {
        // Look for social mentions related to the same brand with escalated threat
        const socialEvidence = await env.DB.prepare(`
          SELECT content_url, content_text, platform, content_author, threat_type
          FROM social_mentions
          WHERE brand_id = ?
            AND status IN ('classified', 'escalated')
            AND severity IN ('critical', 'high')
            AND created_at >= datetime('now', '-30 days')
          ORDER BY created_at DESC
          LIMIT 5
        `).bind(td.brand_id).all<{
          content_url: string | null;
          content_text: string | null;
          platform: string;
          content_author: string | null;
          threat_type: string | null;
        }>();

        if (socialEvidence.results.length > 0) {
          const evidenceLines = socialEvidence.results.map(se =>
            `- [${se.platform}] ${se.threat_type ?? 'threat'} by ${se.content_author ?? 'unknown'}: ${se.content_url ?? 'no URL'}`
          ).join('\n');

          await env.DB.prepare(`
            INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
            VALUES (?, ?, 'social_mention', 'Social Platform Evidence', ?, ?, datetime('now'))
          `).bind(
            crypto.randomUUID(),
            td.id,
            `Social platform evidence corroborating this threat:\n${evidenceLines}`,
            JSON.stringify({ mentions: socialEvidence.results.length, platforms: [...new Set(socialEvidence.results.map(s => s.platform))] }),
          ).run();

          socialEvidenceAttached++;
        }
      }
    } catch (err) {
      console.error('[Sparrow] Social evidence attachment error:', err instanceof Error ? err.message : String(err));
    }

    if (socialEvidenceAttached > 0) {
      outputs.push({
        type: "diagnostic",
        summary: `Attached social evidence to ${socialEvidenceAttached} takedown draft(s)`,
        severity: "info",
        details: { social_evidence_attached: socialEvidenceAttached },
      });
    }

    // ── Phase E: Resolve providers and generate submission drafts ───
    let providersResolved = 0;
    const noProviderTakedowns = await env.DB.prepare(`
      SELECT tr.*, b.name as brand_name
      FROM takedown_requests tr
      LEFT JOIN brands b ON b.id = tr.brand_id
      WHERE tr.status = 'draft'
        AND (tr.provider_name IS NULL OR tr.provider_abuse_contact IS NULL)
        AND tr.target_type IN ('domain', 'url')
      ORDER BY tr.priority_score DESC
      LIMIT 5
    `).all();

    for (const td of noProviderTakedowns.results || []) {
      try {
        const { resolveProvider, generateSubmissionDraft } = await import("../lib/provider-resolver");
        const providerInfo = await resolveProvider(env, td.target_value as string);

        const updates: string[] = [];
        const values: unknown[] = [];

        if (providerInfo.hosting_provider && !td.provider_name) {
          updates.push("provider_name = ?");
          values.push(providerInfo.hosting_provider);
        }
        if (providerInfo.abuse_contact?.abuse_email || providerInfo.abuse_contact?.abuse_url) {
          updates.push("provider_abuse_contact = ?");
          values.push(providerInfo.abuse_contact.abuse_email || providerInfo.abuse_contact.abuse_url);
        }
        if (providerInfo.abuse_contact?.abuse_api_type) {
          updates.push("provider_method = ?");
          values.push(providerInfo.abuse_contact.abuse_api_type);
        }

        // Generate submission draft
        const draft = generateSubmissionDraft(
          { ...(td as Record<string, unknown>), brand_name: td.brand_name as string } as {
            target_type: string;
            target_value: string;
            target_url?: string | null;
            evidence_summary: string;
            evidence_detail?: string | null;
            brand_name?: string;
          },
          providerInfo.abuse_contact,
          providerInfo,
        );
        updates.push("evidence_detail = COALESCE(evidence_detail, '') || ?");
        values.push("\n\n--- SUBMISSION DRAFT ---\n" + draft);

        if (updates.length > 0) {
          updates.push("updated_at = datetime('now')");
          values.push(td.id);
          await env.DB.prepare(
            `UPDATE takedown_requests SET ${updates.join(", ")} WHERE id = ?`
          ).bind(...values).run();
          providersResolved++;
        }
      } catch (err) {
        console.error(`[Sparrow] Provider resolution failed for ${td.id}: ${err}`);
      }
    }

    if (providersResolved > 0) {
      outputs.push({
        type: "diagnostic",
        summary: `Resolved providers and generated submission drafts for ${providersResolved} takedown(s)`,
        severity: "info",
        details: { providers_resolved: providersResolved },
      });
    }

    // ── Phase F: Verify taken-down domains are still down ─────────
    let domainsVerified = 0;
    let domainsResurrected = 0;
    try {
      const { checkDomain } = await import("../lib/domain-checker");
      const { createAlert } = await import("../lib/alerts");

      const takenDown = await env.DB.prepare(`
        SELECT id, target_value, brand_id
        FROM takedown_requests
        WHERE status = 'taken_down'
          AND target_type IN ('domain', 'url')
          AND (last_verified_at IS NULL
               OR last_verified_at < datetime('now', '-7 days'))
        ORDER BY last_verified_at ASC NULLS FIRST
        LIMIT 20
      `).all<{ id: string; target_value: string; brand_id: string }>();

      // Process in batches of 5 concurrent checks
      const CONCURRENCY = 5;
      for (let i = 0; i < takenDown.results.length; i += CONCURRENCY) {
        const batch = takenDown.results.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (td) => {
          try {
            const result = await checkDomain(td.target_value);
            domainsVerified++;

            const isAlive = result.registered && result.hasWeb;
            await env.DB.prepare(`
              UPDATE takedown_requests
              SET last_verified_at = datetime('now'),
                  verification_status = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).bind(isAlive ? 'alive' : 'down', td.id).run();

            if (isAlive) {
              domainsResurrected++;
              // Create high-severity alert
              await createAlert(env.DB, {
                brandId: td.brand_id,
                userId: 'system',
                alertType: 'takedown_resurrected',
                severity: 'HIGH',
                title: `Taken-down domain resurrected: ${td.target_value}`,
                summary: `Domain ${td.target_value} was previously taken down but is now resolving (IP: ${result.ip ?? 'unknown'}) and serving web content. A new takedown may be required.`,
                details: {
                  domain: td.target_value,
                  ip: result.ip,
                  has_mx: result.hasMx,
                  has_web: result.hasWeb,
                  takedown_id: td.id,
                },
                sourceType: 'takedown',
                sourceId: td.id,
              });
            }
          } catch (err) {
            console.error(`[Sparrow] Phase F verify failed for ${td.target_value}: ${err}`);
          }
        }));
      }
    } catch (err) {
      console.error('[Sparrow] Phase F error:', err instanceof Error ? err.message : String(err));
    }

    if (domainsVerified > 0) {
      outputs.push({
        type: domainsResurrected > 0 ? "insight" : "diagnostic",
        summary: `Verified ${domainsVerified} taken-down domains: ${domainsResurrected} resurrected, ${domainsVerified - domainsResurrected} still down`,
        severity: domainsResurrected > 0 ? "high" : "info",
        details: { domains_verified: domainsVerified, domains_resurrected: domainsResurrected },
      });
    }

    // ── Phase G: Auto-submit drafts where authorized ──────────────
    let autoSubmitted = 0;
    let autoSubmitSkipped = 0;
    try {
      const phaseG = await runPhaseGAutoSubmit(env);
      autoSubmitted     = phaseG.submitted;
      autoSubmitSkipped = phaseG.skipped;
      if (autoSubmitted > 0) {
        outputs.push({
          type: "insight",
          summary: `Auto-submitted ${autoSubmitted} takedown draft(s) via the dispatcher`,
          severity: "info",
          details: { submitted: autoSubmitted, skipped: autoSubmitSkipped },
        });
      }
    } catch (err) {
      console.error('[Sparrow] Phase G error:', err instanceof Error ? err.message : String(err));
    }

    // ── Phase H: SLA-breach follow-ups ────────────────────────────
    let followupsFired = 0;
    try {
      const phaseH = await runPhaseHAutoFollowup(env);
      followupsFired = phaseH.followups;
      if (followupsFired > 0) {
        outputs.push({
          type: "insight",
          summary: `Fired ${followupsFired} SLA-breach follow-up(s)`,
          severity: "info",
          details: { followups: followupsFired, skipped: phaseH.skipped },
        });
      }
    } catch (err) {
      console.error('[Sparrow] Phase H error:', err instanceof Error ? err.message : String(err));
    }

    return {
      itemsProcessed,
      itemsCreated: itemsCreated + socialEvidenceAttached,
      itemsUpdated: providersResolved + domainsVerified + autoSubmitted + followupsFired,
      output: {
        captures_scanned: scanResults.captures_processed,
        urls_scanned: scanResults.urls_scanned,
        malicious_found: scanResults.malicious_found,
        url_takedowns: urlTakedowns,
        social_takedowns: socialTakedowns,
        app_store_takedowns: appStoreTakedowns,
        dark_web_takedowns: darkWebTakedowns,
        evidence_assembled: evidenceAssembled,
        social_evidence_attached: socialEvidenceAttached,
        providers_resolved: providersResolved,
        takedown_domains_verified: domainsVerified,
        takedown_domains_resurrected: domainsResurrected,
        auto_submitted: autoSubmitted,
        auto_submit_skipped: autoSubmitSkipped,
        followups_fired: followupsFired,
      },
      agentOutputs: outputs,
    };
  },
};

// ─── Phase B: Malicious URL → Takedown ─────────────────────────────

async function createTakedownsFromMaliciousUrls(env: Env): Promise<number> {
  const unlinkedMalicious = await env.DB.prepare(`
    SELECT usr.*, b.name as brand_name, b.canonical_domain as brand_domain
    FROM url_scan_results usr
    JOIN brands b ON b.id = usr.brand_id
    WHERE usr.is_malicious = 1
      AND usr.takedown_id IS NULL
      AND usr.confidence_score >= 0.6
    ORDER BY usr.confidence_score DESC
    LIMIT 10
  `).all();

  let created = 0;

  for (const result of unlinkedMalicious.results) {
    const hostingProvider = result.hosting_provider as string | null;

    // Look up hosting provider from takedown_providers
    const provider = hostingProvider
      ? await env.DB.prepare(
          "SELECT * FROM takedown_providers WHERE provider_name LIKE ? LIMIT 1"
        ).bind(`%${hostingProvider}%`).first()
      : null;

    const confidenceScore = (result.confidence_score as number) || 0;
    const maliciousReasons: string[] = JSON.parse((result.malicious_reasons as string) || "[]");
    const brandName = (result.brand_name as string) || "unknown brand";
    const url = result.url as string;
    const domain = result.domain as string;

    const takedownId = crypto.randomUUID();
    const owningOrgId = await resolveOwningOrgId(env, result.brand_id as string | null);
    await env.DB.prepare(`
      INSERT INTO takedown_requests (
        id, org_id, brand_id, module_key, target_type, target_value, target_url,
        source_type, source_id, evidence_summary, evidence_detail,
        provider_name, provider_abuse_contact, provider_method,
        status, severity, priority_score, requested_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'domain', 'url', ?, ?, 'url_scan', ?, ?, ?, ?, ?, ?, 'draft', ?, ?, null, datetime('now'), datetime('now'))
    `).bind(
      takedownId,
      owningOrgId,
      result.brand_id as string | null,
      domain,
      url,
      String(result.id),
      `Malicious URL detected targeting ${brandName}. ${maliciousReasons.join(". ")}.`,
      `URL: ${url}\nDomain: ${domain}\nConfidence: ${Math.round(confidenceScore * 100)}%\nReasons: ${maliciousReasons.join(", ")}`,
      (provider?.provider_name as string) || null,
      (provider?.abuse_email as string) || (provider?.abuse_url as string) || null,
      (provider?.abuse_api_type as string) || "email",
      confidenceScore >= 0.8 ? "HIGH" : "MEDIUM",
      confidenceScore >= 0.8 ? 70 : 50,
    ).run();

    // Link the scan result to the takedown
    await env.DB.prepare(
      "UPDATE url_scan_results SET takedown_id = ? WHERE id = ?"
    ).bind(takedownId, result.id).run();

    // Create evidence record
    await env.DB.prepare(`
      INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
      VALUES (?, ?, 'url_scan', 'URL Scan Result', ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      takedownId,
      `URL: ${url}\nDomain: ${domain}\nMalicious: Yes (${Math.round(confidenceScore * 100)}% confidence)\nReasons:\n${maliciousReasons.map((r: string) => "  - " + r).join("\n")}`,
      JSON.stringify({
        url,
        domain,
        confidence_score: confidenceScore,
        reasons: maliciousReasons,
        hosting_provider: hostingProvider,
        known_threat_id: result.known_threat_id,
        source_capture_id: result.source_id,
      }),
    ).run();

    created++;
  }

  return created;
}

// ─── Phase C: Impersonation Profiles → Takedown ────────────────────

async function createTakedownsFromImpersonations(env: Env): Promise<number> {
  const impersonations = await env.DB.prepare(`
    SELECT sp.*, b.name as brand_name
    FROM social_profiles sp
    JOIN brands b ON b.id = sp.brand_id
    WHERE sp.classification = 'impersonation'
      AND sp.status = 'active'
      AND sp.id NOT IN (
        SELECT source_id FROM takedown_requests
        WHERE source_type = 'social_profile' AND source_id IS NOT NULL
      )
    ORDER BY sp.impersonation_score DESC
    LIMIT 10
  `).all();

  let created = 0;

  for (const profile of impersonations.results) {
    const platform = ((profile.platform as string) || "").toLowerCase();
    const handle = profile.handle as string;
    const confidenceScore = (profile.impersonation_score as number) || 0;
    const brandName = profile.brand_name as string;

    // Look up platform abuse contact
    const provider = await env.DB.prepare(
      "SELECT * FROM takedown_providers WHERE provider_type = 'social_platform' AND LOWER(provider_name) LIKE ? LIMIT 1"
    ).bind(`%${platform}%`).first();

    const evidenceText = (profile.ai_evidence_draft as string)
      || (profile.ai_assessment as string)
      || `Account @${handle} on ${platform} is impersonating ${brandName}.`;

    const takedownId = crypto.randomUUID();
    const owningOrgId = await resolveOwningOrgId(env, profile.brand_id as string);
    await env.DB.prepare(`
      INSERT INTO takedown_requests (
        id, org_id, brand_id, module_key, target_type, target_value, target_platform, target_url,
        source_type, source_id, evidence_summary, evidence_detail,
        provider_name, provider_abuse_contact, provider_method,
        status, severity, priority_score, requested_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'social', 'social_profile', ?, ?, ?, 'social_profile', ?, ?, ?, ?, ?, ?, 'draft', ?, ?, null, datetime('now'), datetime('now'))
    `).bind(
      takedownId,
      owningOrgId,
      profile.brand_id as string,
      `@${handle}`,
      platform,
      (profile.profile_url as string) || null,
      String(profile.id),
      `Impersonation account @${handle} on ${platform} targeting ${brandName}. Confidence: ${Math.round(confidenceScore * 100)}%.`,
      evidenceText,
      (provider?.provider_name as string) || platform,
      (provider?.abuse_url as string) || null,
      (provider?.abuse_api_type as string) || "form",
      confidenceScore >= 0.8 ? "HIGH" : "MEDIUM",
      confidenceScore >= 0.8 ? 70 : 50,
    ).run();

    // Create evidence record
    await env.DB.prepare(`
      INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
      VALUES (?, ?, 'ai_report', 'Social Profile Assessment', ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      takedownId,
      evidenceText,
      JSON.stringify({
        platform,
        handle,
        url: profile.profile_url,
        confidence_score: confidenceScore,
        classification: profile.classification,
        brand_name: brandName,
      }),
    ).run();

    created++;
  }

  return created;
}

// ─── Phase C2: App-Store Impersonations → Takedown ────────────────

async function createTakedownsFromAppStoreImpersonations(env: Env): Promise<number> {
  let impersonations: { results: Record<string, unknown>[] };
  try {
    impersonations = await env.DB.prepare(`
      SELECT asl.*, b.name as brand_name
      FROM app_store_listings asl
      JOIN brands b ON b.id = asl.brand_id
      WHERE asl.classification = 'impersonation'
        AND asl.status = 'active'
        AND asl.severity IN ('HIGH', 'CRITICAL')
        AND asl.id NOT IN (
          SELECT source_id FROM takedown_requests
          WHERE source_type = 'app_store' AND source_id IS NOT NULL
        )
      ORDER BY
        CASE asl.severity WHEN 'CRITICAL' THEN 1 ELSE 2 END,
        asl.impersonation_score DESC
      LIMIT 10
    `).all<Record<string, unknown>>();
  } catch {
    // app_store_listings may not exist in a given deployment — gracefully skip.
    return 0;
  }

  let created = 0;

  for (const row of impersonations.results) {
    const store = ((row.store as string) || "").toLowerCase();
    const appName = (row.app_name as string) || "unknown app";
    const devName = (row.developer_name as string) || "unknown developer";
    const bundleId = (row.bundle_id as string) || null;
    const appUrl = (row.app_url as string) || null;
    const score = (row.impersonation_score as number) || 0;
    const severity = ((row.severity as string) || "HIGH").toUpperCase() as "HIGH" | "CRITICAL";
    const brandName = (row.brand_name as string) || "unknown brand";
    const signalsJson = (row.impersonation_signals as string) || "[]";
    const classificationReason = (row.classification_reason as string) || null;

    // Provider lookup: app-store abuse contact. Free-text match on provider_name.
    // Example seed rows: "Apple App Store", "Google Play Store".
    const provider = await env.DB.prepare(
      "SELECT * FROM takedown_providers WHERE provider_type = 'app_store' AND LOWER(provider_name) LIKE ? LIMIT 1"
    ).bind(`%${store}%`).first();

    // Evidence text: prefer AI assessment (populated by the scanner's Haiku
    // review for suspicious rows that got promoted), fall back to the rule-
    // based classification reason, then to a templated summary.
    const aiAssessment = (row.ai_assessment as string) || null;
    const evidenceText = aiAssessment
      ?? classificationReason
      ?? `App "${appName}" on ${store} by "${devName}" is impersonating ${brandName}${bundleId ? ` (bundle ID: ${bundleId})` : ""}. Impersonation score: ${Math.round(score * 100)}%.`;

    const takedownId = crypto.randomUUID();
    const owningOrgId = await resolveOwningOrgId(env, row.brand_id as string);
    await env.DB.prepare(`
      INSERT INTO takedown_requests (
        id, org_id, brand_id, module_key, target_type, target_value, target_platform, target_url,
        source_type, source_id, evidence_summary, evidence_detail,
        provider_name, provider_abuse_contact, provider_method,
        status, severity, priority_score, requested_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'app_store', 'mobile_app', ?, ?, ?, 'app_store', ?, ?, ?, ?, ?, ?, 'draft', ?, ?, null, datetime('now'), datetime('now'))
    `).bind(
      takedownId,
      owningOrgId,
      row.brand_id as string,
      bundleId ?? appName,
      store,
      appUrl,
      String(row.id),
      `App-store impersonation "${appName}" on ${store} by "${devName}" targeting ${brandName}. Confidence: ${Math.round(score * 100)}%.`,
      evidenceText,
      (provider?.provider_name as string) || (store === "ios" ? "Apple App Store" : store),
      (provider?.abuse_url as string) || (provider?.abuse_email as string) || null,
      (provider?.abuse_api_type as string) || "form",
      severity,
      severity === "CRITICAL" ? 85 : 70,
    ).run();

    // Evidence record mirrors the pattern used for social profiles.
    await env.DB.prepare(`
      INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
      VALUES (?, ?, 'app_store_listing', 'App-Store Listing Assessment', ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      takedownId,
      evidenceText,
      JSON.stringify({
        store,
        app_name: appName,
        app_id: row.app_id,
        bundle_id: bundleId,
        developer_name: devName,
        developer_id: row.developer_id ?? null,
        app_url: appUrl,
        impersonation_score: score,
        classification: row.classification,
        severity,
        brand_name: brandName,
        signals: signalsJson,
      }),
    ).run();

    created++;
  }

  return created;
}

// ─── Phase C3: Dark-Web Confirmed Mentions → Takedown ─────────────

async function createTakedownsFromDarkWebMentions(env: Env): Promise<number> {
  let mentions: { results: Record<string, unknown>[] };
  try {
    mentions = await env.DB.prepare(`
      SELECT dwm.*, b.name as brand_name
      FROM dark_web_mentions dwm
      JOIN brands b ON b.id = dwm.brand_id
      WHERE dwm.classification = 'confirmed'
        AND dwm.status = 'active'
        AND dwm.severity IN ('HIGH', 'CRITICAL')
        AND dwm.id NOT IN (
          SELECT source_id FROM takedown_requests
          WHERE source_type = 'dark_web_mention' AND source_id IS NOT NULL
        )
      ORDER BY
        CASE dwm.severity WHEN 'CRITICAL' THEN 1 ELSE 2 END,
        dwm.last_seen DESC
      LIMIT 10
    `).all<Record<string, unknown>>();
  } catch {
    // dark_web_mentions may not exist in a given deployment — gracefully skip.
    return 0;
  }

  let created = 0;

  for (const row of mentions.results) {
    const source = ((row.source as string) || "").toLowerCase();
    const sourceUrl = (row.source_url as string) || "";
    const brandName = (row.brand_name as string) || "unknown brand";
    const matchType = (row.match_type as string) || "unknown";
    const matchedTermsJson = (row.matched_terms as string) || "[]";
    const snippet = (row.content_snippet as string) || "";
    const severity = ((row.severity as string) || "HIGH").toUpperCase() as "HIGH" | "CRITICAL";
    const classificationReason = (row.classification_reason as string) || null;

    // Provider lookup: paste-host abuse contact. Free-text match.
    // Example seed rows: "Pastebin", "Doxbin", "Telegram".
    const provider = await env.DB.prepare(
      "SELECT * FROM takedown_providers WHERE provider_type = 'paste_host' AND LOWER(provider_name) LIKE ? LIMIT 1"
    ).bind(`%${source}%`).first();

    const aiAssessment = (row.ai_assessment as string) || null;
    const evidenceText = aiAssessment
      ?? classificationReason
      ?? `Confirmed ${source} mention of ${brandName} via ${matchType} match.${snippet ? `\n\nExcerpt:\n${snippet}` : ""}`;

    const takedownId = crypto.randomUUID();
    const owningOrgId = await resolveOwningOrgId(env, row.brand_id as string);
    await env.DB.prepare(`
      INSERT INTO takedown_requests (
        id, org_id, brand_id, module_key, target_type, target_value, target_platform, target_url,
        source_type, source_id, evidence_summary, evidence_detail,
        provider_name, provider_abuse_contact, provider_method,
        status, severity, priority_score, requested_by, created_at, updated_at
      ) VALUES (?, ?, ?, 'dark_web', 'paste', ?, ?, ?, 'dark_web_mention', ?, ?, ?, ?, ?, ?, 'draft', ?, ?, null, datetime('now'), datetime('now'))
    `).bind(
      takedownId,
      owningOrgId,
      row.brand_id as string,
      sourceUrl,
      source,
      sourceUrl,
      String(row.id),
      `Confirmed dark-web mention of ${brandName} on ${source} (${matchType} match, ${severity}).`,
      evidenceText,
      (provider?.provider_name as string) || source,
      (provider?.abuse_email as string) || (provider?.abuse_url as string) || null,
      (provider?.abuse_api_type as string) || "email",
      severity,
      severity === "CRITICAL" ? 85 : 65,
    ).run();

    await env.DB.prepare(`
      INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
      VALUES (?, ?, 'dark_web_mention', 'Dark-Web Mention Evidence', ?, ?, datetime('now'))
    `).bind(
      crypto.randomUUID(),
      takedownId,
      evidenceText,
      JSON.stringify({
        source,
        source_url: sourceUrl,
        source_channel: row.source_channel ?? null,
        source_author: row.source_author ?? null,
        posted_at: row.posted_at ?? null,
        match_type: matchType,
        matched_terms: matchedTermsJson,
        classification: row.classification,
        severity,
        brand_name: brandName,
        snippet_length: snippet.length,
      }),
    ).run();

    created++;
  }

  return created;
}

// Need Env type for helper functions
import type { Env } from "../types";

// Resolve the primary org owning a brand. Returns null when the brand
// isn't bound to any org (cross-cutting threats with no tenant
// owner — these stay SOC-initiated and Phase G skips them).
async function resolveOwningOrgId(env: Env, brandId: string | null): Promise<number | null> {
  if (!brandId) return null;
  const row = await env.DB.prepare(
    `SELECT org_id FROM org_brands
     WHERE brand_id = ?
     ORDER BY is_primary DESC
     LIMIT 1`,
  ).bind(brandId).first<{ org_id: number }>();
  return row ? row.org_id : null;
}

// ─── Phase G: Auto-Submit Authorized Drafts ─────────────────────────
//
// Picks up to PHASE_G_BATCH takedowns where:
//   - status = 'draft'
//   - module_key + provider_name resolved (Phase E filled these in)
//   - org_id is set (SOC-initiated takedowns with no org are skipped here;
//     ops handles those manually)
//   - the org has signed an active takedown_authorizations covering the
//     module_key
//   - the matching takedown_providers row has auto_submit_enabled = 1
//
// Each match is dispatched via lib/takedown-submitters/. On any
// non-failed outcome the takedown's status flips to 'submitted'
// and submitted_at is stamped. On 'failed' the status stays 'draft'
// so the next tick (or ops manually) can retry.

const PHASE_G_BATCH = 10;

interface PhaseGRow {
  id:                     string;
  org_id:                 number | null;
  brand_id:               string;
  module_key:             string | null;
  target_type:            string;
  target_value:           string;
  target_url:             string | null;
  evidence_summary:       string;
  evidence_detail:        string | null;
  provider_name:          string | null;
  provider_abuse_contact: string | null;
  provider_method:        string | null;
  severity:               string;
}

async function runPhaseGAutoSubmit(env: Env): Promise<{ submitted: number; skipped: number }> {
  const candidates = await env.DB.prepare(
    `SELECT tr.id, tr.org_id, tr.brand_id, tr.module_key,
            tr.target_type, tr.target_value, tr.target_url,
            tr.evidence_summary, tr.evidence_detail,
            tr.provider_name, tr.provider_abuse_contact, tr.provider_method,
            tr.severity
     FROM takedown_requests tr
     WHERE tr.status = 'draft'
       AND tr.org_id IS NOT NULL
       AND tr.module_key IS NOT NULL
       AND tr.provider_name IS NOT NULL
     ORDER BY tr.priority_score DESC, tr.created_at ASC
     LIMIT ?`,
  ).bind(PHASE_G_BATCH).all<PhaseGRow>();

  let submitted = 0;
  let skipped   = 0;

  const { isModuleAuthorized, isUnderMonthlyTakedownCap } = await import("../lib/takedown-authorizations");
  const { dispatchSubmission } = await import("../lib/takedown-submitters");
  const { isModuleEnabled }    = await import("../lib/entitlements");
  type ModuleKey = Parameters<typeof isModuleAuthorized>[2];

  // S1 — per-org monthly cap (scope_json.max_takedowns_per_month).
  // Resolved once per org per run, then decremented locally so a single
  // batch can't overshoot the cap. Note PHASE_G_BATCH doubles as the
  // per-run send ceiling in live mode.
  const capByOrg = new Map<number, { under: boolean; used: number; cap: number | null }>();
  const capNotifiedOrgs = new Set<number>();

  for (const row of candidates.results ?? []) {
    try {
      const orgId   = row.org_id;
      const modKey  = row.module_key as ModuleKey | null;
      if (orgId === null || modKey === null) { skipped++; continue; }

      // Both gates: entitlement (org_modules) AND consent (takedown_authorizations).
      const [enabled, authorized] = await Promise.all([
        isModuleEnabled(env, orgId, modKey),
        isModuleAuthorized(env, orgId, modKey),
      ]);
      if (!enabled || !authorized) { skipped++; continue; }

      // Consent boundary: stop automating once the signed monthly cap is
      // spent. The takedown stays 'draft' for ops/manual handling.
      let capStatus = capByOrg.get(orgId);
      if (!capStatus) {
        capStatus = await isUnderMonthlyTakedownCap(env, orgId);
        capByOrg.set(orgId, capStatus);
      }
      if (!capStatus.under) {
        skipped++;
        if (!capNotifiedOrgs.has(orgId)) {
          capNotifiedOrgs.add(orgId);
          const month = new Date().toISOString().slice(0, 7);
          const { createNotification } = await import("../lib/notifications");
          await createNotification(env, {
            type:     "takedown_monthly_cap_reached",
            severity: "medium",
            title:    "Takedown automation paused — monthly cap reached",
            message:  `Automated takedown submissions for this month are at the signed limit (${capStatus.used}/${capStatus.cap}). New takedowns stay in draft until next month, or raise the cap by re-signing the takedown authorization.`,
            audience: "tenant",
            brandId:  row.brand_id,
            orgId:    String(orgId),
            groupKey: `takedown_monthly_cap_reached:org_${orgId}:${month}`,
            metadata: { org_id: orgId, used: capStatus.used, cap: capStatus.cap },
          }).catch((err) => {
            console.error(`[Sparrow] cap notification failed for org ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        continue;
      }

      const providerRow = await env.DB.prepare(
        `SELECT id, provider_name, provider_type, abuse_email, abuse_url,
                abuse_api_url, abuse_api_type, auto_submit_enabled
         FROM takedown_providers
         WHERE provider_name = ?
         LIMIT 1`,
      ).bind(row.provider_name as string).first<{
        id:                  number;
        provider_name:       string;
        provider_type:       string;
        abuse_email:         string | null;
        abuse_url:           string | null;
        abuse_api_url:       string | null;
        abuse_api_type:      string | null;
        auto_submit_enabled: number;
      }>();

      if (!providerRow || providerRow.auto_submit_enabled !== 1) { skipped++; continue; }

      const { result } = await dispatchSubmission(
        env,
        {
          id:                     row.id,
          org_id:                 orgId,
          brand_id:               row.brand_id,
          module_key:             modKey,
          target_type:            row.target_type,
          target_value:           row.target_value,
          target_url:             row.target_url,
          evidence_summary:       row.evidence_summary,
          evidence_detail:        row.evidence_detail,
          provider_name:          row.provider_name,
          provider_abuse_contact: row.provider_abuse_contact,
          provider_method:        row.provider_method,
          severity:               row.severity,
        },
        providerRow,
      );

      if (result.outcome === "failed" || result.outcome === "rejected") {
        skipped++;
        continue;
      }

      await env.DB.prepare(
        `UPDATE takedown_requests
         SET status = 'submitted',
             submitted_at = datetime('now'),
             updated_at   = datetime('now')
         WHERE id = ? AND status = 'draft'`,
      ).bind(row.id).run();
      submitted++;

      // In-run cap accounting: only live sends (outcome='submitted')
      // consume cap — queued drafts don't (they're not outbound).
      if (result.outcome === "submitted" && capStatus.cap !== null) {
        capStatus.used += 1;
        capStatus.under = capStatus.used < capStatus.cap;
      }
    } catch (err) {
      console.error(`[Sparrow] Phase G dispatch failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  return { submitted, skipped };
}

// ─── Phase H: SLA-Breach Follow-Ups ─────────────────────────────────
//
// Picks up to PHASE_H_BATCH takedowns where:
//   - status = 'submitted' AND submitted_at IS NOT NULL
//   - the org's takedown_authorizations.scope_json carries a non-null
//     auto_followup_breached_sla_hours
//   - submitted_at + N hours < now (SLA breached)
//   - no follow-up has been recorded since the last submission attempt
//     (dedup against repeat fires)
//   - module_key still authorized + entitled (defensive — same gates
//     as Phase G; an org may have revoked since the original submit)
//
// For each match we call followupDraftSubmitter.submitFollowup() and
// write a takedown_submissions row with submitter_kind='followup_email_draft'.
// We do NOT advance takedown_requests.status — the takedown stays
// 'submitted' until the provider acks (or Phase F flips it to 'taken_down'
// after a domain check), regardless of how many follow-ups we send.

const PHASE_H_BATCH = 10;

interface PhaseHRow {
  id:                     string;
  org_id:                 number;
  brand_id:               string;
  module_key:             string;
  target_type:            string;
  target_value:           string;
  target_url:             string | null;
  evidence_summary:       string;
  evidence_detail:        string | null;
  provider_name:          string | null;
  provider_abuse_contact: string | null;
  provider_method:        string | null;
  severity:               string;
  submitted_at:           string;
  scope_json:             string;
  prior_ticket_id:        string | null;
}

async function runPhaseHAutoFollowup(env: Env): Promise<{ followups: number; skipped: number }> {
  // Find breached takedowns by joining each row to the org's active
  // authorization, extracting the SLA hours from scope_json, and
  // excluding rows that already have a follow-up since the last
  // submission attempt.
  //
  // Inlined (no CTE) because the static SQL extractor in
  // scripts/build-architect-manifest.ts treats `FROM <name>` as a
  // table reference, and a CTE alias would show up as a phantom
  // table in the drift gate.
  const candidates = await env.DB.prepare(
    `SELECT
       tr.id, tr.org_id, tr.brand_id, tr.module_key,
       tr.target_type, tr.target_value, tr.target_url,
       tr.evidence_summary, tr.evidence_detail,
       tr.provider_name, tr.provider_abuse_contact, tr.provider_method,
       tr.severity, tr.submitted_at,
       ta.scope_json,
       (SELECT ts.ticket_id FROM takedown_submissions ts
         WHERE ts.takedown_id = tr.id AND ts.ticket_id IS NOT NULL
         ORDER BY ts.attempted_at DESC LIMIT 1) AS prior_ticket_id
     FROM takedown_requests tr
     JOIN takedown_authorizations ta ON ta.org_id = tr.org_id AND ta.status = 'active'
     WHERE tr.status       = 'submitted'
       AND tr.submitted_at IS NOT NULL
       AND tr.org_id       IS NOT NULL
       AND tr.module_key   IS NOT NULL
       AND json_extract(ta.scope_json, '$.auto_followup_breached_sla_hours') IS NOT NULL
       AND datetime(
             tr.submitted_at,
             '+' || CAST(json_extract(ta.scope_json, '$.auto_followup_breached_sla_hours') AS INTEGER) || ' hours'
           ) < datetime('now')
       AND NOT EXISTS (
         SELECT 1 FROM takedown_submissions ts
         WHERE ts.takedown_id = tr.id
           AND ts.submitter_kind LIKE 'followup_%'
           AND ts.attempted_at > tr.submitted_at
       )
     ORDER BY tr.submitted_at ASC
     LIMIT ?`,
  ).bind(PHASE_H_BATCH).all<PhaseHRow>();

  let followups = 0;
  let skipped   = 0;

  const { isModuleAuthorized } = await import("../lib/takedown-authorizations");
  const { isModuleEnabled }    = await import("../lib/entitlements");
  const { followupDraftSubmitter, recordSubmissionAttempt } = await import("../lib/takedown-submitters");
  type ModuleKey = Parameters<typeof isModuleAuthorized>[2];

  for (const row of candidates.results ?? []) {
    try {
      const modKey = row.module_key as ModuleKey;

      // Defensive re-check: the org may have revoked authorization since
      // the original submit. Don't pile on follow-ups for a takedown the
      // customer has revoked consent for.
      const [enabled, authorized] = await Promise.all([
        isModuleEnabled(env, row.org_id, modKey),
        isModuleAuthorized(env, row.org_id, modKey),
      ]);
      if (!enabled || !authorized) { skipped++; continue; }

      const providerRow = row.provider_name
        ? await env.DB.prepare(
            `SELECT id, provider_name, provider_type, abuse_email, abuse_url,
                    abuse_api_url, abuse_api_type, auto_submit_enabled
             FROM takedown_providers
             WHERE provider_name = ?
             LIMIT 1`,
          ).bind(row.provider_name).first<{
            id:                  number;
            provider_name:       string;
            provider_type:       string;
            abuse_email:         string | null;
            abuse_url:           string | null;
            abuse_api_url:       string | null;
            abuse_api_type:      string | null;
            auto_submit_enabled: number;
          }>()
        : null;

      if (!providerRow) { skipped++; continue; }

      // Compute hoursElapsed for the email body. SQLite already verified
      // SLA breach in the CTE so this should be > sla_hours.
      const submittedAt = new Date(row.submitted_at);
      const hoursElapsed = Math.max(
        0,
        Math.floor((Date.now() - submittedAt.getTime()) / (60 * 60 * 1000)),
      );

      const result = await followupDraftSubmitter.submitFollowup(
        env,
        {
          id:                     row.id,
          org_id:                 row.org_id,
          brand_id:               row.brand_id,
          module_key:             modKey,
          target_type:            row.target_type,
          target_value:           row.target_value,
          target_url:             row.target_url,
          evidence_summary:       row.evidence_summary,
          evidence_detail:        row.evidence_detail,
          provider_name:          row.provider_name,
          provider_abuse_contact: row.provider_abuse_contact,
          provider_method:        row.provider_method,
          severity:               row.severity,
        },
        providerRow,
        {
          originalSubmittedAt: row.submitted_at,
          priorTicketId:       row.prior_ticket_id,
          hoursElapsed,
        },
      );

      await recordSubmissionAttempt(env, row.id, providerRow.id, result);
      followups++;
    } catch (err) {
      console.error(`[Sparrow] Phase H follow-up failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  return { followups, skipped };
}
