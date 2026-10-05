/**
 * Lookalike Domain Scanner — Continuous monitoring for brand-impersonating domains.
 *
 * Generates permutations via dnstwist.ts, stores them in D1, and
 * periodically re-checks them via Cloudflare DoH. What the re-check DOES
 * depends on which TRANSITION it observed — see
 * `classifyLookalikeTransitions` and the dispatch in `runCheckRows`.
 */

import { generatePermutations } from '../lib/dnstwist';
import { createAlert } from '../lib/alerts';
import { checkBIMIExists } from '../email-security';
import { checkDomain, type DomainCheckResult } from '../lib/domain-checker';
import { logger } from '../lib/logger';
import { DEFAULT_DEADLINE_MS } from '../lib/page-fetch';
import { escalateThreatLevelForPage } from '../lib/page-phishing-scorer';
import type { PagePhishingResult, PageThreatLevel } from '../lib/page-phishing-scorer';
import { runPageAnalysisForDomain } from './lookalike-page-analysis';
import { MONITORED_BRAND_PREDICATE_SQL } from '../lib/monitored-brands';
import { computeBackoffRetryAt, LOOKALIKE_CHECK_LADDER } from '../lib/backoff';
import {
  LOOKALIKE_BATCH_LIMIT,
  LOOKALIKE_UNPARK_PER_RUN,
  LOOKALIKE_UNPARK_MIN_AGE_MODIFIER,
} from '../lib/lookalike-budget';
import {
  buildPageEvidenceDetails,
  clearsLookalikeAlertFloor,
  normalizeThreatLevel,
  THREAT_LEVEL_RANK,
  LOOKALIKE_ALERT_SEVERITY_FLOOR,
} from '../lib/lookalike-alert-policy';
import type { Env } from '../types';

// Inline page-analysis budget for the compositor. The broader re-check
// set is handled by analyzeLookalikePages (throttled); here we only
// fetch a bounded number of has_web domains per tick so a backfill surge
// can't blow the tick's wall-clock budget.
const INLINE_PAGE_FETCH_CAP = 10;
const INLINE_PAGE_BUDGET_MS = 60_000;

// ─── Per-run DNS budget, SPLIT between the two cohorts ────────────
//
// The total is unchanged at 50 rows/tick. The two populations do not
// compete in one queue, because they are not comparable:
//
//   * FIRST CONTACT (`baseline_established_at IS NULL`) — the seeder
//     backlog. ~56,010 rows, growing by ~300/tick (10 brands x ~30
//     permutations) while the seeder drains its 1,864-brand stage.
//     One-time.
//   * RE-CHECK (`baseline_established_at IS NOT NULL`) — everything we
//     have already observed. Small today (the ~120 pre-existing rows)
//     and the ONLY path that can observe a TRANSITION: a real
//     `first_seen`, a lapse, a re-registration, a newly-appearing MX or
//     web server, or a BIMI record published after we first looked.
//
// WHY DUENESS ALONE CANNOT BE THE QUEUE. The scheduling column is now
// `check_due_at` (migration 0269) and the obvious simplification is to
// drop the split and just take the 50 most-overdue rows. That
// re-creates the starvation from the other direction: a row seeded three
// weeks ago and never looked at is MORE overdue than a re-check due 24 h
// after its last successful look, so one queue starves re-check exactly
// as `ORDER BY last_checked ASC NULLS FIRST` did. The split was never
// the bug — the bug was that the discriminator and the scheduling column
// were the SAME column, so every scheduling write was also a
// reclassification.
//
// RATIO. `RECHECK_SLOTS` is a FLOOR, not a cap — the spill step in
// `checkLookalikeBatch` hands unused slots to whichever cohort can use
// them, in either direction. 20 re-check slots is 480 rows/day, four
// times today's ENTIRE known population, so known rows keep a
// better-than-24h cadence throughout the drain even in the worst case;
// and once the drain finishes and the first-contact cohort empties, the
// spill gives re-check the full 50. Deliberately NOT a bigger total: see
// `lib/monitored-brands.ts` for why raising the cap without a
// wall-clock guard makes things worse, not better.
//
// `LOOKALIKE_BATCH_LIMIT` itself now lives in `lib/lookalike-budget.ts`
// — Flight Control needs it, and importing it from this module dragged
// `email-security` / `lib/page-fetch` into FC's import
// graph for the sake of one integer.
const FIRST_CONTACT_SLOTS = 30;
const RECHECK_SLOTS = LOOKALIKE_BATCH_LIMIT - FIRST_CONTACT_SLOTS;

/**
 * The success cadence, as a SQLite datetime modifier.
 *
 * Bound rather than inlined so the value is one named constant instead
 * of a string buried in an UPDATE — the previous arrangement had the
 * same 24 hours written as `datetime('now','-24 hours')` in two cohort
 * SELECTs and nowhere as a definition, which is how the "Scan now"
 * handler came to encode it as the magic number `-25 hours`.
 */
const CHECK_CADENCE_MODIFIER = '+24 hours';

/**
 * HARD CEILING on BIMI DNS lookups ONE run may make.
 *
 * The BEC lane is recurring (see `probeAndFileBimi`), so in principle
 * every registered + MX row in a batch is eligible on every pass. The
 * cost is one DNS TXT lookup, not a token spend, so the bound here is
 * WALL CLOCK: `checkBIMIExists` can take up to its own timeout, and 50
 * of them inside CONCURRENCY = 5 batches is ~10 serialized rounds. 25
 * halves that worst case to ~5 rounds while still covering half a full
 * batch, which is more than the measured 62%-of-registered eligible
 * share of a realistic tick.
 *
 * A capped row is deferred: `bimi_first_seen_at` stays NULL (the lane's
 * eligibility predicate) so it is picked up on the next pass. The cap is
 * checked BEFORE the claim for exactly this reason — a row that burned
 * its claim and then hit the cap would never alert.
 */
const BIMI_LOOKUPS_PER_RUN = 25;

/**
 * Budgets for ONE run of the shared row processor.
 *
 * Two named sets, because the two entry points have different risk
 * profiles: the cron tick owns a whole Worker invocation, while
 * `checkLookalikeBatchForBrand` runs INSIDE AN HTTP REQUEST and must not
 * be able to hold one open while it spends 50 DoH queries and 10 page
 * fetches. (There is no AI budget: the threat level is rule-composed —
 * see `compositeAndPersist` — and this pass makes no model calls.)
 */
export interface CheckRunLimits {
  /** Rows the run may process. */
  rows: number;
  bimiLookups: number;
  inlinePageFetches: number;
  pageBudgetMs: number;
}

export const CRON_CHECK_LIMITS: CheckRunLimits = {
  rows: LOOKALIKE_BATCH_LIMIT,
  bimiLookups: BIMI_LOOKUPS_PER_RUN,
  inlinePageFetches: INLINE_PAGE_FETCH_CAP,
  pageBudgetMs: INLINE_PAGE_BUDGET_MS,
};

/**
 * The operator-rescan budget — deliberately a fraction of the cron's.
 *
 * The rescan's JOB is the enqueue (`check_due_at` = the epoch, which
 * beats every other row in the cohort); the inline run is a courtesy so
 * the operator sees something immediately. The remainder drains on the
 * next cron ticks, at the front of the queue, because that is what the
 * enqueue already guaranteed.
 *
 * The enqueue is BOUNDED at `LOOKALIKE_RESCAN_ENQUEUE_LIMIT` rows per
 * press and skips rows already at the epoch — the queue is global and
 * cross-tenant, so an unbounded epoch write is a starvation primitive.
 * See that constant.
 */
export const SCAN_NOW_CHECK_LIMITS: CheckRunLimits = {
  rows: 10,
  bimiLookups: 5,
  inlinePageFetches: 2,
  pageBudgetMs: 15_000,
};

/**
 * What one run of the row processor did.
 *
 * Returned as well as logged (F8). `row_errors` in particular has to
 * reach an operator surface rather than only the log stream: it counts
 * rows whose processing THREW, which before per-row isolation could not
 * be counted at all because a single throw aborted the tick. The
 * `lookalike_scanner` agent folds this into its `agentOutputs`
 * diagnostic, so it lands in `agent_runs` / the /v2/agents page
 * (CLAUDE.md §6) instead of requiring a log search.
 *
 * ── THE SWALLOWED-ERROR COUNTERS ────────────────────────────────────
 *
 * `row_errors` was the ONLY defect counter, and per-row isolation plus
 * the BEC lane's own try/catch left FOUR independently-swallowed failure
 * paths that it cannot see — each one `logger.error` and nothing else.
 * CLAUDE.md §11 is explicit that operator-visible failure belongs on
 * `agent_runs`, not the log stream, so each gets a counter and
 * `lookalikeCheckDefects` folds them into the agent's severity:
 *
 *   bimi_claim_release_failures  THE WORST ONE. The row stays marked
 *                                "BIMI recorded" with no alert in
 *                                existence, and the lane's own
 *                                `bimi_first_seen_at IS NULL`
 *                                eligibility will never offer it again:
 *                                a silently and PERMANENTLY lost
 *                                finding, which is the only remaining
 *                                path of that kind in this file.
 *   bimi_alert_errors            A BIMI finding whose alert did not
 *                                file. Retried next pass (the claim is
 *                                released), but a persistent non-zero
 *                                means every BIMI finding is being
 *                                retried forever and none is landing.
 *   cooldown_stamp_failures      The row was NOT backed off, so it is
 *                                re-selected on the very next tick —
 *                                the hot-loop shape per-row isolation
 *                                exists to prevent.
 *   inline_page_errors           Page evidence silently absent from the
 *                                alert. `fetchSuspectPage` returns
 *                                `{ok: false}` for every ordinary
 *                                network/SSRF outcome rather than
 *                                throwing, so a throw here is a real
 *                                defect and not crawler noise.
 */
export interface LookalikeCheckSummary {
  checked: number;
  /** `registered 0 -> 1` transitions WE observed. */
  new_registrations: number;
  baselines_established: number;
  baselines_suppressed: number;
  /** `typosquat_bimi` alerts filed by the recurring BEC lane. */
  bimi_alerts: number;
  /** DNS TXT lookups the BEC lane spent. */
  bimi_lookups: number;
  bimi_cap_hit: boolean;
  alerts_withheld_below_floor: number;
  /** Checks the resolver gave no answer for — orderly, not a defect. */
  checks_unresolved: number;
  /** Rows whose processing threw. A DEFECT count; should be 0. */
  row_errors: number;
  /** Rows the backoff ladder PARKED (`check_due_at = NULL`). */
  rows_parked: number;
  /** Parked rows this tick RE-ADMITTED to the queue. */
  rows_unparked: number;
  // ── The four swallowed-error paths. All DEFECT counts; see the
  // interface docstring for what each one costs.
  bimi_alert_errors: number;
  bimi_claim_release_failures: number;
  cooldown_stamp_failures: number;
  inline_page_errors: number;
  /**
   * `none`-transition rows re-composited because their EFFECTIVE state is
   * mail+web while the stored level is below HIGH — the one-time catch-up
   * for rows a former Haiku verdict held at LOW/MEDIUM (`ai_assessment`
   * set, status not benign/taken_down). Self-extinguishing:
   * the compositor raises them to HIGH, after which they no longer qualify.
   */
  mail_web_level_lifts: number;
  /** `has_mx 0 -> 1` on an already-registered row. */
  mx_gained: number;
  /** `has_web 0 -> 1` on an already-registered row. */
  web_gained: number;
  /** `has_mx`/`has_web` `1 -> 0`, answered. Persisted, never alerted. */
  mail_or_web_lost: number;
  /** `registered 1 -> 0`, answered. */
  registrations_lost: number;
  /** Linked takedowns stamped `verification_status = 'down'`. */
  takedowns_verified_down: number;
  // ── The mail+web share, MEASURED ─────────────────────────────────
  // The share of registered rows that are operational (mail AND web),
  // which is the rule that lifts a row to HIGH. Nothing used to record
  // it, so the only number available was a one-off manual query (26 of
  // 42 registered rows, 62%). These four counters make it a per-run
  // observation on the agent diagnostic.
  observed_registered: number;
  observed_mail_and_web: number;
  observed_mx_only: number;
  observed_web_only: number;
  selected_first_contact: number;
  selected_recheck: number;
}

/** "Nothing was due" — every counter zero. */
function emptySummary(): LookalikeCheckSummary {
  return {
    checked: 0,
    new_registrations: 0,
    baselines_established: 0,
    baselines_suppressed: 0,
    bimi_alerts: 0,
    bimi_lookups: 0,
    bimi_cap_hit: false,
    alerts_withheld_below_floor: 0,
    checks_unresolved: 0,
    row_errors: 0,
    rows_parked: 0,
    rows_unparked: 0,
    bimi_alert_errors: 0,
    bimi_claim_release_failures: 0,
    cooldown_stamp_failures: 0,
    inline_page_errors: 0,
    mail_web_level_lifts: 0,
    mx_gained: 0,
    web_gained: 0,
    mail_or_web_lost: 0,
    registrations_lost: 0,
    takedowns_verified_down: 0,
    observed_registered: 0,
    observed_mail_and_web: 0,
    observed_mx_only: 0,
    observed_web_only: 0,
    selected_first_contact: 0,
    selected_recheck: 0,
  };
}

/**
 * Every DEFECT this run counted, as one number.
 *
 * PURE, exported and unit-tested so the agent's severity decision is not
 * a hand-maintained `||` chain that drifts the next time a counter is
 * added. The five members are exactly the paths that are invisible
 * without it: the row-level throw plus the four independently-swallowed
 * `logger.error` sites enumerated in `LookalikeCheckSummary`'s
 * docstring.
 *
 * Deliberately NOT a member: `checks_unresolved` (an orderly DNS
 * non-answer), `rows_parked` / `rows_unparked` (the ladder working as
 * designed), `bimi_cap_hit` (a budget biting, which is
 * what a budget is for) and `alerts_withheld_below_floor` (policy).
 */
export function lookalikeCheckDefects(s: LookalikeCheckSummary): number {
  return s.row_errors
    + s.bimi_alert_errors
    + s.bimi_claim_release_failures
    + s.cooldown_stamp_failures
    + s.inline_page_errors;
}

/**
 * The columns `runCheckRows` needs per row.
 *
 * ── Why it is this wide ─────────────────────────────────────────────
 *
 * It used to carry `id, brand_id, domain, permutation_type, registered,
 * unicode_domain, last_checked` — which cannot see its own prior state
 * beyond `registered`. That is why every capability in this file was
 * reachable exactly ONCE per row: the only transition it could detect
 * was `registered 0 -> 1`, and `registered` is monotone in practice, so
 * once a row flipped to 1 the alert branch, the BIMI
 * probe and the compositor were all unreachable forever.
 *
 * `has_mx` / `has_web` make MX and web APPEARANCE detectable.
 * `threat_level` makes the compositor re-entrant without lowering what a
 * previous pass (or the page pass, or an analyst) established.
 * `ai_assessment` is READ ONLY — a historical Haiku note this scanner no
 * longer writes (AI_STRATEGY_2026-10 Phase 1 #18); it is carried onto the
 * alert when present and is otherwise inert. `alert_id` bounds the MX/WEB re-composite path
 * to one alert (and ONLY that path — a `registration_gained` after a
 * lapse re-alerts by design; see that branch).
 * `baseline_established_at` is the first-contact
 * discriminator (0267, amended). `bimi_first_seen_at` is the BEC lane's
 * eligibility token. `check_attempts` drives the backoff ladder.
 * `takedown_id` is what makes a `registered 1 -> 0` actionable.
 *
 * Both cohort queries already did a rowid lookup per selected row, so
 * the wider projection costs no additional seek — the EXPLAIN assertions
 * in `test/lookalike-sql-statements.test.ts` are re-run against it to
 * prove exactly that.
 */
interface LookalikeCheckRow {
  id: string;
  brand_id: string;
  domain: string;
  permutation_type: string;
  registered: number;
  unicode_domain: string | null;
  has_mx: number | null;
  has_web: number | null;
  threat_level: string | null;
  ai_assessment: string | null;
  alert_id: string | null;
  baseline_established_at: string | null;
  bimi_first_seen_at: string | null;
  check_attempts: number;
  takedown_id: string | null;
  /**
   * Analyst disposition (migration 0031: monitoring | confirmed_threat |
   * benign | taken_down). Read ONLY by the mail+web catch-up, which must
   * never re-raise a row an analyst marked benign or already actioned.
   */
  status: string | null;
}

/**
 * ── THE ONE RULE THE COHORT SELECTS ENFORCE ─────────────────────────
 *
 * NEITHER cohort query mentions `last_checked` or
 * `last_check_failed_at`, anywhere, in any clause. Dueness is
 * `check_due_at` and nothing else; the first-contact discriminator is
 * `baseline_established_at` and nothing else. `last_checked` is now a
 * pure record of the last successful observation and
 * `last_check_failed_at` a pure historical record of the last failure —
 * read by the staff/tenant column lists and by Observer's briefing, by
 * NO selection predicate.
 *
 * That is asserted mechanically in
 * `test/lookalike-sql-statements.test.ts` rather than left as this
 * comment, because "we removed the double-sourcing" is exactly the kind
 * of claim that decays.
 *
 * Never-baselined rows. No `ORDER BY` beyond the index's own, and the
 * three WHERE terms are stated explicitly so the query IMPLIES
 * `idx_lookalike_due_first_contact`'s partial predicate — a partial
 * index SQLite cannot prove is implied is a dead index.
 */
function selectFirstContactRows(env: Env, limit: number) {
  return env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.permutation_type, ld.registered,
            ld.unicode_domain, ld.has_mx, ld.has_web, ld.threat_level,
            ld.ai_assessment, ld.alert_id, ld.baseline_established_at,
            ld.bimi_first_seen_at, ld.check_attempts, ld.takedown_id, ld.status
     FROM lookalike_domains ld
     WHERE ld.baseline_established_at IS NULL
       AND ld.check_due_at IS NOT NULL
       AND ld.check_due_at <= datetime('now')
     ORDER BY ld.check_due_at ASC
     LIMIT ?`,
  ).bind(limit).all<LookalikeCheckRow>();
}

/**
 * Rows we HAVE observed before, most overdue first. Same three-term
 * shape against `idx_lookalike_due_recheck`.
 *
 * `offset` exists only for the spill step: when the first-contact cohort
 * cannot fill its share (post-drain, or an empty table), the remaining
 * slots come back here rather than going unused.
 */
function selectRecheckRows(env: Env, limit: number, offset: number) {
  return env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.permutation_type, ld.registered,
            ld.unicode_domain, ld.has_mx, ld.has_web, ld.threat_level,
            ld.ai_assessment, ld.alert_id, ld.baseline_established_at,
            ld.bimi_first_seen_at, ld.check_attempts, ld.takedown_id, ld.status
     FROM lookalike_domains ld
     WHERE ld.baseline_established_at IS NOT NULL
       AND ld.check_due_at IS NOT NULL
       AND ld.check_due_at <= datetime('now')
     ORDER BY ld.check_due_at ASC
     LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<LookalikeCheckRow>();
}

/**
 * ONE brand's due rows, for the operator rescan.
 *
 * Driven by `idx_lookalike_brand` (brand_id equality) with the dueness
 * terms as residual filters — a brand holds ~30 permutations, so there
 * is nothing to narrow further. Deliberately NO `ORDER BY`: the rescan
 * handler has just stamped the brand's enqueued rows with the SAME
 * `check_due_at` (the epoch), so an ordering clause would buy nothing
 * and cost a temp b-tree. Same reasoning the first-contact cohort used
 * when all its rows shared a NULL key.
 */
function selectBrandDueRows(env: Env, brandId: string, limit: number) {
  return env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.permutation_type, ld.registered,
            ld.unicode_domain, ld.has_mx, ld.has_web, ld.threat_level,
            ld.ai_assessment, ld.alert_id, ld.baseline_established_at,
            ld.bimi_first_seen_at, ld.check_attempts, ld.takedown_id, ld.status
     FROM lookalike_domains ld
     WHERE ld.brand_id = ?
       AND ld.check_due_at IS NOT NULL
       AND ld.check_due_at <= datetime('now')
     LIMIT ?`,
  ).bind(brandId, limit).all<LookalikeCheckRow>();
}

/**
 * Re-admit the oldest PARKED rows — the bounded way back out of the
 * ladder's terminal step.
 *
 * ── Why a parked row needed one at all ──────────────────────────────
 *
 * See `LOOKALIKE_UNPARK_PER_RUN` in `lib/lookalike-budget.ts` for the
 * full argument: four writers touch `check_due_at` and three of them
 * cannot reach a parked row, so the only exit was the MANUAL per-brand
 * operator rescan. A row parked before its first successful observation
 * also still carries the seeder's `registered = 0 / has_web = 0 /
 * resolves_to NULL` defaults, so it is invisible to both page-analysis
 * cohorts too, and the one Flight Control warning is keyed on the DUE
 * backlog — which parking REDUCES.
 *
 * ── Why this needs no cron and no new state ─────────────────────────
 *
 * It runs on the checker's own tick, BEFORE selection, and the rows it
 * re-admits are due at `datetime('now')` — which is the LATEST possible
 * due time among due rows. So they sort behind every genuinely overdue
 * row in their cohort and consume only slack capacity: total work per
 * tick is still `limits.rows`, and a saturated queue defers them for
 * free rather than crowding anything out. A dedicated cron would also
 * trigger CLAUDE.md's cron-audit rule for no benefit.
 *
 * The cadence is self-throttling with no cursor, no KV and no counter
 * column, because `last_check_failed_at` is written ONLY by the failure
 * path: on a parked row it is frozen at the moment it parked. A
 * re-admitted row that fails again re-stamps it and is therefore not
 * eligible for another `LOOKALIKE_UNPARK_MIN_AGE_MODIFIER` window; one
 * that succeeds has it cleared and `check_attempts` reset by
 * `persistCheckFacts` and rejoins the normal cadence.
 *
 * `check_attempts` is NOT reset here — see the budget module for why
 * one probe per window is the affordable shape and a full ladder replay
 * is not.
 *
 * Served by `idx_lookalike_parked` (migration 0269, keyed on
 * `last_check_failed_at` and partial on `check_due_at IS NULL`), so the
 * subquery is an index range scan in index order with no temp b-tree
 * over a set that is tiny by construction. Never throws: an un-park
 * failure must not cost the tick its actual work.
 */
async function unparkOldestRows(env: Env, limit: number): Promise<number> {
  if (limit <= 0) return 0;
  try {
    const res = await env.DB.prepare(
      `UPDATE lookalike_domains
       SET check_due_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id IN (
         SELECT id FROM lookalike_domains
          WHERE check_due_at IS NULL
            AND last_check_failed_at <= datetime('now', ?)
          ORDER BY last_check_failed_at ASC
          LIMIT ?
       )`,
    ).bind(LOOKALIKE_UNPARK_MIN_AGE_MODIFIER, limit).run();
    const unparked = res.meta.changes ?? 0;
    if (unparked > 0) {
      logger.info('lookalike_check_unparked', {
        rows: unparked,
        min_age: LOOKALIKE_UNPARK_MIN_AGE_MODIFIER,
      });
    }
    return unparked;
  } catch (err) {
    logger.error('lookalike_unpark_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Advance the failure state: the historical record, the attempt counter,
 * and the next due time — which is NULL when the ladder says to park.
 *
 * ── ONE DERIVATION OF `check_attempts`, NOT TWO ─────────────────────
 *
 * `check_attempts` is BOUND, not `check_attempts + 1`. The increment
 * used to be computed twice: `applyCheckBackoff` derived `attempts` from
 * the SELECT SNAPSHOT to pick the ladder step, while this statement
 * derived it again from the LIVE column. Those agree only if nothing
 * wrote the column in between — and `persistCheckFacts` sets
 * `check_attempts = 0` and runs BEFORE the BIMI lane, the compositor,
 * the page fetch, `createAlert` and `recordTakedownDown`, i.e.
 * before every throw the per-row catch exists to absorb.
 *
 * So for any throw past that point the two derivations diverged and the
 * row reached a FIXED POINT it could never leave:
 *
 *   tick 1  snapshot 0 -> step +60m  -> persist resets to 0 -> write 1
 *   tick 2  snapshot 1 -> step +240m -> persist resets to 0 -> write 1
 *   tick 3  snapshot 1 -> step +240m -> persist resets to 0 -> write 1
 *
 * `isTerminalAttempt(ladder, 2)` is false, so the row NEVER parked. It
 * was re-selected roughly six times a day forever, permanently at the
 * head of its cohort because +240m beats every healthy row's +24h —
 * twenty such rows consume the entire 20-slot re-check floor — and
 * `row_errors` stayed non-zero on every run, pinning the agent
 * diagnostic at `severity: "high"` with no resolution path.
 *
 * Binding the value the caller already computed removes the second
 * derivation rather than trying to keep two in step. The cost is that a
 * genuinely concurrent failure on the same row can lose an increment
 * (last writer wins) instead of double-counting it, which is the right
 * direction for a ladder whose terminal step gives up.
 *
 * `last_checked` is deliberately NOT written: it means "when did we last
 * SUCCESSFULLY observe" and a failed attempt is not an observation.
 * Before migration 0269 that restraint was load-bearing for a second
 * reason (writing it would have reclassified the row's cohort); it is
 * now simply correct, because dueness lives in its own column and the
 * cohort in another.
 *
 * `check_due_at = NULL` is the TERMINAL PARK. Both cohort indexes are
 * partial on `check_due_at IS NOT NULL`, so a parked row holds no index
 * entry at all and costs zero reads — rather than being merely
 * deprioritized, which is what left a dead-resolver row re-admitted
 * every 24 h forever.
 *
 * Extracted because it has THREE callers (the unresolved-DNS branch, the
 * per-row error isolation, and nothing else may invent a fourth), and
 * this file holds exactly ONE copy of the statement:
 * `test/lookalike-sql-statements.test.ts` extracts it from source by
 * marker and asserts a single match, so a second identical literal would
 * fail extraction rather than silently drift.
 */
function stampCheckFailure(
  env: Env,
  id: string,
  attempts: number,
  nextDueAt: string | null,
) {
  return env.DB.prepare(
    `UPDATE lookalike_domains
     SET last_check_failed_at = datetime('now'),
         check_attempts = ?,
         check_due_at = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(attempts, nextDueAt, id).run();
}

/**
 * Apply the backoff ladder to a row that just failed, and report whether
 * it was parked. Never throws — a cooldown-stamp failure must not
 * re-raise into `Promise.all` and undo the per-row isolation. It IS
 * counted, though: an un-stamped row is re-selected on the very next
 * tick, which is the hot loop the isolation exists to prevent.
 */
async function applyCheckBackoff(
  env: Env,
  row: Pick<LookalikeCheckRow, 'id' | 'domain' | 'check_attempts'>,
  counters: LookalikeCheckSummary,
): Promise<{ parked: boolean }> {
  const attempts = (row.check_attempts ?? 0) + 1;
  const nextDueAt = computeBackoffRetryAt(LOOKALIKE_CHECK_LADDER, attempts);
  try {
    await stampCheckFailure(env, row.id, attempts, nextDueAt);
  } catch (err) {
    counters.cooldown_stamp_failures += 1;
    logger.error('lookalike_check_cooldown_stamp_failed', {
      lookalike_id: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { parked: false };
  }
  if (nextDueAt === null) {
    logger.warn('lookalike_check_parked', {
      domain: row.domain,
      lookalike_id: row.id,
      attempts,
      terminal_after: LOOKALIKE_CHECK_LADDER.terminalAfterAttempts,
    });
  }
  return { parked: nextDueAt === null };
}

/**
 * Brand context for an alert. Shared by the compositor and the BEC lane
 * so the two cannot drift, and so the file holds ONE `FROM brands`
 * literal.
 */
function loadBrandContext(env: Env, brandId: string) {
  // R7 (2026-05-07): brand_profiles retired. Pull brand context straight
  // from `brands`. user_id-as-owner is dead; alerts attribute to
  // 'system' (read-side scoping is via brand_id -> org_brands).
  return env.DB.prepare(
    `SELECT name AS brand_name, canonical_domain AS domain
     FROM brands
     WHERE id = ?`,
  ).bind(brandId).first<{ brand_name: string; domain: string }>();
}

/**
 * The fixed-HIGH `typosquat_bimi` alert — "this squat has published a
 * BIMI record", which this file's own comments call the single most
 * damning email signal it can find.
 *
 * NOT subject to `LOOKALIKE_ALERT_SEVERITY_FLOOR` — that floor is scoped
 * to `lookalike_domain_active`, and this is a different finding already
 * at HIGH by construction.
 */
async function fileBimiAlert(
  env: Env,
  row: Pick<LookalikeCheckRow, 'id' | 'brand_id' | 'domain' | 'permutation_type' | 'unicode_domain'>,
  brandDomain: string,
): Promise<void> {
  const displayDomain = row.unicode_domain ?? row.domain;
  await createAlert(env.DB, {
    brandId: row.brand_id,
    userId: 'system',
    alertType: 'typosquat_bimi',
    severity: 'HIGH',
    title: `Lookalike domain has BIMI record: ${displayDomain}`,
    summary: `The lookalike domain ${displayDomain} has published a BIMI ` +
      `record, suggesting it is attempting to display a trusted logo in email clients. ` +
      `This indicates a sophisticated phishing operation.`,
    details: {
      domain: row.domain,
      brand_domain: brandDomain,
      permutation_type: row.permutation_type,
    },
    sourceType: 'lookalike_scanner',
    sourceId: row.id,
  }, { env });
}

/**
 * ── THE RECURRING BEC LANE ──────────────────────────────────────────
 *
 * Eligibility is `registered = 1 AND has_mx = 1 AND bimi_first_seen_at
 * IS NULL`, evaluated on EVERY due check of the row rather than once at
 * first contact. The cadence is therefore the checker's own
 * (`check_due_at`) and the lane needs no third selection query.
 *
 * ── WHAT THAT CADENCE ACTUALLY IS ───────────────────────────────────
 *
 * NOT 24 h. `CHECK_CADENCE_MODIFIER` is what a row's NEXT due time is
 * set to after a successful observation, which is a different quantity
 * from how often a row is actually reached: that is the population
 * divided by the throughput. At the post-seed target of ~56,040 rows
 * against 50 rows/tick x 24 ticks = 1,200 checks/day, a given row —
 * and therefore its BIMI lookup — comes round roughly every 47 DAYS.
 * The 24 h cadence is reached only once the drain is small relative to
 * throughput, which at `LOOKALIKE_BATCH_LIMIT = 50` it is not.
 *
 * That is still a strict improvement on "once per row, ever", which is
 * what the lane was before, and it is the honest number to size
 * `BIMI_LOOKUPS_PER_RUN` and any future standalone lane against.
 *
 * ── WHY NOT A STANDALONE LANE (the real objection) ──────────────────
 *
 * A dedicated BEC SELECT over `registered = 1 AND has_mx = 1 AND
 * bimi_first_seen_at IS NULL` would reach the eligible set far faster
 * than 47 days, and it was rejected — but not for want of an ordering
 * column. `check_due_at` exists and would order it fine. The objection
 * is that `check_due_at` only ADVANCES when the DNS lane selects the
 * row, so a standalone query ordered by it re-serves the SAME top rows
 * every tick: a row it looked at and found no BIMI record on writes
 * nothing (presence-only — see below), so it stays at the head of the
 * order forever and the rest of the set is never reached. A standalone
 * lane therefore needs its OWN cooldown column, which is the cost, not
 * the ordering.
 *
 * Before this, the BIMI check was reachable exactly once — on first
 * contact, through the mail-only baseline branch or the full-assessment
 * tail — so a squat that published a BIMI record a month after we
 * baselined it was invisible forever. That is the BEC-precursor shape
 * (mail, no web) that `analyzeLookalikePages` cannot see either, since
 * it requires `has_web = 1`.
 *
 * ── IDEMPOTENCY IS CLAIM-THEN-ACT ───────────────────────────────────
 *
 * 1. The per-run CAP is checked FIRST, before anything is claimed. A row
 *    that burned its claim and then hit the cap would be permanently
 *    retired from the lane without ever filing its alert.
 * 2. The lookup runs. A `false` answer writes NOTHING — `checkBIMIExists`
 *    catches its own errors and returns `false`, so absence and
 *    lookup-failure are the same value here and recording either would
 *    be recording "we could not tell" as "there is none" (migration
 *    0268's defect, in a new column).
 * 3. A `true` answer CLAIMS the row: `UPDATE ... WHERE id = ? AND
 *    bimi_first_seen_at IS NULL`. Exactly one writer can see
 *    `changes === 1`, and only that writer files.
 * 4. If the alert does not get filed FOR ANY REASON, the claim is
 *    RELEASED so the finding is not lost. "Any reason" is load-bearing:
 *    the release used to live only in the `catch`, and a MISSING BRAND
 *    ROW took neither path — `loadBrandContext` returning null simply
 *    skipped the `if (brand)` body, nothing threw, and the row was left
 *    permanently marked BIMI-recorded with no alert in existence, which
 *    the lane's own `bimi_first_seen_at IS NULL` eligibility then never
 *    offers again. The release is itself guarded (a failed release must
 *    not re-raise) and COUNTED, because a swallowed release failure is
 *    the one remaining path in this file to a silently and permanently
 *    lost finding.
 *
 * The alert id is NOT written to `alert_id`:
 * `raiseUnalertedPhishingPageAlert` keys on `alert_id IS NULL`, so a
 * `typosquat_bimi` id there would permanently suppress that row's
 * phishing-page alert. It stays discoverable via
 * `alerts.source_type = 'lookalike_scanner' AND source_id = <row id> AND
 * alert_type = 'typosquat_bimi'`.
 *
 * Returns whether this row is KNOWN to publish BIMI (newly observed, or
 * already recorded) so the compositor can apply its MEDIUM boost without
 * a second lookup.
 */
async function probeAndFileBimi(
  env: Env,
  row: LookalikeCheckRow,
  budgets: RunBudgets,
  counters: LookalikeCheckSummary,
): Promise<{ bimiKnown: boolean }> {
  // Already recorded — nothing to look up, and the boost still applies.
  if (row.bimi_first_seen_at !== null) return { bimiKnown: true };

  if (budgets.bimi.remaining <= 0) {
    counters.bimi_cap_hit = true;
    logger.info('lookalike_bimi_cap_hit', {
      domain: row.domain,
      lookalike_id: row.id,
      cap: budgets.bimi.cap,
    });
    return { bimiKnown: false };
  }
  budgets.bimi.remaining -= 1;
  counters.bimi_lookups += 1;

  let present = false;
  try {
    present = await checkBIMIExists(row.domain);
  } catch (err) {
    // Non-blocking: a BIMI lookup failure must never cost the row its
    // DNS observation. And nothing is recorded, so the row stays
    // eligible on its next pass.
    logger.error('lookalike_bimi_lookup_error', {
      domain: row.domain,
      error: err instanceof Error ? err.message : String(err),
    });
    return { bimiKnown: false };
  }
  if (!present) return { bimiKnown: false };

  const claim = await env.DB.prepare(
    `UPDATE lookalike_domains
     SET bimi_first_seen_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ? AND bimi_first_seen_at IS NULL`,
  ).bind(row.id).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    // Someone else recorded it between our read and here. The fact is
    // true and the alert is theirs to file.
    return { bimiKnown: true };
  }

  try {
    const brand = await loadBrandContext(env, row.brand_id);
    if (!brand) {
      // NOT a silent skip. The claim is already taken, so returning here
      // without releasing it is exactly the permanent-loss shape the
      // claim-then-act protocol exists to avoid.
      counters.bimi_alert_errors += 1;
      logger.error('lookalike_bimi_alert_error', {
        domain: row.domain,
        lookalike_id: row.id,
        error: 'brand_context_missing',
      });
      await releaseBimiClaim(env, row.id, counters);
      return { bimiKnown: false };
    }
    await fileBimiAlert(env, row, brand.domain);
    counters.bimi_alerts += 1;
  } catch (err) {
    counters.bimi_alert_errors += 1;
    logger.error('lookalike_bimi_alert_error', {
      domain: row.domain,
      lookalike_id: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    await releaseBimiClaim(env, row.id, counters);
    // No alert was filed, so nothing above may assert BIMI on this row
    // — the compositor's boost would otherwise raise it to HIGH with no
    // finding behind the level. The claim is released, so the next pass
    // re-probes and files.
    return { bimiKnown: false };
  }
  return { bimiKnown: true };
}

/**
 * Give back the BEC lane's claim so the finding is retried.
 *
 * Extracted because there are now TWO non-filing paths (a thrown
 * `createAlert` and a missing brand row) and this file holds exactly ONE
 * copy of the statement — `test/lookalike-sql-statements.test.ts`
 * extracts it by marker and asserts a single match, so a second literal
 * would fail extraction rather than silently drift.
 *
 * Never throws. A failed release is COUNTED rather than only logged:
 * the row is then marked BIMI-recorded with no alert anywhere and the
 * lane will never offer it again, which is the only remaining
 * silent-permanent-loss path in this file.
 */
async function releaseBimiClaim(
  env: Env,
  id: string,
  counters: LookalikeCheckSummary,
): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE lookalike_domains SET bimi_first_seen_at = NULL WHERE id = ?`,
    ).bind(id).run();
  } catch (releaseErr) {
    counters.bimi_claim_release_failures += 1;
    logger.error('lookalike_bimi_claim_release_failed', {
      lookalike_id: id,
      error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
    });
  }
}

// ─── Transition classification ───────────────────────────────────

/** What a single check observed, relative to what was already stored. */
export type LookalikeTransition =
  | 'first_contact'
  | 'registration_gained'
  | 'registration_lost'
  | 'mx_gained'
  | 'web_gained'
  | 'mx_lost'
  | 'web_lost'
  | 'none';

export interface LookalikeStoredState {
  baselineEstablished: boolean;
  registered: boolean;
  hasMx: boolean;
  hasWeb: boolean;
}

export interface LookalikeObservedState {
  registered: boolean;
  hasMx: boolean;
  hasWeb: boolean;
}

/**
 * Classify what this check observed. PURE — no env, no clock.
 *
 * ── The one precondition the caller owes this function ──────────────
 *
 * `observed` must be the EFFECTIVE state: for any probe that did not
 * ANSWER, the caller substitutes the STORED value. `lib/domain-checker.ts`
 * returns per-probe answer flags precisely so that a timeout is
 * distinguishable from a finding, and the per-check UPDATE already
 * refuses to overwrite a column whose probe did not answer. Passing the
 * raw `hasMx: false` from an MX timeout would mint an `mx_lost`
 * transition from a three-second blip — which is migration 0268's defect
 * generalised from `registered` to every column.
 *
 * ── Why first contact short-circuits ────────────────────────────────
 *
 * On a never-baselined row the stored `registered` / `has_mx` /
 * `has_web` are the seeder's INSERT DEFAULTS (all 0), not observations.
 * Every comparison against them is therefore meaningless, and reading
 * them as "it was absent and now it is present" is exactly the false
 * 0 -> 1 registration migration 0267 exists to prevent.
 *
 * ── Why a 0 -> 1 registration subsumes mx/web ───────────────────────
 *
 * A domain that did not resolve had no MX and no web server by
 * definition, so "it gained MX" is not a separate finding on the pass
 * that saw it appear — it is part of the appearance. Reporting both
 * would double-count, and the mx/web lanes exist specifically for a row
 * that was ALREADY registered when the new capability showed up.
 */
export function classifyLookalikeTransitions(
  stored: LookalikeStoredState,
  observed: LookalikeObservedState,
): LookalikeTransition[] {
  if (!stored.baselineEstablished) return ['first_contact'];
  if (!stored.registered && observed.registered) return ['registration_gained'];
  if (stored.registered && !observed.registered) return ['registration_lost'];

  const out: LookalikeTransition[] = [];
  if (stored.registered && observed.registered) {
    if (!stored.hasMx && observed.hasMx) out.push('mx_gained');
    if (!stored.hasWeb && observed.hasWeb) out.push('web_gained');
    if (stored.hasMx && !observed.hasMx) out.push('mx_lost');
    if (stored.hasWeb && !observed.hasWeb) out.push('web_lost');
  }
  return out.length > 0 ? out : ['none'];
}

// ─── Generate & Store ────────────────────────────────────────────

/**
 * Generate domain permutations for a brand and store them in the
 * lookalike_domains table. Uses INSERT OR IGNORE to avoid duplicates.
 * Returns the count of newly inserted permutations.
 *
 * `check_due_at = datetime('now')` makes a new candidate due
 * IMMEDIATELY. That is the only scheduling statement in the seeder, and
 * it replaces the old arrangement where "due" was the ABSENCE of a
 * value (`last_checked IS NULL`) — a default that doubled as the
 * first-contact discriminator and so could not be set without lying
 * about the other.
 */
export async function generateAndStoreLookalikes(
  env: Env,
  brandId: string,
  domain: string,
): Promise<number> {
  const permutations = generatePermutations(domain);
  if (permutations.length === 0) return 0;

  let inserted = 0;

  // Batch insert in groups of 10 to stay within D1 limits
  const BATCH = 10;
  for (let i = 0; i < permutations.length; i += BATCH) {
    const batch = permutations.slice(i, i + BATCH);
    const stmts = batch.map((perm) => {
      const id = crypto.randomUUID();
      return env.DB.prepare(
        `INSERT OR IGNORE INTO lookalike_domains
           (id, brand_id, domain, permutation_type, unicode_domain, check_due_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      ).bind(id, brandId, perm.domain, perm.type, perm.display ?? null);
    });

    const results = await env.DB.batch(stmts);
    for (const r of results) {
      if ((r.meta.changes ?? 0) > 0) inserted++;
    }
  }

  logger.info('lookalike_generate', {
    brand_id: brandId,
    domain,
    total_permutations: permutations.length,
    new_stored: inserted,
  });

  return inserted;
}

/**
 * Seed lookalike candidates for platform-monitored brands that don't
 * have any yet. Without this, generateAndStoreLookalikes only ran via the
 * on-demand API handler, so the cron checker had an empty candidate pool
 * for nearly every brand and produced no findings.
 *
 * Generation is cheap (permutation inserts only — DNS happens later in
 * the throttled checker), so we seed up to `brandLimit` un-seeded brands
 * per tick. Returns brands + candidates seeded.
 *
 * The population is `MONITORED_BRAND_PREDICATE_SQL`, NOT `org_brands` —
 * see that constant for why, and for the throughput ceiling that decides
 * how far it may widen. The function name is kept for its call site in
 * agents/lookalike-scanner.ts; "OrgBrands" now overstates its scope.
 */
export async function seedLookalikesForOrgBrands(
  env: Env,
  brandLimit = 10,
): Promise<{ brands_seeded: number; candidates_created: number }> {
  // NOT EXISTS keeps this one-shot per brand: regenerating identical
  // dnstwist permutations for an already-seeded brand is pure write cost.
  // With the tier predicate this is a self-draining backlog, `brandLimit`
  // brands per hourly run: 1,864 un-seeded brands of the 1,867 admitted,
  // at the default 10/tick = ~187 h ≈ 8 days, producing ~56,010 candidate
  // rows in total. That inflow — ~300 rows/tick against the checker's
  // 50/tick drain — is why `checkLookalikeBatch` budgets its two cohorts
  // separately; see its selection comment.
  const brands = await env.DB.prepare(
    `SELECT DISTINCT b.id AS brand_id, b.canonical_domain AS domain
     FROM brands b
     WHERE b.canonical_domain IS NOT NULL
       AND ${MONITORED_BRAND_PREDICATE_SQL}
       AND NOT EXISTS (SELECT 1 FROM lookalike_domains ld WHERE ld.brand_id = b.id)
     LIMIT ?`,
  ).bind(brandLimit).all<{ brand_id: string; domain: string }>();

  let brandsSeeded = 0;
  let candidatesCreated = 0;
  for (const b of brands.results) {
    const created = await generateAndStoreLookalikes(env, b.brand_id, b.domain);
    candidatesCreated += created;
    brandsSeeded++;
  }

  if (brandsSeeded > 0) {
    logger.info('lookalike_seed_org_brands', { brands_seeded: brandsSeeded, candidates_created: candidatesCreated });
  }

  return { brands_seeded: brandsSeeded, candidates_created: candidatesCreated };
}

// ─── The compositor ─────────────────────────────────────────────

interface RunBudgets {
  bimi: { remaining: number; cap: number };
  page: { remaining: number; cap: number; runStart: number; budgetMs: number };
}

/**
 * The rule-only part of the level composition. PURE — exported so the
 * rule table is unit-testable without the D1/fetch harness.
 *
 * Applied in order, starting from the STORED level; every step only
 * RAISES (the persist is monotonic as well, so nothing here can lower a
 * row):
 *
 *   1. mail AND web (the EFFECTIVE probe state — an unanswered probe
 *      carries the stored value, per `classifyLookalikeTransitions`'
 *      precondition) and below HIGH  ->  HIGH.
 *   2. a BIMI record is known and below HIGH  ->  HIGH.
 *
 * The page verdict (`escalateThreatLevelForPage`) is step 3 and runs in
 * `compositeAndPersist`, because it needs a fetch.
 *
 * ── WHY RULE 1 LIFTS LOW, NOT ONLY MEDIUM ───────────────────────────
 *
 * The mail+web boost used to be MEDIUM-only, which was what let a Haiku
 * LOW veto it. With the AI verdict gone (AI_STRATEGY_2026-10 Phase 1
 * #18, threat-intel approved) a MEDIUM-only boost would be a SILENT MISS:
 * a fresh row's stored level is LOW, so an operational squat — the exact
 * shape first contact alerts on — would never clear the HIGH alert floor.
 * Mail+web is the deterministic statement that the domain is
 * OPERATIONAL, and HIGH is the level the alert asserts.
 */
export function composeRuleLevel(
  storedLevel: PageThreatLevel,
  signals: { hasMx: boolean; hasWeb: boolean; bimiKnown: boolean },
): PageThreatLevel {
  let level = storedLevel;
  if (signals.hasMx && signals.hasWeb && THREAT_LEVEL_RANK[level] < THREAT_LEVEL_RANK.HIGH) {
    level = 'HIGH';
  }
  // ── THE BIMI BOOST ───────────────────────────────────────────────
  // A BIMI-publishing squat used to keep `threat_level = 'LOW'` while
  // this file filed a FIXED-HIGH `typosquat_bimi` alert about it, and
  // `agents/sparrow.ts` gates takedown eligibility on `threat_level IN
  // ('HIGH','CRITICAL')` — so the single most damning email signal this
  // scanner can find could not reach the takedown queue. Filing a HIGH
  // alert IS the assertion that the row is HIGH, so the level follows
  // the alert. RAISES to HIGH, never lowers a CRITICAL.
  if (signals.bimiKnown && THREAT_LEVEL_RANK[level] < THREAT_LEVEL_RANK.HIGH) level = 'HIGH';
  return level;
}

/**
 * Compose a threat level from the row's stored state plus whatever this
 * pass learned, persist it MONOTONICALLY, and optionally alert.
 *
 * ── RULES ONLY — NO MODEL CALL ──────────────────────────────────────
 *
 * The level is `composeRuleLevel` (mail+web, BIMI) followed by the
 * deterministic page verdict. This pass makes NO AI call and writes NO
 * `ai_assessment` (AI_STRATEGY_2026-10 Phase 1 #18). The Haiku verdict
 * it replaced was dead in production for months (every call HTTP 400),
 * and its error path silently lifted the MEDIUM seed to HIGH — so the
 * mail+web rule is what the platform had effectively been running on.
 *
 * ── RE-ENTRANCY: THE STORED LEVEL IS THE BASE ───────────────────────
 *
 * `threat_level` was once seeded fresh at `'MEDIUM'` each pass and
 * written back UNCONDITIONALLY. A row sitting at CRITICAL from a page
 * escalation would be written DOWN to HIGH on any pass where the inline
 * page budget was exhausted — and `agents/sparrow.ts` reads
 * `threat_level` for takedown ELIGIBILITY and PRIORITY, so that silently
 * de-queues a confirmed credential-harvest kit. The base is now the
 * STORED level and the persisted write never lowers it; the comparison
 * is done IN SQL (same shape as `applyEscalation`'s alert bump) so it
 * cannot be lost to a concurrent writer between read and write.
 *
 * ── MEDIUM IS REACHABLE AS A PERSISTED VERDICT ──────────────────────
 *
 * `escalateThreatLevelForPage` escalates from LOW, so a `web_gained`
 * row with no MX and a page score of 30-59 — or a bare anti-bot wall —
 * persists MEDIUM. NOTHING READS MEDIUM: `agents/sparrow.ts`'s takedown
 * eligibility, `handlers/tenantDomainModule.ts`'s per-brand rollups and
 * `agents/trademarkMonitor.ts` all test HIGH/CRITICAL only, and
 * `LOOKALIKE_ALERT_SEVERITY_FLOOR` is HIGH. So a MEDIUM row is a row an
 * analyst can sort and filter and nothing else.
 *
 * ── ALERTS FIRE ON TRANSITIONS, NOT REASSESSMENTS ───────────────────
 *
 * This function is reached only from a TRANSITION (first contact,
 * registration gained, an mx/web gain) or from the one-time `none`-path
 * catch-up for a mail+web row stored below HIGH. A stable row already at
 * HIGH yields `none` and never re-enters, so it cannot re-alert.
 * `allowAlert` is decided per path by the dispatch in `runCheckRows`.
 */
async function compositeAndPersist(
  env: Env,
  row: LookalikeCheckRow,
  observed: LookalikeObservedState & { ip?: string },
  opts: {
    allowAlert: boolean;
    bimiKnown: boolean;
    budgets: RunBudgets;
    counters: LookalikeCheckSummary;
    /**
     * File (and link) the alert BEFORE persisting the level. Used only by
     * the one-shot mail+web catch-up, whose predicate is false once the
     * row is HIGH: persisting first would turn a `createAlert` throw into
     * a permanently lost notification. Every other path keeps level-first
     * so a failed alert never costs the row its level (Sparrow reads it).
     */
    alertFirst?: boolean;
  },
): Promise<void> {
  const { budgets, counters } = opts;
  const brandRow = await loadBrandContext(env, row.brand_id);
  if (!brandRow) return;
  const brand = { ...brandRow, user_id: 'system' };

  const storedLevel = normalizeThreatLevel(row.threat_level);

  // Rules 1 + 2 — see `composeRuleLevel`.
  let level: PageThreatLevel = composeRuleLevel(storedLevel, {
    hasMx: observed.hasMx,
    hasWeb: observed.hasWeb,
    bimiKnown: opts.bimiKnown,
  });

  // Rule 3 — deterministic page-content analysis (D6 / S2.4). Slots the
  // page phishing score into the same compositor: credential harvest ->
  // CRITICAL, score >= 60 -> HIGH, >= 30 or an anti-bot wall -> MEDIUM
  // (monotonic — never downgrades). Lane 3 shadow signals do NOT feed the
  // level: only score / credentialHarvest / the anti-bot-wall flag are
  // passed. Inline only for has_web domains and capped per run; the
  // throttled analyzeLookalikePages pass re-checks the broader registered
  // set and picks up whatever this cap defers. All fetches funnel through
  // the SSRF-safe fetchSuspectPage.
  let pagePhishing: PagePhishingResult | null = null;
  if (
    observed.hasWeb &&
    budgets.page.remaining > 0 &&
    Date.now() - budgets.page.runStart < budgets.page.budgetMs
  ) {
    budgets.page.remaining -= 1;
    try {
      const { phishing } = await runPageAnalysisForDomain(
        env,
        { id: row.id, domain: row.domain, brand_name: brand.brand_name, brand_domain: brand.domain },
        Date.now() + DEFAULT_DEADLINE_MS,
      );
      pagePhishing = phishing;
      if (phishing) {
        // Derive the bare-wall MEDIUM floor flag caller-side from the
        // fired set (T4.1 spec §3) so the escalation fn stays pure.
        level = escalateThreatLevelForPage(level, {
          score: phishing.score,
          credentialHarvest: phishing.credentialHarvest,
          antiBotWall: phishing.signals.includes('anti_bot_wall'),
        });
      }
    } catch (err) {
      // COUNTED: page evidence is silently absent from the alert
      // otherwise. `fetchSuspectPage` returns `{ok: false}` for every
      // ordinary outcome (timeout, SSRF block, non-HTML, oversize), so a
      // throw reaching here is a defect and not crawler noise — which is
      // what makes it worth the agent's severity.
      counters.inline_page_errors += 1;
      logger.error('lookalike_inline_page_error', {
        domain: row.domain,
        lookalike_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The level the row ENDS UP at, which is never below what it already
  // carried. Computed here as well as enforced in SQL below because the
  // alert's severity must be the row's real level, not this pass's
  // candidate.
  const effective: PageThreatLevel =
    THREAT_LEVEL_RANK[level] >= THREAT_LEVEL_RANK[storedLevel] ? level : storedLevel;

  // ── The monotonic persist ─────────────────────────────────────────
  // `threat_level` is raised or RESTATED, never lowered, and the rank
  // comparison is IN SQL so THIS statement cannot lower a level a
  // concurrent writer raised between our SELECT and here.
  //
  // That is a one-way guarantee, NOT a symmetry — this comment used to
  // claim the symmetry and it does not hold. `analyzeLookalikePages`'s
  // `applyEscalation` does its monotonic comparison in JS and then
  // issues a bare `SET threat_level = ?`, so it can still write a stale
  // value over a level this statement just raised. Pre-existing and
  // narrow (the two passes are different crons and a later pass
  // re-escalates), but the asymmetry is real and should not be asserted
  // away.
  //
  // `>=` rather than `>` so an equal level is rewritten
  // rather than skipped, which is a no-op on a real value and is what
  // materializes a level on a row whose `threat_level` is NULL (the 0031
  // DEFAULT is 'LOW', but a NULL would otherwise be unreachable by a LOW
  // verdict and stay NULL forever). `ai_assessment` is never written here.
  const persistLevel = async (): Promise<void> => {
    await env.DB.prepare(
      `UPDATE lookalike_domains
       SET threat_level = CASE
             WHEN ? >= (CASE threat_level
                          WHEN 'CRITICAL' THEN 3
                          WHEN 'HIGH' THEN 2
                          WHEN 'MEDIUM' THEN 1
                          ELSE 0 END)
               THEN ? ELSE threat_level END,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(
      THREAT_LEVEL_RANK[level],
      level,
      row.id,
    ).run();
  };

  const fileAlert = async (): Promise<void> => {
    if (!opts.allowAlert) return;

    // Create alert via alerts pipeline. For IDN homoglyph variants the
    // stored `domain` is punycode (xn--…); surface the human-readable
    // unicode form (`аpple.com`) in the title so alerts aren't hostile.
    const displayDomain = row.unicode_domain ?? row.domain;

    // ── SEVERITY FLOOR ──────────────────────────────────────────────
    // Below HIGH there is no `lookalike_domain_active` row. The level is
    // persisted by `persistLevel` either way, so nothing is lost but the
    // notification. The comparison lives in
    // `lib/lookalike-alert-policy.ts` and is shared with the page-analysis
    // producer; it is NOT restated here.
    //
    // Scoped to this alert type only, and NOT an early return: the BEC
    // lane's `typosquat_bimi` alert is a different finding at a fixed HIGH
    // severity, filed independently above.
    if (!clearsLookalikeAlertFloor(effective)) {
      counters.alerts_withheld_below_floor += 1;
      logger.info('lookalike_alert_withheld_below_floor', {
        domain: row.domain,
        threat_level: effective,
        floor: LOOKALIKE_ALERT_SEVERITY_FLOOR,
      });
      return;
    }

    const alertId = await createAlert(env.DB, {
      brandId: row.brand_id,
      userId: brand.user_id,
      alertType: 'lookalike_domain_active',
      severity: effective,
      title: `Lookalike domain registered: ${displayDomain}`,
      summary: `A domain similar to ${brand.domain} (${row.permutation_type} variant) has been registered and is now active. ${observed.hasWeb ? 'It has a web server.' : ''} ${observed.hasMx ? 'It has MX records configured for email.' : ''}`.trim(),
      details: {
        lookalike_domain: row.domain,
        unicode_domain: row.unicode_domain ?? undefined,
        original_domain: brand.domain,
        permutation_type: row.permutation_type,
        resolves_to: observed.ip,
        has_mx: observed.hasMx,
        has_web: observed.hasWeb,
        // Page-content evidence when the inline analysis ran and scored;
        // spreads to nothing otherwise so alert creation is never
        // regressed by a skipped/failed fetch. Descriptive only — does not
        // influence `severity` above, which is the composited level.
        ...buildPageEvidenceDetails(pagePhishing),
      },
      sourceType: 'lookalike_scanner',
      sourceId: row.id,
      // Historical note from the retired Haiku pass, when one exists.
      aiAssessment: row.ai_assessment ?? undefined,
      aiRecommendations: (['CRITICAL', 'HIGH'] as string[]).includes(effective)
        ? [
            'Investigate the domain for brand impersonation content',
            'Consider filing a UDRP complaint or takedown request',
            'Monitor for phishing emails from this domain',
            'Alert customers if the domain is actively being used for phishing',
          ]
        : [
            'Continue monitoring for content changes',
            'Check periodically for brand impersonation',
          ],
    }, { env });

    // Link the alert back to the lookalike record. Guarded on a non-null
    // id: both the floor above and `createAlert`'s NX2 tier gate can
    // legitimately produce no alert, and `alert_id IS NULL` is precisely
    // the state `analyzeLookalikePages` keys its own alert path on.
    if (alertId) {
      await env.DB.prepare(
        `UPDATE lookalike_domains SET alert_id = ? WHERE id = ?`,
      ).bind(alertId, row.id).run();
    }
  };

  if (opts.alertFirst) {
    // A throw from `fileAlert` leaves the level unwritten, so the caller's
    // predicate still holds and the next pass retries. A throw from
    // `persistLevel` AFTER a linked alert leaves `alert_id` set, so the
    // retry persists the level without alerting again.
    await fileAlert();
    await persistLevel();
  } else {
    await persistLevel();
    await fileAlert();
  }
}

/**
 * Record that a linked takedown's target has gone away.
 *
 * Reuses Sparrow's Phase F contract verbatim (`verification_status` +
 * `last_verified_at` on `takedown_requests`) rather than inventing a
 * second vocabulary for the same fact: Sparrow verifies taken-down
 * domains on a 7-day cadence with its own `checkDomain` call, and this
 * is the same observation arriving from the lookalike lane, often
 * sooner. Scoped to `status = 'taken_down'` because that is the only
 * status `verification_status` describes — a submitted-but-unconfirmed
 * takedown's lifecycle stays Sparrow's to advance.
 */
async function recordTakedownDown(env: Env, takedownId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE takedown_requests
     SET verification_status = 'down',
         last_verified_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ? AND status = 'taken_down'`,
  ).bind(takedownId).run();
  return (res.meta.changes ?? 0) > 0;
}

// ─── The shared row processor ────────────────────────────────────

/**
 * Check a set of already-selected rows. The two public entry points
 * differ ONLY in how they select and how much budget they grant.
 *
 * ── FIRST CONTACT IS NOT A REGISTRATION EVENT ───────────────────────
 *
 * `registered = 0` is the seeder's INSERT default, so the column
 * conflates two facts that are not the same:
 *
 *   "we checked, and it was not registered"   — a real observation
 *   "we have never looked"                    — no observation at all
 *
 * `baseline_established_at IS NULL` is what distinguishes them
 * (migration 0267, amended). On a row we have never checked, a squat
 * registered in 2019 reads as a fresh registration the first time we
 * resolve it — and the monitored-brand seeder hands this function
 * ~56,010 such rows, 10-35% of which resolve. That is 5,600-19,600
 * permanent, un-triageable alerts against a queue with 8,941 already
 * unworked (see `lib/lookalike-alert-policy.ts` for the arithmetic).
 *
 * So the two cases get two paths. FIRST CONTACT is BASELINE
 * ESTABLISHMENT: it records everything and alerts only when a real
 * signal is present. With no signal it files
 * NO `lookalike_domain_active` alert.
 */
async function runCheckRows(
  env: Env,
  selected: LookalikeCheckRow[],
  limits: CheckRunLimits,
): Promise<LookalikeCheckSummary> {
  const counters = emptySummary();

  // Shared per-run budgets. JS is single-threaded between awaits, so the
  // synchronous decrement taken before each await is race-free even
  // under the concurrency below.
  const budgets: RunBudgets = {
    bimi: { remaining: limits.bimiLookups, cap: limits.bimiLookups },
    page: {
      remaining: limits.inlinePageFetches,
      cap: limits.inlinePageFetches,
      runStart: Date.now(),
      budgetMs: limits.pageBudgetMs,
    },
  };

  // Process in batches of 5 concurrent checks
  const CONCURRENCY = 5;
  for (let i = 0; i < selected.length; i += CONCURRENCY) {
    const batch = selected.slice(i, i + CONCURRENCY);
    const checks = batch.map(async (row) => {
      // ── PER-ROW ERROR ISOLATION (F8) ────────────────────────────
      //
      // Everything below runs inside a try. It did not, and one throw
      // rejected `Promise.all(checks)` and took the WHOLE TICK down:
      // every remaining row went unprocessed AND unstamped, so the next
      // tick re-selected the same set and hit the same bad row again.
      // Harmless at 120 rows; at 56,010 a single poisoned row is a
      // permanent tick killer.
      //
      // The catch does three things, in this order of importance: the
      // failure is VISIBLE, the row is BACKED OFF so it is not
      // re-selected immediately, and the batch CONTINUES.
      try {
        counters.checked += 1;

        const firstContact = row.baseline_established_at === null;
        const result = await checkDomain(row.domain);

        // ── THE CHECK FAILED — NOT "nothing found" ────────────────
        //
        // `checkDomain` returns `registered: false` for a 3s DNS timeout
        // exactly as it does for a clean NXDOMAIN. Writing that value
        // over a stored `registered = 1` manufactures a lapse, and the
        // next successful check then reads as a 0 -> 1 registration: a
        // false `first_seen` and a permanent
        // un-triageable alert, from a transient resolver blip.
        //
        // So an unresolved check writes NO registration state at all.
        // Only the failure record and the backoff advance.
        if (!result.resolved) {
          counters.checks_unresolved += 1;
          const { parked } = await applyCheckBackoff(env, row, counters);
          if (parked) counters.rows_parked += 1;
          logger.info('lookalike_check_unresolved', {
            domain: row.domain,
            first_contact: firstContact,
            stored_registered: row.registered,
            attempts: (row.check_attempts ?? 0) + 1,
            parked,
          });
          return;
        }

        await persistCheckFacts(env, row.id, result, firstContact);

        // ── THE EFFECTIVE OBSERVED STATE ──────────────────────────
        //
        // For every probe that did NOT answer, substitute the stored
        // value — exactly what the UPDATE above just did to the
        // columns. This is what makes a three-second MX timeout
        // incapable of minting an `mx_lost` transition, and it is the
        // precondition `classifyLookalikeTransitions` documents.
        const observed: LookalikeObservedState & { ip?: string } = {
          registered: result.registered,
          hasMx: result.mxAnswered ? result.hasMx : row.has_mx === 1,
          hasWeb: result.webAnswered ? result.hasWeb : row.has_web === 1,
          ip: result.aAnswered ? result.ip : undefined,
        };

        // The mail+web share, measured per run.
        if (observed.registered) {
          counters.observed_registered += 1;
          if (observed.hasMx && observed.hasWeb) counters.observed_mail_and_web += 1;
          else if (observed.hasMx) counters.observed_mx_only += 1;
          else if (observed.hasWeb) counters.observed_web_only += 1;
        }

        const transitions = classifyLookalikeTransitions(
          {
            baselineEstablished: !firstContact,
            registered: row.registered === 1,
            hasMx: row.has_mx === 1,
            hasWeb: row.has_web === 1,
          },
          observed,
        );

        // ── THE RECURRING BEC LANE ────────────────────────────────
        // Runs on EVERY due check of a registered + MX row, before the
        // compositor so its MEDIUM boost can use the answer without a
        // second lookup. Independent of which transition fired: a BIMI
        // record published months after baseline is a finding whether
        // or not anything else changed this pass.
        let bimiKnown = row.bimi_first_seen_at !== null;
        if (observed.registered && observed.hasMx) {
          ({ bimiKnown } = await probeAndFileBimi(env, row, budgets, counters));
        }

        // ── TRANSITION DISPATCH ───────────────────────────────────
        if (transitions.includes('first_contact')) {
          if (!observed.registered) {
            // Baseline established, nothing resolved. The column records
            // OUR coverage, not the domain's status, which is why it is
            // stamped in the per-check UPDATE rather than here.
            return;
          }
          // ── BASELINE ESTABLISHMENT ──────────────────────────────
          // We learned nothing about WHEN this domain was registered,
          // only that it is registered now. `first_seen` is deliberately
          // NOT stamped (migration 0267): claiming today as the
          // appearance date of a squat that may be years old is worse
          // than leaving it NULL, because downstream "new registrations
          // this week" readings would then measure our own crawl
          // schedule.
          counters.baselines_established += 1;

          if (!(observed.hasMx && observed.hasWeb)) {
            // NO `lookalike_domain_active` ALERT. At a 10-35% resolve
            // rate over the seeder backlog this early return is the
            // difference between thousands of permanent alerts and
            // zero. The BEC lane above already ran, so a mail-only
            // baseline with a BIMI record is NOT silent.
            counters.baselines_suppressed += 1;
            logger.info('lookalike_baseline_no_signal', {
              domain: row.domain,
              has_mx: observed.hasMx,
              has_web: observed.hasWeb,
            });
            return;
          }
          await compositeAndPersist(env, row, observed, {
            allowAlert: true, bimiKnown, budgets, counters,
          });
          return;
        }

        if (transitions.includes('registration_gained')) {
          // ── OBSERVED TRANSITION ────────────────────────────────
          // We checked this row before and it did not resolve; now it
          // does. The domain genuinely appeared while we were watching,
          // so `first_seen` means what it says.
          //
          // ── NO `alert_id` GUARD HERE, DELIBERATELY ─────────────
          //
          // `allowAlert: true` is unconditional, unlike the mx/web path
          // below which bounds itself on `row.alert_id === null`. So a
          // domain that cycles registered -> lapsed -> re-registered
          // files one alert PER CYCLE and `alert_id` ends up pointing at
          // the most recent one.
          //
          // That is the intended behaviour, not an oversight: a
          // re-registration after a lapse is a genuinely new event —
          // typically a NEW registrant, which is the thing this platform
          // exists to notice — and suppressing it would make the second
          // appearance of a squat invisible forever. The cost is bounded
          // by how often a domain can actually lapse and be re-taken.
          //
          // What it means is that "one alert per row per lifetime" is
          // true of the MX/WEB path, not of the row. No comment in this
          // file should claim otherwise. Pinned by a lapse ->
          // re-registration test in `test/lookalike-review-fixes.test.ts`.
          counters.new_registrations += 1;
          await env.DB.prepare(
            `UPDATE lookalike_domains
             SET first_seen = datetime('now')
             WHERE id = ? AND first_seen IS NULL`,
          ).bind(row.id).run();
          await compositeAndPersist(env, row, observed, {
            allowAlert: true, bimiKnown, budgets, counters,
          });
          return;
        }

        if (transitions.includes('registration_lost')) {
          // An ANSWERED 1 -> 0. Persisted by the UPDATE above;
          // `threat_level` is deliberately NOT downgraded — a squat that
          // lapsed is still evidence of who targeted this brand, and
          // `agents/sparrow.ts` reads that level for takedown priority.
          counters.registrations_lost += 1;
          if (row.takedown_id) {
            if (await recordTakedownDown(env, row.takedown_id)) {
              counters.takedowns_verified_down += 1;
            }
          }
          logger.info('lookalike_registration_lost', {
            domain: row.domain,
            takedown_id: row.takedown_id,
          });
          return;
        }

        const mxGained = transitions.includes('mx_gained');
        const webGained = transitions.includes('web_gained');
        if (mxGained || webGained) {
          if (mxGained) counters.mx_gained += 1;
          if (webGained) counters.web_gained += 1;
          // ── MX-ALONE AND WEB-ALONE FILE NO ALERT ────────────────
          //
          // MX alone is a registrar default and web alone is a parking
          // lander, so at this population a per-appearance alert is a
          // queue-destroying event. Their value is RE-OPENING the
          // compositor (which was reachable once per row before this
          // change) and the BEC lane above; a `web_gained` row also
          // becomes `analyzeLookalikePages`-eligible automatically,
          // since that pass selects on `has_web = 1`.
          //
          // ONE EXCEPTION, and it is a deliberate departure from a
          // strict "no alert on either" reading: when the gain COMPLETES
          // the mail+web pair, the row is no longer "MX alone" or "web
          // alone" — it is exactly the operational shape first contact
          // alerts on, arriving a pass later. Withholding there would
          // mean a row first seen as web-only could reach mail+web, be
          // composited to HIGH, and never notify anybody, which is the
          // detection hole this whole change is named for. Bounded three
          // ways: the pair must be complete, the row must carry NO alert
          // yet (so at most one ever comes from this path), and the
          // composed level must still clear the HIGH floor.
          const completesPair = observed.hasMx && observed.hasWeb;
          await compositeAndPersist(env, row, observed, {
            allowAlert: completesPair && row.alert_id === null,
            bimiKnown, budgets, counters,
          });
          return;
        }

        if (transitions.includes('mx_lost') || transitions.includes('web_lost')) {
          // Persisted by the UPDATE above and nothing else. An answered
          // negative is a real observation and worth recording; it is
          // not worth a notification.
          counters.mail_or_web_lost += 1;
          return;
        }

        // 'none' — including a `resolves_to` change, which the UPDATE
        // above has already persisted. Recorded, never a trigger: a
        // squat moving between hosts is NEXUS's input, not an alert.
        //
        // ── ONE-TIME CATCH-UP: mail+web stored below HIGH ─────────
        //
        // The rule table (`composeRuleLevel`) lifts an operational
        // (mail+web) row to HIGH, but rows a retired Haiku verdict held
        // at LOW/MEDIUM never re-enter the compositor through a
        // transition. Re-composite them once here. Sized in prod at 90
        // rows (84 LOW, 6 MEDIUM).
        //
        // SCOPED TO EXACTLY THAT POPULATION — three gates, all required:
        //
        //   * `ai_assessment IS NOT NULL` — the row carries a Haiku
        //     verdict, i.e. it is one the retired model held down. A
        //     mail+web row below HIGH WITHOUT one got there some other
        //     way (an analyst, a lapse/re-registration history) and this
        //     catch-up was not written for it.
        //   * `status NOT IN ('benign','taken_down')` (statuses per
        //     migration 0031 / `handlers/lookalikeDomains.ts` PATCH) — an
        //     analyst-downgraded or already-actioned row is NEVER
        //     re-raised. A human decision outranks the rule table.
        //   * stored level below HIGH.
        //
        // SELF-EXTINGUISHING: the compositor raises the row to HIGH and
        // the monotonic persist keeps it there, so on every later pass
        // this predicate is false and an already-HIGH row is never
        // reassessed or re-alerted.
        //
        // ALERT BOUND: the alert is the LEVEL transition (below HIGH ->
        // HIGH), filed only on a row carrying no `lookalike_domain_active`
        // alert yet (`alert_id IS NULL`, the bound the mx/web path uses)
        // AND no BIMI finding (`bimi_first_seen_at IS NULL` at read time,
        // and not just filed by the BEC lane above — `bimiKnown`). A BIMI
        // row already has its fixed-HIGH `typosquat_bimi` alert, so a
        // second alert for the same domain would be a duplicate.
        //
        // ALERT FIRST, THEN LEVEL (`alertFirst`). This path runs once per
        // row: once the level is HIGH the predicate is false forever. If
        // the level persisted first and `createAlert` then threw, the
        // notification would be lost permanently. Alert-first means a
        // throw leaves the row below HIGH, so the next pass (after the
        // row-error backoff) retries the whole catch-up.
        if (
          observed.registered &&
          observed.hasMx &&
          observed.hasWeb &&
          row.ai_assessment !== null &&
          row.status !== 'benign' &&
          row.status !== 'taken_down' &&
          THREAT_LEVEL_RANK[normalizeThreatLevel(row.threat_level)] < THREAT_LEVEL_RANK.HIGH
        ) {
          counters.mail_web_level_lifts += 1;
          await compositeAndPersist(env, row, observed, {
            allowAlert: row.alert_id === null && row.bimi_first_seen_at === null && !bimiKnown,
            alertFirst: true,
            bimiKnown, budgets, counters,
          });
        }
      } catch (err) {
        counters.row_errors += 1;
        logger.error('lookalike_check_row_error', {
          domain: row.domain,
          lookalike_id: row.id,
          first_contact: row.baseline_established_at === null,
          error: err instanceof Error ? err.message : String(err),
        });
        // Same backoff the unresolved-DNS branch uses. A row that threw
        // did not produce a usable observation, so it belongs behind the
        // ladder exactly as a timeout does; without this it would be
        // re-selected on the very next tick and throw again.
        const { parked } = await applyCheckBackoff(env, row, counters);
        if (parked) counters.rows_parked += 1;
      }
    });

    await Promise.all(checks);
  }

  return counters;
}

/**
 * Persist what a SUCCESSFUL check observed.
 *
 * ── AN UNANSWERED PROBE MUST NOT OVERWRITE A KNOWN VALUE ───────────
 *
 * `resolved` is scoped to `registered` and to nothing else, because a
 * SEEN A record short-circuits it. So three of the four facts below can
 * arrive from a probe that learned nothing, and this statement used to
 * write all of them unconditionally:
 *
 *   * web probe timed out -> `hasWeb = false` over a stored `has_web = 1`,
 *     dropping the row out of BOTH page-analysis cohorts.
 *   * A answered, MX timed out -> `hasMx = false` over a stored 1,
 *     erasing the mail evidence that IS the BEC-precursor signal.
 *   * MX answered, A timed out -> `result.ip ?? null` ERASED a known IP,
 *     dropping the row out of the page cohorts again.
 *
 * Each field is gated on its OWN answer flag, bound rather than
 * interpolated, so a field with no answer keeps whatever the last
 * answering probe stored. `registered` stays unconditional: this
 * statement only runs when `resolved` is true, which is exactly the
 * condition that makes `registered` authoritative.
 *
 * `baseline_established_at` carries `AND baseline_established_at IS NULL`
 * so the column is STRUCTURALLY single-write — and since migration 0267's
 * amendment it is also the first-contact DISCRIMINATOR, so that guard is
 * what makes first contact unforgeable by any scheduling operation.
 *
 * `check_due_at` advances by the cadence and `check_attempts` resets: a
 * successful observation supersedes any run of failures, which is also
 * what un-parks a row that got there the hard way.
 * `last_check_failed_at` is cleared for the same reason.
 */
function persistCheckFacts(
  env: Env,
  id: string,
  result: DomainCheckResult,
  firstContact: boolean,
) {
  return env.DB.prepare(
    `UPDATE lookalike_domains
     SET registered = ?,
         resolves_to = CASE WHEN ? = 1 THEN ? ELSE resolves_to END,
         has_mx      = CASE WHEN ? = 1 THEN ? ELSE has_mx END,
         has_web     = CASE WHEN ? = 1 THEN ? ELSE has_web END,
         baseline_established_at = CASE
           WHEN ? = 1 AND baseline_established_at IS NULL
             THEN datetime('now') ELSE baseline_established_at END,
         last_checked = datetime('now'),
         last_check_failed_at = NULL,
         check_attempts = 0,
         check_due_at = datetime('now', ?),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(
    result.registered ? 1 : 0,
    result.aAnswered ? 1 : 0,
    result.ip ?? null,
    result.mxAnswered ? 1 : 0,
    result.hasMx ? 1 : 0,
    result.webAnswered ? 1 : 0,
    result.hasWeb ? 1 : 0,
    firstContact ? 1 : 0,
    CHECK_CADENCE_MODIFIER,
    id,
  ).run();
}

// ─── Batch Check (called by cron) ────────────────────────────────

/** Fold the run's counters into the log line + the returned summary. */
function logCheckSummary(
  event: 'lookalike_check' | 'lookalike_check_brand',
  summary: LookalikeCheckSummary,
  extra: Record<string, string> = {},
): void {
  logger.info(event, {
    ...extra,
    ...summary,
    // The measured mail+web share, which nothing recorded before. Emitted as a percentage so an operator does not have to
    // divide; null below n=1 rather than a fake 0.
    observed_mail_web_pct: summary.observed_registered > 0
      ? Math.round((summary.observed_mail_and_web / summary.observed_registered) * 100)
      : null,
  });
}

/**
 * Check a batch of lookalike domains for registration changes.
 * Called by the cron orchestrator every hour.
 *
 * SELECTION: two cohorts, two budgets. Re-check goes FIRST so its floor
 * is taken from the budget before the large cohort can claim it, then
 * first contact absorbs whatever re-check left, then the spill returns
 * anything first contact could not use. Total is never more than
 * `limits.rows`.
 */
export async function checkLookalikeBatch(
  env: Env,
  limits: CheckRunLimits = CRON_CHECK_LIMITS,
): Promise<LookalikeCheckSummary> {
  // BEFORE selection, so a re-admitted row can be picked up this tick.
  // It is due at `datetime('now')`, i.e. behind every genuinely overdue
  // row, so it takes only slack capacity — see `unparkOldestRows`.
  const unparked = await unparkOldestRows(env, LOOKALIKE_UNPARK_PER_RUN);

  const recheckSlots = Math.max(0, limits.rows - FIRST_CONTACT_SLOTS);
  const recheck = await selectRecheckRows(env, recheckSlots, 0);
  const firstContactBudget = limits.rows - recheck.results.length;
  const firstContacts = await selectFirstContactRows(env, firstContactBudget);

  const spent = recheck.results.length + firstContacts.results.length;
  // Spill back to re-check only when it was SATURATED (so there is
  // plausibly more of it) and the first-contact cohort left room.
  const spill = spent < limits.rows && recheck.results.length === recheckSlots
    ? (await selectRecheckRows(env, limits.rows - spent, recheckSlots)).results
    : [];

  // Merge by id. The two cohorts are disjoint by construction
  // (`IS NULL` vs `IS NOT NULL` on `baseline_established_at`), so this
  // can only ever collapse a re-check row the spill's OFFSET re-served
  // under a `check_due_at` tie — cheap insurance against an unstable tie
  // order, not a correctness crutch.
  const byId = new Map<string, LookalikeCheckRow>();
  for (const r of [...recheck.results, ...spill, ...firstContacts.results]) byId.set(r.id, r);
  const selected = [...byId.values()];

  if (selected.length === 0) {
    const empty = emptySummary();
    empty.rows_unparked = unparked;
    logger.info('lookalike_check', { message: 'no domains to check', rows_unparked: unparked });
    return empty;
  }

  const summary = await runCheckRows(env, selected, limits);
  summary.rows_unparked = unparked;
  summary.selected_first_contact = firstContacts.results.length;
  summary.selected_recheck = recheck.results.length + spill.length;
  logCheckSummary('lookalike_check', summary);
  return summary;
}

/**
 * Check ONE brand's due rows — the operator "Scan now" path.
 *
 * Exists because the handler used to `await checkLookalikeBatch(env)`,
 * the GLOBAL batch, from inside an HTTP request: up to 100 DoH queries,
 * 50 HEAD probes, 50 (since-retired) Haiku calls and 10 page fetches per button press,
 * on rows belonging to brands the caller never asked about, with no rate
 * limit of any kind in front of it. Brand-scoped and small-budgeted
 * (`SCAN_NOW_CHECK_LIMITS`) removes that amplifier; the rest of the
 * brand's enqueued rows are already at the front of the cron queue
 * because the handler stamped them `check_due_at = '1970-01-01
 * 00:00:00'`, bounded at `LOOKALIKE_RESCAN_ENQUEUE_LIMIT`.
 *
 * No un-park sweep here, deliberately: the handler's enqueue already
 * revives this brand's parked rows, and running the GLOBAL sweep from a
 * request path would let a button press re-admit other tenants' rows.
 */
export async function checkLookalikeBatchForBrand(
  env: Env,
  brandId: string,
  limits: CheckRunLimits = SCAN_NOW_CHECK_LIMITS,
): Promise<LookalikeCheckSummary> {
  const due = await selectBrandDueRows(env, brandId, limits.rows);
  if (due.results.length === 0) return emptySummary();

  const summary = await runCheckRows(env, due.results, limits);
  // The cohort counters describe a SPLIT this path does not make, so
  // they stay 0 rather than being fabricated from the mixed set.
  logCheckSummary('lookalike_check_brand', summary, { brand_id: brandId });
  return summary;
}

// checkDomain() moved to lib/domain-checker.ts for shared use with Sparrow Phase F
