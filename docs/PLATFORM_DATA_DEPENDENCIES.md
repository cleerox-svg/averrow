# Platform Data Dependencies

What reads from what. Where each surface gets its truth. The reconciliation rules.

This doc exists because the codebase has multiple status-of-the-system surfaces (Status page, Notifications, Agents API, Feeds API, Diagnostics) and each one used to read directly from `agent_runs` — which silently became wrong when workflow-dispatched agents (nexus, future cart) started writing to `agent_activity_log` instead. PR-J / PR-R introduced a shared reconciliation layer; this doc tracks all the consumers so future surfaces don't get added without applying the same pattern.

**Linked from:** `CLAUDE.md` §6 (Agent Architecture Rules), `docs/ARCHITECTURE.md`, `docs/AI_AGENTS.md`, `docs/runbooks/workflow-dispatch.md`.

---

## 1. Canonical data stores

| Table / KV key | Writer | Reader(s) | Purpose |
|---|---|---|---|
| `agent_runs` | `lib/agentRunner.executeAgent` at start/end | API, status, FC, diagnostics | Per-execution lifecycle for inline agents. Always paired with status=`partial` row at start, UPDATE to success/failed at end. |
| `agent_activity_log` | Workflow bodies (`workflows/*.ts`) AND `lib/workflow-dispatch.dispatchWorkflow` AND FC logActivity | API, status, FC, diagnostics, notification narrator | Per-event log. **Sole source of truth for workflow-dispatched agents** because they don't write to `agent_runs`. Event types: `workflow_dispatched`, `batch_complete`, `workflow_dispatch_failed`, `workflow_cooldown_skip`, `started`, `recovery`, `batch_complete` (FC tick), etc. |
| `agent_outputs` | Agent execute() bodies | API (`/api/insights/latest`, Home "Latest Intel"), briefing, narrator | Per-agent insights / diagnostics. AI-generated content. Type column: `insight`, `correlation`, `diagnostic`. The legacy `score` (Cartographer) and `classification` (Analyst) types were folded into `insight` in the 2026-05-16 platform audit so they surface through `/api/insights/latest` instead of being written to /dev/null. Cartographer additionally gates Haiku scoring to providers with ≥5 active threats OR repeat-offender status (≥3 campaigns) — saves ~40% of its daily AI spend. |
| `agent_events` | Agents on completion | Orchestrator's `processAgentEvents` | Event-driven dispatch trigger. **Mostly telemetry** post-PR-L — only `pivot_detected` → Observer is wired. See CLAUDE.md §6 for the canonical chain vs the historical declared chain. |
| `agent_configs` | Admin endpoints, FC auto-pause logic | All status surfaces | Circuit breaker state (`enabled`, `paused_reason`, `consecutive_failures`, etc). |
| `feed_status` | `lib/feedRunner.runFeed` success/failure paths | Diagnostics, dashboard | Per-feed live state. PR-K added `next_retry_at` for the circuit breaker. |
| `feed_pull_history` | `lib/feedRunner.runFeed` at start | Diagnostics, milestones, dashboard | Per-pull log. Captures records_ingested, status, error_message, duration_ms. |
| `feed_configs` | Admin endpoints, auto-pause logic | feedRunner dispatch, diagnostics | Source URLs, schedules, enabled flag, paused_reason. |
| `budget_ledger` | `lib/anthropic.callAnthropic` | Diagnostics, budget UI, FC budget logic | Per-AI-call token + cost ledger. Single source for AI spend. |
| `notifications` | `lib/platform-templates.emitPlatformNotification` | UI inbox, notification_narrator, briefing | Platform alerts. Group_key for dedup. |
| `takedown_requests` | `handlers/takedowns` | Tenant takedowns page, sparrow agent, ops admin | Customer-initiated takedown requests with full lifecycle. |
| `threats` | Feeds, cart, enricher, analyst | Almost everything | Core threat intel table. Pre-computed columns (`brand.threat_count`, `hosting_providers.active_threat_count`) avoid full scans. |
| KV `wf_last_dispatch:<workflow>` | `dispatchWorkflow` on success | FC `workflow_dispatch_supervisor` (PR-A) | Dispatch-recency stamp. Drives `platform_workflow_dispatch_silent` alert. |
| KV `wf_cooldown:<workflow>` | `dispatchWorkflow` on `WorkflowInternalError` | `dispatchWorkflow` next-call check | Platform-error cooldown (1h TTL). |
| KV `count.<key>` | `lib/cached-count.cachedCount` | The cachedCount helper | Caches expensive COUNT(*) results. Hit-rate visible in diagnostics. |

---

## 2. The agent-status reconciliation rule (PR-J / PR-R)

**Rule:** Any handler that derives an agent's "is it healthy / when did it last run" status must reconcile `agent_runs` with `agent_activity_log` workflow events. The shared helper is `lib/workflow-agent-stats.getWorkflowAgentStats()`.

**Why:** Workflow-dispatched agents (today: nexus; future: cart post-PR-O) DO NOT write to `agent_runs`. They write `workflow_dispatched` / `batch_complete` / `workflow_dispatch_failed` events to `agent_activity_log`. A handler reading only `agent_runs` will report a healthy workflow agent as FAILING because its only `agent_runs` rows are historical inline-recovery cleanups.

**Consumers that apply the reconciliation:**

| Surface | Handler | What it shows | Without reconciliation |
|---|---|---|---|
| `/api/internal/platform-diagnostics` `agent_mesh.per_agent[]` | `handlers/diagnostics.ts` (PR-J) | Per-agent rollup with `dispatch_source: 'workflow'\|'agent_runs'` | Nexus shows 0 success, 5 failed |
| `/api/agents` (Agents grid) | `handlers/agents.ts handleListAgents` (PR-R) | last_run_at, last_run_status, jobs_24h, status pill | Nexus card shows "FAILING" |
| FC `getAgentHealth` → `platform_agent_stalled` notification gate | `agents/flightControl.ts:1453` (PR-R) | `is_stalled` boolean, `last_run_at`, `last_run_status` | False `platform_agent_stalled` notifications fire for nexus every FC tick |
| `/api/internal/platform-status` `categories[agents]` realtime | `lib/platform-status.computeAgentsRealtime` (PR-R) | 6h success rate for the agents category pill | Status page shows degraded; nexus contributes 0 successes |

**Surfaces that DO NOT need reconciliation (correct by construction):**

- AI spend (`budget_ledger`) — workflow's `callAnthropic` writes there too
- KV-stamped supervisor (`wf_last_dispatch:*`) — workflow-aware by design
- Diagnostics `cron_health` — looks at navigator + flight_control + orchestrator, none of which are workflow-dispatched

**Surfaces still on agent_runs-only (acceptable):**

- `computeAgentsDaily` (status page trailing 30d chart) — historical accuracy of the dip during nexus's pre-workflow outage is correct
- `/api/agents/:name` (agent detail page) — TODO follow-up if pain emerges
- `/api/agents/runs` (runs feed) — TODO follow-up if pain emerges
- `architect/collectors/ops.ts` — internal architect agent, low priority

---

## 3. Notification dependency chain

Notifications surface alerts to operators. They're written by FC and other emitters; consumers include the inbox UI and `notification_narrator` (which composes a daily briefing).

```
Source detection                       → Notification emit                 → Inbox display + Briefing
─────────────────────────────────────    ──────────────────────────────────   ──────────────────────────
FC getAgentHealth.is_stalled  ─────────► platform_agent_stalled              ► notifications inbox
  reads: agent_runs + workflow events      group_key: agent_id+last_run_at     ► notification_narrator
  (PR-R reconciliation)                                                         brief

FC workflow_dispatch_supervisor ───────► platform_workflow_dispatch_silent   ► notifications inbox
  reads: KV wf_last_dispatch:*             group_key: workflow_name            (no narrator path yet)

FC feed_health_pre + at_risk ─────────► platform_feed_at_risk               ► notifications inbox
  reads: feed_status.consecutive_failures   group_key: feed_name+date

feedRunner runFeed catch path ────────► platform_feed_auto_paused           ► notifications inbox
  reads: feed_configs threshold             group_key: feed_name

navigator + FC cron heartbeat ─────────► platform_cron_orchestrator_missed   ► notifications inbox
                                          + platform_cron_navigator_missed

cart enrichment_warnings phase ───────► platform_enrichment_stuck_pile      ► notifications inbox
  reads: threats stuck-pile counter

budget_ledger 24h aggregate ──────────► platform_ai_spend_burst             ► notifications inbox
  reads: budget_ledger SUM(cost)

handlers/briefing daily run ──────────► platform_briefing_silent            ► notifications inbox
  reads: threat_briefings.delivered_at      (when >24h since last)

geoip refresh stall supervisor ───────► platform_geoip_refresh_stalled      ► notifications inbox
  reads: geo_ip_refresh_log

dns-queue parity drift supervisor ────► platform_dns_queue_drift            ► notifications inbox
  reads: dns_queue COUNT (DNS_QUEUE_DB), threats drainable count (main DB)
  fires when |queue_size - drainable| > 500

dns-queue reconciler-stalled supervisor ► platform_dns_queue_stalled         ► notifications inbox
  reads: dns_queue COUNT, threats drainable, agent_outputs MAX(created_at)
         WHERE summary LIKE 'dns-queue-reconcile%' AND has activity
  fires when no enqueue/dequeue in 30 min AND drainable > queue + 500
```

**Key dependency:** ANY change to `getAgentHealth`'s `is_stalled` computation (PR-R reconciliation) directly affects whether `platform_agent_stalled` fires. Without PR-R's workflow-event reconciliation, nexus would generate a false `platform_agent_stalled` every FC tick (every hour), polluting the inbox AND triggering misleading "nexus stalled" entries in the daily briefing via `notification_narrator`.

**Dedup convention:** All `emitPlatformNotification` calls use a `group_key`. The notifications table has a UNIQUE constraint on `(group_key, dedup_window)` so re-firing the same key within the window is a no-op insert. See `lib/platform-templates.ts` for the canonical group_key shapes.

---

## 4. Feeds → Pipeline → Agents flow

```
Cron `7 * * * *`
  │
  ▼
runThreatFeedScan
  │
  ├─► runAllFeeds (loops 38+ feeds)
  │     │
  │     ├─ shouldRunNow check (feed_status.next_retry_at — PR-K circuit breaker)
  │     ├─ feedModule.ingest(ctx) — HTTP fetch + parse + insert into threats
  │     ├─ on success: feed_status.consecutive_failures=0, next_retry_at=NULL
  │     └─ on failure: increment consecutive_failures, stamp next_retry_at
  │                    (exponential backoff + jitter — PR-K)
  │
  ├─► sentinel agent (event-driven on feedResult.totalNew > 0)
  │     │
  │     ├─ writes threats.target_brand_id matches
  │     ├─ writes alerts for high-severity
  │     └─ emits agent_events feed_pulled (telemetry-only — PR-L)
  │
  ├─► analyst agent (every tick, inline await ~113s)
  │     └─ classifies unlinked threats, AI-attribution via Haiku
  │
  └─► nexus workflow dispatch (hour%4===0, via dispatchWorkflow)
        │
        └─► NEXUS_RUN workflow
              ├─ ASN correlation → infrastructure_clusters
              ├─ pivot detection → agent_events pivot_detected → observer (one wired edge)
              └─ provider trends → hosting_providers.trend_7d/30d

Cron `8 * * * *` (PR-E)     → enricher          (domain_geo + brand backfills)
Cron `9 * * * *` (PR-F)     → cartographer      (AI scoring + email scans + provider stats)
Cron `10 */6 * * *` (PR-Q)  → strategist
Cron `11 */6 * * *` (PR-Q)  → sparrow            (takedown automation)
Cron `12 */6 * * *`         → cube_healer        (30-day cube rebuild)
Cron `13 */6 * * *` (PR-Q)  → app_store_monitor
Cron `14 */6 * * *` (PR-Q)  → dark_web_monitor
Cron `15 */6 * * *` (PR-Q)  → social_discovery + social_monitor (paired)
Cron `*/5 * * * *`          → navigator          (DNS resolution, cube refresh, cache warming)
Cron `13 13 * * *`          → daily briefing
```

**Cross-cutting dependencies:**

- **Cart depends on threats from feeds + sentinel matches**: cart's AI provider scoring uses `hosting_providers.threat_count` (maintained by sentinel matches).
- **Nexus depends on cart's `threats.asn` enrichment**: ASN correlation can only group by ASN if cart has filled `threats.asn`. Pre-PR-D the inline cart path was killing the worker before nexus's workflow ran; PR-D made nexus its own workflow with independent budget so this no longer matters.
- **Pre-computed columns** maintained by cart Phase 5 keep `hosting_providers.active_threat_count` + `.total_threat_count` fresh; nexus's workflow (PR-C cube-ified) reads from these instead of scanning threats.
- **FC stall detection (`is_stalled`) feeds `platform_agent_stalled` notification**: when an agent doesn't run on its expected cadence, FC marks it stalled and emits the alert. PR-R reconciles workflow agents so they don't false-fire.

---

## 5. Adding a new surface — the checklist

When adding any new handler / endpoint / agent / UI page that derives agent status:

- [ ] Does it read from `agent_runs`? → If yes, ALSO call `getWorkflowAgentStats(db)` and reconcile per the PR-J/PR-R pattern.
- [ ] Does it derive `is_stalled` or similar staleness booleans? → Same reconciliation.
- [ ] Does it count "failures" or "successes" over a window? → Workflow-dispatched agents need their workflow events counted, not just agent_runs.
- [ ] Will it emit a notification on a per-agent threshold? → Make sure the threshold check uses the reconciled values.
- [ ] Update THIS doc with the new surface in the table in §2.

When adding a new workflow-dispatched agent:

- [ ] Workflow class extends `WorkflowEntrypoint`, emits `started` and `batch_complete` events.
- [ ] Dispatch via `dispatchWorkflow()` (PR-A) for the cooldown + last-dispatch stamp.
- [ ] Add to `agent_activity_log` event_type list in `getWorkflowAgentStats` if any new event types are introduced.
- [ ] Test via diagnostics endpoint — the rollup should show `dispatch_source: 'workflow'` and the correct success/failed counts.

---

## 6. Where each major UI page gets its data

| Page | Path | Endpoint(s) it consumes |
|---|---|---|
| Home (ops) | `/` | `/api/dashboard/overview`, `/api/agents/stats` |
| Observatory | `/observatory` | `/api/observatory/{nodes,arcs,stats,operations,live}` |
| Brands grid | `/brands` | `/api/brands` |
| Brand detail | `/brands/:id` | `/api/brands/:id` (which itself includes threats, alerts, takedowns) |
| Threats | `/threats` | `/api/threats/list`, `/api/threats/stats` |
| Agents | `/agents` | **`/api/agents`** (PR-R reconciled) |
| Agent detail | `/agents/:name` | `/api/agents/:name`, `/api/agents/:name/health` (TODO: reconcile in follow-up) |
| Alerts | `/alerts` | `/api/alerts/list`, `/api/alerts/stats` |
| Feeds | `/feeds` | `/api/admin/feeds` |
| Diagnostics admin | `/admin/diagnostics` | **`/api/internal/platform-diagnostics`** (PR-J reconciled) |
| Public status (tenant + marketing) | `/status` | **`/api/internal/platform-status`** (PR-R reconciled) |

---

## 7. Source-of-truth quick reference

| Question | Read from |
|---|---|
| "Has cron X fired recently?" | `agent_runs` for inline agents, `agent_activity_log` workflow events for workflows. **Use `getWorkflowAgentStats` to reconcile.** |
| "How many threats today?" | `threats` table directly (or `cachedCount('count.threats.total', ...)` for hot paths — PR-I) |
| "Is feed X healthy?" | `feed_status` (live state) + `feed_pull_history` (forensic) |
| "Has agent X been failing?" | `agent_runs.status='failed'` count + `agent_activity_log` workflow_dispatch_failed count. Reconcile via helper. |
| "What's our AI spend today?" | `budget_ledger` SUM(cost_usd). Single source. |
| "Why is the platform degraded?" | `platform-status` endpoint's `note` field. Per-category. |
| "What did agent X output recently?" | `agent_outputs` filtered by `agent_id` + recency |
| "What's queued in the enrichment pipeline?" | `threats WHERE enriched_at IS NULL` — but use `cachedCount` keys `count.threats.carto_queue*` for diagnostics surfaces (PR-I) |

---

## 8. Change log

| PR | Date | Change |
|---|---|---|
| PR-A | 2026-05-13 | KV stamp + cooldown for workflow dispatch (`wf_last_dispatch:*`, `wf_cooldown:*`); `platform_workflow_dispatch_silent` alert |
| PR-B/D | 2026-05-13 | NEXUS cron → workflow dispatch via PR-A's helper |
| PR-E | 2026-05-13 | Enricher → dedicated `8 * * * *` cron |
| PR-F | 2026-05-13 | Cartographer → dedicated `9 * * * *` cron |
| PR-J | 2026-05-14 | Diagnostics `agent_mesh.per_agent` reconciliation with `agent_activity_log` workflow events |
| PR-K | 2026-05-14 | Per-feed circuit breaker (`feed_status.next_retry_at` + exponential backoff + jitter) |
| PR-L | 2026-05-14 | `agent_events` → telemetry-only (except `pivot_detected`); CLAUDE.md §6 rewritten |
| PR-M | 2026-05-14 | `CartographerMainWorkflow` class + binding + manual endpoint (cron cutover deferred) |
| PR-N | 2026-05-14 | Deterministic `anthropic-idempotency-key` header on every Anthropic call |
| PR-Q | 2026-05-14 | 5 agents (strategist + sparrow + 3 monitors) → dedicated 6-hourly crons |
| PR-R | 2026-05-14 | Shared `lib/workflow-agent-stats.ts` helper; applied to `/api/agents`, FC `getAgentHealth`, platform-status realtime |
| PR-S | 2026-05-14 | Brands top-level Lookalikes card → query `threats` (27K+ attributed typosquats) instead of empty `lookalike_domains` (PR-H pattern for the ops Brands page); documented dark-web data gap |
| PR-T | 2026-05-14 | Daily brand-score batch (`computeBrandScoresBatch`) → dedicated `16 0 * * *` cron after a starvation diagnosis showed `brand_score_snapshots` at 0 rows since launch (orchestrator hour===0 inline await never reached the block). Movers SQL in `lib/brand-aggregates.ts` loosened from strict 6-8 day window to "oldest snapshot in 1-8 days" so the Brands page Improving/Declining cards light up as soon as ≥1 day of history exists and naturally extend to the full 7-day diff. |
| PR-U | 2026-05-14 | Brands "Attack types" card → donut over backend-supplied top-8 `threat_type_breakdown` instead of single-value bar treatment. |
| PR-V | 2026-05-14 | Cache-discipline pass: wrap brands count, unify `admin.threats_*` → `count.threats.*`, bump diagnostics carto-queue TTLs 60→300s. |
| PR-X | 2026-05-14 | Billing-cycle (18th-17th) D1 tracker. New `fetchBillingCycleMetrics` aggregates rows_read across all account D1 databases, replaces 24h × 30 projection. UI surfaces per-database breakdown. |
| PR-Y | 2026-05-14 | Top-queries leaderboard now includes `databaseId` dimension — each card shows which DB the query came from. |
| PR-Z | 2026-05-14 | New `threat_cube_arcs` (country × brand × type × severity per hour). `handleObservatoryArcs` + `handleObservatoryBrandArcs` swapped to read from cube — eliminates the largest D1 spender on the trust-radar side (~14M reads/24h → ~0.5M). Same OLAP-cubes pattern as `threat_cube_geo` / `threat_cube_brand` / `threat_cube_provider` / `threat_cube_status`. |

---

## 9. Known data gaps (modules with no live data)

Surfaces that render a card / endpoint but currently have no data because the ingestion path isn't built or isn't wired:

| Surface | Backing table | Card behaviour today | Build status |
|---|---|---|---|
| Brands top-level "Dark-web mentions" card | `dark_web_mentions` | "No signal yet" — table has 0 rows | The `dark_web_monitor` agent runs every 6h (PR-Q) but its current implementation in `scanners/dark-web-monitor.ts` operates against `brand_monitor_schedule` rows for a small monitored-brands subset. Pastebin (PSBDMP) is the only configured source; HIBP / Telegram / Flare integrations have NOT been built. Card lights up automatically the moment rows start landing — query is correct, just no data. |
| Brands top-level "Improving / Declining" cards | `brand_score_snapshots` | Empty until `16 0 * * *` cron has fired ≥1 time (PR-T). First night after deploy: empty. Second night onwards: populates as 1-day-delta movers, naturally extending toward 7-day diff as history accumulates. | Self-healing — no further build needed. Diagnose via `SELECT COUNT(*), MAX(snapshot_day) FROM brand_score_snapshots`. If still empty 48h after deploy, check `agent_runs.agent_id='brand_score_batch'` / `logger.info('brand_scores_daily_batch')` log line for cron firing. |

**Recovery checklist when one of these gaps is closed (new module ingests data):**
1. Verify the relevant `pressureAggregate` / `intelAggregate` query in `lib/brand-aggregates.ts` reads from the right table
2. Smoke-test the affected card on `/brands` (ops) and `/modules` (tenant)
3. Update this table to remove the entry
4. If the new module is workflow-dispatched, ensure `workflow-agent-stats.ts` event types cover it (§2)
