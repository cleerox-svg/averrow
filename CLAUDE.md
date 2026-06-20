# CLAUDE.md — Averrow Platform: Claude Code Standing Instructions

This file is read at the start of every Claude Code session.
Follow all instructions here before writing any code. These are non-negotiable.

---

## 1. Read These First (Every Session)

Before writing any code, read:
1. `RESTRUCTURE_SPEC.md` — target architecture, component specs, migration sequence
2. `AVERROW_UI_STANDARD.md` — design system quick reference
3. `docs/API_REFERENCE.md` — all API routes (do not duplicate)

If the task touches agents or backend:
4. `docs/AI_AGENTS.md` — agent architecture and rules
5. `docs/PLATFORM_DATA_DEPENDENCIES.md` — cross-surface data flow (what reads from
   `agent_runs` vs `agent_activity_log`, how Status/Notifications/APIs/Agents
   depend on each other, the workflow-agent reconciliation rule)

If the task touches login, profile, push, biometric, or PWA install:
5. `docs/SHARED_LOGIN_SPEC.md` — the canonical Averrow ↔ FarmTrack
   login spec. Both products must stay structurally identical; only
   the per-product deltas listed in §1 may differ.

```bash
# Always check for TODOs before starting
grep -rn "TODO\|FIXME\|HACK" packages/averrow-ops/src/ --include="*.tsx" | head -20
```

---

## 2. Repository Structure

```
/
├── packages/
│   ├── trust-radar/              ← Cloudflare Worker (backend) — internal name kept
│   │   ├── src/
│   │   │   ├── agents/           ← All agent files
│   │   │   ├── routes/           ← API route handlers
│   │   │   ├── handlers/         ← Route handler functions
│   │   │   ├── feeds/            ← Threat feed modules
│   │   │   ├── lib/              ← Shared utilities
│   │   │   └── index.ts          ← Worker entry point
│   │   └── wrangler.toml
│   ├── averrow-ops/              ← Staff back-office React SPA (rebadged from averrow-ui in v3 D2; serves /v2/*)
│   ├── averrow-tenant/           ← Customer-facing React SPA (serves /tenant/*)
│   │   ├── src/
│   │   │   ├── design-system/    ← [RESTRUCTURE TARGET] tokens + primitives
│   │   │   ├── features/         ← [RESTRUCTURE TARGET] domain-driven features
│   │   │   ├── layouts/          ← Shell, Sidebar, TopBar, MobileNav
│   │   │   ├── mobile/           ← Mobile-specific views (CommandCenter only)
│   │   │   ├── pages/            ← Migrating to features/ during restructure
│   │   │   ├── components/       ← Migrating to features/ or design-system/
│   │   │   ├── hooks/            ← TanStack Query hooks
│   │   │   └── lib/              ← api.ts, auth.tsx, time.ts, cn.ts
│   │   └── tailwind.config.ts
│   ├── averrow-mcp/              ← MCP server exposing platform diagnostics to Claude Code
│   │   ├── src/index.ts          ← Wraps `/api/internal/*` with MCP tool schemas
│   │   └── wrangler.toml         ← Requires AVERROW_INTERNAL_SECRET + MCP_AUTH_TOKEN
│   └── imprsn8/                  ← Separate Worker for imprsn8.com (digital-impression scoring)
│       ├── src/                  ← handlers/, lib/, middleware/, templates/
│       ├── migrations/           ← D1 migrations (imprsn8-db)
│       └── wrangler.toml
├── docs/
│   ├── API_REFERENCE.md          ← All API routes — update when adding endpoints
│   ├── ARCHITECTURE.md           ← System architecture
│   ├── AI_AGENTS.md              ← Agent specifications
│   ├── archive/                  ← Superseded documents
│   └── ...
├── CLAUDE.md                     ← This file
├── RESTRUCTURE_SPEC.md           ← Architecture source of truth ← READ THIS
├── AVERROW_UI_STANDARD.md        ← Component quick reference
└── docs/IMPROVEMENT_PLAN_2026-06.md ← Active roadmap (see docs/PLATFORM_ASSESSMENT_2026-06.md; old master plan archived)
```

---

## 3. Current Platform State

**React /v2 IS the live platform.**
- `averrow.com` → serves React /v2 by default (session-aware routing)
- `averrow.com/legacy` → old SPA escape hatch
- `/v2` is not in URLs — React Router `basename="/v2"` handles it internally

**NEVER MODIFY — frozen forever:**
```
public/          ← OLD SPA — DO NOT TOUCH
app.js           ← OLD SPA — DO NOT TOUCH
styles.css       ← OLD SPA — DO NOT TOUCH
```

**Restructure in progress:** Sessions R1–R10 per `RESTRUCTURE_SPEC.md`.
Check the spec to see which sessions are complete before starting work.

---

## 4. Code Standards (Zero Exceptions)

### TypeScript
- `npx tsc --noEmit` must pass before every commit
- No `any` types — use `unknown` + type guard
- No `// @ts-ignore` — fix the actual type issue

### React / UI

**The platform is undergoing a full restructure (R1–R10 per RESTRUCTURE_SPEC.md).**

**For sessions working on new/restructured files:**
- Import components from `@/design-system/components`
- Use CSS custom properties: `var(--amber)`, `var(--text-primary)`, `var(--sev-critical)` etc.
- Never use old tokens in new code: no `glass-card`, `bg-cockpit`, `text-parchment`, `text-contrail`

**For sessions NOT yet migrating a file:**
- Leave existing old tokens in place — do not mix systems in one file
- Old files stay old until their designated restructure session

**Components — always use shared components, never rebuild inline:**
During restructure, check `RESTRUCTURE_SPEC.md` for the current component locations.
After restructure: everything imports from `@/design-system/components`.

**Frozen components — never refactor these:**
- `ThreatMap.tsx` — WebGL canvas, untouchable
- `ExposureGauge.tsx` — custom SVG, untouchable
- `PortfolioHealthCard.tsx` — SVG donut, untouchable
- `Sparkline.tsx`, `ActivitySparkline.tsx` — SVG sparklines, untouchable
- `EventTicker.tsx` — scrolling ticker, untouchable

### Backend / Worker
- All agents must write to `agent_runs` on start AND completion
- All agents must emit to `agent_events` after completion
- Never hardcode secrets — use `env.SECRET_NAME`
- D1 queries: always use prepared statements, never string interpolation
- New endpoints must be added to `docs/API_REFERENCE.md`

---

## 5. Design System Quick Reference

### CSS Custom Properties (defined in design-system/tokens.css after R1)

```css
/* Backgrounds */
--bg-page:      #060A14
--bg-card:      rgba(22,30,48,0.85)
--bg-sidebar:   rgba(10,16,30,0.96)

/* Primary accents */
--amber:        #E5A832    /* primary — CTAs, active states, nav */
--amber-dim:    #B8821F    /* gradient pair */
--red:          #C83C3C    /* alerts, critical, logo */
--red-dim:      #8B1A1A    /* gradient pair */
--blue:         #0A8AB5    /* info, infrastructure */
--blue-dim:     #065A78
--green:        #3CB878    /* healthy, operational */
--green-dim:    #1A6B3C

/* Text */
--text-primary:   rgba(255,255,255,0.92)
--text-secondary: rgba(255,255,255,0.60)
--text-tertiary:  rgba(255,255,255,0.40)
--text-muted:     rgba(255,255,255,0.25)

/* Severity */
--sev-critical:        #f87171
--sev-critical-bg:     rgba(239,68,68,0.10)
--sev-critical-border: rgba(239,68,68,0.30)
--sev-high:            #fb923c
--sev-high-bg:         rgba(249,115,22,0.08)
--sev-medium:          #fbbf24
--sev-medium-bg:       rgba(229,168,50,0.08)
--sev-low:             #60a5fa
--sev-low-bg:          rgba(59,130,246,0.07)

/* RESERVED — Observatory WebGL only */
--orbital-teal: #00d4ff
```

### Light Theme
`[data-theme="light"]` overrides all `--bg-*` and `--text-*` vars.
Accent colors and severity colors stay the same in light mode.
Set via `document.documentElement.setAttribute('data-theme', 'light')`.
Stored in `localStorage` via `useTheme()` hook.

### Component Usage (after R2+)
```typescript
import {
  Card, Button, Badge, Avatar, StatCard,
  DataRow, FilterBar, Tabs, PageHeader, StatGrid,
  Input, Select, Modal, EmptyState
} from '@/design-system/components';

// Card variants
<Card />                              // base glass
<Card variant="elevated" />           // modals, panels
<Card variant="active" />             // live data, amber glow
<Card variant="critical" />           // alerts, red glow
<Card variant="active" accent="#0A8AB5" />  // custom accent

// Button variants
<Button />                            // primary amber gradient
<Button variant="secondary" />        // glass dark
<Button variant="danger" />           // red gradient
<Button variant="ghost" />            // transparent

// Badge — unified severity + status
<Badge severity="critical" />
<Badge severity="high" />
<Badge status="active" pulse />

// Avatar (brand/entity — favicon + initial fallback, not for users)
<Avatar name="Acme Corp" color="var(--red)" />
<Avatar name="Google" faviconUrl="https://..." severity="critical" />
```

### User avatars — initials only, never Google profile picture

Source-of-truth helpers in `packages/averrow-ops/src/lib/avatar.ts`:

```typescript
import { parseInitials, colorForUserId, SELF_AVATAR_COLOR } from '@/lib/avatar';

parseInitials("Claude Leroux", null)        // "CL"
parseInitials("Claude Marc Leroux", null)   // "CL"  (first + last word, drops middle)
parseInitials("Claude", null)               // "C"
parseInitials(null, "you@example.com")      // "Y"
parseInitials(null, null)                   // "?"

colorForUserId("usr_abc123")                // deterministic palette pick
SELF_AVATAR_COLOR                           // var(--amber)
```

**Color rule:**
- Self-avatar (top bar, profile dropdown, profile identity card) → always `SELF_AVATAR_COLOR` (static amber).
- Non-self avatars (admin user lists, attribution rows, comment authors) → `colorForUserId(user.id)` so the same user gets the same color across the app.

**Never render `user.avatar_url` / Google profile picture.** Drop the prop from any `<img>` or Avatar call site that previously rendered it. Initials only. See `docs/SHARED_LOGIN_SPEC.md` §3.

### Login + Profile composition

Don't redesign the Login or Profile pages without checking
`docs/SHARED_LOGIN_SPEC.md` first. Both must stay structurally
identical to FarmTrack. Per-product deltas are limited to:
- Brand tile letters (`AV` here, `FT` on FarmTrack)
- Tagline (`AI-FIRST THREAT INTELLIGENCE` here, `AN AVERROW PRODUCT` on FarmTrack)
- Footer pillars (`DETECT · ANALYZE · CORRELATE · RESPOND` here)
- OAuth `return_to` target

### PWA install + biometric prompt

Two install affordances + one biometric auto-prompt:

| Component | Where | When |
|---|---|---|
| `<InstallAppBanner />` | Top of `Home.tsx` | Visible to non-installed users; dismissible per-device |
| `<InstallAppCard />` | Profile page | Always visible (when not installed); not dismissible |
| `<FirstSignInPasskeyPrompt />` | Mounted at `Shell.tsx` root | Auto-fires when `passkey_count === 0` + WebAuthn supported |

All three self-gate internally. Don't add per-route logic to control them.

**Scope note (2026-06-10):** this PWA flow is fully wired in `averrow-ops` only
(hand-rolled SW at `/v2/sw.js`, registered via `src/lib/pwa.ts`, push in
`src/lib/push.ts`). `averrow-tenant` ships a manifest but **no service worker**,
so install/push there is aspirational until improvement-plan session S12
(`docs/IMPROVEMENT_PLAN_2026-06.md`) lands a tenant SW.

---

## 6. Agent Architecture Rules

### Every agent must:
1. Log a row to `agent_runs` at start
2. Update `agent_runs` on completion with `completed_at` and `records_processed`
3. Emit to `agent_events` after completion
4. Handle errors — catch all exceptions, log to `agent_runs.error_message`

### Agent status field (`AgentModule.status`)

The `status` value on each AgentModule registration is **descriptive,
not enforced** — it controls how operators classify the agent and how
the `/v2/agents` UI surfaces it, but `executeAgent` / `runSyncAgent`
(`lib/agentRunner.ts:302,526`) do **not** gate dispatch on it. The
per-agent circuit-breaker (`agent_configs.enabled`) is the only
runtime kill-switch.

| Value | Meaning |
|---|---|
| `active` | Normal operation — dispatched per its trigger field |
| `paused` | Operator-flagged halt — dispatch is the caller's responsibility |
| `shadow` | Used by some agents to label A/B test variants — pure marker |
| `retired` | No real usage; **still callable** via existing manual/sync handlers |

**Retired-as-of 2026-05-14 (PR-P)**: audit of `agent_runs` showed 11
manual/api agents with zero traffic since 2026-04-30 (a one-time test
harness produced ~32 runs each, then nothing). Files and API routes
remain; only the status field was flipped:

```
admin_classify, brand_analysis, brand_deep_scan, brand_report,
geo_campaign_assessment, honeypot_generator, public_trust_check,
qualified_report, scan_report, social_ai_assessor, url_scan
```

**Important caveat (WS-B truth-up):** these agents continue to be
called from live handlers. `public_trust_check` is wired into the
public homepage scan widget (`handlers/admin.ts`); `brand_deep_scan`
is dispatched by the brand-page "AI DEEP SCAN" button; etc. The
`/v2/agents` page shows them with their pretty subtitles but
`0 runs / 24h` because sync invocations don't always write to
`agent_runs`. To genuinely retire an agent: also remove the
manual/api handler that dispatches it. To pause runtime dispatch
without changing the status field: flip
`agent_configs.enabled = 0`.

To re-promote a retired agent to first-class status: flip its
status back to `"active"`. Operators expecting any of these to
"just work" via the agent mesh should be aware they're flagged
dormant — but if a CTA on a customer-facing page calls them, the
CTA still works.

Distinct from `pathfinder` — that agent was explicitly demoted to
`trigger: "manual"` in April after producing 1 run / 7 days under
cron. Pathfinder stays `active` so the existing manual endpoint
keeps working.

### Agent trigger chain:

The platform uses **cron + orchestrator** as the canonical control
flow. The `agent_events` table is mostly **telemetry** — a forensic
record of agent completions — with one event-driven dispatch
(`pivot_detected` → Observer) for low-latency operational alerting.

Events with `target_agent` set are dispatched by `processAgentEvents`
in the orchestrator. Events with `target_agent=NULL` are written for
operator traceability but no auto-dispatch happens (PR-L:1306).

```
Active edges (event-driven):
  Nexus → [pivot_detected]   → Observer    (target_agent='observer')

Telemetry only (target_agent=NULL):
  Sentinel      → [feed_pulled]       — operator sees "new items found"
  Cartographer  → [threats_enriched]  — operator sees enrichment progress
  Nexus         → [nexus_complete]    — operator sees workflow completion

Cron-driven dispatch (no event needed):
  Cartographer  every hour via dedicated `9 * * * *` cron (PR-F)
                + FC scaleAgents for backlog drain
  Nexus         every 4h via NEXUS_RUN workflow (PR-B/D)
  Analyst       every hour via orchestrator inline await
  Strategist    every 6h via orchestrator
  Sparrow       every 6h via orchestrator
  Observer      daily at hour===0 via orchestrator
                + pivot_detected event for immediate dispatch

Not wired (historically declared but never implemented):
  Nexus    → [cluster_detected]  → Analyst + Observer  (never emitted)
  Analyst  → [scores_updated]    → Pathfinder          (Pathfinder demoted to manual 2026-04-29)
```

Industry guidance ([StartupHub.ai 2026](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/multi-agent-orchestration-patterns))
calls hybrid models without explicit lanes the #1 cause of
multi-agent system failure. Trust-Radar is explicitly orchestrator-
pattern with a single event-driven exception (pivot_detected, where
sub-hourly latency matters).

### AI usage rules:
- **Haiku:** classification, scoring, short summaries — high volume
- **Sonnet:** threat actor narratives, cluster briefs — sparingly
- **NEVER** use AI for what SQL `GROUP BY` can do in 50ms
- All AI calls go through Cloudflare AI Gateway
- **Idempotency**: every call through `callAnthropic` (lib/anthropic.ts)
  carries a deterministic `anthropic-idempotency-key` header computed
  from (agentId + runId + model + system + messages + maxTokens). When
  a Workflow step retries (cart workflow's per-step retry policy, FC
  recovery, etc.), the second attempt sends the same key and Anthropic
  returns the cached response — no double-charge. Suppress per-call
  by passing `idempotencyKey: ''` when the prompt legitimately includes
  a timestamp or other non-stable input. See PR-N (#1309).

### Cron schedule (wrangler.toml):
```
navigator:    */5 * * * *    (every 5 min — DNS resolution, cube refresh, cache warming of 24 endpoints)
                              (independent agent; FC monitors health but does not dispatch;
                               historical agent_runs rows use agent_id='fast_tick')
orchestrator: 7 * * * *     (hourly at :07 — feeds, agent dispatch, Workflows)
enricher:     8 * * * *     (hourly at :08 — own invocation so it doesn't share CPU
                             with the orchestrator's analyst inline-await. Decoupled
                             from orchestrator after PR-E because inline placement
                             was dropping ~30-50% of ticks.)
cartographer: 9 * * * *     (hourly at :09 — guaranteed maintenance run with own
                             worker budget. Maintains AI provider scoring + email
                             security scans + provider stats. FC scaleAgents still
                             fires ADDITIONAL instances on top for backlog drain.
                             Dedicated cron added in PR-F after 24% failure rate
                             observed at the orchestrator's :07-:12 window.)
strategist:   10 */6 * * * (every 6h at :10 — relocated from orchestrator in PR-Q because
                             the hour%6===0 inline-await dispatch was routinely starved
                             by analyst's 113s ahead of it)
sparrow:      11 */6 * * * (every 6h at :11 — same rationale as strategist)
cube-healer:  12 */6 * * *  (every 6 hours at :12 — 30-day bulk cube rebuild)
app_store:    13 */6 * * * (every 6h at :13 — dedicated cron PR-Q)
dark_web:     14 */6 * * * (every 6h at :14 — dedicated cron PR-Q)
social:       15 */6 * * * (every 6h at :15 — dispatches social_discovery + social_monitor
                             paired, discovery-first — dedicated cron PR-Q)
brand_scores: 16 0 * * *   (daily at 00:16 UTC — computeBrandScoresBatch over the
                             full brand catalog; writes one brand_score_snapshots
                             row per brand. Was gated on `hour === 0` inside the
                             orchestrator but starved by analyst inline-await, so
                             brand_score_snapshots sat at 0 rows and the Brands
                             page Improving/Declining cards were permanently
                             empty. Dedicated cron PR-T — same pattern as PR-E/F/Q.)
auto-seeder:  (no dedicated cron — gated inside the hourly orchestrator
               on Sundays at hour===5, runs at 05:07 UTC. CF rejects
               the 5-field cron `23 5 * * 0` with code 10100, so this
               is dispatched from the existing hourly cron path.)
greynoise:    19 */4 * * * (every 4h at :19 — dedicated enrichment-feed cron.
                             Was inline in runAllEnrichmentFeeds; its 8×30s
                             sequential sleeps blew the orchestrator worker's
                             wall-clock budget → worker killed → pull reaped
                             silently → breaker never advanced → feed sat
                             overdue 11h+ while still enabled. Own invocation
                             = fresh budget. Skipped inline via
                             DEDICATED_ENRICHMENT_FEEDS. Cadence matches the
                             45/day community cap (8/run × 6 = 48).)
seclookup:    21 * * * *   (hourly at :21 — dedicated enrichment-feed cron,
                             same rationale as greynoise; 100×1s sequential
                             lookups were the worst starvation victim. Hourly
                             cadence drains its enrichment backlog. Both feeds
                             also carry a per-run wall-clock budget guard so a
                             single run can't approach the 15-min reap window.)
```

### Agent dispatch (inside orchestrator hourly tick):
All agents below are dispatched from `runThreatFeedScan()` inside the orchestrator.
Time gates use `event.scheduledTime` hour-only — **no minute gates** (see cron-audit rule below).

```
Always (every tick):  Flight Control, Incident recovery sweep, CertStream health, agent_events consumer
                      (Enricher moved to its own `8 * * * *` cron — see schedule above)
                      (Cartographer's baseline maintenance moved to its own `9 * * * *` cron in PR-F.
                       FC scaleAgents still fires additional cart instances for backlog drain.)
Always (every tick):  Feed ingestion, brand match, email security, Cartographer, Analyst
Sentinel:             after feed ingestion if totalNew > 0 (inline await)
Cartographer:         after Sentinel OR as fallback (dispatched as Workflow)
Analyst:              every tick (ctx.waitUntil)
Strategist:           hour % 6 === 0 (ctx.waitUntil)
NEXUS:                hour % 4 === 0 (dispatched as Workflow)
Sparrow:              hour % 6 === 0 (ctx.waitUntil)
Observer:             hour === 0 (inline await)
Pathfinder:           hour === 3 (inline await, KV throttle ensures once per 7 days)
GeoIP Refresh:        Sunday hour === 2 (ctx.waitUntil, polls MaxMind sha256 — no-op when current; FC supervises stuck workflows hourly per §15)
Observer briefing:    hour === 6 (inline await — also runs Seed Strategist)
Narrator:             hour === 6 (executeAgent, after Observer briefing)
Briefing email:       hour === 13 (inline await, dedup against today's cron briefings)
CT monitor:           every tick (inline await, in handleScheduled)
Lookalike check:      every tick (inline await, in handleScheduled)
Trademark scan:       every tick (runJob, agent 'trademark_monitor' — Phase 1 internal correlation, no external cost; see docs/TRADEMARK_MONITORING.md)
Social discovery:     hour % 6 === 0 (in handleScheduled)
Social monitor:       hour % 6 === 0 (in handleScheduled)
Daily snapshots:      hour === 0, or if none exist today (inline await)
```

**Parity-checker:** Removed in Wave 6. No longer runs anywhere. Do not reference.

### Cron-audit rule (MANDATORY):
When changing cron schedules in `wrangler.toml`, you MUST audit every time gate
in the affected handler for minute-based assumptions. The cron fires at ONE
specific minute — any `minute === X` check that doesn't match that minute is
dead code. This rule exists because Wave 1A shifted the orchestrator from `:00`
to `:07` without updating minute gates, silently killing the entire agent mesh
for 22 hours. All orchestrator gates now use hour-only checks. If sub-hourly
scheduling is needed, use Navigator (`*/5`) or add a dedicated cron trigger.

### Execution patterns:
- **Workflow dispatch:** NEXUS runs as a Cloudflare Workflow (`NEXUS_RUN`), dispatched from the orchestrator cron at `hour % 4 === 0` via `dispatchWorkflow()` in `lib/workflow-dispatch.ts` (KV cooldown on platform errors, FC supervisor watches the last-dispatch stamp). The agent module (`agents/nexus.ts`) stays available as the manual trigger fallback at `/api/internal/agents/nexus/run`. Cartographer still runs as the agent module via FC's `scaleAgents` (workflow path exists but is enrichment-only — see `docs/runbooks/workflow-dispatch.md`).
- **ctx.waitUntil:** Analyst, Strategist, Sparrow run in parallel without blocking the cron mesh
- **Inline await:** Observer, Pathfinder run sequentially (quiet times, fast execution)

### Feed circuit breaker (`lib/feedRunner.ts:computeFeedRetryAt`)

Each feed has a per-feed circuit breaker via `feed_status.next_retry_at`.
On failure, the column is stamped with an exponential-backoff timestamp
(+ ±25% jitter) so the next `runAllFeeds` tick skips the feed until
the window expires. On any successful pull, the column is cleared
(half-open → closed transition). Cleared independently of the auto-pause
threshold below, which still owns hard pauses after N consecutive failures.

**Worker-killed pulls also advance the breaker.** When a pull row is
reaped (worker terminated mid-run → `runFeed`'s catch never executes),
`lib/feed-pull-reaper.ts` now calls `feedRunner.applyReapPenalty` for
each reaped feed: it increments `consecutive_failures`, stamps the same
exponential-backoff `next_retry_at`, and auto-pauses at threshold. Before
this, reaped pulls left the breaker blind, so a feed whose pulls were
always killed (e.g. greynoise/seclookup starved in the inline enrichment
chain) death-looped silently — enabled, "due" every tick, dying every
time, never backing off, never auto-pausing, never alerting. Heavy
enrichment feeds were additionally moved to dedicated crons (greynoise
`19 */4`, seclookup `21`) so they get a fresh per-invocation budget; both
also carry a per-run wall-clock budget guard.

Backoff schedule (base, before jitter):

| Consecutive failures | Backoff |
|---|---|
| 1 | 5 min |
| 2 | 15 min |
| 3 | 45 min |
| 4+ | 120 min (cap) |

Jitter (±25%) is critical: without it, multiple feeds failing on the
same upstream at the same time would all retry at the exact same
minute. Industry guidance: [Fastio retry patterns 2026](https://fast.io/resources/ai-agent-retry-patterns/),
[Google Vertex AI retry docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/retry-strategy).


---

## 7. API Conventions

- User endpoints: `/api/...` (JWT Bearer auth)
- Admin endpoints: `/api/admin/...` (JWT + admin role)
- Internal agent triggers: `/api/internal/agents/:name/run` (AVERROW_INTERNAL_SECRET header)
- **Every new endpoint must be added to `docs/API_REFERENCE.md`**
- Never duplicate an existing endpoint — check the reference first

### RBAC — global vs org roles

Two independent role systems coexist:

**Global roles** (`users.role`, type `UserRole` in `src/types.ts`):

```
super_admin  level 5  — full platform access
admin        level 4  — most platform admin actions
analyst      level 3  — Averrow SOC: handles alerts/takedowns/incidents
sales        level 3  — read customer data + edit pricing + send invites
support      level 3  — read customer data + alerts (no edits)
billing      level 3  — Stripe + pricing only
auditor      level 3  — READ-ONLY global seat (AUTH_AUDIT_2026-06): sees
                        ALL backend + tenant data (getOrgScope returns null,
                        like super_admin), mutates nothing, never reaches an
                        admin-only gate. Minted-only — see note below.
client       level 1  — customer (lives at /tenant; never reaches /v2)
```

**`auditor` is minted-only.** It's a real `UserRole` with a read-only
permission set + global org scope, but it is NOT assignable to a stored
user: the prod `users.role` / `invitations.role` CHECK constraints permit
only `super_admin/admin/analyst/client`, and relaxing them requires a
`users` table rebuild that is UNSAFE to auto-apply (D1 enforces FKs —
`PRAGMA foreign_keys=1` — so `DROP TABLE users` cascades into
sessions/passkeys/notifications). So `auditor` is issued only via
`/api/internal/auth/mint-ui-preview-jwt`, where the preview row is stored
under a CHECK-valid `analyst` placeholder while the minted JWT carries the
real `auditor` role (preview tokens are standalone — no refresh — so the DB
role is never read back to re-mint). To make `auditor` human-assignable,
relax both CHECKs in a maintenance-window rebuild first, then add it to
`VALID_ROLES` in `handlers/invites.ts`.

The four sub-roles (analyst / sales / support / billing) all sit
at level 3 because hierarchy can't capture their differentiated
permission sets. Use `roleHasPermission(role, permission)` from
`lib/role-permissions.ts` when access decisions depend on WHAT
the user can DO, not just whether they're staff.

**Permission flags** (`StaffPermission`):
`read_customers`, `edit_pricing`, `edit_alerts`, `manage_takedowns`,
`manage_invites`, `view_billing`, `view_audit`. The matrix lives
in `lib/role-permissions.ts` and is the single source of truth.

**Middleware guards** (`src/middleware/auth.ts`):
- `requireAuth` — any authenticated user
- `requireStaff` — any non-client (analyst, sales, support, billing,
  admin, super_admin)
- `requireAdmin` — admin or super_admin
- `requireSuperAdmin` — super_admin only
- `requirePermission(flag)` — gates on a `StaffPermission` flag via
  `roleHasPermission`; preferred when the access decision maps to a
  documented permission, especially when multiple sub-roles share an
  endpoint (e.g. pricing routes gate on `edit_pricing`, held by both
  sales and billing). Wired (M4, 2026-06-10 audit) onto: org reads
  (`read_customers`), pricing reads (`view_billing`), pricing
  mutations (`edit_pricing`), staff invites (`manage_invites`), and
  the admin takedown queue (`manage_takedowns`).
- `requireSales` / `requireSupport` / `requireBilling` — specialty
  sub-role guards (super_admin + admin always satisfy any sub-role
  guard since they grant everything). `requireSales` is wired onto
  the `/api/admin/sales-leads/*` lifecycle (prospect data has no
  permission flag; lead DELETE stays super_admin).
  `requireSupport` / `requireBilling` currently have no call sites:
  support's job (customer reads + alerts) is covered by
  `read_customers` + the `requireStaff`-gated `/api/alerts/*`
  surface, and billing's by `view_billing` / `edit_pricing`.

**Org-level roles** (`org_members.role`) are a SEPARATE namespace:
`viewer < analyst < admin < owner`. The string `analyst` exists in
both — a global `analyst` is an Averrow SOC analyst, an org
`analyst` is a customer's internal investigator. The codebase
disambiguates by which table the role is read from. When grepping,
context is the column name, not the value.

**Adding a new global role**:
1. Add to `UserRole` in `src/types.ts`
2. Set its hierarchy level in `middleware/auth.ts ROLE_HIERARCHY`
3. Add a row to `ROLE_PERMISSIONS` in `lib/role-permissions.ts`
4. Add the literal to `VALID_ROLES` in `handlers/invites.ts`
5. Update this section + `docs/API_REFERENCE.md` if any new
   endpoints gate on the role

### Standard response format:
```typescript
// Success
{ success: true, data: T, total?: number }

// Error
{ success: false, error: string }
```

---

## 8. Database Rules

- Primary DB: `trust-radar-v2` (D1, SQLite) — internal name kept intentionally
- Audit DB: `trust-radar-v2-audit`
- GeoIP DB: `geoip-db` (D1, optional binding `GEOIP_DB`) — dedicated reference DB for the third-tier MaxMind GeoLite2 lookup. Migrations live in `migrations-geoip/`. Cartographer Phase 0.5 queries it; the `geoip_refresh` agent loads it. Isolated to keep range-scan reads off the main DB's budget — see `lib/geoip-mmdb.ts`.
- DNS queue DB: `trust-radar-dns-queue` (D1, optional binding `DNS_QUEUE_DB`) — side DB holding the "needs DNS resolution" working set. After the PR-1 → PR-4 split (May 17–18), `dns_queue` is the **source of truth** for the cooldown + attempts state previously kept on `threats.attempted_resolve_at` + `threats.enrichment_attempts`. Navigator's dns-backfill drains it; `lib/dns-queue-reconciler.ts` enqueues new candidates from threats every tick using a **cursor-paginated** read (KV key `reconciler:dns_queue:cursor`, reads only rows added since the last cursor — PR-BI 2026-05-19). The companion `lib/dns-queue-reaper.ts` sweeps stale rows once per day at hour===0 (rows whose threats flipped to inactive after enqueue). Threats table still owns the `ip_address` deliverable but no longer carries the per-attempt state. Threats-side dns indexes (`idx_threats_dns_pending_strict`, `idx_threats_dns_backfill`, `idx_threats_dns_backfill_select`) were dropped in migration 0200. FC backlog (`backlog.domain_geo` / `domain_geo_drainable`), diagnostics (`enrichment_pipeline.domain_geo_drainable`, `dns_queue_parity.drainable_in_threats`), and the admin backfill endpoint all read from `dns_queue` now. Health monitored by FC via `platform_dns_queue_drift`, `platform_dns_queue_stalled`, and `platform_dns_queue_reaper_stalled` notifications. Read-budget: cursor + reaper architecture ≈ 94K reads/day on main DB (down from 15M/day pre-PR-BI, 99.4% reduction). See `lib/dns-backfill.ts` + `lib/dns-queue-reconciler.ts` + `lib/dns-queue-reaper.ts`.
- **Never DROP or ALTER existing columns** without explicit instruction
- New columns: `ALTER TABLE ... ADD COLUMN` only
- New migrations: `migrations/NNNN_description.sql`
- Always use prepared statements — never string interpolation
- Use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE` — never SELECT then INSERT

### D1 Sessions API (Read Replicas)
- Read-heavy handlers use `getDbContext(request)` from `src/lib/db.ts` to route to read replicas
- Cron/agent contexts use `getReadSession(env, ctx)` for read-only sessions
- **Write operations always use `env.DB` directly** — never write through a read session
- Attach bookmarks to responses via `attachBookmark(response, session)` for session continuity

### OLAP Cubes — query cubes, not raw threats
- **threat_cube_geo** — geographic aggregates by hour (country, threat_type, severity, source_feed)
- **threat_cube_provider** — provider aggregates by hour (hosting_provider_id, threat_type, severity, source_feed)
- **threat_cube_brand** — brand aggregates by hour (target_brand_id, threat_type, severity, source_feed)
- **threat_cube_status** — status aggregates by hour (threat_type, severity, source_feed, status)
- **threat_cube_arcs** — country × brand arc corridors by hour (country_code, target_brand_id, threat_type, severity, source_feed) with source_lat/source_lng centroid + first_seen/last_seen aggregates. Powers `/api/observatory/arcs` + `/api/observatory/brand-arcs`. Added in PR-Z.
- For aggregate counts (by country, provider, brand, severity, type) **always query cubes instead of raw threats table**
- Cubes are rebuilt every 5 min (current + prev hour) by Navigator, and full 30-day rebuild every 6 hours by cube-healer
- Cube builder: `src/lib/cube-builder.ts` — `buildGeoCubeForHour()`, `buildProviderCubeForHour()`, `buildBrandCubeForHour()`, `buildStatusCubeForHour()`, `buildArcsCubeForHour()`

### Pre-computed columns — use them, don't re-derive
- `brands.threat_count`, `brands.last_threat_seen` — use instead of `COUNT(*) FROM threats WHERE target_brand_id = ?`
- `hosting_providers.active_threat_count`, `hosting_providers.total_threat_count` — use instead of JOIN to threats
- `hosting_providers.trend_7d`, `hosting_providers.trend_30d` — use instead of 14-day window GROUP BY

Phase 2 of the D1 spend-reduction track migrated the providers list
(`handleListProviders`, `handleWorstProviders`, `handleImprovingProviders`)
and the dashboard `top-brands` query to read from these pre-computed
columns + cubes. Direct `GROUP BY hosting_provider_id` or `GROUP BY
target_brand_id` over the threats table is a code-review red flag —
swap to the pre-computed column or the matching cube.

### Alert auto-triage (`lib/alert-triage.ts`)

`createAlert` dispatches to one of three decision rules based on
the new alert's source/type:

1. **Threat-sourced** (`source_type='threat'`, Tier 1) —
   `decideThreatAutoTriage` reads the underlying threat's
   enrichment snapshot. Dismisses when VT was consulted with zero
   malicious detections, GSB consulted with no flag, GreyNoise
   either benign or not consulted, and SecLookup risk score either
   null or below 30.

2. **Social impersonation** (`alert_type='social_impersonation'`,
   Tier 1.5) — `decideSocialImpersonationTriage` checks two
   independent gates. Dismisses when the alerted handle matches
   the brand's `official_handles` for the same platform (rule B,
   always-safe), OR when `details.score < 0.5` (rule A,
   low-confidence noise). Either gate is sufficient.

3. **App-store impersonation** (`alert_type='app_store_impersonation'`,
   Tier 1.5) — `decideAppStoreImpersonationTriage` mirrors social
   for the app-store world. Dismisses when bundle_id, app_id,
   developer_id, or developer_name matches the brand's
   `official_apps` for the store (rule B), OR when
   `details.impersonation_score < 0.5` (rule A).

The `0.5` threshold is the platform default — tunable per call via
the `impersonationThreshold` parameter on `runAlertTriageBackfill`.
All decision functions are pure and unit-tested under
`test/alert-triage.test.ts`.

Operators run `POST /api/admin/alerts/backfill-triage?limit=500` to
sweep existing 'new' alerts; the endpoint is idempotent and can be
called repeatedly until `scanned < limit`. Each response includes
a `by_type` breakdown showing dismissed/kept counts per
alert_type. Every dismissal stamps the rule reason into
`resolution_notes` so the action is auditable and reversible.

To add a new alert family's rule, write a new `decide…Triage`
function alongside the existing three, add a case to
`runAlertTriageBackfill`'s dispatch switch and to `createAlert`'s
real-time hook. Don't add a second classifier elsewhere; the
rules should stay in one place.

### Alert AI judge (`lib/alert-ai-judge.ts`) — Tier 3

For alerts that survive rule-based triage (the residual queue
after Tier 1 + 1.5 + 1.6), `runAlertJudgeBackfill` calls Haiku
once per alert with the alert + brand context. The model returns
`{ verdict: 'active_threat' | 'likely_safe' | 'needs_human',
confidence: 0-100, reasoning: string }` which gets stamped into
`alerts.ai_assessment`.

Auto-dismiss only fires on `verdict='likely_safe' AND
confidence >= AUTO_DISMISS_CONFIDENCE_FLOOR` (currently 90).
Lower-confidence likely_safes and any other verdict leave the
alert in 'new' for human review with the AI note attached.

Operators run `POST /api/admin/alerts/run-ai-judge?limit=50` to
process residual alerts in batches. Bounded at 200/call. Cost
is ~$0.001/alert via Haiku. Idempotent — alerts with
`ai_assessment` already set are skipped.

The judge does NOT run automatically on alert creation. It's
explicitly a backfill / on-demand tool because rule-based
triage is the cheap path and AI cost is real. If demand grows,
wire `judgeAlertWithAI` into `createAlert`'s post-rule path
behind a feature flag.

### KV Cache on page-load endpoints
- Check `env.CACHE.get(cacheKey)` before querying D1 on any page-load GET endpoint
- Store results with `env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: 300 })` — 5-min TTL standard
- Navigator pre-warms 24 endpoints every 5 min across 3 phases:
  - **A**: Observatory (7d/24h/30d nodes, arcs, stats + live + operations)
  - **B**: Dashboard overview + top-brands, Agents, Operations list + stats
  - **C**: Brands list + stats, Threat Actors list + stats, Breaches, ATO, Email Auth, Cloud Incidents
- Cache keys must encode all query parameters for correctness
- Default page loads (no search/filter, page 1) use reduced-dimension cache keys for higher hit rate
- Use read replicas (`getReadSession`) for all read-heavy list/stats handlers
- Parallelize list + stats queries in the same handler via `Promise.all()`

### Counter cache for COUNT(*) queries — use `cachedCount`, never raw SELECT
Bare `SELECT COUNT(*) FROM threats` (and similar single-integer aggregates)
must go through `lib/cached-count.ts` instead of hitting D1 directly.
Each cache hit shaves a full-table scan off the threats table without
consuming a D1 read.

```typescript
import { cachedCount } from '@/lib/cached-count';

const total = await cachedCount(env, 'count.threats.total', 60,
  () => env.DB.prepare('SELECT COUNT(*) AS n FROM threats')
    .first<{ n: number }>().then(r => r?.n ?? 0));
```

Rules:
- Key namespace: prefix with `count.` so the kill-switch convention is
  uniform (`count.threats.*`, `count.alerts.*`, etc.).
- TTL: 60-300s for fast-changing tables (threats, alerts), up to 3600s
  for slow-changing references (brands, providers, feed_configs).
- Pass `0` as TTL to bypass cache entirely — useful kill-switch without
  a code change. The helper still calls `compute()` and emits a
  `bypass` stat so we can audit the override after the fact.
- Hit/miss rate is surfaced under `cached_count` in
  `/api/internal/platform-diagnostics`. After deploy, hit_rate >70% is
  the steady-state expectation; under that, TTLs are too short.
- Direct `SELECT COUNT(*) FROM threats` is a code-review red flag in
  any path called >1× per TTL window. Sites called *less often than
  their natural TTL* (e.g. hourly-or-less inside the orchestrator
  cron) skip cachedCount intentionally — the cache would never hit,
  and the wrapper adds a KV read on top of the same D1 read. For
  high-frequency callers (Navigator's 5-min tick, page-load handlers,
  diagnostics, FC's per-tick reads): wrap. For once-per-hour or
  once-per-day cron paths: bare is fine.
  Either swap to `cachedCount` or use a cube/pre-computed column when
  the dimension exists (see "OLAP Cubes" and "Pre-computed columns"
  above).
- The legacy `getOrComputeMetric` helper in `lib/system-metrics.ts`
  used a D1-backed cache (`system_metrics` table) — every cache lookup
  spent a D1 read on the freshness check. New code should use
  `cachedCount` instead; it stores in KV so cache lookups are free.

For structured results (arrays of rows, multi-column aggregates,
nested objects), use `cachedValue<T>` from `lib/cached-value.ts` —
same TTL/fallthrough/observability semantics as `cachedCount` but
the cached value can be any JSON-serializable shape:

```typescript
import { cachedValue } from '@/lib/cached-value';

const series = await cachedValue<Array<{ day: string; count: number }>>(
  env, 'agents.daily_runs', 300,
  async () => {
    const r = await env.DB.prepare('...').all<{ day: string; count: number }>();
    return r.results;
  });
```

Hit/miss for both helpers feeds the same `cached_count.hit_rate` ring
in `/api/internal/platform-diagnostics`.

### Key tables:
```
brands                    ← Brand registry (9,652+ brands)
brand_profiles            ← User-created brand profiles
threats                   ← Core threat intelligence (113K+ rows)
threat_cube_geo           ← OLAP cube: hourly geo aggregates
threat_cube_provider      ← OLAP cube: hourly provider aggregates
threat_cube_brand         ← OLAP cube: hourly brand aggregates
threat_cube_arcs          ← OLAP cube: hourly country × brand arc corridors (PR-Z)
hosting_providers         ← Provider registry with pre-computed threat counts
provider_threat_stats     ← Per-period (today/7d/30d/all) provider rollups written by Cartographer
lookalike_domains         ← Typosquat scanner results
alerts                    ← Platform alerts
agent_runs                ← Agent execution log
agent_events              ← Inter-agent event queue
agent_outputs             ← AI-generated insights
campaigns                 ← Threat campaign groupings
infrastructure_clusters   ← NEXUS operation clusters
organizations             ← Multi-tenant org layer
org_members               ← Org membership + roles
```

### Side-DB tables:
```
DNS_QUEUE_DB (trust-radar-dns-queue):
  dns_queue               ← Drainable "needs DNS resolution" set (~17K rows).
                            Populated by lib/dns-queue-reconciler.ts (PR-BI
                            cursor-paginated incremental enqueue, KV cursor at
                            `reconciler:dns_queue:cursor`). Drained by
                            lib/dns-backfill.ts in the Navigator cron. Stale
                            rows (threat flipped inactive after enqueue) are
                            swept once per day at hour===0 by
                            lib/dns-queue-reaper.ts. Reads come from this DB;
                            ip_address writes go back to threats.

GEOIP_DB (geoip-db):
  geo_ip_ranges           ← MaxMind GeoLite2-City ranges (~3.76M rows). Queried by
                            Cartographer Phase 0.5. Loaded by the GeoipRefresh
                            workflow as an in-place DIFF (writes only changed/new/
                            deleted rows, matched via geo_ip_ranges.row_hash) on the
                            weekly refresh, with a ~quarterly full shadow rebuild for
                            GC (geo_ip_refresh_log.mode = 'diff' | 'full' | 'no-op').
                            Diff replaced the per-release full 3.76M-row rebuild that
                            was 61% of all account D1 writes — see lib/geoip-import.ts
                            (runGeoipDiffImport) + workflows/geoipRefresh.ts.
  geo_ip_refresh_log      ← Per-import audit + workflow self-heal log (FC reads
                            for stuck-workflow detection). `mode` records which
                            strategy each refresh used; `rows_deleted` tracks diff
                            deletions.
```

---

## 9. PR and Merge Workflow

```bash
# After every session:
cd packages/averrow-ops && npx tsc --noEmit
git add -A
git commit -m "type(scope): description"
git push origin HEAD
```

Commit format:
```
feat(scope):      new feature
fix(scope):       bug fix
refactor(scope):  cleanup, no behavior change
docs(scope):      documentation only
chore(scope):     build, deps, config
```

Examples:
```
feat(brands): add favicon support to DimensionalAvatar
fix(sidebar): exact active state matching on all NavLinks
refactor(restructure-r2): rebuild Card + Button + Badge to CSS vars
docs(claude): update standing instructions for restructure
```

---

## 10. Platform Diagnostics (Live Health Checks)

Claude Code can assess live platform health by calling the diagnostics endpoint.
This replaces manual D1 queries and gives full visibility into feeds, agents,
enrichment pipeline, and AI spend.

### How to run

```bash
# Requires AVERROW_INTERNAL_SECRET in environment
./scripts/platform-diagnostics.sh        # default 6-hour window
./scripts/platform-diagnostics.sh 24     # 24-hour window
```

### What it returns

The endpoint `GET /api/internal/platform-diagnostics?hours=N` returns:

| Section | Key metrics |
|---|---|
| `enrichment_pipeline` | `stuck_pile` (enriched but no geo), `cartographer_queue` (Phase 0 backlog, private IPs excluded), `cartographer_queue_raw` (unfiltered, for comparison), `private_ip_inflation`, `enriched_last_hour`, `enriched_last_24h`, `needs_dns`, `total_enriched`, `total_threats`, `active_threats` |
| `feeds.per_feed[]` | Per-feed: `pulls`, `success`, `partial`, `failed`, `failure_rate_pct`, `records_ingested`, `last_success_at`, `last_failure_at`, `enabled`, `paused_reason` |
| `feeds.at_risk[]` | Feeds approaching auto-pause threshold (>=60% of consecutive failure limit). Shows `pct_to_auto_pause`. |
| `feeds.recent_errors[]` | Last 20 failed pull error messages with timestamps |
| `agent_mesh.per_agent[]` | Per-agent: `total_runs`, `success`, `partial`, `failed`, `running`, `last_completed_at`, `last_error`, `total_records_processed`, `avg_duration_ms`, `dispatch_source` (`agent_runs` or `workflow`), `cooldown_skipped` (workflow-only), `legacy_inline` (only when an agent has BOTH workflow runs AND historical `agent_runs` rows — e.g. nexus pre-PR-D inline-recovery rows). Workflow-dispatched agents (currently just nexus) read from `agent_activity_log` event types `workflow_dispatched` / `batch_complete` / `workflow_dispatch_failed` / `workflow_cooldown_skip` rather than `agent_runs`. |
| `agent_mesh.stalled[]` | Runs stuck in 'running' state >15 minutes |
| `cron_health[]` | `navigator` (+ historical `fast_tick`), `flight_control`, `orchestrator` run counts + success rate |
| `backlog_trends` | Per-pipeline: `current`, `previous`, `trend` (negative = draining) |
| `ai_spend_24h` | Per-agent: `calls`, `input_tokens`, `output_tokens`, `cost_usd` |
| `platform_totals` | `brands`, `providers`, `campaigns`, `clusters`, `feeds_enabled`, `feeds_disabled` |
| `_meta` | `db_clock_utc` (verify timezone), `window_hours`, `generated_at` |

### When the user asks for a health check

If the user says **"run diagnostics"**, **"check platform health"**, **"how's the platform"**,
or **"assess the platform"**:

1. Run `./scripts/platform-diagnostics.sh` (or `./scripts/platform-diagnostics.sh 24` for a wider window)
2. Parse the JSON response
3. Report findings organized by priority:
   - **Critical:** stuck_pile > 0, feeds at_risk with pct_to_auto_pause >= 80%, stalled agents, failed cron
   - **Warning:** feeds with failure_rate > 50%, enriched_last_hour < 20, cartographer_queue growing
   - **Healthy:** everything else — summarize briefly
4. If enriched_last_hour looks suspiciously low, note it may be mid-cycle and suggest re-checking in 15 min
5. Compare `cartographer_queue` vs `cartographer_queue_raw` to flag private IP inflation

### Auth setup

The script requires `AVERROW_INTERNAL_SECRET` in the environment. This is the same
secret used by `/api/internal/agents/:name/run` and other internal endpoints. Set it:

```bash
export AVERROW_INTERNAL_SECRET="<from Cloudflare Worker secrets>"
```

The endpoint is also available at `/api/admin/platform-diagnostics` with super_admin JWT auth
for browser access.

---

## 11. What NOT to Build Without Explicit Instruction

- New npm packages without checking if existing ones cover the need
- New API endpoints for data derivable client-side
- Loading skeletons on views that already have them
- Refactoring working code during a bug fix session — one thing at a time
- Anything in `public/`, `app.js`, `styles.css` — frozen forever
- Old design tokens (`glass-card`, `bg-cockpit`, `text-parchment`) in new files
- Duplicate utility functions — check `src/lib/` first
- `console.log` in production — use `agent_runs` error logging

---

## 12. Session Checklist (Before Marking Complete)

- [ ] `npx tsc --noEmit` passes in `packages/averrow-ops`
- [ ] No old SPA files touched (`public/`, `app.js`, `styles.css`)
- [ ] New API endpoints added to `docs/API_REFERENCE.md`
- [ ] New agent logic follows `agent_runs` + `agent_events` pattern
- [ ] `RESTRUCTURE_SPEC.md` updated if architecture decisions were made
- [ ] Commit message follows `type(scope): description` format
- [ ] Pushed to feature branch (not master directly)
- [ ] When docs reference files, verified the files exist at the stated path
- [ ] When a task assumes current-state behavior, verified it in code (grep for the function, check cron schedule against wrangler.toml, confirm the agent actually runs)

---

## 13. Platform Context

Averrow is a **threat actor intelligence platform** — not just brand protection.

The goal: identify WHO is conducting attacks, HOW they operate, WHERE they move
infrastructure, and get ahead of them. Threats are evidence. Patterns are the product.

**Customer ROI:**
- Replaces 2–3 security analyst headcount
- Protects brand equity (irreplaceable once damaged)
- Protects customers (the real victims of impersonation attacks)
- Quantifiable: analyst-hours replaced, takedowns completed, exposure prevented

**The rule:** SQL does correlation. AI does narrative.
Never pay AI tokens to do what `GROUP BY` can do in 50ms.

**Pricing:** Free | Professional $1,499/mo | Business $3,999/mo | Enterprise
**Positioning:** Global (not Canada-first). Straight threat-intelligence + brand-protection messaging — **no aviation/military framing** in customer-facing copy (the Avro Arrow heritage narrative was removed from About in Jun 2026; agent role labels are reframed by function). The "Averrow" name is retained as the legal brand; its aviation derivation is no longer narrated. Internal agent code names (Sentinel/ASTRA/Observer/Navigator/Blackbox/Pathfinder) are unchanged.
**Parent company:** LRX Enterprises Inc. (Canadian-incorporated)
**Domains:** averrow.com (primary), averrow.ca (Canadian market)
