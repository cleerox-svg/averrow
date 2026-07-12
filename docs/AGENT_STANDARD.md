# Agent Standard

**Status:** draft (Phase 0 of agent audit)
**Owner:** platform engineering
**Last review:** 2026-04-29

The canonical contract for everything in Averrow we call an "agent." This
document is the spine of the agent audit (see `AGENT_AUDIT.md` once Phase
1 lands) and the source of truth for adding, changing, retiring, and
visually presenting agents on the platform.

If a piece of code calls AI, runs on a schedule, or executes background
work that touches user data, it must comply with this standard. No
exceptions — drift is the threat model.

---

## Table of contents

1. [Definition: what is an agent](#1-definition)
2. [The two agent classes](#2-classes)
3. [The `AgentModule` interface](#3-agentmodule)
4. [Lifecycle contract](#4-lifecycle)
5. [State machine](#5-state-machine)
6. [Wiring checklist (the 12-point compliance list)](#6-wiring)
7. [UI presentation standard](#7-ui)
8. [AI-specific guardrails](#8-ai-guardrails)
9. [Output schema validation](#9-output-schemas)
10. [Resource & permissions model](#10-permissions)
11. [Cost attribution & per-agent budgets](#11-cost)
12. [Approval workflow](#12-approval)
13. [Inter-agent communication](#13-comms)
14. [Observability](#14-observability)
15. [Failure modes & recovery](#15-failure)
16. [SLA / SLOs](#16-sla)
17. [Testing standard](#17-testing)
18. [Canary / shadow mode](#18-canary)
19. [Versioning & rollback](#19-versioning)
20. [Retirement & decommission](#20-retirement)
21. [Authoring: `pnpm new-agent`](#21-authoring)
22. [Enforcement script](#22-enforcement)
23. [Migration plan from current state](#23-migration)

---

<a id="1-definition"></a>
## 1. Definition: what is an agent

An **agent** is an autonomous unit of work that satisfies *all* of the
following:

1. **Runs on a schedule, in response to an event, or as a synchronous
   handler-driven invocation** — never as one-shot bootstrap code.
2. **Executes domain logic** against platform data (D1, KV, R2,
   external APIs). Pure utility helpers do not qualify.
3. **Is supervised by Flight Control.** Stall recovery, circuit
   breaking, and budget enforcement apply uniformly.
4. **Logs a structured run** to `agent_runs` (start + completion) and
   structured outputs to `agent_outputs` when it produces meaningful
   findings.
5. **Has an `AgentModule` registered in `agentModules`** (see §3).

If a piece of code calls AI, it is by definition an agent — it must
comply with §8 (AI guardrails) regardless of how it is triggered.

### Things that look like agents but are not

| Pattern | Where it lives | Why it's not an agent |
|---|---|---|
| **Cron job** | `cron/orchestrator.ts` `runJob()` wrappers (e.g. `ct_monitor`, `trademark_scan`) | Inline procedural step. No FC supervision needed — runs trip the cron-level circuit. |
| **Handler-dispatched writer** | `handlers/briefing.ts` `generateAndEmailBriefing` / `handleGenerateBriefing` (`daily_briefing`, dedicated cron `13 13 * * *` + on-demand) | Fails criterion 5 only — no registered `AgentModule`, so no FC supervision or cost-guard budget. Does satisfy criterion 4: wrapped in `withBriefingRun`, which logs a real `agent_runs` row (start/success/failed) and a telemetry `agent_events` row (`briefing_generated`, `target_agent=NULL`). Pure SQL — no AI call. See `docs/AI_AGENTS.md`. |
| **AI utility helper** | `lib/haiku.ts`, `lib/anthropic.ts` | These are the *transport* agents call through. They never run on their own. |
| **Workflow** | `workflows/cartographerBackfill.ts`, `workflows/nexusRun.ts` | Cloudflare Workflow dispatched **by** an agent (cartographer, nexus). Owned by that agent. |
| **Durable Object** | `durableObjects/CertStreamMonitor.ts`, `durableObjects/ThreatPushHub.ts` | Stateful long-lived entity. Different lifecycle (no per-tick run, no cost guard). Connected to agents via events. |
| **HTTP handler** | `handlers/*.ts` | Owns request/response cycle. May *call* a sync agent (§2) but is not itself an agent. |

Drawing this line crisply matters because every "agent" pays cost
guard, output validation, and FC overhead. We don't tax pure utilities
with that overhead, and we don't let domain logic escape it.

<a id="2-classes"></a>
## 2. The two agent classes

There are exactly two classes. Anything that doesn't fit one of these
two patterns must be redesigned until it does.

### Scheduled agent

| Field | Value |
|---|---|
| `trigger` | `'scheduled'` or `'event'` |
| Returns | `Promise<AgentResult>` (void-ish — the data side-effect is the point) |
| Lifecycle | Long-running — typical 5s to 15min per run |
| Caller | Cron orchestrator, agent_events consumer, FC stall recovery |
| Examples | `sentinel`, `cartographer`, `observer`, `recon` |

### Synchronous agent

| Field | Value |
|---|---|
| `trigger` | `'api'` or `'manual'` |
| Returns | `Promise<AgentResult & { data: T }>` — **handler awaits and uses the result** |
| Lifecycle | Short — typical 100ms to 30s |
| Caller | HTTP handler, calling `runSyncAgent(env, module, input)` |
| Examples | `brand-report` (admin generates a per-brand AI summary), `public-trust-check` (anon homepage assessment), `scan-report` |

The 15 inline AI call-sites currently embedded in `handlers/*` (today
calling `callHaikuRaw` / `callAnthropicText` directly) are all
candidates for sync-agent migration. See §23.

### Choosing between them

If the call's result is consumed by a user request, it's a sync agent.
If the result drops into D1 for a later consumer, it's scheduled. A
single agent must not be both — split it.

### Naming convention

The mesh has two cohorts that get named under different rules. Pick
the right rule when adding a new agent.

| Cohort | Naming style | Examples |
|---|---|---|
| **Operational mesh** — autonomous, cron-scheduled or event-dispatched, "does work" without prompting | Aviation / recon codename — single distinctive word, lowercased + snake_cased in code, capitalized in `displayName` | `flight_control`, `sentinel`, `sparrow`, `mockingbird`, `outrider`, `marshal`, `sounder`, `recon`, `observer`, `pathfinder`, `nexus`, `cartographer`, `analyst`, `strategist`, `narrator`, `attributor` |
| **Sync / utility** — handler-driven, `trigger: 'api'` or `'manual'`, called by name from a route or admin action | Verb-noun describing the operation | `brand_analysis`, `brand_report`, `brand_deep_scan`, `brand_enricher`, `public_trust_check`, `evidence_assembler`, `qualified_report`, `scan_report`, `url_scan`, `admin_classify`, `honeypot_generator`, `lookalike_scanner`, `social_ai_assessor`, `geo_campaign_assessment`, `notification_narrator` |
| **Infrastructure** — pure-mechanical, no AI in the hot path | Functional name describing the artifact maintained | `cube_healer`, `navigator`, `enricher`, `geoip_refresh` |

**Rationale.** Aviation codenames evoke field operatives — they're
appropriate for autonomous workers operating in the wild on their
own initiative. Verb-noun names are appropriate for utilities that
don't act unless called. Functional names are appropriate for
infrastructure that just keeps the lights on. Mixing the styles
within a cohort makes the mesh harder to read at a glance.

**Heritage.** The aviation theme traces to the Avro Arrow lineage
(`CLAUDE.md §13` — kept for the operational mesh; not required
brand-wide). New operational agents should pull from the same
register: birds (sparrow, mockingbird), aerial reconnaissance
(outrider, recon, sounder), command-and-control (flight_control,
marshal, observer), or navigation/charting (cartographer,
pathfinder, navigator). Ad-hoc names that don't fit are a
code-review red flag — propose a register-aligned alternative.

**Renaming is expensive** (touches `agent_runs` history,
`agent_outputs`, `budget_ledger`, dashboards, alerting). Get the
name right at registration time. If a name later becomes
misleading (e.g. `watchdog` → "uptime monitor" → actually a social
mention classifier per the `AGENT_AUDIT.md` 2026-04-29 addendum),
update the metadata subtitle + category before considering a
rename.

<a id="3-agentmodule"></a>
## 3. The `AgentModule` interface

The shape every agent ships. Lives in `lib/agentRunner.ts`. This is
the canonical contract — anything we want true of every agent goes on
this interface so the type checker enforces it.

```ts
interface AgentModule<TInput = unknown, TOutput = unknown> {
  // ── Identity ─────────────────────────────────────────────
  name: AgentName;                     // snake_case, in AgentName union
  displayName: string;                 // human-friendly (e.g. "Recon")
  codename?: string | null;            // optional (e.g. "ASTRA")
  description: string;                 // one-paragraph mandate
  color: string;                       // hex, distinct
  category: 'orchestration' | 'intelligence' | 'response' | 'ops' | 'meta';
  pipelinePosition: number;            // ordering on Agents page

  // ── Lifecycle ────────────────────────────────────────────
  trigger: 'scheduled' | 'event' | 'api' | 'manual';
  schedule?: AgentSchedule;            // null for event/api/manual
  requiresApproval?: boolean;          // §12

  // ── Supervision (FC reads these) ─────────────────────────
  stallThresholdMinutes: number;       // §16, replaces flightControl.ts STALL_THRESHOLDS map
  parallelMax: number;                 // FC scaling ceiling
  costGuard: 'enforced' | 'exempt';    // §8, exempt requires architecture review

  // ── Per-agent budget (§11) ───────────────────────────────
  budget: {
    monthlyTokenCap?: number;          // Haiku/Sonnet/Opus tokens
    monthlyD1ReadCap?: number;
    monthlyD1WriteCap?: number;
    alertAt?: number;                  // 0..1, percent of cap
  };

  // ── Resource declarations (§10) ──────────────────────────
  reads: ResourceDecl[];               // D1 tables, KV namespaces, R2 buckets, AE datasets
  writes: ResourceDecl[];

  // ── AI guardrails (§8, §9) ───────────────────────────────
  ai?: {
    callsites: string[];               // every agentId used in budget_ledger from this module
    model: 'haiku' | 'sonnet' | 'opus' | 'mixed';
    promptVersion: string;             // bumped when the prompt changes
    inputSchema?: ZodSchema;           // user-input agents only, sanitises prompt
    outputSchema?: ZodSchema;          // freeform AI output validated before persist
  };

  // ── Output contract (§9) ─────────────────────────────────
  outputs: {
    type: AgentOutputType;
    schema?: ZodSchema;                // output schema validated before INSERT
  }[];

  // ── State (§5, §20) ──────────────────────────────────────
  status: 'active' | 'paused' | 'shadow' | 'retired';

  // ── Run handler ──────────────────────────────────────────
  execute: (ctx: AgentContext<TInput>) => Promise<AgentResult<TOutput>>;
}
```

### What the type system enforces

- A new agent missing any required field fails to compile.
- The `AgentName` union is the closed set of valid agent names — drift between metadata and the registry is impossible.
- `outputs[].schema` is optional but required for agents using AI.
- The `audit-agent-standard.ts` enforcement script (§22) catches what the type system cannot (e.g. metadata + icon + group membership).

<a id="4-lifecycle"></a>
## 4. Lifecycle contract

Every agent run goes through the same six stages, regardless of class. Deviations get caught by the enforcement script.

```
1. PRE-FLIGHT      → checkCostGuard(env) — bail if monthly AI budget exhausted
2. RUN START       → INSERT INTO agent_runs (id, agent_id, started_at, status='running')
3. EXECUTE         → AgentModule.execute(ctx) — the domain work
4. OUTPUT VALIDATE → outputSchema.parse(result.output) — reject malformed
5. PERSIST         → INSERT INTO agent_outputs (when meaningful)
6. RUN COMPLETE    → UPDATE agent_runs SET status, duration_ms, error_message, completed_at
```

`executeAgent()` (scheduled) and `runSyncAgent()` (sync) are the only two entry-points — neither callable agent code nor handlers may INSERT into `agent_runs` directly. (Today three sites bypass this: `cube-healer`, `navigator`, `nexus` workflow path. They land on the Phase 2 fix list.)

Failure isolation: agents must **never throw upstream**. They catch, populate `error_message`, return `status: 'partial' | 'failed'`. A thrown exception is treated as a crashed agent (`status: 'failed'`, auto-paused after `consecutive_failure_threshold` per circuit breaker).

<a id="5-state-machine"></a>
## 5. State machine

Per-run status (`agent_runs.status`):

```
running ─→ success
        ─→ partial (some sub-steps failed but progress was made)
        ─→ failed  (catastrophic — circuit breaker counter increments)
        ─→ killed  (timed out, FC sent KILL signal, or worker died)
```

Per-agent status (`agent_configs.status`, surfaced in metadata):

```
active             ─→ paused              (operator OR circuit breaker tripped)
                   ─→ shadow              (canary mode — runs, doesn't persist)
                   ─→ awaiting_approval   (requiresApproval=true, gated)
                   ─→ retired             (decommissioned, see §20)

paused             ─→ active              (operator resumes)

shadow             ─→ active              (canary graduated)
                   ─→ retired             (canary failed)

awaiting_approval  ─→ active              (approver granted)
                   ─→ paused              (approver denied)

retired            (terminal — no transitions out)
```

The Agents page shows the per-agent status as the dominant visual signal — that drives operator decisions more than per-run status, which is run-by-run noise.

<a id="6-wiring"></a>
## 6. Wiring checklist (the 12-point compliance list)

For every new agent. The enforcement script (§22) verifies each item — anything missing fails the build.

| # | Surface | What |
|---|---|---|
| 1 | `lib/agentRunner.ts` | Add to `AgentName` union |
| 2 | `agents/<name>.ts` | New `AgentModule` exported as `<name>Agent` |
| 3 | `agents/index.ts` | Register in `agentModules` |
| 4 | Cron orchestrator OR `runSyncAgent` call | Dispatch path |
| 5 | `agents/flightControl.ts` STALL_THRESHOLDS | (Soon) read from module instead — until then, add entry |
| 6 | `lib/agent-metadata.ts` | Add to `AgentId` union + `AGENT_METADATA` entry |
| 7 | `features/agents/Agents.tsx` AGENT_GROUPS | Add to the appropriate category group |
| 8 | `components/brand/AgentIcon.tsx` | New SVG icon |
| 9 | `lib/auto-seeder-planter.ts`-pattern resource decl | Declare reads/writes in module's metadata |
| 10 | `agent_configs` table | Bootstrap row (defaults via migration) |
| 11 | `docs/AI_AGENTS.md` | One-paragraph entry under the appropriate category |
| 12 | Smoke test in `verify_ui_smoke` | If agent has user-facing output, add a probe to the MCP smoke test |

Items 5-11 are scheduled to consolidate behind the AgentModule itself in Phase 4 — once `STALL_THRESHOLDS`, `AGENT_METADATA`, and the wiring tables read from the module, the checklist collapses to items 1-4 + icon. Until then, all 12 are required.

<a id="7-ui"></a>
## 7. UI presentation standard

Every agent appears on three surfaces:

### 7.1 Agents page (`features/agents/Agents.tsx`)

Grouped by `category`. Each group renders a card grid. Card layout:

```
┌─────────────────────────────────────────────────────────────────┐
│ [Icon]  Recon              ●  active   schedule: weekly Sun 05  │
│         auto_seeder        circuit: closed                      │
│                                                                 │
│         Spam-trap seeding agent — plants honeypot addresses…    │
│                                                                 │
│         Last 5 runs:  ▮▮▮▮▮       Last activity: 2h ago         │
│         24h: 1 run · 12 items · $0.00                           │
└─────────────────────────────────────────────────────────────────┘
```

Required elements per card:
- **AgentIcon** at 32px (or 40px on the detail panel)
- **Name + codename** (codename in monospace small caps below name)
- **Status pill** (active green / paused amber / shadow blue / retired grey)
- **Schedule badge** (cadence string OR "on-demand" for sync)
- **Circuit state badge** (closed/tripped, only visible when relevant)
- **Description** (one line, truncated)
- **Run history blocks** (last 5 runs, green/red/grey)
- **24h stats line** (runs · items · cost)

### 7.2 Agent detail panel (right-side drawer when card is selected)

Adds:
- Recent `agent_outputs` (5 most recent, with severity dot)
- Last error (if any, with timestamp)
- Resource declaration (`reads` + `writes` chips)
- Manual trigger button (if `trigger: 'manual'` or operator role)
- Cost gauge (this month spent vs `budget.monthlyTokenCap`)

### 7.3 Agent config view (`features/agents/AgentConfig.tsx`)

Edit form for `agent_configs` runtime parameters. Layout:
- **Identity header** (icon + displayName + codename + status)
- **Schedule section** (cadence + last run + next run)
- **Parameters** (one row per `agent_configs` field, type-aware editor)
- **Approval queue** (only if `requiresApproval=true`)
- **Budget section** (this month, alerts, caps)
- **Resource declaration** (read-only — sourced from module)

### 7.4 Per-class differences

| Surface | Scheduled agent | Synchronous agent |
|---|---|---|
| Schedule badge | Cadence string ("Hourly", "Sun 05:07 UTC") | "On-demand" pill |
| Run history | 5 most recent run blocks | p50/p99 latency over 24h sparkline |
| 24h stats | runs · items · cost | calls · avg latency · errors · cost |
| Manual trigger | "Run now" → cron path | "Test prompt" → debug invocation |

Sync agents render in their own AGENT_GROUPS entry: **"Synchronous AI"** group. Mixing them with scheduled agents in Detection / Intelligence / etc. confuses the operator on cadence expectations.

### 7.5 Forbidden UI patterns

- **Hardcoded agent name strings** in components (use `AGENT_METADATA[id].displayName`).
- **Per-agent if/else rendering** (instead, the agent's metadata supplies what to render).
- **One-off card layouts** (every agent uses the same `<AgentCard agent={...} />` shared component).
- **Agent counts hardcoded as integers** (`AGENT_LIST.length`, never `19`).

### 7.6 Flight Control card — embedded Agent Mesh

The `flight_control` agent owns a wider card at the top of the Agents page. Its body has a left/center/right layout:

```
┌─────────────────────────────────────────────────────────────────────┐
│  [Icon]  Flight Control  ●         │   AGENT MESH         │ Token   │
│         Autonomous supervisor —    │  ┌── Detection &     │ budget  │
│         parallel scaling, stall    │  │   Intelligence  N │  ▮▮▮▯   │
│         recovery, token budget…    │  │  [pills…]         │         │
│                                    │  ├── Response      N │ Backlog │
│                                    │  │  [pill]           │ counters│
│                                    │  ├── Operations   N │  …      │
│                                    │  │  [pills…]         │         │
│                                    │  ├── Meta          0 │         │
│                                    │  │  (hidden if empty)│         │
│                                    │  └── Other         N │         │
│                                    │     [pills…]         │         │
└─────────────────────────────────────────────────────────────────────┘
```

The center "AGENT MESH" panel renders **every other agent** as a status pill — every non-`flight_control` row in `agentModules`. Pills are bucketed by `AGENT_METADATA[id].category` in pipeline order:

1. `Detection & Intelligence` (intelligence)
2. `Response` (response)
3. `Operations` (ops)
4. `Meta` (meta)
5. `Other` — defensive fallback for any agent whose metadata is missing or has an unknown category. Agents must NEVER disappear from the mesh just because metadata wasn't wired correctly.

Per-group rules:

- Empty buckets (zero agents in the category) are hidden, not shown as empty headers.
- Each header is a small uppercase label + agent count to the right (`OPERATIONS  5`).
- Pill visual is unchanged across categories — same border, status dot, color, displayName.
- Pipeline-position ordering within a bucket is not enforced (insertion order from `useAgents()` is fine for now).

Pill structure (single source of truth — used here AND on the Agents page card grid):

- `<AgentStatusBadge status={a.status} />` — status dot (active green / paused amber / shadow blue / retired grey).
- Display name in `AGENT_METADATA[id].color`.
- Border `var(--border-base)`, transparent background.

If a new agent is added but the `Detection & Intelligence` / `Response` / `Operations` / `Meta` taxonomy doesn't fit, **first** propose extending the categories union in `AgentMetadata.category`. Don't add it as `'other'` and ship — that's a code smell and the audit will catch it.

<a id="8-ai-guardrails"></a>
## 8. AI-specific guardrails

Every agent that calls AI must clear all eight gates. No exceptions — the call is blocked at the helper level if the agent doesn't supply the required metadata.

| Gate | What | Where enforced |
|---|---|---|
| **G1 — Cost guard** | `checkCostGuard(env)` returns `null` (not blocked). Bails the run early if monthly platform budget is exhausted. | `lib/haiku.ts` / `lib/anthropic.ts` — refuses the call if `costGuard: 'enforced'` and budget is over |
| **G2 — Per-agent budget** | This agent's monthly token spend is below `budget.monthlyTokenCap`. Alerts at `budget.alertAt` (default 0.8). | Same call site, reads from `budget_ledger` |
| **G3 — Model selection policy** | Module declares `ai.model` ('haiku' \| 'sonnet' \| 'opus'). Default is haiku. Sonnet+ requires architecture review. | Enforcement script (§22) |
| **G4 — Prompt versioning** | `ai.promptVersion` bumped on every prompt edit. Stored alongside output for forensic traceability. | Enforcement script + git pre-commit hook |
| **G5 — Input schema** (user-input agents only) | `ai.inputSchema.parse(input)` succeeds. Domains are normalized, length-capped, pattern-checked. Rejects prompt-injection payloads. | `runSyncAgent()` before calling AI |
| **G6 — Output schema** | `ai.outputSchema.parse(aiResponse)` succeeds. AI text not matching schema is logged + dropped (never persisted, never returned to user). | `runSyncAgent()` after AI returns |
| **G7 — PII filter** | No customer email, no API tokens, no `users` table content sent in prompts. Brand names + public domains are OK. | Lint rule on agent module + spot audit |
| **G8 — Token cap per call** | `maxTokens` declared on the call. Truncated if exceeded. No unbounded `max_tokens: null`. | `lib/anthropic.ts` |

### Model selection policy

| Model | Use for | Don't use for |
|---|---|---|
| Haiku 4.5 | Classification, scoring, short summaries (≤256 tokens), high-volume hot paths | Complex reasoning, long-form narratives |
| Sonnet 4.6 | Threat actor narratives, cluster briefs, deep brand analysis (≤2K tokens) | Hot-path inference (cost), simple classification |
| Opus 4.7 | Reserved — architecture review required before any new call site | Anything we'd be willing to ship without it |

The default for any new agent is Haiku. A new Sonnet call site requires a one-paragraph justification in the PR description and an architecture-team sign-off in the review.

### Prompt-injection defense (user-input agents)

Sync agents accepting user input (`/api/v1/public/assess` is the canonical one) must:

1. **Sanitize input via `ai.inputSchema`** — strict regex/length/charset.
2. **Wrap user content in delimited blocks** in the prompt template (`<user_input>...</user_input>`).
3. **Instruct the model to ignore meta-instructions inside the user block** — explicit in the system prompt.
4. **Output schema is the catch-all** — even if injection succeeds, `outputSchema.parse()` rejects anything not matching the expected shape, so leakage is bounded.

<a id="9-output-schemas"></a>
## 9. Output schema validation

The single biggest hallucination defense. Every agent's `outputs[]` declares a Zod schema (or equivalent) for each output type. The runner validates before persisting.

```ts
// agents/brand-report.ts (sync agent example)
const BrandReportOutput = z.object({
  brand_id: z.string(),
  trust_score: z.number().int().min(0).max(100),
  grade: z.enum(['A', 'B', 'C', 'D', 'F']),
  summary: z.string().min(50).max(500),
  threat_count: z.number().int().min(0),
  recommendations: z.array(z.string()).max(5),
});

export const brandReportAgent: AgentModule<Input, z.infer<typeof BrandReportOutput>> = {
  name: 'brand_report',
  // …
  outputs: [{ type: 'classification', schema: BrandReportOutput }],
  ai: {
    callsites: ['brand-report'],
    model: 'haiku',
    promptVersion: 'v1.2.0',
    outputSchema: BrandReportOutput,
  },
  async execute(ctx) { … },
};
```

What happens on parse failure:
- `agent_runs.status` set to `'partial'` with `error_message: 'output_schema_failed: <details>'`
- Raw AI response logged to `agent_outputs` with `type: 'diagnostic'` for forensic review
- Sync caller receives `{ status: 'partial', data: null }` — handler must have a fallback path
- Schema-failure rate per agent surfaced on the Agents page — recurring failures indicate prompt drift

Where schemas live: `agents/<name>.ts` alongside the module. NOT in a separate file — keeping prompt + schema together makes drift impossible to ignore in code review.

<a id="10-permissions"></a>
## 10. Resource & permissions model

Every agent declares the resources it touches. The architect manifest extracts actual SQL reads/writes via static analysis and compares against the declaration — drift fails CI.

```ts
reads: [
  { kind: 'd1_table', name: 'threats' },
  { kind: 'd1_table', name: 'brands' },
  { kind: 'kv', namespace: 'CACHE', prefix: 'observatory_stats:*' },
],
writes: [
  { kind: 'd1_table', name: 'agent_runs' },        // implicit, all agents
  { kind: 'd1_table', name: 'agent_outputs' },     // implicit when outputs[].length > 0
  { kind: 'd1_table', name: 'spam_trap_captures' },
  { kind: 'r2', bucket: 'ARCHITECT_BUNDLES', prefix: 'narrator/*' },
],
```

### What this enforces

- **Static drift detection.** Architect manifest's per-agent SQL extraction runs on every build. If `agents/sentinel.ts` reads `users.email` but doesn't declare `users`, CI fails.
- **PII scope check.** Reads against `users`, `sessions`, `magic_link_tokens`, `passkeys` are flagged in PR review automatically.
- **Future namespace separation.** When we move to per-agent D1 sessions or SQL views, the declarations are the source of truth for what each agent's session can see.

### Implicit resources

Every agent implicitly reads/writes:
- `agent_runs` (lifecycle)
- `agent_outputs` (when outputs[] is non-empty)
- `agent_events` (when consuming or emitting events)
- `budget_ledger` (when calling AI)

These don't need to be declared.

<a id="11-cost"></a>
## 11. Cost attribution & per-agent budgets

Today's `checkCostGuard` is platform-wide — one bad agent can exhaust the global cap before tripping. Per-agent caps prevent that.

### Budget declaration (in module)

```ts
budget: {
  monthlyTokenCap: 5_000_000,    // 5M Haiku-equivalent tokens/month
  monthlyD1ReadCap: 2_000_000,
  monthlyD1WriteCap: 50_000,
  alertAt: 0.8,                  // alert at 80% of any cap
},
```

### Enforcement

- **Pre-flight check** — before each AI call, the runner reads this month's spend from `budget_ledger` for this agent's `callsites[]`. If `>= cap`, the call is refused with `error_message: 'agent_budget_exhausted'`.
- **Soft alert at `alertAt`** — emits an `agent_outputs` row of type `diagnostic` with `severity: 'high'`, surfaced on the Agents page.
- **Hard cap at 100%** — agent moves to status `paused`. Operator must explicitly resume after raising the cap.
- **Monthly reset** — caps reset on the 1st of the month UTC.

### Cost categories tracked

| Category | Source | Counted toward |
|---|---|---|
| AI tokens | `budget_ledger.cost_usd` | `monthlyTokenCap` (converted via cost-per-token rate) |
| D1 reads | Workers Analytics Engine `trust_radar_d1_reads` | `monthlyD1ReadCap` |
| D1 writes | wrangler `d1QueriesAdaptiveGroups` GraphQL | `monthlyD1WriteCap` |
| KV reads/writes | (out of scope for v1, free tier is generous) | — |
| R2 storage | (out of scope for v1) | — |

### UI exposure

The Agents page card shows a small budget gauge (used / cap, color-coded by % of `alertAt`). The detail panel shows the full breakdown by category and a sparkline of daily spend.

<a id="12-approval"></a>
## 12. Approval workflow

Two distinct approval flows. They solve different problems and have different UIs.

### 12.1 Deployment approval (one-time, per agent)

**Mandatory for every new or structurally-changed agent.** Not opt-in.

When a PR introducing a new agent merges, the agent ships in `status: 'shadow'` (canary, see §18). It does NOT immediately go live. The deploy emits a notification:

```
🔔 New agent ready for review: Recon (auto_seeder)

  • Compliance checklist:  12/12 ✓
  • Estimated monthly cost: $0.05 (Haiku, 12 calls/week)
  • Shadow runs in last 24h: 1 (status: success)
  • Resource scope:         reads 2 tables, writes 1 table

  [Review and approve →]
```

Notification channels: push (PWA / browser), email to `super_admin`s, an in-app banner on the Agents page. Same severity-based throttling as the existing notifications system.

The review screen (`/agents/<name>/review`) shows:

| Section | Source | Auto-populated |
|---|---|---|
| Compliance checklist | Enforcement script (§22) — 12-point list from §6 | ✓ each item, ✗ each missing item with the file/line |
| Resource declaration | `module.reads` + `module.writes` | Diff against actual SQL extracted by architect manifest |
| Output schema | `module.outputs[].schema` | Pretty-printed Zod schema + 1-2 sample valid outputs |
| AI guardrails | `module.ai` | Model · prompt version · all 8 gates from §8 with pass/fail |
| Cost projection | `module.budget` × cadence × cost-per-call | Estimated $/month, alert threshold |
| Shadow runs | `agent_runs` since deploy where `status='shadow'` | Last 5 runs with output preview |
| PR + author | Git metadata | Link to PR, author, merged-at |

Reviewer takes one of three actions:

- **Approve** → `agent_configs.status` flips `shadow → active`. Agent persists outputs from next run.
- **Reject** → `agent_configs.status` flips `shadow → paused`. Agent stops running. Reviewer must include a reason; goes back to author.
- **Request changes** → status stays `shadow`. Reviewer leaves notes, author iterates, re-requests review.

If no reviewer responds within 7 days, the agent stays in `shadow` indefinitely (safer than auto-promoting). A digest fires every 3 days while pending.

### 12.2 Per-run approval (`requiresApproval: true`)

Used when a single execution has high blast radius — sending an email to a registrar, calling a destructive admin endpoint, modifying customer-visible state.

Configured on the module:

```ts
requiresApproval: true,
approvalScope: 'per_run',  // every fire requires human green-light
```

When the agent's runner kicks off, instead of `status: 'running'` it inserts `status: 'awaiting_approval'` with the **full action description** in `agent_outputs.summary`. Notification fires identically to §12.1 but inline — operator approves or rejects within the notification or via a dedicated /approvals queue.

Approval window: 30 minutes default. After that the run auto-rejects (`status: 'failed'`, `error_message: 'approval_timeout'`). Configurable per agent via `approvalTimeoutMinutes`.

### 12.3 Combined flow

A brand-new high-blast-radius agent like a hypothetical "Auto-Reply Trustbot" would:

1. Ship `requiresApproval: true` AND status: `shadow`.
2. Reviewer approves deployment (12.1) — promotes to `active`.
3. Each individual run still requires per-run approval (12.2).

The two flows compose without conflict.

### 12.4 What's not approved

Approval gates do not apply to:
- Cron-triggered ticks for already-approved agents (per-run approval is opt-in via the flag).
- Internal lifecycle writes (`agent_runs`, `agent_outputs`, `agent_events`).
- Output schema validation (handled by the runner, not the approver).
- Budget guard tripping (operator must explicitly resume after a budget pause; that's a different action than approval).

<a id="13-comms"></a>
## 13. Inter-agent communication

Three channels, ordered by latency and durability:

| Channel | Latency | Durability | When to use |
|---|---|---|---|
| `agent_events` table | Seconds (next orchestrator tick consumes) | Durable, replayable | Loose coupling — agent A produces a signal, agent B consumes whenever it next runs |
| `ctx.waitUntil` direct dispatch | Milliseconds | Best-effort, dies with worker | Fire-and-forget within a tick (e.g. cartographer → analyst) |
| Cloudflare Workflow | Tens of seconds, durable | Fully durable, retries built-in | Multi-step processing > 30s CPU (cartographer backfill, NEXUS) |

### Event-channel rules

- Events written to `agent_events` MUST include `event_type` + `source_agent` + `payload` + `created_at`.
- Consumers filter by `event_type` and acknowledge by setting `consumed_at`.
- Unconsumed events older than 7 days are auto-archived (curator's job).
- An event MUST NOT trigger a synchronous loop — A emits → B consumes → B emits → A consumes is a circular dependency the architect manifest must catch.

### Forbidden inter-agent patterns

- **Direct function call from agent A to agent B's `execute()`** — bypasses Flight Control, bypasses cost guard, bypasses output validation. Always go through `executeAgent()` or events.
- **Unbounded fan-out** — `for (brand of brands) await executeAgent(...)` against 9.6K brands will saturate D1 and run out of CPU. Use Workflows for these.
- **Cross-tenant data access** — events MUST carry `org_id` if scoped, and consumers MUST filter.

<a id="14-observability"></a>
## 14. Observability

Beyond `agent_runs`. Five surfaces, all required for every agent.

### 14.1 Structured logs

Every agent uses `lib/logger.ts` (NOT `console.log`). Log lines include `agent_id`, `run_id`, `event`, and structured fields. Workers logs are persistent (24h sampling) so we can query post-mortem.

```ts
logger.info('cartographer_enrichment_complete', {
  agent_id: 'cartographer',
  run_id: ctx.runId,
  threats_processed: 1234,
  duration_ms: 8421,
});
```

### 14.2 Analytics Engine metrics

Each run emits one AE row:

```ts
env.AE.writeDataPoint({
  blobs: [agent.name, status, error_class],
  doubles: [duration_ms, items_processed, cost_usd],
  indexes: [agent.name],
});
```

Surfaces in the platform-diagnostics endpoint, the Agents page run-history sparkline, and AI cost dashboards.

### 14.3 Alerting thresholds

Each agent declares its alert thresholds in metadata:

```ts
alerting: {
  errorRateOver24h: 0.10,    // alert if >10% of runs failed
  durationP99: 30_000,       // alert if p99 > 30s
  successCadence: '7d',      // alert if no successful run in 7 days
}
```

When breached, an `alerts` row is created with `category: 'agent_health'` and surfaces in the existing Alerts UI.

### 14.4 Distributed traces

When agent A dispatches Workflow B, the run_id propagates so the Workflow's status is queryable from agent A's `agent_outputs`. Same for events. The Agents page's detail panel shows the dependency graph.

### 14.5 Audit log

Every state transition (`active → paused`, `paused → active`, approval, retirement) writes to `audit_log` with operator id + reason. Retention: 90 days minimum (compliance baseline).

<a id="15-failure"></a>
## 15. Failure modes & recovery

### 15.1 Failure taxonomy

| Class | Cause | Auto-recovery | Operator action |
|---|---|---|---|
| `transient` | Network blip, AI rate limit, D1 contention | Retry with backoff (2/4/8s) | None |
| `dependency_down` | A required external API or table is unreachable | Mark `partial`, skip the affected items, continue | Investigate dependency |
| `data_integrity` | Schema mismatch, NULL where NOT NULL expected | Mark `failed`, log row id, do NOT auto-retry | Fix data, re-run manually |
| `budget_exhausted` | Per-agent or platform cap hit | Pause agent | Raise cap, resume |
| `output_schema_failed` | AI output didn't match Zod schema | Mark `partial`, persist diagnostic, do NOT retry the same prompt | Investigate prompt drift |
| `approval_timeout` | `requiresApproval` and no human responded | Mark `failed` | Investigate approval gap |
| `circuit_open` | N consecutive failures (default 3) | Pause agent, FC won't dispatch | Operator review + resume |
| `crashed` | Thrown exception | Mark `failed` (run row updated by FC stall recovery) | Investigate stack trace |

### 15.2 Retry policy

`transient` only. Maximum 3 retries with 2s/4s/8s backoff. After 3 retries, escalate to `partial` or `failed` based on whether any items succeeded.

Retries do NOT consume an additional `agent_runs` row — they're recorded as `retry_count` on the original row.

### 15.3 Idempotency requirement

Running an agent twice in the same window MUST NOT double-write. Strategies:

- **Time-windowed dedup keys** — `INSERT OR IGNORE` on a `(agent_id, scope_id, period)` unique index.
- **Cursor-based** — agent reads `last_processed_id` from `agent_state` and only acts on rows newer than that.
- **Content-hash dedup** — hash the prospective write, skip if hash exists.

The enforcement script does not auto-detect idempotency violations. PR review is the gate.

<a id="16-sla"></a>
## 16. SLA / SLOs

Per-agent service-level objectives. Drive `stallThresholdMinutes` and the §14.3 alerting thresholds non-arbitrarily.

```ts
sla: {
  expectedRuntimeP50Ms: 5000,         // target p50 latency
  expectedRuntimeP99Ms: 30000,        // target p99 latency
  acceptableErrorRate: 0.02,          // 2% error rate is fine, more triggers alert
  recoveryTimeObjectiveMinutes: 60,   // operator response time to a paused agent
  successCadence: '24h',              // longest acceptable gap between successful runs
}
```

Stall threshold is derived: `stallThresholdMinutes = scheduleIntervalMinutes × 1.2`. Don't fudge it — if the cadence is 6 hours, the stall threshold is 7.2 hours, period.

<a id="17-testing"></a>
## 17. Testing standard

Three test types per agent, all mandatory. PR cannot merge without all three.

### 17.1 Unit tests (`<name>.test.ts`)

- Pure logic helpers — name synthesis, classification rules, scoring.
- Mocked `env` (D1, KV, AI calls).
- Run on every PR, < 5s per agent.

### 17.2 Integration tests (`<name>.integration.test.ts`)

- Full `execute()` against a Miniflare-backed local D1.
- Real schema, fixture data, mocked AI.
- Verifies output schema validation, cost guard short-circuit, idempotency.
- Run on every PR, < 30s per agent.

### 17.3 Snapshot test (output schema)

For agents with AI: a fixed prompt + recorded AI response (cassette-style) → assert the output matches the Zod schema. Catches prompt drift early.

### 17.4 Smoke test

If the agent has user-facing output (sync agents, narrator, observer): a probe added to `verify_ui_smoke` (the MCP tool from PR #871). Confirms a happy-path call works end-to-end against production-like data.

<a id="18-canary"></a>
## 18. Canary / shadow mode

Every new agent launches in `status: 'shadow'`. Specifically:

- **Runs on schedule.** The cron / event dispatcher fires it.
- **Calls AI.** Cost is real, attributed to the agent's budget.
- **Does NOT persist to `agent_outputs` or any domain table.** Only to `agent_runs` (with `status: 'shadow_success' | 'shadow_partial' | 'shadow_failed'`) and to a `shadow_outputs` audit table.
- **Output schema is still validated.** A shadow run with `output_schema_failed` is the strongest signal a new agent isn't ready.

After 7 days of shadow runs OR 50 successful runs (whichever first), reviewer can promote it to `active` via §12.1's deployment review.

Shadow mode also applies to STRUCTURAL changes on existing agents — e.g. swapping the AI model, changing the prompt template version, broadening resource access. The PR sets `module.status: 'shadow'` for one release; the next release flips back to `'active'` after review.

<a id="19-versioning"></a>
## 19. Versioning & rollback

Every agent module has an implicit version derived from git history. Beyond that:

- **Prompt version (`ai.promptVersion`)** is bumped on every prompt edit (semver: minor for tweaks, major for behaviour change). Stored alongside output for forensic traceability.
- **Output schema version** is encoded in the schema itself (Zod gives this for free via `.describe()`). Breaking schema changes require a migration of past `agent_outputs` OR a `schema_version` column on outputs.
- **Module-level breaking change** (rename, retire, role pivot) requires a migration plan in the PR description. Simply deleting an agent module is forbidden — use the retirement flow (§20).

### Rollback

- **Prompt rollback** — git revert the prompt-only change, redeploy. No data migration needed.
- **Schema rollback** — same, but past `agent_outputs` may have data conforming to the new schema; old consumers must tolerate it.
- **Agent disable** — flip `agent_configs.status` to `'paused'`. No code change. Reversible.

<a id="20-retirement"></a>
## 20. Retirement & decommission

Agents are not deleted from code. They are retired. Retirement is a one-way state transition.

### 20.1 The decommission flow

1. PR proposes retirement, with rationale + impact analysis (which consumers depend on its outputs?).
2. Reviewer approves via §12.1's deployment review screen (same gate, "Retire" action instead of "Approve").
3. PR sets `module.status: 'retired'` and adds the agent to a `RETIRED_AGENTS` const in `lib/agentRunner.ts`.
4. Cron dispatcher refuses to fire retired agents (defensive).
5. UI shows the agent in a separate "Retired" group with grey styling, last-run-ever badge, and link to the retirement PR for context.
6. After 30 days, the agent's metadata can be removed from `AGENT_METADATA` and the icon dropped — but the `AgentName` union retains it forever (so old `agent_runs` rows are still typed).

### 20.2 Data retention for retired agents

| Data | Retention |
|---|---|
| `agent_runs` rows | Forever (audit trail) |
| `agent_outputs` rows | 90 days, then archived to R2 (`ARCHITECT_BUNDLES/retired/<agent>/<date>/`) |
| `agent_events` rows | Auto-archived per §13 (no special handling) |
| `agent_configs` row | Forever (audit trail) |
| Module source file | Forever — git history is the audit trail |

### 20.3 Decommission candidates from Phase 0 hidden-agent hunt

Marked as "needs run-rate data to decide." Phase 1 audit will produce verdicts. Pre-recorded suspicions:

- **Watchdog** — likely overlaps with FC's stall recovery. Audit verdict: probably retire.
- **Curator** — vague mandate, no recent observable output. Audit verdict: probably retire OR consolidate into Architect.
- **Architect** — useful in principle (meta-agent auditing other agents). Audit verdict: keep IF its outputs are actually consumed; retire otherwise.
- **Pathfinder** — tangential to core threat-intel product. Audit verdict: keep (sales lead generation has clear ROI) but possibly demote to manual-only trigger.

<a id="21-authoring"></a>
## 21. Authoring: `pnpm new-agent`

A scaffolder that emits a compliant agent skeleton. Eliminates the 12-point wiring drift problem at the source.

```bash
pnpm new-agent recon-deux \
  --display "Recon Deux" \
  --category intelligence \
  --trigger scheduled \
  --schedule "weekly Sun 06:00"
```

Output (all wired correctly):
- `packages/trust-radar/src/agents/recon-deux.ts` — module skeleton with all required fields
- `packages/trust-radar/src/agents/recon-deux.test.ts` — unit test stub
- `packages/trust-radar/src/agents/recon-deux.integration.test.ts` — integration test stub
- Patches `agentRunner.ts` (AgentName union)
- Patches `agents/index.ts` (registry)
- Patches `agent-metadata.ts` (UI metadata)
- Patches `Agents.tsx` (group membership)
- Patches `AgentIcon.tsx` (placeholder icon to be replaced)
- Patches `flightControl.ts` (STALL_THRESHOLDS — until Phase 4 collapses this)
- Adds skeleton entry to `docs/AI_AGENTS.md`
- Creates `docs/agents/<name>.md` runbook stub

Author replaces the placeholder icon and TODO blocks, fills in the prompt and schema, runs `pnpm audit-agent-standard` to verify compliance, opens PR. PR description is auto-populated with the §12.1 deployment review prompt.

<a id="22-enforcement"></a>
## 22. Enforcement script

`scripts/audit-agent-standard.ts`. Runs in CI (typecheck workflow). Fails the build if anything in this doc is violated.

Checks:
- Every entry in `agentModules` has a matching `AGENT_METADATA` row.
- Every `AgentId` has an icon in `AgentIcon.tsx`.
- Every agent is a member of an AGENT_GROUPS group on the Agents page.
- Every agent has a `STALL_THRESHOLDS` entry (until Phase 4 collapses this onto the module).
- Every agent's `reads`/`writes` declarations cover the static SQL extracted by the architect manifest (drift = fail).
- Every AI-using agent has `ai.outputSchema` set (no freeform AI without validation).
- Every AI-using agent declares `ai.callsites[]` and every `agentId` used in `budget_ledger` from this module is in that list.
- No agent declares `costGuard: 'exempt'` without an inline justification comment.
- `pipelinePosition` is unique across all agents.
- No agent is missing from `docs/AI_AGENTS.md`.

The script also produces a compliance report consumed by §12.1's deployment review screen.

<a id="23-migration"></a>
## 23. Migration plan from current state

Current state (snapshot when this doc was written):

- 18 registered agents in `agentModules`.
- 4 hidden agents (`seed_strategist`, `cube_healer`, `navigator`, `enricher`) — see Phase 0 hidden-agent hunt.
- 15 inline AI call-sites in handlers/lib that should become sync agents.
- No deployment approval flow.
- No per-agent budgets.
- No output schema validation.
- Stall thresholds maintained as a side-table in `flightControl.ts` instead of on the module.

The migration runs as Phases 1-5 (from the audit plan):

| Phase | Scope | Deliverable | Risk |
|---|---|---|---|
| **1** | Per-agent fact sheet against this standard | `AGENT_AUDIT.md` with one row per current agent + verdict | None (read-only) |
| **2** | Structural compliance for the 4 hidden agents + 18 existing | 5-6 small PRs, one per agent group | Low |
| **3** | Migrate 15 AI call-sites to sync agents. Each PR adds the agent + output schema + cost guard. | 8-10 PRs over a week | Medium — touches user-facing handlers |
| **4** | Roll up `STALL_THRESHOLDS`, `AGENT_METADATA`, group membership onto the module itself. Wiring checklist collapses from 12 items to 4. | 2-3 PRs | Low (refactor) |
| **5** | Approval workflow UI, per-agent budget enforcement, scaffolder, enforcement script | 4-5 PRs | Medium (new UI) |

Total scope: ~25 PRs over 2-3 weeks. Each PR is small, reversible, and ships behind the existing test gates. No big-bang.

---

## Open questions

To resolve before Phase 1 starts:

1. **Zod vs hand-rolled validators?** Zod is the obvious choice (already used in averrow-ops) but adds a dependency to the worker. Cost-of-validation matters for sync agents on hot paths.
2. **Where does the deployment review screen live?** New page under `/agents/<name>/review`, or extend the existing `/agents` detail panel? The latter is faster but less discoverable.
3. **Per-run approval UI** — push notification with inline action buttons, or push-to-screen? Inline is the right UX but PWA action buttons have iOS limitations.
4. **Single FC vs domain-split FCs?** Today one FC supervises 19 agents; with §11's per-agent budgets the single-FC model probably scales. Phase 5 verdict.
5. **Retirement delete vs archive?** Current spec keeps retired modules in code forever. Acceptable tradeoff vs file count growth.

---

## Changelog

- 2026-04-29: Initial draft (Phase 0 of agent audit). Sections 1-23 + open questions.

