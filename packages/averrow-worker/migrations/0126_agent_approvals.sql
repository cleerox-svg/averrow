-- ─── Agent deployment approval state ──────────────────────────────
--
-- AGENT_STANDARD §12.1 — every new or structurally-changed agent
-- ships in status='shadow' and requires explicit super_admin
-- approval before flipping to status='active'. This table tracks
-- the approval lifecycle.
--
-- Phase 5.4a (this migration) adds the data model + admin endpoints
-- only. Phase 5.4b will integrate the runner so new agents
-- actually create pending rows on first run, and 5.4b adds the
-- /agents/:id/review UI.
--
-- The 35 agents currently registered are grandfathered: they were
-- running pre-5.4 so we don't retroactively gate them. The migration
-- inserts an 'approved' row for each existing agentModules entry
-- (with reviewer='system_grandfather') so the deployment-approval
-- check is a no-op for them. New agents added after 5.4 will land
-- as 'pending' and appear in the approval queue.

CREATE TABLE IF NOT EXISTS agent_approvals (
  -- Mirrors agentModules registry id (snake_case).
  agent_id        TEXT PRIMARY KEY,
  -- Lifecycle state of this agent's deployment.
  --   'pending'  → ship date set, awaiting reviewer
  --   'approved' → reviewer approved; agent runs normally
  --   'rejected' → reviewer rejected; agent paused via agent_configs
  --   'changes_requested' → author iterates; agent stays in shadow
  state           TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'changes_requested')),
  -- When the agent's deployment was first observed (first run, or
  -- the row's INSERT time for grandfathered entries).
  requested_at    TEXT NOT NULL,
  -- Set when the reviewer takes an action (approve/reject/request
  -- changes). Null while pending.
  reviewed_at     TEXT,
  -- super_admin user_id, or 'system_grandfather' for the rows
  -- inserted by this migration to backfill existing agents.
  reviewed_by     TEXT,
  -- Free-text notes: reason on reject, change requests, or empty
  -- on a clean approve. Length-soft-capped to 4000 chars by the
  -- handler (CHECK at the SQL layer would forbid long strings
  -- which is more restrictive than we need).
  reviewer_notes  TEXT,
  -- The PR / commit that introduced the agent — useful when the
  -- review queue accumulates and the reviewer wants the source
  -- diff. Set by the scaffolder in Phase 5.4b.
  source_pr       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for the "pending agents" admin endpoint — almost always
-- the only one the reviewer hits. Sort by requested_at DESC so the
-- newest pending agent floats to the top.
CREATE INDEX IF NOT EXISTS idx_agent_approvals_pending
  ON agent_approvals(state, requested_at DESC);

-- Backfill: grandfather every agent that's currently registered
-- pre-5.4. Inserts 'approved' rows so the runner gate (added in
-- 5.4b) is a no-op for these agents.
--
-- The list mirrors agents/index.ts agentModules at the time of
-- this migration. Running the migration after the registry shrinks
-- (e.g. an agent retires) just leaves stale rows around — harmless;
-- the runner only consults agent_approvals for active agentModules
-- entries.
INSERT OR IGNORE INTO agent_approvals (
  agent_id, state, requested_at, reviewed_at, reviewed_by, reviewer_notes
)
VALUES
  ('sentinel',                'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('analyst',                 'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('cartographer',            'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('strategist',              'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('observer',                'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('pathfinder',              'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('sparrow',                 'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('nexus',                   'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('flight_control',          'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('curator',                 'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('watchdog',                'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('narrator',                'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('app_store_monitor',       'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('dark_web_monitor',        'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('social_monitor',          'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('social_discovery',        'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('auto_seeder',             'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('seed_strategist',         'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('cube_healer',             'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('navigator',               'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('enricher',                'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('public_trust_check',      'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('qualified_report',        'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('brand_analysis',          'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('brand_report',            'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('brand_deep_scan',         'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('honeypot_generator',      'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('brand_enricher',          'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('lookalike_scanner',       'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('admin_classify',          'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('url_scan',                'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('scan_report',             'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('social_ai_assessor',      'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('geo_campaign_assessment', 'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered'),
  ('evidence_assembler',      'approved', datetime('now'), datetime('now'), 'system_grandfather', 'pre-5.4 agent — grandfathered');

ANALYZE;
