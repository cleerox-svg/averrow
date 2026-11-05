-- 0316: lower the platform AI spend ceiling to fit the $100/month free
-- Anthropic credit.
--
-- Prod re-enables Claude (AI_MODE = "enabled") only for the low-volume,
-- customer-facing tasks listed in AI_CLAUDE_TASKS (wrangler.toml;
-- docs/AI_STRATEGY_2026-10.md §2 "CLAUDE" rows). callAnthropic now enforces
-- the budget_config throttle on every call (lib/ai-throttle.ts), so this
-- ceiling is the platform backstop: the hard throttle (hard_pct, default
-- 95%) pauses non-critical calls at $76, leaving headroom under the $100
-- credit for the 60s KV decision-cache overshoot. Per-agent token caps
-- (lib/per-agent-budget.ts) bound each allowlisted task well below this.
--
-- Non-destructive: only LOWERS an existing higher limit (prod was $150).
-- A lower operator-set limit is kept. No row → no-op (BudgetManager.getConfig
-- then falls back to its $50 default, already under the credit).
UPDATE budget_config
SET monthly_limit_usd = 80,
    updated_at = datetime('now')
WHERE id = 1
  AND monthly_limit_usd > 80;
