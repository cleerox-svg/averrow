-- 0315: partial indexes for Strategist's "active, not yet in a campaign"
-- lookups (agents/strategist.ts).
--
-- Prod (2026-11-02, threats ≈1.51M, ~1.19M active with campaign_id IS
-- NULL): every unclustered lookup planned via idx_threats_campaign
-- (campaign_id=?). sqlite_stat1 averages ~240 rows per campaign_id value
-- and cannot see that NULL holds ~80% of the table, so the planner walked
-- ~1.2M rows per statement:
--   Strategy-1 IP GROUP BY ........................ 2,018,626 rows read
--   Strategy-2 registrar GROUP BY (7-day) ......... 1,195,570
--   per-registrar campaign_id UPDATE (≤10/run) ... ~1.2M each
--   fallback COUNT(DISTINCT ip_address / registrar)  ~1.19M each
--
-- Each index's WHERE is exactly the queries' no-campaign predicate, so a
-- threat leaves the index the moment it is assigned to a campaign or stops
-- being active — the index only ever holds Strategist's work set.
-- SQLite uses a partial index only when the query's WHERE contains the
-- index's WHERE terms literally; the queries do. (Named "no_campaign", not
-- "unclustered", to stay distinct from NEXUS cluster_id indexes such as
-- idx_threats_asn_type_unclustered.)
--
-- Neither index is chosen by the planner on its own, with or without
-- ANALYZE stats (it prefers idx_threats_campaign / idx_threats_status_created),
-- so the queries pin them with INDEXED BY through
-- lib/indexed-by-fallback.ts: a missing index or a WHERE that drifts off
-- the partial predicate re-runs the query unhinted instead of failing.
--
-- `status` and `campaign_id` are trailing key columns even though the
-- partial WHERE fixes their values: SQLite (3.53) does not treat terms
-- implied by a partial index's WHERE as covered, so without them every
-- entry would pay a table lookup. They cost ~7 bytes per entry.
--
-- idx_threats_no_campaign_ip: Strategy-1 groups ALL eligible IPs, so it
-- still reads every entry — but as a covering, ip-ordered scan (no table
-- lookups, no GROUP BY temp b-tree) over only active+unclustered+has-IP
-- rows instead of every campaign_id IS NULL row plus its table row. The
-- per-IP assignment UPDATE (ip_address = ? ... campaign_id IS NULL) also
-- seeks it naturally (previously idx_threats_ip_source_feed; both seek).
--
-- idx_threats_no_campaign_registrar: created_at first so the 7-day window
-- is a range seek; registrar second so the per-registrar UPDATE filters on
-- the index entry inside that range.
--
-- Write cost: one extra index entry per active unclustered threat with an
-- IP / registrar (insert, DNS backfill setting ip_address, WHOIS setting
-- registrar), and one removal when a threat is clustered or goes inactive.
--
-- Additive only; idempotent.
CREATE INDEX IF NOT EXISTS idx_threats_no_campaign_ip
  ON threats(ip_address, source_feed, threat_type, status, campaign_id)
  WHERE ip_address IS NOT NULL AND status = 'active' AND campaign_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_threats_no_campaign_registrar
  ON threats(created_at, registrar, status, campaign_id)
  WHERE registrar IS NOT NULL AND status = 'active' AND campaign_id IS NULL;
