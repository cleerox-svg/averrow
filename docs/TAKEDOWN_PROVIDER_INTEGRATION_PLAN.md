# Takedown Provider-Integration Plan

**Status:** Planning · **Owner:** Platform / SOC engineering
**Last updated:** 2026-06-23
**Related:** `docs/IMPROVEMENT_PLAN_2026-06.md` (S1–S3, S7), `CLAUDE.md` §Agent
architecture, `lib/takedown-submitters/`, `agents/sparrow.ts` (Phases E/G/H)

This document is the gap analysis + build plan for **programmatic, provider-
integrated takedown submission** — moving from today's email-only channel to
true API/form integrations with the registrars, hosts, social platforms, and
blocklists that accept structured abuse reports.

> **Shipped (2026-06-23):** the scaffolding (P1) + the first true provider-API
> submitter — **Google Web Risk** (`lib/takedown-submitters/web-risk.ts`,
> kind `api_web_risk`) — are in. It submits malicious URLs to Google's Web
> Risk Submission API (blocklist flagging in Chrome/Android), gated behind the
> live-send kill switch + a Google service-account credential
> (`GOOGLE_SERVICE_ACCOUNT_JSON`) + `provider.auto_submit_enabled`. Absent
> credential → it declines and the dispatcher falls back to email. Token
> minting lives in the reusable `lib/google-service-account.ts`. **Operator
> prerequisite:** the GCP project must be allow-listed by Google for the Web
> Risk Submission API (partner program) before flipping `auto_submit_enabled`.
>
> **Correction to earlier draft:** Cloudflare has **no public authenticated
> abuse-submission REST API** — their intake is a web form. A Cloudflare
> integration is therefore a form-POST submitter or a tuned email, not an API
> client. Web Risk was chosen as the first real-API target instead.

It is a companion to the **automation-levels** work (Off / Semi-Auto / Auto)
already landed on this branch (`lib/takedown-policy.ts`,
`takedown_authorizations.scope.mode` + `semi_auto_rules`). Levels decide
*whether* a takedown auto-submits; this plan is about *how far* the platform
can carry the submission once it does.

---

## 1. Current state (what exists today)

The submission pipeline is real and end-to-end, but the only live transport is
**abuse email**.

| Layer | File | State |
|---|---|---|
| Provider registry | `takedown_providers` (mig `0046`) | ✅ ~21 seeded providers w/ `abuse_email`, `abuse_url`, `abuse_api_url`, `abuse_api_type`, `auto_submit_enabled` |
| Submitter interface | `lib/takedown-submitters/types.ts` | ✅ `Submitter { kind, canHandle, submit }` |
| Dispatcher | `lib/takedown-submitters/index.ts` | ✅ priority chain, audit row per attempt |
| Live email submitter | `lib/takedown-submitters/email-send.ts` | ✅ sends via Resend (`TAKEDOWN_SEND_MODE='live'`) |
| Draft fallback | `lib/takedown-submitters/email-draft.ts` | ✅ queues for manual send |
| Follow-up | `lib/takedown-submitters/followup-draft.ts` | ✅ SLA-breach re-send |
| Auto-submit driver | `agents/sparrow.ts` Phase G | ✅ gated dispatch (entitlement + consent + policy + provider flag + cap) |
| Audit trail | `takedown_submissions` (mig `0152`) | ✅ outcome/ticket/response per attempt |

**The gap:** the dispatcher's `SUBMITTERS` array has a single comment —
`// future: cloudflareSubmitter, godaddySubmitter, twitterSubmitter, …` — and
no provider-specific submitter is implemented. Every auto-submit ends in an
email to `abuse_email`. Providers that expose **structured intake** (REST
abuse APIs, authenticated partner portals, blocklist submission APIs) are not
used as such; we email their abuse inbox like everyone else.

Why it matters:
- **Latency + acknowledgement.** API/portal submissions return a ticket ID and
  machine-readable status; email gets a best-effort human reply (or silence).
- **Throughput.** Email is rate-limited socially; APIs have published quotas.
- **Evidence fidelity.** Structured intake accepts typed evidence (screenshots,
  WHOIS, DNS, certificate chains) instead of a plain-text body.
- **Closed loop.** Ticket IDs let us poll resolution instead of inferring it
  from a domain rescan.

---

## 2. The submitter contract (already in place — reuse it)

New providers slot into the existing interface with **zero dispatcher
changes** beyond registration order:

```ts
export interface Submitter {
  readonly kind: string;  // 'api_cloudflare' | 'form_godaddy' | 'api_gsb' | …
  canHandle(env, takedown, provider): boolean;   // matches by provider + config + secrets present
  submit(env, takedown, provider): Promise<SubmissionResult>;  // must NOT throw
}
```

Registration (`lib/takedown-submitters/index.ts`):

```ts
const SUBMITTERS: Submitter[] = [
  cloudflareSubmitter,   // provider-specific, highest precedence
  godaddySubmitter,
  gsbSubmitter,
  // …
  emailSendSubmitter,    // generic live email (TAKEDOWN_SEND_MODE='live')
  emailDraftSubmitter,   // generic draft fallback
];
```

First `canHandle()===true` wins, so a provider-specific submitter shadows the
email fallback the moment it's registered and its secret is configured. If its
secret is absent, `canHandle()` returns false and we fall through to email —
**no provider ever loses coverage during rollout.**

Each submitter must return `outcome` per the existing semantics:
`submitted` (provider acknowledged), `rejected` (4xx / explicit no),
`failed` (5xx / network / timeout → Phase G leaves the takedown re-tryable),
`queued` (recorded, no outbound side effect yet).

---

## 3. Provider landscape & integration approach

Grouped by intake type. Each row is a candidate submitter.

### 3.1 Hosting / CDN / infrastructure

| Provider | Integration | Notes |
|---|---|---|
| **Cloudflare** | REST — Abuse Reports API | Phishing/malware categories; returns case number. Highest-value first target: huge share of malicious-domain hosting. |
| **AWS** | Form/email hybrid (`abuse@amazonaws.com` + Trust & Safety portal) | No open API; structured email is the realistic ceiling. Keep on email submitter but with AWS-tuned template. |
| **Google Cloud / Workspace** | Form + GSB (below) | Same — template, not API. |
| **OVH / Hetzner / DigitalOcean / Vercel / Netlify / GitHub Pages** | Mostly abuse email or web form | Tier-2: form-POST submitters where a stable form exists; otherwise tuned email. |

### 3.2 Registrars

| Provider | Integration | Notes |
|---|---|---|
| **GoDaddy / Namecheap / Tucows** | Abuse web form (no public API) | Form-POST submitter; many registrars also honor RDAP-discovered abuse contact email. |
| **Generic registrar** | **RDAP abuse contact** → email | Add an RDAP resolver (`lib/rdac` / reuse DNS infra) to discover the registrar abuse email when the provider isn't in `takedown_providers`. Raises coverage for the long tail. |

### 3.3 Social platforms

| Provider | Integration | Notes |
|---|---|---|
| **Twitter/X, Instagram/Facebook (Meta), LinkedIn, TikTok, YouTube** | Impersonation/brand web forms; some partner APIs behind brand-protection programs | Forms are per-platform and change; treat as form-POST submitters with per-platform field maps, fall back to email/portal URL surfaced to the analyst. Partner-API access (Meta Brand Rights Protection, etc.) is a business-development dependency, flag separately. |

### 3.4 Blocklists / reporting (defensive, high leverage)

| Provider | Integration | Notes |
|---|---|---|
| **Google Safe Browsing** | Submit-a-site / Web Risk API | Gets the URL flagged in Chrome/Android — protects users even before host acts. This is **S2** in the improvement plan. |
| **APWG eCrime eXchange** | API submission | Phishing repository; member submission. |
| **Netcraft** | Report API/email | Takedown service + blocklist. |
| **PhishTank / abuse.ch** | API | Community blocklists. |

Blocklist submission is the **best first investment after Cloudflare**: it's
defensive (no legal exposure from acting on someone else's infra), high-volume-
friendly, and immediately protects the customer's users.

---

## 4. Phased build plan

Sequenced by value/effort. Each phase is independently shippable behind the
existing three-layer gate (`TAKEDOWN_SEND_MODE`, `provider.auto_submit_enabled`,
signed authorization) plus the new automation `mode`.

### Phase P1 — Submitter scaffolding hardening (1 sprint)
- Add `submitter_kind` conventions for API/form (`api_<p>`, `form_<p>`).
- Add a small HTTP helper (`lib/takedown-submitters/http.ts`) with timeout,
  idempotency key, redaction, and `SubmissionResult` mapping — so each
  provider submitter is ~50 lines.
- Add per-provider secret resolution helper (`canHandle` returns false when the
  secret is missing → graceful email fallback).
- Provider config: add `abuse_api_auth` / credential-ref column to
  `takedown_providers` (migration) so the secret name is data, not code.

### Phase P2 — Google Web Risk submission ✅ SHIPPED (first real integration)
- `webRiskSubmitter` (`api_web_risk`): POST to
  `…/projects/{projectId}/uris:submit`, capture the returned operation name →
  `ticket_id`. Reusable OAuth token minting in `lib/google-service-account.ts`.
- Gated on live-send + service-account secret + `auto_submit_enabled`; declines
  → email fallback when unconfigured.
- **Remaining operator step:** GCP project allow-listing for the Web Risk
  Submission API, then a verification run (draft → live on a sample) before
  flipping `auto_submit_enabled=1` on the 'Google Safe Browsing' provider row.

### Phase P3 — Registrar fan-out via NetBeacon ✅ SHIPPED (2026-06-23)
- `netbeaconSubmitter` (`api_netbeacon`): reports domain abuse to the DNS
  Abuse Institute's NetBeacon Reporter API, which normalizes to X-ARF,
  enriches, and **routes to the correct participating registrar/registry**.
  One integration → the whole participating-registrar network, vs. a client
  per registrar. Highest-leverage API target for domain takedowns.
- Category derivation (phishing/malware/botnet/spam) from module + evidence;
  registrable-domain extraction from the target.
- Gated on live-send + `NETBEACON_API_KEY` + `abuse_api_type='netbeacon'` +
  a resolvable domain; declines → email fallback when unconfigured. Exact
  host/path/auth provisioned at reporter onboarding — base overridable via
  `NETBEACON_API_BASE` with no code change.
- migration 0224 seeds the 'NetBeacon' provider row (provider_type
  'reporting', auto_submit_enabled 0).
- **Remaining operator step:** approved DNS Abuse Institute reporter account
  + `NETBEACON_API_KEY` secret + a live verification report, then flip
  `auto_submit_enabled=1`.

  **Routing (✅ wired 2026-06-25):** the dispatcher selects a submitter by the
  takedown's *provider* (`abuse_api_type`). Sparrow Phase E now routes **domain**
  takedowns to the NetBeacon provider row via
  `preferredDomainReportingProvider()` — but only when NetBeacon is actually
  dispatchable (live send mode + `NETBEACON_API_KEY` + the NetBeacon row's
  `auto_submit_enabled=1`). Otherwise it keeps the resolved host/registrar
  contact, so draft-mode / unconfigured behavior is unchanged and a domain is
  never stranded on the NetBeacon row (which has no `abuse_email`). The gate
  mirrors `netbeaconSubmitter.canHandle` exactly, so whenever Phase E routes to
  NetBeacon, Phase G can dispatch it. Still single-channel (first match) —
  registrar-**and**-blocklist fan-out remains the §6 design decision.

### Phase P4 — GoDaddy Abuse API ✅ SHIPPED (2026-06-25) + more blocklists
- `godaddySubmitter` (`api_godaddy`) ✅ — files an abuse ticket via GoDaddy's
  Abuse API (`POST /v1/abuse/tickets`, `sso-key KEY:SECRET` auth, `type`
  derived to GoDaddy's enum, `ticketId` captured). The one major registrar
  with a real authenticated reporter API. migration 0225 flips the GoDaddy
  provider row to `abuse_api_type='godaddy'` while keeping abuse@godaddy.com
  as the email fallback. Gated on live + `GODADDY_API_KEY`/`GODADDY_API_SECRET`
  + `auto_submit_enabled=1`; OTE sandbox via `GODADDY_API_BASE`.
  - **Precedence note:** Phase E's NetBeacon override (when enabled) routes
    *all* domains to NetBeacon, which would shadow the direct GoDaddy path for
    GoDaddy-registered domains. That's acceptable today (NetBeacon reaches
    GoDaddy via the participating-registrar network); sending to **both** is
    the fan-out work below. When NetBeacon is off, GoDaddy-registered domains
    resolve to the GoDaddy row and use the direct API.
- Still TODO: `apwgSubmitter`, `netcraftSubmitter`, abuse.ch/URLhaus. Additive
  — a domain can be sent to **both** its registrar and the blocklists. Extend
  Phase G to allow **multiple submitters per takedown** (fan-out) rather than
  first-match-only, OR model blocklist submission as a separate Phase G2 pass.
  (Design decision — see §6.)

### Phase P4 — Registrar coverage via RDAP + top forms (1–2 sprints)
- RDAP abuse-contact resolver for the long tail → tuned email submitter.
- `form_godaddy`, `form_namecheap` where forms are stable.

### Phase P5 — Social platform forms / partner APIs (ongoing)
- Per-platform form submitters; partner-API integrations gated on BD access.
- Highest maintenance burden (forms drift) — instrument failure rate per
  platform and fall back to analyst-surfaced portal URL aggressively.

### Phase P6 — Evidence packages (depends on S3)
- Structured evidence (screenshot, WHOIS, DNS, cert chain) attached to
  API/form submissions. Requires the S3 evidence-assembly work (R2 bundle).

---

## 5. Cross-cutting requirements

**Secrets.** Each integration needs a Worker secret (`CLOUDFLARE_ABUSE_TOKEN`,
`GSB_API_KEY`, …). Never hardcode (`CLAUDE.md` §4). `canHandle()` must check the
secret's presence so absence = email fallback, not a 500.

**Idempotency.** Reuse the deterministic-key pattern (`lib/anthropic.ts` model)
so a Phase G retry doesn't double-file. Key = (takedown_id + provider_id +
submitter_kind). Persist the key on `takedown_submissions` to dedupe.

**Auth/consent unchanged.** Provider-API submission is still gated by the
signed `takedown_authorizations` + module entitlement + automation `mode`. A
new transport does **not** widen what we're allowed to submit.

**Observability.** `takedown_submissions` already records outcome/status/ticket.
Add a per-provider success-rate panel to `/api/internal/platform-diagnostics`
(or the ops takedown queue) so operators see which submitters are healthy
before flipping `auto_submit_enabled`.

**Legal posture.** Acting on infra (host/registrar takedown) carries more
exposure than blocklist/reporting submission. The MSA (`takedown-msa.ts`) and
the signed scope already cover "submit on your behalf"; keep blocklist
submission and infra takedown distinguishable in the audit trail
(`submitter_kind`) for differentiated review.

---

## 6. Open design decisions

1. **One submitter per takedown vs. fan-out.** Today the dispatcher is
   first-match-wins. Blocklist submission (P3) wants host **and** GSB **and**
   APWG for the same takedown. Options: (a) Phase G2 second pass for blocklists;
   (b) make the dispatcher return N results and write N `takedown_submissions`
   rows. **Recommendation:** (a) for P3 (least disruption), revisit (b) if
   fan-out generalizes.
2. **Form submitters durability.** Web forms drift and break silently. Gate
   each form submitter on a synthetic canary + auto-demote to email on a
   failure-rate threshold (mirror the feed circuit-breaker pattern in
   `lib/feedRunner.ts`).
3. **`provider_method` vs. submitter selection.** `takedown_requests.provider_method`
   ('email'|'form'|'api') and `takedown_providers.abuse_api_type` overlap.
   Decide one source of truth for "how do we reach this provider" — recommend
   the provider row, with the takedown column as a captured snapshot.
4. **Polling resolution via ticket_id.** Once API submitters return ticket IDs,
   add a Sparrow phase that polls provider status to move `submitted →
   taken_down` automatically instead of relying on domain rescan (Phase F).

---

## 7. Definition of done (per provider submitter)

- [ ] `Submitter` implementation with `canHandle` gating on provider match +
      secret presence.
- [ ] Maps `module_key`/`target_type` → provider category.
- [ ] Returns `submitted` with `ticket_id` on success; `rejected`/`failed`
      mapped correctly; never throws.
- [ ] Idempotency key persisted; retry-safe.
- [ ] Registered ahead of `emailSendSubmitter` in `SUBMITTERS`.
- [ ] Operator verification pass in draft mode; `auto_submit_enabled` flipped
      only after a clean sample.
- [ ] Success-rate visible in diagnostics.
- [ ] `docs/API_REFERENCE.md` updated if any new internal endpoint is added.
