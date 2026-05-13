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

## Operator actions when alert fires

| Symptom | Action |
|---|---|
| Alert fires, cooldown active | Wait 1h or `DELETE` the `wf_cooldown:<name>` KV key to retry now |
| Alert fires, no cooldown | Cloudflare Workflows platform likely degraded — check status page; the next supervisor tick will re-check |
| Alert fires repeatedly | Hit `POST /api/internal/agents/<name>/workflow` to verify `.create()` works; if it does, the cron dispatch path is the culprit |
