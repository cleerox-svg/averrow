-- Add AI-generated threat analysis cache to brands table
ALTER TABLE brands ADD COLUMN threat_analysis TEXT;
ALTER TABLE brands ADD COLUMN analysis_updated_at TEXT;
