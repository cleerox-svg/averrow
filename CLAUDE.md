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
└── AVERROW_MASTER_PLAN.md        ← Platform vision + roadmap
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

---

## 6. Agent Architecture Rules

### Every agent must:
1. Log a row to `agent_runs` at start
2. Update `agent_runs` on completion with `completed_at` and `records_processed`
3. Emit to `agent_events` after completion
4. Handle errors — catch all exceptions, log to `agent_runs.error_message`

### Agent trigger chain:
```
Sentinel      → [feed_pulled]        → Cartographer
Cartographer  → [threats_enriched]   → Nexus
Nexus         → [cluster_detected]   → Analyst + Observer (high severity)
Nexus         → [pivot_detected]     → Observer (immediate)
Analyst       → [scores_updated]     → Pathfinder (new high-value leads)
```

### AI usage rules:
- **Haiku:** classification, scoring, short summaries — high volume
- **Sonnet:** threat actor narratives, cluster briefs — sparingly
- **NEVER** use AI for what SQL `GROUP BY` can do in 50ms
- All AI calls go through Cloudflare AI Gateway

### Cron schedule (wrangler.toml):
```
navigator:    */5 * * * *    (every 5 min — DNS resolution, cube refresh, cache warming of 24 endpoints)
                              (independent agent; FC monitors health but does not dispatch;
                               historical agent_runs rows use agent_id='fast_tick')
orchestrator: 7 * * * *     (hourly at :07 — feeds, agent dispatch, Workflows)
cube-healer:  12 */6 * * *  (every 6 hours at :12 — 30-day bulk cube rebuild)
auto-seeder:  (no dedicated cron — gated inside the hourly orchestrator
               on Sundays at hour===5, runs at 05:07 UTC. CF rejects
               the 5-field cron `23 5 * * 0` with code 10100, so this
               is dispatched from the existing hourly cron path.)
```

### Agent dispatch (inside orchestrator hourly tick):
All agents below are dispatched from `runThreatFeedScan()` inside the orchestrator.
Time gates use `event.scheduledTime` hour-only — **no minute gates** (see cron-audit rule below).

```
Always (every tick):  Flight Control, Incident recovery sweep, CertStream health, Enricher, agent_events consumer
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
- **Workflow dispatch:** Cartographer and NEXUS run as Cloudflare Workflows (durable, no CPU ceiling)
- **ctx.waitUntil:** Analyst, Strategist, Sparrow run in parallel without blocking the cron mesh
- **Inline await:** Observer, Pathfinder run sequentially (quiet times, fast execution)

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
client       level 1  — customer (lives at /tenant; never reaches /v2)
```

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
- `requireSales` / `requireSupport` / `requireBilling` — specialty
  sub-role guards (super_admin + admin always satisfy any sub-role
  guard since they grant everything)

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
- For aggregate counts (by country, provider, brand, severity, type) **always query cubes instead of raw threats table**
- Cubes are rebuilt every 5 min (current + prev hour) by Navigator, and full 30-day rebuild every 6 hours by cube-healer
- Cube builder: `src/lib/cube-builder.ts` — `buildGeoCubeForHour()`, `buildProviderCubeForHour()`, `buildBrandCubeForHour()`

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
- Direct `SELECT COUNT(*) FROM threats` is a code-review red flag.
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
hosting_providers         ← Provider registry with pre-computed threat counts
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
| `agent_mesh.per_agent[]` | Per-agent: `total_runs`, `success`, `partial`, `failed`, `running`, `last_completed_at`, `last_error`, `total_records_processed`, `avg_duration_ms` |
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
**Positioning:** Global (not Canada-first). Avro Arrow heritage on About page only.
**Parent company:** LRX Enterprises Inc. (Canadian-incorporated)
**Domains:** averrow.com (primary), averrow.ca (Canadian market)
