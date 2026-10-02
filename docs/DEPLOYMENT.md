# Deployment

Averrow deploys to Cloudflare Workers via GitHub Actions on push to `master`.

## Architecture

```
GitHub Actions (CI/CD)
├── deploy-radar.yml    → Cloudflare Workers (averrow)
└── ci.yml              → TypeCheck averrow Worker
```

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [pnpm](https://pnpm.io/) (workspace manager)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account with Workers, D1, and KV access

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description | Required |
|----------|-------------|----------|
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy token | Yes |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | Yes |
| `JWT_SECRET` | JWT signing secret | Yes |
| `ANTHROPIC_API_KEY` | Claude Haiku API key | Yes |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Yes |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Yes |

See `packages/averrow-worker/wrangler.toml` for Worker bindings (D1, KV, R2).

`AI_MODE` is a Worker `[vars]` entry (not a secret) in `wrangler.toml`, set to `"rules_only"` for production, `[env.staging]` and `[env.dev]`. `rules_only` makes every Anthropic call a deliberate skip (no request leaves the Worker); `enabled`, or unset, lets calls proceed. See `CLAUDE.md` §6 "AI-call health". `ANTHROPIC_API_KEY` is therefore not exercised while `rules_only` is set. The platform-alert email uses the existing `RESEND_API_KEY` / `BRIEFING_RECIPIENT`.

## Local Development

```bash
pnpm install
pnpm dev                    # Start all workers locally (Miniflare)
pnpm typecheck              # Type check all packages
```

Local dev uses Miniflare (Wrangler's local runtime) with local D1 SQLite databases.

## Database Migrations

Migrations are SQL files in `packages/averrow-worker/migrations/`:

```bash
# Run locally
npx wrangler d1 execute trust-radar-v2 --local --file=migrations/0030_social_monitoring.sql

# Run in production
npx wrangler d1 execute trust-radar-v2 --file=migrations/0030_social_monitoring.sql

# Also run audit DB migrations when applicable
npx wrangler d1 execute trust-radar-v2-audit --file=migrations/XXXX_audit.sql
```

Migrations are also run automatically by the deploy workflow.

### Migration 0272 must land before (or with) the Worker that emits `platform_ai_calls_failing`

`0272_notifications_add_ai_calls_failing.sql` rebuilds `notifications` to add `platform_ai_calls_failing` to the hand-maintained `type` CHECK (and restores `idx_notifications_dedup`). Worker code deployed against the pre-0272 schema fails **silently**: the key passes `createNotification`'s registry guard, the INSERT is rejected by the CHECK, Flight Control's try/catch swallows it, zero rows land, and the only trace is `console.warn('[flight-control] AI call-failure check failed:', …)`. The alert for the silent AI outage would itself fail silently — the exact failure it exists to prevent (traced in code: `createNotification`'s INSERT is unwrapped, and the only catch is Flight Control's).

- **CI path is safe by ordering.** `deploy-radar.yml` runs `db:migrate:prod` before `pnpm run deploy`, and a failed migration step stops the job before the deploy step.
- **The manual path is not.** `npx wrangler deploy` (see "Manual Deploy") runs no migrations. Apply first: `pnpm run db:migrate:prod` from `packages/averrow-worker`.
- **Verify before trusting the alert:** `pnpm run db:migrate:status:prod` should list 0272 as applied, and `SELECT sql FROM sqlite_master WHERE name = 'notifications'` should contain `platform_ai_calls_failing`. `test/notification-check-drift.test.ts` only proves the migration *file* covers the registry, not that production applied it.
- 0272 is a table swap (create / copy / drop / rename) with a `notification_deliveries` snapshot-and-restore around the `DROP` — an earlier swap (0215) lost delivery rows to the `ON DELETE CASCADE`. Apply it in a normal migration run, not piecemeal by hand.
- The same rule applies to any future notification key: registry change and CHECK-widening migration ship together (see `docs/PLATFORM_DATA_DEPENDENCIES.md` §3).

### First deploy of AI_STRATEGY Phase 0/1 — expected one-time effects

Phase 0/1 itself needs no migration (the abuse-mailbox change shipped alongside it needs 0273 — see the next section). Expect, once, after the first deploy:

- **Up to ~90 lookalike `HIGH` alerts.** The lookalike scanner's one-time catch-up re-composites mail+web rows that a retired Haiku verdict held below HIGH (prod sizing: 84 LOW + 6 MEDIUM; rows with `status` `benign`/`taken_down` are excluded). They alert as they are re-checked, then the predicate goes false. This is not a regression.
- **Up to ~50 provider insight rows from Cartographer.** `hosting_providers.last_score` still holds the old Haiku scores; the first rule-based score moves past the emit threshold for providers whose heuristic differs, then converges.
- **Possibly one spurious `platform_ai_calls_failing` notification and email.** Pre-deploy `agent_outputs` rows carry `aiCallsAttempted > 0` with 0 successes inside the 2h window; Flight Control may fire once before they age out. Under `rules_only` no new attempts are recorded, so it does not recur. It is escalated by email at most once per UTC day.
- **Service worker update.** `packages/averrow-ops/public/sw.js` `VERSION` is `2026-10-02.1`; old shell/runtime caches are evicted on activate. Bump `VERSION` on any further `sw.js` change.

### Migration 0273 + the `ABUSE_MAILBOX_TRIAGE` Workflow binding (abuse-mailbox rules determinations)

- `0273_abuse_inbox_responder_suppressed.sql` adds `abuse_inbox_messages.responder_suppressed_reason`. Apply it **before** the Worker: the determination claim (`lib/abuse-mailbox-determination.ts`) filters on it and fails closed (no determination email) until it exists. Ingest is unaffected — the backscatter stamp is a separate, caught UPDATE.
- `wrangler.toml` adds `[[workflows]] abuse-mailbox-triage` → `ABUSE_MAILBOX_TRIAGE` / `AbuseMailboxTriageWorkflow` (exported from `src/index.ts`). `wrangler deploy` creates it; no manual provisioning. The binding is optional in `Env` — staging/dev (no `[[workflows]]` there) and any deploy without it fall back to the hourly `17 * * * *` sweeper.
- Verify after deploy: forward a test report; within ~2 min `abuse_inbox_messages.classified_by = 'rules'` and `determination_sent_at` is set; `npx wrangler workflows instances list abuse-mailbox-triage` shows the `abuse-<messageId>` instance.

## Manual Deploy

```bash
cd packages/averrow-worker
npx wrangler deploy          # Deploy to production
npx wrangler deploy --env staging  # Deploy to staging
```

## CI/CD Pipeline

### ci.yml (on every PR and push to master)
1. TypeCheck averrow Worker

> **Note:** The `deploy-api.yml` workflow (FastAPI/Railway) has been removed — all compute runs on Cloudflare Workers.

### deploy-radar.yml (on push to master, paths: `packages/averrow-worker/**`)
1. Type check
2. Run D1 migrations (both DB and AUDIT_DB)
3. Deploy via `wrangler deploy`

### Cron Triggers

Configured in `wrangler.toml`:
```toml
[triggers]
crons = ["7 * * * *", "*/5 * * * *", "12 */6 * * *"]
```

Three cron schedules (staggered to avoid D1 writer collisions at `:00`):

| Schedule | Handler | Purpose |
|----------|---------|---------|
| `*/5 * * * *` | navigator | DNS resolution, OLAP cube refresh (current + prev hour), KV cache pre-warming |
| `7 * * * *` | orchestrator | Hourly mesh — feed scans, agent dispatch, Workflow dispatch |
| `12 */6 * * *` | cube-healer | 30-day bulk cube rebuild (drift remediation) |

The orchestrator (`src/cron/orchestrator.ts`) routes jobs using hour-only gates on `event.scheduledTime.getUTCHours()` (no minute gates — see `CLAUDE.md §6`):

| Cadence | Jobs |
|---------|------|
| Every hourly tick | Flight Control, CertStream ping, agent_events consumer, feed ingest, Enricher, Cartographer Workflow, Analyst (`waitUntil`), CT monitor, lookalike check, email security scan |
| Event-dispatched | Sentinel (when `totalNew > 0`), Watchdog (when new social mentions land) |
| Every 4 hours (0/4/8/12/16/20) | NEXUS Workflow |
| Every 6 hours (0/6/12/18) | Strategist, Sparrow, Social discovery, Social monitor, Sentinel social assessment |
| Hour 0 | Observer, daily brand assessments, daily snapshots |
| Hour 3 | Pathfinder (KV throttle to 7 days) |
| Hour 6 | Observer briefing (Tranco import + Seed Strategist), Narrator threat narratives |
| Hour 13 | Daily briefing email |

### Cloudflare Workflows

Heavy agents run as durable Workflows (not inline in cron):
- `CartographerBackfillWorkflow` — enrichment with retry/checkpointing
- `NexusWorkflow` — clustering with durable execution

Configured in `wrangler.toml` under `[[workflows]]`.

## KV Namespaces

| Binding | Purpose |
|---------|---------|
| `CACHE` | Rate limiting, scan result caching, cron status, page-load endpoint caching (300s TTL, pre-warmed by Navigator) |
| `SESSIONS` | Session storage |

## D1 Databases

| Binding | Purpose |
|---------|---------|
| `DB` | Primary database (users, brands, threats, scans) |
| `AUDIT_DB` | Audit log (data mutations) |

Read-heavy endpoints use the D1 Sessions API to route queries to read replicas. The implementation is in `src/lib/db.ts`. Write operations always use the primary `env.DB` handle.

## Domains

| Domain | Environment |
|--------|-------------|
| `averrow.com` | Production (primary) |
| `averrow.ca` | Canadian market (301 → averrow.com) |
| `trustradar.ca` | Legacy domain (301 → averrow.com) |
| `staging.averrow.com` | Staging |
| `staging.trustradar.ca` | Staging (legacy, 301 → staging.averrow.com) |

## Rollback

Cloudflare Workers supports instant rollback via the dashboard or:
```bash
npx wrangler rollback
```
