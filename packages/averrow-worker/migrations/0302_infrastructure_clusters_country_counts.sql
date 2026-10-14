-- 0302 — infrastructure_clusters.country_counts (NEXUS cluster-quality fix).
--
-- Additive only. No column is dropped, altered or rewritten.
--
-- JSON object {CC: n} of the cluster's member threats per ISO-2 country,
-- top 20 by volume (key order = rank). Written by every NEXUS threats lane
-- (lib/nexus-threat-lanes.ts) from the lane's existing grouped scan — the
-- `countries` array says WHERE, this says HOW MUCH. It replaces the habit of
-- treating the first entry of an unordered GROUP_CONCAT(DISTINCT
-- country_code) as the operation's country (the old "CA AS13335 …" names).
--
-- NULL until the next NEXUS run refreshes a row; app-store / dark-web
-- clusters (no country dimension) stay NULL. Retired rows (retired_reason
-- 'superseded' / 'shared_infra', migration 0303) are never refreshed and
-- stay NULL.

ALTER TABLE infrastructure_clusters ADD COLUMN country_counts TEXT;
