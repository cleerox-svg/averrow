# Business Continuity & Disaster Recovery Plan

**Status: DRAFT — pending owner approval. Internal; not for customer distribution.**

| Field | Value |
|---|---|
| Document | Averrow BCDR operational plan |
| Version | 0.1 (draft) |
| Governing policy | `docs/security/BCDR_POLICY.md` |
| Gap register | `docs/security/BCDR_GAPS.md` |
| Plan owner | [Name] (backup: [Name]) |
| Approved by / date | ______ |
| Basis | Repository state on 2026-10-05 (`packages/averrow-worker/wrangler.toml`, `.github/workflows/deploy-radar.yml`, `docs/DEPLOYMENT.md`) |

**Reading note.** Commands in this plan marked **[verify against current Cloudflare docs]** have not been exercised against this platform and must be checked against current Wrangler and Cloudflare documentation before use. Placeholders in square brackets are to be filled by the owner. No secret values or credentials belong in this document.

---

## 1. System inventory and dependency map

### 1.1 Components and tiers

| Component | Identifier (from `wrangler.toml` unless noted) | Tier | Rebuildable? |
|---|---|---|---|
| Worker | `averrow-worker` (line 1): API, ops SPA (`/v2`), tenant SPA (`/tenant`), marketing site, status page (`/status`), 21 cron triggers, inbound email | 1a | Yes, from git via CI deploy |
| Primary D1 | `trust-radar-v2`, binding `DB` (about 4 GB per owner's inventory) | 1b | No: system of record |
| Audit D1 | `trust-radar-v2-audit`, binding `AUDIT_DB` | 1b | No: system of record |
| R2 | `trust-radar-trademark-assets`, binding `TRADEMARK_ASSETS` (customer logos/wordmarks) | 1c | No: single copy |
| Workflows (6) | `cartographer-backfill`, `cartographer-main`, `nexus-run`, `campaign-hunter`, `geoip-refresh`, `abuse-mailbox-triage` | 2 | Yes: defined in code; in-flight instance state is lost |
| Durable Objects | `ThreatPushHub`, `CertStreamMonitor` | 2 | Yes: reconnect on restart |
| KV | `CACHE`: caches, rate limits, cron stamps, `forced_logout:<user_id>` session-revocation markers, AI call cap | 2 | Caches yes; revocation and rate-limit state no |
| R2 | `averrow-nrd-archive`, binding `NRD_ARCHIVE` (cold tier of `nrd_domains`; sole copy of NRD history older than 30 days) | 2 | No: single copy |
| Analytics Engine | dataset `trust_radar_d1_reads`, binding `AE` | 3 | Diagnostic only |
| D1 | `geoip-db`, binding `GEOIP_DB` | 3 | Yes: reload from MaxMind (`geoip-refresh` Workflow, `POST /api/admin/geoip-refresh`) |
| D1 | `trust-radar-dns-queue`, binding `DNS_QUEUE_DB` | 3 | Yes: re-enqueued from `threats` by `lib/dns-queue-reconciler.ts` |
| R2 | `geoip-staging`, binding `GEOIP_STAGING` | 3 | Yes: transient |
| Workers AI | binding `AI` (prod only) | 2 | Fallback: rules-only |
| MCP server | `averrow-mcp` (`packages/averrow-mcp/wrangler.toml`) | 3 | Yes, but deployed by hand (G13) |
| Queues (legacy) | `architect-analysis` consumer + DLQ `architect-analysis-dlq` (`wrangler.toml` `[[queues.consumers]]`; nothing enqueues to it, but `wrangler deploy` fails if the queues are missing) | 3 | Yes: recreate empty |

Domains routed to the Worker (`wrangler.toml` routes): `averrow.com`, `averrow.ca`, `trustradar.ca`, `lrxradar.com` and their `www.` hosts, as Cloudflare custom domains.

### 1.2 External dependencies

| Dependency | Used for | Tier | Fallback today |
|---|---|---|---|
| Cloudflare (single vendor, shared account hosting other LRX products) | Everything above, DNS/custom domains, Email Routing | Critical | None (see G5) |
| GitHub / GitHub Actions | Source, CI, deploy (`deploy-radar.yml`) | 1 for change, not for running service | Manual `wrangler deploy` from a trusted workstation |
| Resend | Outbound email: platform escalation email, daily briefing, invites, notifications | 2 | Escalation also via push and ops UI; status page |
| Google OAuth | Staff and customer login | 2 | Self-hosted passkeys for users who have enrolled one |
| Stripe | Billing checkout/portal, webhooks | 2 | Existing customers unaffected; new checkouts wait |
| Threat feeds (about 50) | Ingest | 2 | Per-feed circuit breaker with backoff and auto-pause (`lib/feedRunner.ts`) |
| Takedown submitters (NetBeacon, GoDaddy, Google Web Risk) | Takedown submission | 2 | Queue and retry; manual submission |
| MaxMind | GeoIP refresh | 3 | Existing `geoip-db` stays in service |
| Anthropic | Not in request path: `AI_MODE = "rules_only"` in prod, staging and dev | n/a | n/a |
| Domain registrar / DNS | [Name of registrar] | 1 | See G4 |

### 1.3 Dependency map (what fails when X fails)

```
Cloudflare account/control plane
 ├─ Worker (1a) ── needs ──> D1 DB, D1 AUDIT_DB (1b)  [login, API, all handlers]
 │                     ├──> KV CACHE (2)              [rate limit, revocation, cache; fails soft or open per call site: verify]
 │                     ├──> R2 TRADEMARK_ASSETS (1c)  [logo serving only]
 │                     ├──> R2 NRD_ARCHIVE (2)        [nrd_hagezi feed throws if unbound]
 │                     └──> DNS_QUEUE_DB, GEOIP_DB (3) [enrichment only; cartographer falls through]
 ├─ Cron + Workflows (2) ──> D1 + feeds ──> Flight Control monitoring (same Worker)
 └─ Email Routing ──> Worker (abuse mailbox)
GitHub Actions ──> migrations (before deploy) ──> wrangler deploy
Resend ──> escalation + briefing email
Google OAuth ──> login (passkey fallback)
```

Key property: monitoring, incident creation, the public status page and escalation all run inside the Worker that they monitor. A Worker-wide or account-wide failure can disable the alerting that would report it (G6).

---

## 2. Current recovery capabilities (honest statement)

As of 2026-10-05, verified against the repository and `docs/DEPLOYMENT.md`:

| Capability | Exists today | Tested | Notes |
|---|---|---|---|
| D1 Time Travel (platform point-in-time recovery) on `trust-radar-v2` and `trust-radar-v2-audit` | Yes (platform feature; `docs/DEPLOYMENT.md` line 101 cites a 30-day window on paid plans) | **No** | Retention window must be confirmed for this account [verify]. Restore is in place, onto the live database. |
| Worker version rollback (`wrangler rollback`) | Yes (documented at `docs/DEPLOYMENT.md` "Rollback") | **No** | Rolls back the Worker bundle and its assets only. Does not roll back D1 migrations. |
| Independent backup or export of any D1 database | **No** | n/a | Gap G1. |
| Off-Cloudflare copy of any data | **No** | n/a | Gaps G1, G8. |
| Restore drill | **Never performed** | n/a | Gap G2. |
| Approved RTO/RPO | **Objectives approved by owner 2026-10-05** (policy section 5); the plan and policy text are still draft. Tier 1b ≤24h RPO and Tier 1c targets are not achievable until G1/G8 ship | n/a | Gap G3 (narrowed). |
| Staging environment for rehearsal | **No** (names exist in `wrangler.toml`; databases about 12 KB, workers absent) | n/a | Gap G9. |
| External uptime monitoring | **No** | n/a | Gap G6. |
| R2 versioning or second copy (`TRADEMARK_ASSETS`, `NRD_ARCHIVE`) | **No** | n/a | Gap G8. |
| KV backup | **No** | n/a | Gap G10. |
| Down-migrations | **No**: migrations are roll-forward only | n/a | Gap G7. |

**`docs/roadmap/06-DISASTER-RECOVERY.md` is aspirational and is NOT implemented.** It describes a nightly `0 4 * * *` export to an `averrow-backups` bucket, 30/12/12 retention, read replication, and an admin DR panel. None of these exist: the bucket is not bound in `wrangler.toml`, no `0 4 * * *` cron is in the cron list, and the panel route is not present. Do not rely on, or cite to auditors, anything in that roadmap as a current control.

Consequence for this plan: until G1 and G2 are closed, the only recovery path for the system of record is D1 Time Travel, which has never been exercised and sits inside the same vendor account as the data. Playbooks below are written for the capabilities that exist; steps that depend on future capabilities are marked **(future)**.

---

## 3. Incident severity scale

| Severity | Definition | Examples | Response start | Status page |
|---|---|---|---|---|
| Sev 1 | Platform unavailable, or customer data lost, corrupted, or exposed | Worker down, DB corruption, confirmed secret compromise | Immediately, any hour | Required |
| Sev 2 | Major function degraded for many customers, or a Tier 1/2 dependency down without workaround | Login failing, ingestion stopped more than 4h, email escalation down | Within 1 hour | Required if customer-visible |
| Sev 3 | Single feature degraded, workaround exists | One feed failing, one Workflow stalled | Next business day | Optional |
| Sev 4 | Minor, no customer effect | Cosmetic, single retried job | Backlog | No |

Platform note: Flight Control critical notifications auto-create incidents that surface on the public status page (`lib/platform-status.ts`). `platform_ai_calls_failing` is deliberately severity `high`, not `critical`, to avoid an auto-incident, and is escalated by email instead (`EMAIL_ESCALATION_TYPES` in `lib/platform-templates.ts`).

## 4. Contact tree (fill in; keep an offline copy)

| Order | Role | Name | Phone | Email | Alternate |
|---|---|---|---|---|---|
| 1 | BCDR lead / incident commander | [Name] | [ ] | [ ] | [Name] |
| 2 | Backup BCDR lead | [Name] | [ ] | [ ] | [Name] |
| 3 | Engineering / platform operator | [Name] | [ ] | [ ] | [Name] |
| 4 | Communications owner | [Name] | [ ] | [ ] | [Name] |
| 5 | Executive sponsor | [Name] | [ ] | [ ] | [Name] |

| Vendor | Support route | Account / plan reference | Notes |
|---|---|---|---|
| Cloudflare | [support portal / contact] | [account reference, not the secret] | Account recovery owner: [Name] |
| GitHub | [ ] | [ ] | |
| Resend | [ ] | [ ] | |
| Stripe | [ ] | [ ] | |
| Google (OAuth client owner) | [ ] | [ ] | |
| Domain registrar | [ ] | [ ] | |

The escalation email recipient today is a single address (`BRIEFING_RECIPIENT`, optional in `Env`, `src/types.ts`). That is a single point of failure (G4); confirm who receives it during an incident.

## 5. Common procedures

### 5.1 Declare and open an incident
1. Incident commander assigns a severity (section 3) and opens an incident record (use the post-incident template in Appendix B as the live log from the start). Record start time (UTC).
2. For Sev 1/2: post to the public status page (staff incident tooling under `/api/admin`, surfaced on `/status`; see `routes/admin.ts` around line 294) and notify the executive sponsor.
3. Freeze non-essential deploys until resolved.

### 5.2 Health check commands
Per `CLAUDE.md` section 10 (requires `AVERROW_INTERNAL_SECRET` in the environment; never paste the value anywhere):
```bash
./scripts/platform-diagnostics.sh        # 6h window
./scripts/platform-diagnostics.sh 24
```
Reads `GET /api/internal/platform-diagnostics`. Look at `cron_health[]`, `agent_mesh.stalled[]`, `feeds.at_risk[]`, `enrichment_pipeline`, `ai_health`.

### 5.3 Capture a D1 recovery point (do this before any risky change)
```bash
cd packages/averrow-worker
npx wrangler d1 time-travel info trust-radar-v2        # prints current bookmark  [verify against current Cloudflare docs]
npx wrangler d1 time-travel info trust-radar-v2-audit  # [verify against current Cloudflare docs]
```
Record both bookmarks and the UTC time in the change or incident record.

### 5.4 Communications templates
- **Status page (initial):** "We are investigating an issue affecting [function]. Started [UTC time]. Next update by [UTC time]."
- **Status page (resolved):** "The issue affecting [function] was resolved at [UTC time]. [One-sentence cause]. [Data impact: none / describe]."
- **Customer notice (Sev 1/2 with data impact):** states what happened, what data and which customers were affected, what was done, what we are doing to prevent recurrence, and a contact. Sent by communications owner after incident commander and executive sponsor review. Where personal data was affected, assess breach-notification duties with counsel before sending.

---

## 6. Scenario playbooks

For each: detection, decision owner, steps, communications, exit criteria.

### 6.1 Bad deploy (Worker regression)

- **Detection.** Flight Control `platform_cron_navigator_missed`, `platform_cron_orchestrator_missed`, `platform_agent_stalled`; spike in 5xx; `cron_health[]` success rate drops in diagnostics; user reports; failed post-deploy checks.
- **Decision owner.** Incident commander. Rollback is preferred over forward-fix when cause is not understood within 15 minutes.
- **Steps.**
  1. Identify the offending deploy: GitHub Actions run `Deploy — Averrow Worker` (`deploy-radar.yml`) and the merge commit.
  2. Check whether the deploy also applied a migration (workflow step "Run DB migrations (production)" ran before "Deploy Worker + Assets"). If a schema change shipped, assess compatibility of the previous bundle with the new schema before rolling back: migrations are additive by policy, so the previous bundle should normally still run, but confirm.
  3. List versions and roll back (**[verify against current Cloudflare docs]**):
     ```bash
     cd packages/averrow-worker
     npx wrangler versions list
     npx wrangler rollback [version-id]
     ```
  4. Confirm: `./scripts/platform-diagnostics.sh 1`, load `/`, `/v2`, `/tenant`, `/status`, check next Navigator tick (every 5 minutes) completes.
  5. Fix forward in a new PR; do not re-merge the offending change until understood.
  6. Note: cron triggers and Workflow/Durable Object definitions come from the deployed version; verify they behave after rollback.
- **Communications.** Status page if customer-visible for more than 5 minutes.
- **Exit criteria.** Error rate and cron health back to baseline for 1 hour; Flight Control alerts cleared; post-incident review scheduled. Target (approved objective): 30 minutes to rollback, **unverified until a rollback drill is run (G7)**.

### 6.2 Bad migration or data corruption (restore via Time Travel)

- **Detection.** Handler errors after a deploy that included a migration; `db:verify:prod` failure in the deploy; unexpected row counts or missing data reported by users or diagnostics; Flight Control drift alerts; audit log anomalies.
- **Decision owner.** BCDR lead, with executive sponsor informed. A restore discards writes made after the restore point; this is a business decision.
- **Steps.**
  1. Stop the damage: pause the deploy pipeline, and if corruption is ongoing, disable the writing agent (`agent_configs.enabled = 0`, `CLAUDE.md` section 6) or roll back the Worker (6.1).
  2. Record the current bookmark (5.3) first so the restore itself can be undone (**[verify against current Cloudflare docs]**: restore returns the prior bookmark).
  3. Determine the target time: just before the corrupting change (deploy time from the Actions log, or migration application time).
  4. Prefer to prove the target first: restoring in place is destructive to post-target writes. If time permits, export the affected tables as they are now for later reconciliation:
     ```bash
     npx wrangler d1 export trust-radar-v2 --remote --output=<path>   # [verify against current Cloudflare docs]
     ```
     Store the output in an access-restricted location; it contains customer data.
  5. Restore (**[verify against current Cloudflare docs]**):
     ```bash
     npx wrangler d1 time-travel restore trust-radar-v2 --timestamp=<ISO-8601 UTC>
     # or --bookmark=<bookmark>
     ```
     Same for `trust-radar-v2-audit` if affected. Do not restore the audit DB to hide an incident: audit integrity is itself a control.
  6. Verify: `pnpm run db:verify:prod` from `packages/averrow-worker` (with credentials in the environment), then application smoke checks, then diagnostics.
  7. Reconcile writes made between target time and restore: from the pre-restore export, and from feed re-pull (feeds are re-pullable; customer-initiated writes such as alert triage, takedown requests and investigations may need manual re-entry or customer notice).
  8. Check the migration tracker (`npx wrangler d1 migrations list DB --remote`, script `db:migrate:status:prod`): a restore can move the `d1_migrations` table back, so the next deploy may try to re-apply migrations. Decide deliberately whether to re-apply or to hold the pipeline.
- **Communications.** Status page; customer notice if customer-created data was lost or customers acted on bad data.
- **Exit criteria.** Data validated; migration tracker consistent with schema; pipeline unfrozen; reconciliation list closed or communicated; post-incident review done.
- **Limitation.** Recovery is only as far back as the Time Travel window and lives in the same vendor account. Never tested. Independent backup is **(future)**, G1.

### 6.3 Accidental R2 object or bucket deletion

- **Detection.** Customer reports missing trademark logos; `nrd_hagezi` feed failures; `404` on image-serve for known assets; an audit or admin action record.
- **Decision owner.** BCDR lead.
- **Steps.**
  1. Stop further deletion: revoke or reduce the credential or role involved; confirm no automated process is deleting.
  2. `TRADEMARK_ASSETS`: there is **no versioning and no second copy today**. Recovery paths: re-request assets from the affected customers (asset metadata rows remain in D1 and identify org/brand/asset); re-upload via the tenant upload flow (staff may do this on a customer's behalf only through the documented crossover allowance, `CLAUDE.md` section 7).
  3. `NRD_ARCHIVE`: history older than 30 days exists only here. Recent days can be regenerated by re-running the `nrd_hagezi` feed; older history is not recoverable from the platform. **(future)** second copy.
  4. If the bucket itself was deleted, recreate it with the same name (`npx wrangler r2 bucket create <name>`, per `docs/DEPLOYMENT.md` for `averrow-nrd-archive`), because `wrangler deploy` fails when a bound bucket is missing.
- **Communications.** Customer notice to affected orgs for lost logos.
- **Exit criteria.** Bucket and bindings restored; affected assets re-supplied or loss acknowledged; deletion cause removed.

### 6.4 Cloudflare regional or account-level outage

- **Detection.** Cloudflare status page (external); inability to reach the dashboard or API; everything down at once. Internal alerting may be down too (G6), so detect externally.
- **Decision owner.** BCDR lead.
- **Steps.**
  1. Confirm scope via Cloudflare's own status page and independent checks (from outside the account).
  2. Regional or partial platform outage: wait and monitor; there is no secondary hosting. Communicate through channels that do not depend on the platform (the status page is served by the Worker and will be down too): use [out-of-band channel, e.g. a social account or third-party status page: to be established, G6] and direct email to key customers.
  3. Account suspension or lockout: invoke Cloudflare account recovery using the escrowed recovery details (G4); contact Cloudflare support (section 4).
  4. Loss of the account or its data: **there is no independent copy of the databases today (G1), so recovery from account-level data loss is not possible.** This is the principal accepted risk until G1 is closed. Source code and CI are in GitHub and the Worker can be redeployed to a new account, but the data cannot.
  5. When service returns: run diagnostics; expect backlog (feeds re-pull; Workflows may need re-dispatch, `docs/runbooks/workflow-dispatch.md`); confirm Navigator and orchestrator ticks resume.
- **Exit criteria.** Cloudflare reports resolved; diagnostics healthy; backlog draining; review whether the outage justifies funding G5.

### 6.5 Vendor outages

| Vendor | Detection | Impact and action |
|---|---|---|
| Resend | `notification_deliveries` failures; briefing not received (`platform_briefing_silent`); Resend status page | Escalation email and invites delayed. Escalation also reaches the ops UI and sticky push. Check status page and ops UI directly. Resume after recovery; the day-scoped escalation retry logic re-attempts. No data loss. |
| Google OAuth | Login failures reported; Google status | Users with an enrolled passkey can still sign in (self-hosted passkeys). Staff must be enrolled **before** an outage; verify annually. Customers without passkeys wait. Do not disable security controls to restore access. |
| Stripe | Webhook failures; Stripe status | Existing customers unaffected; new checkouts and portal sessions fail. Retry; Stripe retries webhooks. Reconcile after recovery. |
| Threat feeds | `platform_feed_at_risk`, `platform_feed_auto_paused`, `platform_feed_silent`; `feeds.at_risk[]` | Circuit breaker backs off (5 / 15 / 45 / 120 minutes) and auto-pauses (`lib/feedRunner.ts`). No action unless a Tier 1 customer commitment depends on the feed; re-enable after the upstream recovers. |
| Takedown submitters | Submission errors in takedown records | Retry later; submit manually; inform affected customers if SLAs are at risk. |
| Anthropic | Not in path (`AI_MODE=rules_only`) | None. If `AI_MODE` is later changed, `AiDisabledError` and `platform_ai_calls_failing` apply. |

- **Decision owner.** Engineering operator; BCDR lead if Sev 1/2.
- **Exit criteria.** Vendor reports resolved; queues drained; alerts cleared.

### 6.6 Secret compromise or loss

Applies to: `JWT_SECRET`, `AVERROW_INTERNAL_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_SECRET`, `STRIPE_API_KEY`/`STRIPE_WEBHOOK_SECRET`, feed and takedown API keys, the Cloudflare deploy token (CI secret `TRUST_RADAR_IMPRSN8`), `INTEGRATION_CONFIG_KEY`, and any other `Env` secret (`src/types.ts`).

- **Detection.** Unexpected use in provider logs, secret-scanning alert (`.github/workflows/secret-scan.yml`), report from a person or vendor, leaked in a commit or log.
- **Decision owner.** BCDR lead (Sev 1 until scoped).
- **Steps (compromise).**
  1. Contain: rotate the secret at the provider, then `npx wrangler secret put <NAME>` (from `packages/averrow-worker`), then redeploy if needed. Revoke the old value at the provider first when possible.
  2. `JWT_SECRET`: rotation invalidates all sessions; expect everyone to re-authenticate. For targeted revocation use `forced_logout:<user_id>` (KV) via the admin force-logout path. Note that KV revocation state is not backed up (G10).
  3. Scope the exposure from provider logs and the platform audit log; list affected customers.
  4. If customer data or credentials were exposed, follow `docs/DEPLOYMENT.md` section on credential exposure (from line 85, webhook secrets) for the pattern: treat every listed credential as compromised, rotate, notify.
  5. Assess breach-notification obligations with counsel.
- **Steps (loss of `INTEGRATION_CONFIG_KEY`).** The key encrypts stored integration configuration (`lib/integration-secret.ts`). If it is lost **and has no escrow copy (current state: unknown, G4), the encrypted values cannot be decrypted.** Recovery: set a new key, then have each customer org re-enter its integration secrets (webhook secrets, integration credentials). Prevention is escrow per policy section 8.2. Do **not** rotate this key casually: rotating without re-encrypting existing values has the same effect as loss.
- **Communications.** Customer notice if their data, integrations or webhook secrets were exposed or must be re-entered.
- **Exit criteria.** All affected secrets rotated; old values confirmed dead; scope documented; follow-ups recorded.

### 6.7 Key-person unavailability

- **Detection.** Primary BCDR lead or sole operator unreachable during an incident, or long-term absence.
- **Decision owner.** Backup BCDR lead; executive sponsor if both are unavailable.
- **Steps.**
  1. Backup lead assumes incident command. Use the contact tree and the offline copy of this plan.
  2. Gain access through the escrowed paths (policy section 8): Cloudflare account, GitHub, registrar, Resend, Stripe, secret custodians. If escrow does not exist (current state), record each missing item as an incident finding.
  3. Platform has a single `super_admin` and a single escalation recipient today (G4): if that person is the unavailable one, privileged admin actions and alert emails are blocked. Recovery runs through Cloudflare and GitHub account access, not through the application.
  4. Do not share personal credentials; use the vendor's delegated-access or recovery process.
- **Exit criteria.** Access path documented and restored; second privileged holder and second alert recipient added; gap register updated.

---

## 7. Recovery sequence (full rebuild order)

For use if the Worker or account must be rebuilt. Steps that cannot be completed today are noted.

1. Restore control-plane access (Cloudflare account, GitHub, registrar).
2. Restore secrets from escrow (G4).
3. Recreate D1 databases, R2 buckets and the legacy queues `architect-analysis` and `architect-analysis-dlq` (bound as a consumer in `wrangler.toml`; `wrangler deploy` fails without them) with the names in section 1.1 and update IDs in `wrangler.toml` if they changed.
4. Restore Tier 1b data from the latest independent backup **(future, G1)**, or Time Travel if the databases survive.
5. Apply migrations (`pnpm run db:migrate:prod`, `db:migrate:audit:prod`; `geoip`/`dnsq` equivalents) and run `pnpm run db:verify:prod`.
6. Restore `TRADEMARK_ASSETS` **(future, G8)**.
7. Deploy via `deploy-radar.yml` (or manual `pnpm run deploy` from `packages/averrow-worker`).
8. Rebuild Tier 3: trigger `geoip-refresh`; let `dns_queue` reconcile; Navigator rebuilds cubes (cube-healer every 6 hours).
9. Verify with diagnostics and smoke checks; re-dispatch stalled Workflows per `docs/runbooks/workflow-dispatch.md`.
10. Confirm Flight Control, status page and escalation email work end to end.

## 8. Related documents

- `docs/DEPLOYMENT.md` (deploy, rollback; note SESSIONS KV entry is stale, G14)
- `docs/runbooks/workflow-dispatch.md`, `docs/runbooks/analyst-d1-diagnosis.md`
- `docs/EMAIL_ROUTING_RUNBOOK.md` (abuse mailbox routing)
- `docs/SECURITY_AUDIT_2026-07-12.md`, `docs/deploy-baselines/`
- `docs/legal/DPA_DRAFT.md` (backup commitments, open item 20)
- `docs/v3/ADR_002_migration_strategy.md` (status: Proposed; not a recovery document)
- `docs/roadmap/06-DISASTER-RECOVERY.md` (aspirational, not implemented)

---

## Appendix A. DR test log template

| Field | Entry |
|---|---|
| Test ID / date | |
| Test type (restore drill / Time Travel / rollback / R2 restore / tabletop) | |
| Scenario and objective | |
| Participants | |
| Systems and environment (never test destructively against production) | |
| Recovery point used (bookmark/backup id, timestamp) | |
| Start time (UTC) / end time (UTC) / elapsed | |
| Achieved RTO vs target | |
| Achieved RPO vs target (age of recovery point) | |
| Integrity checks performed and result | |
| Pass / fail | |
| Deviations and surprises | |
| Corrective actions (owner, due date, gap register ref) | |
| Approved by / date | |

## Appendix B. Post-incident review template

| Field | Entry |
|---|---|
| Incident ID, severity, dates | |
| Detection time, declaration time, resolution time (UTC) | |
| Detected by (alert type / person / customer) | |
| Timeline of events and decisions | |
| Customer and data impact (scope, number of customers, data classes) | |
| Root cause and contributing factors | |
| What worked / what did not | |
| RTO/RPO actually achieved vs target | |
| Communications sent (status page, customers, regulators) | |
| Actions (owner, due date), added to the gap register | |
| Plan or policy changes required | |
| Review held on / attendees / approved by | |

Due within 10 business days of a Sev 1 or Sev 2 incident.

## Appendix C. Evidence checklist for auditors

Evidence an auditor can request, and where it lives or what is missing today (as of 2026-10-05).

| Evidence | Mapping | Status today |
|---|---|---|
| Approved BCDR policy and plan, with approval date and review record | CC7.5, CC9.1, A.5.29, A.5.30 | Drafts exist; **not approved** (G3) |
| Approved RTO/RPO by tier | A1.2, A1.3 | Objectives **approved 2026-10-05**; Tier 1b ≤24h RPO and Tier 1c unachievable until G1/G8 ship; policy/plan text not yet approved (G3) |
| Backup configuration and schedule (primary, audit) | A1.2, A.8.13 | **None independent** (G1); Time Travel is platform-provided |
| Backup completion and failure alerts | A1.2, A.8.13 | Not available (G1) |
| Restore test records | A1.3, CC7.5, A.8.13 | **None** (G2) |
| Rollback test records | CC7.5 | **None** (G7) |
| Incident response records and post-incident reviews | CC7.4, CC7.5, A.5.29 | Incident records exist in the platform (Flight Control to incidents, `lib/platform-status.ts`); no formal review log |
| Monitoring and alerting configuration | CC7.4, A.8.14 | Flight Control (internal); no external probe (G6) |
| Redundancy / failover design | A1.2, A.8.14 | Provider-managed only; single vendor (G5) |
| Change management: pipeline, approvals, branch protection | CC8.1 (supporting) | Pipeline in `.github/workflows/deploy-radar.yml`; branch protection **not verified** (G13) |
| Secrets inventory and escrow records | CC9.1, A.5.30 | `Env` in `src/types.ts` lists names; **no escrow record** (G4) |
| Vendor register and reviews | CC9.2 (supporting), A.5.30 | **None** (G12) |
| Customer-facing backup claims and their basis | CC2.3 (supporting) | Claim at `packages/averrow-marketing/src/pages/security.astro` line 156 ("automatic backups"), `docs/legal/DPA_DRAFT.md` line 251 and DPA open item 20 (line 571) are **not yet backed** (G11) |
| Training / awareness of the plan, contact tree currency | CC7.4 | Not recorded |
