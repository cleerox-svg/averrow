-- Sales-qualified Brand Risk Plan reports.
--
-- Generated on demand by an admin after a sales call qualifies a lead.
-- The report is a deeper, sharable artifact than the public-scan
-- /api/brand-scan/public response: includes full threat list,
-- infrastructure map, named threat actors, AI-generated remediation
-- plan, and ROI projection.
--
-- One row per generated report — re-running for the same lead writes
-- a new row so historical reports stay intact (audit + comparing
-- before/after over a sales cycle). Share tokens are random URL-safe
-- ids (not signed JWTs); presence + non-expired = access. Tokens
-- expire 30 days from generation by default.
--
-- payload_json holds the snapshotted data — threats, lookalikes,
-- email_security grade, infra clusters, narrative, plan, roi numbers.
-- Storing the full payload here means the share link is immune to
-- subsequent data drift (the report shows the world as it was when
-- the admin generated it).

CREATE TABLE IF NOT EXISTS qualified_reports (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  brand_domain  TEXT NOT NULL,
  share_token   TEXT NOT NULL UNIQUE,
  payload_json  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  generated_by  TEXT NOT NULL,
  view_count    INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (lead_id) REFERENCES scan_leads(id)
);

CREATE INDEX IF NOT EXISTS idx_qualified_reports_lead    ON qualified_reports(lead_id);
CREATE INDEX IF NOT EXISTS idx_qualified_reports_token   ON qualified_reports(share_token);
CREATE INDEX IF NOT EXISTS idx_qualified_reports_created ON qualified_reports(created_at DESC);
