# ARCHITECT — Meta-agent for Averrow

ARCHITECT is Averrow's self-awareness layer: a meta-agent that periodically
scans the platform, builds a structured snapshot of how it's wired together,
and (in later phases) uses Claude to produce a weekly architectural review
that an engineer can action.

The agent is built in phases. **This document covers Phase 1, 1.5, and 2.**
No Sonnet synthesis, no report generation, no UI for the Phase 2 output yet
— those land in Phase 3/5.

---

## Phases

| Phase | Name                     | Status    | Scope                                                                 |
| ----- | ------------------------ | --------- | --------------------------------------------------------------------- |
| 1     | Context collectors       | **Done**  | Three pure collectors + CLI + R2 bundle storage                       |
| 1.5   | Admin trigger + runs view| **Done**  | Super-admin HTTP routes + `/admin/architect` page to start runs & inspect bundles |
| 2     | Haiku inventory pass     | **Done**  | Three section analyzers (agents / feeds / data_layer) persisted to `architect_analyses` |
| 3     | Sonnet synthesis         | Planned   | Cross-cutting narrative — what's drifting, what's expensive, what's risky |
| 4     | Flight Control wiring    | Planned   | ARCHITECT becomes a scheduled agent with `agent_runs` + `agent_events` integration |
| 5     | UI surface (full)        | Planned   | Operator dashboard with historical diffs, proposal review, approve/reject flow |
| 6     | Docs rollup              | Planned   | Auto-generated reference docs derived from the weekly bundle          |

Each phase is additive; Phase 1 must continue to run cleanly after later
phases land.

---

## What Phase 1 collects

Every run produces a **ContextBundle** — a single JSON document that is the
source of truth for everything downstream phases will analyse. The bundle is
written to `/tmp/architect-bundle-<run_id>.json` and uploaded to R2 at
`architect/bundles/<run_id>.json`.

### Bundle schema (v1)

```ts
interface ContextBundle {
  bundle_version: 1;
  run_id: string;          // uuid
  generated_at: string;    // ISO
  repo: RepoInventory;     // repo collector output
  data_layer: DataLayerInventory;
  ops: OpsTelemetry;
}
```

The full TypeScript types live in
[`packages/averrow-worker/src/agents/architect/types.ts`](../../packages/averrow-worker/src/agents/architect/types.ts).

### Collector contracts

Each collector is a single async function with a narrow responsibility:

| Collector                       | Signature                                                         | Reads from                                           |
| ------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| `collectRepoInventory(rootDir)` | `(string) => Promise<RepoInventory>`                              | Filesystem (`fs/promises`) only — no network         |
| `collectDataLayerInventory(env)`| `(Env) => Promise<DataLayerInventory>`                            | D1 `sqlite_master`, per-table `COUNT(*)`, `dbstat`   |
| `collectOpsTelemetry(env)`      | `(Env) => Promise<OpsTelemetry>`                                  | D1 `agent_runs`, `budget_ledger`                     |

**repo** walks every `packages/*/src/agents/` and `packages/*/src/feeds/`
tree, parses each `wrangler.toml` it finds, and returns a per-file inventory
(LOC, last-modified, triggers, referenced D1 tables, referenced Claude
models). It uses a deliberately conservative regex pass — good enough for a
downstream AI to reason about, not an AST-level source of truth.

**data-layer** lists every user table in D1, counts rows, counts indexes,
estimates byte size (via `dbstat` when compiled in, otherwise a page-size
fallback), and computes 7-day row growth by comparing against the
`architect_table_snapshots` ledger. It inserts a fresh snapshot row per
table at the end of each run so the next run has a delta baseline.

Table names coming out of `sqlite_master` are whitelisted against an
identifier regex before being interpolated into `COUNT(*)` queries because
D1 cannot bind identifiers. All other values use prepared statements.

**ops** aggregates 7 days of `agent_runs` (runs, successes, failures,
average duration, last error) and joins in AI spend from `budget_ledger`
(per agent and per model). Sources that aren't wired yet — Cloudflare
Queues depth, AI Gateway cache hit rate, Cron Trigger analytics — return
zeros or `null` with a `TODO` comment. **Never fabricate values.**

---

## Running the collector

### One-shot against dev D1

```bash
cd packages/averrow-worker
pnpm architect:collect
```

Default behaviour:
- `run_type` = `weekly`
- Target env = the `dev` wrangler environment
- R2 bucket = `averrow-architect-bundles`
- D1 binding = `DB`

### Environment variables

| Var                      | Default                       | Purpose                                              |
| ------------------------ | ----------------------------- | ---------------------------------------------------- |
| `ARCHITECT_RUN_TYPE`     | `weekly`                      | One of `weekly`, `ondemand`, `deep`                  |
| `ARCHITECT_WRANGLER_ENV` | `dev`                         | `wrangler --env` target                              |
| `ARCHITECT_R2_BUCKET`    | `averrow-architect-bundles`   | Destination R2 bucket                                |
| `ARCHITECT_D1_BINDING`   | `DB`                          | D1 binding name for the main database                |

### Prerequisites

1. Migration `0070_architect_reports.sql` applied:
   ```bash
   pnpm db:migrate:local   # local dev
   pnpm db:migrate:prod    # remote
   ```
2. R2 bucket exists:
   ```bash
   wrangler r2 bucket create averrow-architect-bundles
   ```
3. The machine running the CLI must have a wrangler session with access to
   the target D1 database and R2 bucket (`wrangler login` or a configured
   API token).

---

## Run lifecycle

Every invocation transitions a row in `architect_reports` through these
states:

```
  (insert)                    (finally)
  collecting  ─────▶  complete
       │
       └────────────▶  failed  (error_message, duration_ms captured)
```

`analyzing` is reserved for Phase 2+; Phase 1 never enters it. The CLI
catches **every** thrown error, marks the row failed, logs, and rethrows.
No silent failures.

---

## Triggering from the UI

Phase 1.5 adds a super-admin-gated control page at **`/admin/architect`**
and three HTTP routes on the Worker. Everything rides on the same
`runCollect()` core that the CLI uses — the route inserts the
`architect_reports` row eagerly, then runs the collector in
`ctx.waitUntil` so the HTTP response returns immediately.

### Routes

| Method | Path                                    | Purpose                                                          |
| ------ | --------------------------------------- | ---------------------------------------------------------------- |
| POST   | `/api/admin/architect/collect`          | Start a run. Body: `{ run_type?: 'ondemand' \| 'deep' }`         |
| GET    | `/api/admin/architect/runs?limit=20`    | List recent runs (ordered by `created_at DESC`)                  |
| GET    | `/api/admin/architect/runs/:run_id`     | Single run row + the R2 bundle JSON (when `status = 'complete'`) |

All three require a super-admin JWT. The POST route enforces a 30-minute
concurrency guard — if any row in `architect_reports` is still in
`collecting` or `analyzing` status within the last 30 minutes, the route
returns **409 Conflict** with:

```json
{
  "success": false,
  "error": "architect_run_in_progress",
  "run_id": "…",
  "status": "collecting"
}
```

On a fresh start the route returns **202 Accepted**:

```json
{
  "success": true,
  "run_id": "…",
  "status": "collecting",
  "started_at": "2026-04-09T12:34:56.000Z"
}
```

The collector then finishes in the background and flips the row to
`complete` (with the R2 key + duration) or `failed` (with the error
message). The UI polls every 10 seconds while any row is non-terminal
so the status pill updates automatically.

### UI

The `/admin/architect` page is the minimal surface:

- **Run Collection** — primary amber button, triggers `run_type: 'ondemand'`
- **Deep Run** — secondary button, triggers `run_type: 'deep'`
- **Recent Runs** table with Started / Type / Status / Duration / Cost / Bundle
- Clicking **view** on a complete run opens a bundle viewer modal that
  pulls the JSON through the GET `:run_id` route (the Worker proxies it
  from R2 via the binding — no presigned URLs)
- Failed runs show the truncated error message inline

The page lives at
[`packages/averrow-ops/src/features/admin/Architect.tsx`](../../packages/averrow-ops/src/features/admin/Architect.tsx)
and uses the thin typed client at
[`packages/averrow-ops/src/api/architectApi.ts`](../../packages/averrow-ops/src/api/architectApi.ts).

This surface is intentionally minimal — it lets an operator kick a run
and confirm the bundle landed. Phase 5 is where the richer dashboard
(historical diffs, proposal review, approval flow) lives.

---

## File map

```
packages/averrow-worker/
├── migrations/
│   └── 0070_architect_reports.sql    # architect_reports + architect_table_snapshots
└── src/
    ├── routes/
    │   └── architect.ts              # POST /collect + GET /runs[/:id] admin routes
    └── agents/architect/
        ├── types.ts                  # ContextBundle + all collector output types
        ├── core.ts                   # runCollect() — runtime-agnostic lifecycle
        ├── wrangler-shim.ts          # Node-side D1 shim over `wrangler d1 execute`
        ├── cli.ts                    # pnpm architect:collect entry (Node-only wrapper)
        └── collectors/
            ├── repo.ts               # collectRepoInventory(rootDir)
            ├── data-layer.ts         # collectDataLayerInventory(env)
            └── ops.ts                # collectOpsTelemetry(env)

packages/averrow-ops/src/
├── api/
│   └── architectApi.ts               # Typed client — startArchitectRun, listArchitectRuns, getArchitectRun
└── features/admin/
    └── Architect.tsx                 # /admin/architect cockpit page
```

---

## Phase 2 — Haiku Analysis

Phase 2 turns the raw ContextBundle from Phase 1 into three structured
section assessments produced by `claude-haiku-4-5-20251001`. Every run
lives in the `architect_analyses` table — one row per section, status
transitions `pending → analyzing → complete | failed`, so the UI can
poll and render partial progress.

### Section analyzers

The three analyzers each consume a focused slice of the bundle (no
whole-bundle forwarding — tokens aren't free even with Haiku) and
return a typed `SectionAnalysis`:

| Analyzer           | Signature                                                              | Bundle slice consumed                                                         |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `analyzeAgents`    | `(ContextBundle, AnalyzerEnv) => Promise<AnalyzerResult<AgentsAnalysis>>`    | `repo.agents`, `repo.crons`, `ops.agents`, `ops.crons`, `ops.ai_gateway`, `ops.telemetry_warnings` |
| `analyzeFeeds`     | `(ContextBundle, AnalyzerEnv) => Promise<AnalyzerResult<FeedsAnalysis>>`     | `repo.feeds`, `repo.crons`, `ops.queues_depth`, `ops.telemetry_warnings`       |
| `analyzeDataLayer` | `(ContextBundle, AnalyzerEnv) => Promise<AnalyzerResult<DataLayerAnalysis>>` | `data_layer.tables`, `data_layer.totals`, `ops.telemetry_warnings`             |

The agents analyzer cross-references ops telemetry so evidence strings
can cite real signals (failure counts, CPU timeouts in `last_error`,
ghost rows where `runs_7d > 0 && successes_7d === 0`). `telemetry_warnings`
is passed through verbatim so the model knows which zero values mean
"missing signal" rather than "nothing happened".

### Schema (one row per section)

```ts
interface SectionAnalysisBase {
  section: "agents" | "feeds" | "data_layer";
  summary: string;                              // 2-3 sentence exec summary
  scorecard: { green: number; amber: number; red: number };
  cross_cutting_concerns: string[];
}

interface AgentAssessment {
  name: string;
  severity: "green" | "amber" | "red";
  recommendation: "keep" | "split" | "merge" | "kill" | "refactor";
  rationale: string;          // 1-3 sentences, specific, evidence-backed
  evidence: string[];         // concrete signals from the bundle
  concerns: string[];
  suggested_actions: string[];
  merge_with?: string;        // only if recommendation === "merge"
  split_into?: string[];      // only if recommendation === "split"
}
// FeedAssessment has the same shape minus merge_with / split_into.
// TableAssessment adds scale_risk: "low" | "medium" | "high".

interface DataLayerAnalysis extends SectionAnalysisBase {
  section: "data_layer";
  assessments: TableAssessment[];
  hot_tables: string[];        // top 5 by bytes or 7-day growth
  scale_bottlenecks: string[]; // tables that break at 10x scale
}
```

Full TypeScript definitions live in
[`packages/averrow-worker/src/agents/architect/analysis/types.ts`](../../packages/averrow-worker/src/agents/architect/analysis/types.ts),
and the hand-rolled JSON validator is in
[`schema.ts`](../../packages/averrow-worker/src/agents/architect/analysis/schema.ts).
The orchestrator throws on invalid JSON and the analyzer row flips to
`failed` with a path-prefixed `SchemaError` message so debugging a bad
model response is a one-grep affair.

### Transport + cost governance

- **AI Gateway when available.** If `env.CF_ACCOUNT_ID` is set the
  analyzer routes through
  `gateway.ai.cloudflare.com/v1/<acct>/averrow-ai-gateway/anthropic` so
  re-runs against the same bundle get cache hits for free. Otherwise
  calls go direct to `api.anthropic.com/v1/messages`.
- **Model.** `claude-haiku-4-5-20251001`, max_tokens 4096, 60s timeout.
- **Per-call cost cap.** $0.50, enforced in the analyzer after the
  response comes back. Throws if exceeded; the row flips to `failed`
  with the cap error.
- **Per-run cost cap.** $2.00, enforced in the orchestrator after all
  three section rows have been persisted. Trips the outer `runAnalysis`
  throw but keeps the analyses that did complete.
- **Pricing constants** live in
  [`analysis/pricing.ts`](../../packages/averrow-worker/src/agents/architect/analysis/pricing.ts)
  — rate updates are a one-file edit.

### Triggering an analysis

```
POST /api/admin/architect/analyze/:run_id
```

Super-admin JWT required. The route validates that the target
`architect_reports` row is in status=`complete` with a non-null
`context_bundle_r2_key`, refuses if an analysis is already in flight
for the same `run_id` (409 `architect_analysis_in_progress`), then
kicks `runAnalysis` in `ctx.waitUntil` and returns **202 Accepted**:

```json
{
  "success": true,
  "run_id": "…",
  "status": "pending",
  "started_at": "2026-04-09T12:34:56.000Z"
}
```

`runAnalysis` inserts the three `architect_analyses` rows immediately
(status=`pending`, section ∈ {agents, feeds, data_layer}) so the UI can
render placeholders, then fires all three Haiku calls in parallel via
`Promise.allSettled`. Each row transitions `pending → analyzing → complete`
or `pending → analyzing → failed` independently — one failing section
never kills the others.

### Reading results

```
GET /api/admin/architect/analyses/:run_id
```

Returns the three section rows with `analysis_json` already parsed:

```json
{
  "success": true,
  "run_id": "…",
  "total_cost_usd": 0.0123,
  "analyses": [
    {
      "id": "…",
      "section": "agents",
      "status": "complete",
      "model": "claude-haiku-4-5-20251001",
      "input_tokens": 4012,
      "output_tokens": 1487,
      "cost_usd": 0.0114,
      "duration_ms": 5320,
      "analysis": { /* AgentsAnalysis */ },
      "error_message": null
    },
    /* feeds */
    /* data_layer */
  ]
}
```

### File map additions

```
packages/averrow-worker/
├── migrations/
│   └── 0071_architect_analyses.sql           # architect_analyses table
└── src/
    └── agents/architect/
        └── analysis/
            ├── types.ts                      # AgentsAnalysis / FeedsAnalysis / DataLayerAnalysis
            ├── pricing.ts                    # Haiku cost constants + computeCostUsd
            ├── schema.ts                     # hand-rolled JSON validators (SchemaError)
            ├── analyzer.ts                   # analyzeAgents / analyzeFeeds / analyzeDataLayer
            └── orchestrator.ts               # runAnalysis(runId, env)
```

---

## Out of scope for Phase 1 / 1.5 / 2

These are intentionally **not** built yet and should not be added to the
current phases:

- Sonnet synthesis / cross-section narrative (Phase 3)
- Markdown report generation / rollup
- Cron wiring / scheduled execution (Phase 4)
- UI surface for Phase 2 analyses (Phase 3/5 — `architect_analyses` is
  already shaped for consumption by the UI, but the dashboard itself
  lives in Phase 5)
- Approval workflow / proposal review
- AI Gateway cost ingestion back into `budget_ledger` (separate track
  — `telemetry_warnings` still surfaces the gap)
- Notifications / email / Slack

Phase 3 is where the Sonnet synthesis lives. Start there when you're
ready to turn the three section assessments into a single narrative.
