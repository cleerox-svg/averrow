-- 0269_lookalike_check_scheduling.sql
--
-- Two additive sections. Section 1 gives the DNS checker its OWN
-- scheduling column so `last_checked` stops carrying three jobs.
-- Section 2 gives the recurring BIMI lane its presence-only marker.
--
-- ══════════════════════════════════════════════════════════════════════
-- THREE TIMESTAMPS ON ONE TABLE, AND WHY THEY ARE NOT UNIFIED
-- ══════════════════════════════════════════════════════════════════════
--
-- This table now carries three "when did a pass last touch this row"
-- stamps, written by three different passes. Read this before unifying
-- them, because the next person's instinct will be to.
--
--   page_fetched_at   THE PAGE PASS (`scanners/lookalike-page-analysis
--                     .ts`). Stamped on BOTH branches of
--                     `runPageAnalysisForDomain` — success AND failure —
--                     so it is a pure COOLDOWN and never a verdict. The
--                     verdict lives in `page_phishing_score` /
--                     `page_signals` / `page_last_outcome`. Its cohort
--                     selection is EXPLAIN-verified against
--                     `idx_lookalike_page_due` (migration 0268).
--
--   last_checked      "WHEN DID WE LAST SUCCESSFULLY OBSERVE THIS ROW",
--                     and as of this migration that is its ONLY job. It
--                     is written only by the per-check UPDATE's success
--                     path. Live readers mean exactly that:
--                     `agents/observer.ts`'s 24 h "lookalikes checked"
--                     briefing count, and the staff + tenant column
--                     lists. It is NO LONGER a selection predicate and
--                     NO LONGER the first-contact discriminator — see
--                     migration 0267's amended header for that flip.
--
--   check_due_at      THE DNS CHECKER'S SCHEDULE (this migration).
--                     "When may this row next be selected." Written by
--                     the seeder (due immediately), by the success path
--                     (now + cadence), by the failure path (now +
--                     jittered backoff), and by the operator rescan
--                     (the epoch, which beats everything). NULL means
--                     PARKED.
--
-- WHY THE PAGE PASS WAS DELIBERATELY LEFT ALONE. `page_fetched_at`
-- already implements the pattern this migration is teaching the DNS
-- lane: the cooldown is stamped on every outcome, so it is never
-- confused with the verdict. It is the CORRECT shape, not the one being
-- fixed. Its index is measured, its two cohorts are budget-split, and
-- its plans are asserted. Collapsing it into `check_due_at` would merge
-- two passes with different cadences, different budgets and different
-- failure semantics into one column for the sake of symmetry, and would
-- rewrite a verified index for no behavioural gain. The three stamps are
-- three schedules because there are three passes; the defect was never
-- that there were several columns, it was that ONE column was answering
-- three questions at once.
--
-- ══════════════════════════════════════════════════════════════════════
-- 1. check_due_at + check_attempts — THE DUE TIMESTAMP IS THE PRIORITY
-- ══════════════════════════════════════════════════════════════════════
--
-- The checker's cohorts used to be `last_checked IS NULL` and
-- `last_checked < -24 hours`, with the failure cooldown
-- (`last_check_failed_at`) bolted on as a residual filter in both. That
-- made ONE column the first-contact discriminator, the dueness
-- predicate, and the last-success record simultaneously, so every
-- scheduling write was also a reclassification. Two columns separate
-- the two jobs:
--
--   check_due_at    TEXT     when this row may next be selected.
--                            NULL = PARKED (see below).
--   check_attempts  INTEGER  consecutive FAILED attempts since the last
--                            success. Drives the backoff ladder in
--                            `lib/backoff.ts`; reset to 0 on success.
--
-- NO SEPARATE `priority` COLUMN, deliberately. `ORDER BY priority DESC,
-- check_due_at ASC` cannot seek: with no equality constraint on the
-- leading column the planner walks the whole `priority = 0` group, which
-- reproduces the scan this migration exists to remove. A due timestamp
-- orders itself — earlier is higher priority — so the operator rescan
-- expresses "now, ahead of everything" as `check_due_at =
-- '1970-01-01 00:00:00'` rather than as a second column.
--
-- ── TERMINAL PARK: NULL DROPS THE ROW OUT OF BOTH INDEXES ─────────────
--
-- Past the ladder's terminal attempt count the failure path writes
-- `check_due_at = NULL`. Both cohort indexes below are PARTIAL on
-- `check_due_at IS NOT NULL`, so a parked row is not merely
-- deprioritized — it holds no entry in either index and therefore costs
-- ZERO reads, structurally. That is the fix for a permanently-dead row:
-- the old arrangement left a row whose resolver always times out
-- re-admitted every 24 h forever, at the head of a cohort it could never
-- leave.
--
-- A parked row is still visible (`check_due_at IS NULL` + a non-zero
-- `check_attempts` is the operator-readable signature, both on the staff
-- list payload), still counted by Flight Control's
-- `backlog.lookalike_parked` gauge, and still revivable by the
-- brand rescan endpoint, which resets `check_attempts = 0`.
--
-- ── THE TWO PARTIAL INDEXES, AND WHY TWO ─────────────────────────────
--
-- The cohort discriminator is `baseline_established_at` (0267), NOT
-- dueness. Ordering a SINGLE queue purely by dueness re-creates the
-- starvation the split was introduced to fix, from the other direction:
-- rows seeded weeks ago and never looked at are all MORE overdue than a
-- re-check due 24 h after its last successful look, so one queue starves
-- re-check exactly as `ORDER BY last_checked ASC NULLS FIRST` did. The
-- split was never the bug — the bug was that the discriminator and the
-- scheduling column were the same column.
--
-- Each index is partial on its cohort's `baseline_established_at` term
-- AND on `check_due_at IS NOT NULL`, keyed on `check_due_at` alone:
--
--   idx_lookalike_due_first_contact  baseline_established_at IS NULL
--   idx_lookalike_due_recheck        baseline_established_at IS NOT NULL
--
-- A partial index is usable only when the query's WHERE IMPLIES the
-- index's, so both cohort SELECTs state all three terms explicitly
-- (`baseline_established_at IS [NOT] NULL AND check_due_at IS NOT NULL
-- AND check_due_at <= datetime('now')`). With that, `check_due_at` is
-- the sole key, the dueness predicate is a range on it, and
-- `ORDER BY check_due_at ASC` is the index's own order — an index range
-- scan with no table scan and no temp b-tree. Measured on the
-- migration-derived schema at the projected volume (56,010 rows, 1,867
-- brands, 30% baselined, ~half due, 1% parked, per-row second-resolution
-- stamps), in BOTH stat states:
--
--   checker/first    SEARCH ld USING INDEX idx_lookalike_due_first_contact (check_due_at>? AND check_due_at<?)
--   checker/recheck  SEARCH ld USING INDEX idx_lookalike_due_recheck (check_due_at>? AND check_due_at<?)
--
-- Unlike 0268's `idx_lookalike_last_checked` plans, these are NOT
-- cardinality-sensitive in the degenerate direction that migration
-- documents. That sensitivity came from `sqlite_stat1` being unable to
-- express that the NULL bucket of `last_checked` held most of the table,
-- which made an `IS NULL` seek look worse than a `LIMIT 50` scan. Here
-- every indexed row has a NON-NULL `check_due_at` by construction (the
-- partial WHERE excludes the NULLs), so there is no NULL bucket to
-- mis-price. The plans are asserted in
-- `test/lookalike-sql-statements.test.ts` with and without ANALYZE
-- anyway, because asserting is cheaper than reasoning.
--
-- A third partial index covers the PARKED set for Flight Control's
-- gauge. It is tiny by construction (only parked rows hold an entry) and
-- its write cost is one entry per park/unpark event, which is rare by
-- definition — so it buys an operator gauge that would otherwise be a
-- full scan of a ninety-fold-grown table, for almost nothing.
--
-- ══════════════════════════════════════════════════════════════════════
-- 2. bimi_first_seen_at — PRESENCE ONLY, NEVER ABSENCE
-- ══════════════════════════════════════════════════════════════════════
--
-- The BIMI check is the single most damning email signal this scanner
-- can find, and it used to be reachable ONCE per row: only on first
-- contact, and only through the mail-only baseline branch or the
-- full-assessment tail. A squat that publishes a BIMI record a month
-- after we baselined it was invisible forever.
--
-- So the lane becomes RECURRING: every re-check of a `registered = 1 AND
-- has_mx = 1` row whose `bimi_first_seen_at IS NULL` spends one DNS TXT
-- lookup, bounded by a per-run cap.
--
-- THIS COLUMN RECORDS PRESENCE ONLY. It is stamped when a BIMI record is
-- OBSERVED and is never written to mean "no BIMI record". That is not
-- fastidiousness: `checkBIMIExists` (`src/email-security.ts`) catches
-- its own errors and returns `false`, so absence and lookup-failure are
-- the SAME value at the call site. A column that recorded `false` would
-- be recording "we could not tell" as "there is none" — which is
-- precisely the defect migration 0268 exists to fix for `registered`,
-- and it would permanently retire the row from the lane on a transient
-- resolver blip.
--
-- It doubles as the lane's IDEMPOTENCY TOKEN. The alert is filed only
-- after a guarded claim (`UPDATE ... WHERE id = ? AND
-- bimi_first_seen_at IS NULL`) reports one changed row, and the claim is
-- released if `createAlert` throws. The per-run cap is checked BEFORE
-- the claim, so a capped row cannot burn its claim and then never alert.
--
-- The BIMI alert id is deliberately NOT written to `alert_id`.
-- `raiseUnalertedPhishingPageAlert` keys its whole existence on
-- `alert_id IS NULL`; a `typosquat_bimi` id parked there would
-- permanently suppress the phishing-page alert for that row. The BIMI
-- alert stays discoverable as `alerts.source_type = 'lookalike_scanner'
-- AND source_id = <lookalike id> AND alert_type = 'typosquat_bimi'`.
--
-- Its partial index is the eligible set itself (`registered = 1 AND
-- has_mx = 1 AND bimi_first_seen_at IS NULL`), so it SHRINKS as rows are
-- claimed and holds no entry for a row that has already been found to
-- publish BIMI.
--
-- ══════════════════════════════════════════════════════════════════════
--
-- Additive only — ADD COLUMN / CREATE INDEX / ANALYZE / data UPDATE,
-- never DROP/ALTER and never a table rebuild (D1 enforces foreign keys,
-- so a rebuild of this table would cascade). ANALYZE is table-scoped
-- (0100's `ANALYZE threats;` shape, same as 0268's) rather than 0123's
-- bare whole-database form: the other tables' statistics are not this
-- migration's business and a bare ANALYZE reads every index in the
-- database. Before touching the plan fixture in
-- `test/lookalike-sql-statements.test.ts`, read 0268's "ONE MEASURED
-- SENSITIVITY" note — that file's seeding is deliberately not simple.

ALTER TABLE lookalike_domains ADD COLUMN check_due_at TEXT;
ALTER TABLE lookalike_domains ADD COLUMN check_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lookalike_domains ADD COLUMN bimi_first_seen_at TEXT;

CREATE INDEX IF NOT EXISTS idx_lookalike_due_first_contact
  ON lookalike_domains(check_due_at)
  WHERE check_due_at IS NOT NULL AND baseline_established_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lookalike_due_recheck
  ON lookalike_domains(check_due_at)
  WHERE check_due_at IS NOT NULL AND baseline_established_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lookalike_parked
  ON lookalike_domains(id)
  WHERE check_due_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lookalike_bimi_due
  ON lookalike_domains(registered, has_mx)
  WHERE registered = 1 AND has_mx = 1 AND bimi_first_seen_at IS NULL;

-- ── Backfill: put every existing row on the new schedule ─────────────
--
-- Without this every pre-existing row has `check_due_at IS NULL`, which
-- the new predicates read as PARKED — the whole table would go
-- permanently unchecked. ~120 rows in production.
--
-- A never-observed row is due NOW. An observed row is due one cadence
-- after its last successful observation, which for anything stale lands
-- in the past and is therefore also due now. This preserves the exact
-- cadence the old `last_checked < datetime('now','-24 hours')` predicate
-- expressed, which is why it reads `last_checked` rather than just
-- stamping everything `datetime('now')`.
--
-- Runs AFTER 0267's disambiguation UPDATE (migration order), so the
-- cohort a backfilled row lands in is already correct.
UPDATE lookalike_domains
   SET check_due_at = CASE
         WHEN last_checked IS NULL THEN datetime('now')
         ELSE datetime(last_checked, '+24 hours')
       END
 WHERE check_due_at IS NULL;

-- Statistics refresh so the planner costs the four new indexes from
-- measured cardinality rather than from defaults or 0123-era stats taken
-- when this table held ~120 rows. Same sibling convention as
-- 0099/0100/0101/0123/0197/0200/0268.
ANALYZE lookalike_domains;
