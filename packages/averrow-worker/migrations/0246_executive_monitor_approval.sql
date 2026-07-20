-- 0246: Grandfather the `executive_monitor` AgentModule as an approved
--       deployment — Stage 4 of the executive social-impersonation feature
--       (EXEC_IMPERSONATION_2026-07).
--
-- AGENT_STANDARD §12.1 / lib/agentRunner.ts executeAgent: the runner
-- refuses to run any agent whose agent_id has no 'approved' row in
-- agent_approvals. On first sight it auto-creates a 'pending' row
-- (agent-approvals.createPending) and RETURNS before writing agent_runs —
-- the run is skipped. This is exactly what silently killed ct_monitor
-- after S0.1 (fixed in migration 0238): a new dedicated-cron agent shipped
-- WITHOUT an approval row, so every tick hit the gate and was skipped,
-- leaving the agent invisible to the mesh.
--
-- Stage 4 registers a NEW AgentModule 'executive_monitor'
-- (agents/executiveMonitor.ts, delegating to
-- scanners/executive-monitor-batch.ts) dispatched from the dedicated cron
-- `26 */6 * * *`. Without this row it would be blocked identically to
-- ct_monitor. This migration grandfathers it to match the operator-approved
-- Stage 4 deploy.
--
-- ── Why ON CONFLICT DO UPDATE, NOT a bare INSERT OR IGNORE (the 0238 trap) ──
-- If a prod worker fires the `26 */6` cron in the window between deploy and
-- this migration applying, executeAgent's gate will already have called
-- createPending and left a 'pending' row for executive_monitor. A bare
-- `INSERT OR IGNORE` would collide on the agent_id PK and be a NO-OP,
-- leaving the agent pending and STILL blocked — the precise 0238 failure.
-- The guarded upsert below flips an existing non-approved row to 'approved'
-- (and inserts one if none exists). The `WHERE ... state != 'approved'`
-- guard keeps it idempotent and never clobbers a deliberate operator
-- decision that already reads 'approved'.
INSERT INTO agent_approvals (
  agent_id, state, requested_at, reviewed_at, reviewed_by, reviewer_notes
)
VALUES
  ('executive_monitor', 'approved', datetime('now'), datetime('now'), 'system_grandfather',
   'Stage 4 executive social-impersonation — new AgentModule on dedicated cron 26 */6 * * *. Grandfathered to match the operator-approved deploy; avoids the ct_monitor (0238) approval-gate block. See agents/executiveMonitor.ts + scanners/executive-monitor-batch.ts + cron/orchestrator.ts.')
ON CONFLICT(agent_id) DO UPDATE SET
  state          = 'approved',
  reviewed_at    = datetime('now'),
  reviewed_by    = 'system_grandfather',
  reviewer_notes = excluded.reviewer_notes,
  updated_at     = datetime('now')
WHERE agent_approvals.state != 'approved';
