# Averrow — Response to the DRPS Assessment: 6-Month Plan & Budget

_Status: approved by owner 2026-11-07. Source: external DRPS assessment + code audit. Paths relative to `packages/averrow-worker/src/` unless noted._

## Context

An outside assessment says Averrow's idea is sound: it groups alerts into campaigns, shows evidence you can trace, and publishes its prices. It also says the platform will win or lose on four things:
1. how fast takedowns happen
2. getting past cloaking
3. keeping false positives low
4. speaking clearly to SecOps buyers vs Legal buyers

I checked each of those against the code. The platform is further along than the assessment assumes in some areas, and has gaps it doesn't mention in others. One of those gaps blocks revenue.

**Constraints you set:** at most $500/month for outside services, built by you plus Claude, over 6 months (12 two-week sprints).

**You asked which buyer is most financially beneficial. My recommendation: SecOps / mid-market first, then a Legal/Brand add-on pack in months 4–5, and MSSP groundwork in month 6.**
- **SecOps first:** it is closest to what the code already does (page capture, phishing scoring, NEXUS clustering, the SIEM connectors). Sales cycles are shorter. The existing Professional ($1,499) and Business ($3,999) tiers fit security budgets. "Time to takedown" is a measurable return the platform can report.
- **Legal/Brand second:** these budgets are larger but more competitive (BrandShield, Red Points, Corsearch). It needs work that doesn't exist yet: marketplace and counterfeit coverage, logo similarity, and legal-grade evidence. The evidence work (Sprint 8) serves both buyers, so the Legal pack becomes a cheap upsell on the same engine, not a separate product.
- **MSSP last:** one MSSP brings in many end customers, but the platform has no parent/child orgs, a session can only bind to one org, and per-member brand scoping (register items G35/G36) is missing. Start it once you have reference customers.

## What the code shows against the assessment

| Assessment theme | Already built | Gaps that matter |
|---|---|---|
| Takedown speed and reach | Sparrow phases B–H; Web Risk, NetBeacon and GoDaddy API submitters; live email via Resend; per-org Off / Semi-auto / Auto modes (`lib/takedown-policy.ts`, `lib/takedown-authorizations.ts`); SLA follow-up; 7-day re-check for domains that come back | Each takedown goes to only one channel; no abuse-contact lookup from RDAP (contacts come only from a ~21-row `takedown_providers` table); ticket IDs are never polled; no escalation ladder (`auto_resubmit_on_pivot` is never read); no time-to-first-response; `takedown_outcome_daily` files non-threat takedowns under `unknown` and never keys by registrar |
| Cloaking | Browser Rendering capture with desktop and mobile profiles, files in R2 with SHA-256 hashes, `detectAntiBotWall` | Detection only. Fixed user agents, no referrer, no proxy or egress country, no clicking, no retry after a block |
| Campaign correlation | Six NEXUS lanes (cert serial, cert SAN, IP, /24, registrar, ASN) and union-find merging of clusters | Exfil sink ID, MX, nameservers, kit fingerprint and favicon hash are not correlation keys. Registrar and ASN clusters can never join clusters together |
| False-positive discipline | Rule triage plus the AI judge, auto-dismissal only at confidence ≥ 90 | Analyst false-positive verdicts feed nothing back |
| Evidence you can trace | Capture hashes, AI-written evidence narrative (currently off pending a review gate) | No signed manifest, no custody log, no legal export bundle, no WHOIS/DNS snapshot taken at capture time |
| Getting paid / onboarding *(not in the assessment)* | Stripe checkout and customer portal, per-module entitlements, free scan | **G-B1: checkout never links the subscription to the org.** Brand and seat limits aren't enforced. API keys are created but never checked, so there is no customer API. No self-service signup. Customers have no settings screen for integrations or webhooks |

## The plan (12 sprints × 2 weeks)

Every sprint goes through the CLAUDE.md §1A pipeline: delivery-lead → engineer → test-engineer → qa-verifier → reviewers → ship. Items marked **[owner OK]** need your approval before merge under §9a (paid service, new binding or cron, pricing or billing, access changes).

### Phase 1 — Get paid, prove takedown speed (Months 1–2)

**S1 · Revenue plumbing**
- Fix G-B1: link the Stripe subscription to the org in `handlers/stripeWebhook.ts` / `lib/stripe-events.ts`, then sync `org_modules` from the plan through `lib/entitlements.ts`.
- Enforce brand and seat limits per plan (G-B5) and gate executive monitoring by tier (G17). Additive migration on the `0153_pricing.sql` plans. **[owner OK: billing]**
- Make API keys authenticate the tenant read API (G2): a key-auth path in `middleware/auth.ts` that reuses `requireOrgMember` scoping. **[owner OK: access]**

**S2 · Takedown reach**
- RDAP abuse-contact lookup: extend `enrichment/rdap.ts` to read the `abuse` role entity (email and phone) and use it as the fallback in `lib/provider-resolver.ts` `matchProvider` when `takedown_providers` has no match. Cache it per registrar or network.
- URLhaus/abuse.ch submitter (free API key) in `lib/takedown-submitters/`, following the shape of `web-risk.ts`.
- Send one takedown to several channels: change the dispatcher in `lib/takedown-submitters/index.ts` from "first one wins" to a list of channels with fixed roles. A blocklist submission (Web Risk, URLhaus) always runs alongside the registrar or host submission. Record one `takedown_submissions` row per channel.

**S3 · Takedown speed, measured**
- Poll ticket status for NetBeacon and GoDaddy using the stored ticket IDs. Add it as a Sparrow phase; no new cron.
- Escalation ladder: host → registrar → registry or upstream ASN after an SLA breach, driven by the `escalation` / `auto_resubmit_on_pivot` settings that are already stored. It reuses the Phase H follow-up.
- Metrics: time to first response, and outcome rollups keyed by **registrar and channel**. Extend `lib/takedown-outcome-rollup.ts` with additive `dim` values, and resolve the key for non-threat sources so they stop landing in `unknown`.
- A customer-facing time-to-mitigation panel: tenant takedowns plus `lib/takedown-metrics.ts`. This is the sales proof the assessment says buyers judge on.

**S4 · Getting past cloaking (lean version)**
- Capture profiles in `lib/page-capture-browser.ts`: real browser user agents, locale and timezone, `Referer` headers that look like a click from email or search, slower human-like timing, and one click on a gated "continue" button.
- When a capture comes back `blocked`, retry it with the next profile. Store which profile was used in `meta.json`.
- A residential proxy only for the second retry, and only if Browser Rendering supports a proxy (spike day 1). If it doesn't, a small headless worker on a ~$6/mo VPS fed from the queue. **[owner OK: paid service]** Cap usage by the number of retries per day.
- KPI: `page_analysis.wall_rate_pct` falls; the share of blocked captures re-captured goes up.

### Phase 2 — Make it one campaign, not 40 alerts (Months 3–4)

**S5 · Kit and visual fingerprints** (computed in the Worker, no paid service)
- Kit fingerprint: a hash of the DOM structure (tag skeleton) plus a hash set of the page's static assets, computed from HTML that capture already stores.
- Favicon hash (mmh3, the Shodan-compatible format) and a perceptual hash of the screenshot (dHash via a small WASM or plain-TS image decode). Also fill in the missing `brands.logo_hash`.

**S6 · Correlation keys and campaign UX**
- New NEXUS keys in `lib/nexus-threat-lanes.ts`: exfil sink ID (`page_exfil_sink_id`), kit hash, favicon hash, MX host, nameserver pair. Specific ones join clusters in `lib/cluster-components.ts`; shared MX and NS providers go on a denylist the same way as `lib/shared-infra-asns.ts`. Keep `test/nexus-lane-parity.test.ts` passing.
- A tenant "Campaign" view: one incident showing linked domains, infrastructure, kit and takedown status, plus one-click "take down the whole campaign" through the multi-channel dispatcher.

**S7 · False-positive feedback loop**
- An analyst or customer "false positive" verdict leads to: a suggested `brand_safe_domains` entry (`source='manual'`, still gated on `manage_takedowns`), a per-brand list of suppressed patterns, and a few labelled examples passed to the AI judge.
- A precision metric shown per tenant: dismissed ÷ raised, per detection source.

### Phase 3 — Legal pack and broader reach (Months 5–6)

**S8 · Evidence packet (serves both SecOps and Legal)**
- Snapshot WHOIS/RDAP, DNS, MX and certificate data at capture time. Write a manifest JSON listing every file's SHA-256 and sign it with HMAC (Ed25519 later). Log a custody entry for each access.
- Export as ZIP plus PDF (Browser Rendering `page.pdf()` from a template, no new package).
- Add the human-review gate, then turn `evidence_assembler` back on, per `docs/runbooks/anthropic-credit-budget.md`. **[owner OK: AI allowlist var]**

**S9 · Legal/Brand add-on**
- A Google Play monitor (the `app_store` type already exists).
- Trademark Phase 2: logo misuse using the perceptual hashes from S5.
- A brand-infringement report export.
- Price it as an add-on module through the existing per-module pricing. **[owner OK: pricing]**

**S10 · Integrations customers can set up themselves**
- A tenant settings screen for integrations, webhooks and API keys (G5).
- Slack and Teams webhook connectors in `lib/integrations/`.
- Emit `threat.detected` and the other declared events that never fire.
- Wire STIX export into the tenant UI.

**S11 · Self-service onboarding**
- Free scan → signup → trial org → Stripe checkout, reusing `lib/free-scan-view.ts` and the lead-conversion logic.

**S12 · MSSP groundwork and honest claims**
- Org switcher (G35) and per-member brand scoping (G36), which unblocks MSSP pilots.
- disclosure-strategist re-checks `docs/DISCLOSURE_REGISTER.md`; marketing claims are updated to the shipped metrics.
- Docs: `TAKEDOWN_PROVIDER_INTEGRATION_PLAN.md` §1 (currently stale), `API_REFERENCE.md`, changelogs, version bump.

## Budget (≤ $500/month)

| Item | Monthly | Notes |
|---|---|---|
| Cloudflare Workers Paid + D1/KV/R2 overage | $5–40 | Already on; watch R2 as captures grow |
| Browser Rendering (capture plus retries) | $20–60 | Billed per browser-hour beyond the included hours; ~5 captures every 10 min ≈ 24–40 h/month. Check against the CF invoice in S4 |
| Residential proxy, pay as you go (retries only) | $50–150 | Capped by a daily retry budget; enable only if S4 shows a lift |
| Fallback VPS for the headless worker (if needed) | $0–10 | Only if Browser Rendering can't use a proxy |
| RDAP, URLhaus, Web Risk, NetBeacon | $0 | Free |
| WHOIS history API (optional, S8) | $0–100 | Start on the free tier |
| APWG membership (eCX feed and reporting) | $0–200 | Optional; a credibility and fast-path play. Decide in S3 |
| Resend (takedown and notification email) | $0–20 | |
| Claude | $0 extra | Stays inside the existing ~$100 Max credit and the $80 throttle |
| **Total** | **~$75–480** | Under the $500 ceiling at the high end |

One-time: legal review of the evidence packet, Terms and DPA language for automated takedowns (~$1.5–3K).

**Break-even:** one Professional customer ($1,499/mo) covers the whole outside-services budget about 3×. Target: 3 paying SecOps customers by month 4 and a first MSSP or Legal-pack pilot by month 6.

## KPIs to report monthly
- Median time to takedown (p50/p90), time to first response, takedown success rate by registrar and channel.
- Share of captures blocked by a bot wall, and the share recovered on retry.
- Alerts per campaign (the "one incident" ratio) and precision by detection source.
- Revenue measures: paid orgs, MRR, conversion from free scan to trial to paid.

## Verification (each sprint)
- Local gate per touched package: `npx tsc --noEmit`, `npm run check:resource-drift`, vitest. qa-verifier drives the flow end to end. For example S2/S3: a staging takedown fans out to several channels and both rows appear in `takedown_submissions`. S4: a known cloaked test URL is re-captured with a second profile. S6: two synthetic threats sharing an exfil sink merge into one component.
- After deploy: `./scripts/platform-diagnostics.sh 24`. Watch `page_analysis`, `agent_mesh` (Sparrow, page_capture), `d1_hourly` for read-spend regressions, and `ai_health`.
- `test/nexus-lane-parity.test.ts`, `test/cluster-retirement.test.ts` and `test/alert-triage.test.ts` must stay green.

## Critical files
- Takedowns: `agents/sparrow.ts`, `lib/takedown-submitters/index.ts` (+ new submitters), `lib/provider-resolver.ts`, `enrichment/rdap.ts`, `lib/takedown-outcome-rollup.ts`, `lib/takedown-metrics.ts`
- Capture: `lib/page-capture.ts`, `lib/page-capture-browser.ts`, `lib/page-phishing-scorer.ts`
- Correlation: `lib/nexus-threat-lanes.ts`, `lib/cluster-components.ts`, `lib/shared-infra-asns.ts`
- False positives: `lib/alert-triage.ts`, `lib/alert-ai-judge.ts`, `handlers/safeDomains.ts`, `handlers/brands.ts`
- Billing and access: `handlers/stripeWebhook.ts`, `lib/stripe-events.ts`, `lib/entitlements.ts`, `middleware/auth.ts`
- Evidence: `lib/evidence-assembler.ts`, `handlers/pageCaptures.ts`

(All under `packages/averrow-worker/src/`; UI under `packages/averrow-tenant/src/features/`.)

