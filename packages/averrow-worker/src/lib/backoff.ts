/**
 * ONE jittered exponential-backoff implementation. TWO ladders.
 *
 * ── Why this module exists ──────────────────────────────────────────
 *
 * `lib/feedRunner.ts` had the only backoff in the codebase: a four-step
 * ladder with ±25% jitter, stamped into `feed_status.next_retry_at`. The
 * lookalike DNS checker now needs the same shape for
 * `lookalike_domains.check_due_at`, and the tempting move — copy the
 * nine lines — is the one that produces two jitter implementations that
 * drift. The jitter is the load-bearing part (without it every row that
 * failed on the same upstream in the same tick retries at the same
 * minute, which is a thundering herd rather than a backoff), so it is
 * the part that must have exactly one definition.
 *
 * ── Why two LADDERS and not one ─────────────────────────────────────
 *
 * The feed ladder caps at 120 min because a feed's cadence is hourly and
 * because past the cap the AUTO-PAUSE threshold owns recovery — a feed
 * that keeps failing gets `enabled = 0` and an operator alert, so the
 * ladder never has to express "give up".
 *
 * The lookalike checker has neither property. Its cadence is 24 h, so a
 * 120-min cap would re-admit a permanently-dead row every two hours
 * FOREVER — twelve times the cadence of a healthy row, at the head of a
 * cohort it can never leave. And it has no auto-pause, so "give up" has
 * to live in the ladder. Hence `terminalAfterAttempts`: past it,
 * `computeBackoffRetryAt` returns null and the caller PARKS the row
 * (`check_due_at = NULL`, which drops it out of both partial cohort
 * indexes — see migration 0269).
 *
 * Everything here is PURE except for the jitter's `Math.random()` and
 * the caller-supplied clock.
 */

/** Jitter half-width as a fraction of the base delay. */
export const JITTER_FRACTION = 0.25;

export interface BackoffLadder {
  /** Short name, for log lines and test labels. */
  readonly name: string;
  /**
   * Base delays in MINUTES, indexed by `attempts - 1`. The last entry
   * is the cap: attempt counts past the array length reuse it.
   */
  readonly stepsMinutes: readonly number[];
  /**
   * Attempt count past which the caller must PARK rather than retry.
   * `null` = never park (the feed ladder — auto-pause owns recovery).
   */
  readonly terminalAfterAttempts: number | null;
}

/**
 * The feed circuit breaker's ladder, UNCHANGED from the literal it was
 * extracted from (`computeFeedRetryAt`, 5/15/45/120 min, no terminal).
 * `test/feed-circuit-breaker.test.ts` passes against this unmodified.
 */
export const FEED_RETRY_LADDER: BackoffLadder = {
  name: 'feed_retry',
  stepsMinutes: [5, 15, 45, 120],
  terminalAfterAttempts: null,
};

/**
 * The lookalike DNS check's ladder.
 *
 * 1 h / 4 h / 12 h / 24 h, then a 48 h cap, and PARK after 8 consecutive
 * failures. Sized against the checker's own 24 h cadence rather than
 * against the feed cron:
 *
 *   * Starting at 1 h rather than the flat 24 h cooldown it replaces: a
 *     single DoH timeout should not cost a full day of coverage on a
 *     row, and the checker's cron is hourly, so 1 h is "next tick".
 *   * Reaching the cadence (24 h) by the fourth failure, so a row with a
 *     genuinely broken resolver stops consuming a daily slot after three
 *     retries rather than after none.
 *   * Capping at 48 h — twice the cadence — so a failing row costs at
 *     most half what a healthy one does while it is still being retried.
 *   * Parking after 8. Cumulative wall-clock to that point is
 *     1 + 4 + 12 + 24 + 48 x 4 ≈ 233 h ≈ 10 days of patient retrying,
 *     which is long enough that a park means "this domain's resolver has
 *     been unanswerable for a week and a half", not "the network
 *     blipped". A parked row is revived by the operator rescan endpoint
 *     (which resets `check_attempts = 0`) and is counted by Flight
 *     Control's `backlog.lookalike_parked` gauge, so parking is visible
 *     rather than silent.
 */
export const LOOKALIKE_CHECK_LADDER: BackoffLadder = {
  name: 'lookalike_check',
  stepsMinutes: [60, 240, 720, 1440, 2880],
  terminalAfterAttempts: 8,
};

/** `YYYY-MM-DD HH:MM:SS` — the SQLite datetime shape D1 compares. */
export function toSqliteDatetime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * The ladder's base delay in ms for an attempt count. Clamped at both
 * ends: a 0 or negative count (defensive — callers increment first)
 * takes the first step, and anything past the array takes the cap.
 */
export function backoffBaseMs(ladder: BackoffLadder, attempts: number): number {
  const idx = Math.min(Math.max(attempts, 1), ladder.stepsMinutes.length) - 1;
  return ladder.stepsMinutes[idx]! * 60_000;
}

/** Has this row exhausted the ladder and earned a terminal park? */
export function isTerminalAttempt(ladder: BackoffLadder, attempts: number): boolean {
  return ladder.terminalAfterAttempts !== null && attempts > ladder.terminalAfterAttempts;
}

/**
 * Next retry stamp for `attempts` consecutive failures, or NULL when the
 * ladder says to park.
 *
 * The jitter arithmetic is byte-for-byte what `computeFeedRetryAt`
 * carried — `(Math.random() - 0.5) * 2 * 0.25 * base`, i.e. ±25% —
 * because that function's tests assert the bounds and must pass
 * unmodified.
 */
export function computeBackoffRetryAt(
  ladder: BackoffLadder,
  attempts: number,
  now: Date = new Date(),
): string | null {
  if (isTerminalAttempt(ladder, attempts)) return null;
  const baseMs = backoffBaseMs(ladder, attempts);
  const jitter = (Math.random() - 0.5) * 2 * JITTER_FRACTION * baseMs;
  return toSqliteDatetime(new Date(now.getTime() + baseMs + jitter));
}
