import { describe, it, expect } from "vitest";
import { computeFeedRetryAt } from "../src/lib/feedRunner";

function diffMinutes(stamp: string, now: Date): number {
  const ms = new Date(stamp.replace(' ', 'T') + 'Z').getTime() - now.getTime();
  return ms / 60_000;
}

describe("computeFeedRetryAt — per-feed circuit breaker backoff", () => {
  const now = new Date('2026-05-14T12:00:00Z');

  it("fail #1 lands ~5min in the future ±25% jitter", () => {
    for (let i = 0; i < 50; i++) {
      const stamp = computeFeedRetryAt(1, now);
      const minutes = diffMinutes(stamp, now);
      expect(minutes).toBeGreaterThanOrEqual(5 * 0.75);
      expect(minutes).toBeLessThanOrEqual(5 * 1.25);
    }
  });

  it("fail #2 lands ~15min ±25%", () => {
    for (let i = 0; i < 50; i++) {
      const minutes = diffMinutes(computeFeedRetryAt(2, now), now);
      expect(minutes).toBeGreaterThanOrEqual(15 * 0.75);
      expect(minutes).toBeLessThanOrEqual(15 * 1.25);
    }
  });

  it("fail #3 lands ~45min ±25%", () => {
    for (let i = 0; i < 50; i++) {
      const minutes = diffMinutes(computeFeedRetryAt(3, now), now);
      expect(minutes).toBeGreaterThanOrEqual(45 * 0.75);
      expect(minutes).toBeLessThanOrEqual(45 * 1.25);
    }
  });

  it("fail #4 lands at the cap of ~120min ±25%", () => {
    for (let i = 0; i < 50; i++) {
      const minutes = diffMinutes(computeFeedRetryAt(4, now), now);
      expect(minutes).toBeGreaterThanOrEqual(120 * 0.75);
      expect(minutes).toBeLessThanOrEqual(120 * 1.25);
    }
  });

  it("fail #10 stays capped at ~120min (no runaway growth)", () => {
    for (let i = 0; i < 20; i++) {
      const minutes = diffMinutes(computeFeedRetryAt(10, now), now);
      expect(minutes).toBeLessThanOrEqual(120 * 1.25);
    }
  });

  it("fail #1 with zero or negative counter still backs off", () => {
    // Defensive — caller increments BEFORE compute, so we should never
    // see 0 in production, but the helper should still produce a
    // sensible positive backoff.
    const stampZero = computeFeedRetryAt(0, now);
    const stampNeg = computeFeedRetryAt(-3, now);
    expect(diffMinutes(stampZero, now)).toBeGreaterThan(0);
    expect(diffMinutes(stampNeg, now)).toBeGreaterThan(0);
  });

  it("jitter actually varies output across calls", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 20; i++) samples.add(computeFeedRetryAt(3, now));
    // 20 calls × ~22min jitter span → expect at least 5 distinct stamps
    // (SQLite second resolution means duplicates do happen, just not
    // ALL of them).
    expect(samples.size).toBeGreaterThan(5);
  });

  it("returned stamp is in SQLite datetime format (no T, no Z)", () => {
    const stamp = computeFeedRetryAt(2, now);
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
