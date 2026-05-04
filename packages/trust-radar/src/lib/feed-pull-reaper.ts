// Feed Pull History Orphan Reaper
//
// `feedRunner.runFeed` inserts a `feed_pull_history` row with
// `status='partial'` before calling the feed module, then flips it to
// 'success' or 'failed' inside a try/catch. If the worker is killed
// mid-run — CPU ceiling, subrequest ceiling, wall-clock timeout — the
// JS try/catch never resolves, the row stays at `partial` with
// `completed_at IS NULL` forever, and `feed_status.consecutive_failures`
// never advances (so auto-pause never kicks in for whatever's
// systematically timing out).
//
// No JS-layer pattern can address this — once the worker is terminated
// no user code runs, including any `finally` block. The only correct
// architecture is an external sweeper.
//
// Navigator runs every 5 min, so it owns this responsibility (the same
// way it owns the agent_events drain). Anything stuck >15 min is by
// definition not actively running — Cloudflare's hard wall-clock cap
// for sub-hour cron handlers is 30 s, plus we add headroom for the
// longest legitimate ingest path (cartographer email-security RDAP
// loops can run ~2-3 min worst-case).
//
// Tested via `test/feed-pull-reaper.test.ts`.

import type { Env } from "../types";

/** Minimum age for a partial row to be considered orphaned. */
export const REAP_AGE_MINUTES = 15;

/** Returns the number of rows reaped. Never throws. */
export async function reapOrphanFeedPullHistory(env: Env): Promise<number> {
  try {
    const result = await env.DB.prepare(
      `UPDATE feed_pull_history
          SET status = 'failed',
              completed_at = datetime('now'),
              error_message = COALESCE(
                error_message,
                'reaped by navigator: pull row stuck partial > ${REAP_AGE_MINUTES}min — worker likely terminated mid-run'
              )
        WHERE status = 'partial'
          AND completed_at IS NULL
          AND started_at <= datetime('now', '-${REAP_AGE_MINUTES} minutes')`,
    ).run();
    return result.meta?.changes ?? 0;
  } catch (err) {
    console.error("[feed-pull-reaper] orphan reap failed:", err);
    return 0;
  }
}
