/**
 * Narrator Agent — threat narrative generation.
 *
 * Correlates multiple threat signals (phishing, lookalike domains, social
 * impersonation, email security, CT certificates, app stores, dark web)
 * for a brand into a coherent attack narrative.
 *
 * AI Strategy Phase 1 (#10, docs/AI_STRATEGY_2026-10.md): SEVERITY IS
 * RULE-DERIVED. `computeNarrativeSeverity` scores the gathered signals
 * deterministically; that value is what lands in
 * `threat_narratives.severity` and what gates alert creation. The model
 * only writes prose (title / narrative / summary / attack stage /
 * recommendations) — any severity it returns is ignored. When the prose
 * call fails or is skipped (cost guard), title + summary + narrative come
 * from a deterministic template, the alert's ai_assessment stays NULL and
 * attack_stage falls back to 'reconnaissance'.
 */

import type { Env } from "../types";
import { createAlert } from "../lib/alerts";
import { checkCostGuard } from "../lib/haiku";
import { callAnthropicJSON } from "../lib/anthropic";
import { HOT_PATH_HAIKU } from "../lib/ai-models";
import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";

// ─── Types ────────────────────────────────────────────────────────

export interface NarrativeThreatRow {
  id: string;
  threat_type: string | null;
  malicious_domain: string | null;
  malicious_url: string | null;
  severity: string | null;
  status: string | null;
  source_feed: string | null;
  created_at: string | null;
}

export interface NarrativeEmailSecurityRow {
  email_security_grade: string | null;
  email_security_score: number | null;
  email_security_scanned_at: string | null;
}

export interface NarrativeSocialRow {
  platform: string | null;
  suspicious_account_name: string | null;
  suspicious_account_url: string | null;
  impersonation_score: number | null;
  status: string | null;
  created_at: string | null;
}

export interface NarrativeLookalikeRow {
  domain: string;
  registered: number | null;
  resolves_to: string | null;
  has_web: number | null;
  has_mx: number | null;
  first_seen: string | null;
}

export interface NarrativeCtCertRow {
  domain: string | null;
  issuer: string | null;
  not_before: string | null;
  suspicious: number | null;
  san_count: number | null;
}

export interface NarrativeAppStoreRow {
  store: string | null;
  app_name: string | null;
  developer_name: string | null;
  bundle_id: string | null;
  app_url: string | null;
  impersonation_score: number | null;
  severity: string | null;
  classification: string | null;
  last_checked: string | null;
}

export interface NarrativeDarkWebRow {
  source: string | null;
  source_url: string | null;
  match_type: string | null;
  matched_terms: string | null;
  severity: string | null;
  classification: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface NarrativeContext {
  threats: NarrativeThreatRow[];
  emailSecurity: NarrativeEmailSecurityRow | null;
  socialFindings: NarrativeSocialRow[];
  lookalikes: NarrativeLookalikeRow[];
  ctCertificates: NarrativeCtCertRow[];
  appStoreListings: NarrativeAppStoreRow[];
  darkWebMentions: NarrativeDarkWebRow[];
}

/** Model-written prose. Severity is deliberately absent — see header. */
interface NarrativeProse {
  title: string;
  narrative: string;
  summary: string;
  attackStage: string;
  recommendations: string[];
}

export type NarrativeSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

const DEFAULT_ATTACK_STAGE = "reconnaissance";
const ATTACK_STAGES = new Set(["reconnaissance", "weaponization", "delivery", "exploitation"]);
/** Matches the per-brand threats query's LIMIT. */
const THREAT_QUERY_LIMIT = 50;

// ─── Rule-based severity ──────────────────────────────────────────

function lc(v: string | null | undefined): string {
  return (v ?? "").toLowerCase();
}

/**
 * Deterministic narrative severity. Pure — no I/O.
 *
 * Points (only status='active' threats count):
 *   threats:   any critical +3, else any high +2
 *              active count >= 50 (query limit) +2, else >= 10 +1
 *   lookalike: any with has_mx && has_web +2, else any +1
 *   social:    max impersonation_score >= 0.8 +2, else >= 0.5 +1
 *   app store: any classification 'impersonation' +2, else 'suspicious' +1
 *   dark web:  any classification 'confirmed' +2, else 'suspicious' +1
 *   CT:        any suspicious cert +1
 *   email_degradation signal +1
 *   +1 per signal type beyond 2
 * Map: >= 8 CRITICAL, >= 5 HIGH, >= 3 MEDIUM, else LOW.
 */
export function computeNarrativeSeverity(
  ctx: NarrativeContext,
  signalTypes: string[],
): NarrativeSeverity {
  let points = 0;

  const active = ctx.threats.filter((t) => lc(t.status) === "active");
  if (active.some((t) => lc(t.severity) === "critical")) points += 3;
  else if (active.some((t) => lc(t.severity) === "high")) points += 2;
  if (active.length >= THREAT_QUERY_LIMIT) points += 2;
  else if (active.length >= 10) points += 1;

  if (ctx.lookalikes.some((d) => Boolean(d.has_mx) && Boolean(d.has_web))) points += 2;
  else if (ctx.lookalikes.length > 0) points += 1;

  const maxSocial = ctx.socialFindings.reduce(
    (m, s) => Math.max(m, Number(s.impersonation_score) || 0),
    0,
  );
  if (maxSocial >= 0.8) points += 2;
  else if (maxSocial >= 0.5) points += 1;

  if (ctx.appStoreListings.some((a) => lc(a.classification) === "impersonation")) points += 2;
  else if (ctx.appStoreListings.some((a) => lc(a.classification) === "suspicious")) points += 1;

  if (ctx.darkWebMentions.some((m) => lc(m.classification) === "confirmed")) points += 2;
  else if (ctx.darkWebMentions.some((m) => lc(m.classification) === "suspicious")) points += 1;

  if (ctx.ctCertificates.some((c) => Boolean(c.suspicious))) points += 1;

  if (signalTypes.includes("email_degradation")) points += 1;

  points += Math.max(0, signalTypes.length - 2);

  if (points >= 8) return "CRITICAL";
  if (points >= 5) return "HIGH";
  if (points >= 3) return "MEDIUM";
  return "LOW";
}

/** True when any status='active' threat in the context is critical. */
export function hasActiveCriticalThreat(ctx: NarrativeContext): boolean {
  return ctx.threats.some((t) => lc(t.status) === "active" && lc(t.severity) === "critical");
}

/**
 * Alert gate: rule severity HIGH/CRITICAL AND either cross-channel
 * corroboration (>= 2 signal types) or an active critical threat.
 */
export function shouldCreateNarrativeAlert(
  severity: NarrativeSeverity,
  signalTypes: string[],
  activeCriticalThreat: boolean,
): boolean {
  if (severity !== "HIGH" && severity !== "CRITICAL") return false;
  return signalTypes.length >= 2 || activeCriticalThreat;
}

const NARRATIVE_SEVERITY_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** A recent open `threat_narrative` alert, as read for the dedupe gate. */
export interface PriorNarrativeAlert {
  severity: string | null;
  /** `alerts.details.signal_types` — a JSON array string, or NULL. */
  signal_types: string | null;
}

function parseSignalTypes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Alert dedupe. Pure — no I/O.
 *
 * Narratives regenerate every 24h per brand, and a brand under sustained
 * attack produces the same HIGH/CRITICAL picture day after day — one
 * alert per day for an unchanged situation is noise. A new alert is
 * warranted only on ESCALATION (severity above every open prior) or a
 * NEW CHANNEL (a signal type no open prior already covered).
 *
 * Returns true (suppress) when some open prior alert from the window has
 * severity >= the current one AND already covers every current signal
 * type (same set, or a superset — a channel going quiet is not news).
 */
export function isDuplicateNarrativeAlert(
  severity: NarrativeSeverity,
  signalTypes: string[],
  priors: PriorNarrativeAlert[],
): boolean {
  const rank = NARRATIVE_SEVERITY_RANK[lc(severity)] ?? 0;
  return priors.some((p) => {
    const priorRank = NARRATIVE_SEVERITY_RANK[lc(p.severity)];
    if (priorRank === undefined || priorRank < rank) return false;
    const covered = new Set(parseSignalTypes(p.signal_types));
    return signalTypes.every((t) => covered.has(t));
  });
}

const SIGNAL_LABELS: Record<string, string> = {
  threats: "threats",
  email_degradation: "weak email authentication",
  social_impersonation: "social impersonation",
  lookalike_domains: "lookalike domains",
  ct_certificates: "suspicious certificates",
  app_store_impersonation: "app-store impersonation",
  dark_web_mention: "dark-web mentions",
};

/** Deterministic prose used when the AI call fails or is skipped. */
export function buildTemplateNarrative(
  brandLabel: string,
  ctx: NarrativeContext,
  signalTypes: string[],
  severity: NarrativeSeverity,
): { title: string; summary: string; narrative: string } {
  const labels = signalTypes.map((s) => SIGNAL_LABELS[s] ?? s);
  const activeThreats = ctx.threats.filter((t) => lc(t.status) === "active").length;
  const title = signalTypes.length >= 2
    ? `Multi-signal activity targeting ${brandLabel} (${signalTypes.length} channels)`
    : `Elevated threat volume targeting ${brandLabel}`;
  const summary =
    `${severity} rule-scored activity against ${brandLabel} over the last 7 days: ` +
    `${ctx.threats.length} threat${ctx.threats.length === 1 ? "" : "s"} (${activeThreats} active)` +
    (labels.length > 0 ? ` across ${labels.join(", ")}.` : ".");
  const narrative = `${summary}\n\n${buildSignalSummary(ctx)}`;
  return { title, summary, narrative };
}

// ─── Core narrative generation ────────────────────────────────────

/** AI prose only. Throws on any API/parse failure — callers fall back to the template. */
export async function generateThreatNarrative(
  env: Env,
  brandId: string,
  context: NarrativeContext,
): Promise<NarrativeProse> {
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
  "attack_stage": "reconnaissance | weaponization | delivery | exploitation",
  "recommendations": ["Specific action item 1", "Specific action item 2", ...]
}`;

  const userMessage = `Analyze these threat signals for brand ${brandId} and generate a threat narrative:\n\n${signalSummary}`;

  const { parsed } = await callAnthropicJSON<{
    title: string;
    narrative: string;
    summary: string;
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

  if (
    typeof parsed?.title !== "string" || !parsed.title ||
    typeof parsed.narrative !== "string" || !parsed.narrative
  ) {
    throw new Error("narrator: AI response missing title/narrative");
  }
  const stage = lc(parsed.attack_stage);
  return {
    title: parsed.title,
    narrative: parsed.narrative,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    attackStage: ATTACK_STAGES.has(stage) ? stage : DEFAULT_ATTACK_STAGE,
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.filter((r): r is string => typeof r === "string")
      : [],
  };
}

// ─── Brand-level narrative orchestrator ───────────────────────────

export async function generateNarrativesForBrand(env: Env, brandId: string): Promise<void> {
  // 1. Gather recent signals (last 7 days)
  const [threats, emailSecurity, socialFindings, lookalikes, ctCertificates, appStoreListings, darkWebMentions] = await Promise.all([
    env.DB.prepare(
      `SELECT id, threat_type, malicious_domain, malicious_url, severity, status, source_feed, created_at
       FROM threats
       WHERE target_brand_id = ? AND created_at >= datetime('now', '-7 days')
       ORDER BY created_at DESC LIMIT 50`
    ).bind(brandId).all<NarrativeThreatRow>(),

    env.DB.prepare(
      `SELECT name, email_security_grade, email_security_score, email_security_scanned_at
       FROM brands WHERE id = ?`
    ).bind(brandId).first<NarrativeEmailSecurityRow & { name: string | null }>(),

    env.DB.prepare(
      `SELECT platform, suspicious_account_name, suspicious_account_url, impersonation_score, status, created_at
       FROM social_monitor_results
       WHERE brand_id = ? AND created_at >= datetime('now', '-7 days')
       ORDER BY created_at DESC LIMIT 30`
    ).bind(brandId).all<NarrativeSocialRow>().catch(() => ({ results: [] as NarrativeSocialRow[] })),

    // `first_seen`, not `created_at`: the latter is when the SEEDER
    // inserted the candidate, so with the monitored-brand seeder running
    // (~300 rows/tick) a 7-day window on it measures our own crawl
    // schedule rather than the brand's exposure. `first_seen` is stamped
    // only on a `registered 0 -> 1` transition we observed — first
    // contact with an already-registered squat leaves it NULL by design
    // (migration 0267), so this counts appearances and nothing else.
    // Since migration 0282 the NRD matcher (lib/lookalike-nrd-matcher.ts)
    // also stamps it, from the registries' newly-registered list — which
    // is what makes this window non-empty: the observed 0 -> 1 path alone
    // needs a DNS re-check the backlog rarely reaches. An NRD-dated row is
    // a registration even while DNS has nothing for it yet, hence the OR.
    // The 45 pre-0267 first_seen artifacts are months outside the window.
    // ── COLUMNS THAT DO NOT EXIST ─────────────────────────────────
    // This selected `dns_active`, `has_content` and `mx_records`. None
    // of the three is in ANY migration for `lookalike_domains`; the real
    // columns are `resolves_to`, `has_web` and `has_mx` (migration
    // 0031). The statement therefore raised SQLITE_ERROR on every run
    // and the `.catch(() => ({ results: [] }))` below swallowed it, so
    // `lookalikes` was PERMANENTLY EMPTY — the signal-type gate never
    // counted this channel and the rendered section never appeared.
    // `resolves_to` replaces `dns_active`: a row that resolves is one we
    // hold an IP for, which is what "DNS active" was reaching for.
    env.DB.prepare(
      `SELECT domain, registered, resolves_to, has_web, has_mx, first_seen
       FROM lookalike_domains
       WHERE brand_id = ? AND (registered = 1 OR registration_evidence = 'nrd') AND first_seen >= datetime('now', '-7 days')
       ORDER BY first_seen DESC LIMIT 30`
    ).bind(brandId).all<NarrativeLookalikeRow>().catch(() => ({ results: [] as NarrativeLookalikeRow[] })),

    env.DB.prepare(
      `SELECT domain, issuer, not_before, suspicious, san_count
       FROM ct_certificates
       WHERE brand_id = ? AND suspicious = 1 AND not_before >= datetime('now', '-7 days')
       ORDER BY not_before DESC LIMIT 20`
    ).bind(brandId).all<NarrativeCtCertRow>().catch(() => ({ results: [] as NarrativeCtCertRow[] })),

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
    ).bind(brandId).all<NarrativeAppStoreRow>().catch(() => ({ results: [] as NarrativeAppStoreRow[] })),

    // Dark-web mentions — confirmed or Haiku-promoted suspicious — in the 7-day window.
    env.DB.prepare(
      `SELECT source, source_url, match_type, matched_terms, severity, classification, first_seen, last_seen
       FROM dark_web_mentions
       WHERE brand_id = ? AND status = 'active'
         AND classification IN ('confirmed', 'suspicious')
         AND COALESCE(last_seen, first_seen) >= datetime('now', '-7 days')
       ORDER BY severity = 'CRITICAL' DESC, severity = 'HIGH' DESC, last_seen DESC
       LIMIT 10`
    ).bind(brandId).all<NarrativeDarkWebRow>().catch(() => ({ results: [] as NarrativeDarkWebRow[] })),
  ]);

  // 2. Count distinct signal types
  const signalTypes: string[] = [];
  if (threats.results.length > 0) signalTypes.push("threats");
  if (emailSecurity?.email_security_grade && ["D", "F"].includes(emailSecurity.email_security_grade)) {
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

  const context: NarrativeContext = {
    threats: threats.results,
    emailSecurity: emailSecurity ?? null,
    socialFindings: socialFindings.results,
    lookalikes: lookalikes.results,
    ctCertificates: ctCertificates.results,
    appStoreListings: appStoreListings.results,
    darkWebMentions: darkWebMentions.results,
  };

  // 3. Severity from rules — never from the model (AI Strategy #10).
  const severity = computeNarrativeSeverity(context, signalTypes);

  // 4. Prose: AI when available, deterministic template otherwise.
  let prose: NarrativeProse | null = null;
  const blocked = await checkCostGuard(env, false);
  if (blocked) {
    console.warn(`[narrator] AI prose skipped: ${blocked}`);
  } else {
    try {
      prose = await generateThreatNarrative(env, brandId, context);
    } catch (err) {
      console.warn(`[narrator] AI prose failed for brand ${brandId}; using template:`, err);
    }
  }
  const template = buildTemplateNarrative(emailSecurity?.name || brandId, context, signalTypes, severity);
  const result = {
    title: prose?.title ?? template.title,
    narrative: prose?.narrative ?? template.narrative,
    summary: prose?.summary || template.summary,
    attackStage: prose?.attackStage ?? DEFAULT_ATTACK_STAGE,
    recommendations: prose?.recommendations ?? [],
  };

  // 5. Store in threat_narratives table
  const narrativeId = crypto.randomUUID();
  const threatIds = threats.results.map((t) => t.id);

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
      severity,
      signalTypes.length >= 4 ? 85 : signalTypes.length >= 3 ? 70 : 55,
      result.attackStage,
      JSON.stringify(result.recommendations),
    ).run();

  } catch (err) {
    console.error(`[narrator] Failed to store narrative for brand ${brandId}:`, err);
    return;
  }

  // 6. Alert gate — rule severity HIGH/CRITICAL AND (>= 2 signal types
  //    OR an active critical threat). See shouldCreateNarrativeAlert.
  if (shouldCreateNarrativeAlert(severity, signalTypes, hasActiveCriticalThreat(context))) {
    try {
      // 6a. Dedupe — open (not resolved / false_positive, per
      //     `AlertStatus`) narrative alerts for this brand from the last
      //     7 days. Driven by `idx_alerts_brand`; the brand's alert set
      //     is small, so the residual filters are cheap. Alert only on
      //     escalation or a new channel — see isDuplicateNarrativeAlert.
      const priors = await env.DB.prepare(
        `SELECT severity, json_extract(details, '$.signal_types') AS signal_types
         FROM alerts
         WHERE brand_id = ?
           AND source_type = 'threat_narrative'
           AND status NOT IN ('resolved', 'false_positive')
           AND created_at >= datetime('now', '-7 days')`
      ).bind(brandId).all<PriorNarrativeAlert>();
      if (isDuplicateNarrativeAlert(severity, signalTypes, priors.results ?? [])) {
        return;
      }

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
        severity,
        title: result.title,
        summary: result.summary,
        details: {
          narrative_id: narrativeId,
          attack_stage: result.attackStage,
          signal_types: signalTypes,
          severity_source: "rules",
          prose_source: prose ? "ai" : "template",
        },
        sourceType: "threat_narrative",
        sourceId: narrativeId,
        // Template prose is not an AI assessment — leave the column NULL.
        aiAssessment: prose ? prose.narrative : undefined,
        aiRecommendations: prose ? prose.recommendations : undefined,
      }, { env });

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
    { kind: "d1_table", name: "alerts" },
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

    // No run-level cost-guard early return: severity is rule-based and
    // the prose falls back to a template, so a budget-blocked run still
    // produces narratives. The guard is checked per brand before the AI
    // prose call (generateNarrativesForBrand).

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
        -- first_seen, not created_at: see the per-brand query above. On
        -- created_at this subquery would have counted seeder output, so
        -- every freshly-seeded brand would have gained a phantom signal
        -- type and cleared the signalTypes >= 2 gate on nothing.
        -- (registered = 1 OR NRD-dated): an NRD-listed registration is a
        -- registry fact even before DNS answers for it (migration 0282).
        (SELECT COUNT(*) FROM lookalike_domains ld WHERE ld.brand_id = b.id AND (ld.registered = 1 OR ld.registration_evidence = 'nrd') AND ld.first_seen >= datetime('now', '-7 days')) as lookalike_count,
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
      const tt = t.threat_type ?? "unknown";
      byType[tt] = (byType[tt] || 0) + 1;
      if (t.malicious_domain) domains.add(t.malicious_domain);
    }
    const typeStr = Object.entries(byType).map(([k, v]) => `${k}: ${v}`).join(", ");
    parts.push(`## Active Threats (last 7 days)
Count: ${context.threats.length}
Types: ${typeStr}
Domains involved: ${Array.from(domains).slice(0, 15).join(", ")}
Sources: ${[...new Set(context.threats.map((t) => t.source_feed).filter(Boolean))].join(", ")}`);
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
    const platforms = [...new Set(context.socialFindings.map((s) => s.platform).filter(Boolean))];
    const active = context.socialFindings.filter((s) => s.status === "active").length;
    parts.push(`## Social Impersonation
Findings: ${context.socialFindings.length} (${active} active)
Platforms: ${platforms.join(", ")}
Accounts: ${context.socialFindings.slice(0, 10).map((s) => `@${s.suspicious_account_name ?? 'unknown'} on ${s.platform} (impersonation score: ${Math.round((Number(s.impersonation_score) || 0) * 100)}%)`).join(", ")}`);
  }

  // Lookalike domains
  if (context.lookalikes.length > 0) {
    // `has_web` / `has_mx`, not the phantom `has_content` / `mx_records`
    // this filtered on — see the SELECT's comment. Both are 0/1 INTEGER
    // columns, so a truthiness filter is the right shape; `mx_records`
    // was a string test against a column that has never existed.
    const withWeb = context.lookalikes.filter((d) => d.has_web).length;
    const withMx = context.lookalikes.filter((d) => d.has_mx).length;
    parts.push(`## Lookalike Domains (registered)
Count: ${context.lookalikes.length} (${withWeb} with a web server, ${withMx} with MX records)
Domains: ${context.lookalikes.slice(0, 15).map((d) => d.domain).join(", ")}`);
  }

  // CT certificates
  if (context.ctCertificates.length > 0) {
    parts.push(`## Suspicious CT Certificates
Count: ${context.ctCertificates.length}
Certificates: ${context.ctCertificates.slice(0, 10).map((c) => `${c.domain} (issuer: ${c.issuer}, SANs: ${c.san_count})`).join("; ")}`);
  }

  // App-store impersonations — iOS today; Google Play / 3rd-party stores later.
  if (context.appStoreListings.length > 0) {
    const confirmed = context.appStoreListings.filter((a) => lc(a.classification) === "impersonation").length;
    const suspicious = context.appStoreListings.filter((a) => lc(a.classification) === "suspicious").length;
    parts.push(`## App-Store Impersonations
Count: ${context.appStoreListings.length} (${confirmed} confirmed impersonation, ${suspicious} suspicious)
Apps: ${context.appStoreListings.slice(0, 5).map((a) =>
  `"${a.app_name}" on ${a.store} by "${a.developer_name ?? "unknown dev"}" (severity ${a.severity}, score ${Math.round((Number(a.impersonation_score) || 0) * 100)}%)`
).join("; ")}`);
  }

  // Dark-web mentions — paste archives today; Telegram / HIBP / Flare later.
  if (context.darkWebMentions.length > 0) {
    const bySource: Record<string, number> = {};
    const byMatch: Record<string, number> = {};
    for (const m of context.darkWebMentions) {
      const src = m.source ?? "unknown";
      bySource[src] = (bySource[src] || 0) + 1;
      if (m.match_type) byMatch[m.match_type] = (byMatch[m.match_type] || 0) + 1;
    }
    const srcStr = Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(", ");
    const matchStr = Object.entries(byMatch).map(([k, v]) => `${k}: ${v}`).join(", ");
    parts.push(`## Dark-Web Mentions
Count: ${context.darkWebMentions.length}
Sources: ${srcStr}
Match types: ${matchStr}
Top: ${context.darkWebMentions.slice(0, 5).map((m) =>
  `${m.source} ${m.match_type ?? "?"} match (severity ${m.severity}, ${m.classification})`
).join("; ")}`);
  }

  return parts.join("\n\n");
}
