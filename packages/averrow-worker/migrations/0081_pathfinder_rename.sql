-- Rename prospector → pathfinder across all tables that reference agent_id
-- Preserves historical data (agent_runs, activity log, sales leads provenance)

UPDATE agent_runs SET agent_id = 'pathfinder' WHERE agent_id = 'prospector';
UPDATE agent_outputs SET agent_id = 'pathfinder' WHERE agent_id = 'prospector';
UPDATE agent_activity_log SET agent_id = 'pathfinder' WHERE agent_id = 'prospector';
UPDATE budget_ledger SET agent_id = 'pathfinder' WHERE agent_id = 'prospector';

-- sales_leads.identified_by uses 'prospector_agent' as the default; rename to match
UPDATE sales_leads SET identified_by = 'pathfinder_agent' WHERE identified_by = 'prospector_agent';

-- agent_configs has agent_id as PRIMARY KEY — DELETE old row and INSERT fresh.
-- This also resets the circuit breaker (which we want post-fix).
DELETE FROM agent_configs WHERE agent_id = 'prospector';
INSERT OR IGNORE INTO agent_configs (agent_id, enabled, consecutive_failures)
  VALUES ('pathfinder', 1, 0);
