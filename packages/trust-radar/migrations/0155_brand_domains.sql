-- 0155_brand_domains.sql
-- Owned-domain footprint per brand. v3 §9.6 Surface tab needs this:
-- the canonical_domain column on `brands` only holds one domain, but a
-- real brand owns many — apex, subdomains, ccTLDs, redirect parking,
-- acquired properties.
--
-- Distinct from `brand_safe_domains` (0015), which is narrower —
-- explicit exclusions to suppress impersonation matching. brand_domains
-- is the broader inventory of "what we know this brand owns."
--
-- Populated by:
--   1. Tranco import — apex only, type='apex'
--   2. CT log scanner — subdomains seen on certs, type='subdomain'
--   3. Customer onboarding — manually added owned, type='customer_added'
--   4. RDAP enricher — registrar/parking detection, type='redirect'
--   5. Acquisition signals from public web (defer) — type='acquired_property'
--
-- Used by:
--   - BrandDetail v3 Surface tab — render full owned-domain list
--   - Brand match backfill — wider domain matching for impersonation
--     detection (a phishing site mimicking aws.amazon.com matches
--     Amazon's brand because aws.amazon.com is on the brand)

CREATE TABLE IF NOT EXISTS brand_domains (
  id              TEXT PRIMARY KEY,
  brand_id        TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  domain          TEXT NOT NULL,
  domain_type     TEXT NOT NULL CHECK (domain_type IN (
    'apex', 'subdomain', 'redirect', 'regional', 'acquired_property', 'customer_added'
  )),
  source          TEXT NOT NULL,                 -- 'tranco' | 'ct_log' | 'rdap' | 'customer' | 'manual'
  verified        INTEGER NOT NULL DEFAULT 0,    -- 0 = candidate, 1 = confirmed
  first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_domains_brand_domain ON brand_domains(brand_id, domain);
CREATE INDEX IF NOT EXISTS idx_brand_domains_domain ON brand_domains(domain);
CREATE INDEX IF NOT EXISTS idx_brand_domains_brand ON brand_domains(brand_id);
CREATE INDEX IF NOT EXISTS idx_brand_domains_type ON brand_domains(domain_type);
CREATE INDEX IF NOT EXISTS idx_brand_domains_verified ON brand_domains(verified);

-- Backfill existing brands' canonical_domain as their apex entry. Idempotent
-- via NOT EXISTS guard — re-running this migration is safe.
INSERT INTO brand_domains (id, brand_id, domain, domain_type, source, verified, first_seen, last_seen)
SELECT
  'bd_' || b.id || '_apex',
  b.id,
  b.canonical_domain,
  'apex',
  'backfill',
  1,
  COALESCE(b.first_seen, datetime('now')),
  COALESCE(b.first_seen, datetime('now'))
FROM brands b
WHERE NOT EXISTS (
  SELECT 1 FROM brand_domains bd WHERE bd.brand_id = b.id AND bd.domain = b.canonical_domain
);
