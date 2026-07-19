# Phase 2–3 Post-Deploy Verification — 2026-07-19

The carry-over 24h verification for the deployment plan
(`docs/DEPLOYMENT_PHASES_2026-07.md`), run once a full day of prod data had
accumulated since the 2026-07-18 deploys. Diffs against
`docs/deploy-baselines/phase-0-baseline-2026-07-17.md`.

- **Diagnostics window:** 24h ending `2026-07-19T03:08:56Z`
  (`endpoint_version` 9). Raw capture in the session scratchpad
  (`diag-24h-2026-07-19.json`). Re-run `./scripts/platform-diagnostics.sh 24`
  to refresh.
- **Deploy reference:** S0.1/S0.2 (PRs #1637/#1638) merged 2026-07-18 ~12:30 UTC;
  S0.4 (#1639) same day. The 24h window therefore straddles the deploy — pre-deploy
  hours still reflect the old behavior, which matters for the cadence reads below.

## Results by verification target

| Target | Baseline (07-17) | Now (07-19) | Verdict |
|---|---|---|---|
| **S0.2** — DNS-queue parity (`dns_queue_parity.delta` ~0) | phantom **9091** | `delta -138` (queue 9577 / drainable 9715) | ✅ **Pass** |
| **S0.4** — D1 read budget trending down | **91.7%** daily · warn · 51 skips | **89.7%** daily · warn · 76 skips; new billing cycle (day 2/31) projects **54.2%** of ceiling | ✅ **Pass** (marginal — still "warn") |
| **S0.1 R1** — lookalike + trademark cadence (target 24/24) | 9/24 each | **17/24** each, hourly since deploy | ✅ **Pass** — see note | 
| **S0.1 R2** — `ct_monitor` visible in `agent_mesh.per_agent[]` | absent | **still absent** | ❌ **Regression** — fixed in migration 0238 |

### S0.2 — DNS-queue parity ✅
`dns_queue_parity` now reports `queue_size 9577`, `drainable_in_threats 9715`,
`delta -138` — the metric tracks the true threats-side candidate count and the
phantom 9091 delta is gone, exactly as the S0.2 metric-correctness fix intended.

### S0.4 — D1 read budget ✅ (trending down, marginal)
`d1_budget_state`: `pct_of_daily_budget` **89.7%** (was 91.7%), `threshold_state`
still **"warn"**, `skip_count_24h` 76 (was 51), `last_skip_at` 2026-07-18 18:36.
The billing cycle reset 2026-07-18; cycle-to-date projection is **54.2%** of the
25B plan ceiling with 6.5% of the cycle elapsed. Daily pct is trending down as
S0.4 intended; it remains in the "warn" band, so continue to treat read-heavy
phases as budget-gated. Top read endpoints unchanged in shape.

### S0.1 R1 — scanner cadence ✅ (17/24 is a mid-window-deploy artifact)
`lookalike_scanner` and `trademark_monitor` each show **17 runs / 24h, 0 failed**,
last completed 02:23–02:24 (~45 min before capture). The window straddles the
~12:30 UTC deploy: pre-deploy hours ran the old starved inline path (~9/24 rate),
post-deploy hours run the dedicated crons (`22 * * * *` / `23 * * * *`) hourly.
17 ≈ (a few starved pre-deploy runs) + (~14 post-deploy hourly runs). The
post-deploy cadence is hourly; a clean full-day window will read **24/24**.

### S0.1 R2 — `ct_monitor` telemetry ❌ → fixed
`ct_monitor` is **still absent** from `agent_mesh.per_agent[]` — zero `agent_runs`.
Root cause: S0.1 registered `ct_monitor` as a new `AgentModule` routed through
`executeAgent`, whose deployment-approval gate (AGENT_STANDARD §12.1) blocks any
`agent_id` lacking an `approved` row in `agent_approvals`. Migration 0126 only
grandfathered the pre-5.4 agents; the S0.1 PR omitted the per-agent approval
migration that 0129 (notification_narrator) / 0130 (geoip_refresh) established as
the pattern for post-0126 agents. Every `18 * * * *` tick hit `blockingState =
"missing"`, auto-created a `pending` row, and returned before writing `agent_runs`
— so **`pollCertificates` has not run in prod since the S0.1 deploy** (previously
it ran as a bare inline call) and CT monitoring is telemetry-invisible.

**Fix:** `migrations/0238_ct_monitor_approval.sql` grandfathers `ct_monitor` to
`approved` (guarded upsert, because a `pending` row already exists in prod from the
blocked ticks). The same migration adds DR/fresh-DB parity rows (`INSERT OR IGNORE`,
pure no-op against current prod) for four other post-0126 `executeAgent`-gated
agents that survive only on runtime operator approvals (`trademark_monitor`,
`abuse_mailbox_classifier`, `attributor`, `news_watcher`).

**Re-verification required post-merge:** after 0238 deploys to prod, re-run
`./scripts/platform-diagnostics.sh 24` and confirm `ct_monitor` appears in
`agent_mesh.per_agent[]` with `agent_runs` accruing hourly, and that a clean
full-day window shows lookalike/trademark at 24/24.

## Go/no-go

- **Phase 2 go/no-go** (scanners at full cadence + `ct_monitor` visible to FC):
  scanners ✅; `ct_monitor` **blocked on the 0238 redeploy** — not yet met until
  the fix ships and re-verifies.
- **Phase 3 go/no-go** (read budget trending down): ✅ met.
- **Phase 4** is copy/config with low incremental read volume, so it is not
  budget-gated by the still-"warn" daily figure; proceed once 0238 is merged and
  the ct_monitor re-verification is scheduled.
