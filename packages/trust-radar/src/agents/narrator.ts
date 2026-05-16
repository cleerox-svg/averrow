/**
 * Narrator Agent — AI-powered threat narrative generation.
 *
 * Correlates multiple threat signals (phishing, lookalike domains, social
 * impersonation, email security, CT certificates) for a brand into a
 * coherent attack narrative with stage identification and recommendations.
 */

import type { Env } from "../types";
import { createAlert } from "../lib/alerts";
import { checkCostGuard } from "../lib/haiku";
import { callAnthropicJSON } from "../lib/anthropic";
import { HOT_PATH_HAIKU } from "../lib/ai-models";
import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

// ─── Types ────────────────────────────────────────────────────────

interface NarrativeContext {
  threats: any[];
  emailSecurity: any;
  socialFindings: any[];
  lookalikes: any[];
  ctCertificates: any[];
  appStoreListings: any[];
  darkWebMentions: any[];
}

interface NarrativeResult {
  title: string;
  narrative: string;
  summary: string;
  severity: string;
  attackStage: string;
  recommendations: string[];
}

// ─── Core narrative generation ────────────────────────────────────

export async function generateThreatNarrative(
  env: Env,
  brandId: string,
  context: NarrativeContext,
): Promise<NarrativeResult> {
  const signalSummary = buildSignalSummary(context);

  const systemPrompt = `You are a senior threat intelligence analyst writing an internal threat narrative for a brand protection team.

Your task is to synthesize multiple threat signals into a coherent attack narrative. You must:
1. Connect signals that might indicate coordinated activity (e.g., lookalike domain registered + phishing emails + social impersonation appearing together).
2. Identify the attack stage:
   - "reconnaissance" — Attacker is probing (CT certs issued, lookalike domains registered but not active yet)
   - "weaponization" — Infrastructure being prepared (lookalike domains with content, email spoofing capability due to weak DMARC)
   - "delivery" — Active attacks in progress (phishing URLs live, social impersonation accounts active)
   - "exploitation" — Successful compromise indicators (credential harvesting confirmed, malware distribution active)
3. Distinguish between noise and genuine threats. Not every signal is an attack.
4. Be specific about what was found and why it matters.
5. Provide 3-5 actionable recommendations.

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "title": "Short descriptive title (e.g., 'Coordinated Phishing Campaign Targeting Brand X')",
  "narrative": "Full 3-5 paragraph narrative connecting the signals into a story. Include specific domains, counts, and timelines.",
  "summary": "2-3 sentence executive summary.",
  "severity": "CRITICAL | HIGH | MEDIUM | LOW",
  "attack_stage": "reconnaissance | weaponization | delivery | exploitation",
  "recommendations": ["Specific action item 1", "Specific action item 2", ...]
}`;

  const userMessage = `Analyze these threat signals for brand ${brandId} and generate a threat narrative:\n\n${signalSummary}`;

  const { parsed } = await callAnthropicJSON<{
    title: string;
    narrative: string;
    summary: string;
    severity: string;
    attack_stage: string;
    recommendations: string[];
  }>(env, {
    agentId: "narrator",
    runId: null,
    model: HOT_PATH_HAIKU,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 2048,
    timeoutMs: 45_000,
  });

  return {
    title: parsed.title,
    narrative: parsed.narrative,
    summary: parsed.summary,
    severity: parsed.severity || "MEDIUM",
    attackStage: parsed.attack_stage || "reconnaissance",
    recommendations: parsed.recommendations || [],
  };
}

// ─── Brand-level narrative orchestrator ───────────────────────────

export async function generateNarrativesForBrand(env: Env, brandId: string): Promise<void> {
  // Cost guard: narrator is non-critical
  const blocked = await checkCostGuard(env, false);
  if (blocked) {
    console.warn(`[narrator] ${blocked}`);
    return;
  }

  // 1. Gather recent signals (last 7 days)
  const [threats, emailSecurity, socialFindings, lookalikes, ctCertificates, appStoreListings, darkWebMentions] = await Promise.all([
    env.DB.prepare(
      `SELECT id, threat_type, malicious_domain, malicious_url, severity, status, source_feed, created_at
       FROM threats
       WHERE target_brand_id = ? AND created_at >= datetime('now', '-7 days')
       ORDER BY created_at DESC LIMIT 50`
    ).bind(brandId).all(),

    env.DB.prepare(
      `SELECT email_security_grade, email_security_score, email_security_scanned_at
       FROM brands WHERE id = ?`
    ).bind(brandId).first(),

    env.DB.prepare(
      `SELECT platform, suspicious_account_name, suspicious_account_url, impersonation_score, status, created_at
       FROM social_monitor_results
       WHERE brand_id = ? AND created_at >= datetime('now', '-7 days')
       ORDER BY created_at DESC LIMIT 30`
    ).bind(brandId).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT domain, registered, dns_active, has_content, mx_records, created_at
       FROM lookalike_domains
       WHERE brand_id = ? AND registered = 1 AND created_at >= datetime('now', '-7 days')
       ORDER BY created_at DESC LIMIT 30`
    ).bind(brandId).all().catch(() => ({ results: [] })),

    env.DB.prepare(
      `SELECT domain, issuer, not_before, suspicious, san_count
       FROM ct_certificates
       WHERE brand_id = ? AND suspicious = 1 AND not_before >= datetime('now', '-7 days')
       ORDER BY not_before DESC LIMIT 20`
    ).bind(brandId).all().catch(() => ({ results: [] })),

    // App-store impersonations — confirmed 'impersonation' classification, or 'suspicious'
    // promoted by Haiku — in the 7-day window. Indexed by (brand_id, severity) WHERE status='active'.
    env.DB.prepare(
      `SELECT store, app_name, developer_name, bundle_id, app_url, impersonation_score, severity, classification, last_checked
       FROM app_store_listings
       WHERE brand_id = ? AND status = 'active'
         AND classification IN ('impersonation', 'suspicious')
         AND COALESCE(last_checked, first_seen) >= datetime('now', '-7 days')
       ORDER BY severity = 'CRITICAL' DESC, severity = 'HIGH' DESC, impersonation_score DESC
       LIMIT 10`
    ).bind(brandId).all().catch(() => ({ results: [] })),

    // Dark-web mentions — confirmed or Haiku-promoted suspicious — in the 7-day window.
    env.DB.prepare(
      `SELECT source, source_url, match_type, matched_terms, severity, classification, first_seen, last_seen
       FROM dark_web_mentions
       WHERE brand_id = ? AND status = 'active'
         AND classification IN ('confirmed', 'suspicious')
         AND COALESCE(last_seen, first_seen) >= datetime('now', '-7 days')
       ORDER BY severity = 'CRITICAL' DESC, severity = 'HIGH' DESC, last_seen DESC
       LIMIT 10`
    ).bind(brandId).all().catch(() => ({ results: [] })),
  ]);

  // 2. Count distinct signal types
  const signalTypes: string[] = [];
  if (threats.results.length > 0) signalTypes.push("threats");
  if (emailSecurity?.email_security_grade && ["D", "F"].includes(emailSecurity.email_security_grade as string)) {
    signalTypes.push("email_degradation");
  }
  if (socialFindings.results.length > 0) signalTypes.push("social_impersonation");
  if (lookalikes.results.length > 0) signalTypes.push("lookalike_domains");
  if (ctCertificates.results.length > 0) signalTypes.push("ct_certificates");
  if (appStoreListings.results.length > 0) signalTypes.push("app_store_impersonation");
  if (darkWebMentions.results.length > 0) signalTypes.push("dark_web_mention");

  // Generate if either:
  //   - 2+ different signal types (cross-channel correlation), OR
  //   - 50+ threats in 7d (volume = signal — narrator should still
  //     synthesize for high-volume targets even without supporting
  //     lookalike/social/CT findings, since most brands in production
  //     only have the threats channel populated; audit 2026-05-16
  //     found this gate killed all 38 narrator runs that week)
  const highVolume = threats.results.length >= 50;
  if (!highVolume && signalTypes.length < 2) {
    return;
  }

  // 3. Generate the narrative
  const context: NarrativeContext = {
    threats: threats.results,
    emailSecurity,
    socialFindings: socialFindings.results,
    lookalikes: lookalikes.results,
    ctCertificates: ctCertificates.results,
    appStoreListings: appStoreListings.results,
    darkWebMentions: darkWebMentions.results,
  };

  let result: NarrativeResult;
  try {
    result = await generateThreatNarrative(env, brandId, context);
  } catch (err) {
    console.error(`[narrator] Narrative generation failed for brand ${brandId}:`, err);
    return;
  }

  // 4. Store in threat_narratives table
  const narrativeId = crypto.randomUUID();
  const threatIds = threats.results.map((t: any) => t.id);

  try {
    await env.DB.prepare(
      `INSERT INTO threat_narratives (id, brand_id, title, narrative, summary, threat_ids, signal_types, severity, confidence, attack_stage, recommendations, generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'narrator')`
    ).bind(
      narrativeId,
      brandId,
      result.title,
      result.narrative,
      result.summary,
      JSON.stringify(threatIds),
      JSON.stringify(signalTypes),
      result.severity,
      signalTypes.length >= 4 ? 85 : signalTypes.length >= 3 ? 70 : 55,
      result.attackStage,
      JSON.stringify(result.recommendations),
    ).run();

  } catch (err) {
    console.error(`[narrator] Failed to store narrative for brand ${brandId}:`, err);
    return;
  }

  // 5. Create an alert if severity is HIGH or CRITICAL
  if (result.severity === "HIGH" || result.severity === "CRITICAL") {
    try {
      // brand_profiles retired (2026-05-07, R3). Alerts are now
      // tenant-scoped via brand_id → org_brands at read time, so we
      // attribute creation to a stable 'system' userId. The legacy
      // path used to look up an owning user via brand_profiles; that
      // table is dead. If a per-creator attribution is needed in
      // future, look up an org_member with admin role for the brand.
      const userId = "system";

      await createAlert(env.DB, {
        brandId,
        userId,
        alertType: "phishing_detected",
        severity: result.severity as "HIGH" | "CRITICAL",
        title: result.title,
        summary: result.summary,
        details: {
          narrative_id: narrativeId,
          attack_stage: result.attackStage,
          signal_types: signalTypes,
        },
        sourceType: "threat_narrative",
        sourceId: narrativeId,
        aiAssessment: result.narrative,
        aiRecommendations: result.recommendations,
      });

    } catch (err) {
      console.error(`[narrator] Failed to create alert for brand ${brandId}:`, err);
    }
  }
}

// ─── Agent module: batch narrative generation across brands ─────

export const narratorAgent: AgentModule = {
  name: "narrator",
  displayName: "Narrator",
  description: "Threat narrative generation across brands with multi-signal correlation",
  color: "#8A8F9C",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 1500,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 5_000_000 },
  reads: [
    { kind: "d1_table", name: "app_store_listings" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "ct_certificates" },
    { kind: "d1_table", name: "dark_web_mentions" },
    { kind: "d1_table", name: "lookalike_domains" },
    { kind: "d1_table", name: "social_monitor_results" },
    { kind: "d1_table", name: "threat_narratives" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [
    { kind: "d1_table", name: "threat_narratives" },
  ],
  outputs: [{ type: "insight" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 14,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;

    const blocked = await checkCostGuard(env, false);
    if (blocked) {
      return {
        itemsProcessed: 0,
        itemsCreated: 0,
        itemsUpdated: 0,
        output: { skipped: true, reason: blocked },
      };
    }

    // PR-C (2026-05-16 audit fix #13): pre-screen also includes the
    // email-security-grade and high-volume-threat signal channels, both
    // of which the inner gate in generateNarrativesForBrand() counts but
    // the screen was ignoring. Audit found 3,092 brands with active
    // threats but 0 with lookalikes/socials in production — under the
    // old gate every brand was filtered out (signalTypes=1) and the
    // narrator produced 0 rows in 7 days of runs. New gate:
    //   threat_count >= 50 OR signalTypes >= 2
    // covers high-volume targets (volume = signal) while keeping the
    // correlation path for brands with diverse evidence.
    const brandsWithSignals = await env.DB.prepare(`
      SELECT b.id, b.name,
        (b.email_security_grade IN ('D','F')) as email_fail,
        (SELECT COUNT(*) FROM threats t WHERE t.target_brand_id = b.id AND t.created_at >= datetime('now', '-7 days')) as threat_count,
        (SELECT COUNT(*) FROM social_monitor_results smr WHERE smr.brand_id = b.id AND smr.created_at >= datetime('now', '-7 days')) as social_count,
        (SELECT COUNT(*) FROM lookalike_domains ld WHERE ld.brand_id = b.id AND ld.registered = 1 AND ld.created_at >= datetime('now', '-7 days')) as lookalike_count,
        (SELECT COUNT(*) FROM ct_certificates ct WHERE ct.brand_id = b.id AND ct.suspicious = 1 AND ct.not_before >= datetime('now', '-7 days')) as ct_count,
        (SELECT COUNT(*) FROM app_store_listings asl WHERE asl.brand_id = b.id AND asl.status = 'active'
           AND asl.classification IN ('impersonation','suspicious')
           AND COALESCE(asl.last_checked, asl.first_seen) >= datetime('now', '-7 days')) as appstore_count,
        (SELECT COUNT(*) FROM dark_web_mentions dwm WHERE dwm.brand_id = b.id AND dwm.status = 'active'
           AND dwm.classification IN ('confirmed','suspicious')
           AND COALESCE(dwm.last_seen, dwm.first_seen) >= datetime('now', '-7 days')) as darkweb_count
      FROM brands b
      WHERE b.threat_count > 0
      ORDER BY b.threat_count DESC
      LIMIT 20
    `).all<{
      id: string; name: string; email_fail: number;
      threat_count: number; social_count: number;
      lookalike_count: number; ct_count: number;
      appstore_count: number; darkweb_count: number;
    }>();

    const outputs: AgentOutputEntry[] = [];
    let itemsProcessed = 0;
    let itemsCreated = 0;
    const errors: string[] = [];
    const MAX_PER_RUN = 5;

    for (const brand of brandsWithSignals.results) {
      let signalTypes = 0;
      if (brand.threat_count > 0)   signalTypes++;
      if (brand.email_fail)         signalTypes++;
      if (brand.social_count > 0)   signalTypes++;
      if (brand.lookalike_count > 0) signalTypes++;
      if (brand.ct_count > 0)       signalTypes++;
      if (brand.appstore_count > 0) signalTypes++;
      if (brand.darkweb_count > 0)  signalTypes++;
      // High-volume single-signal targets get a narrative too — 50+
      // active threats in 7d is itself a signal worth synthesizing.
      const highVolume = brand.threat_count >= 50;
      if (!highVolume && signalTypes < 2) continue;

      const existing = await env.DB.prepare(
        `SELECT id FROM threat_narratives WHERE brand_id = ? AND created_at >= datetime('now', '-24 hours') LIMIT 1`
      ).bind(brand.id).first();
      if (existing) continue;

      itemsProcessed++;
      try {
        const preCount = await env.DB.prepare(
          `SELECT COUNT(*) as c FROM threat_narratives WHERE brand_id = ?`
        ).bind(brand.id).first<{ c: number }>();
        await generateNarrativesForBrand(env, brand.id);
        const postCount = await env.DB.prepare(
          `SELECT COUNT(*) as c FROM threat_narratives WHERE brand_id = ?`
        ).bind(brand.id).first<{ c: number }>();
        if ((postCount?.c ?? 0) > (preCount?.c ?? 0)) itemsCreated++;
      } catch (err) {
        errors.push(`${brand.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (itemsCreated >= MAX_PER_RUN) break;
    }

    outputs.push({
      type: "insight",
      summary: `Narrator processed ${itemsProcessed} brands, generated ${itemsCreated} narratives`,
      severity: "info",
      details: {
        brands_checked: brandsWithSignals.results.length,
        brands_eligible: itemsProcessed,
        narratives_generated: itemsCreated,
        errors: errors.slice(0, 5),
      },
    });

    return {
      itemsProcessed,
      itemsCreated,
      itemsUpdated: 0,
      output: {
        brands_checked: brandsWithSignals.results.length,
        narratives_generated: itemsCreated,
      },
      agentOutputs: outputs,
    };
  },
};

// ─── Helper: Build signal summary for the AI prompt ──────────────

function buildSignalSummary(context: NarrativeContext): string {
  const parts: string[] = [];

  // Threats
  if (context.threats.length > 0) {
    const byType: Record<string, number> = {};
    const domains = new Set<string>();
    for (const t of context.threats) {
      byType[t.threat_type] = (byType[t.threat_type] || 0) + 1;
      if (t.malicious_domain) domains.add(t.malicious_domain);
    }
    const typeStr = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ");
    parts.push(`## Active Threats (last 7 days)
Count: ${context.threats.length}
Types: ${typeStr}
Domains involved: ${Array.from(domains).slice(0, 15).join(", ")}
Sources: ${[...new Set(context.threats.map((t: any) => t.source_feed))].join(", ")}`);
  }

  // Email security
  if (context.emailSecurity) {
    const es = context.emailSecurity;
    parts.push(`## Email Security Posture
Grade: ${es.email_security_grade ?? "Not scanned"}
Score: ${es.email_security_score ?? "N/A"}
Last scanned: ${es.email_security_scanned_at ?? "Never"}`);
  }

  // Social impersonation
  if (context.socialFindings.length > 0) {
    const platforms = [...new Set(context.socialFindings.map((s: any) => s.platform))];
    const active = context.socialFindings.filter((s: any) => s.status === "active").length;
    parts.push(`## Social Impersonation
Findings: ${context.socialFindings.length} (${active} active)
Platforms: ${platforms.join(", ")}
Accounts: ${context.socialFindings.slice(0, 10).map((s: any) => `@${s.suspicious_account_name ?? 'unknown'} on ${s.platform} (impersonation score: ${Math.round((Number(s.impersonation_score) || 0) * 100)}%)`).join(", ")}`);
  }

  // Lookalike domains
  if (context.lookalikes.length > 0) {
    const withContent = context.lookalikes.filter((d: any) => d.has_content).length;
    const withMx = context.lookalikes.filter((d: any) => d.mx_records).length;
    parts.push(`## Lookalike Domains (registered)
Count: ${context.lookalikes.length} (${withContent} with content, ${withMx} with MX records)
Domains: ${context.lookalikes.slice(0, 15).map((d: any) => d.domain).join(", ")}`);
  }

  // CT certificates
  if (context.ctCertificates.length > 0) {
    parts.push(`## Suspicious CT Certificates
Count: ${context.ctCertificates.length}
Certificates: ${context.ctCertificates.slice(0, 10).map((c: any) => `${c.domain} (issuer: ${c.issuer}, SANs: ${c.san_count})`).join("; ")}`);
  }

  // App-store impersonations — iOS today; Google Play / 3rd-party stores later.
  if (context.appStoreListings.length > 0) {
    const confirmed = context.appStoreListings.filter((a: any) => a.classification === "impersonation").length;
    const suspicious = context.appStoreListings.filter((a: any) => a.classification === "suspicious").length;
    parts.push(`## App-Store Impersonations
Count: ${context.appStoreListings.length} (${confirmed} confirmed impersonation, ${suspicious} suspicious)
Apps: ${context.appStoreListings.slice(0, 5).map((a: any) =>
  `"${a.app_name}" on ${a.store} by "${a.developer_name ?? "unknown dev"}" (severity ${a.severity}, score ${Math.round((Number(a.impersonation_score) || 0) * 100)}%)`
).join("; ")}`);
  }

  // Dark-web mentions — paste archives today; Telegram / HIBP / Flare later.
  if (context.darkWebMentions.length > 0) {
    const bySource: Record<string, number> = {};
    const byMatch: Record<string, number> = {};
    for (const m of context.darkWebMentions) {
      bySource[m.source] = (bySource[m.source] || 0) + 1;
      if (m.match_type) byMatch[m.match_type] = (byMatch[m.match_type] || 0) + 1;
    }
    const srcStr = Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(", ");
    const matchStr = Object.entries(byMatch).map(([k, v]) => `${k}: ${v}`).join(", ");
    parts.push(`## Dark-Web Mentions
Count: ${context.darkWebMentions.length}
Sources: ${srcStr}
Match types: ${matchStr}
Top: ${context.darkWebMentions.slice(0, 5).map((m: any) =>
  `${m.source} ${m.match_type ?? "?"} match (severity ${m.severity}, ${m.classification})`
).join("; ")}`);
  }

  return parts.join("\n\n");
}
