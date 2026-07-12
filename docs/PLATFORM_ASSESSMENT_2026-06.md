# Averrow Platform Assessment — June 2026

**Scope:** Full code-level assessment of the Averrow platform (trust-radar Worker,
averrow-ops, averrow-tenant, averrow-marketing, shared, imprsn8 — imprsn8 was
decommissioned 2026-07-12, after this assessment was written; see note under
§2.5) against the stated vision: *ingest intel feeds broadly → identify
targeted brands → surface mid-market North American prospects → onboard them
as brand-protection customers → deepen signal via their email-security stack
— all operated at minimal cost.*

**Method:** Ten parallel code-level audits (feeds, agent mesh, brand-protection
capabilities, email stack, lead-gen, multi-tenancy, cost architecture, documentation,
frontend UI/UX code, live-site visual review) plus competitive research on Bolster AI,
Doppel, Netcraft, ZeroFox, and the SMB entrants. Every claim below traces to code;
file references are included throughout.

---

## 1. Executive Verdict

**The platform is substantially more mature than "early stages" implies — but the
maturity is concentrated in detection and intel, while the gaps are concentrated in
the last mile to revenue.**

| Domain | Maturity | One-line verdict |
|---|---|---|
| Feed ingestion | ★★★★☆ | 35 active feeds, production-grade circuit breakers; 13 dead/disabled feeds documented honestly |
| Agent mesh / enrichment | ★★★★☆ | 7 production-grade agents, full pipeline; 24 of 39 agents dormant/retired |
| Brand-protection detection | ★★★★☆ | Lookalike/CT/social/app-store/dark-web all live; real-time CertStream is a genuine differentiator |
| **Takedowns** | ★★☆☆☆ | **~20% implemented — email drafts queued for manual send. This is the #1 competitive gap.** |
| Email intel (spam trap / abuse mailbox / DMARC) | ★★★★☆ | Genuinely uncommon at this price point; 3P provider integrations absent |
| Multi-tenancy / tenant app | ★★★★☆ | Isolation is solid; ~85% feature-complete; 5 blockers to GA (~18 days est.) |
| Lead-gen ("sweet spot") | ★★★☆☆ | Scoring pipeline works; **ICP filters (NA geography, revenue band) designed but never enforced**; Pathfinder manual-only |
| Cost architecture | ★★★★★ | Thesis validated: ~$100–1,500/mo opex, 85–90% gross margin at list pricing |
| Documentation | ★★☆☆☆ | ARCHITECTURE.md cron section is wrong; API ref has 29 ghost + 110 missing routes; MASTER_PLAN "current state" is a stale March snapshot |
| UI/UX | ★★★★☆ | 7.2/10 overall; strong design system & IA; accessibility and light theme are the weak spots |

**The cost thesis is proven.** A single Professional customer at $1,499/mo covers the
entire estimated operating cost ($100–1,500/mo depending on volume) — gross margins of
85–90%. The cost engineering (OLAP cubes, KV counter caches, side-DB isolation that cut
DNS reads 160×, per-agent AI budget caps with three-level throttling, idempotency-keyed
AI calls) is above-average for commercial threat-intel SaaS.

**The market position is real.** Competitive research confirms the $18K–48K/yr band is
genuinely underserved: Bolster's managed floor is ~$20K/yr, Netcraft/Doppel/ZeroFox are
$50K–250K+, and below sits only self-serve tooling (DoppelDown at $49/mo). Transparent
pricing plus a real free tier is itself a differentiator — almost nobody credible does it.

**The two existential gaps:**
1. **Takedown execution.** Every credible competitor's headline metric is takedown speed
   (Netcraft: 33-min median). Averrow queues email drafts for manual ops send. Without at
   least Google Safe Browsing + APWG eCX blocklist submission (cheap, fast, no registrar
   relationships needed), the $1,499 tier is monitoring + report generation — which
   DoppelDown commoditizes at $49/mo.
2. **The revenue flywheel was never closed.** Pathfinder (lead-gen) is manual-trigger
   only; the "mid-market North American" ICP exists as captured-but-unused columns —
   no geography filter, no revenue-band gate anywhere in the pipeline.

---

## 2. What the Platform Actually Is (Code-Verified Inventory)

### 2.1 Feed ingestion — 35 active / 13 disabled / 21 archived

- **Ingest (22 active):** ct_logs (crt.sh), openphish, urlhaus, threatfox, feodo,
  phishdestroy, malwarebazaar, nrd_hagezi, dshield, cins_army, sslbl, otx_alienvault +
  taxii_otx, cisa_kev, cisa_iran_iocs, blocklist_de, spamhaus_drop, tor_exit_nodes,
  emerging_threats, disposable_email, typosquat_scanner, tweetfeed, nvd_cve, advisories.
- **Enrichment (8 active):** surbl, virustotal, google_safe_browsing, spamhaus_dbl,
  abuseipdb, circl_pdns, greynoise, seclookup — all on free tiers with rate limits
  enforced in code.
- **Social (4):** reddit, github, telegram, mastodon.
- **Disabled (13):** talos_ips, phishstats, cryptoscamdb, c2_tracker, phishtank (dead
  upstreams — migrations 0208/0212/0213 document root causes); cloudflare_scanner,
  digitalside_osint, c2_intel_feeds (zero data/readers); hibp_stealer_logs, urlscanio
  (require paid plans); dataplane.
- **Infrastructure:** Per-feed circuit breaker with exponential backoff + jitter
  (`lib/feedRunner.ts`), orphan-pull reaper (`lib/feed-pull-reaper.ts`), KV+DB dedup,
  bounded concurrency (4 parallel), real-time CertStream WebSocket via Durable Object.
- **External feed cost: $0/month** — every feed is free or free-tier with coded limits.

**Weaknesses:** abuse.ch concentration (4 of 22 ingest feeds); ~23% transient CertStream
failure rate treated as skip-tick; no per-IOC source fusion (same IOC from two feeds =
two threat rows); PhishTank/Talos losses show upstream business-model risk.

### 2.2 Agent mesh — 39 agents, 7 production-grade

**Production-grade:** Sentinel (classification), Analyst/ASTRA (brand attribution),
Cartographer (geo/provider enrichment, 5 phases), NEXUS (SQL infrastructure clustering),
Flight Control (autonomous supervisor), Strategist (campaign correlation), Observer
(daily briefings). Plus Sparrow (takedown drafting), Narrator, Attributor, News Watcher
in earlier maturity.

**Dormant:** 11 agents retired 2026-05-14 (status flip only — several still wired to
live CTAs, e.g. `brand_deep_scan` behind the brand-page "AI DEEP SCAN" button), the
Architect meta-agent, and Pathfinder (demoted to manual).

**AI discipline is good:** Haiku for volume work, sibling-domain dedup, sub-5-threat
provider skip, per-agent monthly token caps (sum ≈650–900M), three-level budget
throttle (soft 80% / hard 95% / emergency 99%), deterministic idempotency keys on every
call. Identified waste risks: Narrator's per-brand narrative generation is unbudgeted
($20–50/day potential), and Strategist's campaign-significance step could be rule-based.

**Architectural debt:** Cartographer's 5-phase pipeline regularly approaches its
150-min stall threshold; the orchestrator inline-await pattern caused repeated agent
starvation (fixed symptomatically via dedicated crons PR-E/F/Q/T but the pattern remains
brittle). Operationally sound at ~100–500 threats/hour; 10× volume needs agent
splitting and likely Workflow-ification of Analyst.

### 2.3 Brand-protection capabilities

| Capability | State | Notes |
|---|---|---|
| Lookalike/typosquat | Production | 8 permutation types, 30/domain cap, DoH validation, AI verdicts, BIMI escalation (`lib/dnstwist.ts`, `scanners/lookalike-domains.ts`) |
| CT monitoring | Production | Real-time CertStream DO, homoglyph + 70-point phishing pattern scoring — **differentiator** |
| Social impersonation | Production | 6 platforms (X, LinkedIn, Instagram, TikTok, GitHub, YouTube); discovery + monitoring + AI assessment; HEAD-request only (no bio scraping/follower data) |
| App-store | Production (iOS only) | iTunes Search API; Google Play not implemented |
| Dark web | Production (narrow) | Pastebin (PSBDMP) + ransomware DLS feeds; Telegram/HIBP/Flare deferred |
| **Takedowns** | **~20%** | Pluggable submitter framework + audit trail exist, but only email-**draft** submitters (queued, not sent — SMTP is "Phase D"). No registrar APIs, no GSB/APWG reporting, no success-rate tracking |
| Trademark | Production Phase 1 | Zero-cost SQL correlation of wordmark misuse; logo matching deferred |
| Brand scoring | Production | Two-axis Health (defense) + Exposure (offense) model, daily snapshots — novel vs competitors |
| Alerts | Production | Tier 1/1.5 rule triage + Tier 3 AI judge (manual backfill); no real-time push, no alert grouping |
| Breach/ATO | ~30% | Credential dumps detected as a dark-web side effect; no HIBP (requires Pro), no dedicated breach feed |

### 2.4 Email intelligence — your strongest unconventional asset

- **Spam trap** (`spam-trap.ts`, 580 lines): production. Brand/spider/paste/employee/seed
  trap addresses across 3 domains via Cloudflare Email Routing; full SPF/DKIM/DMARC
  parsing, URL/attachment extraction, brand matching (5 methods), severity scoring,
  threat creation, tenant notifications. Gaps: attachment SHA256 never populated,
  non-idempotent threat IDs, GeoIP enrichment columns never filled.
- **Abuse mailbox** (`handlers/abuseMailboxEmail.ts`, 832 lines): production. Per-org
  aliases + public platform aliases; handles `message/rfc822` forward-as-attachment;
  inner-header auth parsing; throttling with flood alerts; Haiku classification;
  idempotent threat promotion; ack + determination email loop. This plus the spam trap
  is **genuinely uncommon bundled at this price point** (competitive research confirms).
- **Email posture scans** (`email-security.ts`): SPF/DKIM/DMARC/MX/BIMI via DoH, scoring
  + grading, per-brand history. DNS-only.
- **DMARC RUA ingestion** (`dmarc-receiver.ts`): full RFC 7489 XML parsing including
  ZIP/GZIP, daily rollups, failure-rate notifications. RUF (forensic) not parsed.
- **Proofpoint/Mimecast/IronPort integrations: absent.** Only MX-hostname provider
  detection and hardcoded DKIM selector guesses exist. The "integrate with the
  customer's email security provider" vision is 0% built — but the DMARC RUA pipeline
  is the right foundation: pointing a customer's `rua=` at Averrow delivers much of the
  failure-signal value with zero vendor API work.

### 2.5 Lead-gen — the "revenue sweet spot" pipeline (~60% built, key parts unenforced)

- **Works:** Pathfinder scores unmonitored brands on 16 threat + buying signals (email
  grade, active phishing, trap catches, breach disclosures ≤180d, 10-K cyber mentions),
  creates `sales_leads`, then Haiku enrichment produces threat summary + two outreach
  email variants + CISO research (with web search). Firmographics from SEC EDGAR /
  Companies House / Wikidata. Staff UI has an 8-stage kanban with outreach send via
  Resend. Post-enrichment gates reject enterprises (5000+) and service providers.
- **Broken vs vision:**
  - **No North America filter anywhere.** `company_hq` is captured as free text, never queried.
  - **No revenue-band gate.** Bands exist on every lead but are UI display/filter only.
  - **Pathfinder is manual-only** (demoted 2026-04-29) — no cron refreshes the pipeline.
  - **Brand discovery is attacker-driven**, not ICP-driven — the 9.6K-brand catalog is
    whoever got attacked, with no proactive mid-market seeding loop.
  - imprsn8 was a separate product with zero linkage to `sales_leads`
    (as of this June 2026 assessment). It was decommissioned 2026-07-12 —
    package, Worker, and Cloudflare resources removed — so this line item
    is moot going forward.

### 2.6 Multi-tenancy & customer readiness

Isolation audit found **no cross-org leakage** — all tenant handlers join through
`org_brands`/`org_id`, JWT carries org scope, forced-logout works. The tenant SPA has
7 module pages + alerts/threats/takedowns/notifications/settings/billing, per-brand
monitoring config, member invites/RBAC, API keys + webhooks, Stripe checkout/portal
wiring, takedown-authorization MSA flow.

**Verdict: ready for a sales-led closed beta of 1–3 customers; not ready for GA.**
Blockers (≈18 days): tenant-scoped weekly digest email, CSV/PDF export, Stripe
`stripe_price_id`s actually populated, past-due billing UX, and real (non-manual)
takedown submission. The MSA text is also placeholder — needs legal review.

### 2.7 Cost architecture — thesis validated

- Cloudflare Workers Paid (~$5/mo base) + D1 (3 side-DBs isolating read budgets) + KV +
  R2 + DOs + Workflows; 15 cron triggers.
- Engineering receipts: dns_queue side-DB (15M→94K reads/day), GeoIP diff import (−61%
  writes), cube watermark skips (−33%), `cachedCount`/`cachedValue` KV layers, budget
  ledger with per-agent caps and Anthropic usage-report reconciliation.
- **Estimated all-in: ~$100–400/mo today, $700–1,500/mo at heavy volume** (AI spend
  dominates and is the elastic dial). One Professional customer covers it.
- Scaling: fine to ~10×; at 10× the orchestrator CPU budget and analyst token caps
  become the binding constraints (known, fixable).

---

## 3. Competitive Position (Bolster, Doppel, Netcraft, et al.)

| Band | Players | Cost |
|---|---|---|
| Free/DIY | CheckPhish, DoppelDown free, phish.report tools | $0 |
| Self-serve SMB | DoppelDown ($49+/mo), BrandProtection.ai (~$860/mo) | <$12K/yr |
| **Mid-market gap — Averrow's band** | **very thin** | **$18K–48K/yr** |
| Managed mid-tier | Bolster Standard ($20–50K/yr), PhishFort, Allure | $20–50K/yr |
| Enterprise | Netcraft, Doppel, ZeroFox, Fortra | $50K–250K+/yr |

- **Bolster:** AI/computer-vision detection, claims 95% zero-touch takedowns via 1,500+
  registry/host API partnerships; realistic floor ~$20K/yr; CheckPhish free tier is the
  closest analog to Averrow Free.
- **Doppel:** enterprise "social engineering defense," GPT-5 agentic triage, Threat
  Graph campaign correlation (analogous to NEXUS), six-figure ACVs, Fortune-500 focus.
- **Netcraft:** the takedown incumbent — 33-minute median phishing takedown, 75% via
  direct API/contacts. Explicitly not an SMB option per reviewers.
- **Table stakes Averrow already meets:** typosquat detection, CT monitoring, social +
  app-store + dark-web coverage, alerting/API. **Table stakes Averrow misses:** evidence
  packages, **browser-blocklist submission (GSB reporting + APWG eCX)** — the industry's
  cheap path to minutes-fast disruption — and actually-executed takedowns.
- **Positioning guidance:** anchor marketing on **time-to-blocklist** (achievable via
  GSB/APWG without registrar relationships), not time-to-removal; don't publish SLAs
  the takedown pipeline can't back yet. Email-posture scans + spam-trap intel +
  two-axis brand scoring are honest differentiators at this price.

---

## 4. UI/UX Assessment

**Code-level (averrow-ops 48 routes, averrow-tenant 15 routes):** overall 7.2/10.
- Strengths: coherent IA with safe redirects, ~82% design-system adoption, disciplined
  TanStack Query usage, error boundaries on all lazy routes, the WebGL Observatory.
- Top issues: `--text-muted` at 0.25 alpha fails WCAG readability; no visible keyboard
  focus indicators; light theme incomplete; 45/99 feature files lack loading fallbacks;
  duplicate Button/StatCard implementations; three 1,000+-line page components
  (BrandDetail 1,613; AdminAbuseMailbox 1,356; AgentNetworkView 989); silent
  `.catch(() => {})` API failures; tenant PWA has a manifest but **no service worker**,
  so the documented install banner / passkey prompt flow isn't actually reachable.

**Live visual review (Playwright/Chromium, June 10):**
- **Marketing site (averrow.com): polished.** Strong hero ("Your brand is under attack
  right now"), live intercept-feed motif, free-scan CTA, agent/capability sections,
  clean light aesthetic, renders well at 390px mobile. Two console errors on load worth
  chasing. Stats bar claims (210K+ threats, 9.6K brands, 33+ feeds) are roughly honest
  vs code/DB — "33+ feeds" matches the 35 active.
- **App login (/v2/login): visual bug** — light login card sits on a split background
  (light upper region, abrupt dark-navy band below the fold). Also a brand-tone seam:
  marketing is light/editorial, the app is dark cockpit; the login page is caught
  between them.
- **/tenant unauthenticated** redirects cleanly to marketing (correct behavior).
- Authenticated surfaces couldn't be visually reviewed (no credentials in this
  environment) — covered by the code audit instead.

---

## 5. Documentation Staleness (confirmed: major update needed)

| Doc | Status | Worst issue |
|---|---|---|
| `docs/ARCHITECTURE.md` | **Badly stale — CRITICAL** | Cron section describes an obsolete `*/15` orchestrator; reality is 15 staggered minute-offset crons (wrangler.toml:83) |
| `AVERROW_MASTER_PLAN.md` | Badly stale | §2 "Current State" is a March snapshot ("Cartographer not running" — it runs hourly) |
| `docs/API_REFERENCE.md` | Updated today but incomplete | 29 documented-but-removed routes; ~110 undocumented (40+ legit API: passkeys, approvals, metrics, magic-link, brand aggregates) |
| `docs/AI_AGENTS.md` | Stale (medium) | Display-name ↔ file-name mapping confusing; all agents do exist |
| `docs/PLATFORM_DATA_DEPENDENCIES.md` | Stale (medium) | Data-flow tables unverified after recent route churn |
| `RESTRUCTURE_SPEC.md` | Old but accurate | R1–R9 essentially landed; R10 not started |
| `CLAUDE.md`, `SHARED_LOGIN_SPEC.md` | Current | Verified — though CLAUDE.md describes PWA/passkey components the tenant build doesn't ship a service worker for |

Suggested order: fix ARCHITECTURE.md cron section (30 min) → purge ghost API routes
(15 min) → add the 40 missing legit routes (2–3 h) → archive or rewrite MASTER_PLAN §2
→ agent-name mapping table → re-verify PLATFORM_DATA_DEPENDENCIES.

---

## 6. Prioritized Roadmap (assessment recommendation)

**P0 — Close the value gap (makes the $1,499 tier defensible)**
1. Wire takedown email **sending** (Resend is already integrated for outreach/invites) +
   Google Safe Browsing reporting + APWG eCX submission. This converts "monitoring with
   drafts" into "disruption in minutes" at near-zero infra cost.
2. Ship the 5 tenant GA blockers (digest email, CSV/PDF export, Stripe price IDs,
   past-due UX, auto-submission behind the signed MSA). ~18 days estimated.
3. Evidence packages on takedowns/alerts (screenshots, WHOIS, DNS, headers) — table
   stakes everywhere; partial scaffolding exists in evidence_assembler.

**P1 — Close the revenue flywheel**
4. Enforce the ICP: country-code filter (normalize `company_hq`), revenue-band gate
   (`50-250M`/`250M-1B`) in Pathfinder Phase 1, and restore a weekly Pathfinder cron.
5. DMARC-RUA-as-onboarding: a guided "point your rua= at Averrow" flow gives you the
   email-failure signal the Proofpoint/Mimecast vision wanted, with zero vendor APIs.
   Build provider API integrations later, demand-driven.

**P2 — Detection depth (demand-driven)**
6. Google Play app-store coverage; HIBP Pro when a customer pays for it; Telegram
   dark-web channels; alert grouping/correlation.

**P3 — Hygiene**
7. Doc update sprint (§5); UI a11y fixes (contrast, focus rings) + login-page
   background bug + light theme completion; tenant service worker so the PWA story in
   the docs is real; truly retire or un-retire the 11 zombie agents.

---

*Generated 2026-06-10 from ten code-level audit passes + live-site review + market
research. File references throughout are to the state of `master` at f36888b.*
