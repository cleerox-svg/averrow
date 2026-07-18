# Phase 0 Baseline — 2026-07-17

Pre-flight baseline for the phased deployment plan
(`docs/DEPLOYMENT_PHASES_2026-07.md`). This is the "before" picture that
every later phase diffs its post-deploy diagnostics against.

- **Diagnostics window:** 24h ending `2026-07-17T20:59:26Z`
  (`endpoint_version` 9, `db_clock_utc` 2026-07-17 20:59:26).
- **Raw capture:** full JSON saved to the session scratchpad
  (`deploy-baseline-2026-07.json`, 75 KB). Figures below are the
  decision-relevant extract; re-run `./scripts/platform-diagnostics.sh 24`
  to refresh.

## Phase 0 checklist status

| Item | Status | Evidence |
|---|---|---|
| CI green on `master`; last deploy succeeded | ✅ | `deploy-radar.yml` run for PR #1632 (`3bc8235`) = **success**; no deployable (`packages/**`) change merged since — only docs. |
| No pending migrations | ✅ (inferred) | Latest migration file `0237`; the successful deploy ran `db:migrate:*:prod` + `db:verify:prod`. Direct `db:migrate:status:prod` not runnable from this container (no `wrangler`/CF creds). |
| Baseline diagnostics captured | ✅ | This document + scratchpad JSON. |
| Staging deploys (`wrangler deploy --env staging`) | ⛔ blocked here | No `wrangler` on PATH, no `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` in this container. **Owner/CI action** — must be proven before Phase 1 (the auth phase routes through staging). |
| `wrangler rollback` target exists | ⛔ blocked here | Same credential gap. A known-good deployment plainly exists (prod is live at `3bc8235`); the *command* just can't be exercised from here. |

## The four findings this baseline anchors (all confirmed LIVE)

### R1 — agent starvation (target: 24/24 after S0.1)
Both scanners ran **9 times in 24h** (should be 24 if hourly), last completed
`18:08` — ~3h before capture. Confirms the drop is live and intermittent.

| Agent | total_runs (24h) | success | failed | last_completed |
|---|---|---|---|---|
| `lookalike_scanner` | 9 | 9 | 0 | 2026-07-17 18:08:42 |
| `trademark_monitor` | 9 | 9 | 0 | 2026-07-17 18:08:43 |

*(Assessment said 8/24; 9/24 now — same starved regime.)*

### R2 — `ct_monitor` telemetry blind (target: appears in `agent_mesh` after S0.1)
`ct_monitor` is **absent** from `agent_mesh.per_agent[]` — zero `agent_runs`
rows, so Flight Control's stall watchdog structurally cannot see it. Confirmed.

### R3 — DNS-queue drift (target: delta < 500 after S0.2)
`dns_queue_parity`: `queue_size` **9091**, `drainable_in_threats` 0,
**delta 9091** — ~18× the 500 alert threshold, and *higher* than the
assessment's 8,851, i.e. not self-correcting. `enrichment_pipeline.needs_dns`
= 22,191.

### R4 — D1 read budget (target: trend DOWN after Phase 3 / S0.4)
- `d1_budget_state`: **91.7%** of daily budget, `threshold_state` **"warn"**,
  **51 read-skips in the last 24h** (last skip `13:35`) — the budget guard is
  actively shedding reads at baseline.
- `d1_metrics_24h`: 764.2M rows read / 24h; monthly projection 91.7% of the
  25B plan ceiling.
- `d1_billing_cycle`: cycle-to-date 77.9% of ceiling (30/30 days elapsed).
- Top read endpoints (24h): `observatory_arcs` 15.2M, `agents_list` 14.6M,
  `observatory_nodes` 8.3M rows.

## Handoff to Phase 1

Before Phase 1 (security P0 via staging) starts, the owner must confirm the
two blocked items above — **staging deploys** and a **rollback target** —
since Phase 1 is the one phase that proves out on `staging.averrow.com`
before prod. Everything else in Phase 0 is green.
</content>
