/**
 * Lookalike Domain Scanner — Continuous monitoring for brand-impersonating domains.
 *
 * Generates permutations via dnstwist.ts, stores them in D1, and periodically
 * re-checks registration status via Cloudflare DoH. Newly registered domains
 * trigger AI assessment and alert creation.
 */

import { generatePermutations } from '../lib/dnstwist';
import { createAlert } from '../lib/alerts';
import { analyzeWithHaiku } from '../lib/haiku';
import { checkBIMIExists } from '../email-security';
import { checkDomain } from '../lib/domain-checker';
import { logger } from '../lib/logger';
import { DEFAULT_DEADLINE_MS } from '../lib/page-fetch';
import { escalateThreatLevelForPage } from '../lib/page-phishing-scorer';
import type { PagePhishingResult } from '../lib/page-phishing-scorer';
import { runPageAnalysisForDomain } from './lookalike-page-analysis';
import { MONITORED_BRAND_PREDICATE_SQL } from '../lib/monitored-brands';
import {
  buildPageEvidenceDetails,
  clearsLookalikeAlertFloor,
  LOOKALIKE_ALERT_SEVERITY_FLOOR,
} from '../lib/lookalike-alert-policy';
import type { Env } from '../types';

// Inline page-analysis budget for the newly-registered compositor. The
// broader re-check set is handled by analyzeLookalikePages (throttled);
// here we only fetch a bounded number of just-registered has_web domains
// per tick so a backfill surge can't blow the tick's wall-clock budget.
const INLINE_PAGE_FETCH_CAP = 10;
const INLINE_PAGE_BUDGET_MS = 60_000;

// ─── Per-run DNS budget, SPLIT between the two cohorts ────────────
//
// The total is unchanged at 50 rows/tick. What changed is that the two
// populations no longer compete in one `ORDER BY last_checked ASC NULLS
// FIRST` queue, where NULLs sort first UNCONDITIONALLY:
//
//   * FIRST CONTACT (`last_checked IS NULL`) — the seeder backlog.
//     ~56,010 rows, growing by ~300/tick (10 brands x ~30 permutations)
//     while the seeder drains its 1,864-brand stage. One-time.
//   * RE-CHECK (`last_checked < -24 hours`) — everything we have already
//     observed. Small today (the 120 pre-existing rows, all on
//     `customer`-tier brands) and the ONLY path that can produce an
//     observed `registered 0 -> 1` transition, a real `first_seen`, or a
//     lapse/re-registration.
//
// With one query the first cohort starved the second for the whole
// ~187-tick drain: no non-NULL row would have been selected at all, so
// the observed-transition path would have stopped platform-wide and
// every paying customer's rows would have gone unchecked for ~47 days.
//
// RATIO. `RECHECK_SLOTS` is a FLOOR, not a cap — the spill step in
// `checkLookalikeBatch` hands unused slots to whichever cohort can use
// them, in either direction. 20 re-check slots is 480 rows/day, four
// times today's ENTIRE known population, so known rows keep a
// better-than-24h cadence throughout the drain even in the worst case;
// and once the drain finishes and the first-contact cohort empties, the
// spill gives re-check the full 50. 30 first-contact slots is a 720/day
// floor, but in practice the cohort takes ~45/tick (re-check is
// undersupplied and spills to it), so the one-time drain costs ~52 days
// instead of ~47 — a 10% slowdown on a backlog, in exchange for the
// re-check path never stopping. Deliberately NOT a bigger total: see
// `lib/monitored-brands.ts` for why raising the cap without a
// wall-clock guard makes things worse, not better.
const LOOKALIKE_BATCH_LIMIT = 50;
const FIRST_CONTACT_SLOTS = 30;
const RECHECK_SLOTS = LOOKALIKE_BATCH_LIMIT - FIRST_CONTACT_SLOTS;

/** The columns `checkLookalikeBatch` needs per row. */
interface LookalikeCheckRow {
  id: string;
  brand_id: string;
  domain: string;
  permutation_type: string;
  registered: number;
  unicode_domain: string | null;
  last_checked: string | null;
}

/**
 * Never-checked rows. `last_checked IS NULL` is an indexable range on
 * `idx_lookalike_last_checked` (NULLs are the leading keys), so this is
 * a bounded index seek rather than a scan of a table headed for ~56,010
 * rows.
 *
 * NO `ORDER BY`: every row in this cohort has the same (NULL) sort key,
 * so an ordering clause would buy nothing and cost a temp b-tree over
 * the whole cohort. The `last_check_failed_at` term is the F6 failure
 * cooldown (migration 0268) — a row whose resolver keeps timing out must
 * not be re-selected every tick, and its `last_checked` stays NULL
 * because no observation was made.
 */
function selectFirstContactRows(env: Env, limit: number) {
  return env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.permutation_type, ld.registered,
            ld.unicode_domain, ld.last_checked
     FROM lookalike_domains ld
     WHERE ld.last_checked IS NULL
       AND (ld.last_check_failed_at IS NULL
            OR ld.last_check_failed_at < datetime('now', '-24 hours'))
     LIMIT ?`,
  ).bind(limit).all<LookalikeCheckRow>();
}

/**
 * Rows we HAVE observed before, stalest first. `last_checked IS NOT
 * NULL AND last_checked < ?` is a range on the same index and the
 * `ORDER BY` is that index's own order, so there is no sort step.
 *
 * `offset` exists only for the spill step: when the first-contact cohort
 * cannot fill its share (post-drain, or an empty table), the remaining
 * slots come back here rather than going unused.
 */
function selectRecheckRows(env: Env, limit: number, offset: number) {
  return env.DB.prepare(
    `SELECT ld.id, ld.brand_id, ld.domain, ld.permutation_type, ld.registered,
            ld.unicode_domain, ld.last_checked
     FROM lookalike_domains ld
     WHERE ld.last_checked IS NOT NULL
       AND ld.last_checked < datetime('now', '-24 hours')
       AND (ld.last_check_failed_at IS NULL
            OR ld.last_check_failed_at < datetime('now', '-24 hours'))
     ORDER BY ld.last_checked ASC
     LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all<LookalikeCheckRow>();
}

/**
 * Brand context for an alert. Shared by the full-assessment path and the
 * mail-only BIMI path so the two cannot drift, and so the file holds ONE
 * `FROM brands` literal.
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
 * BIMI record", which the scanner's own comments call the single most
 * damning email signal it can find.
 *
 * Extracted because it now has TWO call sites: the full-assessment path
 * and the mail-only first-contact path (B3). It is NOT subject to
 * `LOOKALIKE_ALERT_SEVERITY_FLOOR` — that floor is scoped to
 * `lookalike_domain_active`, and this is a different finding already at
 * HIGH by construction.
 */
async function fileBimiAlert(
  env: Env,
  row: Pick<LookalikeCheckRow, 'id' | 'brand_id' | 'domain' | 'permutation_type' | 'unicode_domain'>,
  brandDomain: string,
  userId: string,
): Promise<void> {
  const displayDomain = row.unicode_domain ?? row.domain;
  await createAlert(env.DB, {
    brandId: row.brand_id,
    userId,
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
  });
}

// `buildPageEvidenceDetails` + `PageEvidenceDetails` moved to
// `lib/lookalike-alert-policy.ts` (imported above): the page-analysis
// pass is now an alert PRODUCER too and needs the same builder, and that
// module already imports from here, so a shared home in lib/ is the only
// arrangement that isn't a cycle. See that module's docstring.

// ─── Generate & Store ────────────────────────────────────────────

/**
 * Generate domain permutations for a brand and store them in the
 * lookalike_domains table. Uses INSERT OR IGNORE to avoid duplicates.
 * Returns the count of newly inserted permutations.
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
        `INSERT OR IGNORE INTO lookalike_domains (id, brand_id, domain, permutation_type, unicode_domain)
         VALUES (?, ?, ?, ?, ?)`,
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
 * on-demand API handler, so the cron checker (checkLookalikeBatch) had an
 * empty candidate pool for nearly every brand and produced no findings.
 *
 * Generation is cheap (permutation inserts only — DNS/AI happens later in
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
  // Combined with the old three-brand org_brands gate that made the seeder
  // a no-op forever once those three were done in March–May; with the tier
  // predicate it becomes a self-draining backlog instead, `brandLimit`
  // brands per hourly run.
  //
  // The numbers here were stale from the intermediate
  // `monitoring_status='active'` staging draft. The predicate is now
  // `tier` ALONE, so the real figures are: 1,864 un-seeded brands of the
  // 1,867 admitted (3 are already seeded), at the default 10/tick =
  // ~187 h ≈ 8 days to work through the whole stage, producing ~56,010
  // candidate rows in total. That inflow — ~300 rows/tick against the
  // checker's 50/tick drain — is why `checkLookalikeBatch` below budgets
  // its two cohorts separately instead of ordering one query
  // `NULLS FIRST`; see its selection comment.
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

// ─── Batch Check (called by cron) ────────────────────────────────

/**
 * Check a batch of lookalike domains for registration changes.
 * Called by the cron orchestrator every hour.
 *
 * 1. Queries domains that haven't been checked in 24 hours (LIMIT 50).
 * 2. For each, checks A record, MX record, and web availability.
 * 3. For newly registered domains, requests AI assessment and creates alerts.
 *
 * ── FIRST CONTACT IS NOT A REGISTRATION EVENT ───────────────────────
 *
 * Step 3's "newly registered" test is `result.registered && row.registered
 * === 0`, and `registered = 0` is the seeder's INSERT default. So the
 * column conflates two facts that are not the same:
 *
 *   "we checked, and it was not registered"   — a real observation
 *   "we have never looked"                    — no observation at all
 *
 * `last_checked IS NULL` is what distinguishes them (the seeder's INSERT
 * doesn't set it), which is why it joins the SELECT below. On a row we
 * have never checked, a squat registered in 2019 reads as a fresh
 * registration the first time we resolve it — and the monitored-brand
 * seeder is about to hand this function ~56,010 such rows (1,867 brands
 * x ~30 permutations; the 10,770 this comment used to cite was the
 * intermediate `monitoring_status`-filtered draft), 10-35% of which
 * resolve. That is 5,600-19,600 permanent, un-triageable alerts
 * against a queue with 8,941 already unworked (see
 * `lib/lookalike-alert-policy.ts` for the queue arithmetic and why none
 * of them can ever be auto-cleared).
 *
 * So the two cases get two paths. A transition WE OBSERVED keeps today's
 * behaviour exactly, modulo the severity floor. FIRST CONTACT is
 * BASELINE ESTABLISHMENT: it records everything (registration, IP, MX,
 * web, and `baseline_established_at`), and alerts only when a real
 * signal is present. With no signal it spends NO Haiku tokens and files
 * NO `lookalike_domain_active` alert — see the `firstContact` branch
 * below, which is the load-bearing cost control of this whole change
 * rather than a nicety.
 *
 * The one signal that IS evaluated on a no-web first contact is BIMI: a
 * single DNS lookup, no AI, and the only producer that can ever see a
 * mail-only squat (`analyzeLookalikePages` requires `has_web = 1`). See
 * the email lane inside that branch.
 */
export async function checkLookalikeBatch(env: Env): Promise<void> {
  // ── SELECTION: two cohorts, two budgets ─────────────────────────
  //
  // `last_checked` is fetched, not just filtered on: it is the ONLY
  // column that can tell a never-looked-at row from an observed-absent
  // one, and the first-contact branch below turns on exactly that
  // distinction.
  //
  // This used to be ONE query ordered `last_checked ASC NULLS FIRST`.
  // NULLs sort first unconditionally, so the seeder's ~300 never-checked
  // rows per tick displaced every already-checked row for the whole
  // ~187-tick drain — the re-check cohort would not have been sampled
  // once. Two queries with independent LIMITs make the split explicit
  // and auditable; see FIRST_CONTACT_SLOTS / RECHECK_SLOTS above for the
  // ratio and why each is a floor rather than a cap.
  //
  // Re-check goes FIRST so its floor is taken from the budget before
  // the large cohort can claim it, then first contact absorbs whatever
  // re-check left, then the spill returns anything first contact could
  // not use. Total is never more than LOOKALIKE_BATCH_LIMIT.
  const recheck = await selectRecheckRows(env, RECHECK_SLOTS, 0);
  const firstContactBudget = LOOKALIKE_BATCH_LIMIT - recheck.results.length;
  const firstContacts = await selectFirstContactRows(env, firstContactBudget);

  const spent = recheck.results.length + firstContacts.results.length;
  // Spill back to re-check only when it was SATURATED (so there is
  // plausibly more of it) and the first-contact cohort left room.
  const spill = spent < LOOKALIKE_BATCH_LIMIT && recheck.results.length === RECHECK_SLOTS
    ? (await selectRecheckRows(env, LOOKALIKE_BATCH_LIMIT - spent, RECHECK_SLOTS)).results
    : [];

  // Merge by id. The two cohorts are disjoint by construction
  // (`IS NULL` vs `IS NOT NULL`), so this can only ever collapse a
  // re-check row the spill's OFFSET re-served under a `last_checked`
  // tie — cheap insurance against an unstable tie order, not a
  // correctness crutch.
  const byId = new Map<string, LookalikeCheckRow>();
  for (const r of [...recheck.results, ...spill, ...firstContacts.results]) byId.set(r.id, r);
  const selected = [...byId.values()];

  if (selected.length === 0) {
    logger.info('lookalike_check', { message: 'no domains to check' });
    return;
  }

  let newRegistrations = 0;
  let baselinesEstablished = 0;
  let baselinesSuppressed = 0;
  let baselineBimiAlerts = 0;
  let alertsWithheldByFloor = 0;
  let checksUnresolved = 0;
  let totalChecked = 0;

  // Shared inline page-fetch budget across the whole tick (JS is single-
  // threaded between awaits, so the synchronous `remaining--` before each
  // fetch is race-free even under the concurrency below).
  const inlinePageBudget = { remaining: INLINE_PAGE_FETCH_CAP, runStart: Date.now() };

  // Process in batches of 5 concurrent checks
  const CONCURRENCY = 5;
  for (let i = 0; i < selected.length; i += CONCURRENCY) {
    const batch = selected.slice(i, i + CONCURRENCY);
    const checks = batch.map(async (row) => {
      totalChecked++;

      // The first-contact test, computed BEFORE the UPDATE below clears
      // the evidence for it (that UPDATE sets `last_checked`, so after it
      // runs the distinction is gone forever for this row).
      const firstContact = row.last_checked === null;

      const result = await checkDomain(row.domain);

      // ── THE CHECK FAILED — NOT "nothing found" ────────────────────
      //
      // `checkDomain` returns `registered: false` for a 3s DNS timeout
      // exactly as it does for a clean NXDOMAIN. Writing that value over
      // a stored `registered = 1` manufactures a lapse, and the next
      // successful check then reads as a 0 -> 1 registration: a false
      // `first_seen`, a Haiku call, and a permanent un-triageable alert,
      // from a transient resolver blip. That used to be partly absorbed
      // by the `AND first_seen IS NULL` guard on the stamp; baseline
      // rows leave `first_seen` NULL by design, so every seeded row is
      // now exposed to it.
      //
      // So an unresolved check writes NO registration state at all. Only
      // the FAILURE cooldown advances (migration 0268) — `last_checked`
      // must stay NULL on a never-observed row, because that NULL is the
      // first-contact discriminator; writing it here would re-classify
      // the row as "checked before" while `registered` still held the
      // seeder's INSERT default, reproducing the same false transition
      // one tick later. Same shape as the page pass's failure branch:
      // the cooldown describes the last ATTEMPT, the verdict the last
      // SUCCESS.
      if (!result.resolved) {
        checksUnresolved++;
        await env.DB.prepare(
          `UPDATE lookalike_domains
           SET last_check_failed_at = datetime('now'),
               updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(row.id).run();
        logger.info('lookalike_check_unresolved', {
          domain: row.domain,
          first_contact: firstContact,
          stored_registered: row.registered,
        });
        return;
      }

      // Update the record. `baseline_established_at` is stamped here
      // rather than in the first-contact branch below on purpose: the
      // branch only runs for rows that RESOLVED, and a first contact
      // that found nothing is still a baseline we established — the
      // column records our coverage, not the domain's status. Bound as a
      // flag rather than interpolated.
      //
      // The CASE carries `AND baseline_established_at IS NULL` so the
      // column is STRUCTURALLY single-write. The previous version
      // asserted in a comment that it "can never be re-stamped" while
      // relying entirely on `last_checked` being non-NULL — which the
      // "Scan now" handler used to clear wholesale, making the assertion
      // false on any rescanned brand. The guard now holds regardless of
      // how `last_checked` is manipulated (migration 0267).
      //
      // `last_check_failed_at = NULL` closes the failure cooldown: a
      // successful observation supersedes any run of failures.
      await env.DB.prepare(
        `UPDATE lookalike_domains
         SET registered = ?,
             resolves_to = ?,
             has_mx = ?,
             has_web = ?,
             baseline_established_at = CASE
               WHEN ? = 1 AND baseline_established_at IS NULL
                 THEN datetime('now') ELSE baseline_established_at END,
             last_checked = datetime('now'),
             last_check_failed_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        result.registered ? 1 : 0,
        result.ip ?? null,
        result.hasMx ? 1 : 0,
        result.hasWeb ? 1 : 0,
        firstContact ? 1 : 0,
        row.id,
      ).run();

      // Detect NEWLY registered domains (was 0, now resolves) — or, on a
      // row we have never checked, simply "it resolves".
      if (result.registered && row.registered === 0) {
        if (firstContact) {
          // ── BASELINE ESTABLISHMENT ──────────────────────────────────
          // We learned nothing about WHEN this domain was registered,
          // only that it is registered now. `first_seen` is deliberately
          // NOT stamped (see migration 0267): claiming today as the
          // appearance date of a squat that may be years old is worse
          // than leaving it NULL, because downstream "new registrations
          // this week" readings would then be a measure of our own crawl
          // schedule.
          baselinesEstablished++;

          // The FULL-ASSESSMENT signal test. Mail AND web together is
          // the cheap, deterministic statement that a domain existing
          // only to be mistaken for someone else's is also OPERATIONAL —
          // it can both serve a page and receive replies. Either alone is
          // ordinary: parked squats serve registrar landers, and MX is
          // set by default by several registrars.
          //
          // The other qualifying signal — "the page scores as phishing"
          // — is deliberately NOT evaluated here. The inline fetch below
          // is capped at INLINE_PAGE_FETCH_CAP=10 against a LIMIT 50
          // batch, and spending that budget on baseline rows (which are
          // about to be ~56,010 of them) would starve it for the genuine
          // transitions it exists to composite. `analyzeLookalikePages`
          // owns that verdict, with its own per-run budget and a 24 h
          // cadence, and since this change it can also RAISE the alert
          // itself — so a baselined row whose page turns out to be a
          // credential-harvest kit is caught there, one pass later,
          // instead of here at the cost of the compositor's budget.
          if (!(result.hasMx && result.hasWeb)) {
            // ── THE EMAIL LANE IS NOT GATED ON THE WEB CONDITION ──────
            //
            // This early return used to sit ABOVE the BIMI check, so a
            // first-contact row that failed `hasMx && hasWeb` skipped
            // BIMI entirely. The shape that suppressed was MX and NO web
            // — a registered squat set up to RECEIVE MAIL and serve
            // nothing, which is the BEC-precursor shape. It is also
            // invisible to `analyzeLookalikePages` (that pass requires
            // `has_web = 1`), so it was permanently unalertable by ANY
            // producer, while this file's own comments call BIMI the
            // single most damning email signal the scanner can find.
            //
            // Admitting it does NOT reopen the AI-spend problem the
            // baseline branch exists to close: a BIMI check is one DNS
            // lookup against a bounded cohort, not a Haiku call. No
            // Haiku call is made here, and no
            // `lookalike_domain_active` alert either.
            if (result.hasMx) {
              try {
                if (await checkBIMIExists(row.domain)) {
                  const bimiBrand = await loadBrandContext(env, row.brand_id);
                  if (bimiBrand) {
                    await fileBimiAlert(env, row, bimiBrand.domain, 'system');
                    baselineBimiAlerts++;
                  }
                }
              } catch (err) {
                // Non-blocking, exactly as on the full path.
                logger.error('lookalike_baseline_bimi_error', {
                  domain: row.domain,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // NO HAIKU CALL AND NO `lookalike_domain_active` ALERT. This
            // early return is the cost control: at a 10-35% resolve rate
            // over the seeder backlog it is the difference between
            // thousands of Haiku calls plus the same number of permanent
            // alerts, and zero of either.
            baselinesSuppressed++;
            logger.info('lookalike_baseline_no_signal', {
              domain: row.domain,
              has_mx: result.hasMx,
              has_web: result.hasWeb,
            });
            return;
          }
          // Signal present → fall through to the full assessment path
          // below, identical to a real transition from here on.
        } else {
          // ── OBSERVED TRANSITION ─────────────────────────────────────
          // We checked this row before and it did not resolve; now it
          // does. The domain genuinely appeared while we were watching,
          // so `first_seen` means what it says.
          newRegistrations++;

          // Set first_seen
          await env.DB.prepare(
            `UPDATE lookalike_domains
             SET first_seen = datetime('now')
             WHERE id = ? AND first_seen IS NULL`,
          ).bind(row.id).run();
        }

        const brandRow = await loadBrandContext(env, row.brand_id);

        if (!brandRow) return;
        const brand = { ...brandRow, user_id: 'system' };

        // Request AI assessment
        let threatLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'MEDIUM';
        let aiAssessment = '';

        try {
          const aiResult = await analyzeWithHaiku(env, { agentId: "lookalike_scanner", runId: null },
            `Assess the threat level of this newly registered lookalike domain. Is it likely malicious brand impersonation or benign?
             Respond with JSON: {"threat_level": "LOW|MEDIUM|HIGH|CRITICAL", "assessment": "brief explanation", "indicators": ["list of suspicious indicators"]}`,
            {
              lookalike_domain: row.domain,
              original_domain: brand.domain,
              brand_name: brand.brand_name,
              permutation_type: row.permutation_type,
              resolves_to_ip: result.ip,
              has_mx_records: result.hasMx,
              has_web_server: result.hasWeb,
            },
          );

          if (aiResult.success && aiResult.data) {
            const structured = aiResult.data.structured as {
              threat_level?: string;
              assessment?: string;
            } | undefined;
            const responseText = aiResult.data.response ?? '';

            // Try to extract threat_level from structured data or response
            if (structured?.threat_level) {
              const level = structured.threat_level.toUpperCase();
              if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(level)) {
                threatLevel = level as typeof threatLevel;
              }
            }
            aiAssessment = structured?.assessment ?? responseText;
          }
        } catch (err) {
          logger.error('lookalike_ai_assessment_error', {
            domain: row.domain,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Boost threat level based on infrastructure signals
        if (result.hasMx && result.hasWeb && threatLevel === 'MEDIUM') {
          threatLevel = 'HIGH';
        }

        // BIMI on a lookalike domain is extremely suspicious
        let hasBIMI = false;
        try {
          hasBIMI = await checkBIMIExists(row.domain);
          if (hasBIMI && threatLevel === 'MEDIUM') {
            threatLevel = 'HIGH';
          }
        } catch {
          // BIMI check failed — non-blocking
        }

        // Deterministic page-content analysis (D6 / S2.4). Slots the
        // page phishing score into this same threat_level compositor: a
        // credential-form-off-domain page escalates MEDIUM→HIGH/CRITICAL
        // (monotonic — never downgrades). Inline only for newly-
        // registered has_web domains and capped per tick; the throttled
        // analyzeLookalikePages pass re-checks the broader registered set.
        // All fetches funnel through the SSRF-safe fetchSuspectPage.
        //
        // Hoisted out of the block below so the alert built at the tail of
        // this iteration can carry the same evidence (Lane 3 Phase 3 step
        // 16). Stays null when the branch is skipped or throws, which
        // `buildPageEvidenceDetails` degrades to `{}`.
        let pagePhishing: PagePhishingResult | null = null;
        if (
          result.hasWeb &&
          inlinePageBudget.remaining > 0 &&
          Date.now() - inlinePageBudget.runStart < INLINE_PAGE_BUDGET_MS
        ) {
          inlinePageBudget.remaining -= 1;
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
              threatLevel = escalateThreatLevelForPage(threatLevel, {
                score: phishing.score,
                credentialHarvest: phishing.credentialHarvest,
                antiBotWall: phishing.signals.includes('anti_bot_wall'),
              });
            }
          } catch (err) {
            logger.error('lookalike_inline_page_error', {
              domain: row.domain,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Update threat level and AI assessment
        await env.DB.prepare(
          `UPDATE lookalike_domains
           SET threat_level = ?,
               ai_assessment = ?,
               updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(threatLevel, aiAssessment, row.id).run();

        // Create alert via alerts pipeline. For IDN homoglyph variants the
        // stored `domain` is punycode (xn--…); surface the human-readable
        // unicode form (`аpple.com`) in the title so alerts aren't hostile.
        const displayDomain = row.unicode_domain ?? row.domain;
        const severity = threatLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

        // ── SEVERITY FLOOR ────────────────────────────────────────────
        // Below HIGH there is no `lookalike_domain_active` row.
        // Everything above this point has already been persisted —
        // `threat_level`, `ai_assessment`, and the page columns written
        // by `runPageAnalysisForDomain` — so nothing is lost but the
        // notification. The comparison itself lives in
        // `lib/lookalike-alert-policy.ts` and is shared with the
        // page-analysis producer; it is NOT restated here.
        //
        // BEHAVIOUR CHANGE: this also stops MEDIUM alerts on genuine
        // 0 -> 1 transitions, which used to be the common case (the
        // compositor's default level is MEDIUM and only mail+web, BIMI or
        // a page verdict lifted it). That is the requested change; the
        // reasoning is in the floor's docstring.
        //
        // Scoped to this alert type only, and NOT an early return: the
        // `typosquat_bimi` alert below is a different finding at a fixed
        // HIGH severity. A LOW-assessed row with a BIMI record does not
        // get its BIMI boost (that boost is `MEDIUM`-only), so an early
        // return here would silently swallow a HIGH alert about the
        // single most damning email signal this scanner can find.
        let alertId: string | null = null;
        if (clearsLookalikeAlertFloor(threatLevel)) {
          alertId = await createAlert(env.DB, {
            brandId: row.brand_id,
            userId: brand.user_id,
            alertType: 'lookalike_domain_active',
            severity,
            title: `Lookalike domain registered: ${displayDomain}`,
            summary: `A domain similar to ${brand.domain} (${row.permutation_type} variant) has been registered and is now active. ${result.hasWeb ? 'It has a web server.' : ''} ${result.hasMx ? 'It has MX records configured for email.' : ''}`.trim(),
            details: {
              lookalike_domain: row.domain,
              unicode_domain: row.unicode_domain ?? undefined,
              original_domain: brand.domain,
              permutation_type: row.permutation_type,
              resolves_to: result.ip,
              has_mx: result.hasMx,
              has_web: result.hasWeb,
              // Page-content evidence when the inline analysis ran and
              // scored; spreads to nothing otherwise so alert creation is
              // never regressed by a skipped/failed fetch. Descriptive
              // only — does not influence `severity` above, which is the
              // already-composited `threatLevel`.
              ...buildPageEvidenceDetails(pagePhishing),
            },
            sourceType: 'lookalike_scanner',
            sourceId: row.id,
            aiAssessment: aiAssessment || undefined,
            aiRecommendations: (['CRITICAL', 'HIGH'] as string[]).includes(threatLevel)
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
          });
        } else {
          alertsWithheldByFloor++;
          logger.info('lookalike_alert_withheld_below_floor', {
            domain: row.domain,
            threat_level: threatLevel,
            floor: LOOKALIKE_ALERT_SEVERITY_FLOOR,
            first_contact: firstContact,
          });
        }

        // Link the alert back to the lookalike record. Guarded on a
        // non-null id now, where it used to run unconditionally: both the
        // floor above and `createAlert`'s NX2 tier gate can legitimately
        // produce no alert, and `alert_id IS NULL` is precisely the state
        // `analyzeLookalikePages` keys its own alert path on. Writing a
        // NULL over a NULL was harmless; writing one at all is now
        // meaningless work, and being explicit about it is what makes the
        // page-analysis gate's precondition readable.
        if (alertId) {
          await env.DB.prepare(
            `UPDATE lookalike_domains SET alert_id = ? WHERE id = ?`,
          ).bind(alertId, row.id).run();
        }

        // Additional alert if lookalike has BIMI. Shared builder with
        // the mail-only first-contact lane above.
        if (hasBIMI) {
          await fileBimiAlert(env, row, brand.domain, brand.user_id);
        }
      }
    });

    await Promise.all(checks);
  }

  logger.info('lookalike_check', {
    checked: totalChecked,
    // Transitions WE observed — the metric that used to be conflated
    // with first contact and is now honest.
    new_registrations: newRegistrations,
    // Rows resolved for the first time ever...
    baselines_established: baselinesEstablished,
    // ...of which this many carried no full-assessment signal, so cost
    // NO Haiku call and produced NO `lookalike_domain_active` alert.
    // During the seeder backlog drain this is the number to watch: it is
    // the suppression doing its job.
    baselines_suppressed: baselinesSuppressed,
    // Fixed-HIGH `typosquat_bimi` alerts filed from the mail-only
    // first-contact lane — the BEC-precursor shape no other producer can
    // see. A suppressed baseline is NOT a silent one when BIMI is there.
    baseline_bimi_alerts: baselineBimiAlerts,
    // Assessed rows whose composed level sat below the severity floor.
    alerts_withheld_below_floor: alertsWithheldByFloor,
    // Checks that produced NO answer (resolver timeout / non-ok DoH
    // response). These wrote no registration state at all — only the
    // failure cooldown. A rising number here is a resolver problem, and
    // before migration 0268 it was silently minting false transitions.
    checks_unresolved: checksUnresolved,
    // The cohort split, so starvation is visible in the log rather than
    // inferred from a stalled `new_registrations` count.
    selected_first_contact: firstContacts.results.length,
    selected_recheck: recheck.results.length + spill.length,
  });
}

// checkDomain() moved to lib/domain-checker.ts for shared use with Sparrow Phase F
