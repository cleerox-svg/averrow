-- Spamhaus DROP → JSON, and Spamhaus ASN-DROP as a reference feed.
--
-- 1. spamhaus_drop now reads drop_v4.json (feeds/spamhausDrop.ts). eDROP
--    was merged into DROP on 2024-04-10 (edrop.txt is a comment-only stub)
--    and Spamhaus has announced the deprecation of the .txt formats. The
--    CIDR set is unchanged (drop.txt and drop_v4.json held the same 1,759
--    ranges on 2026-11-14), so threat ids are stable. Refresh the row's
--    display name / source / description, which also carries the credit
--    Spamhaus requires for use in a product.
--
-- 2. spamhaus_asn_drop (feeds/spamhausAsnDrop.ts): daily asndrop.json →
--    one row per ASN. Reference metadata, NOT threats: never gates alert
--    triage, never creates alerts. `asn` is the canonical `AS<digits>` key
--    produced by asnKey() (lib/shared-infra-asns.ts). removed_at is set when
--    an ASN disappears from a complete pull and cleared if it is relisted.
--    list_timestamp (unix seconds) + list_copyright keep the list's date and
--    © text with the data, as the Spamhaus terms ask.
--
-- Additive only: new table + index, an UPDATE of one feed_configs row's
-- descriptive columns, and one feed_configs/feed_status seed.

CREATE TABLE IF NOT EXISTS spamhaus_asn_drop (
  asn             TEXT PRIMARY KEY,          -- 'AS12345' (asnKey)
  asn_number      INTEGER NOT NULL,
  as_name         TEXT,
  as_domain       TEXT,
  country_code    TEXT,
  rir             TEXT,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  removed_at      TEXT,                      -- NULL = currently listed
  list_timestamp  INTEGER,
  list_copyright  TEXT
);

-- Listed-only partial index: readers ask "is this ASN listed now".
CREATE INDEX IF NOT EXISTS idx_spamhaus_asn_drop_listed
  ON spamhaus_asn_drop (asn) WHERE removed_at IS NULL;

UPDATE feed_configs
   SET display_name = 'Spamhaus DROP',
       source_url   = 'https://www.spamhaus.org/drop/drop_v4.json',
       description  = 'Hijacked or criminal-operated IPv4 network ranges (CIDR blocks) used for spam, malware and botnets, from drop_v4.json (eDROP was merged into DROP in April 2024). Source: The Spamhaus Project, Spamhaus DROP List (c) The Spamhaus Project SLU, https://www.spamhaus.org/drop/ - free for commercial use with credit to The Spamhaus Project.'
 WHERE feed_name = 'spamhaus_drop';

-- schedule_cron is a poll INTERVAL (parseCronIntervalMs, lib/feedRunner.ts):
-- '0 5 * * *' = every 24h, dispatched from the hourly orchestrator's
-- runAllFeeds. Spamhaus asks for at most one automated fetch per hour.
INSERT INTO feed_configs (feed_name, display_name, description, source_url, enabled, schedule_cron, feed_type, rate_limit, batch_size)
VALUES ('spamhaus_asn_drop', 'Spamhaus ASN-DROP',
  'Autonomous System Numbers operated by spammers or cyber criminals, or hijacked. Reference metadata for hosting providers and ASN evidence; writes spamhaus_asn_drop, not threats. Source: The Spamhaus Project, Spamhaus ASN-DROP List (c) The Spamhaus Project SLU, https://www.spamhaus.org/drop/ - free for commercial use with credit to The Spamhaus Project.',
  'https://www.spamhaus.org/drop/asndrop.json', 1, '0 5 * * *', 'ingest', 60, 500)
ON CONFLICT(feed_name) DO NOTHING;

INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES ('spamhaus_asn_drop', 'healthy');
