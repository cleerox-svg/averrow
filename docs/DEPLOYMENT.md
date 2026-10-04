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

# Audit DB (trust-radar-v2-audit) has its own tracked migrations in
# packages/averrow-worker/migrations-audit/ (binding AUDIT_DB)
cd packages/averrow-worker
pnpm run db:migrate:audit:prod      # = wrangler d1 migrations apply AUDIT_DB --remote
```

Migrations are also run automatically by the deploy workflow (production only — `deploy-radar.yml` runs `db:migrate:prod` and `db:migrate:audit:prod`; staging and dev are applied by hand with `--env staging` / `--env dev`).

### Audit migration 0002 — redact webhook URLs in historic audit rows

`migrations-audit/0002_redact_webhook_urls.sql` rewrites `details.webhook_url` on `webhook_config_updated` rows written before PR #1749, which stored the full org webhook URL (Slack / Teams / Discord URLs embed their credential, and `view_audit` roles can read and CSV-export `audit_log`). The value becomes the `redactWebhookUrl()` form (`https://…slack.com/…`); anything the SQL can't parse strictly (non-http(s) schemes, non-numeric ports, odd IP literals, IDN/punycode, %-escapes) becomes `[redacted]`. Each rewritten row gains `webhook_url_redacted_by` and `webhook_url_original_length`, and the run is recorded as one `audit_redaction_applied` row with `rows_redacted`. Idempotent. Rows written after #1749 are left untouched and unstamped, except TS outputs for a trailing-dot host (`https://…com./…`) or a punycode host, which are re-redacted to `[redacted]` and stamped. The SQL header comment documents the exact rule and its parity with the TS helper.

- **Production:** applied by `deploy-radar.yml` on merge. Manual:
  ```bash
  cd packages/averrow-worker
  npx wrangler d1 migrations apply AUDIT_DB --remote
  ```
- **Staging / dev** (`trust-radar-v2-audit-staging` / `-dev`, not covered by CI), from `packages/averrow-worker`: `npx wrangler d1 migrations apply AUDIT_DB --remote --env staging` and `... --env dev`.
- **Verify** (from `packages/averrow-worker`): `npx wrangler d1 execute AUDIT_DB --remote --command "SELECT details FROM audit_log WHERE action = 'audit_redaction_applied'"` shows the count, and this must return 0:
  ```sql
  SELECT count(*) FROM audit_log
   WHERE action = 'webhook_config_updated'
     AND json_valid(details)
     AND json_extract(details,'$.webhook_url') NOT IN ('', '[redacted]')
     AND json_extract(details,'$.webhook_url') NOT LIKE '%/…';
  ```

#### Credential rotation and customer notification (owned action item, not optional)

The migration only removes the URLs from the audit log; it does not un-expose them. **Owner: platform owner.** Notifying the affected customers and getting both credentials rotated is a required action item.

- **The affected set is every org with a webhook configured**, not only orgs with audit rows. Before #1749 every `read_customers` role (analyst, sales, support, auditor, and the 30-day `auditor` MCP service-account token) could read every org's live `webhook_url` **and** `webhook_secret` from `/api/admin/organizations`. List them:
  ```sql
  -- main DB (trust-radar-v2): every org whose webhook credentials were readable
  SELECT id, name FROM organizations WHERE webhook_url IS NOT NULL;

  -- audit DB (trust-radar-v2-audit): orgs whose full URL was also in audit_log
  SELECT DISTINCT resource_id FROM audit_log
   WHERE action = 'webhook_config_updated'
     AND json_valid(details)
     AND json_extract(details,'$.webhook_url_redacted_by') = '0002_redact_webhook_urls';
  ```
- **Owners must rotate both credentials:** the provider-side webhook URL (regenerate it in Slack / Teams / Discord and save the new one), and the Averrow webhook signing secret via `POST /api/orgs/:orgId/webhook/regenerate-secret` (org owner only; returns the new secret once).
- **Exposure can't be narrowed after the fact.** Audit-log reads and CSV exports (`/api/admin/audit`, `/api/admin/audit/export`) are not themselves audited, so there is no record of who viewed these rows, and CSV / MCP copies may exist off-platform. D1 Time Travel also keeps the pre-migration state restorable for its retention window (30 days on paid plans). Treat every listed credential as compromised.

### Migration 0272 must land before (or with) the Worker that emits `platform_ai_calls_failing`

`0272_notifications_add_ai_calls_failing.sql` rebuilds `notifications` to add `platform_ai_calls_failing` to the hand-maintained `type` CHECK (and restores `idx_notifications_dedup`). Worker code deployed against the pre-0272 schema fails **silently**: the key passes `createNotification`'s registry guard, the INSERT is rejected by the CHECK, Flight Control's try/catch swallows it, zero rows land, and the only trace is `console.warn('[flight-control] AI call-failure check failed:', …)`. The alert for the silent AI outage would itself fail silently — the exact failure it exists to prevent (traced in code: `createNotification`'s INSERT is unwrapped, and the only catch is Flight Control's).

- **CI path is safe by ordering.** `deploy-radar.yml` runs `db:migrate:prod` before `pnpm run deploy`, and a failed migration step stops the job before the deploy step.
- **The manual path is not.** `npx wrangler deploy` (see "Manual Deploy") runs no migrations. Apply first: `pnpm run db:migrate:prod` from `packages/averrow-worker`.
- **Verify before trusting the alert:** `pnpm run db:migrate:status:prod` should list 0272 as applied, and `SELECT sql FROM sqlite_master WHERE name = 'notifications'` should contain `platform_ai_calls_failing`. `test/notification-check-drift.test.ts` only proves the migration *file* covers the registry, not that production applied it.
- 0272 is a table swap (create / copy / drop / rename) with a `notification_deliveries` snapshot-and-restore around the `DROP` — an earlier swap (0215) lost delivery rows to the `ON DELETE CASCADE`. Apply it in a normal migration run, not piecemeal by hand.
- The same rule applies to any future notification key: registry change and CHECK-widening migration ship together (see `docs/PLATFORM_DATA_DEPENDENCIES.md` §3).
- **0274** (`0274_notifications_add_abuse_mailbox_inbound_stale.sql`) is the same swap for `platform_abuse_mailbox_inbound_stale` (Flight Control's abuse-mailbox inbound freshness guard). Same ordering rule and same verification: the `notifications` schema must contain `platform_abuse_mailbox_inbound_stale`.

### Migration 0275 must land before the Worker with staff alert fields (PR-C)

- `0275_alert_staff_fields.sql` adds `alerts.staff_assigned_to`, `staff_assigned_at`, `staff_notes` (ADD COLUMN only) and the partial index `idx_takedown_requests_alert_source` (`takedown_requests(source_id) WHERE source_type = 'alert'`).
- Apply it **before** the Worker. The ops alert list/detail (`GET /api/alerts`, `/api/alerts/:id`) join `users` on `a.staff_assigned_to`, and `PATCH /api/alerts/:id` reads and writes the new columns. Against the pre-0275 schema those routes return 500. Tenant alert routes keep working either way.
- CI applies migrations before deploying. With a manual `npx wrangler deploy`, run `pnpm run db:migrate:prod` first.
- To verify, `PRAGMA table_info(alerts)` should list the three `staff_*` columns.
- No backfill needed: verified read-only against prod on 2026-10-04 — zero alerts have a staff user in `assigned_to` and zero alerts carry a manual (non-`auto:`) `resolution_notes`, so there is nothing to move into the staff columns. The tenant read path additionally masks any staff `assigned_to` as "Averrow SOC" (`resolveTenantUserLabels` / `toTenantAlertView`, `handlers/tenantData.ts`), so a future stray row still can't name a staff member to a customer.

### Migration 0276 must land before the Worker with takedown staff notes

- `0276_takedown_staff_notes.sql` adds `takedown_requests.staff_notes` (ADD COLUMN only). `notes` stays the customer's note (tenant routes only); `staff_notes` is the internal Averrow note written by the ops `PATCH /api/admin/takedowns/:id`.
- Apply it **before** the Worker. The ops PATCH writes `staff_notes` whenever the body carries `staff_notes` or the legacy `notes` alias; against the pre-0276 schema that save returns 500. Status-only ops PATCHes, the ops list, and all tenant takedown routes keep working either way (the tenant detail's `staff_*` strip is a no-op without the column).
- CI applies migrations before deploying. With a manual `npx wrangler deploy`, run `pnpm run db:migrate:prod` first.
- To verify, `PRAGMA table_info(takedown_requests)` should list `staff_notes`.
- No backfill needed: verified read-only against prod on 2026-10-04 — 4,062 `takedown_requests` rows, 0 with a non-empty `notes`, so no staff note sits in the customer column.
- **Post-deploy gate.** Between applying 0276 and the new Worker going live, the OLD Worker's ops PATCH still writes staff notes into `notes`, which the new tenant detail returns to the customer. Immediately after the Worker deploy, run (read-only) `SELECT id FROM takedown_requests WHERE notes IS NOT NULL AND notes <> ''`. For any rows, check the `audit_log` (`AUDIT_DB`) `admin_takedown_update` entries for those ids since 2026-10-04 to identify the staff-written ones, then move only those (manual, reviewed): `UPDATE takedown_requests SET staff_notes = notes, notes = NULL WHERE id IN (...)`. Customer-written notes (tenant `takedown_create` / `takedown_update`) stay put.

### Migration 0277 — `threats` read-spend indexes (applied before the Worker)

- `0277_threats_asn_gsb_indexes.sql` adds two partial indexes on `threats`: `idx_threats_asn` (`threats(asn) WHERE asn IS NOT NULL`, for the threat-actor ASN joins in `lib/threat-aggregates.ts`) and `idx_threats_gsb_pending` (`threats(first_seen DESC) WHERE gsb_checked = 0 AND (malicious_url IS NOT NULL OR malicious_domain IS NOT NULL)`, for the Google Safe Browsing work-queue SELECT and Flight Control's `backlog.gsb` count). `CREATE INDEX IF NOT EXISTS` only — no table or column changes.
- Applied automatically: CI runs `db:migrate:prod` before `pnpm run deploy`. With a manual `npx wrangler deploy`, run `pnpm run db:migrate:prod` first.
- Ordering is for cost, not correctness: the Worker's queries are valid with or without the indexes (without them they keep full-scanning `threats`, ~110M reads/24h between them). The `idx_threats_gsb_pending` predicate copies the two GSB queries' WHERE text exactly; SQLite only uses a partial index when the query's WHERE implies it, so a reworded GSB query silently falls back to a scan. `test/d1-read-spend-2026-10.test.ts` pins both plans.
- One-time build cost: one pass over `threats` per index (~1.25M rows read each, ~2.5M total), paid back within the first hour.
- To verify, `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_threats_asn', 'idx_threats_gsb_pending')` returns both rows.

### Migration 0278 — `idx_threats_malicious_url` (D1 read-spend)

- `0278_threats_malicious_url_index.sql` adds the partial index `idx_threats_malicious_url` (`threats(malicious_url) WHERE malicious_url IS NOT NULL`). It is index-only: no columns change.
- **Applied automatically before the Worker.** CI (`deploy-radar.yml`) runs `db:migrate:prod` before `pnpm run deploy`. With a manual `npx wrangler deploy`, run `pnpm run db:migrate:prod` first. The Worker has no hard dependency on it: without the index, the abuse-mailbox exact-URL correlation (`lib/abuse-mailbox-iocs.ts` `correlateUrls`) still returns the same rows, it just full-scans `threats` (~10M rows read/day), as it did before.
- **One-time cost.** Building the index reads `threats` once (~1.25M rows) and writes one index entry per URL-bearing row. Storage estimate ≤ ~150 MB at the upper bound (see the migration header). After that, each threat INSERT with a non-NULL `malicious_url` writes one extra index row.
- **Verify:** `SELECT sql FROM sqlite_master WHERE name = 'idx_threats_malicious_url'` returns the definition. `EXPLAIN QUERY PLAN SELECT id FROM threats WHERE malicious_url = 'x' LIMIT 1` should show `SEARCH threats USING INDEX idx_threats_malicious_url`. The same plan is pinned on the migration-derived schema by `test/threats-malicious-url-index.test.ts`.

### `hosting_providers.is_bulletproof` — prod-only column now defined in 0078 (fresh-bootstrap fix)

- `GET /api/providers/v2` (`handlers/providers.ts`) selects `hp.is_bulletproof`. Prod gained the column out of band (`INTEGER`, nullable, `DEFAULT 0`), and no migration defined it, so any DB built from `migrations/` (staging, dev, the derived-schema test harness) returned 500 on that route.
- **Fix:** `0078_cartographer_score_recency.sql` now ends with `ALTER TABLE hosting_providers ADD COLUMN is_bulletproof INTEGER DEFAULT 0`. This is the same fresh-bootstrap pattern as 0053. A new migration was not an option: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a plain ALTER fails prod with "duplicate column name", and a no-op new migration (the 0010/0161 pattern) would leave migration-built DBs without the column.
- **Production:** no action needed. 0078 was applied on 2026-04-10, and D1 tracks migrations by filename, so the edit never runs there. Verified read-only on 2026-10-04: the column is present and `d1_migrations` is at `0275`.
- **Staging / dev** (`trust-radar-v2-staging` / `-dev`): no action needed. Both were verified read-only on 2026-10-04 as empty, with no `d1_migrations` table, so their first `npx wrangler d1 migrations apply DB --remote --env staging` (or `--env dev`) creates the column through 0078.
- **Any DB that applied 0078 before this edit** (for example an old `--local` dev DB): add the column by hand, once, from `packages/averrow-worker`. For a local DB use `npx wrangler d1 execute DB --local --command "ALTER TABLE hosting_providers ADD COLUMN is_bulletproof INTEGER DEFAULT 0"`. Never run this against prod, where it fails with a duplicate-column error.
- **Verify:** `PRAGMA table_info(hosting_providers)` lists `is_bulletproof`. `test/hosting-providers-bulletproof-schema.test.ts` pins the derived schema and checks that 0078 is the only migration adding the column.
- Nothing in the codebase writes `is_bulletproof`. It is read-only, and every row reads `0` unless it was set out of band. The ops type `Provider.is_bulletproof` (`averrow-ops/src/hooks/useProviders.ts`) declares it but nothing renders it.

### First deploy of AI_STRATEGY Phase 0/1 — expected one-time effects

Phase 0/1 itself needs no migration (the abuse-mailbox change shipped alongside it needs 0273 — see the next section). Expect, once, after the first deploy:

- **Up to ~90 lookalike `HIGH` alerts.** The lookalike scanner's one-time catch-up re-composites mail+web rows that a retired Haiku verdict held below HIGH (prod sizing: 84 LOW + 6 MEDIUM; rows with `status` `benign`/`taken_down` are excluded). They alert as they are re-checked, then the predicate goes false. This is not a regression.
- **Up to ~50 provider insight rows from Cartographer.** `hosting_providers.last_score` still holds the old Haiku scores; the first rule-based score moves past the emit threshold for providers whose heuristic differs, then converges.
- **Possibly one spurious `platform_ai_calls_failing` notification and email.** Pre-deploy `agent_outputs` rows carry `aiCallsAttempted > 0` with 0 successes inside the 2h window; Flight Control may fire once before they age out. Under `rules_only` no new attempts are recorded, so it does not recur. It is escalated by email at most once per UTC day.
- **Service worker update.** `packages/averrow-ops/public/sw.js` `VERSION` is `2026-10-02.1`; old shell/runtime caches are evicted on activate. Bump `VERSION` on any further `sw.js` change.
- **Post-deploy: re-run the analyst `key_prefix` redaction once.** Until this deploy the old Worker writes the first 8 chars of the Anthropic key into analyst diagnostic rows. 6,616 existing rows were redacted on 2026-10-02; rows written between then and the deploy need the same one-shot (idempotent):
  ```sql
  UPDATE agent_outputs
     SET summary = replace(summary, 'key_prefix=' || json_extract(details,'$.key_prefix'), 'key_prefix=[redacted]'),
         details = json_remove(details,'$.key_prefix')
   WHERE agent_id='analyst' AND type='diagnostic'
     AND json_valid(details) AND json_type(details,'$.key_prefix') IS NOT NULL;
  ```
  Rotate the Anthropic / `LRX_API_KEY` key regardless.

### Migration 0273 + the `ABUSE_MAILBOX_TRIAGE` Workflow binding (abuse-mailbox rules determinations)

- `0273_abuse_inbox_responder_suppressed.sql` adds `abuse_inbox_messages.responder_suppressed_reason`, `forwarded_by_reg_domain` and `responder_guard_version`, backfills `responder_suppressed_reason = 'legacy:pre_guard'` on every row with `determination_sent_at IS NULL` (pre-guard rows are never emailed by the sweeper), and creates four indexes (two partial). Apply it **before** the Worker — **ingest depends on it**: the email handler's INSERT names all three new columns (the backscatter decision is written by the INSERT itself), so a Worker deployed ahead of the migration fails every inbound report. The determination claim, sweeper, `17 * * * *` cron gate and the partial `idx_abuse_inbox_undelivered` index filter on `responder_suppressed_reason IS NULL AND responder_guard_version IS NOT NULL`.
- **Deploy-window gap is closed by the marker — no manual backfill needed.** Rows captured by the OLD Worker between the migration and the Worker deploy are inserted with `responder_suppressed_reason = NULL` (they never passed the positive-authentication guard) but also `responder_guard_version = NULL`; only the new INSERT writes `responder_guard_version = 1`, so those rows are classified but never emailed. Optional, for operator clarity only: `UPDATE abuse_inbox_messages SET responder_suppressed_reason = 'legacy:pre_guard' WHERE responder_guard_version IS NULL AND determination_sent_at IS NULL AND responder_suppressed_reason IS NULL;`
- Verify the marker after deploy: the newest row should have `responder_guard_version = 1` — `SELECT id, responder_guard_version, responder_suppressed_reason FROM abuse_inbox_messages ORDER BY received_at DESC LIMIT 5;`
- `wrangler.toml` adds `[[workflows]] abuse-mailbox-triage` → `ABUSE_MAILBOX_TRIAGE` / `AbuseMailboxTriageWorkflow` (exported from `src/index.ts`). `wrangler deploy` creates it; no manual provisioning. The binding is optional in `Env` — staging/dev (no `[[workflows]]` there) and any deploy without it fall back to the hourly `17 * * * *` sweeper.
- Verify after deploy: forward a test report from a DMARC-passing mailbox; within ~2 min `abuse_inbox_messages.classified_by = 'rules'` and `determination_sent_at` is set; `npx wrangler workflows instances list abuse-mailbox-triage` shows the `abuse-<messageId>` instance; `agent_activity_log` has an `abuse_mailbox_triage` / `abuse_triage_complete` row. A report from a domain without DMARC (`dmarc=none`) is classified but stamped `backscatter:dmarc_not_pass` and gets no ack — expected.

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
| `DB` | Primary database (users, brands, threats, alerts, …) |
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
