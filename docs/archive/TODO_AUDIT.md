> Archived 2026-06-10: point-in-time claims-vs-reality audit (2026-03-21).

# TRUST RADAR — TODO AUDIT

## Claims vs. Reality
**Date:** March 21, 2026

> Every feature described in Trust Radar's public-facing content (corporate site,
> pricing page, blog, changelog) is listed here with its actual build status.
> Claude Code should reference this before claiming any capability exists.

---

## STATUS KEY

```
✅ BUILT     — Exists in codebase, deployed, functional
🔨 PARTIAL   — Some code exists but incomplete or not wired up
❌ NOT BUILT — Described in public content but no implementation exists
📋 PLANNED   — In the roadmap but not described as currently available
```

---

## CORE PLATFORM

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Auth system (register, login, JWT) | Implied by dashboard | ✅ BUILT | Working in Trust Radar Worker |
| User management | Implied by auth | ✅ BUILT | users table in D1 |
| Health check endpoint | API docs | ✅ BUILT | GET /health |
| Domain migration (trustradar.ca) | All public content | 🔨 PARTIAL | Custom domain added, code migration pending (CSP, OAuth, CORS, redirects) |

## THREAT DETECTION

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Core scanning pipeline | Platform page, pricing | ✅ BUILT | CF Scanner, 30-min cron |
| Threat feed integration | Platform page, trust bar | ✅ BUILT | Multiple feeds connected |
| Safe domains allowlist | Internal | 🔨 PARTIAL | Route exists, backfill not run, migration 0017 pending |
| False positive management | Internal | 🔨 PARTIAL | Fix sequence defined but not executed |
| Lookalike domain generation | Pricing (Free scan), platform page | ❌ NOT BUILT | dnstwist-style permutation generator not implemented |
| Lookalike domain monitoring | Pricing (Professional+) | ❌ NOT BUILT | Continuous checking of registered lookalikes |
| Certificate Transparency monitoring | Pricing (Business), platform page | ❌ NOT BUILT | CT log polling not implemented |
| Credential breach/exposure alerts | Pricing (Professional+), scan report | ❌ NOT BUILT | Breach database API not integrated |

## EMAIL SECURITY

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| SPF validation | Platform page, scan report | ✅ BUILT | Via DoH |
| DKIM checking | Platform page, scan report | ✅ BUILT | Working but limited selectors |
| DMARC assessment | Platform page, scan report | ✅ BUILT | Via DoH |
| MX provider detection | Platform page, scan report | ✅ BUILT | Identifies mail provider |
| Email security grade (A+ to F) | Platform page, scan report, pricing | ✅ BUILT | Grade computation exists |
| Multi-selector DKIM (12+ enterprise selectors) | Platform page, feature deep dive | 🔨 PARTIAL | Some selectors exist, 9 new ones queued (proofpoint, mimecast, etc.) |
| Provider-aware scoring (partial DKIM credit) | Platform page | ❌ NOT BUILT | Scoring adjustment for known enterprise providers |
| Historical grade tracking | Platform page, pricing | ❌ NOT BUILT | No grade history table or trend tracking |
| Grade change alerts | Pricing, platform page | ❌ NOT BUILT | No notification on grade changes |
| Email gateway integration (Connected mode) | Platform page, about page | ❌ NOT BUILT | Optional integration with customer email security platforms |

## SOCIAL BRAND MONITORING

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Brand profile management | Pricing, platform | ❌ NOT BUILT | brand_profiles table not created |
| Social handle checking (6 platforms) | Pricing, platform page | ❌ NOT BUILT | No platform checkers implemented |
| Impersonation detection | Platform page, scan report | ❌ NOT BUILT | No impersonation signal analysis |
| Impersonation confidence scoring | Platform page | ❌ NOT BUILT | No AI scoring of social findings |
| Handle permutation generation | Platform page | ❌ NOT BUILT | Username variant generator not built |
| Executive name monitoring | Pricing (Business) | ❌ NOT BUILT | No executive monitoring |
| Evidence collection for takedowns | Platform page | ❌ NOT BUILT | No screenshot/evidence capture |
| Handle reservation status | Platform page | ❌ NOT BUILT | No platform-by-platform status view |
| Social monitoring cron | Internal | ❌ NOT BUILT | No scheduled social scanning |

## AI AGENTS

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Analyst agent (threat assessment) | Platform page, scan report | ✅ BUILT | Evaluates threats, generates assessments |
| Observer agent (daily briefings) | Platform page, pricing | 🔨 PARTIAL | Agent exists, daily briefing may not include all signal types |
| AI threat narratives (multi-signal) | Platform page, pricing (Business) | ❌ NOT BUILT | Correlated narratives connecting email + domain + social + feeds |
| Severity auto-escalation | Platform page | ❌ NOT BUILT | Compound signal escalation logic |
| Observer briefings with email security stats | Changelog entry | ❌ NOT BUILT | Email grade stats in daily briefings |
| Observer briefings with social data | Internal | ❌ NOT BUILT | Social monitoring data in briefings |
| Sales AI agent | Internal/planned | ❌ NOT BUILT | Prospect identification and outreach |

## FREE BRAND EXPOSURE REPORT

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Public scan page (/scan) | Landing page CTA, pricing | ❌ NOT BUILT | No public scan UI |
| POST /api/scan/report endpoint | Internal spec | ❌ NOT BUILT | Composite report endpoint |
| Brand Exposure Score (composite) | Scan report, platform page, pricing | ❌ NOT BUILT | Weighted composite scoring not implemented |
| Email security in report | Scan report mockup | 🔨 PARTIAL | Engine exists, not wired into composite report |
| Threat feed check in report | Scan report mockup | 🔨 PARTIAL | Scanner exists, not wired into composite report |
| Lookalike domain check in report | Scan report mockup | ❌ NOT BUILT | Permutation generator not built |
| Social handle check in report | Scan report mockup | ❌ NOT BUILT | Platform checkers not built |
| AI assessment in report | Scan report mockup | 🔨 PARTIAL | Analyst agent exists, report prompt template not built |
| Shareable report link | Pricing (Free), scan page | ❌ NOT BUILT | No report permalinks or sharing |
| KV caching for scan results | Internal spec | ❌ NOT BUILT | 24hr cache per domain |
| Rate limiting (5/hr unauth) | Internal spec | ❌ NOT BUILT | Public endpoint rate limiting |
| OG image generation for shared reports | Visual design spec | ❌ NOT BUILT | satori + resvg for social preview cards |

## PUBLIC CORPORATE SITE

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Landing page | All marketing | ❌ NOT BUILT | Prototyped but not in Worker codebase |
| Platform overview page | Nav, landing page | ❌ NOT BUILT | Prototyped in JSX |
| Feature deep-dive pages (4) | Site plan | ❌ NOT BUILT | /platform/threat-detection, etc. |
| Solutions pages (3) | Site plan | ❌ NOT BUILT | /solutions/mid-market, mssp, startups |
| Pricing page (standalone) | Nav link | ❌ NOT BUILT | Prototyped in JSX |
| About page | Nav link | ❌ NOT BUILT | Prototyped in JSX |
| Blog | Nav link, 6 posts defined | ❌ NOT BUILT | No blog system or content |
| Contact / demo request | Nav link | ❌ NOT BUILT | No contact form |
| Security & trust page | Nav link | ❌ NOT BUILT | Prototyped in JSX |
| Changelog | Nav link, 8 entries defined | ❌ NOT BUILT | No changelog system |
| Documentation hub | Footer link | ❌ NOT BUILT | No docs system |
| API reference | Footer link, pricing | ❌ NOT BUILT | No structured API docs |
| Privacy policy | Footer link | ❌ NOT BUILT | No legal content |
| Terms of service | Footer link | ❌ NOT BUILT | No legal content |
| DPA | Footer link | ❌ NOT BUILT | No legal content |
| Partners / integrations page | Site plan | ❌ NOT BUILT | |
| Observatory watermark in hero | Visual spec | ❌ NOT BUILT | Dashboard ghosted behind headline |
| Theme toggle (light/dark) | All pages | ❌ NOT BUILT | Not in Worker codebase yet |
| Stats API (social proof bar) | Landing page | ❌ NOT BUILT | Public aggregate stats endpoint |

## DASHBOARD (AUTHENTICATED)

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Dashboard home | Site plan | 🔨 PARTIAL | Basic SPA exists, not matching new specs |
| Threats view | Site plan | 🔨 PARTIAL | Some threat listing exists |
| Email security view | Site plan | 🔨 PARTIAL | Engine exists, dedicated view unclear |
| Social monitoring view | Site plan | ❌ NOT BUILT | Entire feature not built |
| Reports / threat narratives view | Site plan | ❌ NOT BUILT | |
| Settings / account page | Site plan | 🔨 PARTIAL | Basic settings may exist |
| Alert management (resolve, dismiss) | Backend spec | ❌ NOT BUILT | No alerts table or pipeline |

## INTEGRATIONS & EXPORT

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| STIX 2.1 export | Pricing (Business), platform page | ❌ NOT BUILT | No STIX serializer |
| Webhook notifications | Pricing (Business) | ❌ NOT BUILT | No webhook system |
| API access (external REST API) | Pricing (Business) | 🔨 PARTIAL | Internal API exists, not structured for external consumption |
| Slack notifications | Site plan | ❌ NOT BUILT | |
| Email notifications/alerts | Pricing (Professional) | ❌ NOT BUILT | No email alert delivery |
| SIEM integration guides | Pricing (Enterprise), site plan | ❌ NOT BUILT | |
| Connected mode (email gateway) | Platform page, about | ❌ NOT BUILT | Customer platform integration framework |
| Connected mode (SIEM/SOAR) | Platform page | ❌ NOT BUILT | |
| Connected mode (identity providers) | Unified plan | ❌ NOT BUILT | |

## ENTERPRISE FEATURES

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Multi-tenant architecture | Pricing (Enterprise) | ❌ NOT BUILT | Plan in TENANT_ARCHITECTURE.md |
| SSO (SAML/OIDC) | Pricing (Enterprise) | ❌ NOT BUILT | |
| Custom AI agent tuning | Pricing (Enterprise) | ❌ NOT BUILT | |
| SLA guarantee | Pricing (Enterprise) | ❌ NOT BUILT | |
| Dedicated account team | Pricing (Enterprise) | ❌ NOT BUILT | Operational, not code |
| SCIM provisioning | Internal plan | ❌ NOT BUILT | |
| MCP server | Internal plan | ❌ NOT BUILT | |

## INFRASTRUCTURE & OPS

| Feature | Claimed Where | Status | Notes |
|---------|--------------|--------|-------|
| Subscription billing | Pricing page | ❌ NOT BUILT | No payment processing (Stripe, etc.) |
| Usage metering | Implied by tiers | ❌ NOT BUILT | No brand count enforcement per tier |
| Unified AI client | Backend spec | ❌ NOT BUILT | ai-client.ts with retry, token tracking |
| Unified alerts pipeline | Backend spec | ❌ NOT BUILT | alerts table, notification routing |
| Cron consolidation | Backend spec | ❌ NOT BUILT | Single orchestrator pattern |
| Structured logging | Backend spec | ❌ NOT BUILT | |
| Enhanced /health endpoint | Backend spec | ❌ NOT BUILT | |
| Comprehensive rate limiting | Backend spec | 🔨 PARTIAL | Some exists, not all endpoints |

## FUTURE / ROADMAP (not claimed as current)

| Feature | Status | Notes |
|---------|--------|-------|
| Spam trap network | 📋 PLANNED | Decisions locked, code paused |
| DMARC report receiver | 📋 PLANNED | |
| AI-generated phishing detection | 📋 PLANNED | Differentiator capability |
| Telegram channel monitoring | 📋 PLANNED | |
| Sales AI agent | 📋 PLANNED | Architecture doc exists |

---

## SUMMARY COUNTS

```
✅ BUILT:      12
🔨 PARTIAL:    12
❌ NOT BUILT:  62
📋 PLANNED:     5
```

## PRIORITY BUILD ORDER (to make public claims truthful)

The corporate site describes all these features. Before going live, the minimum set to back up the claims:

### MUST HAVE before site launch:
1. Landing page built in Worker (from prototype)
2. Free Brand Exposure Report (/scan) — even if some sub-components are simplified
3. Brand Exposure Score computation (even simplified weighting)
4. Lookalike domain generation (basic permutations + DNS check)
5. Social handle checking (basic exists/doesn't-exist per platform)
6. Public corporate site pages (at minimum: landing, platform, pricing, about, contact, security)
7. Privacy policy + Terms of service (legal requirement)
8. Theme toggle (light/dark)

### SHOULD HAVE within weeks of launch:
9. Social monitoring cron + impersonation scoring
10. AI threat narratives (Analyst agent prompt for multi-signal correlation)
11. Credential breach integration
12. CT log monitoring
13. Email notifications/alerts
14. Historical grade tracking
15. Blog (first 3 posts)
16. Documentation (getting started + API basics)

### CAN FOLLOW after launch:
17. STIX 2.1 export
18. Webhook system
19. Connected mode (email gateway integration)
20. Changelog
21. Observer briefing enhancements
22. Subscription billing
23. Enterprise features (multi-tenant, SSO)

---

*This audit should be reviewed before any public deployment.
Claude Code sessions should check this list when implementing features.*
