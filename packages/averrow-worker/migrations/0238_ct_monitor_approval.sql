-- ─── Phase 2 / S0.1 CT-monitor — grandfather as approved ──────────
--
-- AGENT_STANDARD §12.1: executeAgent refuses to run any agent whose
-- agent_id has no 'approved' row in agent_approvals. On first sight it
-- auto-creates a 'pending' row and RETURNS before writing agent_runs —
-- the run is skipped. Migration 0126 grandfathered the pre-5.4 agents;
-- 0129 (notification_narrator) and 0130 (geoip_refresh) added the two
-- agents that shipped after it.
--
-- S0.1 (PR #1637) registered a NEW AgentModule 'ct_monitor'
-- (agents/ct-monitor.ts) and wrapped runCTMonitor in executeAgent,
-- dispatched from the dedicated cron `18 * * * *`. The PR did NOT ship
-- an approval row, so every `18 * * * *` tick has hit blockingState
-- 'missing' and been skipped: pollCertificates no longer runs in prod
-- and ct_monitor is absent from agent_mesh.per_agent[]. Its sibling
-- dedicated-cron scanners (lookalike `22`, trademark `23`) run fine
-- because they already carry an approved row. This migration grandfathers
-- ct_monitor to match the operator-approved S0.1 deploy, restoring the
-- run the missing approval row blocked.
--
-- ── Why ON CONFLICT DO UPDATE, not a bare INSERT OR IGNORE ──
-- Unlike 0129/0130 — which shipped in the SAME PR as their agent, so the
-- grandfather row landed BEFORE the agent's first gated run and no
-- 'pending' row could pre-exist — this fix lands ~24h AFTER S0.1. During
-- that window every blocked tick called agent-approvals.createPending
-- (agentRunner.ts ~L387), so ct_monitor almost certainly ALREADY has a
-- 'pending' row in prod. A bare `INSERT OR IGNORE` would collide on the
-- agent_id PK and be a NO-OP, leaving ct_monitor pending and still
-- blocked. The guarded upsert below flips an existing non-approved row to
-- 'approved' (and inserts one if — unexpectedly — none exists). The
-- `WHERE state != 'approved'` guard keeps it idempotent and prevents
-- clobbering a row that is already approved.
INSERT INTO agent_approvals (
  agent_id, state, requested_at, reviewed_at, reviewed_by, reviewer_notes
)
VALUES
  ('ct_monitor', 'approved', datetime('now'), datetime('now'), 'system_grandfather',
   'Phase 2 / S0.1 — Certificate Transparency monitor (dedicated cron 18 * * * *). Grandfathered to match the operator-approved S0.1 deploy (PR #1637); restores the pollCertificates run the missing approval row blocked. See wrangler.toml crons + agents/ct-monitor.ts.')
ON CONFLICT(agent_id) DO UPDATE SET
  state          = 'approved',
  reviewed_at    = datetime('now'),
  reviewed_by    = 'system_grandfather',
  reviewer_notes = excluded.reviewer_notes,
  updated_at     = datetime('now')
WHERE agent_approvals.state != 'approved';

-- ── DR / fresh-DB parity for the other gated agents added after 0126 ──
-- Audit of agents/index.ts vs the approval migrations (0126/0129/0130)
-- found four MORE executeAgent-gated agents with no migration approval
-- row: trademark_monitor, abuse_mailbox_classifier, attributor,
-- news_watcher. Unlike ct_monitor these are NOT currently blocked — they
-- run in prod today via an 'approved' row an operator created at runtime
-- through the admin approval UI (trademark's live agent_runs prove the
-- runtime-approval path is what keeps them alive). But that approved
-- state exists ONLY in the live DB — a fresh/DR rebuild from migrations
-- would silently block all four exactly like ct_monitor.
--
-- INSERT OR IGNORE (not the upsert above) is deliberate here: it inserts
-- the grandfather row only when NONE exists, so it is a pure no-op
-- against current prod and can never override a deliberate runtime
-- operator decision (e.g. an intentional 'rejected'/'changes_requested').
-- (campaign_hunter is registered but NOT executeAgent-gated — it runs as
-- its own Cloudflare Workflow that writes agent_runs directly — so it
-- needs no approval row and is intentionally omitted.)
INSERT OR IGNORE INTO agent_approvals (
  agent_id, state, requested_at, reviewed_at, reviewed_by, reviewer_notes
)
VALUES
  ('trademark_monitor',        'approved', datetime('now'), datetime('now'), 'system_grandfather', 'Post-0126 gated agent — DR/fresh-DB parity for the runtime-approved trademark correlation scanner (dedicated cron 23 * * * *).'),
  ('abuse_mailbox_classifier', 'approved', datetime('now'), datetime('now'), 'system_grandfather', 'Post-0126 gated agent — DR/fresh-DB parity for the runtime-approved abuse-inbox classifier (orchestrator dispatch).'),
  ('attributor',               'approved', datetime('now'), datetime('now'), 'system_grandfather', 'Post-0126 gated agent — DR/fresh-DB parity for the runtime-approved NEXUS cluster→actor attributor (orchestrator hour%4===1).'),
  ('news_watcher',             'approved', datetime('now'), datetime('now'), 'system_grandfather', 'Post-0126 gated agent — DR/fresh-DB parity for the runtime-approved threat-intel news watcher (orchestrator hour%6===2).');
