/**
 * FC silent-ingest watchdog — "silent" vs "failing" regression tests.
 *
 * Production 2026-09-11: `platform_feed_silent` fired 9× in a day naming
 * `nrd_hagezi` as "528.5× overdue" while the same platform's diagnostics
 * reported that feed as `enabled: false, paused_reason:
 * auto:consecutive_failures`. Both were true at different minutes:
 * `autoRecoverStalePausedFeeds` (lib/feedRunner.ts:585) un-pauses an
 * auto-paused feed 4 h after its last failure, so a permanently-dead
 * upstream ping-pongs enabled → 5 failures → paused → enabled forever. In
 * each enabled window the watchdog's candidate query matched it
 * (enabled=1, paused_reason IS NULL, ancient last_successful_pull) and it
 * double-reported a feed that was already alarmed by the degraded /
 * at-risk / auto-paused stages.
 *
 * The fix: a recent `last_failure` means the dispatcher IS reaching the
 * feed, so it is failing loudly, not silently.
 *
 * Second cut (F6): "recent" is measured against the feed's OWN interval,
 * not a fixed 3 h window. The fixed window could never close the hole it
 * existed for — `autoRecoverStalePausedFeeds` un-pauses a feed only once
 * its last failure is ≥4 h old, i.e. already outside a 3 h window — and it
 * regressed for any feed coarser than hourly, which is not re-dispatched
 * (and so cannot fail again) for hours after being un-paused.
 */

import { describe, it, expect } from "vitest";
import {
  computeSilentFeedRatio,
  SILENT_RATIO_THRESHOLD,
  DISPATCHER_CADENCE_MS,
} from "../src/agents/flightControl";

const NOW = Date.parse("2026-09-11T18:00:00Z");

/** SQLite `datetime('now')` shape — no zone marker, implicitly UTC. */
function sqlTs(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString().replace("T", " ").slice(0, 19);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("computeSilentFeedRatio", () => {
  it("reports a feed that has not pulled in 3×+ its interval", () => {
    const ratio = computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(5 * HOUR),
      lastFailure: null,
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    });
    expect(ratio).toBeCloseTo(5, 5);
  });

  it("stays quiet just under the ratio threshold", () => {
    expect(computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(SILENT_RATIO_THRESHOLD * HOUR - 60_000),
      lastFailure: null,
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    })).toBeNull();
  });

  it("does NOT report a feed that failed recently — that is loud, not silent", () => {
    // The nrd_hagezi shape: 22 days since the last success (528× overdue at
    // the 60-min dispatcher floor) but failing every hour right now.
    expect(computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(22 * DAY),
      lastFailure: sqlTs(1 * HOUR),
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    })).toBeNull();
  });

  it("resumes reporting once failures stop arriving (dispatch really did stop)", () => {
    const ratio = computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(22 * DAY),
      lastFailure: sqlTs(SILENT_RATIO_THRESHOLD * HOUR + 60_000),
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    });
    expect(ratio).not.toBeNull();
    expect(ratio!).toBeGreaterThan(SILENT_RATIO_THRESHOLD);
  });

  it("treats an old failure from before the last success as irrelevant", () => {
    const ratio = computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(10 * HOUR),
      lastFailure: sqlTs(30 * HOUR),
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    });
    expect(ratio).toBeCloseTo(10, 5);
  });

  it("honors a coarser-than-hourly interval (a 6h feed is not silent at 5h)", () => {
    expect(computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(5 * HOUR),
      lastFailure: null,
      effectiveIntervalMs: 6 * HOUR,
      nowMs: NOW,
    })).toBeNull();
  });

  // ── F6: the auto-recovery window is LONGER than any fixed
  // recent-failure window can be, so "recent" has to be per-feed.
  //
  // Scenario: a `0 */6 * * *` feed auto-paused at 02:00 and auto-recovered
  // at 06:07 (autoRecoverStalePausedFeeds fires at last_failure + 4 h). It
  // is enabled=1 / paused_reason IS NULL again but `runAllFeeds` will not
  // select it until its next cron slot at 12:00, so it CANNOT fail again
  // in between. Under the old fixed 3 h window every FC tick from 07:07 to
  // 11:07 saw a 5-9 h-old failure, declared the feed silent, and re-fired
  // the alert the window was added to suppress.
  describe("6h-cadence feed inside the auto-recovery gap", () => {
    const SIX_HOURS = 6 * HOUR;

    // FC ticks at :07 every hour; the feed is not due again until 12:00.
    for (const [tick, hoursSinceFailure] of [
      ["07:07", 5],
      ["08:07", 6],
      ["09:07", 7],
      ["10:07", 8],
      ["11:07", 9],
    ] as const) {
      it(`stays quiet at ${tick} (${hoursSinceFailure}h after the last failure)`, () => {
        expect(computeSilentFeedRatio({
          lastSuccessfulPull: sqlTs(22 * DAY),
          lastFailure: sqlTs(hoursSinceFailure * HOUR),
          effectiveIntervalMs: SIX_HOURS,
          nowMs: NOW,
        })).toBeNull();
      });
    }

    it("reports once contact ages past 3× the feed's own interval", () => {
      // 18 h with no dispatch of any kind on a 6 h feed — the dispatcher
      // really has stopped, which is what the watchdog is for.
      const ratio = computeSilentFeedRatio({
        lastSuccessfulPull: sqlTs(22 * DAY),
        lastFailure: sqlTs(18 * HOUR + 60_000),
        effectiveIntervalMs: SIX_HOURS,
        nowMs: NOW,
      });
      expect(ratio).not.toBeNull();
      expect(ratio!).toBeGreaterThan(SILENT_RATIO_THRESHOLD);
    });

    it("still quotes the ratio from the last successful pull, not last contact", () => {
      // Operator-facing text says "has not PULLED in N× its interval", so
      // the number must stay anchored to last_successful_pull even though
      // the silent/loud gate uses the contact clock.
      const ratio = computeSilentFeedRatio({
        lastSuccessfulPull: sqlTs(10 * DAY),
        lastFailure: sqlTs(19 * HOUR),
        effectiveIntervalMs: SIX_HOURS,
        nowMs: NOW,
      });
      expect(ratio).toBeCloseTo((10 * DAY) / SIX_HOURS, 5);
    });
  });

  it("accepts ISO timestamps as well as SQLite's space-separated form", () => {
    const iso = new Date(NOW - 5 * HOUR).toISOString();
    expect(computeSilentFeedRatio({
      lastSuccessfulPull: iso,
      lastFailure: null,
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    })).toBeCloseTo(5, 5);
  });

  it("reads a zone-less timestamp as UTC, not local time", () => {
    // A naive Date.parse of "YYYY-MM-DD HH:MM:SS" is local-time in some
    // runtimes, which would skew the ratio by the host's UTC offset.
    const ratio = computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(4 * HOUR),
      lastFailure: null,
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    })!;
    expect(ratio).toBeCloseTo(4, 5);
  });

  it("ignores an unparseable last_successful_pull instead of alerting on NaN", () => {
    expect(computeSilentFeedRatio({
      lastSuccessfulPull: "not-a-timestamp",
      lastFailure: null,
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    })).toBeNull();
  });

  it("ignores an unparseable last_failure rather than suppressing the alert", () => {
    const ratio = computeSilentFeedRatio({
      lastSuccessfulPull: sqlTs(22 * DAY),
      lastFailure: "garbage",
      effectiveIntervalMs: DISPATCHER_CADENCE_MS,
      nowMs: NOW,
    });
    expect(ratio).not.toBeNull();
  });
});
