import { describe, it, expect } from "vitest";
import {
  dueToleranceMs,
  shouldRunNow,
  type FeedConfigRow,
  type FeedStatusRow,
} from "../src/lib/feedRunner";

// Regression for prod 2026-10-22: last_successful_pull is stamped at pull
// COMPLETION (e.g. nvd_cve finishing at :10), while the orchestrator tick
// checks at :07. The fixed 60 s tolerance made hourly feeds skip every
// other tick.

function cfg(schedule_cron: string): FeedConfigRow {
  return {
    feed_name: "f",
    display_name: "f",
    source_url: null,
    schedule_cron,
    rate_limit: 0,
    batch_size: 0,
    retry_count: 0,
    enabled: 1,
  };
}

function status(lastPull: string | null, nextRetryAt: string | null = null): FeedStatusRow {
  return {
    feed_name: "f",
    last_successful_pull: lastPull,
    health_status: "healthy",
    next_retry_at: nextRetryAt,
  };
}

const MIN = 60_000;

describe("dueToleranceMs", () => {
  it("keeps the 60 s floor for 5-minute feeds", () => {
    expect(dueToleranceMs(5 * MIN)).toBe(60_000);
  });
  it("scales with the interval", () => {
    expect(dueToleranceMs(30 * MIN)).toBe(6 * MIN);
    expect(dueToleranceMs(60 * MIN)).toBe(12 * MIN);
  });
  it("caps at 20 min, well under the hourly dispatch cadence", () => {
    expect(dueToleranceMs(2 * 60 * MIN)).toBe(20 * MIN);
    expect(dueToleranceMs(24 * 60 * MIN)).toBe(20 * MIN);
  });
});

describe("shouldRunNow — due check", () => {
  it("hourly feed that completed at :10 is due at the next :07 tick", () => {
    // SQLite datetime('now') format, no zone
    const s = status("2026-10-22 04:10:11");
    expect(shouldRunNow(cfg("0 * * * *"), s, new Date("2026-10-22T05:07:00Z"))).toBe(true);
  });

  it("hourly feed that completed at :17 (late pool slot) is due at :07", () => {
    const s = status("2026-10-22 04:17:00");
    expect(shouldRunNow(cfg("0 * * * *"), s, new Date("2026-10-22T05:07:30Z"))).toBe(true);
  });

  it("6-hourly feed completing at :10 is due at the 6h-later :07 tick", () => {
    const s = status("2026-10-21T03:09:58Z");
    expect(shouldRunNow(cfg("0 */6 * * *"), s, new Date("2026-10-21T09:07:00Z"))).toBe(true);
  });

  it("2-hourly feed completing at :20 is due when the next due tick reaches it at :13", () => {
    const s = status("2026-10-21 12:20:34");
    expect(shouldRunNow(cfg("0 */2 * * *"), s, new Date("2026-10-21T14:13:00Z"))).toBe(true);
  });

  it("hourly feed that ran 20 min ago is NOT due", () => {
    const s = status("2026-10-22 04:47:00");
    expect(shouldRunNow(cfg("0 * * * *"), s, new Date("2026-10-22T05:07:00Z"))).toBe(false);
  });

  it("2-hourly feed is NOT due one tick early (~1h elapsed)", () => {
    const s = status("2026-10-22 04:09:00");
    expect(shouldRunNow(cfg("0 */2 * * *"), s, new Date("2026-10-22T05:07:00Z"))).toBe(false);
  });

  it("5-minute feed keeps the 60 s tolerance", () => {
    const now = new Date("2026-10-22T05:07:00Z");
    // 4 min elapsed = interval − 60 s → due
    expect(shouldRunNow(cfg("*/5 * * * *"), status("2026-10-22 05:03:00"), now)).toBe(true);
    // 3m59s elapsed → not due
    expect(shouldRunNow(cfg("*/5 * * * *"), status("2026-10-22 05:03:01"), now)).toBe(false);
  });

  it("future next_retry_at still blocks even when the interval has elapsed", () => {
    const s = status("2026-10-22 02:00:00", "2026-10-22 05:30:00");
    expect(shouldRunNow(cfg("0 * * * *"), s, new Date("2026-10-22T05:07:00Z"))).toBe(false);
  });

  it("past next_retry_at falls through to the interval check", () => {
    const s = status("2026-10-22 02:00:00", "2026-10-22T05:00:00Z");
    expect(shouldRunNow(cfg("0 * * * *"), s, new Date("2026-10-22T05:07:00Z"))).toBe(true);
  });

  it("no status row / never succeeded → due", () => {
    const now = new Date("2026-10-22T05:07:00Z");
    expect(shouldRunNow(cfg("0 * * * *"), undefined, now)).toBe(true);
    expect(shouldRunNow(cfg("0 * * * *"), status(null), now)).toBe(true);
  });
});
