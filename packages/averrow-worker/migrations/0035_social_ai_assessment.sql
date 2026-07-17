-- Add AI assessment columns to social_monitor_results
ALTER TABLE social_monitor_results ADD COLUMN ai_confidence REAL;
ALTER TABLE social_monitor_results ADD COLUMN ai_action TEXT;
ALTER TABLE social_monitor_results ADD COLUMN ai_evidence_draft TEXT;
