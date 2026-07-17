-- 0221: per-signal ownership for the tenant analyst queue.
--
-- Adds an assignee to alerts so an org analyst can take ownership of a
-- signal (TENANT_ANALYST_UX_RESEARCH_2026-06 #8). Nullable + additive — no
-- backfill, no rewrite. assigned_to is a users.id; assigned_at stamps when.
ALTER TABLE alerts ADD COLUMN assigned_to TEXT;
ALTER TABLE alerts ADD COLUMN assigned_at TEXT;
