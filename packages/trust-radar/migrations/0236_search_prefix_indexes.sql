-- 0236_search_prefix_indexes.sql
--
-- Tier-1 unified search (GET /api/search) backing indexes.
--
-- The unified staff search endpoint runs prefix-anchored, case-
-- insensitive matches (name LIKE 'q%') across four entity tables.
-- SQLite only applies its LIKE-to-index optimization when the indexed
-- column's collation matches the LIKE operator's case sensitivity.
-- LIKE is case-insensitive by default, so a plain BINARY-collated index
-- is ignored and the query falls back to a full-table scan. Declaring
-- each index COLLATE NOCASE matches the case-insensitive LIKE, so SQLite
-- turns the prefix pattern into a bounded index range (name >= 'q' AND
-- name < 'r') and satisfies the lookup with an index range scan.
--
-- Additive only: CREATE INDEX IF NOT EXISTS, no DROP, no ALTER.
--
-- brands.canonical_domain already carries a BINARY unique index
-- (idx_brands_domain). That index cannot back a case-insensitive LIKE
-- either, so the brands `name LIKE ? OR canonical_domain LIKE ?` branch
-- would degrade the whole predicate to a full scan. A second NOCASE
-- index on canonical_domain lets SQLite run a multi-index OR (an index
-- range on each branch) instead. The existing unique index is left in
-- place untouched — this is an additional index only.
--
-- No index is added on the threats table — the search endpoint never
-- reads it.

CREATE INDEX IF NOT EXISTS idx_brands_name ON brands(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_brands_canonical_domain_nocase ON brands(canonical_domain COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_threat_actors_name ON threat_actors(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_hosting_providers_name ON hosting_providers(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_campaigns_name ON campaigns(name COLLATE NOCASE);
