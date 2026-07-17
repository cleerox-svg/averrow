-- Add brand_match_method column to threats table.
-- Tracks how a threat was matched to a brand: 'keyword' (heuristic pre-match),
-- 'ai' (Haiku inference), or NULL (not yet matched / legacy).
ALTER TABLE threats ADD COLUMN brand_match_method TEXT;
