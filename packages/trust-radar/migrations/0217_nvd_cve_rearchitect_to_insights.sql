-- nvd_cve re-architecture: CVEs move from `threats` to `agent_outputs` insights.
--
-- Background:
--   Migration 0173 (2026-05-12) disabled nvd_cve and purged its rows because
--   the module wrote CVEs to `threats` with threat_type='malicious_ip'
--   (a CVE is not an IP) — polluting every geo/provider/severity aggregate.
--   The feed was meant to stay off until re-architected to write
--   agent_outputs insights (the feeds/cisa_kev.ts convention).
--
--   An operator manually re-enabled the feed around 2026-06-06 without the
--   module being fixed, so it re-polluted `threats` with ~3,300 mis-typed
--   'malicious_ip' CVE rows AND began flapping on NVD's frequent HTTP 503s
--   (degraded -> auto-pause -> auto-recover -> re-fail), spamming operator
--   alerts.
--
-- This migration finishes the re-architecture now that feeds/nvd_cve.ts has
-- been rewritten to write agent_outputs insights with bounded 503 retry:
--   1. Purge the mis-typed CVE rows from `threats` (same cleanup 0173 did).
--   2. Clear any stale auto-pause / disable state so the breaker starts clean.
--      The feed stays ENABLED — it now writes to the correct table.

-- 1. Purge the polluting CVE rows from the threats table.
DELETE FROM threats WHERE source_feed = 'nvd_cve';

-- 2. Keep the feed enabled, clear any stale pause reason from the prior
--    disable / auto-pause cycles. (No-op if already enabled with NULL reason.)
UPDATE feed_configs
   SET enabled = 1,
       paused_reason = NULL,
       updated_at = datetime('now')
 WHERE feed_name = 'nvd_cve';

-- 3. Reset the circuit-breaker counters so the feed re-enters the rotation
--    healthy rather than carrying the 503-streak that caused the flapping.
UPDATE feed_status
   SET health_status = 'healthy',
       consecutive_failures = 0,
       next_retry_at = NULL,
       last_error = NULL
 WHERE feed_name = 'nvd_cve';
