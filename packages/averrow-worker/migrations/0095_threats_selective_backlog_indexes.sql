-- Partial indexes for selective enrichment backlog queries.
--
-- Context: Flight Control's backlog counts and the enrichment agents that
-- pull candidate rows both filter on _checked columns plus a severity or
-- ip_address predicate. Without an index they full-scan the 174K-row
-- threats table. Migration 0094 caches the counter results, which alone
-- cuts the read volume on the monitoring path. These indexes additionally
-- cut the cost of the recompute itself AND speed up the agent queries
-- that read candidate rows (not just counts).
--
-- Selectivity rule for what gets an index here:
--   * Only indexed when the predicate matches a small fraction of the
--     table (severity='critical/high' is ~15%, ip_address IS NOT NULL is
--     ~50%). SURBL, DBL, GSB, SecLookup all match >50% of the table and
--     a partial index on them would still scan most rows — they're
--     handled by the counter cache (0094) instead.
--
-- Cartographer Phase 0 is also covered here: 58K of 174K rows (34%) match
-- the enrichment predicate, making the partial index a ~3x scan reduction
-- on every Cartographer tick.
--
-- Write amplification note: each INSERT/UPDATE to threats that touches
-- (severity, ip_address, malicious_domain, enriched_at, or the _checked
-- column) writes a row to the matching partial index. At ~5-10M
-- writes/month total on threats, write cost is negligible (<$10/month)
-- compared to the read savings on the agent fetch queries.

-- Cartographer Phase 0: unenriched threats with a public-ish IP.
-- Aligned with measureBacklogs() and the cartographer dispatch query.
-- id-only payload because the caller always follows up with a targeted
-- fetch by id, so the index just needs to identify candidates cheaply.
CREATE INDEX IF NOT EXISTS idx_threats_carto_phase0
  ON threats(id)
  WHERE enriched_at IS NULL
    AND ip_address IS NOT NULL
    AND ip_address != ''
    AND status = 'active';

-- VirusTotal pending: only critical/high with a domain. Severity filter
-- is restrictive enough that the partial index is a big win.
CREATE INDEX IF NOT EXISTS idx_threats_vt_pending
  ON threats(first_seen DESC)
  WHERE vt_checked = 0
    AND severity IN ('critical', 'high')
    AND malicious_domain IS NOT NULL;

-- Passive DNS pending: same shape as VT.
CREATE INDEX IF NOT EXISTS idx_threats_pdns_pending
  ON threats(first_seen DESC)
  WHERE pdns_checked = 0
    AND severity IN ('critical', 'high')
    AND malicious_domain IS NOT NULL;

-- GreyNoise pending: critical/high with an IP. Double selectivity filter.
CREATE INDEX IF NOT EXISTS idx_threats_greynoise_pending
  ON threats(first_seen DESC)
  WHERE greynoise_checked = 0
    AND severity IN ('critical', 'high')
    AND ip_address IS NOT NULL;

-- AbuseIPDB pending: all unchecked IPs (no severity filter). ~50% of
-- rows have an IP, so the index isn't as tight as the ones above but
-- still halves the scan cost.
CREATE INDEX IF NOT EXISTS idx_threats_abuseipdb_pending
  ON threats(first_seen DESC)
  WHERE abuseipdb_checked = 0
    AND ip_address IS NOT NULL;
