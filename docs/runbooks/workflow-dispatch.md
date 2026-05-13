# Workflow Dispatch Runbook

Companion runbook for `packages/trust-radar/src/lib/workflow-dispatch.ts`
and the FC supervisor block that watches it.

Three workflows live in the trust-radar worker:

| Binding | Class | wrangler.toml `name` |
|---|---|---|
| `CARTOGRAPHER_BACKFILL` | `CartographerBackfillWorkflow` | `cartographer-backfill` |
| `NEXUS_RUN` | `NexusWorkflow` | `nexus-run` |
| `GEOIP_REFRESH` | `GeoipRefreshWorkflow` | `geoip-refresh` |

GeoIP has always dispatched through its own self-healing path
(see `agents/geoip-refresh.ts`). Cartographer and nexus dispatch
through `dispatchWorkflow()` after PR-B lands.

## What the helper guarantees

| Concern | Mechanism |
|---|---|
| Platform `WorkflowInternalError` flooding | KV cooldown `wf_cooldown:<name>` (1h TTL) — subsequent dispatches skip while active |
| Dispatch attempts going silent | KV stamp `wf_last_dispatch:<name>` (7d TTL) — FC supervisor alerts when stale |
| Per-dispatch audit trail | Every outcome (dispatched / cooldown / failed) writes a row to `agent_activity_log` |

## FC supervisor thresholds

| Workflow | Expected interval | Alert threshold (3×) |
|---|---|---|
| `cartographer-backfill` | 1h (post-sentinel, when totalNew > 0) | 3h |
| `nexus-run` | 4h (cron at hour%4===0) | 12h |

Alert template: `renderPlatformWorkflowDispatchSilent` in
`lib/platform-templates.ts`. Group key:
`platform_workflow_dispatch_silent:<workflow>`.

## Verification (PR-A landing)

### 1. Type check + unit tests pass

```bash
cd packages/trust-radar
npx tsc --noEmit
npx vitest run test/workflow-dispatch.test.ts
```

Expected: TS clean, 6 tests passing.

### 2. FC tick still completes after deploy

Pull live diagnostics and confirm the new phase appears in
`fc_tick_timings.timings`:

```bash
./scripts/platform-diagnostics.sh | jq '.data.fc_tick_timings.timings.workflow_dispatch_supervisor'
```

Expected: a number ≥ 0 (typically <20 ms since we only do 2 KV reads).

### 3. Supervisor stays quiet while nothing dispatches yet

```bash
./scripts/platform-diagnostics.sh | \
  jq '.data.recent_platform_alerts.items[] | select(.type == "platform_workflow_dispatch_silent")'
```

Expected: empty (no alert). The supervisor's `lastDispatch === null`
branch skips alerting until PR-B starts dispatching.

### 4. Manual dispatch endpoint stamps KV

Hit the existing manual nexus workflow endpoint and confirm the KV
stamp appears:

```bash
curl -sS -X POST -H "Authorization: Bearer ${AVERROW_INTERNAL_SECRET}" \
  "https://averrow.com/api/internal/agents/nexus/workflow" | jq

# Then re-pull diagnostics; the new dispatch should show up in the
# agent_activity_log via:
```

> **Note:** this verifies the workflow class itself can be created.
> The endpoint at `index.ts:432` does **not** yet route through
> `dispatchWorkflow()` (that's PR-B). To verify the helper directly,
> rely on the unit tests.

## Verification (PR-B landing)

PR-B switches the orchestrator cron's nexus dispatch from inline
`executeAgent` to `dispatchWorkflow(env, { workflow: env.NEXUS_RUN, ... })`.
Cartographer FC scaling is intentionally unchanged in PR-B because the
cartographer-backfill workflow is enrichment-only — switching FC scaling
to it would silently skip the AI provider scoring + email security scans
the agent module performs.

### 1. Next orchestrator cron tick at `hour % 4 === 0` writes a workflow_dispatched row

```bash
# Wait for the next 00/04/08/12/16/20 UTC :07 tick, then:
wrangler d1 execute trust-radar-v2 --remote --command "
  SELECT created_at, event_type, message
  FROM agent_activity_log
  WHERE agent_id = 'nexus'
    AND event_type IN ('workflow_dispatched','workflow_dispatch_failed','workflow_cooldown_skip')
  ORDER BY created_at DESC
  LIMIT 3"
```

Expected: at least one `workflow_dispatched` row with the new instance id.

### 2. KV last-dispatch stamp is fresh

The supervisor reads this stamp; fresh = under 12h old.

```bash
wrangler kv:key get --binding=CACHE wf_last_dispatch:nexus-run --remote
```

Expected: JSON `{ "instance_id": "...", "dispatched_at": "..." }`.

### 3. agent_runs row is populated by the workflow

The workflow body writes `agent_runs` entries on start/complete. After
the workflow finishes (typically <5 min):

```bash
wrangler d1 execute trust-radar-v2 --remote --command "
  SELECT id, status, started_at, completed_at, records_processed
  FROM agent_runs
  WHERE agent_id = 'nexus'
  ORDER BY started_at DESC LIMIT 3"
```

Expected: a fresh row with `status = 'success'` and `records_processed > 0`.

### 4. No new stuck-partial rows from cron path

```bash
wrangler d1 execute trust-radar-v2 --remote --command "
  SELECT COUNT(*) as stuck
  FROM agent_runs
  WHERE agent_id = 'nexus'
    AND status = 'partial'
    AND completed_at IS NULL
    AND started_at >= datetime('now', '-24 hours')"
```

Expected: 0 after the first successful workflow run.

### 5. (Negative) Manual `/api/internal/agents/nexus/run` still uses the agent module

```bash
curl -sS -X POST -H "Authorization: Bearer ${AVERROW_INTERNAL_SECRET}" \
  "https://averrow.com/api/internal/agents/nexus/run" | jq
```

Expected: a synchronous response with `runId` — the inline path is
preserved as the operator fallback for when CF Workflows is degraded.

## Verification (PR-C landing)

PR-C replaces the heavy correlated-subquery `UPDATE hosting_providers`
block in `agents/nexus.ts` with the cube-based version mirrored from
`workflows/nexusRun.ts`. The agent module is the manual-trigger
fallback at `/api/internal/agents/nexus/run`; PR-C keeps it cheap
enough to actually use if Cloudflare Workflows is degraded and we
need to force a run.

Live cube numbers (2026-05-13):
- threats: 276,106 (and growing)
- threat_cube_provider 30d slice: **15,719 rows**
- distinct providers in cube: **2,654** (vs 5,173 total)

EXPLAIN QUERY PLAN: `SCAN threat_cube_provider USING INDEX idx_cube_provider_id_hour` — single covering-index scan, ~15.7K rows. Down from millions of correlated-subquery reads.

### 1. Manual nexus run via inline path completes in <60s

Trigger the inline agent module (the path PR-C defends):

```bash
curl -sS -X POST -H "Authorization: Bearer ${AVERROW_INTERNAL_SECRET}" \
  "https://averrow.com/api/internal/agents/nexus/run" | jq

# Then immediately:
wrangler d1 execute trust-radar-v2 --remote --command "
  SELECT id, status, duration_ms/1000.0 AS sec, records_processed
  FROM agent_runs WHERE agent_id='nexus'
  ORDER BY started_at DESC LIMIT 1"
```

Expected: `status='success'`, `sec < 60`, `records_processed > 0`.
Pre-PR-C the same call would tip into `partial`+reap after >180 min.

### 2. providersUpdated count is sensible

After a successful run, count providers whose `trend_7d` or `trend_30d`
were set (the new code only writes when the cube has a row):

```bash
wrangler d1 execute trust-radar-v2 --remote --command "
  SELECT COUNT(*) AS providers_with_trend
  FROM hosting_providers
  WHERE trend_7d > 0 OR trend_30d > 0"
```

Expected: a value in the low-thousands — matches the cube's distinct
hosting_provider_id count (currently ~2,654).

### 3. active_threat_count / total_threat_count still maintained

These columns are owned by cartographer Phase 5 (see commit comment
in `agents/nexus.ts` correlation 2). PR-C drops them from nexus.
Verify cartographer still keeps them fresh:

```bash
./scripts/platform-diagnostics.sh | \
  jq '.data.enrichment_pipeline | { total_enriched, active_threats }'
```

Expected: non-zero numbers that change over the next 24h.

## Operator actions when alert fires

| Symptom | Action |
|---|---|
| Alert fires, cooldown active | Wait 1h or `DELETE` the `wf_cooldown:<name>` KV key to retry now |
| Alert fires, no cooldown | Cloudflare Workflows platform likely degraded — check status page; the next supervisor tick will re-check |
| Alert fires repeatedly | Hit `POST /api/internal/agents/<name>/workflow` to verify `.create()` works; if it does, the cron dispatch path is the culprit |
