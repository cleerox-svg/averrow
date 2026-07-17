-- Tier 1 (close the loop): link a lookalike_domains row to the takedown it
-- spawned, mirroring url_scan_results.takedown_id. Lets Sparrow's
-- createTakedownsFromLookalikes skip rows it has already actioned and lets
-- the lookalike UI show takedown status. Additive, nullable.
ALTER TABLE lookalike_domains ADD COLUMN takedown_id TEXT;
CREATE INDEX IF NOT EXISTS idx_lookalike_takedown ON lookalike_domains(takedown_id);
