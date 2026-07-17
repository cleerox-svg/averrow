-- 0219: Refresh-token reuse detection (H-2, AUTH_AUDIT_2026-06)
--
-- Rotation already issued a fresh refresh token on every /api/auth/refresh,
-- but the just-rotated token was overwritten and forgotten. With no memory
-- of the previous token, a stolen refresh token replayed after the
-- legitimate client had already rotated was indistinguishable from a normal
-- "invalid token" miss — no theft signal, no family revocation.
--
-- These columns let handleRefreshToken recognise a presented token that was
-- ALREADY rotated away:
--   * within a short grace window  → benign concurrent refresh (e.g. two
--     browser tabs racing) — re-issue without alarm.
--   * outside the grace window / on a revoked session → treat as theft:
--     revoke the entire session family for that user + force-logout.
--
-- previous_token_hash: SHA-256 of the refresh token that this session held
--   immediately before its most recent rotation.
-- rotated_at: when that rotation happened (drives the grace check).
ALTER TABLE sessions ADD COLUMN previous_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN rotated_at TEXT;

-- Lookup index for the reuse-detection path (presented token vs the
-- prior-generation hash).
CREATE INDEX IF NOT EXISTS idx_sessions_prev_refresh ON sessions(previous_token_hash);
