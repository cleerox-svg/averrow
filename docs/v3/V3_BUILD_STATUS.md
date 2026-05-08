# v3 Build Status — 2026-05-08 session

Snapshot of what landed in this session and what's left for v3
to be launch-ready. Pairs with `eager-moseying-papert.md` (the
plan) and `PHASE_0_CLOSEOUT.md` (the pre-build audit).

## TL;DR

**28 PRs merged in one continuous session**, covering the full
v3 customer-tenant build PLUS the Phase D launch story PLUS the
full Stripe billing loop PLUS the Abuse Mailbox Email Worker:

- **Phase A foundation** — already in (org_modules, org_usage_daily,
  takedown_authorizations, averrow-tenant skeleton).
- **Phase B per-module surfaces (sprints B1–B8)** — all 7
  customer-facing modules + Notifications + Alerts shipped.
- **Phase C takedown automation (C1–C4)** — Sparrow Phase G
  auto-submit, Phase H follow-up, dispatcher + email-draft
  submitter + tenant-side takedowns view.
- **Phase D launch hardening (D1, D2, D2b, D2c, D2d)** — light/
  dark theme parity across both apps + averrow-ui → averrow-ops
  rebadge + sidebar trim + RBAC role gate.

**Test suite: 590 → 590 passing throughout.** Drift checker
green throughout. Worker + tenant typecheck both clean.

The platform now has a working customer-tenant front door
(`averrow.com/tenant/*`) and a clean staff back-office
(`averrow.com/v2/*`) that don't cross-contaminate. Customers can
sign authorization, watch takedowns flow, see real findings per
module. Staff retain full ops surface.

## Per-PR ledger

| # | Title | Phase |
|---|---|---|
| 1111 | feat(v3-phase-b): Domain Monitoring real surface (sprint 1) | B1 |
| 1112 | feat(v3-phase-b): Notifications + Alerts UI port (sprint 2) | B2 |
| 1113 | feat(v3-phase-b): Social Media Impersonation surface (sprint 3) | B3 |
| 1114 | feat(v3-phase-b): App Store Impersonation surface (sprint 4) | B4 |
| 1115 | feat(v3-phase-b): Dark Web Monitoring surface (sprint 5) | B5 |
| 1116 | feat(v3-phase-b): Abuse Mailbox tenant surface + schema (sprint 6) | B6 |
| 1117 | feat(v3-phase-b): Trademark Infringement surface + schema (sprint 7) | B7 |
| 1118 | feat(v3-phase-b): Threat-Actor Intelligence surface (sprint 8) | B8 |
| 1119 | feat(v3-phase-c): Sparrow Phase G + takedown-submitter dispatcher (C1) | C1 |
| 1120 | feat(v3-phase-c): stamp module_key + org_id on Sparrow takedowns (C2) | C2 |
| — | fix(sparrow): declare d1:org_brands in reads (drift fix for C2) | C2 |
| 1121 | feat(v3-phase-c): Sparrow Phase H + followup-draft submitter (C3) | C3 |
| 1122 | feat(v3-phase-c): tenant takedowns surface (C4) | C4 |
| 1123 | feat(v3-phase-d): light/dark theme parity for averrow-tenant (D1) | D1 |
| 1124 | feat(v3-phase-d): rename averrow-ui → averrow-ops (D2) | D2 |
| 1125 | feat(v3-phase-d): light/dark theme parity for averrow-ops (D2d) | D2d |
| 1126 | feat(v3-phase-d): trim averrow-ops sidebar of brand-admin entries (D2b) | D2b |
| 1127 | feat(v3-phase-d): RBAC gate keeps customer-tenant users out of /v2 (D2c) | D2c |
| 1128 | docs(v3): session status — first wrap-up doc | docs |
| 1129 | chore(docs): sweep averrow-ui → averrow-ops references (post-D2) | doc-sweep |
| 1130 | feat(v3-phase-d): /scan onboarding UI + pricing schema (Stripe sprint 1) | D-onboarding + Stripe S1 |
| 1131 | feat(v3-phase-d): pricing PATCH endpoints + Customers pricing tab (Stripe sprint 2) | Stripe S2 |
| 1132 | feat(v3-phase-d): per-customer override edit forms (Stripe sprint 3a) | Stripe S3a |
| 1133 | feat(v3-phase-d): /admin/pricing global edit page (Stripe sprint 3b) | Stripe S3b |
| 1134 | feat(v3-phase-d): Stripe webhook handler + subscription lifecycle (Stripe sprint 4) | Stripe S4 |
| 1135 | feat(v3-phase-d): tenant billing UI (Stripe sprint 5) | Stripe S5 |
| 1136 | feat(v3-phase-d): Stripe Checkout + customer portal redirect (Stripe sprint 6) | Stripe S6 |
| 1137 | feat(v3-phase-b-followup): wire Email Worker for Abuse Mailbox | B6 scanner |

## Phase A — foundation (carried in from before this session)

Already merged before the session started; verified live:

- `org_modules` — per-tenant module entitlements
- `module_metric_definitions` — catalogue of per-module metrics
- `org_usage_daily` — KV-cached daily usage rollup
- `takedown_authorizations` — customer signs once; `scope_json`
  carries module list, monthly cap, escalation mode, SLA
  follow-up window, per-takedown-approval flag
- `lib/entitlements.ts` (`isModuleEnabled`, `requireModule`,
  `ModuleNotEntitledError`)
- `lib/module-usage.ts` (`recordUsage`, `getMonthlyUsage`)
- `lib/takedown-authorizations.ts` (`isModuleAuthorized`,
  `requireAuthorizationForModule`, `recordSignedAuthorization`,
  `revokeAuthorization`)
- `packages/averrow-tenant/` skeleton — Vite + React + Tailwind +
  TanStack Query 5 + React Router 6, served via `[assets]`
  binding at `averrow.com/tenant/*`
- Acme Corp activated as design partner: app_store + domain +
  social + dark_web modules entitled, takedown authorization
  signed.

## Phase B — per-module customer surfaces (8 sprints, all merged)

Same recipe each sprint: tenant handler with `verifyOrgAccess` +
`requireModule` gates → routes → React Query hooks → primary
page + drill-down + 10 tests.

| Sprint | Module | Schema | Page | Drill-down |
|---|---|---|---|---|
| B1 | Domain Monitoring | rides existing `lookalike_domains` + `ct_certificates` | `/tenant/modules/domain` | `/tenant/modules/domain/brands/:brandId` |
| B2 | Notifications + Alerts | rides existing `notifications_v2` + `alerts` | `/tenant/notifications` + `/tenant/alerts` | — |
| B3 | Social Impersonation | rides `social_profiles` (ported `org_brands` scope) | `/tenant/modules/social` | `/tenant/modules/social/brands/:brandId` |
| B4 | App Store Impersonation | rides `app_store_listings` | `/tenant/modules/app-store` | `/tenant/modules/app-store/brands/:brandId` |
| B5 | Dark Web Monitoring | rides `dark_web_mentions` | `/tenant/modules/dark-web` | `/tenant/modules/dark-web/brands/:brandId` |
| B6 | Abuse Mailbox | **new schema 0150** (`org_abuse_aliases`, `abuse_inbox_messages`) | `/tenant/modules/abuse-mailbox` | filterable list, per-brand chip filter |
| B7 | Trademark Infringement | **new schema 0151** (`trademark_assets`, `trademark_findings`) | `/tenant/modules/trademark` | `/tenant/modules/trademark/brands/:brandId` |
| B8 | Threat-Actor Intelligence | rides `threat_actors` + `threat_attributions` + `threat_actor_targets` + `threat_actor_infrastructure` | `/tenant/modules/threat-actor` | `/tenant/modules/threat-actor/actors/:actorId` |

**Out-of-band**: B6 + B7 carry empty-state UIs because their
scanners aren't wired yet (Email Worker for Abuse Mailbox,
image-hash crawler for Trademark — flagged in
"What's left" below).

## Phase C — takedown automation (4 sprints, all merged)

Closes the **submit → wait → escalate → audit** loop. Sparrow
now goes from "creates a draft" to "auto-submits under signed
authorization, follows up on SLA breach, exposes the audit
trail to the customer" without a human in the loop.

### C1 — dispatcher framework + Sparrow Phase G (PR #1119)

- Migration 0152 adds `module_key` + `auto_submit_enabled` +
  `last_verified_at` columns on existing tables, plus new
  `takedown_submissions` audit table.
- `lib/takedown-submitters/`:
  - `types.ts` — `Submitter` interface (`canHandle` + `submit`),
    `TakedownRecord`, `ProviderRecord`, `SubmissionResult` with
    outcome `submitted | queued | rejected | failed`
  - `email-draft.ts` — first concrete submitter; assembles email
    body from evidence, writes audit row with `outcome='queued'`,
    NO outbound SMTP yet (safe to enable in production from day
    one)
  - `index.ts` — dispatcher with priority list of submitters;
    catches submitter throws; persists audit row in all cases
- `agents/sparrow.ts` — new Phase G after Phase F:
  - Picks `PHASE_G_BATCH=10` drafts per tick
  - **Both gates**: `isModuleEnabled` (org_modules) + `isModuleAuthorized`
    (takedown_authorizations.scope.modules)
  - Provider must have `auto_submit_enabled=1` (operator gate)
  - On non-failed outcome, flips status to `submitted` +
    stamps `submitted_at`

### C2 — module_key + org_id stamping (PR #1120 + drift fix)

Without C2, every Sparrow-created takedown got `module_key=NULL`
+ `org_id=NULL` and Phase G refused to fire. C2 stamps both at
INSERT time across all four `createTakedownsFrom*` paths via
`resolveOwningOrgId(env, brandId)` helper that joins `org_brands`.

| Creator | module_key |
|---|---|
| `createTakedownsFromMaliciousUrls` | `domain` |
| `createTakedownsFromImpersonations` | `social` |
| `createTakedownsFromAppStoreImpersonations` | `app_store` |
| `createTakedownsFromDarkWebMentions` | `dark_web` |

Drift fix: declare `d1:org_brands` in sparrow's `reads`.

### C3 — Sparrow Phase H follow-up + followup-draft submitter (PR #1121)

- `lib/takedown-submitters/followup-draft.ts` — mirrors
  email-draft but body is reframed as "Follow-up — takedown
  still active" with prior ticket id reference and hours-elapsed.
- Dispatcher refactor: pulled audit-row INSERT into a reusable
  `recordSubmissionAttempt()` helper.
- Sparrow Phase H — picks `PHASE_H_BATCH=10` SLA-breached
  takedowns per tick (`status='submitted'` AND
  `submitted_at + scope.auto_followup_breached_sla_hours < now`
  AND no follow-up since last submit). Defensively re-checks
  entitlement + authorization (org may have revoked).

### C4 — tenant takedowns surface (PR #1122)

Customer-facing `/tenant/takedowns`:

- 4-card headline (Total / In flight / Taken down / Failed+expired)
- Filter bar: status pills (draft / submitted / pending_response /
  taken_down / failed) + module pills
- List rows with severity, status, module chip, target, brand,
  provider, evidence preview
- Detail page `/tenant/takedowns/:id` with header + 8-fact grid +
  evidence section + **submission audit trail** (one card per
  attempt with outcome pill, submitter_kind chip, ticket_id,
  email target, request summary preview, error message,
  timestamp+duration+HTTP status)

## Phase D — launch hardening (5 PRs, all merged)

The rebadge story: separate the customer-facing app from the
staff back-office, make light mode work everywhere, gate roles
correctly.

### D1 — light/dark theme parity for averrow-tenant (PR #1123)

The whole tenant package was using Tailwind classes that
hard-code white text (`text-white/55`, `bg-white/[0.04]`,
`border-white/[0.06]`, `bg-black/X`). Those literal colors don't
flip when `[data-theme="light"]` toggles, so light mode rendered
white-on-white.

Fix: append a finite `[data-theme="light"]` rule block to
`src/index.css` that redirects each hard-coded utility to a
dark equivalent under the light theme. Set is exhaustive against
grep across `src/`:

- 12 `text-white/X` opacities
- 5 `bg-white/X` opacities + `bg-black/20`
- 8 `border-white/X` opacities

Plus Tailwind config now references `var(--bg-page)` etc., a
`useTheme` hook (mirrored from averrow-ops's pattern), and a
Sun/Moon toggle in the sidebar.

### D2 — averrow-ui → averrow-ops rename (PR #1124)

Mechanical rename: `git mv packages/averrow-ops packages/averrow-ops`
+ package.json + CI/deploy workflows + scripts that hard-coded
the path. `/v2/*` URL stayed the same so bookmarks work.

### D2d — light/dark theme parity for averrow-ops (PR #1125)

Same fix as D1 applied to the rebadged staff back-office.
Wider opacity inventory (17 text + 12 bg + 14 border) because
the staff app has more components and more distinct opacity
values in its design language.

### D2b — sidebar trim (PR #1126)

Removed `BRAND_ADMIN_SECTIONS` from averrow-ops sidebar — that
was a thin customer experience embedded in the staff app, and
the same modules now live as real customer surfaces in
averrow-tenant. Sidebar always renders staff `OPS_SECTIONS`
(Intelligence / Response / Platform). super_admin-only items
inside Platform keep their guards.

### D2c — RBAC gate (PR #1127)

Three layered gates so a `role='client'` user never lands in
`/v2/*`:

1. `requireStaff()` helper — new alias for `requireRole("analyst")`
   for future per-route adoption.
2. **Worker-side login redirect backstop** — `handlers/auth.ts`
   overrides `return_to` to `/tenant/` when role=client and the
   requested return_to was inside `/v2/*`.
3. **SPA-boot redirect** in averrow-ops — `lib/auth.tsx`
   AuthProvider checks both the cached user AND `/api/auth/me`;
   if either reveals role=client, hard-redirect to `/tenant/`
   before any React shell renders.

The rebadge is shippable.

## What's complete vs what's left

### Engineering — done

- Phase A foundation
- All 7 customer-facing modules have tenant surfaces (read-side)
- Customer-facing notifications + alerts UI
- Phase C takedown automation submit + follow-up + audit loop
- Customer-facing takedowns view with full audit trail
- averrow-ops rebadge (rename + theme + sidebar + RBAC gate)

### Engineering — left for future sprints

#### Scanner backfill (lights up empty surfaces)

| Module | Scanner state | What's needed |
|---|---|---|
| Abuse Mailbox | Schema only (B6 PR #1116) | Email Worker wiring: parse forwarded message → classify with Haiku → bind to brand → write `abuse_inbox_messages` → send ack. Per-tenant alias provisioning (`verify-<tenant>@averrow.com`). Two-response flow (instant ack + 24h determination). |
| Trademark Infringement | Schema only (B7 PR #1117) | Image-hash crawler (pHash sweeps over found_image_urls) + vision-LLM fallback for similarity reasoning. Asset upload UI for customers to register logos/wordmarks. R2 storage + pHash compute on upload. |
| Dark Web Monitoring | PSBDMP source live | Add HIBP, Flare/DarkOwl, Telegram sources. Auto-exec-discovery (LinkedIn-public + company-website + Wikipedia parsers). |
| Social Impersonation | Working on existing scope | None blocking — already produces data. |
| Domain Monitoring | Working | None blocking. |
| App Store | Working | Could expand to alternative stores (APKPure / Aptoide / Samsung Galaxy / Huawei AppGallery / Amazon) per the operator's earlier note. |
| Threat-Actor | Working | None blocking. |

#### Phase C deepening

- **Provider-specific submitters** registered ahead of `email-draft`
  in `SUBMITTERS`: Cloudflare API, GoDaddy form, Twitter/X
  impersonation, etc. Each is a separate sprint with real
  outbound HTTP work.
- **Auto-discovery agent** (RDAP + abuse.net + per-provider
  knowledge base) for unknown providers — Haiku-cheap proposes
  contact, human-in-the-loop approves, directory grows.
- **Per-route `requireStaff` sweep** — defensive audit replacing
  `requireAuth` with `requireStaff` on cross-tenant or admin-only
  handlers.

#### Phase D remaining

- **`/scan` onboarding UI** — pure frontend on existing public-scan
  endpoints (`/api/scan/public`, `/api/brand-scan/public`,
  `scan_leads`, `brand_scans`). Result page → conversion CTA.
  This was the planned next sprint when the session ended.
- **Doc sweep** — many `*.md` files (`CLAUDE.md`, `README.md`,
  `RESTRUCTURE_SPEC.md`, `AVERROW_UI_STANDARD.md`) and code
  comments still reference `averrow-ops` in prose; update to
  `averrow-ops`.
- **Outbound SMTP** for the email-draft submitter — currently
  records intent; Phase D should wire real send.

### Operator-decision items

These need your direction before engineering can proceed:

- **Stripe billing** — `stripe_customer_id` + `stripe_subscription_id`
  on `organizations`, webhook handler, subscription lifecycle →
  `org_modules` activation/suspension. Needs price IDs / plan
  structure decisions first.
- **Pricing structure** — instrumentation is in (`org_usage_daily`)
  but no SKU model is defined. Plan stays neutral until you
  decide.
- **Customer authorization legal model** — DMCA-agent
  designation vs MSA-clause vs hybrid. Engineering can build
  either; the table accommodates both.
- **Design-partner soak** — operational; pick 1–2 design
  partners and run for 2–3 weeks before public launch.

## Suggested next-session priorities

1. **`/scan` onboarding UI** (frontend-only, ~30 min)
2. **Doc sweep** for averrow-ui → averrow-ops references
3. **Email Worker wiring** for Abuse Mailbox (lights up B6)
4. Stripe billing once you've decided plan structure
5. Per-route `requireStaff` sweep when you have appetite for an
   audit pass

## Files to read in a fresh session

- This doc (`docs/v3/V3_BUILD_STATUS.md`)
- `eager-moseying-papert.md` (the v3 plan)
- `docs/v3/PHASE_B_FOLLOWUPS.md` (operator notes)
- `CLAUDE.md` standing instructions
- `RESTRUCTURE_SPEC.md` if touching design system

---

# Post-doc-revision additions (PRs #1128–#1137)

## /scan customer-acquisition funnel (PR #1130, part 1)

`packages/trust-radar/public/scan/index.html` — single-file static
landing page served at `averrow.com/scan`. Visitor types domain →
hits `/api/brand-scan/public` → renders trust score + risk pill +
lookalike count + threat-feed mention indicator → conversion form
posts to `/api/leads` and writes a `scan_leads` row. Deep-link
support via `?domain=...`. ~280 lines, no build step.

## Stripe billing — full loop, 6 sprints (PRs #1130–#1136)

The full sign-up → trial → bill → see → manage flow:

| Sprint | What landed |
|---|---|
| 1 | DB schema (`pricing_plans` / `module_prices` / `org_pricing_overrides` + 5 columns on `organizations`); seed data for the 3 tiers + 7 modules; `Customers` rename in averrow-ops sidebar (was "Organizations") |
| 2 | super_admin PATCH endpoints + read-only Pricing tab in averrow-ops Customer detail |
| 3a | Per-customer override edit form (3 override types) + revoke button with two-step confirm |
| 3b | `/admin/pricing` global edit page for tier + module baselines |
| 4 | Stripe webhook handler with HMAC-SHA256 signature verification; `customer.subscription.created/updated/deleted` + `invoice.payment_failed/succeeded` event handlers; idempotency table; full subscription lifecycle → `org_modules` state sync |
| 5 | `/tenant/settings/billing` read-only summary (plan, modules, overrides, status, trial end) |
| 6 | Stripe Checkout (`POST /api/orgs/:orgId/billing/checkout-session`) + customer portal (`POST /api/orgs/:orgId/billing/portal-session`); minimal Stripe API client (no SDK dep); Subscribe + Manage in Stripe buttons on Billing page; success/cancel banners |

**Pricing config lives in the DB**, not env vars or hardcoded.
Super_admins edit baseline tier + module prices in
`/admin/pricing` and per-customer overrides in
`/admin/customers/<org>/pricing`. Stripe handles the billing
event; trust-radar is the source of truth for what each org's
effective price IS.

**Test mode**: code ships without `STRIPE_API_KEY` /
`STRIPE_WEBHOOK_SECRET`; both endpoints return 503 until the
operator sets the secrets and creates Stripe Products / Prices
in the dashboard. Stripe CLI for local testing supported.

**Stripe end-to-end test guide** lives in chat history of this
session — capture into `docs/v3/STRIPE_TESTING.md` as a
follow-up if the operator wants it as a permanent doc.

## Abuse Mailbox Email Worker (PR #1137)

Lights up B6's empty-state UI. Cloudflare Email Routing forwards
`verify-*@averrow.com` (and `report-*` / `abuse-*`) to the
Worker's `email()` handler. Local-part router branches to a new
`handleAbuseMailboxEmail` that:

- Resolves to-address → `org_abuse_aliases` (case-insensitive)
- Parses headers + body
- Extracts the *original* suspicious email metadata via regex
  sweep over the four most common forward markers (Outlook /
  Gmail / Apple Mail / raw-headers-injected)
- Counts URLs + attachments
- Inserts `abuse_inbox_messages` with `classification='pending'`,
  `severity='LOW'`, `status='new'`

Bounded scans (64KB) so big messages don't blow CPU.

**Operator follow-ups for Abuse Mailbox to fully work:**
- Provision per-org aliases in `org_abuse_aliases`
- Configure Cloudflare Email Routing DNS / catch-all
- Wire the AI classification pass (Haiku via existing
  `lib/anthropic.ts`)
- Wire outbound SMTP for ack + determination emails

## Engineering backlog (post-merge)

| Item | Effort | Notes |
|---|---|---|
| AI classification for Abuse Mailbox | Small | Reads `abuse_inbox_messages` rows where `classification='pending'`, calls Haiku, updates the row. Cron-driven. |
| Outbound SMTP for ack + determination emails | Medium | Cloudflare Email Routing has an outbound API; needs sending domain configured |
| Image-hash crawler for Trademark (B7) | Large | pHash sweeps + vision-LLM verification + asset upload UI for customers + R2 storage |
| Dark Web source expansion | Medium | HIBP / Flare / DarkOwl / Telegram — each is its own integration |
| Per-route `requireStaff` sweep | Small | Defensive audit; `requireStaff()` helper landed in D2c |
| Full-platform light/dark audit (Wave 2) | Medium | `/scan` landing, worker-rendered pages, email templates, observatory WebGL chrome |
| Outbound SMTP for email-draft submitter (Phase C) | Medium | Currently records intent in `takedown_submissions`; ops sends manually |
| Plan picker UI on `/scan` landing | Small | Today the lead form is the conversion handoff; a plan picker would shorten that loop |
| Sales-side invite flow (Checkout link generator) | Small | super_admin can pre-create a Stripe Checkout for a prospect |
| Annual billing toggle | Small | Adds `pricing_plans.annual_price_cents` + a toggle in the pricing config |
| Usage-based takedown overage | Medium | Adds metered Stripe billing for takedowns over the monthly cap |

## Operator-decision items (still)

- **Customer authorization legal model** — DMCA-agent vs MSA-clause
  vs hybrid. Engineering can build either.
- **Design-partner soak** — operational; pick 1–2 partners and run
  for 2–3 weeks before public launch.
- **Email Routing DNS setup** for `averrow.com` (per-tenant alias
  catch-all rule)
- **Stripe Products / Prices** creation + price-ID assignment via
  `/admin/pricing`

