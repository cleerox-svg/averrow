-- Add token tracking to agent_runs for Haiku API cost monitoring
ALTER TABLE agent_runs ADD COLUMN tokens_used INTEGER DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER DEFAULT 0;
