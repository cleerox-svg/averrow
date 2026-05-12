/**
 * Analyst Agent — Threat classification & brand matching via Haiku.
 *
 * Runs every 15 minutes. For threats that have no target_brand_id,
 * uses Haiku to infer the targeted brand from domain/URL patterns.
 * Complements the rule-based brand detection in lib/brandDetect.ts.
 */

import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from "../lib/agentRunner";
import { inferBrand } from "../lib/haiku";
import { loadSafeDomainSet, isSafeDomain } from "../lib/safeDomains";
import { correlateBrandThreats } from "../brand-threat-correlator";
import { resolveMasterBrandName } from "../lib/threatScoring";
import { getBrandSocialIntel } from "../lib/social-intel";
import { computeBrandExposureScore } from "../lib/brand-scoring";
import { getBrandById, incrementBrandThreatCount } from "../db/brands";
import { cachedValue } from "../lib/cached-value";

// ─── Domain parsing utilities ─────────────────────────────────────

/** Extract apex/registrable domain (eTLD+1). */
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

/** Extract subdomain portion (everything before the apex domain). */
function getSubdomain(domain: string): string {
  const apex = getApexDomain(domain);
  if (domain === apex) return "";
  return domain.slice(0, domain.length - apex.length - 1);
}

/** Check if a domain contains a numeric segment that can be varied. */
function extractNumberedPattern(domain: string): { prefix: string; num: number; suffix: string } | null {
  // Match patterns like "domain123.com" or "site-42-login.com"
  const match = domain.match(/^(.*?)(\d+)(.*?)$/);
  if (!match || !match[2]) return null;
  const num = parseInt(match[2], 10);
  if (isNaN(num)) return null;
  return { prefix: match[1] ?? '', num, suffix: match[3] ?? '' };
}

export const analystAgent: AgentModule = {
  name: "analyst",
  displayName: "ASTRA",
  description: "Threat classification & brand matching via Haiku",
  color: "#E8923C",
  trigger: "scheduled",
  requiresApproval: false,
  stallThresholdMinutes: 75,
  parallelMax: 1,
  costGuard: "enforced",
  budget: { monthlyTokenCap: 100_000_000 },
  reads: [
    { kind: "d1_table", name: "app_store_listings" },
    { kind: "d1_table", name: "brand_threat_assessments" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "dark_web_mentions" },
    { kind: "d1_table", name: "geopolitical_campaign_links" },
    { kind: "d1_table", name: "geopolitical_campaigns" },
    { kind: "d1_table", name: "monitored_brands" },
    { kind: "d1_table", name: "social_mentions" },
    { kind: "d1_table", name: "social_profiles" },
    { kind: "d1_table", name: "threats" },
  ],
  writes: [
    { kind: "d1_table", name: "agent_outputs" },
    { kind: "d1_table", name: "brands" },
    { kind: "d1_table", name: "threats" },
  ],
  outputs: [{ type: "classification" }],
  status: "active",
  category: "intelligence",
  pipelinePosition: 5,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    const { env, runId } = ctx;
    const callCtx = { agentId: "analyst", runId };

    const apiKey = env.ANTHROPIC_API_KEY || env.LRX_API_KEY;
    const keySource = env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : env.LRX_API_KEY ? "LRX_API_KEY" : "NONE";

    // Get threats without brand assignment that rule-based detection missed
    const threats = await env.DB.prepare(
      `SELECT id, malicious_url, malicious_domain, source_feed, threat_type
       FROM threats
       WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL
       ORDER BY created_at DESC LIMIT 30`
    ).all<{
      id: string; malicious_url: string | null;
      malicious_domain: string | null; source_feed: string; threat_type: string;
    }>();

    // Load known brands with their keyword/alias data for cheap pre-matching
    const brands = await env.DB.prepare(
      "SELECT id, name, brand_keywords, aliases FROM brands ORDER BY threat_count DESC LIMIT 100"
    ).all<{ id: string; name: string; brand_keywords: string | null; aliases: string | null }>();
    const brandNames = brands.results.map((b) => b.name);

    // Build a flat keyword → brand_id map for substring matching.
    // Keywords are typically lowercase, alphanumeric, ≥4 chars to avoid false positives.
    const keywordToBrandId = new Map<string, string>();
    for (const b of brands.results) {
      const addKeyword = (kw: string) => {
        const norm = kw.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (norm.length >= 4) keywordToBrandId.set(norm, b.id);
      };
      addKeyword(b.name);
      if (b.brand_keywords) {
        try {
          const kws = JSON.parse(b.brand_keywords) as string[];
          if (Array.isArray(kws)) kws.forEach(addKeyword);
        } catch { /* ignore parse errors */ }
      }
      if (b.aliases) {
        try {
          const als = JSON.parse(b.aliases) as string[];
          if (Array.isArray(als)) als.forEach(addKeyword);
        } catch { /* ignore parse errors */ }
      }
    }

    // Load safe domains for allowlist filtering
    const safeSet = await loadSafeDomainSet(env.DB);

    let itemsProcessed = 0;
    let itemsUpdated = 0;
    let totalTokens = 0;
    let model: string | undefined;
    let haikuSuccesses = 0;
    let haikuFailures = 0;
    let lowConfidence = 0;
    const outputs: AgentOutputEntry[] = [];

    let safeSkipped = 0;
    let keywordPreMatched = 0;
    const matchedBrandIds = new Set<string>();

    // Collect keyword-match updates to batch in one D1 request after the loop
    const keywordMatchBatch: { threatId: string; brandId: string }[] = [];
    // Collect AI-match updates similarly
    const aiMatchUpdates: {
      threatId: string; brandId: string; brandName: string; threatType: string;
      attackVector: string; targetAudience: string; sophistication: string;
    }[] = [];

    for (const threat of threats.results) {
      itemsProcessed++;

      // Skip threats whose domain is in the safe domain allowlist
      if (threat.malicious_domain && isSafeDomain(threat.malicious_domain, safeSet)) {
        safeSkipped++;
        continue;
      }

      // Pre-filter: substring match against brand keywords. Skip AI on confident matches.
      const domainNorm = (threat.malicious_domain ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      let preMatchedBrandId: string | null = null;
      if (domainNorm) {
        for (const [kw, brandId] of keywordToBrandId) {
          if (domainNorm.includes(kw)) {
            preMatchedBrandId = brandId;
            break;
          }
        }
      }

      if (preMatchedBrandId) {
        // High-confidence keyword match — collect for batch write below
        keywordPreMatched++;
        keywordMatchBatch.push({ threatId: threat.id, brandId: preMatchedBrandId });
        matchedBrandIds.add(preMatchedBrandId);
        itemsUpdated++;
        continue; // skip to next threat
      }

      // No keyword match — fall through to existing AI inference
      const result = await inferBrand(
        env,
        callCtx,
        {
          malicious_url: threat.malicious_url,
          malicious_domain: threat.malicious_domain,
          source_feed: threat.source_feed,
        },
        brandNames,
      );

      // Derive attack classification from available signals
      const domain = threat.malicious_domain ?? '';
      const url = threat.malicious_url ?? '';
      const attackVector = url.includes('login') || url.includes('signin') || url.includes('password') || domain.includes('login')
        ? 'credential_theft'
        : threat.threat_type === 'malware_distribution' ? 'malware'
        : domain.includes('redirect') || url.includes('redirect') ? 'redirect'
        : 'scam';
      const targetAudience = domain.includes('gov') || domain.includes('.mil') ? 'government'
        : domain.includes('crypto') || domain.includes('wallet') || domain.includes('nft') ? 'crypto'
        : domain.includes('enterprise') || domain.includes('corp') ? 'enterprise'
        : 'consumer';
      const sophistication = (domain.length > 30 || url.includes('?')) && !domain.includes('free')
        ? 'high' : domain.includes('free') || domain.includes('giveaway') ? 'low' : 'medium';

      // On FIRST call, write diagnostic directly to agent_outputs for D1 querying
      if (itemsProcessed === 1) {
        const diagSummary = `ANTHROPIC_API_KEY set=${!!env.ANTHROPIC_API_KEY}, LRX_API_KEY set=${!!env.LRX_API_KEY}, key_prefix=${apiKey ? apiKey.slice(0, 8) + "..." : "NONE"}, haiku_success=${result.success}, haiku_error=${result.error ?? "none"}, domain=${threat.malicious_domain}`;
        try {
          await env.DB.prepare(
            `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at)
             VALUES (?, 'analyst', 'diagnostic', ?, 'info', ?, datetime('now'))`
          ).bind(
            crypto.randomUUID(),
            diagSummary,
            JSON.stringify({
              anthropic_key_set: !!env.ANTHROPIC_API_KEY,
              lrx_key_set: !!env.LRX_API_KEY,
              key_source: keySource,
              key_prefix: apiKey ? apiKey.slice(0, 8) + "..." : "NONE",
              haiku_success: result.success,
              haiku_error: result.error ?? null,
              haiku_model: result.model ?? null,
              haiku_tokens: result.tokens_used ?? null,
              test_domain: threat.malicious_domain,
              threats_to_process: threats.results.length,
            }),
          ).run();
        } catch (diagErr) {
          console.error("[analyst] diagnostic write failed:", diagErr);
        }
      }

      if (!result.success || !result.data) {
        haikuFailures++;
        if (haikuFailures === 1) {
          console.error(`[analyst] FIRST HAIKU FAILURE — domain=${threat.malicious_domain}, error: ${result.error ?? "no data returned"}`);
          console.error(`[analyst] This error will repeat for all ${threats.results.length} threats. Fix the root cause above.`);
        }
        continue;
      }

      if (result.data.confidence < 70) {
        lowConfidence++;
        continue;
      }

      haikuSuccesses++;
      if (result.tokens_used) totalTokens += result.tokens_used;
      if (result.model) model = result.model;

      // Find or create the brand. Run the raw Haiku name through the
      // master-brand alias resolver so sub-brands like "Amazonses"
      // (Amazon SES) or "Cloudfront" (AWS CloudFront) fold into the
      // correct master brand instead of creating a new vanity row.
      // See audit C10 (2026-05-06).
      const matchedBrand = resolveMasterBrandName(
        result.data.brand_name,
        threat.malicious_domain,
      );
      let brandId = await env.DB.prepare(
        "SELECT id FROM brands WHERE LOWER(name) = LOWER(?)"
      ).bind(matchedBrand).first<{ id: string }>();

      if (!brandId) {
        const newId = `brand_${matchedBrand.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
        const domain = threat.malicious_domain ?? "unknown";
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO brands (id, name, canonical_domain, threat_count, first_seen)
             VALUES (?, ?, ?, 0, datetime('now'))`
          ).bind(newId, matchedBrand, domain).run();
          brandId = { id: newId };
        } catch (err) {
          console.error(`[analyst] Brand creation failed for ${matchedBrand}:`, err);
          continue;
        }
      }

      // Collect for batch DB write after the loop
      aiMatchUpdates.push({
        threatId: threat.id,
        brandId: brandId.id,
        brandName: matchedBrand,
        threatType: threat.threat_type,
        attackVector,
        targetAudience,
        sophistication,
      });
      matchedBrandIds.add(brandId.id);
      itemsUpdated++;
    }

    // ─── Batch flush keyword-match updates ────────────────────────
    // Send all keyword-matched threat updates in a single D1 batch request.
    if (keywordMatchBatch.length > 0) {
      try {
        await env.DB.batch(
          keywordMatchBatch.map(({ threatId, brandId }) =>
            env.DB.prepare(
              `UPDATE threats SET target_brand_id = ?, brand_match_method = 'keyword' WHERE id = ?`
            ).bind(brandId, threatId)
          )
        );
      } catch (err) {
        console.error('[analyst] keyword batch update failed:', err);
      }
    }

    // ─── Batch flush AI-match updates + email security escalations ──
    if (aiMatchUpdates.length > 0) {
      // Write brand assignments in one batch
      try {
        await env.DB.batch(
          aiMatchUpdates.map(({ threatId, brandId }) =>
            env.DB.prepare(
              "UPDATE threats SET target_brand_id = ? WHERE id = ? AND target_brand_id IS NULL"
            ).bind(brandId, threatId)
          )
        );
      } catch (err) {
        console.error('[analyst] AI-match batch update failed:', err);
      }

      // Bulk-increment threat counts for all matched brands
      const uniqueAiMatchedBrands = [...new Set(aiMatchUpdates.map(u => u.brandId))];
      for (const bId of uniqueAiMatchedBrands) {
        try { await incrementBrandThreatCount(env, bId); } catch { /* non-fatal */ }
      }

      // Fetch email security for all matched brands in one query, then process escalations
      if (uniqueAiMatchedBrands.length > 0) {
        const emailPlaceholders = uniqueAiMatchedBrands.map(() => '?').join(',');
        const emailSecRows = await env.DB.prepare(
          `SELECT id, email_security_grade FROM brands WHERE id IN (${emailPlaceholders})`
        ).bind(...uniqueAiMatchedBrands).all<{ id: string; email_security_grade: string | null }>();
        const emailSecMap = new Map(emailSecRows.results.map(r => [r.id, r.email_security_grade]));

        const severityEscalations: D1PreparedStatement[] = [];
        for (const update of aiMatchUpdates) {
          const grade = emailSecMap.get(update.brandId);
          if (grade && ['F', 'D'].includes(grade)) {
            if (update.threatType === 'phishing') {
              severityEscalations.push(
                env.DB.prepare("UPDATE threats SET severity = 'critical' WHERE id = ?").bind(update.threatId)
              );
            }
            outputs.push({
              type: 'classification',
              summary: `**Email Security Risk** — ${update.brandName} has grade ${grade}: weak spoofing protection increases phishing effectiveness. ${update.threatType === 'phishing' ? 'Threat escalated to CRITICAL.' : ''}`,
              severity: 'high',
              details: {
                brand: update.brandName,
                email_security_grade: grade,
                threat_type: update.threatType,
                attack_vector: update.attackVector,
                target_audience: update.targetAudience,
                sophistication: update.sophistication,
              },
              relatedBrandIds: [update.brandId],
            });
          }
        }
        if (severityEscalations.length > 0) {
          try { await env.DB.batch(severityEscalations); } catch { /* non-fatal */ }
        }
      }
    }

    // ─── Phase 2.5: Enrichment validation context per brand ─────
    // Split into 6 small queries (one per enrichment signal) to avoid the
    // single-query OR-over-six-columns that forces a full active-table scan.
    // See docs/runbooks/analyst-d1-diagnosis.md for EXPLAIN plans.
    //
    // KV-cached for 25 min. Analyst's natural cadence is hourly but
    // navigator pre-warming + retries had it running ~7×/hour
    // (diagnostics 2026-05-12 query #5: dbl_listed slice alone burned
    // 924k rows/hour). The 6 signals are all active-status snapshots,
    // not real-time — a stale 25-min reading is acceptable.
    const baseCond = "status = 'active' AND target_brand_id IS NOT NULL";
    const enrichmentBatch = await cachedValue<{
      surbl: Array<{ target_brand_id: string; cnt: number }>;
      vt: Array<{ target_brand_id: string; cnt: number }>;
      vtAvg: Array<{ target_brand_id: string; avg_mal: number | null }>;
      gsb: Array<{ target_brand_id: string; cnt: number }>;
      dbl: Array<{ target_brand_id: string; cnt: number }>;
      greynoise: Array<{ target_brand_id: string; noise_scanners: number; potentially_targeted: number }>;
      seclookup: Array<{ target_brand_id: string; high_risk: number }>;
    }>(env, "analyst.enrichment_by_brand", 1500, async () => {
      const [surblRows, vtRows, vtAvgRows, gsbRows, dblRows, greynoiseRows, seclookupRows] = await Promise.all([
        env.DB.prepare(
          `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${baseCond} AND surbl_listed = 1 GROUP BY target_brand_id`
        ).all<{ target_brand_id: string; cnt: number }>(),
        env.DB.prepare(
          `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${baseCond} AND vt_malicious > 0 GROUP BY target_brand_id`
        ).all<{ target_brand_id: string; cnt: number }>(),
        env.DB.prepare(
          `SELECT target_brand_id, ROUND(AVG(vt_malicious), 1) as avg_mal FROM threats WHERE ${baseCond} AND vt_malicious > 0 GROUP BY target_brand_id`
        ).all<{ target_brand_id: string; avg_mal: number | null }>(),
        env.DB.prepare(
          `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${baseCond} AND gsb_flagged = 1 GROUP BY target_brand_id`
        ).all<{ target_brand_id: string; cnt: number }>(),
        env.DB.prepare(
          `SELECT target_brand_id, COUNT(*) as cnt FROM threats WHERE ${baseCond} AND dbl_listed = 1 GROUP BY target_brand_id`
        ).all<{ target_brand_id: string; cnt: number }>(),
        env.DB.prepare(
          `SELECT target_brand_id,
            SUM(CASE WHEN greynoise_noise = 1 AND greynoise_classification = 'benign' THEN 1 ELSE 0 END) as noise_scanners,
            SUM(CASE WHEN greynoise_noise = 0 THEN 1 ELSE 0 END) as potentially_targeted
          FROM threats WHERE ${baseCond} AND greynoise_checked = 1 GROUP BY target_brand_id`
        ).all<{ target_brand_id: string; noise_scanners: number; potentially_targeted: number }>(),
        env.DB.prepare(
          `SELECT target_brand_id, SUM(CASE WHEN seclookup_risk_score >= 80 THEN 1 ELSE 0 END) as high_risk
          FROM threats WHERE ${baseCond} AND seclookup_checked = 1 GROUP BY target_brand_id`
        ).all<{ target_brand_id: string; high_risk: number }>(),
      ]);
      return {
        surbl: surblRows.results,
        vt: vtRows.results,
        vtAvg: vtAvgRows.results,
        gsb: gsbRows.results,
        dbl: dblRows.results,
        greynoise: greynoiseRows.results,
        seclookup: seclookupRows.results,
      };
    });
    const surblRows = { results: enrichmentBatch.surbl };
    const vtRows = { results: enrichmentBatch.vt };
    const vtAvgRows = { results: enrichmentBatch.vtAvg };
    const gsbRows = { results: enrichmentBatch.gsb };
    const dblRows = { results: enrichmentBatch.dbl };
    const greynoiseRows = { results: enrichmentBatch.greynoise };
    const seclookupRows = { results: enrichmentBatch.seclookup };

    // Pivot subquery results into the original per-brand shape
    const enrichmentByBrand = new Map<string, {
      target_brand_id: string;
      surbl_confirmed: number;
      vt_flagged: number;
      vt_avg_malicious: number | null;
      gsb_confirmed: number;
      dbl_confirmed: number;
      noise_scanners: number;
      potentially_targeted: number;
      seclookup_high_risk: number;
    }>();

    const getOrInit = (bid: string) => {
      let entry = enrichmentByBrand.get(bid);
      if (!entry) {
        entry = {
          target_brand_id: bid,
          surbl_confirmed: 0, vt_flagged: 0, vt_avg_malicious: null,
          gsb_confirmed: 0, dbl_confirmed: 0, noise_scanners: 0,
          potentially_targeted: 0, seclookup_high_risk: 0,
        };
        enrichmentByBrand.set(bid, entry);
      }
      return entry;
    };

    for (const r of surblRows.results) getOrInit(r.target_brand_id).surbl_confirmed = r.cnt;
    for (const r of vtRows.results) getOrInit(r.target_brand_id).vt_flagged = r.cnt;
    for (const r of vtAvgRows.results) getOrInit(r.target_brand_id).vt_avg_malicious = r.avg_mal;
    for (const r of gsbRows.results) getOrInit(r.target_brand_id).gsb_confirmed = r.cnt;
    for (const r of dblRows.results) getOrInit(r.target_brand_id).dbl_confirmed = r.cnt;
    for (const r of greynoiseRows.results) {
      const e = getOrInit(r.target_brand_id);
      e.noise_scanners = r.noise_scanners;
      e.potentially_targeted = r.potentially_targeted;
    }
    for (const r of seclookupRows.results) getOrInit(r.target_brand_id).seclookup_high_risk = r.high_risk;

    // ─── Phase 3: Brand threat correlation escalation ──────────
    // After processing threats, run correlation for brands with new matches
    // (matchedBrandIds already populated by keyword pre-matches above)
    if (threats.results.length > 0) {
      const threatIds = threats.results.map(t => t.id);
      const brandRows = await env.DB.prepare(
        `SELECT DISTINCT target_brand_id FROM threats
         WHERE id IN (${threatIds.map(() => '?').join(',')})
           AND target_brand_id IS NOT NULL`
      ).bind(...threatIds).all<{ target_brand_id: string }>();
      for (const row of brandRows.results) {
        matchedBrandIds.add(row.target_brand_id);
      }
    }

    for (const bid of Array.from(matchedBrandIds).slice(0, 5)) {
      try {
        const assessment = await correlateBrandThreats(env, bid);
        if (!assessment) continue;

        // Escalation: PhishTank + no DMARC
        if (assessment.phishtank_active_urls > 0 && (!assessment.dmarc_policy || assessment.dmarc_policy === "none")) {
          outputs.push({
            type: "classification",
            summary: `**Active Phishing + No DMARC** — ${assessment.brand_name} has ${assessment.phishtank_active_urls} active phishing URLs with DMARC policy "${assessment.dmarc_policy ?? "missing"}". Immediate enforcement recommended.`,
            severity: "critical",
            details: {
              brand: assessment.brand_name,
              phishtank_urls: assessment.phishtank_active_urls,
              dmarc_policy: assessment.dmarc_policy,
              risk_score: assessment.composite_risk_score,
            },
            relatedBrandIds: [bid],
          });
        }

        // Escalation: AI-generated phishing detected
        if (assessment.ai_generated_phishing_detected) {
          outputs.push({
            type: "classification",
            summary: `**AI-Generated Threat Detected** — ${assessment.ai_phishing_count_30d} AI-generated phishing attempts targeting ${assessment.brand_name} in the last 30 days.`,
            severity: "high",
            details: {
              brand: assessment.brand_name,
              ai_phishing_count: assessment.ai_phishing_count_30d,
              risk_score: assessment.composite_risk_score,
            },
            relatedBrandIds: [bid],
          });
        }

        // Escalation: Risk score spike (check previous assessment)
        const prev = await env.DB.prepare(
          "SELECT composite_risk_score FROM brand_threat_assessments WHERE brand_id = ? ORDER BY assessed_at DESC LIMIT 1"
        ).bind(bid).first<{ composite_risk_score: number }>();
        if (prev && assessment.composite_risk_score - prev.composite_risk_score >= 20) {
          outputs.push({
            type: "classification",
            summary: `**Risk Score Spike** — ${assessment.brand_name} risk score jumped from ${prev.composite_risk_score} to ${assessment.composite_risk_score} (+${assessment.composite_risk_score - prev.composite_risk_score} points).`,
            severity: "high",
            details: {
              brand: assessment.brand_name,
              previous_score: prev.composite_risk_score,
              current_score: assessment.composite_risk_score,
              risk_factors: assessment.risk_factors,
            },
            relatedBrandIds: [bid],
          });
        }
      } catch (corrErr) {
        console.error(`[analyst] correlation check failed for brand ${bid}:`, corrErr);
      }
    }

    // ─── Phase 3.5: Enrichment validation summaries per brand ──────
    for (const bid of Array.from(matchedBrandIds).slice(0, 5)) {
      const enrichment = enrichmentByBrand.get(bid);
      if (enrichment && (enrichment.surbl_confirmed > 0 || enrichment.vt_flagged > 0 || enrichment.gsb_confirmed > 0 || enrichment.dbl_confirmed > 0 || enrichment.noise_scanners > 0 || enrichment.potentially_targeted > 0 || enrichment.seclookup_high_risk > 0)) {
        const brand = await getBrandById(env, bid);
        const brandName = brand?.name ?? bid;
        const parts: string[] = [];
        if (enrichment.surbl_confirmed > 0) parts.push(`${enrichment.surbl_confirmed} confirmed by SURBL`);
        if (enrichment.vt_flagged > 0) parts.push(`${enrichment.vt_flagged} flagged by VirusTotal (avg ${enrichment.vt_avg_malicious ?? 0} engines)`);
        if (enrichment.gsb_confirmed > 0) parts.push(`${enrichment.gsb_confirmed} confirmed by Google Safe Browsing`);
        if (enrichment.dbl_confirmed > 0) parts.push(`${enrichment.dbl_confirmed} confirmed by Spamhaus DBL`);
        if (enrichment.seclookup_high_risk > 0) parts.push(`${enrichment.seclookup_high_risk} rated high-risk by SecLookup`);

        // GreyNoise context — separates background noise from targeted attacks
        let greynoiseContext = '';
        if (enrichment.noise_scanners > 0 || enrichment.potentially_targeted > 0) {
          greynoiseContext = ` GreyNoise context: ${enrichment.noise_scanners} threats from known internet scanners (background noise), ${enrichment.potentially_targeted} threats NOT seen mass-scanning (potential targeted attacks).`;
        }
        if (enrichment.seclookup_high_risk > 0) {
          greynoiseContext += ` SecLookup: ${enrichment.seclookup_high_risk} threats rated high-risk.`;
        }

        outputs.push({
          type: 'classification',
          summary: `**External Validation** — ${brandName}: ${parts.join('. ')}.${greynoiseContext}`,
          severity: enrichment.vt_flagged > 5 || enrichment.surbl_confirmed > 10 || enrichment.gsb_confirmed > 5 || enrichment.dbl_confirmed > 5 || enrichment.seclookup_high_risk > 5 ? 'high' : 'medium',
          details: {
            brand_id: bid,
            surbl_confirmed: enrichment.surbl_confirmed,
            vt_flagged: enrichment.vt_flagged,
            vt_avg_malicious: enrichment.vt_avg_malicious,
            gsb_confirmed: enrichment.gsb_confirmed,
            dbl_confirmed: enrichment.dbl_confirmed,
            noise_scanners: enrichment.noise_scanners,
            potentially_targeted: enrichment.potentially_targeted,
            seclookup_high_risk: enrichment.seclookup_high_risk,
          },
          relatedBrandIds: [bid],
        });
      }
    }

    // ─── Phase 4: Social intelligence correlation & exposure scoring ──
    for (const bid of Array.from(matchedBrandIds).slice(0, 5)) {
      try {
        const socialIntel = await getBrandSocialIntel(env, bid);

        if (socialIntel.totalProfiles > 0) {
          const socialContext = `Social Media Intelligence:
- Total profiles tracked: ${socialIntel.totalProfiles} across ${socialIntel.platformsCovered.join(', ')}
- Official verified: ${socialIntel.officialProfiles}
- Suspicious/Impersonation: ${socialIntel.suspiciousProfiles + socialIntel.impersonationProfiles}
- Platforms with impersonation: ${socialIntel.platformsWithImpersonation.join(', ') || 'None'}
- Social Risk Score: ${socialIntel.socialRiskScore ?? 'Not computed'}
- AI recommends takedown for ${socialIntel.aiTakedownRecommendations} profiles
- New impersonations (24h): ${socialIntel.newImpersonationsLast24h}`;

          // Check for coordinated attack: phishing + social impersonation
          const brandThreats = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id = ? AND status = 'active' AND threat_type = 'phishing'"
          ).bind(bid).first<{ n: number }>();

          if ((brandThreats?.n || 0) > 0 && socialIntel.impersonationProfiles > 0) {
            outputs.push({
              type: "classification",
              summary: `**Coordinated Attack Signal** — Brand has ${brandThreats?.n} active phishing campaigns AND ${socialIntel.impersonationProfiles} social impersonation accounts. This suggests a coordinated attack.`,
              severity: "critical",
              details: {
                brand_id: bid,
                phishing_count: brandThreats?.n,
                impersonation_count: socialIntel.impersonationProfiles,
                platforms_affected: socialIntel.platformsWithImpersonation,
                social_risk_score: socialIntel.socialRiskScore,
                social_context: socialContext,
              },
              relatedBrandIds: [bid],
            });
          }

          // Check for high-vulnerability: weak email + social impersonation
          const emailSec2 = await env.DB.prepare(
            "SELECT email_security_grade FROM brands WHERE id = ?"
          ).bind(bid).first<{ email_security_grade: string | null }>();

          if (emailSec2?.email_security_grade && ['F', 'D'].includes(emailSec2.email_security_grade) && socialIntel.impersonationProfiles > 0) {
            outputs.push({
              type: "classification",
              summary: `**High Vulnerability** — Brand has email security grade ${emailSec2.email_security_grade} AND ${socialIntel.impersonationProfiles} active impersonation accounts. Extremely vulnerable to brand abuse.`,
              severity: "high",
              details: {
                brand_id: bid,
                email_grade: emailSec2.email_security_grade,
                impersonation_count: socialIntel.impersonationProfiles,
                social_risk_assessment: {
                  score: socialIntel.socialRiskScore,
                  highest_severity: socialIntel.highestSeverity,
                  takedown_needed: socialIntel.aiTakedownRecommendations,
                },
              },
              relatedBrandIds: [bid],
            });
          }
        }

        // Compute composite exposure score
        await computeBrandExposureScore(env, bid);
      } catch (socialErr) {
        console.error(`[analyst] social intel check failed for brand ${bid}:`, socialErr);
      }
    }

    // ─── Phase 4.5: Social mentions intelligence (Reddit, Telegram, GitHub, Mastodon) ──
    for (const bid of Array.from(matchedBrandIds).slice(0, 5)) {
      try {
        const mentionStats = await env.DB.prepare(`
          SELECT
            COUNT(*) as total_mentions,
            SUM(CASE WHEN severity IN ('critical', 'high') THEN 1 ELSE 0 END) as high_severity,
            SUM(CASE WHEN threat_type = 'credential_leak' THEN 1 ELSE 0 END) as credential_leaks,
            SUM(CASE WHEN threat_type = 'phishing_link' THEN 1 ELSE 0 END) as phishing_links,
            SUM(CASE WHEN threat_type = 'code_leak' THEN 1 ELSE 0 END) as code_leaks,
            SUM(CASE WHEN threat_type = 'impersonation' THEN 1 ELSE 0 END) as impersonations,
            SUM(CASE WHEN threat_type = 'threat_actor_chatter' THEN 1 ELSE 0 END) as threat_chatter,
            GROUP_CONCAT(DISTINCT platform) as platforms_seen
          FROM social_mentions
          WHERE brand_id = ? AND status != 'false_positive'
          AND created_at >= datetime('now', '-30 days')
        `).bind(bid).first<{
          total_mentions: number;
          high_severity: number;
          credential_leaks: number;
          phishing_links: number;
          code_leaks: number;
          impersonations: number;
          threat_chatter: number;
          platforms_seen: string | null;
        }>();

        if (mentionStats && mentionStats.total_mentions > 0) {
          const brand = await getBrandById(env, bid);
          const brandName = brand?.name ?? bid;
          const platforms = mentionStats.platforms_seen ?? 'unknown';

          // Escalate if credential leaks + active phishing detected
          if (mentionStats.credential_leaks > 0 && mentionStats.phishing_links > 0) {
            outputs.push({
              type: 'classification',
              summary: `**Social Threat Convergence** — ${brandName} has ${mentionStats.credential_leaks} credential leaks AND ${mentionStats.phishing_links} phishing links shared on social platforms (${platforms}). Active exploitation likely.`,
              severity: 'critical',
              details: {
                brand_id: bid,
                total_mentions: mentionStats.total_mentions,
                credential_leaks: mentionStats.credential_leaks,
                phishing_links: mentionStats.phishing_links,
                code_leaks: mentionStats.code_leaks,
                impersonations: mentionStats.impersonations,
                threat_chatter: mentionStats.threat_chatter,
                platforms: platforms,
              },
              relatedBrandIds: [bid],
            });
          } else if (mentionStats.high_severity > 3) {
            outputs.push({
              type: 'classification',
              summary: `**Elevated Social Chatter** — ${brandName}: ${mentionStats.total_mentions} social mentions across ${platforms} (${mentionStats.high_severity} high-severity). ${mentionStats.credential_leaks} credential leaks, ${mentionStats.code_leaks} code leaks.`,
              severity: 'high',
              details: {
                brand_id: bid,
                total_mentions: mentionStats.total_mentions,
                high_severity: mentionStats.high_severity,
                platforms: platforms,
              },
              relatedBrandIds: [bid],
            });
          }
        }
      } catch (mentionErr) {
        console.error(`[analyst] social mentions check failed for brand ${bid}:`, mentionErr);
      }
    }

    // ─── Phase 4.6: Dark-web + app-store cross-correlation ───────
    // SQL-only correlation (no Haiku): ties confirmed paste mentions +
    // app-store impersonations back to active phishing / social signals
    // on the same brand. Surfaces exploit-in-progress and campaign
    // convergence patterns. Wrapped in try/catch so missing tables in
    // a given deployment gracefully skip the phase.
    for (const bid of Array.from(matchedBrandIds).slice(0, 5)) {
      try {
        const dwStats = await env.DB.prepare(`
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN classification = 'confirmed' AND status = 'active' THEN 1 ELSE 0 END) AS confirmed,
            SUM(CASE WHEN classification = 'suspicious' AND status = 'active' THEN 1 ELSE 0 END) AS suspicious,
            SUM(CASE WHEN severity IN ('CRITICAL','HIGH') AND status = 'active' THEN 1 ELSE 0 END) AS high_severity,
            SUM(CASE WHEN match_type = 'executive' AND status = 'active' THEN 1 ELSE 0 END) AS executive_matches,
            SUM(CASE WHEN match_type = 'domain' AND status = 'active' THEN 1 ELSE 0 END) AS domain_matches,
            SUM(CASE WHEN classification_reason LIKE '%credential_dump%' AND status = 'active' THEN 1 ELSE 0 END) AS credential_dumps,
            COUNT(DISTINCT source) AS sources
          FROM dark_web_mentions
          WHERE brand_id = ?
            AND first_seen >= datetime('now', '-7 days')
        `).bind(bid).first<{
          total: number; confirmed: number; suspicious: number;
          high_severity: number; executive_matches: number;
          domain_matches: number; credential_dumps: number; sources: number;
        }>().catch(() => null);

        if (dwStats && dwStats.confirmed > 0) {
          const brand = await getBrandById(env, bid);
          const brandName = brand?.name ?? bid;

          // Signal 1: credential exposure + active phishing = exploit in progress
          const activePhishing = await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM threats WHERE target_brand_id = ? AND status = 'active' AND threat_type = 'phishing'"
          ).bind(bid).first<{ n: number }>();

          if (dwStats.credential_dumps > 0 && (activePhishing?.n || 0) > 0) {
            outputs.push({
              type: "classification",
              summary: `**Credential Exposure + Active Phishing** — ${brandName} has ${dwStats.credential_dumps} paste(s) with credential-dump signatures AND ${activePhishing?.n} active phishing campaigns. Treat as exploit-in-progress.`,
              severity: "critical",
              details: {
                brand_id: bid,
                dark_web_credential_dumps: dwStats.credential_dumps,
                dark_web_confirmed_total: dwStats.confirmed,
                dark_web_sources: dwStats.sources,
                active_phishing_threats: activePhishing?.n,
              },
              relatedBrandIds: [bid],
            });
          }

          // Signal 2: executive exposure — unique risk, raise even without phishing
          if (dwStats.executive_matches > 0) {
            outputs.push({
              type: "classification",
              summary: `**Executive Exposure** — ${brandName}: ${dwStats.executive_matches} confirmed dark-web mention(s) naming an executive${dwStats.credential_dumps > 0 ? ` alongside ${dwStats.credential_dumps} credential-dump paste(s)` : ''}. Targeted-attack precursor.`,
              severity: dwStats.credential_dumps > 0 ? "critical" : "high",
              details: {
                brand_id: bid,
                executive_matches: dwStats.executive_matches,
                credential_dumps: dwStats.credential_dumps,
                sources: dwStats.sources,
              },
              relatedBrandIds: [bid],
            });
          }

          // Signal 3: bulk credential exposure without observed exploitation yet
          // — lead indicator for expected phishing campaigns in the next 7–14d.
          if (dwStats.confirmed >= 3 && (activePhishing?.n || 0) === 0 && dwStats.executive_matches === 0) {
            outputs.push({
              type: "classification",
              summary: `**Pre-Exploitation Exposure** — ${brandName} has ${dwStats.confirmed} confirmed dark-web mention(s) across ${dwStats.sources} source(s) with no active phishing yet. Expect incoming phishing; pre-position defenses.`,
              severity: "high",
              details: {
                brand_id: bid,
                dark_web_confirmed: dwStats.confirmed,
                dark_web_credential_dumps: dwStats.credential_dumps,
                dark_web_domain_matches: dwStats.domain_matches,
                dark_web_sources: dwStats.sources,
              },
              relatedBrandIds: [bid],
            });
          }
        }

        // Signal 4: app-store impersonation + active phishing / social = multichannel
        const appStoreStats = await env.DB.prepare(`
          SELECT
            SUM(CASE WHEN classification = 'impersonation' AND status = 'active' THEN 1 ELSE 0 END) AS impersonations,
            SUM(CASE WHEN severity IN ('CRITICAL','HIGH') AND status = 'active' AND classification = 'impersonation' THEN 1 ELSE 0 END) AS high_severity
          FROM app_store_listings
          WHERE brand_id = ?
            AND first_seen >= datetime('now', '-30 days')
        `).bind(bid).first<{ impersonations: number; high_severity: number }>().catch(() => null);

        if (appStoreStats && appStoreStats.impersonations > 0) {
          const brand = await getBrandById(env, bid);
          const brandName = brand?.name ?? bid;

          const otherChannels = await env.DB.prepare(`
            SELECT
              (SELECT COUNT(*) FROM threats WHERE target_brand_id = ? AND status = 'active' AND threat_type = 'phishing') AS phishing,
              (SELECT COUNT(*) FROM social_profiles WHERE brand_id = ? AND status = 'active' AND classification = 'impersonation') AS social_imp
          `).bind(bid, bid).first<{ phishing: number; social_imp: number }>();

          const channelCount = (appStoreStats.impersonations > 0 ? 1 : 0)
            + ((otherChannels?.phishing || 0) > 0 ? 1 : 0)
            + ((otherChannels?.social_imp || 0) > 0 ? 1 : 0);

          if (channelCount >= 2) {
            outputs.push({
              type: "classification",
              summary: `**Multi-Channel Brand Attack** — ${brandName} targeted across ${channelCount} channels: ${appStoreStats.impersonations} app-store impersonation(s)${(otherChannels?.phishing || 0) > 0 ? `, ${otherChannels?.phishing} phishing threat(s)` : ''}${(otherChannels?.social_imp || 0) > 0 ? `, ${otherChannels?.social_imp} social impersonation(s)` : ''}. Coordinated campaign likely.`,
              severity: appStoreStats.high_severity > 0 ? "critical" : "high",
              details: {
                brand_id: bid,
                app_store_impersonations: appStoreStats.impersonations,
                app_store_high_severity: appStoreStats.high_severity,
                active_phishing: otherChannels?.phishing,
                social_impersonations: otherChannels?.social_imp,
                channel_count: channelCount,
              },
              relatedBrandIds: [bid],
            });
          }
        }
      } catch (correlationErr) {
        console.error(`[analyst] dark-web/app-store correlation failed for brand ${bid}:`, correlationErr);
      }
    }

    // ─── Phase 5: Subdomain brand spoofing detection ─────────────
    // Checks BOTH subdomain and full domain for brand name impersonation.
    // Runs against all unclassified threats (no time window) to catch backlog.
    let subdomainSpoofCount = 0;
    try {
      // Get monitored brand names and domains for matching
      const monitoredBrands = await env.DB.prepare(`
        SELECT b.id, LOWER(b.name) as name, LOWER(b.canonical_domain) as domain
        FROM brands b
        JOIN monitored_brands mb ON mb.brand_id = b.id
        WHERE mb.status = 'active' AND b.canonical_domain IS NOT NULL
      `).all<{ id: string; name: string; domain: string }>();

      // Find threats not yet checked for subdomain spoofing — no time window
      // to ensure backfill of older threats. Batch in 500 at a time.
      const uncheckedThreats = await env.DB.prepare(`
        SELECT id, malicious_domain, country_code
        FROM threats
        WHERE malicious_domain IS NOT NULL
          AND threat_type != 'subdomain_brand_spoofing'
          AND (threat_type IS NULL OR threat_type NOT IN ('subdomain_brand_spoofing'))
          AND malicious_domain LIKE '%.%.%'
        ORDER BY created_at DESC
        LIMIT 500
      `).all<{ id: string; malicious_domain: string; country_code: string | null }>();

      for (const threat of uncheckedThreats.results) {
        const domain = threat.malicious_domain.toLowerCase();
        const apex = getApexDomain(domain);
        const subdomain = getSubdomain(domain);

        // Flatten the full domain for matching (catches brand in apex too)
        const domainFlat = domain.replace(/[^a-z0-9]/g, '');

        for (const brand of monitoredBrands.results) {
          const brandApex = getApexDomain(brand.domain);
          // Skip if the registrable domain IS the brand's own domain
          if (apex === brandApex) continue;

          const brandKeyword = brand.name.replace(/[^a-z0-9]/g, '');
          if (brandKeyword.length < 3) continue;

          // Check brand name in subdomain OR in full domain (catches email-microsoft.com etc)
          const subdomainFlat = subdomain ? subdomain.replace(/[^a-z0-9]/g, '') : '';
          const brandInSubdomain = subdomainFlat.length > 0 && subdomainFlat.includes(brandKeyword);
          const brandInDomain = domainFlat.includes(brandKeyword);

          if (brandInSubdomain || brandInDomain) {
            // This is subdomain/domain brand spoofing
            subdomainSpoofCount++;

            // Check if threat is from adversary country for campaign tagging
            let campaignLink: string | null = null;
            if (threat.country_code) {
              const geoCampaign = await env.DB.prepare(`
                SELECT gc.id, gcl.campaign_id FROM geopolitical_campaigns gc
                JOIN geopolitical_campaign_links gcl ON gcl.geopolitical_campaign_id = gc.id
                WHERE gc.status = 'active' AND gc.adversary_countries LIKE '%' || ? || '%'
                LIMIT 1
              `).bind(threat.country_code).first<{ id: string; campaign_id: string }>();
              if (geoCampaign) campaignLink = geoCampaign.campaign_id;
            }

            await env.DB.prepare(`
              UPDATE threats SET
                threat_type = 'subdomain_brand_spoofing',
                severity = CASE WHEN severity IN ('low', 'medium') THEN 'high' ELSE severity END,
                target_brand_id = COALESCE(target_brand_id, ?),
                campaign_id = COALESCE(campaign_id, ?)
              WHERE id = ?
            `).bind(brand.id, campaignLink, threat.id).run();

            outputs.push({
              type: 'classification',
              summary: `**Subdomain Brand Spoofing** — ${brand.name} impersonated in ${brandInSubdomain ? 'subdomain' : 'domain'} of ${apex}: ${domain}`,
              severity: 'high',
              details: {
                brand: brand.name,
                malicious_domain: domain,
                apex_domain: apex,
                subdomain: subdomain || null,
                match_location: brandInSubdomain ? 'subdomain' : 'domain',
                country_code: threat.country_code,
                campaign_linked: !!campaignLink,
              },
              relatedBrandIds: [brand.id],
            });

            break; // One brand match per threat is sufficient
          }
        }
      }

      if (subdomainSpoofCount > 0) {
        outputs.push({
          type: 'diagnostic',
          summary: `Subdomain spoofing scan: ${subdomainSpoofCount} brand spoofing attempts detected in ${uncheckedThreats.results.length} threats checked`,
          severity: subdomainSpoofCount > 5 ? 'high' : 'medium',
          details: { subdomain_spoof_count: subdomainSpoofCount, threats_checked: uncheckedThreats.results.length },
        });
      }
    } catch (spoofErr) {
      console.error("[analyst] subdomain spoofing detection error:", spoofErr);
    }

    // ─── Phase 6: Numbered domain variant scanning ─────────────
    let numberedVariantsFound = 0;
    try {
      // Find recent malicious domains containing numbers
      const numberedThreats = await env.DB.prepare(`
        SELECT id, malicious_domain, threat_type, campaign_id, target_brand_id, severity
        FROM threats
        WHERE malicious_domain IS NOT NULL
          AND malicious_domain GLOB '*[0-9]*'
          AND severity IN ('high', 'critical')
          AND created_at >= datetime('now', '-24 hours')
        ORDER BY created_at DESC
        LIMIT 20
      `).all<{
        id: string; malicious_domain: string; threat_type: string;
        campaign_id: string | null; target_brand_id: string | null; severity: string;
      }>();

      for (const threat of numberedThreats.results) {
        const pattern = extractNumberedPattern(threat.malicious_domain);
        if (!pattern) continue;

        // Generate ±10 variants
        const variants: string[] = [];
        for (let delta = -10; delta <= 10; delta++) {
          if (delta === 0) continue; // skip the original
          const variantNum = pattern.num + delta;
          if (variantNum < 0) continue;
          const variantDomain = `${pattern.prefix}${variantNum}${pattern.suffix}`;
          // Skip if we already have this domain
          variants.push(variantDomain);
        }

        if (variants.length === 0) continue;

        // Check which variants resolve via DNS
        const resolvedVariants: string[] = [];
        for (const variant of variants) {
          try {
            const dnsRes = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(variant)}&type=A`, {
              headers: { 'Accept': 'application/dns-json' },
              signal: AbortSignal.timeout(3000),
            });
            if (dnsRes.ok) {
              const dnsData = await dnsRes.json() as { Answer?: Array<{ type: number; data: string }> };
              if (dnsData.Answer && dnsData.Answer.length > 0) {
                resolvedVariants.push(variant);
              }
            }
          } catch {
            // DNS lookup failed, skip this variant
          }
        }

        // Create threats for resolved variants (that don't already exist)
        for (const resolvedDomain of resolvedVariants) {
          const existing = await env.DB.prepare(
            "SELECT id FROM threats WHERE malicious_domain = ? LIMIT 1"
          ).bind(resolvedDomain).first<{ id: string }>();

          if (!existing) {
            const newId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO threats (id, malicious_domain, threat_type, severity, source_feed, campaign_id, target_brand_id, first_seen, status, created_at)
              VALUES (?, ?, ?, ?, 'numbered_variant_scan', ?, ?, datetime('now'), 'active', datetime('now'))
            `).bind(
              newId, resolvedDomain, threat.threat_type, threat.severity,
              threat.campaign_id, threat.target_brand_id,
            ).run();
            numberedVariantsFound++;
          }
        }

        if (resolvedVariants.length > 0) {
          outputs.push({
            type: 'classification',
            summary: `**Numbered Domain Variants** — ${resolvedVariants.length} active variants found from pattern ${threat.malicious_domain}: ${resolvedVariants.slice(0, 5).join(', ')}${resolvedVariants.length > 5 ? '...' : ''}`,
            severity: 'high',
            details: {
              source_domain: threat.malicious_domain,
              pattern: `${pattern.prefix}[N]${pattern.suffix}`,
              variants_checked: variants.length,
              variants_resolved: resolvedVariants.length,
              resolved_domains: resolvedVariants,
            },
          });
        }
      }

      if (numberedVariantsFound > 0) {
        outputs.push({
          type: 'diagnostic',
          summary: `Numbered domain scan: ${numberedVariantsFound} new variant threats created from ${numberedThreats.results.length} source domains`,
          severity: 'high',
          details: { new_variants: numberedVariantsFound, source_domains_checked: numberedThreats.results.length },
        });
      }
    } catch (numErr) {
      console.error("[analyst] numbered domain variant scanning error:", numErr);
    }

    // Always generate an output so agent_outputs gets populated
    outputs.push({
      type: "classification",
      summary: itemsProcessed > 0
        ? `Analyst matched ${itemsUpdated} threats to brands (${itemsProcessed} processed, haiku=${haikuSuccesses}/${haikuFailures}, low_conf=${lowConfidence}, keywordPreMatched=${keywordPreMatched})`
        : `Analyst found 0 unmatched threats to process`,
      severity: "info",
      details: {
        processed: itemsProcessed,
        matched: itemsUpdated,
        haikuSuccesses,
        haikuFailures,
        lowConfidence,
        keywordPreMatched,
        knownBrands: brandNames.length,
        anthropicKeySource: keySource,
        anthropicApiConfigured: !!apiKey,
        model,
        enhanced_fields: ['attack_vector', 'target_audience', 'sophistication'],
        subdomain_spoofing_detected: subdomainSpoofCount,
        numbered_variants_created: numberedVariantsFound,
      },
    });

    return {
      itemsProcessed,
      itemsCreated: numberedVariantsFound,
      itemsUpdated,
      output: { brandMatches: itemsUpdated, keywordPreMatched },
      model,
      tokensUsed: totalTokens,
      agentOutputs: outputs,
    };
  },
};
