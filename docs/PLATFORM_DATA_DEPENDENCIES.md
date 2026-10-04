# Platform Data Dependencies

What reads from what. Where each surface gets its truth. The reconciliation rules.

This doc exists because the codebase has multiple status-of-the-system surfaces (Status page, Notifications, Agents API, Feeds API, Diagnostics) and each one used to read directly from `agent_runs` — which silently became wrong when workflow-dispatched agents (nexus, future cart) started writing to `agent_activity_log` instead. PR-J / PR-R introduced a shared reconciliation layer; this doc tracks all the consumers so future surfaces don't get added without applying the same pattern.

**Linked from:** `CLAUDE.md` §6 (Agent Architecture Rules), `docs/ARCHITECTURE.md`, `docs/AI_AGENTS.md`, `docs/runbooks/workflow-dispatch.md`.

---

## 1. Canonical data stores

| Table / KV key | Writer | Reader(s) | Purpose |
|---|---|---|---|
| `agent_runs` | `lib/agentRunner.executeAgent` at start/end | API, status, FC, diagnostics | Per-execution lifecycle for inline agents. Always seeded as status=`partial` (`completed_at` NULL) at start, then UPDATEd at end to `success` / `failed`, or to `partial` again when the run finished degraded (`AgentResult.degraded` — every AI call failed) or is held for approval. A finished run always has `completed_at`; **`partial` + `completed_at IS NULL` is in flight**, so never count `status='partial'` alone as either a failure or a success. |
| `agent_activity_log` | Workflow bodies (`workflows/*.ts`) AND `lib/workflow-dispatch.dispatchWorkflow` AND FC logActivity | API, status, FC, diagnostics, notification narrator | Per-event log. **Sole source of truth for workflow-dispatched agents** because they don't write to `agent_runs`. Event types: `workflow_dispatched`, `batch_complete`, `workflow_dispatch_failed`, `workflow_cooldown_skip`, `started`, `recovery`, `batch_complete` (FC tick), etc. |
| `agent_outputs` | Agent execute() bodies | Briefing, narrator, diagnostics (`/api/insights/latest` + Home "Latest Intel" retired in PR-D, 2026-10) | Per-agent insights / diagnostics. AI-generated content. Type column: `insight`, `correlation`, `diagnostic`. The legacy `score` (Cartographer) and `classification` (Analyst) types were folded into `insight` in the 2026-05-16 platform audit so they surfaced through the (since-retired) `/api/insights/latest`. Cartographer additionally gates Haiku scoring to providers with ≥5 active threats OR repeat-offender status (≥3 campaigns) — saves ~40% of its daily AI spend. |
| `agent_outputs.details` AI counters (`aiCallsAttempted` / `aiCallsSucceeded` / `aiCallsSkipped` / `aiFirstFailureKind` / `aiFirstError`) | analyst, sentinel, cartographer via `lib/haiku.ts` `newAiCallCounters` / `recordAiCall` — once per real API call, never per item | FC `platform_ai_calls_failing` and diagnostics `ai_health` (both `json_extract`, `json_valid`-guarded, agent-agnostic) | Strictly-API call outcomes. **Not** the legacy `haikuSuccesses` counters, which count rules-based skips as successes. Key names are a contract between the three writers and the two readers. |
| `agent_events` | Agents on completion | Orchestrator's `processAgentEvents` | Event-driven dispatch trigger. **Mostly telemetry** post-PR-L — only `pivot_detected` → Observer is wired. See CLAUDE.md §6 for the canonical chain vs the historical declared chain. |
| `agent_configs` | Admin endpoints, FC auto-pause logic | All status surfaces | Circuit breaker state (`enabled`, `paused_reason`, `consecutive_failures`, etc). |
| `feed_status` | `lib/feedRunner.runFeed` success/failure paths | Diagnostics, dashboard | Per-feed live state. PR-K added `next_retry_at` for the circuit breaker. |
| `feed_pull_history` | `lib/feedRunner.runFeed` at start | Diagnostics, milestones, dashboard | Per-pull log. Captures records_ingested, status, error_message, duration_ms. |
| `feed_configs` | Admin endpoints, auto-pause logic | feedRunner dispatch, diagnostics | Source URLs, schedules, enabled flag, paused_reason. |
| `budget_ledger` | `lib/anthropic.callAnthropic` | Diagnostics, budget UI, FC budget logic | Per-AI-call token + cost ledger. Single source for AI spend. **One row per SUCCESSFUL call, nothing on failure** — which makes `MAX(created_at)` the ground truth for "AI last worked" (FC `platform_ai_calls_failing`, diagnostics `ai_health.last_ledger_row_at`). A silent ledger alone cannot distinguish a quiet platform from an outage; pair it with the attempt counters in `agent_outputs.details`. |
| `notifications` | `lib/platform-templates.emitPlatformNotification` | UI inbox, notification_narrator, briefing | Platform alerts. Group_key for dedup. |
| `takedown_requests` | `handlers/takedowns` | Tenant takedowns page, sparrow agent, ops admin | Customer-initiated takedown requests with full lifecycle. |
| `threats` | Feeds, cart, enricher, analyst | Almost everything | Core threat intel table. Pre-computed columns (`brand.threat_count`, `hosting_providers.active_threat_count`) avoid full scans. |
| `phishing_pattern_signals` | `lib/phishing-pattern-writer.ts runPhishingSignalWriter`, endpoint-dispatched only (`POST /api/admin/phishing-signals/backfill`) — not an AgentModule, no `agent_runs`/`agent_events` (same precedent as `runAlertTriageBackfill`) | `brand-threat-correlator.ts correlateBrandThreats` (+15 risk factor + "AI-generated content" impersonation technique when `ai_generated_probability >= AI_GENERATION_PROBABILITY_THRESHOLD`), `agents/pathfinder.ts` (per-brand AI-phishing counts, same threshold), `runPhishingCampaignRollup` (self, reads its own rows to build `campaign_pattern_stats`) | One row per `spam_trap_captures` capture: deterministic (zero-AI) measurements — `template_hash`, `campaign_key`/`campaign_key_kind`, `url_obfuscation_type`, `impersonation_technique`, etc. — from the pure core `lib/phishing-pattern-signals.ts` (migration 0257 added the unique index + campaign columns on top of the dormant migration-0023 table). See §9 for the `ai_generated_probability` nuance. |
| `campaign_pattern_stats` | `lib/phishing-pattern-writer.ts runPhishingCampaignRollup`, endpoint-dispatched only (`POST /api/admin/phishing-signals/rollup`) | None yet — write-only as of phase-1; no handler/UI reads it | Campaign-grain rollup (`polymorphism_regime`, pairwise-Hamming stats, distinct-sender/domain/ASN counts) over `phishing_pattern_signals` groups sharing a `campaign_key`. No `ai_generated_probability`-equivalent column exists — deliberate, migration 0257. |
| `phantom_domains` | (1) `agents/phantomEnumerator.ts` (Phantom, `trigger: "manual"`, no cron) — writes new rows at `status='predicted'` only, one bounded Haiku pass per monitored/customer-tier brand. (2) `lib/phantom-matcher.ts runPhantomMatch` — post-pass dispatched via `POST /api/admin/phantom-domains/match` (super_admin) or `POST /api/internal/phantom-domains/match` (internal secret); READS `nrd_domains`/`ct_certificates`/`lookalike_domains` (lookalike gated `registered=1`), flips a matched phantom's `status` `predicted`→`registered` (guarded, at most once) and stamps `matched_source`/`matched_at`/`alert_id` | No UI/API list surface yet — read only by the two match endpoints above and by the enumerator's own dedup query | Wave 2 phantom-squat watchlist (migration 0258). A phantom is a PREDICTION, never a threat: the enumerator never calls `createAlert` and never inserts `threats`; the matcher raises **at most one** `low`-severity `alerts` row per hit (reusing `lookalike_domain_active` / `ct_certificate_issued` — no new alert_type) and likewise never writes `threats`. See `docs/AI_AGENTS.md` (Phantom) and `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` §3.3/§6 rec 3. |
| `threats.weaponization_hours` / `threats.weaponization_flag` | `lib/velocity-writer.ts runVelocityBackfill`, dispatched only via `POST /api/admin/velocity/backfill` (admin-gated) — not an AgentModule, no cron, no `agent_runs`/`agent_events` (same precedent as `runAlertTriageBackfill` / `runPhishingSignalWriter`) | `handlers/diagnostics.ts` `velocity` block (`GROUP BY weaponization_flag`, cachedValue-wrapped, key `diag.weaponization.distribution`, TTL 900s) | Wave 3 rec 5 (v1). Migration 0259. Pure decide-fn `lib/velocity-signatures.ts` (`decideWeaponizationVelocity`) buckets the whole-hours `first_seen − domain_created_at` delta into `very_fast` (≤24h) / `fast` (≤72h) / `normal` (>72h); NULL when not computable (missing/unparseable WHOIS date, negative delta beyond tolerance, pre-1985 sentinel), kept distinct from `normal`. Metadata/evidence ONLY — must never gate `lib/alert-triage.ts` / `lib/alert-ai-judge.ts`. See `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` §3.4/§6 rec 5. |
| `lookalike_domains.page_anti_bot_wall` | `scanners/lookalike-page-analysis.ts` (persists `PagePhishingResult.antiBotWallFamily` from `lib/page-phishing-scorer.ts`, itself fed by `lib/page-fetch.ts`'s wall detection) | `handlers/diagnostics.ts` `page_analysis` block (`GROUP BY page_anti_bot_wall`, cachedValue-wrapped, key `diag.page_analysis.cloaking.v2`, TTL 600s — the `.v2` suffix is load-bearing, the block's shape changed in Lane 3 Phase 1 and a stale key would keep serving the old shape after deploy) | Wave 3 rec 4 (cloaking-as-signal). Migration 0260. Authoritative anti-bot-wall family (`turnstile`/`recaptcha`/`hcaptcha`/`cf_challenge`/`js_challenge`) for the last successful page analysis, or NULL when no wall was seen. The fired `anti_bot_wall` signal (weight 20) also lands in the existing `page_signals` JSON array and carries a monotonic MEDIUM threat-level floor in `escalateThreatLevelForPage`. See `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` §3.5/§7.2/§6 rec 4. |
| `lookalike_domains.page_ai_signals` · `page_score_delta` · `page_generator` · `page_exfil_sink` · `page_exfil_sink_id` · `page_evidence` | `scanners/lookalike-page-analysis.ts` — **success UPDATE only**; the failure UPDATE never writes them, which is what makes non-NULL `page_ai_signals` usable as the "reached the scorer" marker in diagnostics | (1) `handlers/diagnostics.ts` `page_analysis.ai_build` / `.exfil` / `.generator` / `by_fetch_outcome[]`; (2) staff `GET /api/lookalikes/:brandId` via the `LOOKALIKE_LIST_COLUMNS` allowlist → `SignalBreakdownCard` on the ops Brand **Risk** tab; (3) tenant `handlers/tenantDomainModule.ts` → `BrandDomainFindings` Signals chip + `PageAnalysisDialog` — **`page_evidence` excluded here**; (4) `lookalike_domain_active` alert `details` via `buildPageEvidenceDetails` (`lib/lookalike-alert-policy.ts`, moved there from `scanners/lookalike-domains.ts` when the page-analysis pass became a second alert producer) — the two sink fields and `page_evidence` excluded | Lane 3 shadow mode. Migration 0264 (six ADD COLUMNs, no index). **SHADOW: computed and persisted, contributing nothing to `page_phishing_score`, threat level or alert triage** — `page_score_delta` is the would-be contribution, never added. Two fields are handling-sensitive: `page_exfil_sink` is a live attacker C2 host and must be defanged at every render site and never a link or auto-linkified value; `page_evidence` is a literal lifted verbatim from attacker page content (the one page field with no closed vocabulary) and is staff-only — absent from the tenant SELECT, the tenant interface and alert `details`, with `test/lookalike-list-columns.test.ts` pinning that asymmetry from both sides. Nothing may write `phishing_pattern_signals.ai_generated_probability`; per-message MGT detection is a rejected doctrine, not a gap. See `docs/LANE3_AI_BUILD_ARTIFACTS_SPEC.md` §3.5/§5/§11 and `docs/AI_THREAT_INTEL_FEEDS_PLAN_2026-09.md` §13. |
| `lookalike_domains.baseline_established_at` | `scanners/lookalike-domains.ts` `checkLookalikeBatch` — stamped in the per-check UPDATE via a bound `CASE WHEN ? = 1` flag that is now derived from **this column itself** (`baseline_established_at IS NULL`, migration 0267 amended — it was `last_checked IS NULL`), so it is written once per row and never re-stamped and no scheduling operation can forge first contact; written on EVERY first contact, including one that finds the domain unregistered (the column records our coverage, not the domain's status) | staff `GET /api/lookalikes/:brandId` via the `LOOKALIKE_LIST_COLUMNS` allowlist. Deliberately absent from the tenant SELECT in `handlers/tenantDomainModule.ts` — crawl coverage is pipeline detail, the same product call made for `page_last_outcome`. No diagnostics consumer yet | Migration 0267 (one ADD COLUMN, no index). Distinguishes "we have never looked" from "we looked and it was not registered", which `registered = 0` alone could not: the seeder's INSERT leaves `registered` at its default, so first contact with an old squat used to read as a fresh registration and fire a Haiku call + a `createAlert`. First contact is now BASELINE ESTABLISHMENT — it alerts only on a real signal (`has_mx AND has_web`) and otherwise spends NO tokens and files NO alert. `first_seen` keeps its narrower meaning (a `0 → 1` transition we observed) and BOTH columns may be set on one row. Paired with the HIGH/CRITICAL alert floor in `lib/lookalike-alert-policy.ts` and the second alert producer in `scanners/lookalike-page-analysis.ts` (`raiseUnalertedPhishingPageAlert`), which is what keeps a row suppressed at first contact reachable if its page later scores as phishing. |
| `lookalike_domains.check_due_at` · `check_attempts` | `scanners/lookalike-domains.ts` — FOUR writers, and they are the whole schedule: `generateAndStoreLookalikes` (new candidate, `datetime('now')` = due immediately), the per-check success UPDATE (`datetime('now', '+24 hours')`, `check_attempts = 0`), `stampCheckFailure` (the jittered ladder from `lib/backoff.ts`, writing a **BOUND** `check_attempts` the caller already derived to pick the ladder step — never `check_attempts + 1`, which was a second derivation that diverged on every throw past the success path's `check_attempts = 0` reset and pinned the counter at a fixed point the ladder could never terminate on — or **NULL to PARK** past 8 consecutive failures), and `handlers/lookalikeDomains.ts handleScanLookalikes` (`'1970-01-01 00:00:00'` + `check_attempts = 0` — a priority enqueue that also revives a parked row, bounded at `LOOKALIKE_RESCAN_ENQUEUE_LIMIT` rows per press and skipping rows already at the epoch, because the queue it jumps is global and cross-tenant). A FIFTH writer re-admits parked rows: `unparkOldestRows`, on the checker's own tick, bounded per run and self-throttling on `last_check_failed_at` — without it a park was terminal in practice, since the other writers either never touch an existing row or require the row to have been selected. | The two cohort SELECTs + the brand-scoped rescan selector in `scanners/lookalike-domains.ts`; `agents/flightControl.ts` gauges `backlog.lookalike_dns_due` / `backlog.lookalike_parked` (+ the `lookalike_backlog` activity-log warning); staff `GET /api/lookalikes/:brandId` via `LOOKALIKE_LIST_COLUMNS`. Absent from the tenant SELECT. | Migration 0269 (two ADD COLUMNs, two partial cohort indexes keyed on `check_due_at` + one parked index, ANALYZE, and a backfill so no pre-existing row reads as parked). Separates DUENESS from the first-contact discriminator and from `last_checked`, which had been carrying all three jobs at once — so every scheduling write was also a reclassification. NULL means PARKED, and because both cohort indexes are partial on `check_due_at IS NOT NULL` a parked row holds no index entry and costs zero reads structurally. **`last_checked` and `last_check_failed_at` are now read by NO selection predicate**; `test/lookalike-sql-statements.test.ts` asserts that mechanically. The parked index is keyed on `last_check_failed_at` so it serves both FC's gauge and the un-park sweep's ordered range. Bounds and thresholds live in `lib/lookalike-budget.ts`, which is also where `agents/flightControl.ts` reads the drain size and the gauge's probe ceiling from — importing them from the scanner dragged `lib/haiku` / `email-security` / `lib/page-fetch` into FC's import graph. FC's due gauge is now a BOUNDED probe (`COUNT(*) FROM (SELECT 1 … LIMIT 51)` per cohort): the exact form read one index entry per due row, 300K-600K reads/day during the seeder drain, to answer a boolean. |
| `lookalike_domains.bimi_first_seen_at` | `scanners/lookalike-domains.ts` `probeAndFileBimi` — a guarded claim (`UPDATE … WHERE id = ? AND bimi_first_seen_at IS NULL`) taken only when a BIMI record is OBSERVED, released on every path that does not file the alert — a thrown `createAlert` **and a missing brand row**, which originally took neither branch (`if (brand)` was simply skipped, nothing threw) and left the row permanently marked BIMI-recorded with no alert in existence. A release that itself fails is counted on the agent diagnostic (`bimi_claim_release_failures`), being the one remaining path to a silently and permanently lost finding. **Never written to record absence**: `checkBIMIExists` catches its own errors and returns `false`, so absence and lookup-failure are the same value at the call site. | The BEC lane's own eligibility predicate (`registered = 1 AND has_mx = 1 AND bimi_first_seen_at IS NULL`), which is what makes the lane recurring AND file-once; staff `GET /api/lookalikes/:brandId`. Absent from the tenant SELECT. | Migration 0269 §2 (one ADD COLUMN, **no index** — the `(registered, has_mx) WHERE … bimi_first_seen_at IS NULL` partial index this migration originally carried had no reader in `src/` at all and was removed; it was designed for a standalone BEC SELECT the cadence deviation then decided not to write, and cost an index entry per eligible row rewritten on every successful check since the success path writes both `registered` and `has_mx`). The lane's real cadence post-seed is ~47 days (56,040 rows / 1,200 checks per day), NOT the 24 h success cadence. The BIMI check used to be reachable ONCE per row — first contact only — so a squat publishing BIMI after we baselined it was invisible forever, and `analyzeLookalikePages` cannot see the mail-only shape either (it requires `has_web = 1`). The `typosquat_bimi` alert id is deliberately NOT written to `alert_id`: `raiseUnalertedPhishingPageAlert` keys on `alert_id IS NULL` and one parked there would permanently suppress that row's phishing-page alert. |
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
| `/api/internal/platform-status` `categories[agents]` realtime | `lib/platform-status.computeAgentsRealtime` (PR-R) | 6h success rate for the agents category pill. `success` and finished `partial` count as successes; `completed_at IS NULL` rows are excluded (see `PUBLIC_UPTIME_SEMANTICS` in the file) | Status page shows degraded; nexus contributes 0 successes |

**Surfaces that DO NOT need reconciliation (correct by construction):**

- AI spend (`budget_ledger`) — workflow's `callAnthropic` writes there too
- KV-stamped supervisor (`wf_last_dispatch:*`) — workflow-aware by design
- Diagnostics `cron_health` — looks at navigator + flight_control + orchestrator, none of which are workflow-dispatched

**Surfaces still on agent_runs-only (acceptable):**

- `computeAgentsDaily` (status page trailing 30d chart) — historical accuracy of the dip during nexus's pre-workflow outage is correct. Same success/`partial`/`completed_at` semantics as the realtime function: an internal AI outage (degraded `partial` runs) is deliberately not a public availability event
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

budget_ledger silence + agent_outputs ► platform_ai_calls_failing           ► notifications inbox
  details AI counters (FC, hourly)         group_key: platform_ai_calls_failing:<UTC date>
  reads: MAX(budget_ledger.created_at) > 2h AND an agent with >= 3 aiCallsAttempted,
         0 aiCallsSucceeded in the same 2h window (severity: high, audience: super_admin,
         dedup -50 min — not critical, which would auto-create a public-status incident)

handlers/briefing daily run ──────────► platform_briefing_silent            ► notifications inbox
  reads: threat_briefings.delivered_at      (when >24h since last)

geoip refresh stall supervisor ───────► platform_geoip_refresh_stalled      ► notifications inbox
  reads: geo_ip_refresh_log

dns-queue parity drift supervisor ────► platform_dns_queue_drift            ► notifications inbox
  reads: dns_queue COUNT (DNS_QUEUE_DB), threats drainable count (main DB)
  fires when |queue_size - drainable| > 500

dns-queue reconciler-stalled supervisor ► platform_dns_queue_stalled         ► notifications inbox
  reads: dns_queue COUNT, threats drainable, latest agent_outputs row
         WHERE summary LIKE 'dns-queue-reconcile%' (reads details.cursor_lag_minutes)
  fires when cursor_lag_minutes > 30 AND drainable > queue + 500
         (PR-BI cursor architecture — replaced the pre-PR-BI 'no enqueue/dequeue in 30 min' check)

dns-queue reaper-stalled supervisor ───► platform_dns_queue_reaper_stalled   ► notifications inbox
  reads: CACHE.get('reconciler:dns_queue:reaper_last_run') (KV stamp)
         CACHE.get('reconciler:dns_queue:reaper_last_delta')
  fires when hours_since_last_run > 36 (severity: medium)
         No baseline established yet → YELLOW until first hour===0 tick after PR-BI deploy
```

**Key dependency:** ANY change to `getAgentHealth`'s `is_stalled` computation (PR-R reconciliation) directly affects whether `platform_agent_stalled` fires. Without PR-R's workflow-event reconciliation, nexus would generate a false `platform_agent_stalled` every FC tick (every hour), polluting the inbox AND triggering misleading "nexus stalled" entries in the daily briefing via `notification_narrator`.

**Dedup convention:** All `emitPlatformNotification` calls use a `group_key`. Dedup is application-level, not a DB constraint (the `notifications` table has no UNIQUE on it): `createNotification` runs a `SELECT 1 … WHERE type=? AND group_key=? AND created_at > datetime('now', <window>) ORDER BY created_at DESC LIMIT 1` first and returns 0 on a hit; the window is the event's `dedupWindow` in the shared registry. That query is served by `idx_notifications_dedup (type, group_key, created_at DESC)`.

**Adding a notification key is a two-part change.** Register it in `packages/shared/src/notification-events.ts` (`KNOWN_EVENT_KEYS`, dedup windows and the toggleable set all derive from it) **and** ship a migration that widens the `notifications.type` CHECK, which is a hand-maintained copy of the registry (re-synced in 0207, 0215, 0265, 0272). A key in the registry but not in the CHECK passes `createNotification`'s guard and then throws at INSERT; Flight Control's mandatory try/catch turns that into a `console.warn` and zero rows, so the alert fails silently. `test/notification-check-drift.test.ts` fails CI on the file-level mismatch, but it checks the migration *file* — it cannot tell you production has applied it (see `docs/DEPLOYMENT.md` "Database Migrations"). Separately, `createNotification` now logs a `console.warn` and returns 0 when an audience resolves to zero recipients (e.g. no active `super_admin`) — previously a silent no-op. See `lib/platform-templates.ts` for the canonical group_key shapes.

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
| "Is AI actually working?" | Diagnostics `ai_health` (`hours_since_last_call` + `per_agent[].attempted/succeeded`). **Not** `ai_spend_24h` (cost only) and **not** the legacy `haikuSuccesses` counters. |
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
| PR-Z | 2026-05-14 | New `threat_cube_arcs` (country × brand × type × severity per hour). `handleObservatoryArcs` + `handleObservatoryBrandArcs` swapped to read from cube — eliminates the largest D1 spender on the backend side (~14M reads/24h → ~0.5M). Same OLAP-cubes pattern as `threat_cube_geo` / `threat_cube_brand` / `threat_cube_provider` / `threat_cube_status`. |
| AI-outage detection | 2026-10-01 | Silent-AI-failure guard after ~3 months of zero working AI (last `budget_ledger` row 2026-07-10, Anthropic HTTP 400 credit balance). `failure_kind` on `lib/haiku.ts` results; strictly-API counters in analyst/sentinel/cartographer; `AgentResult.degraded` → run finalizes `partial`; FC `platform_ai_calls_failing` (migration 0272); diagnostics `ai_health`; public-status uptime counts finished `partial` as success and excludes in-flight rows. Branch `claude/averrow-intel-feeds-research-ukhoef`. |

---

## 9. Known data gaps (modules with no live data)

Surfaces that render a card / endpoint but currently have no data because the ingestion path isn't built or isn't wired:

| Surface | Backing table | Card behaviour today | Build status |
|---|---|---|---|
| Brands top-level "Dark-web mentions" card | `dark_web_mentions` | "No signal yet" — table has 0 rows | The `dark_web_monitor` agent runs every 6h (PR-Q) but its current implementation in `scanners/dark-web-monitor.ts` operates against `brand_monitor_schedule` rows for a small monitored-brands subset. Pastebin (PSBDMP) is the only configured source; HIBP / Telegram / Flare integrations have NOT been built. Card lights up automatically the moment rows start landing — query is correct, just no data. |
| Brands top-level "Improving / Declining" cards | `brand_score_snapshots` | Empty until `16 0 * * *` cron has fired ≥1 time (PR-T). First night after deploy: empty. Second night onwards: populates as 1-day-delta movers, naturally extending toward 7-day diff as history accumulates. | Self-healing — no further build needed. Diagnose via `SELECT COUNT(*), MAX(snapshot_day) FROM brand_score_snapshots`. If still empty 48h after deploy, check `agent_runs.agent_id='brand_score_batch'` / `logger.info('brand_scores_daily_batch')` log line for cron firing. |
| "AI-generated phishing" signal — `brand-threat-correlator.ts`'s `ai_phishing_count_30d` / "AI-generated content" technique / composite-score +15, and Analyst's "AI-Generated Threat Detected" insight | `phishing_pattern_signals.ai_generated_probability` | Count stays 0 and the insight never fires. The correlator's query (`ai_generated_probability >= AI_GENERATION_PROBABILITY_THRESHOLD`, shared constant in `lib/phishing-signals.ts`) is correct SQL against a real column, but the phase-1 writer (`lib/phishing-pattern-writer.ts` / `lib/phishing-pattern-signals.ts`) structurally never writes that column — it's typed `null`-only (`AiGeneratedProbability`) and runtime-guarded (`assertEvidenceOnly`) by design: phase-1 is evidence-only deterministic measurement, not an AI verdict (research doc §0.2 rule 1). `agents/pathfinder.ts` has the identical downstream-zero pattern (its brand AI-phishing GROUP BY reads the same column). | Waiting on a future campaign-level AI judge (not yet built — `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` §6 item 6) to score `ai_generated_probability`. This is the intended sequencing, not a bug: fix the dead reads first (done this wave), measure deterministically first (done this wave), add the judge last. |

**Recovery checklist when one of these gaps is closed (new module ingests data):**
1. Verify the relevant `pressureAggregate` / `intelAggregate` query in `lib/brand-aggregates.ts` reads from the right table
2. Smoke-test the affected card on `/brands` (ops) and `/modules` (tenant)
3. Update this table to remove the entry
4. If the new module is workflow-dispatched, ensure `workflow-agent-stats.ts` event types cover it (§2)
