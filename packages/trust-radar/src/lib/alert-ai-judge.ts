// Averrow — Alert AI judge (Tier 3)
//
// Per-alert Haiku call that gives a second opinion on the residual
// queue after the rule-based triage in `lib/alert-triage.ts` has
// already cleared the obvious cases. Designed for the alerts that
// landed in the 0.7-0.9 impersonation-score band — too high for
// the rule-based dismiss threshold to handle but often dormant /
// abandoned / legitimate-but-not-allowlisted in reality.
//
// Cost shape: 1 Haiku call per alert (~$0.001/alert). At 1,200
// alerts in the residual queue that's ~$1.20 for a one-shot
// backfill, then ongoing hits as new alerts land that survive
// rule-based triage.
//
// Conservative-by-design output handling:
//   - The judge always stamps `ai_assessment` with the verdict +
//     reasoning so operators see the AI's opinion when they open
//     the alert. Reversible; no data loss.
//   - Auto-dismiss only fires on `verdict === 'likely_safe'` AND
//     `confidence >= 90`. Anything below that is left in 'new'
//     for human review with the AI note attached.
//   - The judge never dismisses 'active_threat' or 'needs_human'
//     verdicts. We only use AI to remove load from the operator,
//     not to escalate.
//
// Per CLAUDE.md AI rules:
//   - Haiku for classification (this fits)
//   - All AI calls go through the AI Gateway via callAnthropicJSON
//   - Throttle gating (BudgetManager) is automatic via the haiku
//     helper

import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';
import { callAnthropicJSON, AnthropicError } from './anthropic';
import { HOT_PATH_HAIKU } from './ai-models';
import { loadBrandAllowlists } from './alert-triage';

// ─── Public types ────────────────────────────────────────────────

export type AlertVerdict = 'active_threat' | 'likely_safe' | 'needs_human';

export interface JudgeResult {
  verdict: AlertVerdict;
  confidence: number;     // 0-100
  reasoning: string;      // one short sentence
}

export interface AlertJudgeContext {
  alert_type: string;
  brand_name: string | null;
  brand_domain: string | null;
  details: Record<string, unknown> | null;
}

const SYSTEM_PROMPT = `You are a security analyst triaging brand-protection alerts.
For each alert, return JSON with these keys:
- verdict: "active_threat" | "likely_safe" | "needs_human"
- confidence: 0-100 integer (how confident you are in the verdict)
- reasoning: one short sentence (max 200 chars)

Rules:
- "active_threat" — strong evidence of active phishing/scam against
  the brand. Specific phishing language, credential harvesting,
  active engagement, recent posts, lookalike-domain hosting.
- "likely_safe" — appears dormant, abandoned, fan account, sub-brand,
  legitimate brand sub-product that wasn't allowlisted, parked
  domain, or so generic that brand impersonation is unlikely.
- "needs_human" — ambiguous. Default to this when in doubt.

Be conservative on "likely_safe" — false-safe is worse than
false-needs-human. Operators can clear a "needs_human" verdict
faster than recovering from a missed phish. Only return
"likely_safe" with confidence >= 90 when you are genuinely sure.`;

/**
 * Build the user-message prompt fragment from an alert's structured
 * context. Pure function — no I/O. Exposed for unit testing the
 * shape of what gets sent to the model.
 */
export function buildJudgePrompt(ctx: AlertJudgeContext): string {
  const lines: string[] = [];
  lines.push(`Alert type: ${ctx.alert_type}`);
  if (ctx.brand_name) lines.push(`Brand: ${ctx.brand_name}${ctx.brand_domain ? ` (${ctx.brand_domain})` : ''}`);

  const d = ctx.details ?? {};

  if (ctx.alert_type === 'social_impersonation') {
    if (d.platform) lines.push(`Platform: ${d.platform}`);
    if (d.handle) lines.push(`Handle: @${d.handle}`);
    if (d.url) lines.push(`URL: ${d.url}`);
    if (typeof d.score === 'number') lines.push(`Impersonation score: ${(d.score as number).toFixed(2)} (0-1, higher = stronger signal)`);
    if (Array.isArray(d.signals) && d.signals.length > 0) {
      lines.push(`Signals: ${(d.signals as unknown[]).join(', ')}`);
    }
  } else if (ctx.alert_type === 'app_store_impersonation') {
    if (d.store) lines.push(`Store: ${d.store}`);
    if (d.app_name) lines.push(`App name: ${d.app_name}`);
    if (d.developer_name) lines.push(`Developer: ${d.developer_name}`);
    if (d.bundle_id) lines.push(`Bundle ID: ${d.bundle_id}`);
    if (typeof d.impersonation_score === 'number') {
      lines.push(`Impersonation score: ${(d.impersonation_score as number).toFixed(2)} (0-1, higher = stronger signal)`);
    }
    if (Array.isArray(d.signals) && d.signals.length > 0) {
      lines.push(`Signals: ${(d.signals as unknown[]).join(', ')}`);
    }
    if (d.reason) lines.push(`Classifier reason: ${d.reason}`);
  } else {
    // Generic: dump key/value pairs the model can reason from.
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        lines.push(`${k}: ${v}`);
      }
    }
  }

  lines.push('');
  lines.push('Return JSON.');
  return lines.join('\n');
}

/**
 * Validate + normalize the raw model output into a JudgeResult. Any
 * shape error returns null so the caller can stamp a "ai_judge_failed"
 * note instead of crashing.
 */
export function parseJudgeResult(raw: unknown): JudgeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const verdict = obj.verdict;
  const confidence = obj.confidence;
  const reasoning = obj.reasoning;

  if (verdict !== 'active_threat' && verdict !== 'likely_safe' && verdict !== 'needs_human') return null;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 100) return null;
  if (typeof reasoning !== 'string' || reasoning.length === 0) return null;

  return {
    verdict,
    confidence: Math.round(confidence),
    reasoning: reasoning.slice(0, 240).trim(),
  };
}

/**
 * Call Haiku for one alert and return a structured verdict. Returns
 * null on transport failure or unparseable output — caller decides
 * how to handle (typically: leave alert in 'new' status, log error).
 */
export async function judgeAlertWithAI(
  env: Env,
  ctx: AlertJudgeContext,
): Promise<JudgeResult | null> {
  try {
    const { parsed } = await callAnthropicJSON<unknown>(env, {
      agentId: 'alert_ai_judge',
      runId: null,
      model: HOT_PATH_HAIKU,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildJudgePrompt(ctx) }],
      maxTokens: 256,
    });
    return parseJudgeResult(parsed);
  } catch (err) {
    if (err instanceof AnthropicError) {
      console.error('[alert_ai_judge] anthropic error:', err.message);
    } else {
      console.error('[alert_ai_judge] unexpected error:', err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

// ─── Auto-dismiss threshold ──────────────────────────────────────

/** Confidence floor (0-100) at which a `likely_safe` verdict triggers
 *  auto-dismiss. Anything below this stamps the verdict on the alert
 *  but leaves it in 'new' for human review. */
export const AUTO_DISMISS_CONFIDENCE_FLOOR = 90;

// ─── Backfill ────────────────────────────────────────────────────

export interface JudgeBackfillResult {
  scanned: number;
  judged: number;
  dismissed: number;
  kept: number;
  failed: number;
  by_verdict: Record<AlertVerdict | 'parse_error', number>;
}

interface AlertRow {
  id: string;
  brand_id: string;
  alert_type: string;
  details: string | null;
  ai_assessment: string | null;
}

interface BrandRow {
  id: string;
  name: string | null;
  canonical_domain: string | null;
}

/**
 * Backfill pass that runs the Haiku judge against `new` alerts that
 * haven't been judged yet. Skips alerts with an existing
 * `ai_assessment` so the run is idempotent on re-call.
 *
 * - `limit` bounds the batch (default 50, max 200) to keep AI cost
 *   per call predictable. At ~$0.001/call this is ~$0.05-$0.20
 *   per batch.
 * - Operator runs repeatedly until `scanned < limit`.
 * - Auto-dismiss only when verdict='likely_safe' AND
 *   confidence >= AUTO_DISMISS_CONFIDENCE_FLOOR. All other verdicts
 *   stamp ai_assessment + leave alert in 'new'.
 */
export async function runAlertJudgeBackfill(
  env: Env,
  opts?: { limit?: number; offset?: number },
): Promise<JudgeBackfillResult> {
  const limit = Math.min(200, opts?.limit ?? 50);
  const offset = Math.max(0, opts?.offset ?? 0);

  const rows = await env.DB.prepare(`
    SELECT id, brand_id, alert_type, details, ai_assessment
    FROM alerts
    WHERE status = 'new'
      AND ai_assessment IS NULL
    ORDER BY created_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all<AlertRow>();

  // Bulk-load brand metadata for the batch in one query.
  const brandIds = Array.from(new Set(rows.results.map((r) => r.brand_id)));
  const brandMap = await loadBrandsForJudge(env.DB, brandIds);

  const result: JudgeBackfillResult = {
    scanned: rows.results.length,
    judged: 0,
    dismissed: 0,
    kept: 0,
    failed: 0,
    by_verdict: {
      active_threat: 0,
      likely_safe: 0,
      needs_human: 0,
      parse_error: 0,
    },
  };

  for (const alert of rows.results) {
    const brand = brandMap.get(alert.brand_id);
    let details: Record<string, unknown> | null = null;
    if (alert.details) {
      try {
        details = JSON.parse(alert.details) as Record<string, unknown>;
      } catch {
        details = null;
      }
    }

    const verdict = await judgeAlertWithAI(env, {
      alert_type: alert.alert_type,
      brand_name: brand?.name ?? null,
      brand_domain: brand?.canonical_domain ?? null,
      details,
    });

    if (!verdict) {
      result.failed += 1;
      result.by_verdict.parse_error += 1;
      continue;
    }

    result.judged += 1;
    result.by_verdict[verdict.verdict] += 1;

    const aiAssessment = `[AI ${verdict.verdict} @${verdict.confidence}%] ${verdict.reasoning}`;

    if (
      verdict.verdict === 'likely_safe' &&
      verdict.confidence >= AUTO_DISMISS_CONFIDENCE_FLOOR
    ) {
      // Auto-dismiss with a stamped reason capturing the AI verdict.
      await env.DB.prepare(`
        UPDATE alerts
        SET status = 'false_positive',
            resolved_at = datetime('now'),
            resolution_notes = ?,
            ai_assessment = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'new'
      `).bind(
        `auto: AI judged likely_safe @${verdict.confidence}% — ${verdict.reasoning.slice(0, 180)}`,
        aiAssessment,
        alert.id,
      ).run();
      result.dismissed += 1;
    } else {
      // Stamp the verdict on the alert without changing status.
      await env.DB.prepare(`
        UPDATE alerts
        SET ai_assessment = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND status = 'new'
      `).bind(aiAssessment, alert.id).run();
      result.kept += 1;
    }
  }

  return result;
}

async function loadBrandsForJudge(
  db: D1Database,
  brandIds: string[],
): Promise<Map<string, BrandRow>> {
  const result = new Map<string, BrandRow>();
  if (brandIds.length === 0) return result;
  const ph = brandIds.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT id, name, canonical_domain
    FROM brands
    WHERE id IN (${ph})
  `).bind(...brandIds).all<BrandRow>();
  for (const r of rows.results) result.set(r.id, r);
  return result;
}
