-- 0001_init.sql: threat archive index (averrow-archive)
--
-- Index of threats archived to R2 (bucket binding THREAT_ARCHIVE). One row
-- per archived threat id; the evidence body lives in the R2 object under
-- its shard_key. Nothing reads or writes this DB yet: the archiver lands in
-- a later PR. ARCHIVE_DB is optional (prod + staging only), so every future
-- caller must handle the binding being absent.

CREATE TABLE IF NOT EXISTS threat_archive_index (
  id          TEXT PRIMARY KEY,
  shard_key   TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  last_status TEXT,
  created_at  TEXT,
  last_seen   TEXT
);

CREATE INDEX IF NOT EXISTS idx_threat_archive_index_shard
  ON threat_archive_index(shard_key);
