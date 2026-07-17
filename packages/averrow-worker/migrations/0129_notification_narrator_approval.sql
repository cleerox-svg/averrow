-- ─── Backlog B4 — approve notification_narrator agent ─────────────
--
-- New sync agent introduced in this PR (Q5b from the
-- NOTIFICATIONS_AUDIT.md backlog). Runs at hour===13 alongside the
-- legacy briefing cron and emits per-user notification_digest
-- envelopes.
--
-- Mirrors the row shape from migration 0126.

INSERT OR IGNORE INTO agent_approvals (
  agent_id, state, requested_at, reviewed_at, reviewed_by, reviewer_notes
)
VALUES
  ('notification_narrator', 'approved', datetime('now'), datetime('now'), 'system_grandfather', 'B4 — Q5b digest builder, AI-summarised per-user daily digest');
