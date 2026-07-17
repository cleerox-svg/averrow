-- 0158_brand_firmographics.sql
-- Sibling table for firmographic data (revenue, employees, industry,
-- founded year, public-company status).
--
-- Why a sibling table, not columns on `brands`:
--   1. Refresh cadence — Tranco rank changes weekly; firmographic
--      data changes quarterly at most. Different update cadences
--      shouldn't share a row.
--   2. Source-swappability — the v3 research evaluated Apollo (~$3-5K
--      for 100K records), ZoomInfo (~$300K), Clearbit/Breeze (~$10K
--      but requires HubSpot tenancy). We rejected paid sources and
--      use free public data exclusively (SEC EDGAR, Companies House,
--      Wikidata, Wikipedia, brand-website scraper, Pathfinder AI
--      piggyback). If we ever swap providers, the schema doesn't churn
--      — we add rows with new `source` values.
--   3. Sparse coverage — 30-50% of brands stay null on these fields.
--      Keeping them off `brands` avoids polluting the main table with
--      low-coverage columns + indexes that mostly hold null.
--
-- HQ country / lat / lng / IP stay on `brands` (added in migration 0066
-- by the RDAP enricher path) — those come from technical signals, not
-- firmographic feeds.

CREATE TABLE IF NOT EXISTS brand_firmographics (
  brand_id              TEXT PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  revenue_band          TEXT,                     -- '<10M' | '10-50M' | '50-250M' | '250M-1B' | '1B+' | NULL
  employee_band         TEXT,                     -- '<50' | '50-250' | '250-1K' | '1K-10K' | '10K+' | NULL
  industry_naics        TEXT,                     -- NAICS 6-digit, e.g. '522110' = Commercial Banking
  industry_sic          TEXT,                     -- SIC 4-digit (legacy alongside NAICS)
  founded_year          INTEGER,
  is_public             INTEGER,                  -- 0 | 1 | NULL
  ticker                TEXT,                     -- 'GOOGL' for public companies
  parent_company        TEXT,                     -- free-text human-readable; structural parent_id lives on brands
  source                TEXT NOT NULL,            -- 'sec_edgar' | 'companies_house' | 'wikidata' | 'wikipedia' | 'website_scraper' | 'pathfinder_ai' | 'customer'
  source_url            TEXT,
  confidence            INTEGER NOT NULL DEFAULT 50
                          CHECK (confidence BETWEEN 0 AND 100),
  enriched_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brand_firmographics_revenue  ON brand_firmographics(revenue_band);
CREATE INDEX IF NOT EXISTS idx_brand_firmographics_industry ON brand_firmographics(industry_naics);
CREATE INDEX IF NOT EXISTS idx_brand_firmographics_source   ON brand_firmographics(source);
