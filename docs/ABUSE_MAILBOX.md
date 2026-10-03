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
      • backscatter guard (POSITIVE authentication — see below)
      • throttle: per sender, per sender REGISTRABLE domain, per org,
        global (rolling 60 min)
      • INSERT abuse_inbox_messages (classification='pending') — the
        INSERT itself carries responder_suppressed_reason (fail-closed)
      • send instant ack email (guard passed, not throttled, not follow-up)
      • dispatch AbuseMailboxTriageWorkflow (id abuse-<messageId>) for
        EVERY non-throttled, non-follow-up row, suppressed or not
  → AbuseMailboxTriageWorkflow              src/workflows/abuseMailboxTriage.ts
      (steps in src/lib/abuse-mailbox-triage-pipeline.ts)
      1. rules verdict                       src/lib/abuse-mailbox-rules(-runner).ts
           M1 intel correlation / M2 named-threat IOC|regex /
           M3 device-code ≥0.85 → phishing HIGH;  M4 risky attachment →
           malware CRITICAL;  else H1 heuristic score → "likely phishing"
           HIGH;  else ambiguous / review (never benign/spam)
         + AI second opinion only when AI_MODE allows and rules said review
      2. sleep ~2 minutes
      3. deliverAbuseDetermination — atomic determination_sent_at claim;
         THROWS on a transient send failure so the step retries
      4. agent_activity_log row (agent_id abuse_mailbox_triage,
         event_type abuse_triage_complete)
  → hourly `17 * * * *` agent (Sifter) — the sweeper
      • rules pass over pending rows (≤50, NEWEST first)
      • runAbuseClassifierBackfill (AI; skipped under rules_only) — only
        pending rows and rules REVIEW rows; never a rules malicious row
      • sweepAbuseDeterminations — emails verdicts the Workflow missed
        (never throws; failures land in the run output)
```

### Backscatter guard (positive authentication)

Acks and determinations go to the forward's header-From, which a sender can
forge. `decideBackscatterGuard` (`src/lib/abuse-mailbox-responder.ts`) replies
ONLY when all of these hold, and the decision is written by the INSERT itself
— a row is never briefly email-eligible:

1. The From header parses as exactly ONE mailbox (`parseSingleRecipient`:
   quoted display names allowed; any other `,`/`;`, more than one `@`, or a
   malformed `<…>` rejects). That normalized address is stored as
   `forwarded_by_email` and is the exact Resend `to`.
2. Its registrable domain equals the SMTP envelope sender's.
3. The FIRST (topmost) plain `Authentication-Results` header has authserv-id
   exactly `mx.cloudflare.net` and reports `dmarc=pass` with `header.from`
   equal to the From domain. If the topmost instance carries any other
   authserv-id, or there is no `Authentication-Results` at all → suppressed
   (`backscatter:no_trusted_auth`). The guard never searches further down
   for a CF-labelled instance (everything below the topmost arrived with the
   message and can carry any label), and **never** reads
   `ARC-Authentication-Results` (sender-suppliable unless the whole ARC chain
   is validated, which we don't do). Prod evidence (read-only D1, last 50
   `raw_headers` JSON maps, 2026-10): 50/50 carry a plain
   `authentication-results` starting with `mx.cloudflare.net`, never joined
   with a second instance; the upstream provider's results (e.g.
   `mx.google.com`) appear only in `arc-authentication-results` — Cloudflare
   Email Routing always prepends its own AR at the top. Headers are read in
   wire order from the raw header block (`extractHeaderInstances`), not
   `message.headers` — `Headers.get()` joins duplicates with `", "`, which
   loses instance boundaries.

Reason codes in `responder_suppressed_reason`: `backscatter:invalid_recipient`,
`backscatter:domain_mismatch`, `backscatter:no_trusted_auth`,
`backscatter:dmarc_not_pass`. Suppressed rows are still classified (the
Workflow runs) but never emailed.

**Guard-version marker.** The guard-aware INSERT also writes
`responder_guard_version = 1` (`RESPONDER_GUARD_VERSION`). The determination
claim, the sweeper, the `17 * * * *` cron gate and
`idx_abuse_inbox_undelivered` all require it `IS NOT NULL`, so a row inserted
by a pre-guard Worker (e.g. between migration 0273 and the Worker deploy —
`responder_suppressed_reason` and the marker both NULL) is classified but
never emailed. The ack is sent only inline by that same INSERT path.

#### Security notes / residual risk

- **DMARC authenticates the domain, not the mailbox.** `dmarc=pass` proves
  the message was sent by infrastructure authorized for the From *domain*;
  it does not prove the sender controls the specific From *mailbox*. On a
  shared-tenant domain (a large mailbox provider, a university, any domain
  where many unrelated users can send authenticated mail), user A can send a
  report with `From: userB@samedomain` that still passes SPF/DKIM alignment
  if the provider doesn't enforce mailbox-level From binding — and our ack /
  determination would go to user B. Impact is bounded: at most one ack + one
  determination per report, fixed non-model copy, subject defanged, per
  sender / registrable-domain / org / global flood throttle, and
  List-Unsubscribe honoured. Not mitigated further by design (no per-mailbox
  verification step); revisit if abuse is observed.
- **No model text reaches a submitter.** Analyst notes are fixed copy
  (`RULES_EMAIL_NOTE` / `AI_EMAIL_NOTE`); the Sonnet deep-analysis narrative
  (`deep_analysis`, "Investigator findings") is shown only in the operator /
  admin UI and is never put in the determination email; the
  `abuse_mailbox_verdict` notification `message` is fixed copy per verdict
  (`RULES_OPERATOR_NOTE` / `AI_OPERATOR_NOTE`), never the model's reasoning.

### Rules evidence

- **M1** — an active, non-`abuse_mailbox` threat that either matches a message
  URL EXACTLY (any feed), or lists the message HOST itself
  (`malicious_domain` = host) from a domain-level phishing feed (`openphish`,
  `phishtank`, `phishing_database`) or with VT malicious > 0 / GSB flagged.
  `urlhaus` / `threatfox` count for exact URLs only. Domain-level matches never
  count on multi-tenant / redirector hosts (`brandDetect.isMultiTenantHost`:
  github.com, *.googleusercontent.com, dropbox, sharepoint, discord CDN,
  pastebin, shorteners, safelinks / urldefense wrappers, google.com, …) — but a
  platform TENANT subdomain (`x.pages.dev`, `x.workers.dev`, `x.duckdns.org`)
  is single-tenant and does count; only the bare platform apex is shared. The
  brand's own domain and `brand_safe_domains` (lib/safeDomains.ts, KV-cached)
  never count. Outlook safelinks, Proofpoint urldefense (v1–v3),
  `google.com/url` and `l.facebook.com` wrappers are unwrapped first.
- **M2** — `matchStrongestNamedThreat`: IOC domain / IOC URL / regex only.
  IP-only IOC hits don't qualify; regex hits on `device_code_phishing`
  entries (they match the real microsoft.com/devicelogin) don't qualify —
  M3 (≥0.85) owns that case; strong-signal entries outrank keyword scores.
- **M4** — executable / script / disk-image extensions (`.com` excluded —
  "amazon.com"-style filenames).
- **H1** — heuristic "likely phishing" (`lib/abuse-mailbox-heuristics.ts`),
  only when M1–M4 did not fire. Scored signals in five families: *identity*
  (sender isn't the claimed brand / lookalike sender domain), *lure*
  (account-locked, data-deletion, verify-credentials, payment, sign-in alert,
  delivery wording + urgency), *link* (raw IP, punycode, `user@host` trick,
  free-hosting tenant or shared gateway, shortener, abused TLD, lookalike or
  brand-in-foreign host, link ≠ sender), *attachment* (`.html`/`.svg`/macro
  Office/`.one`…), *auth* (DMARC/SPF/DKIM fail, forward-as-attachment only).
  Fires at score ≥ 5 across ≥ 2 families, one of them *lure* or
  *attachment*. → phishing / HIGH / escalate, confidence 60–80 (below every
  M rule). Never promotes. The email says **"Likely phishing"** with its own
  fixed note, never "Phishing confirmed" (product decision 2026-10-03). The
  reporter's own address is never scored as the sender. Below threshold,
  review rows carry `h1_score:N` + the signal codes for operators.

Promotion to `threats`: EXACT matched URLs only (M1 exact-URL, M2 IOC-URL),
cap 20, never the sender IP. Domain-level matches, M3 and M4 never promote.
The M1 qualifying threat ids replace `correlated_threat_ids` in the same
guarded verdict UPDATE (the determination's "N indicators match" count reads
them).

Rules verdicts skip the Sonnet deep analyzer. Determination emails show no
confidence % for rules verdicts, and "Analyst notes" is ALWAYS fixed copy —
one sentence per rule (`RULES_EMAIL_NOTE`) or per AI classification
(`AI_EMAIL_NOTE`); model reasoning is never emailed (prompt-injection). An
automated verdict never says "Takedown initiated" — it reads "Reported to our
threat team". The echoed subject is defanged (scheme stripped, `.` → `[.]`).
The Sonnet deep-analysis narrative ("Investigator findings") is never in the
email for any verdict source — operator / admin UI only.

### Backlog

Rows older than 2 days (`ABUSE_RESPONSE_LOOKBACK`) are classified but get no
promotion, notification or email: the rules verdict UPDATE stamps
`responder_suppressed_reason='backlog:stale'`, and the determination claim
itself refuses rows older than the lookback.

### Delivery semantics (at-most-once)

`deliverAbuseDetermination` claims the row (`determination_sent_at = now`)
and only then calls Resend. If the isolate dies between the claim and the
release, the row stays claimed and that report gets no determination — an
accepted at-most-once window, chosen over duplicates. A transient Resend
failure releases the claim; the Workflow step throws and retries with
backoff, and the hourly sweeper is the backstop. A lost response after
Resend accepted the email is covered by the `Idempotency-Key`
(`abuse-determination/<id>`; acks use `abuse-ack/<id>`). Resend 400/422 is a
permanent rejection: `responder_suppressed_reason='determination:resend_rejected'`.

### Notifications

`abuse_mailbox_verdict` (HIGH/CRITICAL phishing|malware): brand-bound
captures go to brand subscribers who are ACTIVE `org_members` of the
reporting org (`createNotification`'s `restrictToOrgMembers`), plus opted-in
super_admins; unbound captures go to super_admins. The forwarded subject is
never in the title, and the `message` is fixed copy (`RULES_OPERATOR_NOTE`
for rules verdicts, `AI_OPERATOR_NOTE` for AI verdicts) — never model
reasoning.

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
| Flood throttle (sender 20/h, registrable domain 50/h, org 200/h, global 1000/h) | `src/lib/abuse-mailbox-throttle.ts` |
| Ack / determination emails, backscatter guard | `src/lib/abuse-mailbox-responder.ts` |
| Rules verdict (pure) | `src/lib/abuse-mailbox-rules.ts` |
| Rules pass (I/O, promotion, notifications) | `src/lib/abuse-mailbox-rules-runner.ts` |
| Exactly-once determination delivery + sweeper | `src/lib/abuse-mailbox-determination.ts` |
| Per-message Workflow (`ABUSE_MAILBOX_TRIAGE`) | `src/workflows/abuseMailboxTriage.ts` |
| Classifier (Haiku, optional second opinion) | `src/lib/abuse-mailbox-classifier.ts` |
| Deep analysis (Sonnet) | `src/lib/abuse-mailbox-deep-analyzer.ts` |
| Named-threat catalog match | `src/lib/named-threat-matcher.ts` |
| One-click unsubscribe (RFC 8058) | `src/handlers/abuseMailboxUnsubscribe.ts` |
| Ops UI | `packages/averrow-ops/src/features/admin/AdminAbuseMailbox.tsx` |
| Tenant UI | `packages/averrow-tenant/src/features/abuse-mailbox/AbuseMailbox.tsx` |
| Tenant API client | `packages/averrow-tenant/src/lib/abuseMailboxModule.ts` |

### Classifier dispatch & status

The classifier is a registered first-class `AgentModule` —
**`abuse_mailbox_classifier`** (display name **Sifter**),
`src/agents/abuseMailboxClassifier.ts`. It runs the rules pass, then the
batch `runAbuseClassifierBackfill`, then the determination sweeper, and is
dispatched via `executeAgent` from the dedicated `17 * * * *` cron
(`src/cron/orchestrator.ts`, only when there are pending rows or recent
undelivered determinations), so every run writes `agent_runs` + emits `agent_events` and surfaces
in Flight Control, platform-diagnostics, and the `/v2/agents` mesh. It can
also be triggered manually via `/api/internal/agents/abuse_mailbox_classifier/run`.

The standalone `POST /api/admin/abuse-mailbox/run-classifier` drain
endpoint runs the same order as the cron — `runAbuseRulesPass` then
`runAbuseClassifierBackfill` — directly (bypassing the runner); every email
it causes goes through the atomic determination claim. It's an operator tool
for ad-hoc backlog draining and intentionally does not create an
`agent_runs` row. Response: the AI pass's fields at the top level (unchanged)
plus `rules` and `ai` sub-objects.

Cost is ~$0.001/message via Haiku; declared `monthlyTokenCap` is 10M
(`costGuard: 'enforced'`).

Poison-pill protection: a per-message retry cap of 3 auto-graduates a
`pending` message to `ambiguous` rather than looping (`classification_attempts`,
`last_classify_error`). Rules review rows are never auto-graduated — they
stay `classified_by='rules'` and drop out of the AI selector at the cap.

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
| `0273` | `responder_suppressed_reason` — why no ack/determination email is sent (`backscatter:*`, `determination:*`, `backlog:stale`, `legacy:pre_guard` backfill for every undelivered pre-0273 row); `forwarded_by_reg_domain` (throttle key); `responder_guard_version` (guard-version marker — `1` written only by the guard-aware INSERT; NULL = pre-guard row, never emailed); indexes `idx_abuse_inbox_reg_domain_recent`, `idx_abuse_inbox_received_at`, partial `idx_abuse_inbox_triage_queue` (`classification IN ('pending','ambiguous')`), partial `idx_abuse_inbox_undelivered` (`determination_sent_at IS NULL AND responder_suppressed_reason IS NULL AND responder_guard_version IS NOT NULL`) |

`classified_by` ∈ `ai | rules | manual | auto_graduated` (no CHECK).

`classification` ∈ `pending | phishing | spam | benign | malware |
ambiguous | follow_up`. `status` ∈ `new | investigating | resolved |
dismissed`. `severity` ∈ `LOW | MEDIUM | HIGH | CRITICAL`.

Supporting tables:
- **`org_abuse_aliases`** (PK `org_id`, UNIQUE `alias`,
  `forwarding_instructions`) — maps an inbound alias to the owning org.
  Averrow's own platform org + production aliases are seeded by
  `0180_averrow_self_abuse_mailbox.sql` (+ `0182`, `0183`). Per-tenant
  `verify-<slug>@averrow.com` aliases are auto-minted on org create and
  re-provisionable via `lib/abuse-alias-provision.ts` (Tier 3).
- **`org_abuse_branding`** (PK `org_id`, `0231`) — per-org responder
  branding (Tier 3): display name, product name, tagline, logo, accent /
  header colours, subject prefix, footer links. Resolved (validated +
  defaults-merged) by `lib/abuse-mailbox-branding.ts` and threaded through
  the ack + determination emails; a null/disabled/invalid value falls back
  to the Averrow default so behaviour is unchanged for orgs that haven't
  opted in. The envelope **From stays on `abuse-noreply@averrow.com`** (an
  authenticated domain) — only the display name + look are branded.
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
   instant; the determination follows ~2 minutes later via the per-message
   Workflow (malicious verdict on a rules match, otherwise an "analyst will
   review" determination), with the hourly sweeper as backstop.

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
