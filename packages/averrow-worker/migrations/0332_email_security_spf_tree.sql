-- 0332_email_security_spf_tree.sql
-- SPF include-tree walk (src/lib/spf-record.ts + src/lib/spf-walk.ts, wired
-- in src/email-security.ts). The posture scanner now follows include: /
-- redirect= over DoH (hard caps: 25 queries, 4 s per walk) and counts DNS
-- lookups against RFC 7208's limit of 10 and void lookups against 2.
--
-- ADD COLUMN only, all nullable; older rows read NULL ("not captured"),
-- which every reader tolerates. No backfill: the next scan of each brand
-- writes them. spf_too_many_lookups (0020) stays and is still written —
-- since this change it is set only when the walk PROVES more than 10.
--
--   spf_lookup_count  INTEGER — DNS-querying terms across the include tree
--                               (lower bound when spf_walk_status='unknown')
--   spf_void_lookups  INTEGER — include/redirect targets that were NXDOMAIN
--                               or had no TXT answers (lower bound likewise)
--   spf_walk_status   TEXT    — complete | unknown | no_record | not_walked
--                               | root_error (the domain's own TXT lookup
--                               failed and no earlier scan could be carried
--                               forward; spf_exists is then written NULL,
--                               never a confirmed 0 — the column has no NOT
--                               NULL constraint, DEFAULT 0 only applies when
--                               the column is omitted)
--                               | carried_legacy (a root failure carried
--                               forward a pre-0332 scan with no walk data)
--   spf_findings      TEXT    — JSON array of {code, names?, count?};
--                               codes and validated DNS names only, never
--                               record text
--
-- The scoring rubric changed with it (EMAIL_SCORE_RUBRIC_VERSION 2 -> 3,
-- stored in score_rubric_version from 0328), so the first rescan of each
-- brand updates its grade without a grade-change alert.

ALTER TABLE email_security_scans ADD COLUMN spf_lookup_count INTEGER;
ALTER TABLE email_security_scans ADD COLUMN spf_void_lookups INTEGER;
ALTER TABLE email_security_scans ADD COLUMN spf_walk_status TEXT;
ALTER TABLE email_security_scans ADD COLUMN spf_findings TEXT;
