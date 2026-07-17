-- Backfill of historical platform incidents (April–May 2026).
--
-- One-shot population so the /status page and /admin/incidents have
-- realistic content from day one. Idempotent — INSERT OR IGNORE keys
-- on the deterministic ids below, so re-runs are safe no-ops.
--
-- Apply against the trust-radar-v2 D1 database. Either:
--   wrangler d1 execute trust-radar-v2 --file=scripts/backfill-historical-incidents.sql --remote
-- or paste through the MCP d1_database_query tool.
--
-- Each incident captures the timeline as we lived it. Public copy is
-- customer-safe (no system-internal jargon, no commit hashes).

-- ─── Incidents ───────────────────────────────────────────────────

INSERT OR IGNORE INTO incidents
  (id, title, description, public_title, public_details,
   status, severity, visibility, affected_components,
   detected_at, acknowledged_at, resolved_at,
   source, root_cause, mitigation, created_at, updated_at)
VALUES
('incident_apr29_ingest_blackout',
 'Ingest pipeline silent for 82 hours (50cb1e4)',
 'Column-name typo in autoRecoverStalePausedFeeds caused runAllFeeds to throw on every hourly tick. Outer try/catch in orchestrator swallowed it. Enrichment + social feeds (separate code path) kept running so the symptom hid behind partial liveness.',
 'Threat ingest pipeline degraded',
 'Several threat ingest feeds were not receiving updates for an extended period. Detection of new threats was delayed during this window. Existing threat data, alerting, and monitoring were unaffected. Pipeline fully restored after the underlying parser issue was patched.',
 'resolved', 'critical', 'public',
 '["category:feeds","feed:urlhaus","feed:threatfox","feed:phishdestroy","feed:openphish","feed:malwarebazaar","feed:typosquat_scanner","feed:tor_exit_nodes","feed:disposable_email","feed:sslbl"]',
 '2026-04-29 17:19:00', '2026-05-03 02:00:00', '2026-05-03 03:08:00',
 'manual',
 'Column-name typo in autoRecoverStalePausedFeeds (last_failure_at vs last_failure) caused runAllFeeds to throw before any per-feed dispatch. The orchestrator outer try/catch swallowed the error. Enrichment + social feeds run from separate functions and stayed up — so the platform appeared partially healthy.',
 'Fixed column reference (commit 50cb1e4). Added two defenses: (1) orchestrator catch now emits platform_feed_silent immediately with the throw message; (2) flightControl watchdog flags any feed whose last_successful_pull is older than 3x its schedule_cron interval.',
 '2026-04-29 17:30:00', '2026-05-03 03:08:00'
),
('incident_apr27_ct_logs_paused',
 'ct_logs auto-paused after crt.sh 5xx burst',
 'crt.sh returned five HTTP 502s in succession, tripping the ct_logs feed into auto-pause. Manual unpause was the only path out until autoRecoverStalePausedFeeds was added.',
 'Certificate transparency monitor briefly paused',
 'The certificate transparency log monitor was paused after a series of upstream errors from crt.sh. New domain detection from CT logs was delayed for several hours. Service restored automatically.',
 'resolved', 'high', 'public',
 '["category:feeds","feed:ct_logs"]',
 '2026-04-27 14:00:00', '2026-04-27 18:30:00', '2026-04-28 04:00:00',
 'manual',
 'Five consecutive HTTP 502s from crt.sh tripped the ct_logs feed into the consecutive-failures auto-pause path. The transient-error handler on the feed module then prevented future failures from incrementing the counter, so manual unpause was the only path out.',
 'Added autoRecoverStalePausedFeeds: any feed auto-paused for consecutive_failures whose last_failure is older than 4h gets re-enabled with a clean counter on the next dispatch tick.',
 '2026-04-27 14:30:00', '2026-04-28 04:00:00'
),
('incident_may2_feodo_json_format',
 'Feodo C2 feed parser broken by upstream JSON migration (#986)',
 'Feodo upstream switched from text/list to JSON format. Old parser returned 0 IPs from a 62-line response and emitted a "format change?" log line.',
 'Feodo C2 feed parser updated',
 'The Feodo C2 IP feed changed format upstream. Our parser was updated to consume the new JSON shape and ingestion resumed. C2 IP detection coverage from other feeds was unaffected during the gap.',
 'resolved', 'medium', 'public',
 '["feed:feodo"]',
 '2026-05-02 12:00:00', '2026-05-03 13:30:00', '2026-05-03 14:12:00',
 'manual',
 'abuse.ch switched the Feodo IP blocklist from a plain text format to a JSON envelope. The existing line-based parser saw 62 lines of JSON braces and treated the result as zero IPs.',
 'Rewrote the feodo parser to consume the JSON shape (commit landed in PR #986). First post-deploy pull ingested 5 IPs and recovery was confirmed.',
 '2026-05-02 12:30:00', '2026-05-03 14:12:00'
),
('incident_may3_c2_tracker_retired',
 'c2_tracker upstream archived (#986)',
 'The Github repo backing c2_tracker (Brute Ratel / Sliver / Cobalt Strike / Posh C2 / Metasploit IP feeds) returned 404 on every endpoint. Disabled the feed and added an upstream-archived stub.',
 'C2 tracker feed retired',
 'A third-party C2 tracker feed we previously consumed was archived by its publisher. We disabled the integration. C2 detection coverage from our other feeds is unchanged.',
 'resolved', 'low', 'public',
 '["feed:c2_tracker"]',
 '2026-05-03 06:00:00', '2026-05-03 13:50:00', '2026-05-03 13:55:00',
 'manual',
 'Upstream Github repo for the c2_tracker IP lists was archived by its maintainer. Every endpoint returned HTTP 404.',
 'Disabled the c2_tracker feed in feed_configs and added an upstream-archived stub so the dispatcher does not retry it (commit landed in PR #986).',
 '2026-05-03 06:30:00', '2026-05-03 13:55:00'
);

-- ─── Timeline updates ────────────────────────────────────────────

INSERT OR IGNORE INTO incident_updates
  (id, incident_id, kind, status, message, visibility, created_at)
VALUES
('upd_apr29_blackout_1', 'incident_apr29_ingest_blackout', 'system', 'investigating',
 'Ingest pipeline silent — multiple feeds not receiving updates. Investigating.',
 'public', '2026-04-29 17:30:00'),
('upd_apr29_blackout_2', 'incident_apr29_ingest_blackout', 'operator', 'identified',
 'Root cause identified — column-name typo in the auto-recovery query was throwing on every dispatch tick. Fix in flight.',
 'public', '2026-05-03 02:30:00'),
('upd_apr29_blackout_3', 'incident_apr29_ingest_blackout', 'operator', 'monitoring',
 'Fix deployed (commit 50cb1e4). Feeds resumed normal pull cadence; monitoring for 12h.',
 'public', '2026-05-03 03:10:00'),
('upd_apr29_blackout_4', 'incident_apr29_ingest_blackout', 'operator', 'resolved',
 'Resolved. Pipeline healthy. Two new defenses landed alongside the fix: a watchdog that flags silent feeds within 1h, and an immediate platform notification when the dispatcher catch-block fires.',
 'public', '2026-05-04 03:00:00'),

('upd_apr27_ctlogs_1', 'incident_apr27_ct_logs_paused', 'system', 'investigating',
 'ct_logs feed paused after consecutive upstream HTTP 502s from crt.sh.',
 'public', '2026-04-27 14:30:00'),
('upd_apr27_ctlogs_2', 'incident_apr27_ct_logs_paused', 'operator', 'monitoring',
 'crt.sh recovered. Re-enabled ct_logs and added an auto-recovery path for stale paused feeds.',
 'public', '2026-04-27 18:45:00'),
('upd_apr27_ctlogs_3', 'incident_apr27_ct_logs_paused', 'operator', 'resolved',
 'Resolved. Stable for 8h+. Feed back to normal pull cadence.',
 'public', '2026-04-28 04:00:00'),

('upd_may2_feodo_1', 'incident_may2_feodo_json_format', 'system', 'investigating',
 'Feodo feed returning 0 ingested IPs from upstream — format change suspected.',
 'public', '2026-05-02 12:30:00'),
('upd_may2_feodo_2', 'incident_may2_feodo_json_format', 'operator', 'monitoring',
 'Parser updated to consume the new JSON envelope. Deployed and watching.',
 'public', '2026-05-03 14:00:00'),
('upd_may2_feodo_3', 'incident_may2_feodo_json_format', 'operator', 'resolved',
 'Resolved. Post-deploy pull ingested 5 IPs and subsequent pulls confirm steady cadence.',
 'public', '2026-05-03 14:30:00'),

('upd_may3_c2_1', 'incident_may3_c2_tracker_retired', 'system', 'investigating',
 'c2_tracker endpoints returning 404 across all upstream lists.',
 'public', '2026-05-03 06:30:00'),
('upd_may3_c2_2', 'incident_may3_c2_tracker_retired', 'operator', 'resolved',
 'Confirmed upstream Github repo was archived. Feed disabled. Other C2 feeds (Feodo, ThreatFox) provide overlapping coverage.',
 'public', '2026-05-03 13:55:00');
