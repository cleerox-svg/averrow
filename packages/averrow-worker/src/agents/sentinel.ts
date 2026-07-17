/**
 * Sentinel Agent — Certificate & domain surveillance.
 *
 * Runs on every feed ingestion event. Classifies new threats
 * via Haiku AI and assigns confidence scores + severity.
 * Falls back to rule-based classification when Haiku is unavailable.
 *
 * Also performs:
 * - Source-quality confidence boosting (merged from triage agent)
 * - Homoglyph & brand-squatting detection (merged from impersonation-detector agent)
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import type { Env } from "../types";
import { classifyThreat } from "../lib/haiku";
import { callAnthropicJSON } from "../lib/anthropic";
import { classifySaasTechnique } from "../lib/saas-classifier";
import { HOT_PATH_HAIKU } from "../lib/ai-models";
import { cachedCount } from "../lib/cached-count";
import { withD1Retry } from "../lib/d1-retry";

// ─── Sibling-domain dedup (Lever #3) ─────────────────────────────

/**
 * Extract the registrable / apex domain (eTLD+1) from a hostname.
 * "login.fake-paypal.com" → "fake-paypal.com"
 * "abc.def.gov.uk"       → "def.gov.uk"
 *
 * Used for sibling-domain dedup at the Haiku-classification step:
 * two threats with the same (apex_domain, source_feed, asn) are
 * almost certainly the same campaign, and the classifier returns
 * the same threat_type / severity / confidence for both. Sharing
 * the result eliminates the duplicate AI call.
 *
 * Per-threat enrichment (homoglyph detect, brand squat, Iranian APT
 * escalation) still runs INDIVIDUALLY on every threat — only the
 * base classification is shared. So sibling subdomains can still
 * land at different severities if one happens to match a homoglyph.
 *
 * Inlined here instead of importing from analyst.ts to avoid coupling
 * two agents through a util file.
 */
function getApexDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  const sld = parts[parts.length - 2] ?? "";
  const knownSlds = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "ltd", "plc"]);
  if (sld.length > 0 && sld.length <= 3 && knownSlds.has(sld)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/**
 * Compose the dedup key for sibling-domain classification sharing.
 * Threats sharing this tuple inherit the same Haiku classification.
 *
 * When malicious_domain is null (IP-only threats), we still group by
 * (source_feed, asn) — different feeds emit IP threats with different
 * default semantics, and same-feed/same-ASN clusters are almost always
 * the same campaign.
 */
function classificationGroupKey(threat: {
  malicious_domain: string | null;
  source_feed: string;
  asn: string | null;
}): string {
  const apex = threat.malicious_domain ? getApexDomain(threat.malicious_domain) : "";
  return `${apex}|${threat.source_feed}|${threat.asn ?? ""}`;
}

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
  description: "Certificate & domain surveillance — classifies new threats via AI",
  color: "#C83C3C",
  trigger: "event",
  requiresApproval: false,
  stallThresholdMinutes: 75,
  parallelMax: 1,
  costGuard: "enforced",
  // Per-tick high volume — classifies each new threat from feed
  // ingestion. Sized for ~50-200 calls per hourly run.
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
    const { env, runId } = ctx;
    const callCtx = { agentId: "sentinel", runId };

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
          threat_type: string; target_brand_id: string | null;
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
    const nullCount = { n: await cachedCount(env, 'count.threats.null_confidence', 900, async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) as n FROM threats WHERE confidence_score IS NULL").first<{ n: number }>();
      return row?.n ?? 0;
    }) };

    let itemsProcessed = 0;
    let itemsUpdated = 0;
    let impersonationsFound = 0;
    const outputs: AgentOutputEntry[] = [];
    let totalTokens = 0;
    let model: string | undefined;
    let haikuSuccesses = 0;
    let haikuFailures = 0;
    let aiSkippedByRules = 0;

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

    // Concurrent fan-out cap. The prior implementation processed
    // threats serially with one Haiku call + 3 inner DB reads per
    // iteration — 50-threat batches routinely hit the 15-min
    // navigator reaper threshold (21% of runs killed over 48h per
    // diagnostics). Five at a time keeps any single Haiku stall
    // localized to its wave instead of blocking the whole batch.
    // Same prompts, same JSON parsing — zero classification-quality
    // risk. Increments to itemsProcessed / counters and pushes to
    // outputs[] are race-free because JS is single-threaded between
    // awaits.
    const SENTINEL_CONCURRENCY = 5;
    const threatList = threats.results;

    // Lever #3: sibling-domain classification cache. Threats sharing
    // (apex_domain, source_feed, asn) reuse the FIRST caller's Haiku
    // result — the next caller awaits the same promise instead of firing
    // its own call. Per-threat enrichment still runs individually below.
    // Map keys go in as soon as the call is initiated (not resolved) so
    // concurrent wave-mates don't race into duplicate Haiku calls.
    type ClassificationResult = Awaited<ReturnType<typeof classifyThreat>>;
    const classificationCache = new Map<string, Promise<ClassificationResult>>();
    let aiSkippedBySibling = 0;
    const getOrClassify = (threat: typeof threatList[number]): Promise<ClassificationResult> => {
      const key = classificationGroupKey(threat);
      const existing = classificationCache.get(key);
      if (existing) {
        aiSkippedBySibling++;
        return existing;
      }
      const p = classifyThreat(env, callCtx, {
        malicious_url: threat.malicious_url,
        malicious_domain: threat.malicious_domain,
        ip_address: threat.ip_address,
        source_feed: threat.source_feed,
        ioc_value: threat.ioc_value,
      });
      classificationCache.set(key, p);
      return p;
    };

    for (let i = 0; i < threatList.length; i += SENTINEL_CONCURRENCY) {
      const wave = threatList.slice(i, i + SENTINEL_CONCURRENCY);
      await Promise.all(wave.map((threat) => processThreat(threat, getOrClassify)));
    }

    async function processThreat(
      threat: typeof threats.results[number],
      getOrClassify: (t: typeof threats.results[number]) => Promise<Awaited<ReturnType<typeof classifyThreat>>>,
    ): Promise<void> {
      itemsProcessed++;

      // Pre-filter: high-confidence feeds with known threat types skip AI
      const ruleResult = ruleBasedClassify(threat.source_feed, threat.threat_type);
      const skipAI = ruleResult.confidence >= 85 && threat.threat_type && threat.threat_type !== 'unknown';

      let confidence: number;
      let severity: string;

      if (skipAI) {
        // High-confidence feed with known threat type — trust the feed
        confidence = ruleResult.confidence;
        severity = ruleResult.severity;
        haikuSuccesses++; // count as success for stats
        aiSkippedByRules++;
      } else {
        // Try Haiku classification. Lever #3: routed through
        // getOrClassify so sibling threats share a single AI call —
        // the first caller fires it, subsequent callers in the same
        // tick (same apex_domain + source_feed + asn) await the same
        // promise.
        const result = await getOrClassify(threat);

        if (result.success && result.data) {
          haikuSuccesses++;
          confidence = result.data.confidence;
          severity = result.data.severity;
          if (result.tokens_used) totalTokens += result.tokens_used;
          if (result.model) model = result.model;
        } else {
          haikuFailures++;
          // Fallback: rule-based scoring with source-quality boosting
          const fb = ruleBasedClassify(threat.source_feed, threat.threat_type);
          confidence = fb.confidence;
          severity = fb.severity;
        }
      }

      // Impersonation detection on domain
      let threatType = threat.threat_type;
      const domain = threat.malicious_domain;
      if (domain) {
        const hasHomoglyphs = detectHomoglyphs(domain);
        const squattedBrand = detectBrandSquatting(domain, brandKeywords);

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

    // Always generate a summary output so agent_outputs gets populated
    outputs.push({
      type: "classification",
      summary: itemsProcessed > 0
        ? `Sentinel classified ${itemsUpdated} threats (${itemsProcessed} processed, ${impersonationsFound} impersonations, haiku=${haikuSuccesses}/${haikuFailures}, aiSkippedByRules=${aiSkippedByRules}, aiSkippedBySibling=${aiSkippedBySibling})`
        : `Sentinel found 0 unclassified threats (${totalCount?.n ?? 0} total in DB, ${nullCount?.n ?? 0} with NULL confidence)`,
      severity: "info",
      details: {
        processed: itemsProcessed,
        updated: itemsUpdated,
        impersonationsFound,
        haikuSuccesses,
        haikuFailures,
        aiSkippedByRules,
        aiSkippedBySibling,
        totalThreats: totalCount?.n ?? 0,
        nullConfidenceThreats: nullCount?.n ?? 0,
        anthropicApiConfigured: !!env.ANTHROPIC_API_KEY,
      },
    });

    // ─── APT pattern detection (if batch >= 10 threats) ─────────
    let aptHits = 0;
    if (itemsProcessed >= 10) {
      try {
        const recentDomains = threats.results
          .filter(t => t.malicious_domain)
          .map(t => t.malicious_domain)
          .slice(0, 30);
        if (recentDomains.length >= 10) {
          const { callHaikuRaw } = await import("../lib/haiku");
          const aptResult = await callHaikuRaw(env, callCtx,
            "You detect state-sponsored phishing patterns. Reply ONLY with valid JSON array, no markdown.",
            `Given these new threat domains: ${JSON.stringify(recentDomains)}. Do any match known state-sponsored phishing patterns (typosquats of government/military/financial domains)? Reply JSON: [{domain, apt_pattern, confidence: "high"|"medium"|"low", notes}]. Only include high/medium confidence. Empty array if none.`,
            512,
          );
          if (aptResult.success && aptResult.text) {
            if (aptResult.tokens_used) totalTokens += aptResult.tokens_used;
            const jsonMatch = aptResult.text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const hits = JSON.parse(jsonMatch[0]) as Array<{
                domain: string; apt_pattern: string; confidence: string; notes: string;
              }>;
              for (const hit of hits) {
                if (hit.confidence !== 'high' && hit.confidence !== 'medium') continue;
                aptHits++;
                // Escalate matching threats
                const matchingThreat = threats.results.find(t => t.malicious_domain === hit.domain);
                if (matchingThreat) {
                  await env.DB.prepare(
                    "UPDATE threats SET severity = 'critical' WHERE id = ? AND severity != 'critical'"
                  ).bind(matchingThreat.id).run();
                }
                outputs.push({
                  type: "classification",
                  summary: `**APT Pattern Detected** — ${hit.domain} matches ${hit.apt_pattern} pattern (${hit.confidence} confidence). ${hit.notes}`,
                  severity: "critical",
                  details: { domain: hit.domain, apt_pattern: hit.apt_pattern, confidence: hit.confidence },
                });
              }
            }
          }
        }
      } catch (aptErr) {
        console.error("[sentinel] APT detection error:", aptErr);
      }
    }

    return {
      itemsProcessed,
      itemsCreated: 0,
      itemsUpdated,
      output: { classified: itemsUpdated, impersonationsFound, aptHits },
      model,
      tokensUsed: totalTokens,
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
 * Uses the same callAnthropic pattern as the main sentinel classification loop.
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

function ruleBasedClassify(
  sourceFeed: string,
  threatType: string,
): { confidence: number; severity: string } {
  const highConfidence = ["phishtank", "threatfox", "feodo", "cisa_kev"];
  const medConfidence = ["urlhaus", "openphish"];
  const socialSources = ["tweetfeed", "mastodon_ioc"];

  let confidence = 60;
  if (highConfidence.includes(sourceFeed)) confidence = 90;
  else if (medConfidence.includes(sourceFeed)) confidence = 80;
  else if (socialSources.includes(sourceFeed)) confidence = 70;

  let severity = "medium";
  if (threatType === "malware_distribution" || threatType === "credential_harvesting") severity = "high";
  if (threatType === "c2" || threatType === "botnet") severity = "critical";
  if (sourceFeed === "feodo") severity = "critical";
  if (sourceFeed === "cisa_kev") severity = "critical";

  return { confidence, severity };
}
