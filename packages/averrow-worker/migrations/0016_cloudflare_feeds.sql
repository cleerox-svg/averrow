-- Cloudflare Radar feed setup: scanner + email security
--
-- Backfill note (fresh-bootstrap fix): cf_scan_id / cf_verdict / cf_categories
-- were originally added to prod OUT-OF-BAND (no migration ever created them),
-- so this migration's index below assumed columns that a fresh
-- `d1 migrations apply` never creates → bootstrap died here with
-- "no such column: cf_scan_id". The three ADD COLUMNs below capture that
-- out-of-band change so a fresh local/staging DB is self-contained.
-- This is prod-safe: wrangler tracks applied migrations by filename in
-- d1_migrations, so prod (which already recorded 0016) never re-runs this
-- file and never re-executes these ALTERs. Only environments applying 0016
-- fresh — which by definition lack the columns — run them. Plain ADD COLUMN
-- (matches the codebase pattern, e.g. 0093) because SQLite has no
-- ADD COLUMN IF NOT EXISTS.

-- ─── Backfill out-of-band Cloudflare scanner columns ────────────
ALTER TABLE threats ADD COLUMN cf_scan_id TEXT;
ALTER TABLE threats ADD COLUMN cf_verdict TEXT;
ALTER TABLE threats ADD COLUMN cf_categories TEXT;

-- ─── Index for CF Scanner polling ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_threats_cf_scan ON threats(cf_scan_id) WHERE cf_scan_id IS NOT NULL;

-- ─── Register Cloudflare feeds in feed_configs ──────────────────
INSERT OR IGNORE INTO feed_configs (feed_name, display_name, description, source_url, schedule_cron, rate_limit, batch_size, enabled) VALUES
  ('cloudflare_scanner', 'Cloudflare URL Scanner', 'Two-phase URL scanner: submit unscanned threat URLs, poll for verdicts and confidence adjustment', 'https://api.cloudflare.com/client/v4/accounts/', '*/30 * * * *', 10, 20, 1),
  ('cloudflare_email',   'Cloudflare Email Security', 'Daily email threat intelligence from Cloudflare Radar (spam, spoof, malicious, categories)', 'https://api.cloudflare.com/client/v4/radar/email/security/', '0 6 * * *', 10, 4, 1);

-- ─── Register feed_status entries ───────────────────────────────
INSERT OR IGNORE INTO feed_status (feed_name, health_status) VALUES
  ('cloudflare_scanner', 'healthy'),
  ('cloudflare_email',   'healthy');
