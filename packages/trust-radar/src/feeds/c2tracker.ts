import type { FeedModule, FeedContext, FeedResult } from "./types";

/**
 * C2 Tracker — Command & Control server IPs (montysecurity/C2-Tracker).
 *
 * **PAUSED 2026-05-03 — UPSTREAM ARCHIVED.**
 *
 * The montysecurity/C2-Tracker GitHub repo was archived. README states:
 *   "This project has been archived. The text files in `data/` have been
 *    removed and are no longer updated."
 * All 6 source URLs (Cobalt Strike, Sliver, Brute Ratel, Metasploit, Posh C2,
 * Havoc) return HTTP 404. Set `feed_configs.enabled = 0` with
 * `paused_reason = 'manual:upstream_archived'`.
 *
 * The module is kept in the registry so `runAllFeeds` skips it cleanly
 * (matching `feedModules[name]` returns this stub instead of `undefined`).
 * If a maintained mirror surfaces, replace the body with the per-framework
 * URL fetch loop and flip feed_configs.enabled back to 1. The previous
 * implementation is in git history at HEAD~ for reference.
 *
 * Defensive: if a future operator re-enables this feed without restoring
 * a working source, we want a clear "go fix the source" message in
 * feed_pull_history rather than six HTTP 404 lines.
 */
export const c2_tracker: FeedModule = {
  async ingest(_ctx: FeedContext): Promise<FeedResult> {
    throw new Error(
      "c2_tracker upstream archived (montysecurity/C2-Tracker no longer publishes data/). " +
      "Replace the source list in c2tracker.ts before re-enabling feed_configs.enabled=1.",
    );
  },
};
