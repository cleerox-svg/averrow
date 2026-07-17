-- Phase D: Webhook configuration columns for organizations
ALTER TABLE organizations ADD COLUMN webhook_events TEXT;           -- JSON array of subscribed event types
ALTER TABLE organizations ADD COLUMN webhook_failures_24h INTEGER DEFAULT 0;
ALTER TABLE organizations ADD COLUMN webhook_last_success TEXT;
ALTER TABLE organizations ADD COLUMN webhook_last_failure TEXT;
