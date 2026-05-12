-- Trust Radar — Stride 2: STIX/TAXII consumer
--
-- Adds the per-feed config for a generic TAXII 2.1 client. Each
-- TAXII collection we subscribe to becomes a single feed_configs
-- row whose feed_name is `taxii_<server>` (e.g. `taxii_otx`,
-- `taxii_circl`). The runtime handler is feeds/taxii.ts — one
-- module shared across all TAXII collections, dispatched by
-- feed_name in feeds/index.ts.
--
-- Cursor model: TAXII 2.1's `added_after` query param + the
-- `X-TAXII-Date-Added-Last` response header lets us do
-- incremental pulls without server-side state. We persist the
-- last successful `X-TAXII-Date-Added-Last` (or response
-- timestamp) in taxii_next_added_after so the next tick only
-- fetches new objects. Safe to reset to NULL to re-pull
-- everything (the threat dedup helpers in feedRunner handle
-- the existing-row case).
--
-- Auth: only `none` and `basic` for v1. Most public TAXII
-- servers (CIRCL, EclecticIQ, AlienVault OTX, Anomali STAXX
-- mirrors) accept either anonymous access or HTTP Basic with
-- a static credential. OAuth/JWT will land in a later
-- migration if we ever need it.

-- ─── feed_configs additions ──────────────────────────────────────

ALTER TABLE feed_configs ADD COLUMN taxii_root_url           TEXT;
ALTER TABLE feed_configs ADD COLUMN taxii_collection_id      TEXT;
ALTER TABLE feed_configs ADD COLUMN taxii_auth_type          TEXT;
ALTER TABLE feed_configs ADD COLUMN taxii_username           TEXT;
ALTER TABLE feed_configs ADD COLUMN taxii_api_key_env        TEXT;
ALTER TABLE feed_configs ADD COLUMN taxii_next_added_after   TEXT;

-- ─── Seed: AlienVault OTX TAXII 2.1 collection ───────────────────
--
-- OTX exposes a full TAXII 2.1 root at /taxii/2.1 — far higher
-- throughput than the v1 REST `pulses/subscribed` endpoint we
-- currently use as `otx_alienvault`. The TAXII firehose
-- collection ID is documented in the OTX docs and stays stable.
-- Auth is the same OTX_API_KEY secret we already store; the
-- TAXII server accepts it as `Authorization: Bearer <key>`,
-- which we treat as auth_type=basic for now and re-use the
-- header in lib/taxii-client.ts.
--
-- Rationale for keeping the REST OTX feed alongside this one:
-- the REST endpoint surfaces pulse-level adversary metadata
-- (threat actor attribution, targeted countries, ATT&CK IDs)
-- that the TAXII firehose strips off — we preserve the
-- existing attribution pipeline in feeds/otx_alienvault.ts
-- while ALSO ingesting the higher-volume IOC firehose here.
INSERT OR IGNORE INTO feed_configs (
  feed_name, display_name, description, source_url,
  schedule_cron, batch_size, rate_limit, enabled,
  taxii_root_url, taxii_collection_id, taxii_auth_type,
  taxii_api_key_env
) VALUES (
  'taxii_otx',
  'AlienVault OTX (TAXII 2.1)',
  'OTX full-firehose IOC stream via STIX/TAXII 2.1 — complements the REST otx_alienvault pulse feed.',
  'https://otx.alienvault.com/taxii/2.1/',
  '0 * * * *',
  500,
  60,
  1,
  'https://otx.alienvault.com/taxii/2.1/',
  'user_AlienVault',
  'bearer',
  'OTX_API_KEY'
);
