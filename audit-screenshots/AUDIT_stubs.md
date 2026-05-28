# Averrow Platform Stub & Placeholder Audit

Generated 2026-05-28. Source repo: `/home/user/trust-radar`.

Scope: code + DB context for `packages/trust-radar` (Worker) and
`packages/averrow-ops` (staff React SPA). UI screenshots not opened.

> One-line takeaway: there are **four classes** of soft-broken
> features here.
>
>   1. **Endpoints + producers exist, but never get to write rows**
>      because they're gated on an integration that was never wired
>      (HIBP key, CIRCL credentials, DMARC RUA forwarding,
>      org-signed takedown authorizations).
>   2. **Endpoints exist + are pre-warmed by Navigator, but no UI
>      ever reads them** — operators have no way to surface the
>      data even if it were there (`/api/breaches`, `/api/ato-events`,
>      `/api/email-auth`, `/api/cloud-incidents`, `/api/narratives`,
>      `/api/ct/certificates`).
>   3. **Agents flagged `retired` (PR-P, 2026-05-14) are still
>      called from live production handlers** — the retirement
>      label is wrong for at least 11 modules. None of them are
>      hidden from the Agents page.
>   4. **Self-serve org actions in `/settings` are disabled buttons
>      with "coming soon" tooltips** — billing, member-managed
>      brand add, org deletion, billing email change.

---

## Empty tables → broken / dormant features

| Table | UI surface | API endpoint | Producer | Verdict |
|---|---|---|---|---|
| `ct_certificates` (0) | None in averrow-ops or averrow-tenant | `/api/ct/certificates/:brandId` + `/stats` + `/scan/:brandId` (`routes/brands.ts:397-414`) — wired | `scanners/ct-monitor.ts::pollCertificates` runs every hourly tick (`cron/orchestrator.ts:534`). Requires `JOIN org_brands` — there's only a tenant-monitored brand list to scan against. | **Endpoint exists, no UI consumer, producer needs org-monitored brands to do anything.** |
| `passive_dns_records` (0) | None | None (no /api/passive-dns route) | `feeds/circlPassiveDns.ts:31-46` — short-circuits to `[]` when `CIRCL_PDNS_USER`/`CIRCL_PDNS_PASS` env vars are missing. Comment: "Registered as DISABLED by default until CIRCL credentials are obtained." | **Producer disabled, no UI, no route. Dead feed registration.** |
| `breach_checks` (0) | None | `GET /api/breaches` → `handlers/intel.ts::handleListBreaches` (`routes/threats.ts:313`). Pre-warmed by Navigator (`cron/navigator.ts:556`). | **No INSERT anywhere in the codebase.** Grep for `INSERT.*INTO breach_checks` returns zero hits. | **Endpoint shipped, producer never written. Phantom feature.** |
| `ato_events` (0) | None | `GET /api/ato-events` + `PATCH /api/ato-events/:id` → `handlers/intel.ts::handleListATOEvents` (`routes/threats.ts:320,325`). Pre-warmed. | **No INSERT anywhere.** | **Endpoint shipped, producer never written.** |
| `stealer_log_results` (0) | None | `feeds/hibp.ts::hibp_stealer_logs` writes here (line 124) but feed gated on `env.HIBP_API_KEY`. Source comment line 1: `// TODO: Enable when HIBP Pro subscription is purchased`. | HIBP module registered as a feed. Pull short-circuits if no API key. | **Producer wired but explicitly disabled until paid HIBP subscription added.** |
| `dmarc_reports` (0) + `dmarc_report_records` (0) | None in averrow-ops. Brand-level SPF/DKIM/DMARC policy comes from `brands` table (different field), so no false UI dependency. | None (no /api/dmarc-reports route registered) | `dmarc-receiver.ts::handleDmarcEmail` (line 54). Wired to Cloudflare Email Worker at `index.ts:118-121` for `dmarc_rua@averrow.com` + `dmarc_rua@trustradar.ca`. | **Producer wired, requires customers to set `rua=mailto:dmarc_rua@averrow.com` in their DMARC DNS record. Zero customers have done this. No reader UI either.** |
| `phishing_pattern_signals` (0) | None | Read by Pathfinder (`agents/pathfinder.ts:334`) + brand-threat-correlator (line 121) | **No INSERT anywhere.** Migration `0023_seed_campaign_v1_and_phishing_signals.sql` created the table but no agent writes to it. | **Read but never written. Always-empty input → no signal-derived insights.** |
| `brand_threat_assessments` (0) | None directly. Endpoints `/api/brand/:brandId/threat-assessment` + `/history` (`routes/brands.ts:252-258`) exist. | Same | `brand-threat-correlator.ts::runDailyAssessments` runs at hour===0 (`cron/orchestrator.ts:1153`). Writes via `storeAssessment` (line 358). | **Producer runs but table empty — implies the daily-assessment cron path is failing silently or `brand_threat_correlator` throws inside the loop. No UI surface so no operator pressure to fix it.** |
| `threat_signals` (0) | None | None (no /api/threat-signals) | `threat-feeds.ts::insertSignal` is called from `syncPhishtankFeed` (line 272) + `syncUrlhausFeed` (line 362) every hourly tick. Both feeds are CIRCL-style aux feeds gated on KV throttle. | **Producer runs but only inserts when fuzzy-matched-brand IS in our brands table for the URLhaus/PhishTank entry — happens via `runThreatFeedSync` in `cron/orchestrator.ts:1014`. Zero hits in 30d suggests fuzzy match never succeeds in practice.** |
| `takedown_submissions` (0) — but `takedown_requests=1413`, `takedown_evidence=1525` | Read by `tenantTakedowns` (handlers/tenantTakedowns.ts:116, 219, 226, 240) — customer-facing takedown timeline. | Read via `/api/tenant/takedowns` | Writer: `lib/takedown-submitters/index.ts::recordSubmissionAttempt` (line 105), dispatched by Sparrow Phase G (`agents/sparrow.ts:844`). The Phase G query gates on `takedown_providers.auto_submit_enabled = 1` — migration `0152_takedown_automation.sql:35` sets DEFAULT 0. **No provider has been opted in.** | **End-to-end submitter pipeline shipped (email-draft submitter, follow-up draft submitter, dispatcher). But ZERO providers have `auto_submit_enabled=1` so the Phase G loop skips every candidate. Plus the only existing submitter (`email-draft`) is documented at `lib/takedown-submitters/email-draft.ts:1-21` as: "records an intended submission ... but does NOT actually send the email."** Customers' takedown timeline never shows a submission count because none get recorded. |
| `url_scan_results` (4) | None in averrow-ops UI. Read by Sparrow handler (`handlers/sparrow.ts:42,52`) — internal evidence assembler input. | `POST /api/scan` (`routes/scan.ts:33`) — public homepage scan widget on averrow.com. | `lib/url-scanner.ts:153` writes here. Called from `urlScanAgent` (the agent flagged "retired") and from `scanUnprocessedCaptures`. | **Only 4 rows — implies only 4 public scans have happened. Producer wired, just low usage. Not a stub.** |
| `qualified_reports` (low/check) | `features/scan-leads/ScanLeads.tsx` — "Generate Report" button calls `useGenerateQualifiedReport()` (hooks/useScanLeads.ts:88-99). | `POST /api/admin/leads/:id/qualified-report` (`routes/admin.ts:363`). | `handlers/qualifiedReport.ts::handleGenerateQualifiedReport` INSERTs to `qualified_reports` (line 254). Calls `qualifiedReportAgent` — which is flagged `status: "retired"` in `agents/qualified-report.ts:161`. **Runner doesn't enforce retired status, so the call still works.** | **Endpoint + UI button both real. Calls a "retired" agent that still functions. Pure documentation drift.** |
| `threat_narratives` (55 vs threat_actors=60) | **No UI consumer in averrow-ops.** `/api/narratives/:brandId` exists (`handlers/narratives.ts:44`) but is never called from the React SPA. | `GET /api/narratives/:brandId` + detail + generate + PATCH | `agents/narrator.ts:216` writes here. Runs daily at hour===6 (`cron/orchestrator.ts:512`). | **Producer is healthy — 55 rows matches the daily cadence. No UI ever surfaces them. Pure backend-only data with no reader.** |

---

## TODO / FIXME hotspots

After filtering the 429 raw `grep` hits (most are the
`// TODO: Refactor to use handler-utils (Phase 6 continuation)` mass
marker), the meaningful TODOs cluster into 4 groups.

### A. Integrations are CRUD-only — no actual integration

- `handlers/organizations.ts:1359` — `// TODO: Encrypt config with
  AES-GCM using env secret in production`. Config (Splunk HEC
  tokens, Jira API tokens, SAML shared keys etc.) is stored as
  plaintext JSON in `org_integrations.config_encrypted` despite
  the column name. The UI in `features/admin/components/ConnectIntegrationSheet.tsx`
  prompts for password-typed inputs implying secure storage.
- `handlers/organizations.ts:1480` — `// TODO: Implement actual
  connection tests per integration type (Splunk HEC, Jira API,
  etc.) // For now, mark as connected if config exists`. The
  "Test Connection" button always returns
  `{ status: "connected", message: "Connection test successful" }`
  as long as `config_encrypted` is non-null. The customer has no
  way to know whether their integration actually works.

### B. Architect telemetry collectors return zeros

`agents/architect/collectors/ops.ts`. Architect agent is itself
retired per `agents/index.ts:22-28`, so these TODOs are dead
unless the agent is resurrected. Listed for completeness.

- Line 74: `// TODO: wire Cloudflare Queues API once
  producers/consumers are declared in wrangler.toml` →
  `queues_depth: {}`.
- Line 207: `// TODO: wire Cloudflare Cron Trigger analytics
  (graphQL analytics API)`.
- Line 268: `// TODO: cache_hit_rate requires the Cloudflare AI
  Gateway analytics API`.

### C. Feed creation/deletion via API not wired

- `routes/feeds.ts:84` — `POST /api/feeds` returns 501 "Feed
  creation via API deferred to v2 admin module".
- `routes/feeds.ts:88` — `DELETE /api/feeds/:id` returns 501
  "Feed deletion via API deferred to v2 admin module".
- `handlers/feeds.ts:154` — `handleTriggerFeed` returns 501 when
  `feedModules[feedName]` is missing (legit, defensive).

No UI button currently calls these — operators add feeds by
migration. Low-impact stubs.

### D. Documentation drift

- `agents/sentinel.ts:202`, `feeds/certstream.ts:46-50,178`,
  `agents/auto-seeder.ts:98`, `lib/auto-seeder-planter.ts:9,172`,
  `lib/agentRunner.ts:268,552`, `feeds/mastodon.ts:76` — all
  mention "hardcoded" but in the comment-explanation sense
  ("falls back to a hardcoded default roster"), not the
  bug sense. Real behavior.

---

## Backend stub handlers

### `handleFeedQuota` (`handlers/feeds.ts:262-266`)

```ts
// ─── Feed quota (stub — quota tracking deferred to Phase 2) ─────
export async function handleFeedQuota(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  return json({ success: true, data: [] }, 200, origin);
}
```

Wired at `GET /api/feeds/quota` (`routes/feeds.ts:47`). No UI
consumes it. Pure stub, low-risk.

### `handleTestIntegration` (`handlers/organizations.ts:1465-1491`)

Always succeeds. See group A above.

### `routes/feeds.ts:82-89` — 501s for feed CRUD

Documented above. Returns
`"Feed creation via API deferred to v2 admin module"` /
`"Feed deletion via API deferred to v2 admin module"`.

### `handlers/intel.ts` — Tier-2 intel section is a phantom

`handleListBreaches`, `handleListATOEvents`, `handleListEmailAuth`,
`handleListCloudIncidents` all exist, all are auth-gated,
all are KV-cached, all are pre-warmed by Navigator
(`cron/navigator.ts:556-559`). Every one of them reads from a
table that has zero writers. They will always return
`{ stats: { total: 0 }, ... [] }` until someone wires a producer.

The pre-warming cost is real — Navigator burns four DB reads
every 5 min keeping the empty-table KV cache warm.

---

## Frontend stubs / fake data

### `features/admin/SuperAdminOrgs.tsx:436-464` — two placeholder tabs

```tsx
// ─── Integrations Tab (placeholder - uses existing tenant endpoints) ──
function DetailIntegrationsTab({ orgId }: { orgId: string }) {
  return (
    <div className="space-y-4">
      <SectionLabel>Integrations</SectionLabel>
      <p className="text-[11px] text-white/55">
        Integration configuration is managed from the organization's own dashboard.
      </p>
      <Button variant="secondary" size="sm" onClick={() => window.open(`/v2/admin/users`, '_blank')}>
        Open Org Dashboard
      </Button>
    </div>
  );
}
// ─── API Keys Tab (placeholder) ─────────────────────────────
function DetailApiKeysTab({ orgId }: { orgId: string }) { ... explanatory text only ... }
```

Tab labels imply per-org integration + API-key management. The
tab content is just a "see the org's own dashboard" pointer.
The button opens `/v2/admin/users` (Organization page) which
itself has disabled buttons (see next).

### `features/settings/Organization.tsx` — four disabled "self-serve" buttons

| Line | Action | Tooltip | Replacement |
|---|---|---|---|
| 195-209 | Manage Billing | "Self-serve billing isn't wired yet — contact support to make plan changes." | "Email billing@averrow.com to change plans." |
| 252 | (member-side) Add Brand | "Member self-serve brand assignment isn't wired yet — contact support to add a brand." | n/a |
| 590 | (billing email edit) | "Self-serve billing email isn't wired yet — contact support." | n/a |
| 647-654 | Delete Org | "Self-serve org deletion isn't wired — email support@averrow.com to delete." | Email instruction |

These are honest dead-end disabled buttons with explicit
"contact support" copy. Not pretending to work. But: the entire
billing surface is "email us" rather than self-serve.

### `templates/homepage.ts:682-748` — averrow.com marketing mocks

```
/* ── CAPABILITY PRODUCT MOCKS ──
   Stylized UI snippets, not real screenshots. Synthetic data only. */
```

Domain names like `login-yourbrand-mfa.com` (lines 1343-1345,
1422-1423) make the synthetic intent obvious. **Not a stub
problem** — marketing intentionally renders illustrative data.

### `preview/*-preview.tsx` — dev harnesses with `MOCK_USER`

`preferences-preview.tsx`, `bell-preview.tsx`,
`admin-dashboard-preview.tsx`. Each has a `const MOCK_USER` and
a `window.fetch` interceptor that returns canned data. These
are explicitly dev-only — comment at line 3 of each:
`// Mocks the API + AuthContext so we can iterate on the UX
without running the full app or signing in. Not shipped to prod.`

Not bundled into production routes. Safe.

---

## Retired agents still surfaced in the UI

Per CLAUDE.md §6 + per-file comments
`status: "retired"  // PR-P 2026-05-14: zero real usage in 14d`,
these 11 agents are flagged retired:

```
admin_classify, brand_analysis, brand_deep_scan, brand_report,
geo_campaign_assessment, honeypot_generator, public_trust_check,
qualified_report, scan_report, social_ai_assessor, url_scan
```

**Critical finding:** every one of them has a live production
callsite in a handler or scanner. Retirement is a documentation
claim only. The runner (`lib/agentRunner.ts::runSyncAgent`)
does NOT check `agentModule.status` before dispatching, so the
agents continue to execute when called.

| Agent | Live caller | Surface |
|---|---|---|
| `admin_classify` | `handlers/admin.ts:1235` (`runSyncAgent(adminClassifyAgent, ...)`) | Admin "Classify backfill" endpoint |
| `brand_analysis` | `handlers/brands.ts:1153` | Brand detail page — per-brand threat assessment |
| `brand_deep_scan` | `handlers/brands.ts:1215` | Brand detail page — batch URL classification |
| `brand_report` | `handlers/reports.ts:243` | Per-brand exposure report |
| `geo_campaign_assessment` | `handlers/geopolitical.ts:541` | Geo campaign dashboard narrative |
| `honeypot_generator` | `routes/admin.ts:1116-1124` | Admin "Generate honeypot site" action |
| `public_trust_check` | `handlers/public.ts:236-238` (`/api/v1/public/assess`) | averrow.com homepage scan widget — public-facing |
| `qualified_report` | `handlers/qualifiedReport.ts:166-168` | `/v2/leads` ScanLeads → "Generate Report" button (`ScanLeads.tsx:243`) |
| `scan_report` | `handlers/scanReport.ts:150` | Scan-report narrative for public report page |
| `social_ai_assessor` | `scanners/social-monitor.ts:577` + `handlers/brands.ts:1810` | **Cron-driven** social-monitor scanner, every 6h |
| `url_scan` | `handlers/scan.ts:281-282` | `/api/scan` (public URL scan from homepage) |

Also: **all 11 are still in `agentModules`** (`agents/index.ts:86-103`),
so they appear on the `/v2/agents` Agents page with their
pretty AGENT_METADATA subtitles (`packages/averrow-ops/src/lib/agent-metadata.ts:288-404`).
There is no filter for retired status in `features/agents/Agents.tsx`,
and the `/api/agents` handler doesn't filter on `mod.status`
either (`handlers/agents.ts:20-28`).

Net effect:
- Operator opens `/v2/agents` and sees 11 cards with
  "Synchronous AI — admin-triggered customer-facing brand risk
  reports" and similar prose.
- Each card shows `0 runs / 24h`, `0 outputs / 24h`,
  `last_run_at: null` because the sync paths don't write to
  `agent_runs` the same way scheduled paths do — so the agent
  looks broken even though the underlying handler works.
- The cards are clickable, leading to detail panes that show
  the same "nothing's happening" picture.

**Suggested action:** either flip the status back to `active`
(they're not retired in practice) or remove them from the UI
surface (filter `status !== 'retired'` in
`handlers/agents.ts::getAgentDefinitions`).

---

## Top 10 most embarrassing stubs (ranked)

Ordered by "what does a customer or operator see that doesn't
match reality."

### 1. Integration "Test Connection" always succeeds

`handlers/organizations.ts:1480-1490`. Customer enters their
Splunk HEC token, clicks "Test Connection", sees
"Connection test successful" — regardless of whether the
token works, the URL is reachable, or anything. The integration
will then sit in `status='connected'` until something else
catches the failure. Combined with #2 below, the customer's
credential is also stored plaintext.

### 2. Integration config is stored plaintext

`handlers/organizations.ts:1359` + column name
`org_integrations.config_encrypted`. Splunk HEC tokens, Jira
API tokens, ServiceNow basic-auth creds, Elastic API keys — all
of them get JSON-serialized and stored as the literal text in
`config_encrypted`. Schema name lies. Security exposure for
every integration that exists.

### 3. Email-draft takedown submitter doesn't send email

`lib/takedown-submitters/email-draft.ts:1-21`. The only
registered submitter (`SUBMITTERS = [emailDraftSubmitter]` in
`lib/takedown-submitters/index.ts:36-39`) is documented as:
"does NOT actually send the email." It assembles a body,
writes the row with `outcome='queued'`, and ... that's it.
Combined with `auto_submit_enabled DEFAULT 0` for every provider
(`migrations/0152_takedown_automation.sql:35`), this means the
entire "Averrow auto-submits takedowns on your behalf" promise
is unwired. There are 1,413 `takedown_requests` and 0
`takedown_submissions`.

### 4. Four "Intel" endpoints are pre-warmed empty arrays

`/api/breaches`, `/api/ato-events`, `/api/email-auth`,
`/api/cloud-incidents`. Endpoints + stats blocks + KV caching
+ Navigator pre-warm tier (`cron/navigator.ts:556-559`)
shipped. Tables exist (`breach_checks`, `ato_events`,
`email_auth_reports`, `cloud_incidents`). **Zero writers
anywhere in the codebase.** Navigator burns 4 D1 reads / 5min
keeping the empty cache warm. No UI surfaces them, but if
someone hits the JSON endpoint they get an authoritative
"no breaches detected, 0 ATOs, all email auth passing,
no cloud incidents" — false comfort.

### 5. 11 "retired" agents are visible on /v2/agents with `0 runs` next to a paragraph of prose

See "Retired agents" section above. Worst offender is
`Honeypot Generator` — `agent-metadata.ts:333-340` markets it
as "renders complete honeypot trap websites (index + contact +
team pages with embedded trap mailtos, Haiku × 3)" but the
agent shows zero runs on the dashboard because the only caller
is the admin "Generate honeypot site" button (`routes/admin.ts:1116`)
which isn't being clicked.

### 6. CT certificate monitoring runs hourly and produces zero rows

`scanners/ct-monitor.ts::pollCertificates` runs every hourly
tick. The `org_brands` join (line 65) returns nothing because
in the current single-org SOC setup the brands table isn't
populated through `org_brands` for the monitoring path. So
crt.sh isn't queried, no certs land, the
`/api/ct/certificates/:brandId` endpoint that's wired in
`routes/brands.ts:397-414` always returns empty. Endpoint and
producer both shipped — feature is dark because of the
gate that wasn't anticipated.

### 7. /api/narratives endpoint family has no UI consumer

`agents/narrator.ts` runs daily at hour===6 and writes ~55
narratives. `handlers/narratives.ts` exposes
`/api/narratives/:brandId`, `/:brandId/:id`,
`/:brandId/generate`, `PATCH /:id`. **Nothing in
averrow-ops or averrow-tenant calls these.** Cron burns
Haiku tokens daily producing data nobody reads.

### 8. `phishing_pattern_signals` is read but never written

Migration `0023` created the table. Pathfinder
(`agents/pathfinder.ts:334`) + brand-threat-correlator
(line 121) read it as a "high-signal AI phishing detection"
input. **No INSERT in the codebase.** Whatever risk score is
supposed to come from this signal will always evaluate to "0
AI-detected phishing patterns."

### 9. `brand_threat_assessments` is daily-cron-written but empty

`brand-threat-correlator.ts::runDailyAssessments` is called at
hour===0 (`cron/orchestrator.ts:1153`). Loops `LIMIT 100`
brands, calls `correlateBrandThreats` for each, calls
`storeAssessment` (line 358). Table is empty, which means the
correlator returns `null` for every brand. Two endpoints
expose the data (`/api/brand/:brandId/threat-assessment` +
`/history`, `routes/brands.ts:252-258`). Nothing in the UI
fetches them. Silent daily compute that nobody sees, and that
also isn't actually persisting.

### 10. DMARC RUA receiver is wired but no customer has aimed it

`dmarc-receiver.ts::handleDmarcEmail` is wired to
`dmarc_rua@averrow.com` + `dmarc_rua@trustradar.ca` in
`index.ts:118-121`. Producer fully implemented (RFC 7489 parser,
ZIP/GZIP, DecompressionStream). **Zero customers have set
their DMARC RUA record to point at us.** No UI consumer for
the reports anyway. Pure phantom — engineering effort exists,
but no go-to-market or operator surface to make it real.

---

## Bonus context worth flagging

- **Self-serve billing is entirely "email billing@averrow.com."**
  `features/settings/Organization.tsx:194-209`. There's a UI
  surface (PricingConfig, plan tiers, Stripe handler) but no
  in-app plan-change flow. New customers / upgrades all funnel
  through email.
- **Navigator pre-warms 24 endpoints across 3 phases**
  (CLAUDE.md §8). Phase A is real-data (Observatory etc).
  Phase C **includes** the four phantom intel endpoints
  (`Breaches`, `ATO`, `Email Auth`, `Cloud Incidents`),
  meaning the platform pays a recurring D1-read tax to keep
  empty-table caches warm. Recommend dropping these four
  from the Navigator phase-C list until producers exist.
- **`stealer_log_results` is the only "feature-gated-on-paid-sub"
  case where the file itself is honest** (`feeds/hibp.ts:1`,
  `// TODO: Enable when HIBP Pro subscription is purchased`).
  This pattern should be the model for the others.
