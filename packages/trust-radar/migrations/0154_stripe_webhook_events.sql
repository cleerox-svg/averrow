-- Stripe webhook idempotency table.
--
-- Stripe sometimes re-delivers events (network blips, our worker
-- timing out before responding 200). Without an idempotency check
-- a re-delivery would double-process the lifecycle change. Stripe
-- gives every event a unique `event.id` (`evt_xxxxx`); we store
-- it on first successful process and skip on re-delivery.
--
-- Append-only audit table — every event lands here even if the
-- handler is a no-op for that event type. Lets ops correlate
-- "what did Stripe send us at 14:32 yesterday?" without scraping
-- worker logs.
--
-- v3 Phase D Stripe sprint 4.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id     TEXT PRIMARY KEY,                -- Stripe's evt_xxx; their idempotency key
  event_type   TEXT NOT NULL,                   -- e.g. customer.subscription.updated
  api_version  TEXT,                            -- Stripe API version that produced the event
  livemode     INTEGER NOT NULL DEFAULT 0,      -- 1 = live, 0 = test
  org_id       INTEGER,                         -- if the handler resolved this event to an org
  status       TEXT NOT NULL DEFAULT 'received',
                                                -- 'received' | 'processed' | 'noop' | 'failed'
  error        TEXT,                            -- error message if status='failed'
  raw_payload  TEXT,                            -- first 4096 chars of the body for forensics
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received
  ON stripe_webhook_events(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type
  ON stripe_webhook_events(event_type, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_org
  ON stripe_webhook_events(org_id, received_at DESC)
  WHERE org_id IS NOT NULL;
