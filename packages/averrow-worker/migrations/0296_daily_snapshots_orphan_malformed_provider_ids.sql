-- Migration 0296: merge orphaned "hp_AS<N> <name>" provider snapshots
--
-- Follow-up to 0294. Prod still held 80 daily_snapshots provider rows
-- (16 entity_ids × 5 days, 2026-04-30 … 2026-05-05) keyed by the legacy
-- spaced id form, e.g. 'hp_AS13335 Cloudflare, Inc.'. Their
-- hosting_providers rows were removed before 0294 ran, so 0294 (which
-- stages from hosting_providers) never saw them. Nothing reads them; the
-- canonical provider's history for those days is just short by their
-- counts.
--
-- Prod audit 2026-10-14 (read-only): every one of the 80 rows has a
-- canonical provider (hosting_providers.asn = the AS<digits> prefix) and a
-- canonical snapshot row for the same date. The values differ (e.g.
-- Cloudflare 2026-04-30: 11,608 active on the spaced id vs 31,409 on
-- hp_AS13335), i.e. they counted DISJOINT threat sets at snapshot time —
-- so they are merged by adding the counters, exactly like 0294 step 4b.
-- The canonical row keeps its own dominant_threat_type unless NULL.
--
-- Scope is deliberately limited to the spaced AS<digits> shape: the other
-- ~35K orphaned provider snapshots (2026-03-14 … 04-22) use name-derived
-- ('hp_03ai_ltd') or UUID ids with no ASN to map them by, and are left
-- alone.
--
-- Rows whose prefix maps to no hosting_providers row are left in place.
-- Idempotent: a second run finds no spaced rows. No BEGIN/COMMIT, no TEMP
-- table (D1 migration runner).

INSERT INTO daily_snapshots
  (date, entity_type, entity_id, new_threats, active_threats,
   remediated_threats, dominant_threat_type)
SELECT s.date, 'provider', h.id,
       SUM(s.new_threats), SUM(s.active_threats), SUM(s.remediated_threats),
       MAX(s.dominant_threat_type)
FROM daily_snapshots s
JOIN hosting_providers h
  ON h.asn = substr(s.entity_id, 4, instr(s.entity_id, ' ') - 4)
WHERE s.entity_type = 'provider'
  AND s.entity_id LIKE 'hp_AS% %'
  AND substr(s.entity_id, 4, instr(s.entity_id, ' ') - 4) GLOB 'AS[0-9]*'
  AND substr(s.entity_id, 4, instr(s.entity_id, ' ') - 4) NOT GLOB 'AS*[^0-9]*'
  AND h.id <> s.entity_id
GROUP BY s.date, h.id
ON CONFLICT(date, entity_type, entity_id) DO UPDATE SET
  new_threats          = daily_snapshots.new_threats + excluded.new_threats,
  active_threats       = daily_snapshots.active_threats + excluded.active_threats,
  remediated_threats   = daily_snapshots.remediated_threats + excluded.remediated_threats,
  dominant_threat_type = COALESCE(daily_snapshots.dominant_threat_type, excluded.dominant_threat_type);

DELETE FROM daily_snapshots
WHERE entity_type = 'provider'
  AND entity_id LIKE 'hp_AS% %'
  AND substr(entity_id, 4, instr(entity_id, ' ') - 4) GLOB 'AS[0-9]*'
  AND substr(entity_id, 4, instr(entity_id, ' ') - 4) NOT GLOB 'AS*[^0-9]*'
  AND EXISTS (
    SELECT 1 FROM hosting_providers h
    WHERE h.asn = substr(daily_snapshots.entity_id, 4, instr(daily_snapshots.entity_id, ' ') - 4)
      AND h.id <> daily_snapshots.entity_id
  );
