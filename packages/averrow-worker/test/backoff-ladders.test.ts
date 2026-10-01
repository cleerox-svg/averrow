/**
 * `lib/backoff.ts` — ONE jitter implementation, TWO ladders.
 *
 * The feed path's own tests (`test/feed-circuit-breaker.test.ts`) pin
 * `computeFeedRetryAt`'s bounds and pass UNMODIFIED against the
 * extracted version, which is the real regression guard for that half.
 * This file covers what is new: the ladder abstraction itself, the
 * lookalike ladder's shape, and the TERMINAL PARK — the behaviour the
 * feed ladder does not have and could not express.
 */

import { describe, it, expect } from "vitest";
import {
  computeBackoffRetryAt,
  backoffBaseMs,
  isTerminalAttempt,
  toSqliteDatetime,
  FEED_RETRY_LADDER,
  LOOKALIKE_CHECK_LADDER,
  JITTER_FRACTION,
  type BackoffLadder,
} from "../src/lib/backoff";
import { computeFeedRetryAt } from "../src/lib/feedRunner";

const NOW = new Date("2026-05-14T12:00:00Z");

function minutesOut(stamp: string, now: Date = NOW): number {
  return (new Date(stamp.replace(" ", "T") + "Z").getTime() - now.getTime()) / 60_000;
}

describe("the ladder core", () => {
  it("clamps a 0 or negative attempt count to the first step", () => {
    // Defensive — every caller increments BEFORE computing, so this
    // should be unreachable; a helper that returned a negative delay
    // from it would stamp a row PERMANENTLY due.
    for (const ladder of [FEED_RETRY_LADDER, LOOKALIKE_CHECK_LADDER]) {
      expect(backoffBaseMs(ladder, 0)).toBe(backoffBaseMs(ladder, 1));
      expect(backoffBaseMs(ladder, -7)).toBe(backoffBaseMs(ladder, 1));
      expect(minutesOut(computeBackoffRetryAt(ladder, 0, NOW)!)).toBeGreaterThan(0);
    }
  });

  it("clamps past the array to the last step — the cap", () => {
    for (const ladder of [FEED_RETRY_LADDER, LOOKALIKE_CHECK_LADDER]) {
      const last = ladder.stepsMinutes.length;
      expect(backoffBaseMs(ladder, last + 1)).toBe(backoffBaseMs(ladder, last));
      expect(backoffBaseMs(ladder, 99)).toBe(backoffBaseMs(ladder, last));
    }
  });

  it("jitters by ±25%, and the jitter actually varies", () => {
    // The load-bearing part. Without it every row that failed on the
    // same upstream in the same tick retries at the same MINUTE, which
    // is a thundering herd rather than a backoff.
    const ladder: BackoffLadder = {
      name: "test", stepsMinutes: [100], terminalAfterAttempts: null,
    };
    const samples = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const stamp = computeBackoffRetryAt(ladder, 1, NOW)!;
      samples.add(stamp);
      const m = minutesOut(stamp);
      expect(m).toBeGreaterThanOrEqual(100 * (1 - JITTER_FRACTION));
      expect(m).toBeLessThanOrEqual(100 * (1 + JITTER_FRACTION));
    }
    expect(samples.size, "200 draws over a 50-minute span").toBeGreaterThan(20);
  });

  it("emits SQLite datetime format — no T, no Z, second resolution", () => {
    expect(toSqliteDatetime(NOW)).toBe("2026-05-14 12:00:00");
    const stamp = computeBackoffRetryAt(LOOKALIKE_CHECK_LADDER, 1, NOW)!;
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe("FEED_RETRY_LADDER — unchanged from the literal it replaced", () => {
  it("is 5 / 15 / 45 / 120 minutes", () => {
    expect([...FEED_RETRY_LADDER.stepsMinutes]).toEqual([5, 15, 45, 120]);
  });

  it("NEVER parks — auto-pause owns recovery on the feed side", () => {
    // A feed that keeps failing gets `enabled = 0` and an operator
    // alert, so the ladder never has to express "give up". Were this
    // ever to return null, `computeFeedRetryAt` would throw rather than
    // stamp a NULL into `feed_status.next_retry_at`.
    expect(FEED_RETRY_LADDER.terminalAfterAttempts).toBeNull();
    for (const n of [1, 4, 10, 500]) {
      expect(isTerminalAttempt(FEED_RETRY_LADDER, n)).toBe(false);
      expect(computeBackoffRetryAt(FEED_RETRY_LADDER, n, NOW)).not.toBeNull();
    }
  });

  it("the adapter and the ladder agree on every step's bounds", () => {
    // `computeFeedRetryAt` is now a delegate. This is the assertion that
    // the delegation preserved the ladder rather than the one that
    // re-states the bounds (that is feed-circuit-breaker.test.ts's job).
    for (const [attempt, base] of [[1, 5], [2, 15], [3, 45], [4, 120], [10, 120]] as const) {
      for (let i = 0; i < 25; i += 1) {
        const m = minutesOut(computeFeedRetryAt(attempt, NOW));
        expect(m, `fail #${attempt}`).toBeGreaterThanOrEqual(base * 0.75);
        expect(m, `fail #${attempt}`).toBeLessThanOrEqual(base * 1.25);
      }
    }
  });
});

describe("LOOKALIKE_CHECK_LADDER — sized against a 24 h cadence", () => {
  it("climbs 1 h / 4 h / 12 h / 24 h and caps at 48 h", () => {
    // The feed ladder's 120-minute cap is WRONG here, and that is the
    // whole reason for a second ladder: on a 24 h cadence it would
    // re-admit a permanently-dead row every two hours forever — twelve
    // times the rate of a healthy row, at the head of a cohort it can
    // never leave.
    const hours = LOOKALIKE_CHECK_LADDER.stepsMinutes.map((m) => m / 60);
    expect(hours).toEqual([1, 4, 12, 24, 48]);
    // Reaches the cadence by the fourth failure...
    expect(backoffBaseMs(LOOKALIKE_CHECK_LADDER, 4)).toBe(24 * 3600_000);
    // ...and never exceeds twice it.
    expect(backoffBaseMs(LOOKALIKE_CHECK_LADDER, 8)).toBe(48 * 3600_000);
  });

  it("PARKS past the terminal attempt count, and not before", () => {
    // `null` is the caller's instruction to write `check_due_at = NULL`,
    // which drops the row out of both partial cohort indexes — zero
    // reads structurally, rather than merely deprioritized.
    expect(LOOKALIKE_CHECK_LADDER.terminalAfterAttempts).toBe(8);
    for (let n = 1; n <= 8; n += 1) {
      expect(isTerminalAttempt(LOOKALIKE_CHECK_LADDER, n), `attempt ${n}`).toBe(false);
      expect(computeBackoffRetryAt(LOOKALIKE_CHECK_LADDER, n, NOW), `attempt ${n}`).not.toBeNull();
    }
    for (const n of [9, 10, 99]) {
      expect(isTerminalAttempt(LOOKALIKE_CHECK_LADDER, n), `attempt ${n}`).toBe(true);
      expect(computeBackoffRetryAt(LOOKALIKE_CHECK_LADDER, n, NOW), `attempt ${n}`).toBeNull();
    }
  });

  it("spends about ten days of patient retrying before parking", () => {
    // The number that makes a park mean "this domain's resolver has been
    // unanswerable for a week and a half" rather than "the network
    // blipped". Computed from the ladder so it cannot drift from it.
    let hours = 0;
    for (let n = 1; n <= LOOKALIKE_CHECK_LADDER.terminalAfterAttempts!; n += 1) {
      hours += backoffBaseMs(LOOKALIKE_CHECK_LADDER, n) / 3600_000;
    }
    expect(hours).toBeGreaterThan(7 * 24);
    expect(hours).toBeLessThan(14 * 24);
  });

  it("every step is strictly increasing — a ladder that plateaus early is a loop", () => {
    const steps = LOOKALIKE_CHECK_LADDER.stepsMinutes;
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!, `step ${i}`).toBeGreaterThan(steps[i - 1]!);
    }
  });
});
