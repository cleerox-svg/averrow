-- api_quota_counters — atomic call-quota counters for paid / free-tier
-- external APIs (first user: the Google Web Risk Lookup API, uris.search,
-- lib/web-risk-lookup.ts).
--
-- One row per (bucket, period): e.g. ('web_risk_lookup:month', '2026-11'),
-- ('web_risk_lookup:contact_day', '2026-11-24'). A reservation is ONE
-- statement (INSERT … ON CONFLICT(bucket, period) DO UPDATE … RETURNING), so
-- concurrent callers can never be granted more than the cap between them —
-- the KV read-modify-write it replaces could, and KV's ~1 write/s/key limit
-- broke back-to-back reservations.
--   n          = calls reserved so far in the period (never refunded)
--   last_grant = calls granted by the most recent reservation (read back
--                through RETURNING; meaningless otherwise)
--
-- Core table (not telemetry). Rows are tiny and few (one per month per
-- bucket, one per day for daily buckets); no retention sweep needed yet.
-- Additive only.

CREATE TABLE IF NOT EXISTS api_quota_counters (
  bucket     TEXT    NOT NULL,
  period     TEXT    NOT NULL,
  n          INTEGER NOT NULL DEFAULT 0,
  last_grant INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, period)
);
