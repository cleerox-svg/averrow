-- Expand seed addresses to cover both domains and increase trap surface area.
-- lrxradar.com is now a full honeypot domain; trustradar.ca gets generic/brand/employee traps.

-- ── lrxradar.com honeypot addresses ──────────────────────────────

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('contact@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com contact page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('info@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com homepage footer', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('support@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com contact page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('sales@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com contact page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('ceo@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('cto@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('sarah.chen@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('james.wilson@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('admin@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com hidden spider trap', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('billing@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com hidden spider trap', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('security@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com hidden spider trap', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('hr@lrxradar.com', 'lrxradar.com', 'honeypot', NULL, 'lrxradar.com hidden spider trap', 'active');

-- ── trustradar.ca generic traps ──────────────────────────────────

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('admin@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('info@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('support@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('billing@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('security@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('contact@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('help@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('sales@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('hr@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('finance@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('webmaster@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('postmaster@trustradar.ca', 'trustradar.ca', 'generic', NULL, 'Common address - catch-all', 'active');

-- ── trustradar.ca brand phishing traps ───────────────────────────

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('amazon-support@trustradar.ca', 'trustradar.ca', 'brand', NULL, 'Brand phishing bait', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('apple-id@trustradar.ca', 'trustradar.ca', 'brand', NULL, 'Brand phishing bait', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('google-security@trustradar.ca', 'trustradar.ca', 'brand', NULL, 'Brand phishing bait', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('microsoft-account@trustradar.ca', 'trustradar.ca', 'brand', NULL, 'Brand phishing bait', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('netflix-billing@trustradar.ca', 'trustradar.ca', 'brand', NULL, 'Brand phishing bait', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('paypal-support@trustradar.ca', 'trustradar.ca', 'brand', NULL, 'Brand phishing bait', 'active');

-- ── trustradar.ca employee traps ─────────────────────────────────

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('james.wilson@trustradar.ca', 'trustradar.ca', 'employee', NULL, 'Honeypot team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('sarah.chen@trustradar.ca', 'trustradar.ca', 'employee', NULL, 'Honeypot team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('ceo@trustradar.ca', 'trustradar.ca', 'employee', NULL, 'Honeypot team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('cfo@trustradar.ca', 'trustradar.ca', 'employee', NULL, 'Honeypot team page', 'active');

INSERT OR IGNORE INTO seed_addresses (address, domain, channel, brand_target, seeded_location, status)
VALUES ('cto@trustradar.ca', 'trustradar.ca', 'employee', NULL, 'Honeypot team page', 'active');
