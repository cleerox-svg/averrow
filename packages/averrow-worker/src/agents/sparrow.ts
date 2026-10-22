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
    { kind: "d1_table", name: "abuse_inbox_messages" },
    { kind: "d1_table", name: "app_store_listings" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "dark_web_mentions" },
    { kind: "d1_table", name: "lookalike_domains" },
    { kind: "d1_table", name: "org_brands" },
    { kind: "d1_table", name: "social_mentions" },
    { kind: "d1_table", name: "social_profiles" },
    { kind: "d1_table", name: "takedown_authorizations" },
    { kind: "d1_table", name: "threats" },
    { kind: "d1_table", name: "takedown_evidence" },
    { kind: "d1_table", name: "takedown_providers" },
    { kind: "d1_table", name: "takedown_requests" },
    { kind: "d1_table", name: "takedown_submissions" },
    { kind: "d1_table", name: "url_scan_results" },
  ],
  writes: [
    { kind: "d1_table", name: "abuse_inbox_messages" },
    { kind: "d1_table", name: "lookalike_domains" },
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

    // Each creator below catches and counts a per-candidate write failure
    // instead of throwing, so one bad row can't fail the whole run (a NULL
    // brand_id on one abuse-report candidate auto-paused Sparrow in 2026-06).
    // The tallies are surfaced on the run at the end of execute()
    // (degraded on some failures, thrown when every candidate failed).
    // ── Phase B: Auto-create takedowns from malicious URL scan results ──
    const urlTally = await createTakedownsFromMaliciousUrls(env);
    const urlTakedowns = urlTally.created;

    // ── Phase C: Auto-create takedowns from impersonation social profiles ──
    const socialTally = await createTakedownsFromImpersonations(env);
    const socialTakedowns = socialTally.created;

    // ── Phase C2: Auto-create takedowns from app-store impersonations ──
    const appStoreTally = await createTakedownsFromAppStoreImpersonations(env);
    const appStoreTakedowns = appStoreTally.created;

    // ── Phase C3: Auto-create takedowns from confirmed dark-web mentions ──
    const darkWebTally = await createTakedownsFromDarkWebMentions(env);
    const darkWebTakedowns = darkWebTally.created;

    // ── Phase B2: Auto-create takedowns from active lookalike/typosquat domains ──
    const lookalikeTally = await createTakedownsFromLookalikes(env);
    const lookalikeTakedowns = lookalikeTally.created;

    // ── Phase B3: Auto-create takedowns from abuse-mailbox-confirmed phishing ──
    const abuseTally = await createTakedownsFromAbuseReports(env);
    const abuseTakedowns = abuseTally.created;

    itemsCreated += urlTakedowns + socialTakedowns + appStoreTakedowns + darkWebTakedowns + lookalikeTakedowns + abuseTakedowns;

    const draftTallies: Record<string, DraftTally> = {
      url: urlTally,
      social: socialTally,
      app_store: appStoreTally,
      dark_web: darkWebTally,
      lookalike: lookalikeTally,
      abuse_report: abuseTally,
    };
    const draftFailures = Object.values(draftTallies).reduce((n, t) => n + t.failed, 0);
    const draftsCreated = Object.values(draftTallies).reduce((n, t) => n + t.created, 0);
    const firstDraftError = Object.values(draftTallies).find((t) => t.firstError !== null)?.firstError ?? null;
    if (draftFailures > 0) {
      outputs.push({
        type: "diagnostic",
        summary: `${draftFailures} takedown draft candidate(s) failed to write and were skipped${firstDraftError ? ` (first: ${firstDraftError})` : ""}`,
        severity: "high",
        details: Object.fromEntries(
          Object.entries(draftTallies).map(([k, t]) => [k, { created: t.created, failed: t.failed, first_error: t.firstError }]),
        ),
      });
    }

    if (urlTakedowns > 0 || socialTakedowns > 0 || appStoreTakedowns > 0 || darkWebTakedowns > 0 || lookalikeTakedowns > 0 || abuseTakedowns > 0) {
      const totalNew = urlTakedowns + socialTakedowns + appStoreTakedowns + darkWebTakedowns + lookalikeTakedowns + abuseTakedowns;
      outputs.push({
        type: "insight",
        summary: `Created ${totalNew} takedown drafts (${urlTakedowns} URL, ${socialTakedowns} social, ${appStoreTakedowns} app-store, ${darkWebTakedowns} dark-web, ${lookalikeTakedowns} lookalike, ${abuseTakedowns} abuse-report)`,
        severity: totalNew > 5 ? "high" : "medium",
        details: {
          url_takedowns: urlTakedowns,
          social_takedowns: socialTakedowns,
          app_store_takedowns: appStoreTakedowns,
          dark_web_takedowns: darkWebTakedowns,
          lookalike_takedowns: lookalikeTakedowns,
          abuse_report_takedowns: abuseTakedowns,
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
        const { resolveProvider, generateSubmissionDraft, preferredDomainReportingProvider } = await import("../lib/provider-resolver");
        const providerInfo = await resolveProvider(env, td.target_value as string);

        // Domain takedowns route to NetBeacon (registrar fan-out) when it's
        // dispatchable; otherwise keep the resolved host/registrar contact.
        const netbeacon = (td.target_type as string) === "domain"
          ? await preferredDomainReportingProvider(env)
          : null;
        const abuseContact = netbeacon ?? providerInfo.abuse_contact;
        const providerName = netbeacon ? netbeacon.provider_name : providerInfo.hosting_provider;

        const updates: string[] = [];
        const values: unknown[] = [];

        // NetBeacon override (re)asserts the routing columns unconditionally;
        // the host path keeps its original "only fill when empty" semantics.
        if (netbeacon) {
          updates.push("provider_name = ?");
          values.push(netbeacon.provider_name);
        } else if (providerName && !td.provider_name) {
          updates.push("provider_name = ?");
          values.push(providerName);
        }
        if (abuseContact?.abuse_email || abuseContact?.abuse_url) {
          updates.push("provider_abuse_contact = ?");
          values.push(abuseContact.abuse_email || abuseContact.abuse_url);
        }
        if (abuseContact?.abuse_api_type) {
          updates.push("provider_method = ?");
          values.push(abuseContact.abuse_api_type);
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
          abuseContact,
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
              }, { env });
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
    let autoSubmitSkippedBrandNotOwned = 0;
    try {
      const phaseG = await runPhaseGAutoSubmit(env);
      autoSubmitted     = phaseG.submitted;
      autoSubmitSkipped = phaseG.skipped;
      autoSubmitSkippedBrandNotOwned = phaseG.skipped_brand_not_owned;
      if (autoSubmitted > 0) {
        outputs.push({
          type: "insight",
          summary: `Auto-submitted ${autoSubmitted} takedown draft(s) via the dispatcher`,
          severity: "info",
          details: { submitted: autoSubmitted, skipped: autoSubmitSkipped, skipped_brand_not_owned: autoSubmitSkippedBrandNotOwned },
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

    // Surface caught draft failures on the run itself (checked after the
    // later phases so existing drafts are still verified/submitted):
    //   every candidate failed and none was drafted → throw, so agent_runs
    //     records 'failed' + error_message and the circuit breaker counts it;
    //   some failed → degraded ('partial' with completed_at set), so a source
    //     whose candidates all fail while others succeed is still visible.
    // A degraded/failed run is also the visibility mitigation for a
    // permanently-failing candidate that keeps its LIMIT-10 slot (see the
    // note at createTakedownsFromAbuseReports' selection).
    if (draftFailures > 0 && draftsCreated === 0) {
      throw new Error(`sparrow: all ${draftFailures} takedown draft candidate(s) failed; first: ${firstDraftError ?? "unknown"}`);
    }
    const degraded = draftFailures > 0
      ? { reason: `${draftFailures} takedown draft candidate(s) failed (${draftsCreated} created); first: ${firstDraftError ?? "unknown"}` }
      : undefined;

    return {
      ...(degraded ? { degraded } : {}),
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
        lookalike_takedowns: lookalikeTakedowns,
        abuse_report_takedowns: abuseTakedowns,
        takedown_draft_failures: draftFailures,
        evidence_assembled: evidenceAssembled,
        social_evidence_attached: socialEvidenceAttached,
        providers_resolved: providersResolved,
        takedown_domains_verified: domainsVerified,
        takedown_domains_resurrected: domainsResurrected,
        auto_submitted: autoSubmitted,
        auto_submit_skipped: autoSubmitSkipped,
        auto_submit_skipped_brand_not_owned: autoSubmitSkippedBrandNotOwned,
        followups_fired: followupsFired,
      },
      agentOutputs: outputs,
    };
  },
};

// ─── Phase B: Malicious URL → Takedown ─────────────────────────────

async function createTakedownsFromMaliciousUrls(env: Env): Promise<DraftTally> {
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

  const tally = newDraftTally();

  for (const result of unlinkedMalicious.results) {
    try {
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
      // One atomic batch (draft + link + evidence): a failure rolls the
      // candidate back whole, so the unlinked row is retried next run
      // instead of leaving an orphan draft that would be re-drafted.
      await env.DB.batch([env.DB.prepare(`
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
      ),

      // Link the scan result to the takedown
      env.DB.prepare(
        "UPDATE url_scan_results SET takedown_id = ? WHERE id = ?"
      ).bind(takedownId, result.id),

      // Create evidence record
      env.DB.prepare(`
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
      )]);

      tally.created++;
    } catch (err) {
      recordDraftFailure(tally, "url_scan", result.id, err);
    }
  }

  return tally;
}

// ─── Phase B2: Active Lookalike / Typosquat Domain → Takedown ──────
//
// Close the loop. HIGH/CRITICAL lookalike domains surfaced by the
// lookalike scanner were previously a detect-and-alert dead end — never
// wired into the takedown system. This drafts a takedown for each active
// (registered + resolving) HIGH/CRITICAL lookalike, which then flows
// through the SAME pipeline as every other source: Phase E resolves the
// provider, Phase G submits ONLY if the org's signed `domain`
// authorization + policy mode + caps permit. This adds drafts; it does
// not bypass any consent gate.
//
// Only org-owned brands are drafted (owner decision 2026-10-22: "candidates
// ONLY from org-owned brands"; an orgless draft would be skipped by Phase G
// and just litter the queue). Ownership is decided IN the selection, not
// after it: the old shape took the top 10 rows across ALL brands and only
// then dropped orgless ones, and with ~4.2K eligible lookalikes of which 4
// were org-owned every run's 10 slots went to unowned brands — 0 lookalike
// drafts were ever created. The predicate is owningOrgIdSql(), the same
// subquery resolveOwningOrgId runs, so "owned" (earliest claimant — see
// owningOrgIdSql) has one definition across every Sparrow phase. Drafts
// always land in the RESOLVED owner's org, never in whichever org happened
// to trigger the run.
//
// Order: CRITICAL before HIGH, then oldest first (first_seen ASC, id as the
// tie-break). Every drafted row leaves the set (takedown_id link), so the
// owned backlog drains deterministically at LOOKALIKE_DRAFT_LIMIT per run.
// A brand that becomes owned is also drafted immediately by
// createTakedownsFromLookalikesForBrand (called from the org_brands insert
// paths via lib/lookalike-ownership-drafts.ts) instead of waiting up to 6h —
// but only when the inserting org IS the resolved owner, so a later claimant
// of an already-owned brand can't pull its drafts into its own org.
//
// Each row is drafted at most once even when the cron and an ownership hook
// race: the draft insert and the link update are both conditional on
// `takedown_id IS NULL` inside one atomic batch, and the evidence row is
// conditional on the draft existing. Only registered domains with a live
// web/MX footprint qualify. Drafting only — Phase G's authorization, policy
// and caps decide any submission.
export async function createTakedownsFromLookalikes(env: Env): Promise<DraftTally> {
  return draftOwnedLookalikeTakedowns(env, null);
}

/**
 * Brand-scoped Phase B2, run when `orgId` has just claimed `brandId` so its
 * lookalike drafts start immediately. Same selection (plus the brand filter
 * AND `owningOrgIdSql(brand) = orgId`), same insert code, same per-call
 * limit. Drafts nothing when `orgId` is not the brand's resolved owner (e.g.
 * a later claimant of a brand another org already owns) — the hook can never
 * draft into a different org than resolution picks. A second call is a no-op
 * because drafted rows carry takedown_id. Throws only if the selection read
 * fails — per-candidate write failures are tallied like the cron path.
 */
export async function createTakedownsFromLookalikesForBrand(env: Env, brandId: string, orgId: number): Promise<DraftTally> {
  return draftOwnedLookalikeTakedowns(env, { brandId, orgId });
}

const LOOKALIKE_DRAFT_LIMIT = 10;

async function draftOwnedLookalikeTakedowns(
  env: Env,
  scope: { brandId: string; orgId: number } | null,
): Promise<DraftTally> {
  const owningOrg = owningOrgIdSql("ld.brand_id");
  const select = env.DB.prepare(`
    SELECT ld.id, ld.brand_id, ld.domain, ld.permutation_type,
           ld.threat_level, ld.ai_assessment, ld.has_mx, ld.has_web,
           ld.resolves_to, b.name AS brand_name,
           ${owningOrg} AS owning_org_id
    FROM lookalike_domains ld
    JOIN brands b ON b.id = ld.brand_id
    WHERE ld.registered = 1
      AND ld.takedown_id IS NULL
      AND ld.threat_level IN ('HIGH', 'CRITICAL')
      AND ld.status NOT IN ('benign', 'taken_down')
      AND (ld.has_web = 1 OR ld.has_mx = 1)
      AND ${owningOrg} IS NOT NULL
      ${scope === null ? "" : `AND ld.brand_id = ? AND ${owningOrg} = ?`}
    ORDER BY CASE ld.threat_level WHEN 'CRITICAL' THEN 0 ELSE 1 END, ld.first_seen ASC, ld.id ASC
    LIMIT ${LOOKALIKE_DRAFT_LIMIT}
  `);
  const candidates = await (scope === null ? select : select.bind(scope.brandId, scope.orgId)).all();

  const tally = newDraftTally();

  for (const ld of candidates.results) {
    try {
      const candidateBrandId = ld.brand_id as string;
      const owningOrgId = ld.owning_org_id as number;

      const domain = ld.domain as string;
      const threatLevel = (ld.threat_level as string) || "HIGH";
      const permutationType = (ld.permutation_type as string) || "lookalike";
      const brandName = (ld.brand_name as string) || "a monitored brand";
      const signals = [
        ld.has_web ? "live web server" : null,
        ld.has_mx ? "mail (MX) records" : null,
        ld.resolves_to ? `resolves to ${ld.resolves_to}` : null,
      ].filter(Boolean).join(", ");

      const takedownId = crypto.randomUUID();
      // Atomic draft + link + evidence (same reasoning as Phase B). Every
      // statement is conditional, so if a concurrent drafter (cron vs
      // ownership hook) already linked this row the batch writes nothing
      // instead of a duplicate draft.
      const results = await env.DB.batch([env.DB.prepare(`
        INSERT INTO takedown_requests (
          id, org_id, brand_id, module_key, target_type, target_value, target_url,
          source_type, source_id, evidence_summary, evidence_detail,
          provider_name, provider_abuse_contact, provider_method,
          status, severity, priority_score, requested_by, created_at, updated_at
        )
        SELECT ?, ?, ?, 'domain', 'domain', ?, null, 'lookalike', ?, ?, ?, null, null, 'email', 'draft', ?, ?, null, datetime('now'), datetime('now')
        WHERE EXISTS (SELECT 1 FROM lookalike_domains WHERE id = ? AND takedown_id IS NULL)
      `).bind(
        takedownId,
        owningOrgId,
        candidateBrandId,
        domain,
        String(ld.id),
        `Active ${permutationType} lookalike domain impersonating ${brandName}: ${domain}${signals ? ` (${signals})` : ""}.`,
        `Domain: ${domain}\nPermutation: ${permutationType}\nThreat level: ${threatLevel}\nSignals: ${signals || "registered"}${ld.ai_assessment ? `\nAssessment: ${ld.ai_assessment}` : ""}`,
        threatLevel === "CRITICAL" ? "CRITICAL" : "HIGH",
        threatLevel === "CRITICAL" ? 80 : 65,
        ld.id,
      ),

      // Link back so we don't re-draft + the lookalike UI can show status.
      env.DB.prepare(
        "UPDATE lookalike_domains SET takedown_id = ? WHERE id = ? AND takedown_id IS NULL"
      ).bind(takedownId, ld.id),

      // Evidence record (mirrors Phase B), only for a draft this batch wrote.
      env.DB.prepare(`
        INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
        SELECT ?, ?, 'lookalike', 'Lookalike Domain Detection', ?, ?, datetime('now')
        WHERE EXISTS (SELECT 1 FROM takedown_requests WHERE id = ?)
      `).bind(
        crypto.randomUUID(),
        takedownId,
        `Domain: ${domain}\nPermutation type: ${permutationType}\nThreat level: ${threatLevel}\nRegistered: Yes\nSignals: ${signals || "registered"}`,
        JSON.stringify({
          domain,
          permutation_type: permutationType,
          threat_level: threatLevel,
          has_mx: ld.has_mx,
          has_web: ld.has_web,
          resolves_to: ld.resolves_to,
          lookalike_id: ld.id,
        }),
        takedownId,
      )]);

      // A lost race wrote nothing — neither a draft nor a failure.
      if (Number(results[0]?.meta?.changes ?? 0) > 0) tally.created++;
    } catch (err) {
      recordDraftFailure(tally, "lookalike", ld.id, err);
    }
  }

  return tally;
}

// ─── Phase B3: Abuse-Mailbox Confirmed Phishing → Takedown ─────────
//
// Close the loop, part 2. When a phish is reported to the Abuse Mailbox and
// the classifier confirms it (HIGH/CRITICAL phishing|malware), the malicious
// URLs are promoted to `threats` (promoted_threat_ids) — but were never
// connected to takedown, so a reported+confirmed phish wasn't actually
// actioned. This drafts a takedown for each promoted malicious URL.
//
// Same safety model as every source: drafts (module_key='domain') flow
// through Phase E (provider resolve) → Phase G (auth/policy/cap-gated
// submit). The abuse message already carries org_id (alias→org), so we use
// it directly. Each message is processed once (takedown_drafted_at stamp),
// and we skip domains the org already has an active takedown for (avoids
// double-actioning a domain Phase B/B2 drafted).
//
// Brandless messages are excluded at selection: takedown_requests.brand_id
// is NOT NULL, and a message the classifier couldn't tie to a brand has no
// one to file on behalf of. Before this filter, one such message made the
// INSERT throw (SQLITE_CONSTRAINT_NOTNULL) on every run, failing Sparrow
// three times in a row on 2026-06-30 until it auto-paused. They are left
// unstamped, so a message later attributed to a brand is picked up then.
//
// Known limit (accepted, no attempt counter): a message whose draft write
// fails every time is never stamped and keeps its slot in this fixed-order
// LIMIT 10, so ten such messages would starve newer reports (the url_scan /
// lookalike / social / app-store / dark-web selections share the shape).
// It cannot happen silently: any caught failure finalizes the run 'partial'
// (AgentResult.degraded) or, when nothing was drafted, 'failed' — see the
// end of execute().
export async function createTakedownsFromAbuseReports(env: Env): Promise<DraftTally> {
  const messages = await env.DB.prepare(`
    SELECT id, org_id, brand_id, classification, severity, promoted_threat_ids
    FROM abuse_inbox_messages
    WHERE classification IN ('phishing', 'malware')
      AND severity IN ('HIGH', 'CRITICAL')
      AND org_id IS NOT NULL
      AND brand_id IS NOT NULL
      AND promoted_threat_ids IS NOT NULL
      -- An open-model "likely" verdict is never takedown evidence, even if
      -- a future path were to promote its URLs.
      AND COALESCE(classified_by, '') <> 'workers_ai'
      AND takedown_drafted_at IS NULL
    ORDER BY received_at DESC
    LIMIT 10
  `).all<{
    id: string; org_id: number; brand_id: string;
    classification: string; severity: string; promoted_threat_ids: string | null;
  }>();

  const tally = newDraftTally();

  for (const msg of messages.results) {
    // A message is stamped only when every promoted threat was handled, so a
    // failed draft is retried next run (the open-takedown check below keeps
    // the retry from double-drafting the domains that did succeed).
    let messageFailed = false;
    try {
      let threatIds: string[] = [];
      try {
        const parsed = JSON.parse(msg.promoted_threat_ids || "[]");
        if (Array.isArray(parsed)) threatIds = parsed.filter((x): x is string => typeof x === "string");
      } catch { threatIds = []; }

      if (threatIds.length > 0) {
        const promoted = await loadPromotedThreats(env, threatIds);

        const severity = msg.severity === "CRITICAL" ? "CRITICAL" : "HIGH";

        for (const t of promoted) {
          const domain = t.malicious_domain;
          if (!domain) continue;
          const url = t.malicious_url;

          try {
            // Don't double-action a domain the org already has an open takedown
            // for (Phase B/B2 may have drafted it, or a prior abuse report).
            const existing = await env.DB.prepare(
              `SELECT 1 FROM takedown_requests
               WHERE org_id = ? AND target_value = ?
                 AND status NOT IN ('failed', 'expired', 'withdrawn')
               LIMIT 1`,
            ).bind(msg.org_id, domain).first();
            if (existing) continue;

            const takedownId = crypto.randomUUID();
            // Atomic draft + evidence: a failure leaves neither behind.
            await env.DB.batch([
              env.DB.prepare(`
                INSERT INTO takedown_requests (
                  id, org_id, brand_id, module_key, target_type, target_value, target_url,
                  source_type, source_id, evidence_summary, evidence_detail,
                  provider_name, provider_abuse_contact, provider_method,
                  status, severity, priority_score, requested_by, created_at, updated_at
                ) VALUES (?, ?, ?, 'domain', 'url', ?, ?, 'abuse_report', ?, ?, ?, null, null, 'email', 'draft', ?, ?, null, datetime('now'), datetime('now'))
              `).bind(
                takedownId,
                msg.org_id,
                msg.brand_id,
                domain,
                url,
                msg.id,
                `Confirmed ${msg.classification} reported to the Abuse Mailbox: ${url ?? domain}.`,
                `Domain: ${domain}\nURL: ${url ?? "—"}\nClassification: ${msg.classification}\nSeverity: ${msg.severity}\nSource: customer abuse report (ref ${msg.id})`,
                severity,
                severity === "CRITICAL" ? 85 : 70,
              ),
              env.DB.prepare(`
                INSERT INTO takedown_evidence (id, takedown_id, evidence_type, title, content_text, metadata_json, created_at)
                VALUES (?, ?, 'abuse_report', 'Abuse Mailbox Report', ?, ?, datetime('now'))
              `).bind(
                crypto.randomUUID(),
                takedownId,
                `Reported to the Abuse Mailbox and AI-confirmed as ${msg.classification} (${msg.severity}).\nDomain: ${domain}\nURL: ${url ?? "—"}`,
                JSON.stringify({
                  abuse_message_id: msg.id,
                  threat_id: t.id,
                  classification: msg.classification,
                  severity: msg.severity,
                  domain,
                  url,
                }),
              ),
            ]);

            tally.created++;
          } catch (err) {
            messageFailed = true;
            recordDraftFailure(tally, "abuse_report", `${msg.id}/${t.id}`, err);
          }
        }
      }

      // Mark processed regardless of how many drafts resulted, so the message
      // isn't re-scanned every run — unless a draft failed and should retry.
      if (!messageFailed) {
        await env.DB.prepare(
          `UPDATE abuse_inbox_messages SET takedown_drafted_at = datetime('now') WHERE id = ?`,
        ).bind(msg.id).run();
      }
    } catch (err) {
      recordDraftFailure(tally, "abuse_report", msg.id, err);
    }
  }

  return tally;
}

// D1 caps a statement at 100 bound parameters; a message's promoted_threat_ids
// list is unbounded, so the IN lookup is chunked (same 90 as
// lib/cluster-attribution-inherit.ts IN_CHUNK). Ids are de-duplicated first —
// IN already ignores duplicates, so the returned rows are unchanged.
const PROMOTED_IN_CHUNK = 90;

async function loadPromotedThreats(
  env: Env,
  threatIds: string[],
): Promise<Array<{ id: string; malicious_url: string | null; malicious_domain: string | null }>> {
  const ids = [...new Set(threatIds)];
  const out: Array<{ id: string; malicious_url: string | null; malicious_domain: string | null }> = [];
  for (let i = 0; i < ids.length; i += PROMOTED_IN_CHUNK) {
    const part = ids.slice(i, i + PROMOTED_IN_CHUNK);
    const rows = await env.DB.prepare(
      `SELECT id, malicious_url, malicious_domain FROM threats WHERE id IN (${part.map(() => "?").join(",")})`,
    ).bind(...part).all<{ id: string; malicious_url: string | null; malicious_domain: string | null }>();
    out.push(...rows.results);
  }
  return out;
}

// ─── Phase C: Impersonation Profiles → Takedown ────────────────────

export async function createTakedownsFromImpersonations(env: Env): Promise<DraftTally> {
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

  const tally = newDraftTally();

  for (const profile of impersonations.results) {
    try {
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
      // Atomic draft + evidence: the dedup is `id NOT IN (SELECT source_id
      // FROM takedown_requests …)`, so a draft committed without its evidence
      // could never be redrafted. A failure rolls both back.
      await env.DB.batch([env.DB.prepare(`
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
      ),

      // Create evidence record
      env.DB.prepare(`
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
      )]);

      tally.created++;
    } catch (err) {
      recordDraftFailure(tally, "social_profile", profile.id, err);
    }
  }

  return tally;
}

// ─── Phase C2: App-Store Impersonations → Takedown ────────────────

export async function createTakedownsFromAppStoreImpersonations(env: Env): Promise<DraftTally> {
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
    return newDraftTally();
  }

  const tally = newDraftTally();

  for (const row of impersonations.results) {
    try {
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
      // Atomic draft + evidence (same NOT IN dedup reasoning as Phase C).
      await env.DB.batch([env.DB.prepare(`
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
      ),

      // Evidence record mirrors the pattern used for social profiles.
      env.DB.prepare(`
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
      )]);

      tally.created++;
    } catch (err) {
      recordDraftFailure(tally, "app_store", row.id, err);
    }
  }

  return tally;
}

// ─── Phase C3: Dark-Web Confirmed Mentions → Takedown ─────────────

export async function createTakedownsFromDarkWebMentions(env: Env): Promise<DraftTally> {
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
    return newDraftTally();
  }

  const tally = newDraftTally();

  for (const row of mentions.results) {
    try {
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
      // Atomic draft + evidence (same NOT IN dedup reasoning as Phase C).
      await env.DB.batch([env.DB.prepare(`
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
      ),

      env.DB.prepare(`
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
      )]);

      tally.created++;
    } catch (err) {
      recordDraftFailure(tally, "dark_web_mention", row.id, err);
    }
  }

  return tally;
}

// Need Env type for helper functions
import type { Env } from "../types";

// Per-source result of a takedown-draft creator. A candidate whose writes
// fail is counted here and skipped — never thrown out of the agent, so one
// bad row can't fail (and eventually auto-pause) the whole Sparrow run.
export interface DraftTally {
  created: number;
  failed: number;
  firstError: string | null;
}

function newDraftTally(): DraftTally {
  return { created: 0, failed: 0, firstError: null };
}

function recordDraftFailure(tally: DraftTally, source: string, candidateId: unknown, err: unknown): void {
  tally.failed++;
  if (tally.firstError === null) {
    tally.firstError = `${source} ${String(candidateId)}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Resolve the org owning a brand (owningOrgIdSql — earliest claimant), used
// by phases B/D/E/F. Returns null when the brand isn't bound to any org
// (cross-cutting threats with no tenant owner — these stay SOC-initiated and
// Phase G skips them). Exported for tests.
export async function resolveOwningOrgId(env: Env, brandId: string | null): Promise<number | null> {
  if (!brandId) return null;
  const row = await env.DB.prepare(
    `SELECT ${owningOrgIdSql("?")} AS org_id`,
  ).bind(brandId).first<{ org_id: number | null }>();
  return row?.org_id ?? null;
}

// The single definition of "the org that owns a brand": the EARLIEST
// org_brands claim (created_at, then the AUTOINCREMENT id for a same-second
// tie — both are DB-assigned, never caller-set). Shared by resolveOwningOrgId
// (phases B/D/E/F) and the Phase B2 lookalike selection + ownership hook, so
// every phase agrees on one owner.
//
// is_primary deliberately does NOT rank here. It is caller-set (any org
// admin's POST /api/orgs/:orgId/brands passes it), and org_brands is
// UNIQUE(org_id, brand_id), so it only says which of ONE org's brands is
// its primary — it says nothing about which org owns a brand. Ranking on it
// (the old is_primary-first ordering) let a later claimant with
// is_primary=1 take over a brand another org already owned and receive its
// drafts/submissions. Earliest-claimant-wins means a new claim can never
// change the owner while the original claim stands. (Verifying ownership
// on tenant assignment is a separate, pending owner decision.)
//
// `brandIdExpr` is a fixed column reference or the `?` placeholder — never
// caller data. Seeks idx_ob_brand (brand_id) and sorts that brand's few rows.
function owningOrgIdSql(brandIdExpr: "?" | "ld.brand_id"): string {
  return `(SELECT org_id FROM org_brands
     WHERE brand_id = ${brandIdExpr}
     ORDER BY created_at ASC, id ASC
     LIMIT 1)`;
}

// ─── Phase G: Auto-Submit Authorized Drafts ─────────────────────────
//
// Picks up to PHASE_G_BATCH takedowns where:
//   - status IN ('draft', 'requested')
//   - module_key + provider_name resolved (Phase E filled these in)
//   - org_id is set (SOC-initiated takedowns with no org are skipped here;
//     ops handles those manually)
//   - the org has signed an active takedown_authorizations covering the
//     module_key
//   - the matching takedown_providers row has auto_submit_enabled = 1
//   - the org's signed automation policy (scope.mode + semi_auto_rules)
//     resolves to 'auto' for the takedown — see lib/takedown-policy.ts:
//       off       → skipped (manual)
//       auto      → submitted
//       semi_auto → submitted only when severity/target/provider match the
//                   signed rules; otherwise held in 'draft' and the
//                   customer is notified that it awaits approval. A
//                   CUSTOMER-approved 'requested' row (isCustomerApproved,
//                   lib/takedown-customer-approval.ts — G21) submits in any
//                   non-off posture; a staff-set 'requested' row does not
//                   count as approved and is judged like a draft.
//
// Each match is dispatched via lib/takedown-submitters/. On any
// non-failed outcome the takedown's status flips to 'submitted'
// and submitted_at is stamped. On 'failed' the status stays put
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
  status:                 string;
  requested_at:           string | null;
  requested_by:           string | null;
  staff_severity_set_at:  string | null;
  /** 1 while org_brands(org_id, brand_id) still exists, else 0. */
  brand_owned:            number;
}

/** Exported for tests (test/sparrow-phase-g-approval.test.ts). */
export async function runPhaseGAutoSubmit(
  env: Env,
): Promise<{ submitted: number; skipped: number; skipped_brand_not_owned: number }> {
  // status='draft'     → policy decides (auto / approval-hold / off)
  // status='requested' → auto-submits in any non-off posture ONLY when the
  //                      CUSTOMER approved it (isCustomerApproved — G21); a
  //                      staff-set 'requested' is judged like a draft
  const candidates = await env.DB.prepare(
    `SELECT tr.id, tr.org_id, tr.brand_id, tr.module_key,
            tr.target_type, tr.target_value, tr.target_url,
            tr.evidence_summary, tr.evidence_detail,
            tr.provider_name, tr.provider_abuse_contact, tr.provider_method,
            tr.severity, tr.status, tr.requested_at, tr.requested_by,
            tr.staff_severity_set_at,
            EXISTS (SELECT 1 FROM org_brands ob
                     WHERE ob.org_id = tr.org_id AND ob.brand_id = tr.brand_id) AS brand_owned
     FROM takedown_requests tr
     WHERE tr.status IN ('draft', 'requested')
       AND tr.org_id IS NOT NULL
       AND tr.module_key IS NOT NULL
       AND tr.provider_name IS NOT NULL
     ORDER BY tr.priority_score DESC, tr.created_at ASC
     LIMIT ?`,
  ).bind(PHASE_G_BATCH).all<PhaseGRow>();

  let submitted = 0;
  let skipped   = 0;
  // Subset of `skipped`: the takedown's org no longer holds the brand.
  let skippedBrandNotOwned = 0;

  const { isModuleAuthorized, isUnderMonthlyTakedownCap, getActiveAuthorization } = await import("../lib/takedown-authorizations");
  const { dispatchSubmission } = await import("../lib/takedown-submitters");
  const { isModuleEnabled }    = await import("../lib/entitlements");
  const { evaluateTakedownPolicy } = await import("../lib/takedown-policy");
  const { isCustomerApproved }     = await import("../lib/takedown-customer-approval");
  type ModuleKey = Parameters<typeof isModuleAuthorized>[2];

  // Resolve each org's active authorization once per run (cached in KV
  // anyway). null → no signed scope → nothing to auto-submit.
  const authByOrg = new Map<number, Awaited<ReturnType<typeof getActiveAuthorization>>>();
  // De-dupe the "awaiting approval" notification to one per takedown per run.
  const approvalNotified = new Set<string>();

  // S1 — per-org monthly cap (scope_json.max_takedowns_per_month).
  // Resolved once per org per run, then decremented locally so a single
  // batch can't overshoot the cap. Note PHASE_G_BATCH doubles as the
  // per-run send ceiling in live mode.
  const capByOrg = new Map<number, { under: boolean; used: number; cap: number | null }>();
  const capNotifiedOrgs = new Set<number>();

  for (const row of candidates.results ?? []) {
    // Set while this row is claimed ('submitted') but the dispatch outcome is
    // not yet known — see the catch below.
    let claimedId: string | null = null;
    try {
      const orgId   = row.org_id;
      const modKey  = row.module_key as ModuleKey | null;
      if (orgId === null || modKey === null) { skipped++; continue; }

      // Brand re-check: consent (takedown_authorizations) is per org/module,
      // not per brand, so a takedown is only submitted in the org's name
      // while that org still holds the brand in org_brands. A removed claim
      // leaves the row in draft for ops. The atomic claim (further down) repeats the
      // check atomically. Indexed (UNIQUE(org_id, brand_id)), no binds.
      if (row.brand_owned !== 1) { skipped++; skippedBrandNotOwned++; continue; }

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

      // ── Policy gate (Semi-Auto control) ──────────────────────────────
      // off       → never auto-submits (fully manual).
      // auto      → always auto-submits.
      // semi_auto → auto-submits only when the takedown's characteristics
      //             match the signed rules; otherwise it's held until the
      //             CUSTOMER approves it in the tenant app (tenant PATCH
      //             draft → 'requested', stamping requested_at/requested_by).
      // A customer-approved 'requested' row submits in any non-off posture.
      // G21: approval is provenance-checked (isCustomerApproved — the one
      // definition shared with the staff send paths); a 'requested' row
      // without a valid customer stamp is judged on its characteristics like
      // a draft. A staff-edited severity (staff_severity_set_at, migration
      // 0284) counts as unknown, so it never qualifies for semi_auto.
      let auth = authByOrg.get(orgId);
      if (auth === undefined) {
        auth = await getActiveAuthorization(env, orgId);
        authByOrg.set(orgId, auth);
      }
      if (!auth) { skipped++; continue; }

      const decision = evaluateTakedownPolicy(auth.scope, {
        severity:              row.severity,
        severity_set_by_staff: row.staff_severity_set_at !== null,
        target_type:           row.target_type,
        provider_type:         providerRow.provider_type,
        human_approved:        await isCustomerApproved(env, row),
      });

      if (decision !== "auto") {
        skipped++;
        // Semi-auto hold: tell the customer a takedown is waiting on them.
        if (decision === "approval" && !approvalNotified.has(row.id)) {
          approvalNotified.add(row.id);
          const { createNotification } = await import("../lib/notifications");
          await createNotification(env, {
            type:     "takedown_awaiting_approval",
            severity: "medium",
            title:    "Takedown awaiting your approval",
            message:  `A ${row.severity} takedown for ${row.target_value} matched your semi-automatic policy's approval gate. Review and approve it from the Takedowns queue to submit, or adjust your Automation Policy.`,
            audience: "tenant",
            brandId:  row.brand_id,
            orgId:    String(orgId),
            groupKey: `takedown_awaiting_approval:${row.id}`,
            metadata: { takedown_id: row.id, org_id: orgId, severity: row.severity, target_type: row.target_type },
          }).catch((err) => {
            console.error(`[Sparrow] approval notification failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        continue;
      }

      // ── Atomic claim BEFORE dispatch (appsec M1; mirrors the staff
      // hand-submit). The policy was judged on the status read above; pin the
      // claim to exactly that status so a customer withdrawal (or any other
      // status change) between the read and now means changes=0 → no send.
      // Also pinned to the org still holding the brand (the brand re-check
      // above, repeated so a claim removal in between can't slip through).
      const claim = await env.DB.prepare(
        `UPDATE takedown_requests
         SET status = 'submitted',
             submitted_at = datetime('now'),
             updated_at   = datetime('now')
         WHERE id = ? AND status = ?
           AND EXISTS (SELECT 1 FROM org_brands ob
                        WHERE ob.org_id = takedown_requests.org_id
                          AND ob.brand_id = takedown_requests.brand_id)`,
      ).bind(row.id, row.status).run();
      if (!claim.meta || claim.meta.changes !== 1) { skipped++; continue; }
      claimedId = row.id;

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
        // The provider did not accept the report: release the claim back to
        // the status we took it from so the next tick can retry (Sparrow's
        // long-standing retry semantics; the takedown_submissions row records
        // the attempt). Pinned to 'submitted' so it never clobbers a change
        // made after our claim.
        await env.DB.prepare(
          `UPDATE takedown_requests
           SET status = ?, submitted_at = NULL, updated_at = datetime('now')
           WHERE id = ? AND status = 'submitted'`,
        ).bind(row.status, row.id).run();
        claimedId = null;
        skipped++;
        continue;
      }
      claimedId = null;
      submitted++;

      // Notify the org's data-out destinations (webhook + SIEM + ticketing)
      // that the takedown was submitted. Auto-submissions previously emitted
      // no event — only the manual/tenant handler paths did — so customer
      // systems and compliance tickets missed the auto path entirely.
      if (row.org_id != null) {
        try {
          const { emitOrgEvent } = await import("../lib/org-events");
          await emitOrgEvent(env, row.org_id, "takedown.status_changed", {
            takedown_id: row.id,
            status: "submitted",
            target: row.target_value,
            severity: row.severity,
          });
        } catch {
          /* best-effort — never fail the submit on a notification error */
        }
      }

      // In-run cap accounting: only live sends (outcome='submitted')
      // consume cap — queued drafts don't (they're not outbound).
      if (result.outcome === "submitted" && capStatus.cap !== null) {
        capStatus.used += 1;
        capStatus.under = capStatus.used < capStatus.cap;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Sparrow] Phase G dispatch failed for ${row.id}: ${message}`);
      skipped++;
      // Dispatch threw after the claim: we can't tell whether the report went
      // out, so — like the staff hand-submit — record it as 'failed'
      // (at-most-once) rather than release it for an automatic re-send.
      if (claimedId !== null) {
        await env.DB.prepare(
          `UPDATE takedown_requests
           SET status = 'failed', resolved_at = datetime('now'),
               response_notes = ?, updated_at = datetime('now')
           WHERE id = ? AND status = 'submitted'`,
        ).bind(`Auto-submit dispatch error: ${message}`.slice(0, 1000), claimedId).run().catch(() => {});
      }
    }
  }

  return { submitted, skipped, skipped_brand_not_owned: skippedBrandNotOwned };
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

/** Exported for tests (test/takedown-consent-integration.test.ts). */
export async function runPhaseHAutoFollowup(env: Env): Promise<{ followups: number; skipped: number }> {
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
