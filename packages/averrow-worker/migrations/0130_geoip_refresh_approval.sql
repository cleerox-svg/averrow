-- ─── Phase 3 GeoIP Refresh — grandfather as approved ─────────────
--
-- AGENT_STANDARD §12.1 requires every new agent_id to have a row
-- in agent_approvals before the runner will execute it. Without
-- this row the runner creates a 'pending' state on first
-- invocation and blocks the run, surfacing "1 pending" on the
-- Agents admin page.
--
-- The geoip_refresh agent landed across PRs #972-#974 (schema +
-- lookup + Cartographer Phase 0.5 + Workflow). The work was
-- operator-approved as it shipped, so flipping the row to
-- 'approved' here matches the explicit greenlight without making
-- the operator click through the approval UI for an already-
-- agreed-upon deployment.
--
-- Mirrors the row shape from migrations 0126 and 0129.

INSERT OR IGNORE INTO agent_approvals (
  agent_id, state, requested_at, reviewed_at, reviewed_by, reviewer_notes
)
VALUES
  ('geoip_refresh', 'approved', datetime('now'), datetime('now'), 'system_grandfather',
   'Phase 3 — third-tier GeoIP provider; Workflow-based MaxMind GeoLite2-City import. Operator-approved across PRs #972-#974.');
