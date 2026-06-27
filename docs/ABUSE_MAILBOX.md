# Abuse Mailbox

Customer-branded report-fraud inbox with AI auto-triage and automated
response. Customers (and Averrow's own SOC) forward suspicious emails to a
dedicated alias; the platform parses, classifies, enriches, correlates,
and responds — promoting confirmed phishing/malware into the threat
pipeline and emailing the reporter a determination.

This is the canonical reference for the feature. It is internal/staff
documentation — see the marketing page (`/abuse-mailbox`) for the
customer-facing pitch and the in-app module for the customer setup flow.

---

## 1. Pipeline at a glance

```
Inbound email (Cloudflare Email Routing)
  → email() handler                         src/index.ts:115
  → handleAbuseMailboxEmail()               src/handlers/abuseMailboxEmail.ts:62
      • resolve alias → org_abuse_aliases → org_id
      • parse outer headers/body
      • extract the ORIGINAL suspicious mail (rfc822 attach > inline forward > envelope)
      • extract URLs + attachments
      • parse SPF/DKIM/DMARC + sender IP
      • correlate URLs vs existing threats
      • match monitored brands
      • per-sender/per-domain throttle
      • INSERT abuse_inbox_messages (classification='pending')
      • send instant ack email
  → runAbuseClassifierBackfill()            src/lib/abuse-mailbox-classifier.ts
      (orchestrator hourly cron when pending > 0, or manual endpoint)
      • Haiku classification → phishing/spam/benign/malware/ambiguous
      • action → safe/review/escalate/takedown, severity computed in code
      • on HIGH/CRITICAL phishing|malware:
          - promote URLs → threats
          - Sonnet deep analysis → deep_analysis
          - send 24h determination email
          - fire in-app notifications
```

Ingestion routing (`src/index.ts:137`): local-parts matching `verify-*`,
`verify_*`, `report-*`, `abuse-*`, or the platform set
`{abuse, phishing, report, security}` dispatch to the abuse-mailbox
handler. DMARC mail is split off first; everything else falls through to
the spam-trap handler. Unregistered aliases are dropped silently (no
bounce).

---

## 2. Components

| Concern | File |
|---|---|
| Email entry point | `src/index.ts:115` (`email()` handler) |
| Ingestion handler | `src/handlers/abuseMailboxEmail.ts` |
| IOC parsing (SPF/DKIM/DMARC, sender IP) | `src/lib/abuse-mailbox-iocs.ts` |
| Brand matching | `src/lib/abuse-mailbox-brand-match.ts` |
| Sender/domain throttle | `src/lib/abuse-mailbox-throttle.ts` |
| Ack / determination emails | `src/lib/abuse-mailbox-responder.ts` |
| Classifier (Haiku) | `src/lib/abuse-mailbox-classifier.ts` |
| Deep analysis (Sonnet) | `src/lib/abuse-mailbox-deep-analyzer.ts` |
| Named-threat catalog match | `src/lib/named-threat-matcher.ts` |
| One-click unsubscribe (RFC 8058) | `src/handlers/abuseMailboxUnsubscribe.ts` |
| Ops UI | `packages/averrow-ops/src/features/admin/AdminAbuseMailbox.tsx` |
| Tenant UI | `packages/averrow-tenant/src/features/abuse-mailbox/AbuseMailbox.tsx` |
| Tenant API client | `packages/averrow-tenant/src/lib/abuseMailboxModule.ts` |

### Classifier dispatch & status

The classifier runs as a **backfill helper**, not a registered
`AgentModule` (agent id `abuse_mailbox_classifier`). It is dispatched from
the orchestrator hourly cron (`src/cron/orchestrator.ts`) when the pending
count > 0, and on demand via `POST /api/admin/abuse-mailbox/run-classifier`.

> **Note (CLAUDE.md §6):** because it isn't a registered AgentModule, the
> classifier does **not** write `agent_runs` / `agent_events` rows, so it
> does not appear in the `/v2/agents` mesh or platform diagnostics.
> Promoting it to a first-class agent (for run history + diagnostics
> visibility) is the natural next hardening step if this becomes a
> headline paid product. Cost is ~$0.001/message via Haiku.

Poison-pill protection: a per-message retry cap of 3 auto-graduates a
message to `ambiguous` rather than looping (`classification_attempts`,
`last_classify_error`).

---

## 3. Data model

Primary table `abuse_inbox_messages`, base migration
`migrations/0150_abuse_mailbox.sql`, extended additively:

| Migration | Adds |
|---|---|
| `0150_abuse_mailbox.sql` | base table (org_id, brand_id, received_at, forwarded_by_email, inbound_alias, original_from, original_subject, original_body_snippet, attachment_count, url_count, classification, classified_by, classification_confidence, classification_reason, ai_assessment, ai_action, severity, status, ack_sent_at, determination_sent_at, timestamps) |
| `0184` | raw capture: `raw_body`, `raw_headers`, `extracted_urls`, `attachment_names`, `raw_size_bytes` |
| `0185` | throttle: `forwarded_by_domain`, `throttled`, `throttle_reason` |
| `0187` | IOCs: `auth_results`, `sender_ip`, `correlated_threat_ids`, `promoted_threat_ids` |
| `0188` | `deep_analysis` |
| `0196` | retry: `classification_attempts`, `last_classify_error` |
| `0206` | named threats: `detected_technique`, `named_threat_id`, `named_threat_name` |

`classification` ∈ `pending | phishing | spam | benign | malware |
ambiguous | follow_up`. `status` ∈ `new | investigating | resolved |
dismissed`. `severity` ∈ `LOW | MEDIUM | HIGH | CRITICAL`.

Supporting tables:
- **`org_abuse_aliases`** (PK `org_id`, UNIQUE `alias`,
  `forwarding_instructions`) — maps an inbound alias to the owning org.
  Averrow's own platform org + production aliases are seeded by
  `0180_averrow_self_abuse_mailbox.sql` (+ `0182`, `0183`).
- **`org_modules`** — the `abuse_mailbox` entitlement key is registered in
  `migrations/0145_org_modules.sql`. The tenant UI is gated on this.

---

## 4. API routes

All routes below should also be reflected in `docs/API_REFERENCE.md`.

### Tenant (`requireAuth` + `requireModule('abuse_mailbox')`)
Handlers in `src/handlers/tenantAbuseMailboxModule.ts`, routed in
`src/routes/tenant.ts`:

| Method | Path |
|---|---|
| GET | `/api/orgs/:orgId/modules/abuse-mailbox` (summary) |
| GET | `/api/orgs/:orgId/modules/abuse-mailbox/messages` (`?brandId` optional) |
| GET | `/api/orgs/:orgId/modules/abuse-mailbox/messages/:id` |
| PATCH | `/api/orgs/:orgId/modules/abuse-mailbox/messages/:id/status` |
| GET | `/api/orgs/:orgId/modules/abuse-mailbox/intel` |

### Admin / Averrow self-org (`requireSuperAdmin` unless noted)
Handlers in `src/handlers/adminAbuseMailbox.ts`, routed in
`src/routes/admin.ts`:

| Method | Path | Guard |
|---|---|---|
| GET | `/api/admin/abuse-mailbox` (summary) | super_admin |
| GET | `/api/admin/abuse-mailbox/messages` | super_admin |
| GET | `/api/admin/abuse-mailbox/messages/:id` | super_admin |
| PATCH | `/api/admin/abuse-mailbox/messages/:id/status` | super_admin |
| GET | `/api/admin/abuse-mailbox/intel` | super_admin |
| POST | `/api/admin/abuse-mailbox/run-classifier` | admin |
| POST | `/api/admin/abuse-mailbox/messages/:id/unthrottle` | super_admin |

### Public (no auth — RFC 8058 one-click unsubscribe)
Handler `src/handlers/abuseMailboxUnsubscribe.ts`, routed in
`src/routes/public.ts`:

| Method | Path |
|---|---|
| POST | `/api/abuse-mailbox/unsubscribe` |
| GET | `/api/abuse-mailbox/unsubscribe` |

---

## 5. Provisioning a customer (operational runbook)

The feature is fully built in code on both ops and tenant. Turning it on
for a customer org is operational, not engineering:

1. **Grant the entitlement** — add an `org_modules` row with key
   `abuse_mailbox` for the org (status `active` or `trial`). The tenant
   sidebar and module surface gate on this; without it the customer sees
   the locked "Unlock" affordance.
2. **Provision the alias** — insert the org's `org_abuse_aliases` row:
   a unique inbound alias (e.g. `verify-<tenant>@averrow.ca`) plus
   `forwarding_instructions`. Until this exists, inbound mail to the alias
   is dropped silently.
3. **Confirm Email Routing** — the alias local-part must match one of the
   accepted prefixes (`verify-*`, `report-*`, `abuse-*`) or the platform
   set, so `src/index.ts` routes it to the abuse-mailbox handler.
4. The customer then forwards suspicious mail to their alias; ack is
   instant, determination follows within ~24h for escalations.

---

## 6. Customer-facing surfaces

- **Setup / how-to-forward:** the marketing product page `/abuse-mailbox`
  (section `#setup`). The tenant UI links here from the empty-inbox state.
- **Product pitch:** `/abuse-mailbox` (marketing) + a pricing line item.
- **In-app:** tenant module at `/modules/abuse-mailbox` shows the alias,
  forwarding instructions, the unified inbox, per-message drill-down, and
  an intel summary.

Keep all customer-facing copy non-proprietary per CLAUDE.md §9b — no
internal agent codenames (Sentinel/ASTRA/etc.), no infra detail.
