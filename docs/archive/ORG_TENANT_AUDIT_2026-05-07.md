> Archived 2026-06-10: point-in-time tenant audit; superseded by the v3 tenant build (docs/v3 ADRs).

# Organizations module — live tenant audit (2026-05-07)

**Auth context:** logged in as `service-mcp@averrow.local` (super_admin, no org binding) per the JWT minted by `/api/internal/auth/mint-service-jwt`. Empty-state rendering is real for any super_admin without an org; data-state rendering for cleeroxtest@gmail.com (org_id=1, role `analyst`, Acme Corp) follows the same component tree with populated data.

**Test user state confirmed:** cleeroxtest@gmail.com is in `org_members` with `org_id=1`, `org_role='analyst'`, `member_status='active'`, org name "Acme Corp", plan "enterprise". Visible to her on every tab where org-scoped queries fire. PR #1102 multi-tenancy bugfix is live.

---

## TL;DR — your "pre-v2 UI" instinct vs. what I see

**Mixed.** The module mostly uses modern design-system primitives (`Card`, `Tabs`, `Badge`, `EmptyState`, `Input`, `Select`, `Button`, `PageHeader`). The reason it *feels* dated isn't the components — it's three different things:

1. **Integration logos are 2-letter chars** (`Sp`, `Se`, `Ji`, `SN`, etc.) instead of real brand SVGs. This single decision makes the most polished tab look the most amateur. **High-impact, low-effort fix.**
2. **The page is utility-focused, not value-focused.** It does a great job at "manage your account" (members, API keys, webhooks, SSO) but the customer's primary goal — protecting their brand — isn't represented anywhere on this page. This is the v3 plan's exact thesis.
3. **Half-wired numbers + hardcoded plan features** read as "we never finished this." `Threats This Month —` shows an em-dash forever; the plan card lists features as a static `<ul>` instead of pulling from the API.

So the answer to "deprecate or extend?" is **extend.** This page becomes the `averrow-tenant` Settings page in v3 — about 70% reusable as-is, 30% needs touch-ups.

---

## Tab-by-tab observations

### Tab 1 — Overview

| What I see | Verdict |
|---|---|
| `PageHeader title="Organization" subtitle="Settings"` | Generic. Subtitle should be the org name when loaded |
| 4 StatMiniCards: Brands Monitored 0/5, Team Members 0/10, **Threats This Month —**, Active Integrations 0 | "Threats This Month" never wired — em-dash forever. **Either wire it or remove it.** |
| StatMiniCards are bespoke local component, not the platform `StatCard` | Drift from M1 (audit unification). Should use `StatCard` |
| `ENTERPRISE Plan` card with hardcoded `<ul>` of 5 features | Plan tier is read from API (`org.plan`), but the **features are hardcoded** in the React file. If sales sells a Pro tier without "SIEM integrations", this UI lies |
| "Manage Billing" disabled + the new copy from PR #1101 ✓ | My follow-up fix is live and reads well |

**Verdict: weakest tab.** Not broken, just doesn't earn its prime placement.

### Tab 2 — Brands

| What I see | Verdict |
|---|---|
| `0 / 5 brands` + disabled `ADD BRAND` button + the new explanatory copy ✓ | PR #1102 polish is live |
| Empty state "No brands assigned" / "Add brands to start monitoring threats for your organization." | Modern `EmptyState` |
| Brand row layout (when populated): Card with name + Primary badge + domain + threat count + View/Remove buttons | Solid. Reuses the design-system `Card` primitive correctly |

**Verdict: clean.** Once Member-side brand add wires up in v3 Phase A, this tab is done.

### Tab 3 — Members

| What I see | Verdict |
|---|---|
| `TEAM MEMBERS` section + `INVITE MEMBER` button (top-right) | Modern; works |
| Empty state "No members yet" with `Invite Member` CTA | Modern `EmptyState` |
| Member table (when populated): Name / Email / Role / Last Active / Actions columns | Modern `<table>` |
| Role dropdown — now uses design-system `<Select>` ✓ from PR #1102 | Live and rendering correctly |
| `last_active_at` formatting uses inline `toLocaleDateString()` | Should use `formatDate()` from `lib/time.ts` (M5 from earlier audit work) |
| `PENDING INVITATIONS` section below | Clean |
| `MemberInviteSheet` opens on Invite click | Modern bottom-sheet pattern |

**Verdict: strong tab post-fix.** One small loose end: migrate the date formatter to the new helper.

### Tab 4 — Integrations

| What I see | Verdict |
|---|---|
| Three sections: `SIEM & LOGGING`, `TICKETING & INCIDENT MANAGEMENT`, `INBOUND FEEDS` | Clean grouping |
| 12 integration cards in 4-col responsive grid | Modern `Card` layout |
| Each card: 2-letter logo char (`Sp`/`Se`/`Ji`/`SN`/etc.) + name + 1-line description + Connect button | **The logos are the single most "pre-v2"-looking thing on this page** |
| Splunk/Sentinel/Elastic/QRadar/Jira/ServiceNow/PagerDuty/Linear/Mimecast/Proofpoint/Defender/CrowdStrike — all have public brand SVGs we could ship instead | Replace with real SVGs (~30 min, small new component, high visual impact) |
| Connected state (not visible — no integrations connected): would show `lastSync`, `eventsSent`, `lastError`, with `Configure`/`Disconnect` actions | Modern, well-designed |
| `ConnectIntegrationSheet` opens on click | Modern bottom-sheet pattern |

**Verdict: technically the best tab, visually the most dated because of the letter-logos.** This is your strongest single-fix lever for the page.

### Tab 5 — API Keys

| What I see | Verdict |
|---|---|
| `API KEYS` section + helpful subtitle "API keys allow programmatic access to your org's threat data." | Good copy |
| `CREATE API KEY` button (top-right + centered CTA in empty state) | Two CTAs, both work |
| Empty state "No API keys" / "Create an API key to integrate with your systems." | Modern `EmptyState` |
| Populated table (not visible): Name / Prefix / Scopes (as Badges) / Last Used / Created / Revoke | Modern table layout |
| `ApiKeyCreateSheet` opens on click | Modern bottom-sheet |

**Verdict: clean.** Production-ready.

### Tab 6 — Webhooks

| What I see | Verdict |
|---|---|
| `WEBHOOK CONFIGURATION` section with URL input | Modern |
| Webhook secret field (hashed display + Regenerate) | Modern |
| `CHOOSE EVENTS` checkbox grid — 15 event types (`threat.detected`, `alert.fired`, etc.) | Functional, slightly cramped at 1440 width — could benefit from event-type categorization |
| Probably also has "Test delivery" + recent deliveries list (not visible in screenshot but in `WebhookConfig.tsx`) | Solid, complete |

**Verdict: the heaviest tab feature-wise; visually fine.** Minor: 15 events laid out flat; could group into "Threat events / Alert events / Takedown events / System events" for scan-ability.

### Tab 7 — SSO

| What I see | Verdict |
|---|---|
| `SSO CONFIGURATION` section | Modern |
| `AUTHENTICATION PROTOCOL` selector — three buttons: `Disabled` / `SAML` / `OIDC` | Functional radio-group pattern |
| `HOW SSO WORKS` explanatory section with 3 bullets explaining behavior | **Best copy on the page.** Educational without being patronizing |

**Verdict: well-designed.** Good model for how other tabs should explain themselves.

### Tab 8 — Settings

| What I see | Verdict |
|---|---|
| `ORGANIZATION DETAILS`: Org Name `<Input>` ✓ + Save button | PR #1102 fix live |
| Billing Email field — placeholder "billing@yourcompany.com" ✓ (no tenant leakage) | PR #1102 fix live |
| Helper text "Self-serve billing email arrives with v3 (Phase D / Stripe wiring)" ✓ | Lands well |
| Slug "— (read-only)" ✓ | No more "lrx-enterprises" leak |
| SSO Configuration card (just a pointer to the SSO tab) | Slightly redundant; could be removed since the SSO tab exists |
| `SCIM PROVISIONING` with `ENABLE SCIM` disabled + helper text ✓ | PR #1102 fix live |
| `DANGER ZONE` with disabled `DELETE ORGANIZATION` + email-support copy ✓ | Lands well |

**Verdict: my fixes from PR #1102 are visible and reading well.** One small redundancy with the dedicated SSO tab.

---

## What's actually dated (the "pre-v2" feeling)

After walking the whole page, the things that read as dated are NOT the design system:

| # | Issue | Effort to fix |
|---|---|---|
| **1** | **Integration logo chars** instead of real brand SVGs (`Sp`, `Ji`, `SN`, etc.) | Small (~30 min, +12 SVGs) |
| **2** | `Threats This Month —` placeholder that never resolves | Trivial — wire or remove |
| **3** | Hardcoded plan feature `<ul>` (lies if plan tier ≠ enterprise) | Small — pull from API |
| **4** | `StatMiniCard` is a bespoke local component | Small — replace with platform `StatCard` (closes M1) |
| **5** | Page subtitle is generic "Settings" instead of org name | Trivial |
| **6** | Member-row date format uses inline `toLocaleDateString()` | Trivial — use `formatDate()` |
| **7** | `SSO Configuration` card on Settings tab is a redundant pointer to the SSO tab | Trivial — remove |

None of these are architectural. All are 2-3 hours of polish total.

---

## What's missing (genuine gaps for tenant value)

These aren't "outdated" — they're **never built**. Belong in v3 plan, not in a polish pass:

| # | Gap | Where it belongs |
|---|---|---|
| G1 | **No tenant identity card** — customer doesn't see "Acme Corp" branding/logo on this page | v3 Phase A — averrow-tenant header |
| G2 | **No primary actions for analyst-role users** — page is admin-shaped, but cleeroxtest is `analyst`. Most tabs (API Keys, Webhooks, SSO, Settings) are read-only / disabled for her | v3 Phase A — role-aware rendering |
| G3 | **No member-side billing flow** | v3 Phase D — Stripe wiring (already in plan) |
| G4 | **No member-side brand add** | v3 Phase A — Brands tab on member view |
| G5 | **No org-level usage display** ("you've used X of Y this month") | v3 Phase A — `org_modules` + `org_usage_daily` instrumentation (already in plan) |

---

## Recommendation

**Extend, don't deprecate.** The 7 polish items above are a half-day PR. The 5 gaps fold into v3 Phase A by design.

For v3 specifically, this exact page becomes the `averrow-tenant` **Settings** destination. It is NOT one of the 7 v3 modules (Domain / Social / App Store / Dark Web / Abuse Mailbox / Trademark / Threat-Actor) — it's foundational settings. The v3 customer value will come from the modules; this page is just where the customer manages their account.

**Polish suggestion order if you want to ship now:**
1. **#1 (integration logos)** — biggest visual lift per minute spent
2. **#2 (Threats This Month)** — kill the em-dash
3. **#5 (subtitle)** — show org name
4. The rest can travel with v3 Phase A.

Want me to ship #1 + #2 + #5 (3 small fixes) as a follow-up PR? Roughly 1 hour of work, takes the page from "fine" to "polished."
