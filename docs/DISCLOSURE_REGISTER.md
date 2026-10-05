# Disclosure Register

Owner: `disclosure-strategist`. Maintained per `.claude/agents/disclosure-strategist.md`.
First pass: 2026-10-05. Verified against the `master` checkout, prod `wrangler.toml`
(`AI_MODE = "rules_only"`, `ABUSE_AI_PROVIDER = "workers_ai"`, `TAKEDOWN_SEND_MODE = "live"`,
`TENANT_DIGEST_MODE = "off"`) and the live public endpoints `GET /api/v1/public/stats`,
`/feeds`, `/platform-status` and `/milestones/latest` (fetched 2026-10-05). No authenticated or
D1 reads were made. Numbers marked "query needed" must be pulled by ops before publication.

Path roots: `W/` = `packages/averrow-worker/src/`, `T/` = `packages/averrow-tenant/src/`,
`M/` = `packages/averrow-marketing/src/pages/`.

---

## 1. Summary

- **The product is stronger than the site in some places and weaker in others.** The site
  overclaims AI, API/STIX/TAXII, SSO, credential-breach intel, daily briefings and
  real-time coverage. It underclaims SIEM/ticketing connectors (Splunk, Microsoft Sentinel,
  QRadar, Jira and ServiceNow are built), takedown stay-down re-checks, ransomware leak-site
  monitoring and measured takedown metrics. These features exist but customers can't
  configure or see them.
- **The live public stats endpoint is part of the problem.** It publishes a hard-coded
  "<5min detection time", labels the whole 124K-brand catalog "Brands in coverage", returns two
  different totals for "threats", and publishes the full feed list with vendors and volumes (T3).
- **The best near-term proof is aggregate volume plus infrastructure correlation:** 1.3M+
  threats, 12K+ hosting providers mapped, 215 countries, 6K+ campaigns, and lookalike volume.
  Outcome proof (takedown time and success) exists in ops only and needs owner sign-off (S1.5).
- **The biggest competitive gaps for marketing are outcome metrics, customer-facing API/export,
  SSO, Google Play, credential leaks, and self-serve integrations.** All but SSO and credential
  leaks are S/M changes because the backend mostly exists.

---

## 2. Live-site problems (fix now)

Severity: **H** = false or legally exposed. **M** = materially overstated. **L** = T3 leak or wording.

| # | Sev | Where | Problem | Truth in code | Fix (copy) |
|---|---|---|---|---|---|
| L1 | H | `M/security.astro:246-249`, `M/legal/dpa.astro:99`, `M/why-averrow.astro:212` ("No PII stored", "We don't collect email content") | Not true | `abuse_inbox_messages` stores `forwarded_by_email`, `original_from`, `original_subject`, `original_body_snippet` (≤500 chars) (`W/../migrations/0150_abuse_mailbox.sql:27-40`). Spam-trap and DMARC receivers also ingest mail (`W/spam-trap.ts`, `W/dmarc-receiver.ts`). | State it: "For the Abuse Mailbox we store the reporter's address, sender, subject and a short excerpt of each reported message." Drop "No PII stored". **Legal/DPA change: owner sign-off (§9a).** |
| L2 | H | `M/pricing.astro:173,216`, `M/solutions/mssp.astro:141` (Enterprise "SSO / SAML / SCIM") | Not true | Sign-in is Google OAuth, magic link and passkeys only (`W/handlers/auth.ts:2`, `W/handlers/passkeys.ts`). SSO is a label (`W/handlers/organizations.ts:173`) plus an unused `sso_config_json` column. | Remove, or "SSO on the Enterprise roadmap". |
| L3 | H | `M/solutions/mssp.astro:14,89-90,101-102`, `M/partners.astro:16,44-62,142`, `M/platform.astro:268-269`, `M/docs/index.astro:61,148`, `M/docs/getting-started.astro:49`, `M/pricing.astro:126,157,211` ("STIX/TAXII live", "Full REST API access", "API access") | Not true | Customer API keys are created and stored (`W/handlers/organizations.ts:1454-1478`), but no auth path reads `org_api_keys.key_hash`. STIX export is `requireStaff` (`W/routes/export.ts:17-26`). There is no TAXII server. TAXII appears only as an *ingest* feed (`W/feeds/taxii.ts`). | "STIX 2.1 export on request (delivered by our team)" until G3 ships. Drop TAXII. Remove "REST API" until G2 ships. |
| L4 | H | `M/index.astro:121-122` + `/api/v1/public/stats` `detection_time_label` ("<5min Threat detection time") | Not true (unmeasured) | Hard-coded constant (`W/lib/public-stats.ts:24,44,94`). No metric computes it. The CT monitor polls hourly (`W/scanners/ct-monitor.ts:1-7`). | Remove the tile, or replace with a measured figure (G1/G14). |
| L5 | H | `M/pricing.astro:122,240`, `M/pricing.astro:207` ("Daily strategic intel briefings", "daily AI briefings") | Not true for customers | The daily briefing is a staff ops email (`W/handlers/briefing.ts`). The tenant digest is weekly and `TENANT_DIGEST_MODE="off"` (`wrangler.toml:361`, `W/lib/tenant-digest.ts`). | Remove, or "weekly brand briefing" once G10 ships. |
| L6 | H | `M/threat-detection.astro:31,101-102,131` ("Credential-breach intel … Daily … Global") | Not true | The HIBP feed is a stub awaiting a paid key (`W/feeds/hibp.ts:1-4`) and is not among the 46 enabled feeds. Dark web covers paste archives and ransomware leak-site victim lists only (`W/scanners/dark-web-monitor.ts:1-10,816-821`). | Replace with "paste-site and ransomware leak-site mentions of your brand". |
| L7 | H | `M/pricing.astro:152,212` ("Custom monitoring rules", Business) | Not true | `monitoring_config_json` is saved, but the only reader is the weekly-digest opt-in (`W/lib/tenant-digest.ts:79`). Nothing applies rules. | Remove until G11. |
| L8 | H | `M/pricing.astro:154` ("Priority takedown processing", Business) | Not true | Sparrow orders by `priority_score` (severity-derived), not by plan (`W/agents/sparrow.ts:125,161,224`). | Remove. |
| L9 | H | `M/pricing.astro:155-156,215` (Business includes "Campaign intelligence" + "Abuse Mailbox") | Plan mismatch | The seeded plans put `abuse_mailbox` + `threat_actor` in **Enterprise** only. Business = domain, social, app_store, dark_web, trademark (`W/../migrations/0153_pricing.sql:62-80`). Live DB rows are admin-editable (`W/handlers/adminPricing.ts`), so confirm before changing copy. | Align the copy to the entitlement matrix, or change the plan rows (pricing change: owner sign-off). Business also *understates*: it includes dark web + trademark and the page doesn't say so. Professional includes app store, also unlisted. |
| L10 | H | AI claims: `M/index.astro:118` ("AI agents deployed"), `:143-151`, `:239`, `:353` ("AI-generated narrative"); `M/pricing.astro:28,63,121,206`; `M/platform/ai-agents.astro:78,86,116,170`; `M/why-averrow.astro:89`; `M/solutions/*.astro` ("42-agent mesh"); `M/threat-detection.astro:31,282`; `M/platform/social-monitoring.astro:245`; `M/platform/email-security.astro:276`; blog `ai-powered-threat-narratives.mdx` | Not true under `AI_MODE=rules_only` | No Anthropic call leaves the Worker. Narrative prose falls back to a deterministic template (`docs/AI_STRATEGY_2026-10.md` Status #10). The registry has 44 modules (`/api/v1/public/stats` `agents_deployed:"44"`), and pages hard-code "42". About 10 are `retired`, and AI_STRATEGY §0 finds only one is agentic. | "Automated analysis", "rule-based correlation", "plain-language threat summaries". Drop the agent count as a headline. If kept, use "specialised automated processes" with no "AI". Label sample narratives "Illustrative". |
| L11 | H | `M/abuse-mailbox.astro:16,21,24,40,66-69` ("triages every report with AI", "AI classification: … benign", "Confirmed … promote", "Deep analysis … explains the verdict") | Overstated / not true | Rules classify. The Workers AI second opinion is clamped to "likely phishing/malware or review": it never says benign, never promotes, and is daily-capped. Sonnet deep analysis does not run (CLAUDE.md §6, `W/lib/workers-ai.ts`). | "Every report is classified automatically, with an automated second opinion on borderline cases. Confirmed phishing moves into your threat feed." Drop the deep-analysis line. |
| L12 | M | `M/index.astro:137` + stats `brands_monitored_label:"124K+"` ("Brands in coverage") | Misleading | `COUNT(*) FROM brands` (`W/lib/public-stats.ts:79-84`) is the passive catalog. About 112K rows are `tier='tracked'` and `createAlert` ignores them (CLAUDE.md §8). | "124K+ brands in our threat catalog" (T1), or show monitored-brand coverage (P6). |
| L13 | M | `M/index.astro:337`; `M/threat-detection.astro:126-130` ("Real-time" CT / feeds / DNS) | Overstated | CT is polled from crt.sh hourly (`W/scanners/ct-monitor.ts:1-7`). The `certstream` feed shows 0 records today. Feeds run hourly to 6-hourly. | "Continuous", "hourly certificate-transparency checks". |
| L14 | M | `M/solutions/mssp.astro:91,103`, `M/platform.astro:270`, `M/partners.astro:60-62` ("Webhooks … real-time event delivery — live") | Partial | Webhooks fire only for social, app-store and dark-web `alert.created`, and for alert/takedown status changes (`W/lib/org-events.ts` callers). Lookalike, CT, threat and executive alerts from `createAlert` (`W/lib/alerts.ts`) never fire. `threat.detected`, `email_grade.changed` and `social_profile.discovered` are declared but never emitted (`W/lib/webhooks.ts:16-23`). Customers can't configure webhooks themselves (no tenant UI). | "Webhooks for alert and takedown events, set up with our team" after G4. |
| L15 | M | `M/platform.astro:276-279`, `M/solutions/mssp.astro:95,105-107`, `M/docs/index.astro:61`, `M/partners.astro:88-105` (Splunk / Sentinel / QRadar "Roadmap") | **Understated** | Connectors exist for Splunk HEC, Microsoft Sentinel, QRadar, Jira and ServiceNow (`W/lib/integration-delivery.ts:40-42`, `W/lib/integrations/*`). They are configured from ops (`averrow-ops/.../IntegrationCard.tsx`), not by tenants, and carry the same event-coverage gap as L14. | After G4: "Splunk, Microsoft Sentinel, QRadar, Jira and ServiceNow connectors, configured with our team." Slack stays roadmap. |
| L16 | M | `M/security.astro:194-199`, `M/legal/dpa.astro:114`, `M/why-averrow.astro:214` ("SOC 2 Type I — Scheduled Q3 2026", "Engagement letter in place") | Stale (Q3 ended 2026-09-30) | No evidence in the repo. | Owner confirms the real date and status. Legal/policy content: owner sign-off. |
| L17 | M | `M/index.astro:301`, `M/platform.astro:175`, `M/platform/social-monitoring.astro:14` ("six platforms") | True, but needs naming | The six are X, LinkedIn, Instagram, TikTok, GitHub and YouTube (`W/scanners/social-monitor.ts:43`). No Facebook. | Name the six. Never imply Facebook. |
| L18 | M | Free-scan FAQ "in under a minute" (`M/pricing.astro:236`) vs "under five minutes" elsewhere | Inconsistent | Not instrumented. | Pick one ("in minutes"). |
| L19 | L (T3 leak) | **`GET /api/v1/public/feeds`** (`W/handlers/public.ts`, route `W/routes/*:328`) | T3 exposed | Publishes all 46 enabled feeds with vendor names, per-feed daily volumes, health, and method descriptions (e.g. "checks DNS registration via Cloudflare"). This gives competitors the source list and attackers the coverage map and feed blind spots. | **Escalate to `platform-security`/orchestrator:** remove the route or restrict it to `{ count }`. Check whether legacy `public/app.js` depends on it first. |
| L20 | L | `/api/v1/public/stats` | Inconsistent / mislabelled | `total_threats` (cube sum, 1,175,038) ≠ `threats_detected` ("1.3M+", table count). `certificates_today` is actually *threats today*. `latest_insight_summary` publishes 80 chars of internal agent output, which could carry brand names: a customer-data risk. | Publish one threat total. Rename or remove `certificates_today`. Drop `latest_insight_summary` (escalate with L19). |
| L21 | L | `M/index.astro:150`, `M/platform.astro:26`, `M/why-averrow.astro:96`, `M/company/index.astro:112`, `M/press.astro:88`, `M/security.astro:78` (Cloudflare Workers, cost structure) | T3 (architecture/cost) | Cloudflare is a sub-processor, so it must stay in the DPA/trust page. As *positioning* it explains our cost structure. | Keep it in DPA/security as a sub-processor. Drop "built on Cloudflare Workers … which is why it costs a fraction" from sales pages. |
| L22 | L | `M/index.astro:352` sample narrative ("same Cloudflare account", "'BeaverTooth' phishing kit") | Reads as real output | Synthetic. | Label it "Illustrative example". Don't name a real provider as the attacker's host. |

---

## 3. Register by surface

Columns: **Tier** (T1/T2/T3/Gap/Not true) · **Plan** (seeded entitlement, `0153_pricing.sql`) ·
**Approved phrasing** · **Never say** · **Evidence** · **Best peer claim** (source; V = verified
on the vendor's page, S = search snippet only, I = from the orchestrator's brief, unverified) · **Gap note**.

### 3.1 Domains and certificates

| Capability | Tier | Plan | Approved phrasing | Never say | Evidence | Best peer claim | Gap note |
|---|---|---|---|---|---|---|---|
| Lookalike / typosquat detection for every monitored brand | T1 (coverage, volume) / T3 (generation method, TLD list, scoring) | Domain (Pro+) | "Every brand we monitor gets continuous lookalike-domain coverage: newly registered look-alikes, character swaps and brand-plus-keyword domains." | Permutation types, how many variants, which registries/NRD source, the "registered" test | `W/scanners/lookalike-domains.ts`, `W/lib/monitored-brands.ts` (`MONITORED_BRAND_PREDICATE_SQL`), stats insight "1190 checked, 696 registered (24h)" | Bolster: automated detection plus free checkers (I) | Volume is publishable (P4) |
| Page-content phishing scoring on lookalikes | T2 | Domain | "We fetch and analyse what a lookalike actually serves, so a parked domain and a live credential-harvesting page are not scored the same." | Signals, weights, anti-bot wall families, wall rate, kit/exfil detection (`page_analysis` block) | `W/lib/page-fetch.ts`, `W/lib/page-phishing-scorer.ts` | Netcraft/Bolster page classification (I) | Cloaking blind spot = T3, always |
| Certificate Transparency monitoring | T1 (that we do it) / T3 (cadence, source) | Domain | "Certificate-transparency monitoring flags new TLS certificates on brand look-alikes." | "Real-time", crt.sh, poll interval | `W/scanners/ct-monitor.ts:1-7` (hourly) | Most peers claim real-time (I) | G13 |
| Weaponization velocity (registration → live threat) | T1 (aggregate distribution) / T3 (bands, use in scoring) | — | "X% of brand-targeting phishing domains we saw went live within 24 hours of registration." | That it never gates triage; band cut-offs | `W/../migrations/0259_*.sql`, `threats.weaponization_flag`, diagnostics `velocity` | — | **Not published (G16).** The stamp writer runs only from `POST /api/admin/velocity/backfill`, so the 30-day sample is usually < 30, and prod has no `threats(first_seen)` index for a cheap public read. Removed from `/api/v1/public/stats` `proof` on 2026-10-05 |
| Phishing / malware feed ingestion | T1 (count "40+ sources", total volume) / **T3 (names, vendors, per-feed volume)** | All | "We correlate 40+ phishing, malware and infrastructure intelligence sources." | Any feed or vendor name, enrichment APIs | 46 enabled (`/api/v1/public/feeds`), ~12 with 0 records today, several are context lists (Tor exits, disposable email, CVE/KEV) | — | L19. Say "40+", not "46 brand-protection feeds" |
| Free brand scan (no signup) | T1 | Free | "Enter any domain: email-authentication grade, look-alike domains, social-handle check and an exposure score, free, no signup." | Scoring deductions (`W/handlers/brandScan.ts:224-248`), spam-trap counts method | `W/handlers/brandScan.ts`, `W/routes/scan.ts:31` | Bolster free checkers (I) | Ahead: combines email posture + impersonation |

### 3.2 Email

| Capability | Tier | Plan | Approved phrasing | Never say | Evidence | Peer | Gap |
|---|---|---|---|---|---|---|---|
| SPF/DKIM/DMARC posture grading (A+–F) | T1 | Free (grade), Pro+ (monitoring) | "Continuous SPF, DKIM and DMARC grading, A+ to F." | Grade weights | `W/email-security.ts`, `/api/v1/public/email-security/:domain` | Few DRP peers bundle this (I) | Ahead (A3) |
| DMARC aggregate report ingestion | T2 | — (not on pricing) | "We can receive and parse your DMARC aggregate reports." | Mailbox routing | `W/dmarc-receiver.ts` | — | Unmarketed. Confirm it reaches the tenant UI before claiming it |
| Spam-trap network (spoofed mail seen impersonating a domain) | T2 | — | "We observe spoofed mail impersonating brands." | Trap addresses, count, domains | `W/spam-trap.ts`, `W/agents/public-trust-check.ts:115` | — | Never reveal trap locations |
| Abuse Mailbox (branded report inbox) | T1 (workflow) / T2 (classification) / T3 (rules, cap, model) | **Enterprise** per seed (site says Business, L9) | "Employees and customers forward suspicious email to one address. Each report is acknowledged instantly, classified automatically and, if it's phishing, added to your threat feed and queued for takedown." | "AI decides", model name, daily cap, clamp rules, what it dismisses | `W/../migrations/0150_abuse_mailbox.sql`, `W/lib/workers-ai.ts`, `W/agents/abuseMailboxClassifier.ts` | — | L1, L11 |

### 3.3 Social, apps, executives

| Capability | Tier | Plan | Approved phrasing | Never say | Evidence | Peer | Gap |
|---|---|---|---|---|---|---|---|
| Social impersonation | T1 (platform list) / T3 (handle-probe method, 0.5 threshold, official-handle dismissal) | Social (Pro+) | "Fake accounts and handle-squatting on X, LinkedIn, Instagram, TikTok, GitHub and YouTube." | Threshold, permutation count, that only existing handles are probed | `W/scanners/social-monitor.ts:43,55`, `W/lib/alert-triage.ts` | ZeroFox/Doppel: broad social incl. Facebook, Telegram (I) | G12 (Facebook) |
| App-store impersonation | T1 (Apple App Store) | App store (Pro+) | "Look-alike apps on the Apple App Store." | Google Play (not built) | `W/scanners/app-store-monitor.ts:4,289` (iTunes Search API only) | Peers: iOS + Google Play + third-party stores (I) | **Gap G7** |
| Executive impersonation | T1 | (crossover surface; not a plan module) | "Watches the executives you name for impersonation accounts on the same six platforms." | Name-permutation method | `W/scanners/executive-monitor.ts`, `W/../migrations/0244` | ZeroFox exec protection (I) | Unmarketed on pricing |
| Trademark monitoring | T2 | **Business** (seed) | "A trademark view that collects every misuse of your name across domains, social and apps in one place." | Logo/image matching (not built: Phase 2) | `W/scanners/trademark-monitor.ts:1-25` | BrandShield logo/marketplace (I) | Marketplaces + logo = Gap |

### 3.4 Dark web

| Capability | Tier | Plan | Approved phrasing | Never say | Evidence | Peer | Gap |
|---|---|---|---|---|---|---|---|
| Paste-site + ransomware leak-site mentions | T1 (source *types*) / T3 (named sources) | Dark web (**Business** per seed) | "Monitors paste sites and ransomware leak-site victim lists for your brand, domains and executives." | "Dark web forums", "credential dumps", "stealer logs", source names | `W/scanners/dark-web-monitor.ts:1-10,816-821`, `W/feeds/telegram.ts` (public channels, `degraded`, 0 today) | ZeroFox, Recorded Future: forums, markets, leaked credentials, code leaks (I) | **Gap G8** (credentials) |

### 3.5 Correlation and intelligence (the differentiator)

| Capability | Tier | Plan | Approved phrasing | Never say | Evidence | Peer | Gap |
|---|---|---|---|---|---|---|---|
| Infrastructure clustering into operations | **T2** | Threat-actor module (**Enterprise**); campaigns view in ops | "Averrow links individual phishing domains, IPs and certificates into operations by the infrastructure they share, so you see the campaign behind each alert and notice when it moves." | Lane names/order (cert serial, SAN, per-IP, /24, registrar, ASN), fan-out thresholds, bridge rules, 4-hour cadence | `W/agents/nexus.ts:1-23`, `W/lib/cluster-components.ts`, `infrastructure_clusters` | Doppel "Threat Graph" links incidents into an attack story (I/S) | Parity with Doppel on the claim. Our edge is breadth (cross-brand, 1.3M threats) and transparency. Pro/Business don't get it (G15) |
| Infrastructure movement / pivot detection | T2 | Enterprise | "We alert when an operation moves to new hosting, networks or certificates." | Trigger thresholds (>80% drop etc.) | `CLAUDE.md` §6 `pivot_detected` | — | Ahead if shown with an example |
| Threat-actor profiles / attribution | T2 (cautious) | Enterprise | "Where public reporting names the actor behind infrastructure we've clustered, we link it." | "We identify who is attacking you", AI attribution | `W/agents/attributor.ts:1-30` (OTX inheritance + human backlog; AI removed) | Recorded Future actor intel (I) | Don't lead with WHO (AI_STRATEGY §1) |
| Campaigns | T1 (count) | — | "6,000+ campaigns tracked." | Naming method | `/api/v1/public/stats` `threat_campaigns: 6097` | — | — |
| Hosting-provider mapping | T1 (count) / T3 (provider scoring) | — | "12,000+ hosting providers mapped against threat activity." | Scores, "worst providers" naming of real providers in public | `providers_mapped: 12147` | — | Naming bad hosts publicly = legal review |

### 3.6 Alerting and workflow

| Capability | Tier | Plan | Approved phrasing | Never say | Evidence | Peer | Gap |
|---|---|---|---|---|---|---|---|
| Alert auto-triage | T2 / **T3 rules** | All | "Low-value noise is dismissed automatically, with the reason recorded, so your queue holds what needs a decision." | Any dismissal rule, threshold or enrichment condition (evasion-relevant) | `W/lib/alert-triage.ts` | — | Never publish triage rules |
| Investigations (case management) | T1 | All tenant | "Group alerts, threats and takedowns into a case with notes and an audit trail." | — | `T/features/investigations`, `W/handlers/tenantInvestigations.ts` | — | Unmarketed |
| Managed SOC handling ("Averrow SOC") | T1 | — | "Averrow's analysts can triage and act on alerts for you; you see every action, marked as Averrow SOC." | Staff names | CLAUDE.md §7 PR-C | Bolster/Axur managed service (I) | Unmarketed |
| Notifications / push / email | T1 | All | "In-app, email and push alerts." | — | `W/lib/push.ts`, tenant `notifications` | — | — |
| Webhooks + SIEM/ticketing connectors | Gap (event coverage) → T1 after G4 | Business (site) | see L14/L15 | "Real-time", "self-serve" | `W/lib/org-events.ts`, `W/lib/integration-delivery.ts` | ZeroFox/RF: many connectors (I) | G4, G5 |
| Customer REST API | **Not true** | Pro+ (site) | — | "API access" | L3 | Standard among peers | G2 |
| STIX export | Not true for customers (staff-only) | — | "STIX 2.1 export on request" | "TAXII" | `W/routes/export.ts:17-26`, `W/handlers/stixExport.ts` | Standard | G3 |

### 3.7 Takedowns

| Capability | Tier | Plan | Approved phrasing | Never say | Evidence | Peer | Gap |
|---|---|---|---|---|---|---|---|
| Takedown submission (automated, under signed authorization) | T1 (workflow) / T3 (submitter names, routes) | All modules (domain only for tenant self-request) | "Takedowns are submitted automatically under an authorization you sign, to registrars and browser blocklists, with a full audit trail." | Provider/API names (NetBeacon, GoDaddy, Web Risk), send mode, fallbacks | `W/../migrations/0226_*.sql`, `W/lib/takedown-submitters/*`, `wrangler.toml:357` | Bolster "takedowns in minutes" (I); Netcraft median 33 min to 2.6 h phishing (S) | Tenants can request only from domain findings (AI_STRATEGY §1, `T/lib/domainModule.ts:178-202`) |
| Stay-down re-checks | T1 | — | "Removed domains are re-checked; if one comes back, you're alerted to re-file." | 7-day cadence, batch size | `W/agents/sparrow.ts:300-360` (Phase F: re-checks `takedown_requests` with `status='taken_down'` and `target_type` domain/url every 7 days, 20 per run, raises `takedown_resurrected`) | Axur 15-day stay-down guarantee (I) | Unmarketed. Re-verified 2026-10-05 against a report that it is not built: it is built, but only covers takedowns an operator has marked `taken_down` (ops `PATCH /api/admin/takedowns/:id`); automated submissions stop at `submitted`/`pending_response` until then. A *guarantee* is commercial, not product |
| Takedown speed / success metrics | **Gap (gated)** | — | Nothing public until owner sign-off (S1.5) and n ≥ 30 resolved | Any number before sign-off | `W/lib/takedown-metrics.ts` (p50/p90, true-removal rate), `GET /api/admin/takedowns/metrics` (`W/routes/admin.ts:634`, ops-only) | Axur 98.9% / median 9h (I; snippet shows 99.6% in one case study, S); BrandShield 98% (I); Netcraft as above (S) | **G6: highest-value gap** |

### 3.8 Platform, trust, commercial

| Capability | Tier | Approved phrasing | Never say | Evidence | Gap |
|---|---|---|---|---|---|
| Transparent pricing | T1 | "$1,499/mo Professional, $3,999/mo Business, monthly, no minimum." | Module prices beyond the page | `M/pricing.astro`, `0153_pricing.sql` | Ahead (A2) |
| Public status page with 30-day uptime | T1 | "Live public status page with 30-day history." | Feed-level internals | `/status`, `/api/v1/public/platform-status` (feeds 94.3% 30d) | Honest (shows degraded days) |
| Passkeys / biometric sign-in | T1 | "Passkey and biometric sign-in." | — | `W/handlers/passkeys.ts` | — |
| SSO / SAML / SCIM | **Not true** | — | — | L2 | G9 |
| Tenant isolation / RBAC | T1 (outcome) / T3 (mechanism) | "Every customer organisation is isolated, with role-based access and a full audit log." | Guard names, staff-crossover rules | CLAUDE.md §7 | — |
| Compliance | T1 as it is | GDPR-aligned, PIPEDA, WCAG 2.1 AA. SOC 2 status per owner | "SOC 2 compliant" | L16 | — |
| Agent mesh / count / codenames | **T3** | Describe functions, not agents | Codenames, "42/44 agents", cron cadence | `W/agents/index.ts` | L10 |
| AI | Not true while `rules_only` | "Automated analysis", "rule-based correlation". Abuse mailbox: "automated second opinion" | Model/provider names, "AI-native" | `wrangler.toml:370,376` | Revisit at AI_STRATEGY Phase 2 |
| Architecture / cost basis | T3 (sub-processor disclosure excepted) | — | "Cloudflare Workers" as positioning | L21 | — |

---

## 4. Gap backlog (ranked: marketing value ÷ effort)

| Rank | ID | Smallest product change | Claim it unlocks | Size | Owner |
|---|---|---|---|---|---|
| 1 | G1 | Add cached aggregates to `GET /api/v1/public/stats` (`cachedValue`, 1h TTL): lookalikes registered (30d), operations (`infrastructure_clusters` / `component_id` count), median registration→detection hours and the ≤24h share (`threats.weaponization_hours`), monitored-brand count (`tier IN ('monitored','customer')`). Remove `detection_time_label`. Fix L20. **Shipped 2026-10-05 as `proof.*` except the velocity share (moved to G16).** | "Monitors N brands; found X new look-alike domains last month; Z active operations tracked." | S | backend |
| 2 | G4 | Fan out `alert.created` (and `threat.detected`) from `createAlert` / `lib/alert-fanout.ts` via `emitOrgEvent` for domain, CT, threat and executive alerts | Webhooks + Splunk/Sentinel/QRadar/Jira/ServiceNow "receive every alert" (L14/L15 become true and stronger than the site) | S | backend |
| 3 | G3 | Tenant route `GET /api/orgs/:orgId/export/stix` reusing `handleSTIXExport`, scoped to org brands, plus a tenant button | "STIX 2.1 export of your findings" (no TAXII) | S | backend + frontend |
| 4 | G6 | (a) Owner sign-off on S1.5. (b) Publish takedown p50 and true-removal rate when resolved n ≥ 30. (c) Show org-scoped metrics on the tenant takedowns page. | "Median time to removal: Xh; Y% of adjudicated takedowns removed" (direct answer to Axur/Netcraft/BrandShield) | S (b) / M (c) | owner → backend/frontend |
| 5 | G2 | API-key auth: middleware hashing `X-API-Key` against `org_api_keys` (scopes, expiry, revocation), read-only on tenant GETs, rate-limited, documented | "REST API access" (Pro) | M | backend + appsec-reviewer |
| 6 | G10 | Turn on the tenant weekly digest (`TENANT_DIGEST_MODE`) after QA. Default `weekly_digest` on | "Weekly brand-risk briefing" (replaces the false "daily") | S (switch: owner OK) | backend/owner |
| 7 | G5 | Tenant Settings → Integrations/Webhook UI on the existing routes | "Self-serve SIEM, ticketing and webhook connectors" | M | frontend |
| 8 | G15 | Expose a cluster/operation view (read-only) in Business for the org's brands, or move `threat_actor` into Business | "Campaign intelligence" in Business becomes true (fixes L9 the other way) | M (pricing: owner) | owner + frontend |
| 9 | G11 | Apply `monitoring_config_json` rules (keyword include/exclude, severity floor) in alert creation for the org | "Custom monitoring rules" | M | backend |
| 10 | G13/G14 | Make the `certstream` feed healthy, or tighten CT to sub-hourly for monitored brands. Instrument `first_seen → alert.created_at` latency | "New look-alike certificates flagged within minutes" (measured) | M | backend |
| 11 | G7 | Google Play search in `W/feeds/` + app-store monitor `platform='google_play'` | "Apple App Store and Google Play" | M | backend |
| 12 | — | Tenant takedown request from social, app-store and dark-web findings | "One-click takedown from any finding" | M | backend + frontend |
| 13 | G12 | Facebook (and Telegram handle) coverage in social monitor | "Seven platforms incl. Facebook" | M | backend |
| 14 | G8 | Buy HIBP Pro (stealer logs) and enable `W/feeds/hibp.ts`, tenant surfacing | "Credentials for your domain found in stealer logs" | M ($, owner) | owner + backend |
| 15 | G9 | OIDC SSO (then SAML/SCIM) via a broker | "SSO for Enterprise" | L | backend + appsec |
| 16 | G16 | Schedule the velocity writer (today admin-only `POST /api/admin/velocity/backfill`) and give the 30-day read a cheap source (cube or `threats(first_seen)` index), then re-add the share to `proof` with the n ≥ 30 floor | "Y% of phishing domains we saw went live within 24h of registration" | S/M | backend |

---

## 5. Approved proof points (T1)

Publish these with an "as of" date. Never mix the two threat totals.

| # | Proof point | Current value | Source | Status |
|---|---|---|---|---|
| P1 | Threats tracked to date | 1.3M+ (`threats_detected`). Cube sum 1,175,038 | `GET /api/v1/public/stats` → `threats_detected` (`COUNT(*) FROM threats`, `W/lib/public-stats.ts:75`) | Live. Use `threats_detected` only |
| P2 | Hosting providers mapped | 12,147 | `/api/v1/public/stats` → `providers_mapped` (`COUNT(DISTINCT hosting_provider_id) FROM threat_cube_provider`) | Live. "12,000+" |
| P3 | Countries observed | 215 | `/api/v1/public/stats` → `countries` (`threat_cube_geo`) | Live |
| P4 | Look-alike domains found | 696 registered of 1,190 checked (24h, from insight text) | `/api/v1/public/stats` → `proof.lookalikes_found_30d` (`registered=1 AND first_seen >= now-30d`) | Live (1h cache) |
| P5 | Campaigns tracked | 6,097 | `/api/v1/public/stats` → `threat_campaigns` | Live. "6,000+" |
| P6 | Brands under continuous monitoring (all get look-alike coverage) | ~1,867 per CLAUDE.md §8 (2026-09-30) vs `brands_monitored` 817 (`monitored_brands` active) | `/api/v1/public/stats` → `proof.monitored_brands` (`tier IN ('monitored','customer')`) | Live. Use this definition, not `brands_monitored` |
| P7 | Operations (infrastructure clusters) | — | `/api/v1/public/stats` → `proof.operations_tracked` (distinct `COALESCE(component_id, id)`, status active/accelerating/pivot, seen in 30d) | Live |
| P9 | New threats today | 9,097 | `/api/v1/public/stats` → `threats_classified_today` | Live. Never call it "certificates" |
| P10 | 1M threats milestone | 2026-08-24 | `GET /api/v1/public/milestones/latest` | Live |
| P11 | Public 30-day uptime | per category (feeds 94.3%) | `GET /api/v1/public/platform-status` | Live. Honest, includes degraded days |
| P12 | Takedown median time / removal rate | — | `GET /api/admin/takedowns/metrics` (ops) | **Blocked: owner sign-off S1.5, n ≥ 30** |

---

## 6. Where we are ahead (approved T2 phrasing)

| # | Claim | Approved phrasing | Caveat |
|---|---|---|---|
| A1 | Infrastructure correlation → operations, across the whole catalog | "Averrow doesn't stop at the alert. It links phishing domains, IPs and certificates that share infrastructure into operations, across more than a million threats and every brand we watch, so you see the campaign, and know when it moves." | Doppel claims a similar Threat Graph (I). Differentiate on breadth and visibility, not existence. True for Enterprise today; G15 for Business |
| A2 | Published, monthly pricing | "Published prices. Professional $1,499/mo, Business $3,999/mo. Month-to-month, no minimum contract." | Most peers are quote-only. Re-verify per peer before naming one |
| A3 | Email-authentication posture and impersonation in one view, free to try | "One exposure picture: your SPF/DKIM/DMARC grade alongside the look-alike domains and fake accounts using your name. Run it free on any domain, no signup." | Bolster offers free checkers (I). The bundle is the edge |
| A4 | Explainable, evidence-first scoring | "Every score traces back to evidence you can see: deterministic correlation, no black box." | True *because* of `rules_only`. Revisit at AI Phase 2 |
| A5 | Stay-down re-checks + visible SOC actions | "Removed domains are re-checked, and if one returns you're told. Every action our analysts take is visible in your console." | Not a guarantee. Don't match Axur's 15-day promise without a commercial decision |

---

## 7. Competitor claim log

| Peer | Claim | Source status |
|---|---|---|
| Doppel | Threat Graph links incidents into an attack story; OpenAI case study 80% less analyst work | I (orchestrator brief, snippet-sourced) |
| Bolster | Automated takedowns in minutes; free checkers | I |
| Netcraft | Median phishing takedown cited as 33 min, 2.1 h and 2.6 h in different places; disruption within 5 min; conversational scam intelligence | S (search snippets of netcraft.com, 2026-10-05; vendor pages not fetched) + I |
| Axur | 98.9% success, median 9h, 15-day stay-down guarantee | I. A snippet shows **99.6%** in one retail case study (S, discover.axur.com PDF) |
| BrandShield | 98% takedown success | I |
| Memcyco | Real-time per-victim visibility on cloned sites (customer-side JS beacon) | I. Category we do not play in |
| ZeroFox | Dark web + takedown + breach response | I |
| Recorded Future | Leaked credentials, code leaks | I |

Vendor sites were not fetched. Before any comparative copy names a peer, `market-analyst`
must verify the claim on the vendor's own page.
