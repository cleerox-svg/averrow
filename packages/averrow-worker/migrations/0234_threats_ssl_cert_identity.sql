-- 0234_threats_ssl_cert_identity.sql
-- SSL certificate identity retention on threats (NEXUS Lane C).
--
-- Both certificate-transparency sources (crt.sh REST poller in
-- feeds/certstream.ts and the calidog WebSocket in
-- durableObjects/CertStreamMonitor.ts) parse cert issuer / serial / SAN
-- set at ingest and then discard them. NEXUS Lane C clusters
-- impersonation domains that share a certificate identity (one serial
-- reused across >= 2 impersonation domains, or one SAN set hashing
-- identically), which is a near-conclusive same-operator signal. That
-- lane needs the cert fields persisted on the threat row.
--
-- These are NEW, threats-owned columns. Do NOT confuse them with the
-- identically-named ssl_cert_issuer on phishing_pattern_signals
-- (migration 0023) — that belongs to the spam-trap pipeline, not here.
--
-- Additive only — ADD COLUMN, never DROP/ALTER. Every non-cert feed
-- leaves all three NULL and keeps working unchanged.

ALTER TABLE threats ADD COLUMN ssl_cert_serial TEXT;
ALTER TABLE threats ADD COLUMN ssl_cert_issuer TEXT;
ALTER TABLE threats ADD COLUMN ssl_san_hash TEXT;

-- Partial indexes: the vast majority of threats carry no cert identity,
-- so index only the sparse populated rows. These back the Lane C
-- GROUP BY ssl_cert_serial / GROUP BY ssl_san_hash correlation passes.
CREATE INDEX IF NOT EXISTS idx_threats_ssl_cert_serial
  ON threats(ssl_cert_serial)
  WHERE ssl_cert_serial IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_threats_ssl_san_hash
  ON threats(ssl_san_hash)
  WHERE ssl_san_hash IS NOT NULL;
