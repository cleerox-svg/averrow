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
import { applyReapPenalty } from "./feedRunner";

/** Minimum age for a partial row to be considered orphaned. */
export const REAP_AGE_MINUTES = 15;

const REAP_ERROR =
  `reaped by navigator: pull row stuck partial > ${REAP_AGE_MINUTES}min — worker likely terminated mid-run`;

/** Returns the number of rows reaped. Never throws. */
export async function reapOrphanFeedPullHistory(env: Env): Promise<number> {
  try {
    // Both sides of the comparison MUST go through `datetime()` so the
    // engine compares parsed timestamps, not raw strings. feedRunner
    // inserts `started_at` via `new Date().toISOString()` ("…T20:11:49.957Z")
    // while `datetime('now', ...)` returns "YYYY-MM-DD HH:MM:SS" with a
    // space separator. Naive string comparison fails because 'T' (0x54)
    // sorts ABOVE ' ' (0x20), so an ISO-format `started_at` is always
    // lexically greater than any space-format threshold — this is what
    // left 13 reapable orphans visible in production despite the reaper
    // running every 5 min for hours. Wrapping the LHS in datetime()
    // forces SQLite to coerce both into the same canonical representation.
    //
    // RETURNING feed_name gives us EXACTLY the rows this statement reaped —
    // not a separate pre-scan SELECT. That matters for the breaker penalty
    // below: a pre-scan would have a TOCTOU window where a stuck pull could
    // finalize to 'success' (via runFeed's retry) or be reaped by an
    // overlapping Navigator tick between the scan and the UPDATE, and we'd
    // then wrongly penalize / auto-pause a feed that didn't actually get
    // reaped here. Penalizing only the returned rows closes that window.
    const result = await env.DB.prepare(
      `UPDATE feed_pull_history
          SET status = 'failed',
              completed_at = datetime('now'),
              error_message = COALESCE(
                error_message,
                '${REAP_ERROR}'
              )
        WHERE status = 'partial'
          AND completed_at IS NULL
          AND datetime(started_at) <= datetime('now', '-${REAP_AGE_MINUTES} minutes')
        RETURNING feed_name`,
    ).all<{ feed_name: string }>();

    const reapedRows = result.results ?? [];

    // Advance the circuit breaker once per DISTINCT feed that was actually
    // reaped here, so worker-killed death-loops back off + eventually
    // auto-pause instead of staying silently overdue. Best-effort per
    // feed; never blocks the reap.
    for (const feedName of new Set(reapedRows.map((r) => r.feed_name))) {
      await applyReapPenalty(env, feedName, REAP_ERROR);
    }

    return reapedRows.length;
  } catch (err) {
    console.error("[feed-pull-reaper] orphan reap failed:", err);
    return 0;
  }
}
