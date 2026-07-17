-- 0235_threats_ip_subnet24_generated.sql
-- Index-backed /24 subnet key for the NEXUS subnet-correlation lane.
--
-- Perf hotfix. The NEXUS /24 lane derived its subnet key at query time as
-- rtrim(ip_address, '0123456789'). Because that wraps the column in a
-- function, no index on ip_address was usable in either the GROUP BY or
-- the per-cluster stamp predicate, so both fell back to a full scan of
-- ~691K threats, six times a day. Live D1 stats: the stamp predicate
-- alone read ~50.5M rows / 24h (~8.2% of daily reads); the companion
-- GROUP BY added ~13M more.
--
-- Fix: materialise the exact same key as a VIRTUAL generated column and
-- index it. VIRTUAL (not STORED) is the only kind addable via ALTER TABLE
-- ADD COLUMN, and it is metadata-only — zero existing rows are rewritten,
-- so this is safe to apply while the account is near its D1 ceiling. Only
-- the partial index build touches storage, once.
--
-- Equivalence: for every row that qualified for the subnet lane's grouping
-- today (ip_address non-null, IPv4, not '' / '0.0.0.0'), the column value
-- equals rtrim(ip_address, '0123456789') byte-for-byte — same SQLite
-- function, same argument. For the excluded rows (NULL, IPv6, or the two
-- sentinel literals) the column is NULL, which is exactly the set the old
-- lane's WHERE guards removed. The partial index is sparse (IPv4-only).
--
-- Additive only — ADD COLUMN, never DROP/ALTER. Non-IPv4 rows leave the
-- column NULL and every other lane keeps working unchanged.

ALTER TABLE threats ADD COLUMN ip_subnet24 TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN ip_address IS NOT NULL
       AND ip_address NOT LIKE '%:%'
       AND ip_address NOT IN ('', '0.0.0.0')
      THEN rtrim(ip_address, '0123456789')
    END
  ) VIRTUAL;

-- Partial index: the column is NULL for every non-IPv4 row, so index only
-- the populated (IPv4) rows. Backs both the subnet lane's grouping scan
-- and, decisively, the per-cluster stamp's equality seek (ip_subnet24 = ?)
-- which was the single most expensive query on the platform.
CREATE INDEX IF NOT EXISTS idx_threats_subnet24
  ON threats(ip_subnet24)
  WHERE ip_subnet24 IS NOT NULL;
