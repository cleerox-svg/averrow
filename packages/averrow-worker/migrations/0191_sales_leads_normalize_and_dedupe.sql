-- 0191_sales_leads_normalize_and_dedupe.sql
--
-- Three-part cleanup of the sales_leads table:
--
-- 1. Normalize status strings — UI sends 'drafted' / 'meeting' but the
--    stats SQL and Pathfinder's re-creation filter were looking for
--    'outreach_drafted' / 'meeting_booked'. The mismatch caused
--    pipeline tile undercounts AND let Pathfinder re-insert brands
--    that already had a 'meeting' lead because its filter was checking
--    only 'meeting_booked'. Canonical short forms going forward.
--
-- 2. Dedupe — production has rows like Docusign x3, "coeensquarelogin"
--    x3, Grow x3 because createLead() has no idempotency. Keep one
--    row per brand_id, preferring active over rejected, AI-enriched
--    over unenriched, then highest prospect_score, then lowest id.
--
-- 3. Active-lead uniqueness — partial unique index on brand_id where
--    status is not a terminal state. New insertions go through a
--    NOT EXISTS guard in db/sales-leads.ts:createLead, so this index
--    is the belt-and-suspenders safety net (and a useful constraint
--    for any future ad-hoc INSERT path).

-- Part 1: normalize legacy status strings
UPDATE sales_leads SET status = 'drafted' WHERE status = 'outreach_drafted';
UPDATE sales_leads SET status = 'meeting' WHERE status = 'meeting_booked';

-- Part 2: dedupe — keep the "best" row per brand_id
DELETE FROM sales_leads
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY brand_id
             ORDER BY
               CASE WHEN status IN ('rejected','declined') THEN 1 ELSE 0 END ASC,
               ai_enriched DESC,
               prospect_score DESC,
               id ASC
           ) AS rn
    FROM sales_leads
  )
  WHERE rn = 1
);

-- Part 3: partial unique index. New creations atomically guard
-- against duplicates via WHERE NOT EXISTS in createLead, but if anyone
-- ever bypasses that path we want the database to refuse.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_leads_brand_active_unique
  ON sales_leads(brand_id)
  WHERE status NOT IN ('rejected','declined');
