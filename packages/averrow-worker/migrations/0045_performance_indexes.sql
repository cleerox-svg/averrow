-- Phase 8: Performance indexes for hot query patterns
-- ─────────────────────────────────────────────────────

-- Composite index for the most common query pattern: active threats in time window
-- Used by observatory, admin dashboard, agents, briefings
CREATE INDEX IF NOT EXISTS idx_threats_status_created ON threats(status, created_at DESC);

-- Composite for brand + time window queries (used by analyst, observer, prospector)
CREATE INDEX IF NOT EXISTS idx_threats_brand_created ON threats(target_brand_id, created_at DESC);

-- Spam trap captures by time (used by dashboard stats, daily charts)
CREATE INDEX IF NOT EXISTS idx_stc_captured_category ON spam_trap_captures(captured_at DESC, category);

-- Email security scans by domain + time (used by grade change detection)
CREATE INDEX IF NOT EXISTS idx_ess_domain_scanned ON email_security_scans(domain, scanned_at DESC);

-- Brand monitor schedule by next check time (used by cron social monitor)
CREATE INDEX IF NOT EXISTS idx_brand_monitor_schedule_next_check ON brand_monitor_schedule(monitor_type, next_check) WHERE enabled = 1;

-- Sales leads unenriched (used by Pathfinder Phase 2)
CREATE INDEX IF NOT EXISTS idx_sales_leads_unenriched ON sales_leads(ai_enriched, prospect_score DESC) WHERE ai_enriched = 0;

-- Agent runs latest per agent (used by dashboard, agent config)
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON agent_runs(agent_id, started_at DESC);

-- Brands by monitoring status (used by cron pipelines)
CREATE INDEX IF NOT EXISTS idx_brands_monitoring ON brands(monitoring_status) WHERE monitoring_status = 'active';

-- Threats with no brand match (used by brand match backfill — runs every 30 min)
CREATE INDEX IF NOT EXISTS idx_threats_unmatched ON threats(target_brand_id) WHERE target_brand_id IS NULL;
