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
 * new cron — the cron-audit rule is not triggered). Throttle: 20 rows
 * per run SPLIT between the never-analyzed and already-scored cohorts
 * (see FIRST_ANALYSIS_SLOTS), 24h per-domain cadence, concurrency 4, and
 * a per-run wall-clock budget guard so a batch of slow hosts can't
 * approach the 15-min reap window (the greynoise/seclookup starvation
 * lesson).
 */

import {
  fetchSuspectPage,
  normalizePageOutcome,
  DEFAULT_DEADLINE_MS,
  type SuspectPageResult,
} from '../lib/page-fetch';
import {
  scorePagePhishing,
  escalateThreatLevelForPage,
  type PagePhishingResult,
  type PageThreatLevel,
} from '../lib/page-phishing-scorer';
import { MONITORED_BRAND_PREDICATE_SQL } from '../lib/monitored-brands';
import {
  buildPageEvidenceDetails,
  clearsLookalikeAlertFloor,
  pageVerdictClearsPhishingBar,
  THREAT_LEVEL_RANK as LEVEL_ORDER,
  LOOKALIKE_ALERT_SEVERITY_FLOOR,
} from '../lib/lookalike-alert-policy';
import { createAlert } from '../lib/alerts';
import { logger } from '../lib/logger';
import type { Env } from '../types';

const PAGE_ANALYSIS_LIMIT = 20;
/**
 * The same two-cohort split `checkLookalikeBatch` applies to its DNS
 * budget, for the same reason and inside the same unchanged total.
 *
 *   * FIRST ANALYSIS (`page_fetched_at IS NULL`) — every row the seeder
 *     produces that later resolves with a web server. ~18,200 at the 35%
 *     registration band.
 *   * RE-ANALYSIS (`page_fetched_at < -24 hours`) — rows we have already
 *     scored. ~36 today. This is the ONLY cohort that can observe a page
 *     CHANGE, which is what `applyEscalation` acts on, and the only way
 *     a row whose alert was withheld at MEDIUM gets a second look once
 *     its page turns into a credential-harvest kit.
 *
 * One query ordered `page_fetched_at ASC NULLS FIRST` gave the whole
 * budget to the first cohort for ~38 days: re-analysis would not have
 * run at all, so escalation and the withheld-alert recovery path would
 * both have stopped platform-wide while the drain proceeded.
 *
 * 12/8 is the same 60/40 floor-plus-spill arrangement as the checker's
 * 30/20: 8 re-analysis slots on the hourly tick is 192 rows/day against
 * a ~36-row known population, and the spill hands re-analysis the full
 * 20 once the first-analysis cohort empties. `PAGE_ALERT_CAP` bounds
 * what either cohort can FILE, independently of this.
 */
const FIRST_ANALYSIS_SLOTS = 12;
const REANALYSIS_SLOTS = PAGE_ANALYSIS_LIMIT - FIRST_ANALYSIS_SLOTS;
const CONCURRENCY = 4;
/** Whole-run wall-clock budget. Well under the 15-min reap window. */
const RUN_BUDGET_MS = 120_000;

/**
 * Hard ceiling on alerts ONE run of this pass may CREATE (see
 * `raiseUnalertedPhishingPageAlert`). Same spirit as RUN_BUDGET_MS: a
 * bound that makes the worst case arithmetic rather than a hope.
 *
 * Sized against the QUEUE, not against this pass. Platform-wide alert
 * intake is ~36/week against ~8,941 already-unworked rows, so an
 * unbounded new producer is an operational hazard even when every alert
 * it files is correct. 5/run on the hourly `22 * * * *` tick is a
 * 120/day worst case, and only for rows whose page clears the phishing
 * bar AND the severity floor.
 *
 * A row skipped by the cap is DEFERRED, not dropped: its verdict and its
 * escalated `threat_level` are already persisted, and it becomes
 * eligible again on the next 24 h pass. The skip is logged per-domain
 * because that gap is real and an operator may want to act sooner.
 */
const PAGE_ALERT_CAP = 5;

// LEVEL_ORDER is the shared THREAT_LEVEL_RANK from lib/
// lookalike-alert-policy.ts, aliased to keep this module's existing call
// sites (and the bind-arity assertions pinned against them) unchanged.
// It used to be a third private copy of the same four-entry map.

export interface PageAnalysisRow {
  id: string;
  brand_id: string;
  domain: string;
  threat_level: string | null;
  alert_id: string | null;
  brand_name: string | null;
  brand_domain: string | null;
}

/**
 * The columns `analyzeLookalikePages` actually selects. Wider than
 * `PageAnalysisRow` because the alert path below has to reproduce the
 * checker's alert shape (permutation type, unicode display form, the DNS
 * facts) — kept as a separate interface so `applyEscalation` and
 * `runPageAnalysisForDomain` keep their narrow, already-pinned inputs.
 */
export interface PageAnalysisSelectRow extends PageAnalysisRow {
  permutation_type: string;
  unicode_domain: string | null;
  has_mx: number | null;
  has_web: number | null;
  resolves_to: string | null;
}

export interface PageAnalysisSummary {
  analyzed: number;
  fetched_ok: number;
  escalated: number;
  credential_harvest: number;
  budget_hit: boolean;
  /** Alerts this run CREATED for phishing pages that had none. */
  alerts_raised: number;
  /** Rows that qualified but whose level sat below the severity floor. */
  alerts_withheld_below_floor: number;
  /** True when PAGE_ALERT_CAP stopped at least one qualifying row. */
  alert_cap_hit: boolean;
  /** Rows selected from the never-analyzed cohort this run. */
  selected_first_analysis: number;
  /**
   * Rows selected from the already-scored cohort this run. A run of
   * zeroes here while `selected_first_analysis` is saturated is the
   * starvation the budget split exists to prevent, and it is now
   * visible rather than inferred from a flat `escalated` count.
   */
  selected_reanalysis: number;
}

function normalizeLevel(raw: string | null): PageThreatLevel {
  const v = (raw ?? 'LOW').toUpperCase();
  return v === 'MEDIUM' || v === 'HIGH' || v === 'CRITICAL' ? (v as PageThreatLevel) : 'LOW';
}

/**
 * Never-analyzed rows. No `ORDER BY`: every row in this cohort shares
 * the same (NULL) key, so ordering buys nothing and would cost a sort
 * over a cohort headed for ~18,200 rows.
 *
 * The brand gate is MONITORED_BRAND_PREDICATE_SQL, shared with the
 * seeder so the two cannot drift; it reads `brands.tier` rather than
 * `org_brands`, because a typosquat is actor intelligence whether or not
 * a tenant pays for that brand. See its definition for the staging
 * rationale and the throughput ceiling that caps how far it can widen.
 * Not EXISTS/JOIN on org_brands any more, so there is also no row
 * fan-out from a brand monitored by several orgs.
 */
function selectFirstAnalysisRows(env: Env, limit: number) {
  return env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.threat_level, ld.alert_id,
            ld.permutation_type, ld.unicode_domain, ld.has_mx, ld.has_web,
            ld.resolves_to,
            b.name AS brand_name, b.canonical_domain AS brand_domain
     FROM lookalike_domains ld
     JOIN brands b ON b.id = ld.brand_id
     WHERE ld.registered = 1
       AND ld.has_web = 1
       AND ld.resolves_to IS NOT NULL
       AND ld.page_fetched_at IS NULL
       AND ${MONITORED_BRAND_PREDICATE_SQL}
     LIMIT ?`,
  ).bind(limit).all<PageAnalysisSelectRow>();
}

/**
 * Rows already scored at least once, stalest first. `ORDER BY
 * page_fetched_at ASC` is `idx_lookalike_page_due`'s own order, so
 * there is no sort step. `offset` serves the spill only.
 */
function selectReanalysisRows(env: Env, limit: number, offset: number) {
  return env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.threat_level, ld.alert_id,
            ld.permutation_type, ld.unicode_domain, ld.has_mx, ld.has_web,
            ld.resolves_to,
            b.name AS brand_name, b.canonical_domain AS brand_domain
     FROM lookalike_domains ld
     JOIN brands b ON b.id = ld.brand_id
     WHERE ld.registered = 1
       AND ld.has_web = 1
       AND ld.resolves_to IS NOT NULL
       AND ld.page_fetched_at IS NOT NULL
       AND ld.page_fetched_at < datetime('now', '-24 hours')
       AND ${MONITORED_BRAND_PREDICATE_SQL}
     ORDER BY ld.page_fetched_at ASC
     LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<PageAnalysisSelectRow>();
}

/**
 * Fetch + score a single suspect domain and persist the page columns.
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

  if (phishing) {
    // Successful analysis — overwrite the full verdict + change-detection
    // hash.
    await env.DB.prepare(
      `UPDATE lookalike_domains
       SET page_fetched_at = datetime('now'),
           page_http_status = ?,
           page_phishing_score = ?,
           page_signals = ?,
           page_content_hash = ?,
           page_anti_bot_wall = ?,
           page_ai_signals = ?,
           page_score_delta = ?,
           page_generator = ?,
           page_exfil_sink = ?,
           page_exfil_sink_id = ?,
           page_evidence = ?,
           page_last_outcome = 'scored',
           updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(
      result.httpStatus ?? null,
      phishing.score,
      JSON.stringify(phishing.signals),
      result.contentHash ?? null,
      // Authoritative 5-family label (or null) for the crawler blind-spot
      // metric — cheap `GROUP BY page_anti_bot_wall`. The `anti_bot_wall`
      // fired key also lands in page_signals above for fired-signal
      // dashboards (T4.1 spec §5).
      phishing.antiBotWallFamily,
      // ── Lane 3 SHADOW MODE (migration 0264) ─────────────────────
      // Persisted for measurement ONLY. page_phishing_score above is
      // the pre-Lane-3 score and page_score_delta is NOT added to it;
      // threat_level escalation below reads neither. Promotion out of
      // shadow mode is Phase 2 (spec §5.1-§5.2).
      //
      // page_ai_signals and page_score_delta are written on EVERY
      // successful analysis (as '[]' / 0 when nothing fired), which is
      // also what makes a non-NULL page_ai_signals the reliable marker
      // that the last analysis reached the scorer — the failure branch
      // below writes none of these columns.
      JSON.stringify(phishing.aiSignals),
      phishing.scoreDelta,
      phishing.pageGenerator,
      phishing.exfilSink,
      phishing.exfilSinkId,
      Object.keys(phishing.evidence).length > 0 ? JSON.stringify(phishing.evidence) : null,
      row.id,
    ).run();
  } else {
    // Failed / blocked / non-HTML / oversize fetch. Advance the 24h
    // cooldown (page_fetched_at) and record any status, but do NOT wipe a
    // prior successful verdict or its content-hash baseline — leave
    // page_phishing_score / page_signals / page_content_hash intact.
    // Same rule for the Lane 3 shadow columns (migration 0264): this
    // branch writes NONE of page_ai_signals / page_score_delta /
    // page_generator / page_exfil_sink / page_exfil_sink_id /
    // page_evidence, so a transient fetch failure never erases the
    // evidence an analyst is adjudicating.
    //
    // page_last_outcome (migration 0266) is the ONE exception to that
    // rule, and deliberately so: it must describe the LAST pass, not the
    // last SUCCESSFUL one. Leaving a stale 'scored' here is exactly the
    // §11.3 defect — a row that scored once and has 403'd for a month
    // would keep contributing its stale signal set to the §5.2 lift
    // measurement. Normalized rather than raw (§11.4 + the IP-leak note
    // in normalizePageOutcome).
    await env.DB.prepare(
      `UPDATE lookalike_domains
       SET page_fetched_at = datetime('now'),
           page_http_status = ?,
           page_last_outcome = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(
      result.httpStatus ?? null,
      normalizePageOutcome(result.rejectedReason),
      row.id,
    ).run();
  }

  return { result, phishing };
}

/**
 * Apply the monotonic page escalation to a lookalike row's threat_level
 * and, when the level rises and a live alert is linked, bump the alert's
 * severity. Never downgrades. Returns true if anything escalated.
 */
export async function applyEscalation(
  env: Env,
  row: PageAnalysisRow,
  phishing: PagePhishingResult,
): Promise<boolean> {
  const current = normalizeLevel(row.threat_level);
  // Derive the bare-wall floor flag caller-side from the fired set so the
  // escalation function stays pure value-in / value-out (T4.1 spec §3).
  const next = escalateThreatLevelForPage(current, {
    score: phishing.score,
    credentialHarvest: phishing.credentialHarvest,
    antiBotWall: phishing.signals.includes('anti_bot_wall'),
  });
  if (LEVEL_ORDER[next] <= LEVEL_ORDER[current]) return false;

  await env.DB.prepare(
    `UPDATE lookalike_domains
     SET threat_level = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(next, row.id).run();

  if (row.alert_id) {
    // Raise the operator-facing alert severity too, but MONOTONICALLY —
    // only ever up, never down. The CASE ranks the alert's CURRENT
    // (lowercase, migration 0121 CHECK) severity and the WHERE only
    // fires when it sits below the new level, so an analyst's manual
    // escalation (e.g. critical) is never silently downgraded by a lower
    // page verdict. Scoped to still-open alerts (never resurrect a
    // resolved/dismissed one).
    await env.DB.prepare(
      `UPDATE alerts
       SET severity = ?, updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('new','acknowledged','investigating')
         AND (CASE severity
                WHEN 'critical' THEN 3
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 1
                ELSE 0
              END) < ?`,
    ).bind(next.toLowerCase(), row.alert_id, LEVEL_ORDER[next]).run();
  }
  return true;
}

/**
 * Create the `lookalike_domain_active` alert for a REGISTERED row whose
 * page clears the phishing bar but which carries NO linked alert.
 *
 * ── The blind spot this closes ──────────────────────────────────────
 *
 * `checkLookalikeBatch` alerts on the `registered 0 -> 1` transition
 * only, and two independent things now leave a registered row with no
 * alert:
 *
 *   1. First contact with a seeded row withholds the alert unless a
 *      signal is present (mail+web) — but it still flips `registered` to
 *      1. So `row.registered === 0` is false FOREVER afterwards and the
 *      checker's alert branch can never be reached for that row again.
 *   2. The severity floor withholds it whenever the composed level lands
 *      below HIGH, on first contact and on real transitions alike.
 *
 * Either way the row sits registered, with a persisted verdict, and no
 * notification — and `applyEscalation` above cannot fix it, because it
 * only ever BUMPS an existing alert's severity and its UPDATE is guarded
 * by `if (row.alert_id)`. Without this function a withheld row whose page
 * later became an outright credential-harvest kit would escalate its
 * `threat_level` silently and alert nobody.
 *
 * So this is the second half of the suppression: the pass that produces
 * the page verdict must also be able to act on it.
 *
 * ── Idempotency under CONCURRENCY = 4 ───────────────────────────────
 *
 * The pass re-runs every 24 h over overlapping populations, so a
 * double-create has to be impossible rather than unlikely:
 *
 *   * WITHIN a run — `row.alert_id === null` is read from a SELECT keyed
 *     on the primary key, so each id appears at most ONCE in
 *     `rows.results`. Two concurrent tasks therefore never share a row,
 *     and the `alert_id` each writes is its own. Concurrency cannot
 *     produce a second alert for one row.
 *   * ACROSS runs — `runPageAnalysisForDomain` stamps
 *     `page_fetched_at = datetime('now')` on BOTH its branches, and it
 *     runs (and awaits) BEFORE this function is called. The selection
 *     predicate requires `page_fetched_at IS NULL OR < -24 hours`, so by
 *     the time this row could be re-selected its `alert_id` write has
 *     long since landed.
 *
 * The write is still CONDITIONAL (`AND alert_id IS NULL`) and a zero-row
 * result is logged at error level. That is a tripwire, not the guarantee:
 * if the reasoning above is ever invalidated — by a second producer, or
 * by someone widening the SELECT — the collision becomes visible in the
 * logs instead of quietly duplicating operator work.
 *
 * Returns true when an alert was created.
 */
export async function raiseUnalertedPhishingPageAlert(
  env: Env,
  row: PageAnalysisSelectRow,
  phishing: PagePhishingResult,
): Promise<{ created: boolean; withheld_below_floor: boolean }> {
  // Severity is the same composed level `applyEscalation` just wrote —
  // recomputed from the same pure inputs rather than threaded through, so
  // this stays independent of whether the level actually ROSE this pass.
  // A row that was already HIGH escalates by zero steps and still
  // deserves its first alert.
  const severity = escalateThreatLevelForPage(normalizeLevel(row.threat_level), {
    score: phishing.score,
    credentialHarvest: phishing.credentialHarvest,
    antiBotWall: phishing.signals.includes('anti_bot_wall'),
  });

  // The severity floor, from the one shared home both producers use.
  //
  // Today this is implied by `pageVerdictClearsPhishingBar` (which the
  // caller has already applied): a verdict that reaches HIGH from the LOW
  // floor reaches at least HIGH from any level, because the escalation is
  // monotonic. It is asserted anyway, explicitly, so that raising the
  // floor to CRITICAL later takes effect on BOTH producers rather than on
  // one — which is the entire reason the comparison lives in lib/.
  if (!clearsLookalikeAlertFloor(severity)) {
    logger.info('lookalike_page_alert_withheld_below_floor', {
      domain: row.domain,
      severity,
      floor: LOOKALIKE_ALERT_SEVERITY_FLOOR,
    });
    return { created: false, withheld_below_floor: true };
  }

  // IDN homoglyphs are stored as punycode; surface the human-readable
  // unicode form in operator-facing copy (same rule as the checker).
  const displayDomain = row.unicode_domain ?? row.domain;

  const alertId = await createAlert(env.DB, {
    brandId: row.brand_id,
    // user_id-as-owner is dead platform-wide (R7); read-side scoping is
    // brand_id -> org_brands. Matches the checker's 'system' attribution.
    userId: 'system',
    // Deliberately the SAME alert type as the checker's, not a parallel
    // one: to an operator this is the same finding — an active lookalike
    // — discovered one pass later. A new type would need a migration to
    // the 0121 CHECK, a UI label, and its own triage reasoning.
    alertType: 'lookalike_domain_active',
    severity,
    title: `Lookalike domain serving a phishing page: ${displayDomain}`,
    summary: `The lookalike domain ${displayDomain} (${row.permutation_type} variant of ` +
      `${row.brand_domain ?? 'a monitored brand'}) is serving a page that scores as phishing ` +
      `on deterministic content analysis${phishing.credentialHarvest
        ? ', including a credential form posting to an off-domain endpoint'
        : ''}. No alert had been raised for this domain previously.`,
    details: {
      lookalike_domain: row.domain,
      unicode_domain: row.unicode_domain ?? undefined,
      original_domain: row.brand_domain,
      permutation_type: row.permutation_type,
      resolves_to: row.resolves_to,
      has_mx: row.has_mx === 1,
      has_web: row.has_web === 1,
      // KEYS ONLY — never phishing.evidence / exfilSink / exfilSinkId.
      // Read that builder's docstring: alert details reach customer
      // surfaces and email digests, and those three fields are literals
      // lifted verbatim from attacker-controlled page content.
      ...buildPageEvidenceDetails(phishing),
      // Distinguishes this producer from the registration-transition one
      // inside the same alert type, so the two are separable in analysis
      // without a second alert_type.
      discovered_by: 'page_analysis',
    },
    sourceType: 'lookalike_scanner',
    sourceId: row.id,
    aiRecommendations: [
      'Review the live page content and capture evidence before it rotates',
      'Consider an expedited takedown or registrar abuse report',
      'Check whether credentials may already have been submitted',
    ],
  });

  // Null = `createAlert`'s NX2 tier gate declined the insert
  // (brands.tier = 'tracked'). Nothing to link, nothing raised.
  if (!alertId) return { created: false, withheld_below_floor: false };

  const link = await env.DB.prepare(
    `UPDATE lookalike_domains
     SET alert_id = ?, updated_at = datetime('now')
     WHERE id = ? AND alert_id IS NULL`,
  ).bind(alertId, row.id).run();

  if ((link.meta.changes ?? 0) === 0) {
    // Another writer linked an alert between our SELECT and here. Per the
    // ordering argument in the docstring this is unreachable; if it ever
    // fires, it is the duplicate-alert signal to investigate.
    logger.error('lookalike_page_alert_link_lost', {
      domain: row.domain,
      lookalike_id: row.id,
      alert_id: alertId,
    });
  }
  return { created: true, withheld_below_floor: false };
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
    alerts_raised: 0,
    alerts_withheld_below_floor: 0,
    alert_cap_hit: false,
    selected_first_analysis: 0,
    selected_reanalysis: 0,
  };

  // Shared alert-creation budget for the whole run. Same shape and same
  // race argument as checkLookalikeBatch's inline page budget: JS is
  // single-threaded between awaits, so the synchronous `remaining -= 1`
  // taken before the first await is race-free under CONCURRENCY = 4.
  const alertBudget = { remaining: PAGE_ALERT_CAP };

  // Population: the platform-monitored, registered, resolving, has_web
  // set — the domains checkLookalikeBatch already alerts on. The brand
  // gate is MONITORED_BRAND_PREDICATE_SQL, shared with the seeder so the
  // two cannot drift; it reads `brands.tier` rather than `org_brands`,
  // because a typosquat is actor intelligence whether or not a tenant
  // pays for that brand. See its definition for the staging rationale
  // and the throughput ceiling that caps how far it can widen.
  //
  // Predicate not EXISTS/JOIN on org_brands any more, so there is also no
  // longer a row-fan-out concern from a brand monitored by several orgs.
  // Reads are fine off env.DB here (agent context);
  // the volume is bounded to 20 rows/run.
  //
  // The extra non-page columns (permutation_type / unicode_domain /
  // has_mx / has_web / resolves_to) are here for
  // `raiseUnalertedPhishingPageAlert` — they reproduce the checker's
  // alert shape without a second round-trip per row. `has_web` is
  // already pinned to 1 by the predicate and is selected anyway so the
  // alert's `details` states the fact rather than assuming it.
  //
  // Split into two explicitly budgeted cohorts — see
  // FIRST_ANALYSIS_SLOTS above. Re-analysis goes first so its floor is
  // taken before the large cohort can claim it; first analysis absorbs
  // what re-analysis left; the spill returns the remainder. Both are
  // served by `idx_lookalike_page_due` (migration 0268), a partial index
  // on `page_fetched_at` over exactly this `registered = 1 AND has_web =
  // 1` set, so each cohort is an index range scan in index order — no
  // table scan, no sort.
  const reanalysis = await selectReanalysisRows(env, REANALYSIS_SLOTS, 0);
  const firstAnalysisBudget = PAGE_ANALYSIS_LIMIT - reanalysis.results.length;
  const firstAnalysis = await selectFirstAnalysisRows(env, firstAnalysisBudget);

  const spent = reanalysis.results.length + firstAnalysis.results.length;
  const spill = spent < PAGE_ANALYSIS_LIMIT && reanalysis.results.length === REANALYSIS_SLOTS
    ? (await selectReanalysisRows(env, PAGE_ANALYSIS_LIMIT - spent, REANALYSIS_SLOTS)).results
    : [];

  // Merge by id. The cohorts are disjoint by construction (`IS NULL` vs
  // `IS NOT NULL`); this only collapses a row the spill's OFFSET could
  // re-serve under a `page_fetched_at` tie. It also keeps
  // `raiseUnalertedPhishingPageAlert`'s WITHIN-a-run idempotency
  // argument intact: that argument rests on each id appearing at most
  // once in the row set, which was previously guaranteed by there being
  // one SELECT.
  const byId = new Map<string, PageAnalysisSelectRow>();
  for (const r of [...reanalysis.results, ...spill, ...firstAnalysis.results]) byId.set(r.id, r);
  const selected = [...byId.values()];

  summary.selected_first_analysis = firstAnalysis.results.length;
  summary.selected_reanalysis = reanalysis.results.length + spill.length;

  if (selected.length === 0) {
    return summary;
  }

  for (let i = 0; i < selected.length; i += CONCURRENCY) {
    // Wall-clock budget guard — stop launching new fetches if we're
    // running long. Leaves remaining rows for the next tick (their
    // page_fetched_at stays stale, so they're re-selected).
    if (Date.now() - runStart > RUN_BUDGET_MS) {
      summary.budget_hit = true;
      break;
    }

    const batch = selected.slice(i, i + CONCURRENCY);
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

            // ── The blind-spot path (see raiseUnalertedPhishingPageAlert)
            // Ordered deliberately AFTER applyEscalation: that call is
            // what persists the raised `threat_level`, so if the alert
            // path throws or is capped, the row's own verdict has already
            // landed and the deliverable survives.
            //
            // Three gates, cheapest first:
            //   1. no linked alert — the ONLY state this path may act on,
            //      and keyed on `alert_id` rather than on anything that
            //      assumes an alert was ever attempted. With the severity
            //      floor a row can legitimately be registered, MEDIUM and
            //      alert-less, and it must still be reachable here.
            //   2. the page verdict clears the PHISHING bar, not merely
            //      the "worth looking at" bar.
            //   3. run budget remains. Decremented synchronously before
            //      the await so CONCURRENCY = 4 cannot overspend it.
            if (row.alert_id === null && pageVerdictClearsPhishingBar(phishing)) {
              if (alertBudget.remaining > 0) {
                alertBudget.remaining -= 1;
                const raised = await raiseUnalertedPhishingPageAlert(env, row, phishing);
                if (raised.created) summary.alerts_raised += 1;
                if (raised.withheld_below_floor) summary.alerts_withheld_below_floor += 1;
              } else {
                // Deferred, not dropped — the verdict is persisted and
                // the row is eligible again after the 24 h cooldown.
                // Logged per-domain because that gap is real.
                summary.alert_cap_hit = true;
                logger.warn('lookalike_page_alert_cap_hit', {
                  domain: row.domain,
                  lookalike_id: row.id,
                  cap: PAGE_ALERT_CAP,
                });
              }
            }
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
