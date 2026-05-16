-- 0189_brand_firmographics_buying_signals.sql
--
-- Add "buying signals" columns to brand_firmographics so the sales
-- pipeline can answer: does this brand show evidence of caring about
-- the problem Averrow solves? Three free-data signals, all attributable
-- to a public source:
--
--   1. last_breach_disclosed_at — most recent breach disclosure for this
--      brand. Populated from news_watcher when an article matching the
--      brand domain mentions a breach. Strong buy-signal: a brand that
--      just disclosed an incident is procuring detection capability.
--
--   2. last_security_news_at + security_news_headline/url — most recent
--      security-relevant news mention. Lower-confidence than (1) but
--      catches "hired CISO", "expanded SOC", "investing in security"
--      narratives that imply active budget.
--
--   3. cyber_10k_mentions + cyber_10k_filed_at — count of "cybersecurity"
--      / "ransomware" / "data breach" / "phishing" mentions in the
--      brand's most recent 10-K Item 1C. Public companies have disclosed
--      cybersecurity risk in 10-K Item 1C since 2023 (SEC rule
--      33-11216). A high count means the board considers it material —
--      i.e. the budget signal is already on the record.
--
-- All three fields stay null for brands where we don't have data;
-- the UI hides empty rows.

ALTER TABLE brand_firmographics ADD COLUMN last_breach_disclosed_at TEXT;
ALTER TABLE brand_firmographics ADD COLUMN last_security_news_at TEXT;
ALTER TABLE brand_firmographics ADD COLUMN security_news_headline TEXT;
ALTER TABLE brand_firmographics ADD COLUMN security_news_url TEXT;
ALTER TABLE brand_firmographics ADD COLUMN cyber_10k_mentions INTEGER;
ALTER TABLE brand_firmographics ADD COLUMN cyber_10k_filed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_brand_firmographics_breach
  ON brand_firmographics(last_breach_disclosed_at)
  WHERE last_breach_disclosed_at IS NOT NULL;
