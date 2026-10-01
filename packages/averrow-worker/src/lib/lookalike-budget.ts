/**
 * The lookalike DNS checker's QUANTITIES — per-tick drain, probe
 * ceilings, enqueue bounds, un-park cadence, operator thresholds.
 *
 * ── Why a neutral module and not the scanner ─────────────────────────
 *
 * `agents/flightControl.ts` needs the drain size to say whether the
 * backlog is saturated, and the due-probe ceiling to bound its own
 * gauge. Importing those from `scanners/lookalike-domains.ts` — which
 * is what it did — statically drags `lib/haiku`, `email-security` and
 * `lib/page-fetch` into Flight Control's import graph for the sake of
 * two integers. There is no cycle and no measurable bundle cost today,
 * but it contradicts the pattern `lib/monitored-brands.ts` and
 * `lib/lookalike-alert-policy.ts` were created to establish, and both of
 * those argue the case at length: a value two modules share belongs in
 * a module that depends on neither.
 *
 * Everything here is a PURE integer or SQLite datetime modifier. No
 * imports, no env, no clock — so any module may read it.
 */

/**
 * Rows ONE cron tick of the checker may process, across both cohorts.
 *
 * Deliberately NOT raised: see `lib/monitored-brands.ts` for why
 * lifting the cap without a wall-clock guard makes throughput worse
 * rather than better, and `scanners/lookalike-domains.ts` for the
 * 30/20 cohort split and its bidirectional spill.
 */
export const LOOKALIKE_BATCH_LIMIT = 50;

/**
 * How far Flight Control's due gauge COUNTS before it stops counting.
 *
 * The gauge answers exactly one question — "are more rows due than one
 * tick can drain?" — and both of its cohort subqueries are index RANGE
 * counts, so an exact answer reads one index entry per due row. During
 * the seeder drain the due set is tens of thousands and the gauge is
 * recomputed ~12x/day, which is 300K-600K index reads a day to produce
 * a boolean.
 *
 * `LIMIT 51` per cohort answers `due > LOOKALIKE_BATCH_LIMIT` EXACTLY
 * (51 > 50 regardless of how the two cohorts split it) for at most 102
 * reads. The cost is resolution: the gauge is a bounded probe, so above
 * its ceiling it reports the ceiling and cannot express "rising". That
 * is why `lookalikeDrainFallingBehind` asks for a NON-DECREASING run of
 * saturated samples rather than a strictly rising one — see its
 * docstring.
 */
export const LOOKALIKE_DUE_PROBE_LIMIT = LOOKALIKE_BATCH_LIMIT + 1;

/** The ceiling the due gauge can report, i.e. both cohorts probed out. */
export const LOOKALIKE_DUE_GAUGE_CEILING = LOOKALIKE_DUE_PROBE_LIMIT * 2;

/**
 * Rows ONE operator "Scan now" press may stamp to the head of the
 * queue.
 *
 * ── The unbounded case this removes ─────────────────────────────────
 *
 * `handleScanLookalikes` wrote `check_due_at = '1970-01-01 00:00:00'`
 * to EVERY row of a brand (`WHERE brand_id = ?`, no `LIMIT`), and both
 * cohort selectors are `ORDER BY check_due_at ASC` over a GLOBAL,
 * cross-tenant queue. With no rate limit, no cooldown and no cap, an
 * org-scoped staff member scripting the endpoint could pin an unbounded
 * number of their own rows to the head of the queue indefinitely and
 * starve every other tenant's due rows against a 50-row/tick drain.
 *
 * The intent is "this brand's rows jump the queue", not "this brand
 * owns the queue". 100 is above the ~30 permutations a brand typically
 * holds, so the honest press is unaffected, and it bounds the worst
 * case to two ticks' worth of the global drain. The statement is
 * additionally written to SKIP rows already at the epoch, so repeated
 * presses re-stamp nothing until the previous batch has drained — which
 * is what makes the bound hold over TIME rather than per call.
 */
export const LOOKALIKE_RESCAN_ENQUEUE_LIMIT = 100;

/**
 * Parked rows ONE tick may re-admit, and how long a row must have been
 * parked before it is eligible.
 *
 * ── Why a parked row needs a way back ───────────────────────────────
 *
 * `check_due_at = NULL` drops a row out of both partial cohort indexes,
 * which is the point (a dead-resolver row costs zero reads). But it had
 * NO automatic path back: the seeder's `INSERT OR IGNORE` never touches
 * an existing row, both other writers require the row to be SELECTED
 * (which a parked row is not), and the only remaining writer was the
 * manual per-brand operator rescan. A row parked before its first
 * successful observation also still carries `registered = 0 /
 * has_web = 0 / resolves_to NULL`, so it is invisible to both
 * page-analysis cohorts too — permanently undetectable, with no
 * recovery path.
 *
 * The realistic trigger is OUR side, not the domain's: sustained
 * `cloudflare-dns.com` degradation or rate-limiting (a non-ok DoH reply
 * lands in the same unresolved branch as a timeout) across the ladder's
 * ~10 days parks a whole cohort. And the Flight Control warning is
 * keyed on the DUE backlog, which parking REDUCES — so a park event
 * pushes the only gauge in the silencing direction.
 *
 * So the park becomes a LONG CADENCE rather than a terminal state: the
 * oldest parked rows are re-admitted, bounded per tick, and the sweep
 * is self-throttling because `last_check_failed_at` is written only by
 * the failure path. A re-admitted row that fails again re-parks with a
 * fresh stamp and is therefore not eligible again for another window;
 * one that succeeds has `check_attempts` reset by the success path and
 * rejoins the normal cadence.
 *
 * `check_attempts` is deliberately NOT reset on re-admission. Resetting
 * it would send a still-dead row back through the whole 1h/4h/12h/24h/
 * 48h ladder — ~8 further DNS probes over 10 days — every window.
 * Leaving it past the terminal count means the row is probed ONCE, and
 * re-parks on that single failure: one DNS query per parked row per
 * window, which is what makes this affordable at scale.
 */
export const LOOKALIKE_UNPARK_PER_RUN = 25;

/** SQLite datetime modifier: how stale a park must be to be re-admitted. */
export const LOOKALIKE_UNPARK_MIN_AGE_MODIFIER = '-7 days';

/**
 * Parked rows past which Flight Control warns.
 *
 * `backlog.lookalike_parked` existed with no threshold and no warning of
 * its own, so a growing parked set was visible only to an operator who
 * thought to read the number — while the one warning that did exist
 * (the DUE backlog) moves the WRONG WAY when rows park.
 *
 * 500 is a day of un-park capacity (`LOOKALIKE_UNPARK_PER_RUN` x 24 =
 * 600 re-admissions/day): below it the sweep turns the whole parked set
 * over inside a day, above it the set is growing faster than the lane
 * that recovers it. It is also 10 ticks' worth of the global drain, and
 * just under the 1%-parked shape migration 0269's plan fixture models
 * as the pathological case at the projected 56,010-row population.
 */
export const LOOKALIKE_PARKED_WARN_THRESHOLD = 500;
