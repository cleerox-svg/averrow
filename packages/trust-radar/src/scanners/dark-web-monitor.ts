/**
 * Dark-Web Mention Monitoring
 *
 * Scans paste archives (PSBDMP first; Telegram / HIBP / Flare / DarkOwl
 * land in subsequent slices via the `source` column on dark_web_mentions)
 * for mentions of a brand, its domain, executives, or known threat-actor
 * aliases. Pure classification logic + a per-brand scanner that upserts
 * findings and raises alerts on HIGH/CRITICAL rows. The Haiku review
 * pass and cron batch runner land in later slices.
 */

import { searchPastes, fetchPasteContent, type PasteMention } from "../feeds/psbdmp";
import { createAlert } from "../lib/alerts";
import { deliverWebhook } from "../lib/webhooks";
import { logger } from "../lib/logger";
import { checkCostGuard } from "../lib/haiku";
import { callAnthropicText, AnthropicError } from "../lib/anthropic";
import { HOT_PATH_HAIKU } from "../lib/ai-models";
import { computeBrandExposureScore } from "../lib/brand-scoring";
import { runDarkWebRansomwareIngest } from "../lib/dark-web-ransomware-ingest";
import type { Env } from "../types";

// ─── Types ──────────────────────────────────────────────────────

export type MentionClassification =
  | "confirmed"        // strong signal — credential dump, leak keyword + brand domain, etc.
  | "suspicious"       // moderate signal — defer to AI
  | "false_positive"
  | "resolved"
  | "unknown";

export type MentionMatchType = "brand_name" | "domain" | "executive" | "actor_alias" | "mixed";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface DarkWebBrandContext {
  name: string;
  domain: string | null;
  aliases: string[];
  executives: string[];
  /** Known threat-actor aliases — enrich severity when they co-occur with brand terms. */
  actor_aliases: string[];
}

export interface MentionClassificationResult {
  classification: MentionClassification;
  confidence: number;
  score: number;                 // 0 – 1
  severity: Severity;
  match_type: MentionMatchType;
  matched_terms: string[];
  signals: string[];
  reason: string;
  needs_ai_review: boolean;
}

const SOURCE_PASTEBIN = "pastebin";
const CONTENT_SNIPPET_MAX = 500;
const PER_TERM_SEARCH_LIMIT = 10;
const MAX_UNIQUE_PASTES_PER_BRAND = 30;
const MAX_ALIASES_SCANNED = 2;
const MAX_EXECUTIVES_SCANNED = 3;

// ─── Classification helpers ─────────────────────────────────────

function hasCredentialDumpPattern(content: string): boolean {
  // "email:password" or "email|password" on three or more lines is
  // the classic combolist / stealer log signature.
  let hits = 0;
  const lines = content.split(/\r?\n/);
  const pattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[:|][^\s]+/;
  for (const line of lines) {
    if (pattern.test(line)) {
      hits++;
      if (hits >= 3) return true;
    }
  }
  return false;
}

function hasLeakVocabulary(content: string): boolean {
  return /\b(leak|leaked|dump|dumped|breach|breached|combo(?:list)?|database|db\s?dump|cracked|hacked|hack\sforum|exploit|0day|stealer|log(?:s)?)\b/i
    .test(content);
}

function collectMatchedTerms(
  brand: DarkWebBrandContext,
  haystack: string,
): { terms: string[]; matched: { name: boolean; domain: boolean; executive: boolean } } {
  const terms: string[] = [];
  const matched = { name: false, domain: false, executive: false };

  const lower = haystack.toLowerCase();

  const nameTokens = [brand.name, ...brand.aliases]
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3);

  for (const t of nameTokens) {
    // Require word-boundary match so "acme" doesn't match "acmelabs".
    const re = new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(haystack)) {
      terms.push(t);
      matched.name = true;
    }
  }

  if (brand.domain) {
    const domainLower = brand.domain.toLowerCase();
    if (lower.includes(domainLower)) {
      terms.push(brand.domain);
      matched.domain = true;
    }
  }

  for (const exec of brand.executives) {
    const execTrim = exec.trim();
    if (execTrim.length < 4) continue;
    const re = new RegExp(`\\b${execTrim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(haystack)) {
      terms.push(execTrim);
      matched.executive = true;
    }
  }

  return { terms, matched };
}

function pickMatchType(
  matched: { name: boolean; domain: boolean; executive: boolean },
): MentionMatchType {
  const count = Number(matched.name) + Number(matched.domain) + Number(matched.executive);
  if (count > 1) return "mixed";
  if (matched.executive) return "executive";
  if (matched.domain) return "domain";
  return "brand_name";
}

function severityForScore(score: number): Severity {
  if (score >= 0.85) return "CRITICAL";
  if (score >= 0.55) return "HIGH";
  if (score >= 0.3) return "MEDIUM";
  return "LOW";
}

// ─── Classifier (pure) ──────────────────────────────────────────

/**
 * Classify a paste hit against a brand. Pure: no I/O.
 * `content` is the best-effort body of the paste (may be empty if
 * upstream fetch failed); `fallbackSnippet` can stand in for content
 * if the body is unavailable (e.g. just the paste title/ID).
 */
export function classifyPasteMention(
  brand: DarkWebBrandContext,
  paste: PasteMention,
  content: string,
): MentionClassificationResult | null {
  const haystack = content || paste.url;
  const { terms: matchedTerms, matched } = collectMatchedTerms(brand, haystack);

  if (matchedTerms.length === 0) {
    return null; // no real brand signal — skip
  }

  const signals: string[] = [];
  let score = 0;

  if (matched.name) {
    signals.push("brand_name_match");
    score += 0.25;
  }
  if (matched.domain) {
    signals.push("brand_domain_match");
    score += 0.4;

    if (brand.domain) {
      const emailRe = new RegExp(
        `[a-zA-Z0-9._%+-]+@${brand.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "i",
      );
      if (emailRe.test(haystack)) {
        signals.push("brand_email_in_paste");
        score += 0.25;
      }
    }
  }
  if (matched.executive) {
    signals.push("executive_mentioned");
    score += 0.3;
  }

  if (hasCredentialDumpPattern(haystack)) {
    signals.push("credential_dump_pattern");
    score += 0.3;
  }
  if (hasLeakVocabulary(haystack)) {
    signals.push("leak_vocabulary");
    score += 0.15;
  }

  // Actor cross-reference: adds a signal + boosts severity when any
  // known actor alias co-occurs with a brand term.
  const actorHits: string[] = [];
  for (const alias of brand.actor_aliases) {
    if (alias.length < 3) continue;
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(haystack)) {
      actorHits.push(alias);
      score += 0.2;
    }
  }
  if (actorHits.length > 0) {
    signals.push(`actor_alias:${actorHits.slice(0, 3).join(",")}`);
  }

  score = Math.min(1, score);

  const severity = severityForScore(score);
  const matchType: MentionMatchType = actorHits.length > 0 && matched.name
    ? "mixed"
    : pickMatchType(matched);

  // Confirmed when signals are strong enough that AI shouldn't be
  // needed to decide. Below that threshold, flag for the Haiku pass
  // so it can demote or promote based on context.
  const confirmed = score >= 0.55;
  const classification: MentionClassification = confirmed ? "confirmed" : "suspicious";
  const confidence = confirmed ? 0.9 : 0.5;

  const reason = confirmed
    ? `Strong dark-web signal: ${signals.join(", ")}`
    : `Possible dark-web mention — needs context review`;

  return {
    classification,
    confidence,
    score,
    severity,
    match_type: matchType,
    matched_terms: matchedTerms,
    signals,
    reason,
    needs_ai_review: !confirmed,
  };
}

// ─── Per-brand scanner ──────────────────────────────────────────

export interface BrandRow {
  id: string;
  name: string;
  domain: string | null;
  aliases: string | null;            // JSON array
  executive_names: string | null;    // JSON array
}

export interface DarkWebScanResult {
  mention_id: string;
  source: string;
  source_url: string;
  match_type: MentionMatchType;
  matched_terms: string[];
  severity: Severity;
  classification: MentionClassification;
  score: number;
  alert_id: string | null;
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function loadActorAliases(env: Env): Promise<string[]> {
  // threat_actors.aliases is a JSON array per row. Tolerate missing
  // table / column so this scanner runs even in fresh environments.
  try {
    const rows = await env.DB.prepare(
      "SELECT aliases FROM threat_actors WHERE aliases IS NOT NULL",
    ).all<{ aliases: string }>();
    const out = new Set<string>();
    for (const row of rows.results) {
      for (const alias of parseJsonArray<string>(row.aliases)) {
        const trimmed = alias.trim();
        if (trimmed.length >= 3) out.add(trimmed);
      }
    }
    return Array.from(out);
  } catch {
    return [];
  }
}

async function sha256(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildWatchTerms(ctx: DarkWebBrandContext): string[] {
  const terms = new Set<string>();
  terms.add(ctx.name);
  for (const a of ctx.aliases.slice(0, MAX_ALIASES_SCANNED)) terms.add(a);
  if (ctx.domain) terms.add(ctx.domain);
  for (const exec of ctx.executives.slice(0, MAX_EXECUTIVES_SCANNED)) terms.add(exec);
  return Array.from(terms).filter((t) => t.trim().length >= 3);
}

function extractSnippet(content: string, term: string): string {
  const full = content.trim();
  if (full.length <= CONTENT_SNIPPET_MAX) return full;
  // Try to center the snippet around the first matched term.
  const idx = full.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return full.slice(0, CONTENT_SNIPPET_MAX);
  const start = Math.max(0, idx - 120);
  return full.slice(start, start + CONTENT_SNIPPET_MAX);
}

/**
 * Run the dark-web monitor for a single brand.
 * Queries PSBDMP for each watch term, fetches each unique paste body,
 * classifies against the brand, and upserts into dark_web_mentions.
 * Creates alerts on HIGH/CRITICAL confirmed findings.
 */
export async function runDarkWebMonitorForBrand(
  env: Env,
  brand: BrandRow,
  opts: { userId?: string | null; triggeredBy?: string } = {},
): Promise<DarkWebScanResult[]> {
  const ctx: DarkWebBrandContext = {
    name: brand.name,
    domain: brand.domain,
    aliases: parseJsonArray<string>(brand.aliases),
    executives: parseJsonArray<string>(brand.executive_names),
    actor_aliases: await loadActorAliases(env),
  };

  const results: DarkWebScanResult[] = [];
  const seenPasteIds = new Set<string>();
  const watchTerms = buildWatchTerms(ctx);

  // 1. Fan out: one search per watch term. Dedup paste IDs as we go.
  const pastes: PasteMention[] = [];
  for (const term of watchTerms) {
    const hits = await searchPastes(term, { limit: PER_TERM_SEARCH_LIMIT });
    for (const hit of hits) {
      if (seenPasteIds.has(hit.paste_id)) continue;
      seenPasteIds.add(hit.paste_id);
      pastes.push(hit);
      if (pastes.length >= MAX_UNIQUE_PASTES_PER_BRAND) break;
    }
    if (pastes.length >= MAX_UNIQUE_PASTES_PER_BRAND) break;
  }

  if (pastes.length === 0) {
    logger.info("dark_web_monitor_brand_complete", {
      brand_id: brand.id,
      pastes_returned: 0,
      rows_written: 0,
      triggered_by: opts.triggeredBy ?? "unknown",
    });
    return results;
  }

  // 2. Resolve alert recipient + org once.
  let alertUserId = opts.userId ?? null;
  if (!alertUserId) {
    const monitoredBy = await env.DB.prepare(
      "SELECT added_by FROM monitored_brands WHERE brand_id = ? LIMIT 1",
    ).bind(brand.id).first<{ added_by: string }>();
    alertUserId = monitoredBy?.added_by ?? null;
  }
  const orgRow = await env.DB.prepare(
    "SELECT org_id FROM org_brands WHERE brand_id = ? LIMIT 1",
  ).bind(brand.id).first<{ org_id: number }>();

  // 3. Fetch body + classify + upsert, one paste at a time.
  for (const paste of pastes) {
    let content = "";
    try {
      content = await fetchPasteContent(paste.paste_id);
    } catch (err) {
      logger.warn("dark_web_monitor_paste_fetch_error", {
        brand_id: brand.id,
        paste_id: paste.paste_id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const verdict = classifyPasteMention(ctx, paste, content);
    if (!verdict) continue;

    const mentionId = crypto.randomUUID();
    const snippet = extractSnippet(content, verdict.matched_terms[0] ?? brand.name);
    const fullHash = await sha256(content);

    await env.DB.prepare(`
      INSERT INTO dark_web_mentions (
        id, brand_id, source, source_url, source_channel,
        posted_at, content_snippet, content_full_hash,
        matched_terms, match_type,
        classification, classified_by, classification_confidence, classification_reason,
        severity, status,
        first_seen, last_seen, last_checked
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, 'system', ?, ?,
        ?, 'active',
        datetime('now'), datetime('now'), datetime('now')
      )
      ON CONFLICT (brand_id, source, source_url) DO UPDATE SET
        content_snippet    = excluded.content_snippet,
        content_full_hash  = excluded.content_full_hash,
        matched_terms      = excluded.matched_terms,
        match_type         = excluded.match_type,
        classification     = CASE
          WHEN dark_web_mentions.classified_by = 'manual' THEN dark_web_mentions.classification
          ELSE excluded.classification
        END,
        classified_by      = CASE
          WHEN dark_web_mentions.classified_by = 'manual' THEN dark_web_mentions.classified_by
          ELSE 'system'
        END,
        classification_confidence = CASE
          WHEN dark_web_mentions.classified_by = 'manual' THEN dark_web_mentions.classification_confidence
          ELSE excluded.classification_confidence
        END,
        classification_reason = CASE
          WHEN dark_web_mentions.classified_by = 'manual' THEN dark_web_mentions.classification_reason
          ELSE excluded.classification_reason
        END,
        severity           = excluded.severity,
        last_seen          = datetime('now'),
        last_checked       = datetime('now'),
        updated_at         = datetime('now')
    `).bind(
      mentionId, brand.id, SOURCE_PASTEBIN, paste.url, paste.paste_id,
      paste.posted_at, snippet, fullHash,
      JSON.stringify(verdict.matched_terms), verdict.match_type,
      verdict.classification, verdict.confidence, verdict.reason,
      verdict.severity,
    ).run();

    // Alert on HIGH/CRITICAL confirmed findings.
    let alertId: string | null = null;
    if (
      (verdict.severity === "HIGH" || verdict.severity === "CRITICAL") &&
      verdict.classification === "confirmed" &&
      alertUserId
    ) {
      try {
        alertId = await createAlert(env.DB, {
          brandId: brand.id,
          userId: alertUserId,
          alertType: "dark_web_mention",
          severity: verdict.severity,
          title: `${verdict.severity === "CRITICAL" ? "Critical" : "High-risk"} dark-web mention on ${SOURCE_PASTEBIN}`,
          summary: `A ${SOURCE_PASTEBIN} paste appears to reference ${brand.name}. Signals: ${verdict.signals.join(", ")}.`,
          details: {
            source: SOURCE_PASTEBIN,
            paste_id: paste.paste_id,
            paste_url: paste.url,
            posted_at: paste.posted_at,
            match_type: verdict.match_type,
            matched_terms: verdict.matched_terms,
            signals: verdict.signals,
            score: verdict.score,
            reason: verdict.reason,
          },
          sourceType: "dark_web_monitor",
          sourceId: mentionId,
        });

        if (orgRow?.org_id) {
          deliverWebhook(env, orgRow.org_id, "alert.created", {
            alert_id: alertId,
            brand_name: brand.name,
            brand_domain: brand.domain,
            severity: verdict.severity,
            title: `Dark-web mention: ${brand.name} on ${SOURCE_PASTEBIN}`,
            alert_type: "dark_web_mention",
            source: SOURCE_PASTEBIN,
            source_url: paste.url,
            score: verdict.score,
          }).catch(() => {});
        }
      } catch (alertErr) {
        logger.error("dark_web_monitor_alert_error", {
          brand_id: brand.id,
          paste_id: paste.paste_id,
          error: alertErr instanceof Error ? alertErr.message : String(alertErr),
        });
      }
    }

    results.push({
      mention_id: mentionId,
      source: SOURCE_PASTEBIN,
      source_url: paste.url,
      match_type: verdict.match_type,
      matched_terms: verdict.matched_terms,
      severity: verdict.severity,
      classification: verdict.classification,
      score: verdict.score,
      alert_id: alertId,
    });
  }

  // Recompute brand exposure score so the Dark Web tab's new data reflects
  // in the brand's headline risk score. Pure SQL, no Haiku. Wrapped so a
  // scoring bug can't fail the scan.
  try {
    await computeBrandExposureScore(env, brand.id);
  } catch (scoreErr) {
    logger.warn("dark_web_monitor_score_error", {
      brand_id: brand.id,
      error: scoreErr instanceof Error ? scoreErr.message : String(scoreErr),
    });
  }

  logger.info("dark_web_monitor_brand_complete", {
    brand_id: brand.id,
    brand_name: brand.name,
    pastes_returned: pastes.length,
    rows_written: results.length,
    triggered_by: opts.triggeredBy ?? "unknown",
  });

  return results;
}

// ─── AI Fallback (Haiku) ────────────────────────────────────────

type AiVerdict = "confirmed" | "suspicious" | "false_positive";
type AiAction = "safe" | "review" | "escalate" | "takedown";

interface AiAssessmentOutput {
  verdict: AiVerdict;
  confidence: number;
  action: AiAction;
  reasoning: string;
}

interface MentionAssessmentRow {
  id: string;
  brand_id: string;
  source: string;
  source_url: string;
  content_snippet: string | null;
  matched_terms: string | null;
  match_type: string | null;
  impersonation_signals?: string | null; // unused here; kept for symmetry
}

const SEVERITY_FOR_AI_VERDICT: Record<AiVerdict, Severity> = {
  confirmed: "HIGH",
  suspicious: "MEDIUM",
  false_positive: "LOW",
};

function buildAssessmentPrompt(
  brand: DarkWebBrandContext,
  mention: MentionAssessmentRow,
): string {
  const snippet = (mention.content_snippet ?? "").slice(0, 800);
  const matched = mention.matched_terms ?? "[]";

  return `You are a dark-web analyst for the Averrow threat intelligence platform.

Decide whether this paste genuinely references the BRAND below, or whether the brand keyword appears coincidentally (common word, unrelated topic, different company with a similar name).

BRAND:
  name: ${brand.name}
  domain: ${brand.domain ?? "?"}
  aliases: ${JSON.stringify(brand.aliases)}
  known executives: ${JSON.stringify(brand.executives.slice(0, 10))}

PASTE:
  source: ${mention.source}
  source_url: ${mention.source_url}
  match_type: ${mention.match_type ?? "?"}
  matched_terms: ${matched}
  snippet (truncated): ${snippet || "[no content available]"}

Consider: credential dumps and combolists that include the brand's domain or employee emails are ALWAYS confirmed. A paste that just contains the brand name in passing (joke, unrelated sentence, different company) is a false_positive. When unsure, return "suspicious".

Return ONLY a JSON object with this exact shape (no prose, no markdown):
{"verdict":"confirmed|suspicious|false_positive","confidence":0.0,"action":"safe|review|escalate|takedown","reasoning":"one short sentence"}`;
}

function parseAiResponse(raw: string): AiAssessmentOutput | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<AiAssessmentOutput>;
    const verdict = parsed.verdict;
    const action = parsed.action;
    if (!verdict || !["confirmed", "suspicious", "false_positive"].includes(verdict)) return null;
    if (!action || !["safe", "review", "escalate", "takedown"].includes(action)) return null;
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;
    return {
      verdict,
      action,
      confidence,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 500) : "",
    };
  } catch {
    return null;
  }
}

/**
 * Send one suspicious mention to Haiku for a verdict and persist the
 * result. Preserves manual classifications. Caller should have already
 * verified the row is in 'suspicious' state.
 */
export async function assessSuspiciousMentionAI(
  env: Env,
  brand: DarkWebBrandContext,
  mention: MentionAssessmentRow,
  runId: string | null = null,
): Promise<{ updated: boolean; verdict: AiVerdict | null; error?: string }> {
  const prompt = buildAssessmentPrompt(brand, mention);

  let rawText = "";
  try {
    const { text } = await callAnthropicText(env, {
      agentId: "dark_web_monitor",
      runId,
      model: HOT_PATH_HAIKU,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 300,
    });
    rawText = text;
  } catch (err) {
    const msg = err instanceof AnthropicError ? err.message
      : err instanceof Error ? err.message : String(err);
    logger.warn("dark_web_ai_assess_call_failed", {
      brand_id: mention.brand_id,
      mention_id: mention.id,
      error: msg,
    });
    return { updated: false, verdict: null, error: msg };
  }

  const verdict = parseAiResponse(rawText);
  if (!verdict) {
    logger.warn("dark_web_ai_assess_parse_failed", {
      brand_id: mention.brand_id,
      mention_id: mention.id,
      raw_snippet: rawText.slice(0, 200),
    });
    return { updated: false, verdict: null, error: "parse_failed" };
  }

  const newSeverity = SEVERITY_FOR_AI_VERDICT[verdict.verdict];
  const newStatus = verdict.verdict === "false_positive" ? "false_positive" : "active";

  await env.DB.prepare(`
    UPDATE dark_web_mentions SET
      ai_assessment           = ?,
      ai_confidence           = ?,
      ai_action               = ?,
      ai_assessed_at          = datetime('now'),
      classification          = CASE WHEN classified_by = 'manual' THEN classification ELSE ? END,
      classified_by           = CASE WHEN classified_by = 'manual' THEN classified_by ELSE 'ai' END,
      classification_confidence = CASE WHEN classified_by = 'manual' THEN classification_confidence ELSE ? END,
      classification_reason   = CASE WHEN classified_by = 'manual' THEN classification_reason ELSE ? END,
      severity                = CASE WHEN classified_by = 'manual' THEN severity ELSE ? END,
      status                  = CASE WHEN classified_by = 'manual' THEN status ELSE ? END,
      updated_at              = datetime('now')
    WHERE id = ?
  `).bind(
    verdict.reasoning,
    verdict.confidence,
    verdict.action,
    verdict.verdict,
    verdict.confidence,
    verdict.reasoning,
    newSeverity,
    newStatus,
    mention.id,
  ).run();

  return { updated: true, verdict: verdict.verdict };
}

/**
 * Process a batch of 'suspicious' mentions that have not yet been
 * AI-assessed (or were last assessed >7 days ago). Respects the global
 * cost guard. Caller may scope to a single brand.
 */
export async function runDarkWebAIAssessmentBatch(
  env: Env,
  opts: { brandId?: string; limit?: number; runId?: string | null } = {},
): Promise<{ processed: number; upgraded: number; errors: number }> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? 15));

  const blocked = await checkCostGuard(env, false);
  if (blocked) {
    logger.info("dark_web_ai_assess_cost_guard", { reason: blocked });
    return { processed: 0, upgraded: 0, errors: 0 };
  }

  const where = opts.brandId
    ? "WHERE dwm.classification = 'suspicious' AND dwm.status = 'active' AND dwm.brand_id = ? AND (dwm.ai_assessed_at IS NULL OR dwm.ai_assessed_at < datetime('now','-7 days'))"
    : "WHERE dwm.classification = 'suspicious' AND dwm.status = 'active' AND (dwm.ai_assessed_at IS NULL OR dwm.ai_assessed_at < datetime('now','-7 days'))";
  const bindings: unknown[] = opts.brandId ? [opts.brandId, limit] : [limit];

  const rows = await env.DB.prepare(`
    SELECT dwm.id, dwm.brand_id, dwm.source, dwm.source_url,
           dwm.content_snippet, dwm.matched_terms, dwm.match_type,
           b.name AS brand_name, b.canonical_domain AS domain,
           b.aliases, b.executive_names
    FROM dark_web_mentions dwm
    JOIN brands b ON b.id = dwm.brand_id
    ${where}
    ORDER BY dwm.updated_at DESC
    LIMIT ?
  `).bind(...bindings).all<MentionAssessmentRow & {
    brand_name: string;
    domain: string | null;
    aliases: string | null;
    executive_names: string | null;
  }>();

  // Actor aliases are global — load once for the batch.
  const actorAliases = await loadActorAliases(env);

  let processed = 0;
  let upgraded = 0;
  let errors = 0;

  for (const row of rows.results) {
    const brandCtx: DarkWebBrandContext = {
      name: row.brand_name,
      domain: row.domain,
      aliases: parseJsonArray<string>(row.aliases),
      executives: parseJsonArray<string>(row.executive_names),
      actor_aliases: actorAliases,
    };

    const result = await assessSuspiciousMentionAI(env, brandCtx, row, opts.runId ?? null);
    processed++;
    if (result.updated) {
      if (result.verdict && result.verdict !== "suspicious") upgraded++;
    } else {
      errors++;
    }
  }

  logger.info("dark_web_ai_assess_batch_complete", {
    brand_id: opts.brandId ?? "all",
    processed,
    upgraded,
    errors,
  });

  return { processed, upgraded, errors };
}

// ─── Batch Runner (Cron) ────────────────────────────────────────

const BATCH_LIMIT = 15;
const DEFAULT_CHECK_INTERVAL_HOURS = 24;
const MONITOR_TYPE = "darkweb";
const SCHEDULE_PLATFORM = "pastebin";

/**
 * Ensure a brand_monitor_schedule row exists for (brand, 'darkweb', 'pastebin').
 * Idempotent — relies on the unique index on (brand_id, monitor_type, platform).
 */
async function ensureDarkWebSchedule(env: Env, brandId: string): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO brand_monitor_schedule
      (id, brand_id, monitor_type, platform, check_interval_hours, enabled, next_check)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT (brand_id, monitor_type, platform) DO NOTHING
  `).bind(
    crypto.randomUUID(),
    brandId,
    MONITOR_TYPE,
    SCHEDULE_PLATFORM,
    DEFAULT_CHECK_INTERVAL_HOURS,
  ).run();
}

/**
 * Run the dark-web monitor for every monitored brand due for a check.
 * Called from the cron orchestrator on the `hour % 6 === 0` tick, after
 * the app-store monitor.
 */
export async function runDarkWebMonitorBatch(env: Env): Promise<{
  brands_processed: number;
  rows_upserted: number;
  alerts_created: number;
  ai_processed: number;
  ai_upgraded: number;
  ransomware_inserted: number;
  ransomware_alerts: number;
}> {
  const now = new Date().toISOString();

  // ── 0. Global-pull ransomware DLS ingest ──
  // Pulls ransomwatch + ransomware.live victim feeds, brand-matches
  // in SQL, inserts directly into dark_web_mentions with
  // source='ransomware_leak'. One pull per cron tick (every 6h),
  // not per-brand. Deterministic classification — no AI tokens.
  // Failures here never block the per-brand PSBDMP scan below.
  let ransomwareInserted = 0;
  let ransomwareAlerts = 0;
  try {
    const ransomware = await runDarkWebRansomwareIngest(env);
    ransomwareInserted = ransomware.inserted;
    ransomwareAlerts = ransomware.alerts_created;
    if (ransomware.skipped) {
      logger.warn("dark_web_ransomware_skipped", { reason: ransomware.reason });
    } else {
      logger.info("dark_web_ransomware_summary", {
        victims_total: ransomware.victims_total,
        brand_matches: ransomware.brand_matches,
        inserted: ransomware.inserted,
        alerts: ransomware.alerts_created,
      });
    }
  } catch (err) {
    logger.error("dark_web_ransomware_ingest_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Seed schedule rows for every monitored brand that lacks one.
  const needsSeed = await env.DB.prepare(`
    SELECT DISTINCT mb.brand_id
    FROM monitored_brands mb
    LEFT JOIN brand_monitor_schedule bms
      ON bms.brand_id = mb.brand_id
     AND bms.monitor_type = ?
     AND bms.platform = ?
    WHERE bms.id IS NULL
    LIMIT 200
  `).bind(MONITOR_TYPE, SCHEDULE_PLATFORM).all<{ brand_id: string }>();
  for (const row of needsSeed.results) {
    await ensureDarkWebSchedule(env, row.brand_id);
  }

  // Select due brands for this tick.
  const dueBrands = await env.DB.prepare(`
    SELECT DISTINCT b.id, b.name, b.canonical_domain AS domain,
           b.aliases, b.executive_names
    FROM brands b
    INNER JOIN monitored_brands mb ON mb.brand_id = b.id
    INNER JOIN brand_monitor_schedule bms ON bms.brand_id = b.id
    WHERE bms.monitor_type = ?
      AND bms.platform = ?
      AND bms.enabled = 1
      AND (bms.next_check IS NULL OR bms.next_check <= ?)
    ORDER BY bms.next_check ASC
    LIMIT ?
  `).bind(MONITOR_TYPE, SCHEDULE_PLATFORM, now, BATCH_LIMIT).all<BrandRow>();

  if (dueBrands.results.length === 0) {
    logger.info("dark_web_monitor_batch", { message: "No brands due", checked_at: now });
    return {
      brands_processed: 0, rows_upserted: 0, alerts_created: 0,
      ai_processed: 0, ai_upgraded: 0,
      ransomware_inserted: ransomwareInserted,
      ransomware_alerts: ransomwareAlerts,
    };
  }

  logger.info("dark_web_monitor_batch_start", { brands_count: dueBrands.results.length });

  let brandsProcessed = 0;
  let rowsUpserted = 0;
  let alertsCreated = 0;

  for (const brand of dueBrands.results) {
    try {
      const results = await runDarkWebMonitorForBrand(env, brand, { triggeredBy: "cron" });
      rowsUpserted += results.length;
      alertsCreated += results.filter((r) => r.alert_id !== null).length;

      // brand_monitor_schedule has no updated_at column (migration 0036).
      // Referencing it throws "no such column" and silently freezes next_check
      // (every schedule advance fails) — keep this UPDATE to existing columns only.
      await env.DB.prepare(`
        UPDATE brand_monitor_schedule
        SET last_checked = ?,
            next_check = datetime(?, '+' || check_interval_hours || ' hours')
        WHERE brand_id = ? AND monitor_type = ? AND platform = ? AND enabled = 1
      `).bind(now, now, brand.id, MONITOR_TYPE, SCHEDULE_PLATFORM).run();

      brandsProcessed++;
    } catch (err) {
      logger.error("dark_web_monitor_batch_brand_error", {
        brand_id: brand.id,
        brand_name: brand.name,
        error: err instanceof Error ? err.message : String(err),
      });
      // Advance the schedule even on error so one broken brand can't block the queue.
      await env.DB.prepare(`
        UPDATE brand_monitor_schedule
        SET last_checked = ?,
            next_check = datetime(?, '+' || check_interval_hours || ' hours')
        WHERE brand_id = ? AND monitor_type = ? AND platform = ? AND enabled = 1
      `).bind(now, now, brand.id, MONITOR_TYPE, SCHEDULE_PLATFORM).run().catch(() => {});
    }
  }

  // Drain AI queue after the deterministic scan — gated by cost guard.
  const ai = await runDarkWebAIAssessmentBatch(env, { limit: 15 });

  logger.info("dark_web_monitor_batch_complete", {
    brands_processed: brandsProcessed,
    rows_upserted: rowsUpserted,
    alerts_created: alertsCreated,
    ai_processed: ai.processed,
    ai_upgraded: ai.upgraded,
    ransomware_inserted: ransomwareInserted,
    ransomware_alerts: ransomwareAlerts,
  });

  return {
    brands_processed: brandsProcessed,
    rows_upserted: rowsUpserted,
    alerts_created: alertsCreated,
    ai_processed: ai.processed,
    ai_upgraded: ai.upgraded,
    ransomware_inserted: ransomwareInserted,
    ransomware_alerts: ransomwareAlerts,
  };
}
