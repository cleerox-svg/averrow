-- Backfill: enroll every org-assigned brand into the monitoring watchlist.
--
-- The dark-web + app-store scanners select brands via
--   brands ⨝ monitored_brands ⨝ brand_monitor_schedule
-- but handleAssignOrgBrand only ever wrote org_brands, so tenant-assigned
-- brands (e.g. the Acme test org's brands) were never monitored by those
-- scanners. Going forward, handleAssignOrgBrand enrolls on assignment; this
-- migration backfills the brands already assigned before that change.
--
-- monitored_brands.added_by is NOT NULL REFERENCES users(id); we attribute
-- the backfill to an existing super_admin, matching the existing 815
-- '__internal__' watchlist rows. INSERT OR IGNORE keeps it idempotent
-- (PK is brand_id + tenant_id). The scanners' own needsSeed step creates
-- the per-platform brand_monitor_schedule rows on their next tick.

INSERT OR IGNORE INTO monitored_brands (brand_id, tenant_id, added_by, status)
SELECT DISTINCT ob.brand_id,
       '__internal__',
       (SELECT id FROM users WHERE role = 'super_admin' ORDER BY id LIMIT 1),
       'active'
FROM org_brands ob
WHERE EXISTS (SELECT 1 FROM users WHERE role = 'super_admin');
