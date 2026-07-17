-- PR-AS — Raw capture for abuse_inbox_messages
--
-- Adds full-fidelity capture for forwarded suspicious emails so the
-- drill-down UI (and downstream AI analyzers) can inspect the full
-- body, every header, the dereferenced URL list, and attachment
-- filenames. Counts (url_count, attachment_count) and the 500-char
-- snippet (original_body_snippet) stay — they remain the list-view
-- columns. The new heavy fields are fetched on demand via the
-- per-message detail endpoint, not the list.
--
-- All five columns are NULLable. Pre-PR-AS rows will continue to
-- show counts + snippet only; the drill-down UI handles the "raw
-- capture not available" empty state gracefully.
--
-- Storage caps enforced in the email handler:
--   raw_body          256 KB
--   raw_headers       64 KB (JSON object of all RFC822 headers)
--   extracted_urls    32 KB (JSON array, cap 200 entries)
--   attachment_names  16 KB (JSON array, cap 50 entries)
-- D1 per-row limit is 1 MB, so worst case ~368 KB leaves room.
--
-- Why ALTER TABLE additive and not a new table:
--   - One-row-per-message stays one query for the detail panel
--   - No JOIN cost on drill-down
--   - All fields scoped to the same lifecycle (created/deleted together)
--   - Per CLAUDE.md §8: ALTER TABLE ADD COLUMN is the platform pattern

ALTER TABLE abuse_inbox_messages ADD COLUMN raw_body         TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN raw_headers      TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN extracted_urls   TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN attachment_names TEXT;
ALTER TABLE abuse_inbox_messages ADD COLUMN raw_size_bytes   INTEGER;
