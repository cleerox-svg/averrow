-- Migration 0290: Phishing page capture queue + evidence index
-- (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md).
--
-- Additive only: one new table, its indexes, and the agent_approvals
-- grandfather row for the new `page_capture` AgentModule.
--
-- page_captures — one row per headless-browser capture attempt of a
-- suspected fake login page. The worker (agents/pageCapture.ts →
-- lib/page-capture.ts, dedicated cron `*/10 * * * *`) claims `queued`
-- rows, renders them with Cloudflare Browser Rendering, stores the
-- desktop/mobile PNG + rendered HTML + meta.json in the private R2 bucket
-- `averrow-phish-captures`, and records the SHA-256 of every object here.
-- `expires_at = captured_at + 180 days`; the daily sweep marks the row
-- `expired` and nulls its keys (R2 lifecycle deletes the objects).
--
-- Columns beyond the spec's list:
--   `claimed_at`  — when the row last moved `queued` → `capturing`; the
--                   reaper keys on it (stuck > 15 min).
--   `target_key`  — normalized target (lowercased host + path, no query /
--                   fragment); auto-enqueue skips a target captured in the
--                   last 7 days, so the same page reported under several
--                   threats (e.g. CertStream duplicates across CT logs) is
--                   rendered once.
--   `meta_sha256` — SHA-256 of the stored meta.json.

CREATE TABLE IF NOT EXISTS page_captures (
  id                     TEXT PRIMARY KEY,
  threat_id              TEXT,
  target_url             TEXT NOT NULL,
  target_key             TEXT,
  status                 TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','capturing','captured','failed','blocked','expired')),
  attempts               INTEGER NOT NULL DEFAULT 0,
  requested_by           TEXT,
  final_url              TEXT,
  http_status            INTEGER,
  page_title             TEXT,
  redirect_chain_json    TEXT,
  form_action_hosts_json TEXT,
  desktop_key            TEXT,
  mobile_key             TEXT,
  html_key               TEXT,
  desktop_sha256         TEXT,
  mobile_sha256          TEXT,
  html_sha256            TEXT,
  meta_sha256            TEXT,
  html_bytes             INTEGER,
  error                  TEXT,
  anti_bot_wall          TEXT,
  queued_at              TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at             TEXT,
  captured_at            TEXT,
  expires_at             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Claim queue: `status = 'queued' ORDER BY queued_at`.
CREATE INDEX IF NOT EXISTS idx_page_captures_status_queued
  ON page_captures(status, queued_at);

-- Detail endpoint (newest 5 per threat) + the auto-enqueue
-- "never captured before" probe.
CREATE INDEX IF NOT EXISTS idx_page_captures_threat_created
  ON page_captures(threat_id, created_at);

-- Auto-enqueue target dedup: `target_key = ? AND created_at >= ?`.
CREATE INDEX IF NOT EXISTS idx_page_captures_target_created
  ON page_captures(target_key, created_at);

-- At most ONE open (queued|capturing) capture per threat. Enqueue is
-- INSERT OR IGNORE … WHERE NOT EXISTS, so a race on this index is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_captures_one_open
  ON page_captures(threat_id)
  WHERE status IN ('queued','capturing');

-- Retention sweep: `status IN ('captured','blocked') AND expires_at < ?`
-- → (status=?, expires_at<?) range per status instead of walking every
-- stored row via (status, queued_at).
CREATE INDEX IF NOT EXISTS idx_page_captures_status_expiry
  ON page_captures(status, expires_at);

-- page_capture_targets — every threat auto-enqueued for a target_key, incl.
-- the ones the 7-day target dedup SKIPPED. On capture success the evidence
-- linker attaches the screenshot to the takedowns of ALL threats sharing the
-- capture's target_key (not just the capturing threat). PK serves the
-- `target_key = ?` lookup; rows older than 14 days are purged by the daily
-- capture sweep (idx on created_at).
CREATE TABLE IF NOT EXISTS page_capture_targets (
  target_key TEXT NOT NULL,
  threat_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (target_key, threat_id)
);
CREATE INDEX IF NOT EXISTS idx_page_capture_targets_created
  ON page_capture_targets(created_at);

-- Grandfather the new AgentModule (same guarded upsert as 0246 — a bare
-- INSERT OR IGNORE would leave a 'pending' row created by an early cron
-- tick in place and the agent blocked; see migration 0238).
INSERT INTO agent_approvals (
  agent_id, state, requested_at, reviewed_at, reviewed_by, reviewer_notes
)
VALUES
  ('page_capture', 'approved', datetime('now'), datetime('now'), 'system_grandfather',
   'Phishing page capture — new AgentModule on dedicated cron */10 * * * * (owner-approved 2026-10-12, docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md). See agents/pageCapture.ts + lib/page-capture.ts.')
ON CONFLICT(agent_id) DO UPDATE SET
  state          = 'approved',
  reviewed_at    = datetime('now'),
  reviewed_by    = 'system_grandfather',
  reviewer_notes = excluded.reviewer_notes,
  updated_at     = datetime('now')
WHERE agent_approvals.state != 'approved';
