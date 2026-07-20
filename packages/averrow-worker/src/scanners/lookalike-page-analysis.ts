/**
 * Lookalike page-content analysis pass (S2.4 / D6 increment 1).
 *
 * Throttled companion to checkLookalikeBatch. Fetches the LIVE HTML of
 * registered + resolving + has_web lookalike domains for org-monitored
 * brands via the SSRF-safe fetcher (lib/page-fetch.ts), scores it with
 * the deterministic scorer (lib/page-phishing-scorer.ts), persists the
 * verdict, and MONOTONICALLY escalates threat_level (+ the linked
 * alert's severity) when the page is phishing. ZERO AI.
 *
 * Runs inside the existing `22 * * * *` lookalike_scanner cron tick (no
 * new cron — the cron-audit rule is not triggered). Throttle: LIMIT 20
 * per run, 24h per-domain cadence, concurrency 4, and a per-run
 * wall-clock budget guard so a batch of slow hosts can't approach the
 * 15-min reap window (the greynoise/seclookup starvation lesson).
 */

import { fetchSuspectPage, DEFAULT_DEADLINE_MS, type SuspectPageResult } from '../lib/page-fetch';
import {
  scorePagePhishing,
  escalateThreatLevelForPage,
  type PagePhishingResult,
  type PageThreatLevel,
} from '../lib/page-phishing-scorer';
import { logger } from '../lib/logger';
import type { Env } from '../types';

const PAGE_ANALYSIS_LIMIT = 20;
const CONCURRENCY = 4;
/** Whole-run wall-clock budget. Well under the 15-min reap window. */
const RUN_BUDGET_MS = 120_000;

const LEVEL_ORDER: Record<PageThreatLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

interface PageAnalysisRow {
  id: string;
  brand_id: string;
  domain: string;
  threat_level: string | null;
  alert_id: string | null;
  brand_name: string | null;
  brand_domain: string | null;
}

export interface PageAnalysisSummary {
  analyzed: number;
  fetched_ok: number;
  escalated: number;
  credential_harvest: number;
  budget_hit: boolean;
}

function normalizeLevel(raw: string | null): PageThreatLevel {
  const v = (raw ?? 'LOW').toUpperCase();
  return v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL' ? (v as PageThreatLevel) : 'LOW';
}

/**
 * Fetch + score a single suspect domain and persist the 5 page columns.
 * ALWAYS stamps page_fetched_at (even on SSRF/network rejection) so a
 * domain that keeps failing isn't re-selected every tick. Writes go
 * through env.DB directly (never a read replica). Returns the phishing
 * result when the page was fetched + scored, else null.
 */
export async function runPageAnalysisForDomain(
  env: Env,
  row: Pick<PageAnalysisRow, 'id' | 'domain' | 'brand_name' | 'brand_domain'>,
  deadlineAt: number,
): Promise<{ result: SuspectPageResult; phishing: PagePhishingResult | null }> {
  const result = await fetchSuspectPage(row.domain, { deadlineAt });

  let phishing: PagePhishingResult | null = null;
  if (result.ok && result.signals) {
    phishing = scorePagePhishing(result.signals, {
      suspectDomain: row.domain,
      brandDomain: row.brand_domain,
      brandName: row.brand_name,
    });
  }

  await env.DB.prepare(
    `UPDATE lookalike_domains
     SET page_fetched_at = datetime('now'),
         page_http_status = ?,
         page_phishing_score = ?,
         page_signals = ?,
         page_content_hash = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(
    result.httpStatus ?? null,
    phishing ? phishing.score : null,
    phishing ? JSON.stringify(phishing.signals) : null,
    result.contentHash ?? null,
    row.id,
  ).run();

  return { result, phishing };
}

/**
 * Apply the monotonic page escalation to a lookalike row's threat_level
 * and, when the level rises and a live alert is linked, bump the alert's
 * severity. Never downgrades. Returns true if anything escalated.
 */
async function applyEscalation(
  env: Env,
  row: PageAnalysisRow,
  phishing: PagePhishingResult,
): Promise<boolean> {
  const current = normalizeLevel(row.threat_level);
  const next = escalateThreatLevelForPage(current, phishing);
  if (LEVEL_ORDER[next] <= LEVEL_ORDER[current]) return false;

  await env.DB.prepare(
    `UPDATE lookalike_domains
     SET threat_level = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(next, row.id).run();

  if (row.alert_id) {
    // Raise the operator-facing alert severity too, but only for still-
    // open alerts (never resurrect a resolved/dismissed one). Severity
    // is stored lowercase (migration 0121 CHECK).
    await env.DB.prepare(
      `UPDATE alerts
       SET severity = ?, updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('new','acknowledged','investigating')`,
    ).bind(next.toLowerCase(), row.alert_id).run();
  }
  return true;
}

/**
 * Throttled page-analysis pass. Selects up to PAGE_ANALYSIS_LIMIT
 * registered + resolving + has_web lookalike domains for org-monitored
 * brands whose page hasn't been analyzed in 24h, fetches + scores each,
 * persists the verdict, and escalates. Concurrency-bounded with a
 * wall-clock budget guard.
 */
export async function analyzeLookalikePages(env: Env): Promise<PageAnalysisSummary> {
  const runStart = Date.now();
  const summary: PageAnalysisSummary = {
    analyzed: 0,
    fetched_ok: 0,
    escalated: 0,
    credential_harvest: 0,
    budget_hit: false,
  };

  // Population: exactly the org-monitored, registered, resolving,
  // has_web set — the domains checkLookalikeBatch already alerts on.
  // EXISTS (not JOIN) so a brand monitored by multiple orgs doesn't
  // fan the row out. Reads are fine off env.DB here (agent context);
  // the volume is bounded to 20 rows/run.
  const rows = await env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.threat_level, ld.alert_id,
            b.name AS brand_name, b.canonical_domain AS brand_domain
     FROM lookalike_domains ld
     JOIN brands b ON b.id = ld.brand_id
     WHERE ld.registered = 1
       AND ld.has_web = 1
       AND ld.resolves_to IS NOT NULL
       AND (ld.page_fetched_at IS NULL OR ld.page_fetched_at < datetime('now', '-24 hours'))
       AND EXISTS (SELECT 1 FROM org_brands ob WHERE ob.brand_id = ld.brand_id)
     ORDER BY ld.page_fetched_at ASC NULLS FIRST
     LIMIT ?`,
  ).bind(PAGE_ANALYSIS_LIMIT).all<PageAnalysisRow>();

  if (rows.results.length === 0) {
    return summary;
  }

  for (let i = 0; i < rows.results.length; i += CONCURRENCY) {
    // Wall-clock budget guard — stop launching new fetches if we're
    // running long. Leaves remaining rows for the next tick (their
    // page_fetched_at stays stale, so they're re-selected).
    if (Date.now() - runStart > RUN_BUDGET_MS) {
      summary.budget_hit = true;
      break;
    }

    const batch = rows.results.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        summary.analyzed += 1;
        try {
          const deadlineAt = Math.min(Date.now() + DEFAULT_DEADLINE_MS, runStart + RUN_BUDGET_MS);
          const { result, phishing } = await runPageAnalysisForDomain(env, row, deadlineAt);
          if (result.ok) summary.fetched_ok += 1;
          if (phishing) {
            if (phishing.credentialHarvest) summary.credential_harvest += 1;
            const escalated = await applyEscalation(env, row, phishing);
            if (escalated) summary.escalated += 1;
          }
        } catch (err) {
          logger.error('lookalike_page_analysis_error', {
            domain: row.domain,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  logger.info('lookalike_page_analysis', { ...summary });
  return summary;
}
