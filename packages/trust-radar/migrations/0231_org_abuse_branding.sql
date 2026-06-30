-- Tier 3 (abuse mailbox): per-org branding for the auto-responder
-- (ack + determination emails). Before this, every responder email was
-- hardcoded Averrow. This table lets an org present the report-fraud
-- inbox under its own name/logo/colours.
--
-- Scope note: the envelope From address stays on Averrow's authenticated
-- domain (abuse-noreply@averrow.com) for SPF/DKIM/DMARC deliverability —
-- only the display NAME, logo, colours, links and copy are branded. True
-- customer-domain sending (report.theirbrand.com) requires the customer
-- to delegate DNS/email-auth and is a separate track.
--
-- All override columns are nullable: a NULL (or an invalid value, caught
-- at load time) falls back to the Averrow default for that field, so a
-- partially-filled row is safe. enabled=0 ignores the row entirely.
CREATE TABLE IF NOT EXISTS org_abuse_branding (
  org_id          INTEGER PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 1,
  from_name       TEXT,   -- display name, e.g. "Acme Trust & Safety"
  product_name    TEXT,   -- email header text, e.g. "Acme"
  tagline         TEXT,   -- header subtitle, e.g. "Abuse Triage"
  accent_color    TEXT,   -- #RRGGBB accent stripe
  header_bg_color TEXT,   -- #RRGGBB header background
  logo_url        TEXT,   -- https-only logo image
  logo_alt        TEXT,   -- logo alt text
  subject_prefix  TEXT,   -- subject prefix before " · ", e.g. "Acme"
  website_url     TEXT,   -- https-only footer site link
  website_label   TEXT,
  report_url      TEXT,   -- https-only "report another threat" link
  report_label    TEXT,
  footer_note     TEXT,   -- footer descriptor after the site link
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
