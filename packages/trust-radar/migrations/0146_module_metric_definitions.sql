-- 0146_module_metric_definitions.sql
-- Catalogue of what each module measures. Drives both the
-- customer-facing "you've used X of Y this month" display AND any
-- future SKU/usage-billing model. v3 Phase A foundation.
--
-- Pattern mirrors `agent_budget_rollups` (single-row read) so usage
-- queries stay cost-aware. See `lib/module-usage.ts` for the writer
-- + KV-cached reader.

CREATE TABLE module_metric_definitions (
  module_key   TEXT NOT NULL,
  metric_key   TEXT NOT NULL,
  label        TEXT NOT NULL,            -- customer-facing label
  unit         TEXT NOT NULL,            -- 'count', 'mb', 'usd', 'seconds'
  is_billable  INTEGER NOT NULL DEFAULT 0,  -- 1 if a future SKU could bill on this
  description  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (module_key, metric_key)
);

-- Seed the canonical metric set for the 7 v3 modules. Add metrics
-- here as new measurements get instrumented; the framework reads
-- definitions, not hardcoded enums.

INSERT INTO module_metric_definitions (module_key, metric_key, label, unit, is_billable, description) VALUES
  -- Domain Monitoring
  ('domain', 'lookalikes_detected',     'Lookalike domains detected',      'count', 0, 'Typosquats / homoglyphs / brand-keyword variations found.'),
  ('domain', 'malicious_urls_active',   'Malicious URLs active',           'count', 0, 'URLs scoped to brand currently flagged across feeds.'),
  ('domain', 'takedowns_submitted',     'Takedowns submitted',             'count', 1, 'Domain-scope takedown requests sent to providers.'),
  -- Social Media Impersonation
  ('social', 'impersonators_detected',  'Impersonator profiles detected',  'count', 0, 'Fake profiles, executive impersonations, brand-misuse handles.'),
  ('social', 'profiles_monitored',      'Profiles monitored',              'count', 1, 'Distinct profile + platform handles tracked for the brand.'),
  ('social', 'takedowns_submitted',     'Takedowns submitted',             'count', 1, 'Social-platform takedown requests sent.'),
  -- App Store Impersonation
  ('app_store', 'fake_apps_detected',   'Fake apps detected',              'count', 0, 'Apps flagged across Apple, Google Play, alternative stores.'),
  ('app_store', 'stores_covered',       'Stores covered',                  'count', 0, 'Stores actively scanned for this tenant''s brands.'),
  ('app_store', 'takedowns_submitted',  'Takedowns submitted',             'count', 1, 'App-store takedown requests sent.'),
  -- Dark Web Monitoring
  ('dark_web', 'mentions_detected',     'Mentions detected',               'count', 0, 'Brand or executive mentions surfaced from dark/deep web sources.'),
  ('dark_web', 'execs_monitored',       'Executives monitored',            'count', 1, 'Executive identities on the watchlist (auto-discovered + curated).'),
  ('dark_web', 'leaks_confirmed',       'Confirmed credential leaks',      'count', 0, 'Verified leaked credentials affecting the tenant.'),
  -- Abuse Mailbox
  ('abuse_mailbox', 'reports_received', 'Reports received',                'count', 1, 'Inbound abuse reports forwarded to the tenant''s alias.'),
  ('abuse_mailbox', 'reports_classified','Reports classified',             'count', 0, 'Reports successfully parsed + classified by the platform.'),
  ('abuse_mailbox', 'auto_responses_sent','Auto-responses sent',           'count', 0, 'Acknowledgement + determination emails sent on the tenant''s behalf.'),
  -- Trademark Infringement
  ('trademark', 'matches_detected',     'Matches detected',                'count', 0, 'Logo / wordmark / likeness matches surfaced.'),
  ('trademark', 'assets_registered',    'Trademark assets registered',     'count', 1, 'Logos / wordmarks the tenant has on record for matching.'),
  ('trademark', 'takedowns_submitted',  'Takedowns submitted',             'count', 1, 'Trademark-scope takedown requests sent.'),
  -- Threat-Actor Intelligence
  ('threat_actor', 'actors_targeting',  'Actors targeting your brand',     'count', 0, 'Unique threat actors with detections attributed to your tenant.'),
  ('threat_actor', 'pivots_observed',   'Pivots observed',                 'count', 0, 'Provider / ASN / kit changes detected against attributed actors.'),
  ('threat_actor', 'kits_fingerprinted','Phish kits fingerprinted',        'count', 0, 'Distinct kit fingerprints attributed to actors targeting you.');
