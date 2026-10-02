/**
 * Sentinel Agent — Certificate & domain surveillance.
 *
 * Runs on every feed ingestion event. Classifies new threats with
 * deterministic rules (`ruleBasedClassify`) and assigns confidence
 * scores + severity. No AI call sits on the classification path
 * (AI_STRATEGY_2026-10 Phase 1, Batch B): confidence comes from the
 * source feed's track record, severity from the threat type, and the
 * escalations below are all string/set checks.
 *
 * Also performs:
 * - Source-quality confidence (merged from triage agent)
 * - Homoglyph & brand-squatting detection (merged from impersonation-detector agent)
 * - Credential-path escalation (brand-matched URL whose path/query
 *   carries a login/verify/wallet-style token)
 *
 * The one remaining AI call in this file is `runSentinelSocialAssessment`,
 * a separate orchestrator-invoked helper — not part of `execute()`.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import type { Env } from "../types";
import { callAnthropicJSON } from "../lib/anthropic";
import { classifySaasTechnique } from "../lib/saas-classifier";
import { HOT_PATH_HAIKU } from "../lib/ai-models";
import { cachedCount } from "../lib/cached-count";
import { withD1Retry } from "../lib/d1-retry";

// ─── Homoglyph & brand-squatting detection ──────────────────────

const FALLBACK_BRAND_KEYWORDS = [
  "paypal", "apple", "google", "microsoft", "amazon", "netflix", "facebook",
  "instagram", "twitter", "linkedin", "dropbox", "adobe", "zoom", "slack",
  "github", "cloudflare", "stripe", "shopify", "coinbase", "binance",
];

// Known Iranian APT infrastructure ASNs — auto-escalate threats from these
const IRANIAN_APT_ASNS = new Set([
  "AS43754",   // Asiatech Data Transmission — commonly used by Iranian APTs
  "AS208137",  // Iranian hosting linked to MOIS operations
  "AS205585",  // Noyan Abr Arvan — Iranian cloud provider used for C2
  "AS44244",   // Irancell
  "AS58224",   // TIC (Telecommunication Infrastructure Company)
  "AS12880",   // Information Technology Company (ITC)
  "AS48159",   // Telecommunication Infrastructure Company
]);

const HOMOGLYPHS: Record<string, string[]> = {
  a: ["а", "ą", "ä", "å", "α"],
  e: ["е", "ë", "ę", "ε"],
  o: ["о", "ö", "ø", "ο", "0"],
  i: ["і", "ì", "1", "l", "|"],
  l: ["1", "і", "|", "ℓ"],
  n: ["ñ", "ń", "η"],
  c: ["с", "ç", "ć"],
  s: ["ś", "ş", "ș"],
};

function detectHomoglyphs(domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/[.-]/g, "");
  for (const glyphs of Object.values(HOMOGLYPHS)) {
    for (const glyph of glyphs) {
      if (normalized.includes(glyph)) return true;
    }
  }
  return false;
}

function detectBrandSquatting(domain: string, brandKeywords: string[]): string | null {
  const cleaned = domain.toLowerCase().replace(/[.-]/g, "");
  for (const brand of brandKeywords) {
    if (cleaned.includes(brand)) {
      const realPatterns = [`${brand}.com`, `${brand}.io`, `${brand}.org`, `${brand}.net`];
      if (!realPatterns.includes(domain)) return brand;
    }
  }
  return null;
}

// ─── Social profile cross-reference ─────────────────────────────

export interface SocialProfileRow {
  handle: string;
  platform: string;
  classification: string;
  profile_url: string | null;
  brand_name: string;
}

/**
 * Match a threat's domain against a pre-fetched list of suspicious /
 * impersonation social profiles. Pure function — exported for tests.
 *
 * Mirrors the prior per-threat SQL:
 *   sp.profile_url LIKE '%' || ? || '%'         (full domain)
 *   OR sp.handle    LIKE '%' || ? || '%'        (domain's first label)
 *
 * Pulling the social_profiles set once per Sentinel batch and
 * matching in-memory replaces N full-table LIKE scans (12.4M rows /
 * 24h per the diagnostic top-queries report) with a single
 * filtered SELECT.
 */
export function findSocialMatchesForDomain(
  profiles: SocialProfileRow[],
  domain: string,
  limit = 3,
): SocialProfileRow[] {
  const domainKeyword = domain.split(".")[0] ?? "";
  const matches: SocialProfileRow[] = [];
  for (const p of profiles) {
    const profileUrlHit = !!(p.profile_url && p.profile_url.includes(domain));
    const handleHit = !!(domainKeyword && p.handle && p.handle.includes(domainKeyword));
    if (profileUrlHit || handleHit) {
      matches.push(p);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

// ─── Sentinel Agent ─────────────────────────────────────────────

export const sentinelAgent: AgentModule = {
  name: "sentinel",
  displayName: "Sentinel",
  description: "Certificate & domain surveillance — classifies new threats with source/type rules",
  color: "#C83C3C",
  trigger: "event",
  requiresApproval: false,
  stallThresholdMinutes: 75,
  parallelMax: 1,
  costGuard: "enforced",
  // execute() makes no AI call since Phase 1 (rules only). The cap still
  // governs runSentinelSocialAssessment, which bills under agentId
  // "sentinel" — ~20 Haiku calls per social-monitor batch.
  budget: { monthlyTokenCap: 100_000_000 },
  reads: [
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "monitored_brands" },
    { kind: "d1_table", name: "social_monitor_results" },
    { kind: "d1_table", name: "social_profiles" },
    { kind: "d1_table", name: "threat_actor_infrastructure" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [
    { kind: "d1_table", name: "social_monitor_results" },
    { kind: "d1_table", name: "threat_actor_infrastructure" },
    { kind: "d1_table", name: "threat_actor_targets" },
    { kind: "d1_table", name: "threat_actors" },
    { kind: "d1_table", name: "threats" },
  ],
  outputs: [{ type: "classification" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 1,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env } = ctx;

    // Load monitored brand keywords from DB, fall back to hardcoded list
    const monitoredBrands = await env.DB.prepare(
      `SELECT b.name FROM brands b
       INNER JOIN monitored_brands mb ON mb.brand_id = b.id
       WHERE mb.status = 'active'`
    ).all<{ name: string }>().catch(() => ({ results: [] as { name: string }[] }));

    const brandKeywords = monitoredBrands.results.length > 0
      ? monitoredBrands.results.map((b) => b.name.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((k) => k.length >= 3)
      : FALLBACK_BRAND_KEYWORDS;

    // Get unclassified threats (no confidence_score yet). Wrapped in
    // withD1Retry: this top-level read is unguarded (unlike monitoredBrands
    // above, which has a .catch fallback) and a transient "Network
    // connection lost" here threw straight out of execute(), failing the
    // whole run. Idempotent read → safe to retry.
    const threats = await withD1Retry(
      () =>
        env.DB.prepare(
          `SELECT id, malicious_url, malicious_domain, ip_address, asn, country_code, source_feed, ioc_value, threat_type, target_brand_id
           FROM threats
           WHERE confidence_score IS NULL
           ORDER BY created_at DESC LIMIT 50`,
        ).all<{
          id: string; malicious_url: string | null; malicious_domain: string | null;
          ip_address: string | null; asn: string | null; country_code: string | null;
          source_feed: string; ioc_value: string | null;
          threat_type: string | null; target_brand_id: string | null;
        }>(),
      { label: "sentinel unclassified-threats read" },
    );

    // Both counts are diagnostic only — cache via cachedCount (KV-
    // backed) so we don't full-scan the 174K-row threats table on
    // every Sentinel tick (~24/day, ~4.4M rows_read/day eliminated
    // by this cache). 15-min TTL.
    //
    // Pre-fix this used `getOrComputeMetric` which writes a freshness
    // row to the system_metrics table on every check — that itself
    // burned a D1 read. cachedCount stores in KV, so cache lookups
    // cost zero D1 reads.
    // PR-AM: TTL bumped 900s → 3600s. Total threat count drifts very
    // slowly (~5% per hour during ingest peaks); a 1h cache window is
    // well within tolerance and quadruples the hit rate.
    const totalCount = { n: await cachedCount(env, 'count.threats.total', 3600, async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM threats").first<{ n: number }>();
      return row?.n ?? 0;
    }) };
    // PR-BU: TTL 900s → 7200s. Sentinel is dispatched from the hourly
    // orchestrator tick (after feed ingestion when totalNew > 0), so
    // its inter-run gap is ~1-2h. A 15-min TTL is far shorter than
    // that gap → the entry always expired before the next run → this
    // full-table `confidence_score IS NULL` scan ran every dispatch
    // (diagnostics: 29.5M reads/24h). A 2h TTL exceeds the inter-run
    // gap so consecutive runs reuse the warmed entry. This count is
    // diagnostic-only (per-run summary logging); a stale reading is
    // acceptable even though sentinel itself drains the null-confidence
    // backlog. (No cube/pre-computed column covers this predicate;
    // migration 0256 adds a partial index idx_threats_null_confidence
    // ON threats(created_at DESC) WHERE confidence_score IS NULL so both
    // this COUNT and the re-classify SELECT above are served from the
    // index instead of a full-table scan — the raised TTL now just
    // absorbs the residual index-count cost.)
    const nullCount = { n: await cachedCount(env, 'count.threats.null_confidence', 7200, async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM threats WHERE confidence_score IS NULL").first<{ n: number }>();
      return row?.n ?? 0;
    }) };

    let itemsProcessed = 0;
    let itemsUpdated = 0;
    let impersonationsFound = 0;
    let credentialPathEscalations = 0;
    const outputs: AgentOutputEntry[] = [];

    // Pre-fetch the suspicious / impersonation social_profiles set
    // ONCE per batch, then match in-memory inside the per-threat
    // loop. Replaces the previous per-threat double-LIKE query that
    // the diagnostic top-queries report flagged at 12.4M rows / 24h
    // (738 calls × ~17K rows scanned per call). The active+suspicious
    // /impersonation predicate keeps the working set small (<10K
    // rows realistically), so the JSON returned fits comfortably in
    // Workers RAM.
    let socialProfiles: SocialProfileRow[] = [];
    try {
      const r = await env.DB.prepare(`
        SELECT sp.handle, sp.platform, sp.classification, sp.profile_url,
               b.name AS brand_name
          FROM social_profiles sp
          JOIN brands b ON b.id = sp.brand_id
         WHERE sp.status = 'active'
           AND sp.classification IN ('suspicious', 'impersonation')
      `).all<SocialProfileRow>();
      socialProfiles = r.results ?? [];
    } catch (err) {
      // Non-fatal — social cross-ref is best-effort.
      console.warn("[sentinel] social profile prefetch failed:", err);
    }

    // Concurrent fan-out cap. Classification itself is now pure CPU
    // (ruleBasedClassify), but each threat still does up to ~4 D1
    // round-trips (Iranian-APT actor bumps + the final UPDATE). Five at
    // a time keeps a slow D1 write localized to its wave. Counter
    // increments and outputs[] pushes are race-free because JS is
    // single-threaded between awaits.
    const SENTINEL_CONCURRENCY = 5;
    const threatList = threats.results;

    for (let i = 0; i < threatList.length; i += SENTINEL_CONCURRENCY) {
      const wave = threatList.slice(i, i + SENTINEL_CONCURRENCY);
      await Promise.all(wave.map((threat) => processThreat(threat)));
    }

    async function processThreat(threat: typeof threatList[number]): Promise<void> {
      itemsProcessed++;

      const domain = threat.malicious_domain;
      const squattedBrand = domain ? detectBrandSquatting(domain, brandKeywords) : null;

      // Rules are the only classifier (AI_STRATEGY_2026-10 Phase 1).
      // `brandMatched` drives the credential-path escalation: either the
      // domain carries a monitored brand keyword (and is not the brand's
      // own apex), or the threat was already attributed to a brand.
      const rule = ruleBasedClassify({
        sourceFeed: threat.source_feed,
        threatType: threat.threat_type,
        maliciousUrl: threat.malicious_url,
        brandMatched: squattedBrand !== null || !!threat.target_brand_id,
      });
      let confidence = rule.confidence;
      let severity: string = rule.severity;
      if (rule.credentialPathEscalated) credentialPathEscalations++;

      // Impersonation detection on domain
      let threatType = threat.threat_type;
      if (domain) {
        const hasHomoglyphs = detectHomoglyphs(domain);

        if (hasHomoglyphs || squattedBrand) {
          impersonationsFound++;
          if (severity === "low" || severity === "medium") severity = "high";
          if (threatType === "unknown") threatType = "impersonation";
          confidence = Math.min(95, confidence + 10);
        }
      }

      // Iranian APT infrastructure detection — auto-escalate threats from known IRGC/MOIS ASNs
      if (threat.asn && IRANIAN_APT_ASNS.has(threat.asn)) {
        if (severity === "low" || severity === "medium") severity = "high";
        if (severity === "high" && (threatType === "credential_harvesting" || threatType === "malware_distribution")) {
          severity = "critical";
        }
        confidence = Math.min(98, confidence + 15);
        outputs.push({
          type: "classification",
          summary: `**Iranian APT Infrastructure** — Threat ${threat.id} (${domain ?? threat.ip_address ?? "unknown"}) originates from known Iranian APT ASN ${threat.asn}. Auto-escalated to ${severity}.`,
          severity: severity as "critical" | "high" | "medium" | "low" | "info",
          details: {
            threat_id: threat.id,
            asn: threat.asn,
            country_code: threat.country_code,
            domain,
            escalated_severity: severity,
            iranian_apt_asn: true,
          },
        });

        // Update threat actor activity tracking — last_seen + last_observed.
        // Tiered match, most specific first:
        //   1. Exact ASN → bump that specific actor
        //   2. No ASN match but threat country is known (e.g. 'IR') →
        //      bump every active actor from that country. Coarser, but we
        //      already know this threat came from Iranian APT infrastructure
        //      (we're inside the IRANIAN_APT_ASNS branch), so it's a
        //      meaningful signal that the whole cluster is live.
        // Non-blocking: failures don't impact the classification path.
        try {
          const actorIdRow = await env.DB.prepare(
            `SELECT threat_actor_id FROM threat_actor_infrastructure WHERE asn = ? LIMIT 1`
          ).bind(threat.asn).first<{ threat_actor_id: string }>();
          if (actorIdRow?.threat_actor_id) {
            await env.DB.batch([
              env.DB.prepare(
                `UPDATE threat_actors SET last_seen = datetime('now'), updated_at = datetime('now') WHERE id = ?`
              ).bind(actorIdRow.threat_actor_id),
              env.DB.prepare(
                `UPDATE threat_actor_infrastructure SET last_observed = datetime('now') WHERE threat_actor_id = ? AND asn = ?`
              ).bind(actorIdRow.threat_actor_id, threat.asn),
            ]);
            // Also update last_targeted if the threat hits a tracked brand
            if (threat.target_brand_id) {
              await env.DB.prepare(
                `UPDATE threat_actor_targets SET last_targeted = datetime('now') WHERE threat_actor_id = ? AND brand_id = ?`
              ).bind(actorIdRow.threat_actor_id, threat.target_brand_id).run();
            }
          } else if (threat.country_code) {
            // Country-level fallback: bump every active actor from that
            // country. Scoped to 'active' status so disrupted/dormant actors
            // don't get falsely resurrected.
            await env.DB.prepare(
              `UPDATE threat_actors
                  SET last_seen = datetime('now'),
                      updated_at = datetime('now')
                WHERE country_code = ?
                  AND status = 'active'`
            ).bind(threat.country_code).run();
          }
        } catch (err) {
          // swallow: threat_actor_* tables optional, don't block Sentinel
          console.error('[sentinel] threat_actor activity update failed:', err);
        }
      }

      // Cross-reference with the pre-fetched social_profiles set
      // (one query at the top of the batch, in-memory match here).
      if (domain) {
        const socialMatches = findSocialMatchesForDomain(socialProfiles, domain);
        if (socialMatches.length > 0) {
          const correlationNote = socialMatches.map(s =>
            `Correlated with ${s.classification} ${s.platform} profile @${s.handle} (${s.brand_name})`
          ).join('; ');

          // Escalate severity on social correlation
          if (severity === 'medium') severity = 'high';
          else if (severity === 'high') severity = 'critical';

          outputs.push({
            type: "classification",
            summary: `**Social Correlation** — Threat ${threat.id} (${domain}) correlates with social impersonation: ${correlationNote}`,
            severity: severity as "critical" | "high" | "medium" | "low" | "info",
            details: {
              threat_id: threat.id,
              domain,
              social_matches: socialMatches,
              escalated_severity: severity,
            },
          });
        }
      }

      // SaaS attack technique classification (PushSecurity taxonomy).
      const saasTechniqueId = classifySaasTechnique({
        threat_type:      threatType,
        malicious_domain: threat.malicious_domain,
        malicious_url:    threat.malicious_url,
        source_feed:      threat.source_feed,
      });

      try {
        await env.DB.prepare(
          `UPDATE threats
             SET confidence_score   = ?,
                 severity           = COALESCE(severity, ?),
                 threat_type        = ?,
                 saas_technique_id  = COALESCE(saas_technique_id, ?)
           WHERE id = ?`
        ).bind(confidence, severity, threatType, saasTechniqueId, threat.id).run();
        itemsUpdated++;
      } catch (err) {
        console.error(`[sentinel] update failed for ${threat.id}:`, err);
      }
    }

    // The state-sponsored "APT pattern" batch guess that used to sit here
    // (one Haiku call over the batch's domains) was deleted in Phase 1:
    // it asked the model to recognise typosquats from a bare domain list,
    // which the homoglyph / brand-squat / IRANIAN_APT_ASNS rules above
    // already do deterministically. Attribution belongs to NEXUS +
    // attributor, not a per-batch guess.

    // Always generate a summary output so agent_outputs gets populated.
    // No aiCalls* counters: execute() makes no Anthropic call, so it is
    // not one of the counter-instrumented agents Flight Control's
    // platform_ai_calls_failing check or diagnostics ai_health read.
    outputs.push({
      type: "classification",
      summary: itemsProcessed > 0
        ? `Sentinel classified ${itemsUpdated} threats (${itemsProcessed} processed, ${impersonationsFound} impersonations, rules=${itemsProcessed}, credentialPathEscalations=${credentialPathEscalations})`
        : `Sentinel found 0 unclassified threats (${totalCount?.n ?? 0} total in DB, ${nullCount?.n ?? 0} with NULL confidence)`,
      severity: "info",
      details: {
        processed: itemsProcessed,
        updated: itemsUpdated,
        impersonationsFound,
        rulesClassified: itemsProcessed,
        credentialPathEscalations,
        totalThreats: totalCount?.n ?? 0,
        nullConfidenceThreats: nullCount?.n ?? 0,
      },
    });

    return {
      itemsProcessed,
      itemsCreated: 0,
      itemsUpdated,
      output: { classified: itemsUpdated, impersonationsFound, credentialPathEscalations },
      tokensUsed: 0,
      agentOutputs: outputs,
    };
  },
};

// ─── Social Assessment ───────────────────────────────────────

interface SocialAssessmentRow {
  id: string;
  brand_id: string;
  platform: string;
  handle_checked: string;
  suspicious_account_url: string | null;
  suspicious_account_name: string | null;
  impersonation_score: number;
  impersonation_signals: string;
  severity: string;
  brand_name: string;
  domain: string;
  official_handles: string | null;
}

interface SocialAssessmentAI {
  confirmed_impersonation: boolean;
  confidence: number;
  reasoning: string;
  recommended_action: string;
  evidence_summary: string | null;
}

/**
 * AI-assess open HIGH/CRITICAL social monitoring results that lack an ai_assessment.
 * Called by the cron orchestrator after runSocialMonitorBatch completes.
 * Routed through callAnthropicJSON (budget_ledger + AI Gateway). This is
 * sentinel's only remaining AI call; execute() is rules-only.
 */
export async function runSentinelSocialAssessment(env: Env): Promise<void> {
  // Fetch unassessed HIGH/CRITICAL results.
  // brand_profiles retired (R3, 2026-05-07) — query the brands
  // table directly. Pre-deprecation rows whose brand_id is a stale
  // brand_profiles.id won't match brands.id and get skipped here;
  // that's correct (the assessment loop was silently no-op'ing
  // those rows anyway since brand_profiles is empty).
  const rows = await env.DB.prepare(`
    SELECT smr.id, smr.brand_id, smr.platform, smr.handle_checked,
           smr.suspicious_account_url, smr.suspicious_account_name,
           smr.impersonation_score, smr.impersonation_signals, smr.severity,
           b.name AS brand_name,
           b.canonical_domain AS domain,
           b.official_handles
    FROM social_monitor_results smr
    JOIN brands b ON b.id = smr.brand_id
    WHERE smr.severity IN ('HIGH', 'CRITICAL')
      AND smr.ai_assessment IS NULL
      AND smr.status = 'open'
    ORDER BY smr.created_at DESC
    LIMIT 20
  `).all<SocialAssessmentRow>();

  if (rows.results.length === 0) {
    return;
  }

  let assessed = 0;
  let failed = 0;

  for (const row of rows.results) {
    // Parse official handles to find the one for this platform
    let officialHandles: Record<string, string> = {};
    try { officialHandles = row.official_handles ? JSON.parse(row.official_handles) : {}; } catch { /* ignore */ }
    const officialHandle = officialHandles[row.platform]?.replace(/^@/, "") ?? "not set";

    // Parse impersonation signals into a bullet list
    let signals: string[] = [];
    try { signals = JSON.parse(row.impersonation_signals || "[]"); } catch { /* ignore */ }
    const signalBullets = signals.length > 0
      ? signals.map((s) => `- ${s}`).join("\n")
      : "- (none detected)";

    const systemPrompt =
      "You are a brand protection analyst. Evaluate whether this social media account is impersonating the brand below.\n" +
      "Respond in JSON only — no preamble, no markdown.";

    const userMessage =
      `BRAND: ${row.brand_name} — ${row.domain}\n` +
      `Official ${row.platform} handle: ${officialHandle}\n\n` +
      `SUSPICIOUS ACCOUNT:\n` +
      `- Handle: ${row.handle_checked}\n` +
      `- Platform: ${row.platform}\n` +
      `- Impersonation score: ${Math.round(row.impersonation_score * 100)}%\n` +
      `- Signals detected:\n${signalBullets}\n` +
      `- Follower count: unknown\n` +
      `- Account age: unknown days\n` +
      `- Verified: no\n\n` +
      `{\n` +
      `  "confirmed_impersonation": true | false,\n` +
      `  "confidence": 0.0-1.0,\n` +
      `  "reasoning": "1-2 sentence plain English assessment",\n` +
      `  "recommended_action": "monitor" | "report" | "legal_notice" | "dismiss",\n` +
      `  "evidence_summary": "one paragraph suitable for a platform abuse report, or null if dismiss"\n` +
      `}`;

    // Route through the canonical wrapper so the call lands in
    // budget_ledger like every other Anthropic call. agentId stays
    // "sentinel" for the per-agent spend roll-up; runId is null
    // because this helper runs outside the standard agentRunner.
    try {
      let parsed: SocialAssessmentAI;
      try {
        const { parsed: jsonParsed } = await callAnthropicJSON<SocialAssessmentAI>(env, {
          agentId: "sentinel",
          runId: null,
          model: HOT_PATH_HAIKU,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          maxTokens: 1024,
        });
        parsed = jsonParsed;
      } catch (callErr) {
        console.error(`[sentinel-social] Haiku call failed for ${row.id}: ${callErr instanceof Error ? callErr.message : String(callErr)}`);
        failed++;
        continue;
      }

      // Store result into the four columns added by migration 0035
      await env.DB.prepare(`
        UPDATE social_monitor_results
        SET ai_assessment = ?,
            ai_confidence = ?,
            ai_action = ?,
            ai_evidence_draft = ?
        WHERE id = ?
      `).bind(
        parsed.reasoning,
        parsed.confidence,
        parsed.recommended_action,
        parsed.evidence_summary ?? null,
        row.id,
      ).run();

      assessed++;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[sentinel-social] Error assessing ${row.id}: ${errMsg}`);
      failed++;
    }
  }

}

// ─── Rule-based classification ──────────────────────────────────

/**
 * Source-feed confidence tiers. Keys are the literal `threats.source_feed`
 * strings the feed modules write (src/feeds/*.ts). `mastodon_ioc` is an
 * archived feed (src/feeds/_archive) kept so historical rows still score
 * as a social source.
 */
const FEED_CONFIDENCE_90 = new Set([
  "phishtank", "threatfox", "feodo", "sslbl", "malwarebazaar", "cisa_iran_iocs",
]);
const FEED_CONFIDENCE_80 = new Set([
  "urlhaus", "openphish", "phishing_database", "phishstats",
]);
const FEED_CONFIDENCE_70 = new Set([
  "tweetfeed", "mastodon_ioc", "otx_alienvault", "digitalside_osint", "circl_osint", "urlscanio",
]);
// Speculative sources: certificate transparency, generated typosquat
// permutations and newly-registered-domain lists name candidates, not
// observed malicious activity.
const FEED_CONFIDENCE_50 = new Set(["ct_logs", "typosquat_scanner", "nrd_hagezi"]);
const DEFAULT_FEED_CONFIDENCE = 60;
const UNKNOWN_TYPE_PENALTY = 10;
const CONFIDENCE_FLOOR = 40;

/**
 * Tokens that mark a credential-capture page when they appear in a
 * brand-matched URL's path or query. Plain substring checks, lowercased.
 */
export const CREDENTIAL_PATH_TOKENS = [
  "login", "signin", "verify", "account", "wallet", "password", "2fa", "secure",
] as const;

export type RuleSeverity = "critical" | "high" | "medium" | "low";

const SEVERITY_RANK: Record<RuleSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface RuleClassifyInput {
  sourceFeed: string;
  threatType: string | null;
  maliciousUrl?: string | null;
  /** The threat's domain matched a monitored brand keyword, or it is already brand-attributed. */
  brandMatched?: boolean;
}

export interface RuleClassifyResult {
  confidence: number;
  severity: RuleSeverity;
  /** The credential-path escalation raised severity (it was below high). */
  credentialPathEscalated: boolean;
}

function feedConfidence(sourceFeed: string): number {
  if (FEED_CONFIDENCE_90.has(sourceFeed)) return 90;
  if (FEED_CONFIDENCE_80.has(sourceFeed)) return 80;
  if (FEED_CONFIDENCE_70.has(sourceFeed)) return 70;
  if (FEED_CONFIDENCE_50.has(sourceFeed)) return 50;
  return DEFAULT_FEED_CONFIDENCE;
}

function typeSeverity(sourceFeed: string, threatType: string | null): RuleSeverity {
  if (sourceFeed === "feodo") return "critical";
  switch (threatType) {
    case "c2":
    case "botnet":
      return "critical";
    case "malware_distribution":
    case "credential_harvesting":
      return "high";
    case "phishing":
    case "impersonation":
    case "typosquatting":
      return "medium";
    case "malicious_ip":
    case "scanning":
      return "low";
    default:
      return "medium";
  }
}

/**
 * The path + query portion of a URL, lowercased. Tolerates scheme-less
 * values (`evil.com/login`) by retrying with an `http://` prefix. The
 * host is deliberately excluded so a token in the hostname
 * (`secure-paypal.com`) cannot satisfy the path check on its own.
 * Returns "" when the value cannot be parsed as a URL.
 */
export function urlPathAndQuery(rawUrl: string): string {
  const candidates = rawUrl.includes("://") ? [rawUrl] : [`http://${rawUrl}`];
  for (const c of candidates) {
    try {
      const u = new URL(c);
      return `${u.pathname}${u.search}`.toLowerCase();
    } catch {
      // unparseable — fall through
    }
  }
  return "";
}

export function hasCredentialPathToken(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  const pq = urlPathAndQuery(rawUrl);
  if (!pq) return false;
  for (const token of CREDENTIAL_PATH_TOKENS) {
    if (pq.includes(token)) return true;
  }
  return false;
}

/**
 * Sentinel's sole classifier. Pure — exported for tests.
 *
 *   confidence = source-feed tier (90/80/70/50, default 60),
 *                −10 when threat_type is NULL/'unknown', floor 40
 *   severity   = by threat_type (feodo is always critical), then
 *                raised to at least 'high' when the threat is
 *                brand-matched AND its URL path/query carries a
 *                credential token (login, verify, wallet, …)
 *
 * The homoglyph / brand-squat / Iranian-APT-ASN / social-correlation
 * escalations run after this in processThreat and are unchanged.
 */
export function ruleBasedClassify(input: RuleClassifyInput): RuleClassifyResult {
  let confidence = feedConfidence(input.sourceFeed);
  if (!input.threatType || input.threatType === "unknown") {
    confidence = Math.max(CONFIDENCE_FLOOR, confidence - UNKNOWN_TYPE_PENALTY);
  }

  let severity = typeSeverity(input.sourceFeed, input.threatType);
  let credentialPathEscalated = false;
  if (
    input.brandMatched
    && SEVERITY_RANK[severity] < SEVERITY_RANK.high
    && hasCredentialPathToken(input.maliciousUrl)
  ) {
    severity = "high";
    credentialPathEscalated = true;
  }

  return { confidence, severity, credentialPathEscalated };
}
