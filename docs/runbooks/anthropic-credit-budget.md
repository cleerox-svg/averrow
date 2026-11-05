# Anthropic Credit Budget Runbook

How prod uses Claude on the owner's Max-plan API credit, the layered limits
that keep spend under it, and what to do when it runs out. Code references are
under `packages/averrow-worker/`. Background: `docs/AI_STRATEGY_2026-10.md`
Status (2026-11-05), `CLAUDE.md` §6 "AI usage rules" / "AI-call health".

## What is configured

- `wrangler.toml` prod `[vars]`: `AI_MODE = "enabled"`,
  `AI_CLAUDE_TASKS = "observer,narrator,abuse_mailbox_classifier,abuse_mailbox_deep_analyzer,evidence_assembler,campaign_hunter"`.
  Staging and dev stay `rules_only`.
- Credit source: the Claude Max plan's monthly $100 Anthropic API credit
  (https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers).
  Included credit is spent first and expires each billing cycle (the Max billing
  date, not the 1st). It only applies to the Console org linked on claude.ai
  (Settings, Billing, API credits).
- Cloudflare AI Gateway must pass our own key (BYOK). Unified Billing would not
  use the credit.

## Layered limits (outermost first)

| Layer | Limit | Where | Owner |
|---|---|---|---|
| Console org spend limit | ~$90 hard stop | Console, Billing, "Spend limits" | Owner action (not in code). Leave auto-reload OFF for a hard stop. |
| Platform throttle | `budget_config.monthly_limit_usd` = $80; hard throttle at 95% ($76), emergency 99% | `lib/ai-throttle.ts`, enforced inside `callAnthropic`; migration 0316 | Code |
| Per-agent token caps | see table | `lib/per-agent-budget.ts`, agent `budget.monthlyTokenCap` | Code |
| Allowlist | six agentIds | `AI_CLAUDE_TASKS`, `isAiTaskAllowed` in `lib/anthropic.ts` | `wrangler.toml` |

The throttle decision is KV-cached for 60s (key `ai:throttle_reason`) and fails
open on a KV/D1 error, so overshoot is bounded by one cache window of calls. A
throttled call throws `AiBudgetThrottledError` (`ai_budget_throttled:`), a
deliberate skip (`failure_kind: 'throttled'`), not an outage.

### Per-agent worst case

Caps are tokens (input + output). "Hard worst" prices every capped token at the
model's output rate, an upper bound real call mixes cannot reach
(Sonnet $3 in / $15 out, Haiku $1 / $5 per 1M).

| agentId | Model | Cap | Hard worst | Cap lives in |
|---|---|---|---|---|
| campaign_hunter | Sonnet | 1.0M | $15.00 | `agents/campaign-hunter.ts` |
| abuse_mailbox_deep_analyzer | Sonnet | 0.5M | $7.50 | `NON_MODULE_AGENT_CAPS` |
| abuse_mailbox_classifier | Haiku | 2.0M | $10.00 | `agents/abuseMailboxClassifier.ts` |
| evidence_assembler | Haiku | 2.0M | $10.00 | `agents/evidence-assembler.ts` |
| narrator | Haiku | 2.0M | $10.00 | `agents/narrator.ts` |
| observer | Haiku | 2.0M | $10.00 | `agents/observer.ts` |
| Total | | | $62.50 / month | |

The abuse classifier and deep analyzer are inert while
`ABUSE_AI_PROVIDER = "workers_ai"`. Observer runs triggered by `pivot_detected`
(`input.triggeredByEvent`) skip the AI call and the weekly report.

## Owner checklist

1. Confirm which Console org is linked on claude.ai (Settings, Billing, API credits).
2. Confirm `ANTHROPIC_API_KEY` (Worker secret) was created in that org.
3. Check that org's purchased balance and auto-reload. For a no-charge setup:
   zero purchased credit, auto-reload off.
4. Set the Console spend limit (~$90) under Billing, "Spend limits".
5. Confirm the AI Gateway uses our own key (BYOK), not Unified Billing.
6. Apply migration 0316 and verify `SELECT monthly_limit_usd FROM budget_config WHERE id = 1` is 80.

## Billing cycle vs calendar month

Our ledger (`budget_ledger`, `agent_budget_rollups.year_month`) resets on the
calendar month (`strftime('%Y-%m','now')`). The credit resets on the Max billing
date. Mid-cycle the two windows overlap differently: our $80 throttle can open
(new month) while the credit is already spent, or stay closed while fresh credit
exists. The Console spend limit and the credit balance are the true gates; our
throttle is a conservative backstop and measures our own estimated cost, not the
provider balance.

## When the credit runs out

Symptom: Anthropic returns HTTP 400 "credit balance is too low" (no card charge
if no purchased credit). Allowlisted agents hit `api_error`; they fall back to
their rules/template paths, runs still report success or `partial`.

Detection caveat: the strictly-API counters are instrumented for analyst only
(`lib/haiku.ts` `recordAiCall`), and analyst is not allowlisted, so Flight
Control's `platform_ai_calls_failing` and `ai_health.agents_all_failing` will
not fire for these tasks. Watch instead:

- `./scripts/platform-diagnostics.sh`: `ai_health.hours_since_last_call` growing
  while allowlisted agents have run (newest `budget_ledger` row = last successful call).
- `ai_spend_24h` dropping to zero.
- Worker logs for `Anthropic HTTP 400`.

Response, least to most drastic:

1. Wait for the next billing cycle (the credit refreshes on the Max billing date).
2. Remove tasks from `AI_CLAUDE_TASKS` (edit the var; every other id already
   skips quietly). A `wrangler.toml` platform-switch change, so CLAUDE.md §9a
   owner-OK applies.
3. Set `AI_MODE = "rules_only"` to stop every Claude call (same §9a rule).

Never leave `AI_CLAUDE_TASKS` unset or empty while `AI_MODE = "enabled"`: that
allows every task, including the bulk callers that were deliberately turned off.
