-- Phase 4 Step 4: Per-agent circuit breaker in Flight Control.
--
-- Mirrors the 0074 feed auto-pause pattern for agents. Adds a new
-- agent_configs table with a persistent consecutive_failures counter,
-- a paused_reason metadata channel, and a per-agent threshold override.
-- The global default threshold lands in the same system_config key/value
-- table 0074 introduced — we intentionally do NOT create a second config
-- table for agents.
--
-- Design notes:
--
-- (i) circuit_trip_rule exists with a default of 'consecutive_failures'.
--     v1 only implements the consecutive-failures trigger — it's the
--     simplest rule and the one that actually matches how analyst fails
--     today (thundering structural D1 timeouts in runs). Leaving the
--     column in place means v2 can add 'error_rate' / 'p95_latency'
--     triggers without another ALTER TABLE. executeAgent() checks the
--     rule string and no-ops on anything other than 'consecutive_failures'.
--
-- (ii) Automatic recovery (half-open → closed) is deferred on purpose.
--      Once analyst's structural D1 timeouts are fixed in Step 5, we can
--      revisit — but until then, any cooldown-based auto-retry would just
--      re-trip the breaker on the first execution after the cooldown
--      window and create a notification storm. v1 is manual reset only.
--
-- (iii) paused_reason semantics copy 0074 exactly:
--         'auto:consecutive_failures' → tripped by executeAgent()
--         'manual'                     → flipped off by an admin
--         NULL                         → enabled
--
-- (iv) flight_control and architect are NOT protected here — the
--      protection lives in executeAgent() as a hardcoded const set
--      (PROTECTED_FROM_CIRCUIT_BREAKER). A column would be a config
--      knob; this is a code-level invariant.
--
-- (v)  executeAgent() will INSERT OR IGNORE a row the first time it
--      sees a new agent, so the seed list below is just so the admin
--      UI has something to render on day one of the new table.

-- ── agent_configs: circuit breaker state ────────────────────
CREATE TABLE IF NOT EXISTS agent_configs (
  agent_id                       TEXT PRIMARY KEY,
  enabled                        INTEGER NOT NULL DEFAULT 1,
  paused_reason                  TEXT,
  consecutive_failures           INTEGER NOT NULL DEFAULT 0,
  consecutive_failure_threshold  INTEGER,
  circuit_trip_rule              TEXT NOT NULL DEFAULT 'consecutive_failures',
  paused_at                      TEXT,
  paused_after_n_failures        INTEGER,
  created_at                     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed one row per current agentModules key. All enabled, zero failures.
-- New agents added after this migration will be lazily inserted by
-- executeAgent() via INSERT OR IGNORE on first run.
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('sentinel');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('analyst');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('cartographer');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('strategist');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('observer');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('prospector');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('sparrow');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('nexus');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('flight_control');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('curator');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('watchdog');
INSERT OR IGNORE INTO agent_configs (agent_id) VALUES ('architect');

-- ── system_config: global default threshold for agents ─────
-- Reuses the same system_config table 0074 created. The feed
-- default lives under 'feed_consecutive_failure_threshold'; agents
-- get their own key so the two can diverge.
INSERT OR IGNORE INTO system_config (key, value)
  VALUES ('agent_consecutive_failure_threshold', '3');
