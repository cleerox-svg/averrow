# AVERROW — TECHNICAL ROADMAP

**Document owner:** Claude Leroux, Founder & CTO — LRX Enterprises Inc.
**Last updated:** March 2026
**Status:** Pre-seed / Active development

---

## 1. ARCHITECTURE OVERVIEW

Averrow is a brand protection platform built entirely on Cloudflare's edge infrastructure. The architecture is serverless, globally distributed, and designed for low operational cost at scale.

### Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Compute | Cloudflare Workers (TypeScript) | API, rendering, email processing, agent execution |
| Database | Cloudflare D1 (SQLite) | Primary data store — brands, threats, agents, users |
| Cache | Cloudflare KV | Session data, rate limits, feed state, dashboard caching |
| Storage | Cloudflare R2 | Evidence artifacts, email bodies, screenshots |
| AI | Anthropic Claude Haiku | Threat classification, evidence assembly, lead generation |
| DNS/CDN | Cloudflare | SSL, DDoS protection, email routing, domain management |
| CI/CD | GitHub Actions | Automated typecheck → migration → deploy on merge to master |
| Coordination | Cloudflare Durable Objects | Real-time threat push notifications |

### Why This Stack

The entire platform runs on two production dependencies (`itty-router` and `zod`). No Express, no ORM, no Redis, no container orchestration. This is intentional:

- **Cost:** Current infrastructure cost is under $25/month for the full platform including AI calls. Traditional cloud architecture (EC2, RDS, ElastiCache) would cost $500-2,000/month for equivalent capability.
- **Performance:** Every API response is served from the nearest Cloudflare edge location (~200 cities). Cold start is <5ms.
- **Reliability:** No servers to manage, no scaling configuration, no database connection pooling. Cloudflare handles all of this.
- **Security:** No open ports, no SSH access, no container vulnerabilities. The attack surface is Cloudflare's edge, which they secure.

### Codebase Metrics (current)

| Metric | Value |
|--------|-------|
| TypeScript source files | 203 |
| TypeScript lines of code | ~46,700 |
| SPA (app.js) | 9,631 lines |
| CSS (styles.css) | 4,034 lines |
| Database migrations | 46 |
| API routes | 300+ |
| Database indexes | 166 |
| AI agents | 7 (Sentinel, ASTRA, Navigator, Strategist, Observer, Pathfinder, Sparrow) |
| Production dependencies | 2 (itty-router, zod) |

---

## 2. WHAT WE'VE BUILT

### Core Platform

- **Threat Detection Engine:** Ingests from 45+ intelligence feeds (PhishTank, URLhaus, OpenPhish, Certificate Transparency, CISA KEV, etc.) on a 30-minute cycle. Currently tracking 9,300+ brands and 20,000+ active threats.
- **Email Security Posture Engine:** Scans SPF, DKIM (12+ selectors), DMARC, and MX configuration. A+ through F grading methodology. 3,800+ scans completed.
- **Social Airspace Monitoring:** Monitors six platforms (Twitter/X, LinkedIn, Instagram, TikTok, GitHub, YouTube) for brand impersonation. AI-powered confidence scoring and classification.
- **Observatory:** Real-time global threat visualization with deck.gl/MapLibre GL — maps threat infrastructure, attack origins, and brand exposure geographically.
- **Campaign Intelligence:** AI-driven clustering correlates threats into organized campaigns, tracks attack patterns across brands and providers.
- **Infrastructure Intelligence:** Maps hosting providers, ASNs, and registrars. Reputation scoring based on threat density, response times, and trends.

### AI Agent Squadron (7 agents)

Each agent is an autonomous module with its own execution cycle, error handling, and output persistence:

| Agent | Function | Schedule |
|-------|----------|----------|
| Sentinel | Certificate & domain surveillance, threat classification | Event-driven (on new data) |
| ASTRA | Threat scoring, brand matching, severity assessment | Every 15 minutes |
| Navigator | IP geolocation, infrastructure mapping, provider scoring | Every 6 hours |
| Strategist | Campaign correlation, attack pattern clustering | Every 6 hours |
| Observer | Trend analysis, daily intelligence briefings | Daily |
| Pathfinder | Sales intelligence — identifies prospects from platform data | Weekly (Phase 1) + per-run enrichment (Phase 2) |
| Sparrow | Takedown agent — URL scanning, evidence assembly, provider resolution, submission drafts | Every 6 hours |

### Spam Trap Network

- Catch-all email routing on multiple domains
- 29+ seed addresses across 10 channels (Brand, Employee, Contact Page, Forum, etc.)
- Automatic brand matching, email authentication analysis, URL extraction
- Feeds directly into Sparrow's takedown pipeline

### Multi-Tenant Architecture

- Organization model with RBAC (owner, admin, analyst, viewer)
- SCIM-ready columns for future Okta/Azure AD provisioning
- Per-org brand assignment, monitoring configuration, webhook/SIEM integration
- HMAC-SHA256 signed webhook delivery
- Audit trail on all actions

### Takedown Pipeline (Sparrow)

- Auto-creates takedown requests from malicious URLs and social impersonation signals
- AI-powered evidence assembly via Claude Haiku
- Hosting provider detection via DNS resolution and infrastructure mapping
- Abuse contact directory with 21 seeded providers
- Submission draft generation (provider-specific templates for registrars, hosting, social platforms)
- Human-in-the-loop review workflow with status transitions

---

## 3. RECENT CODE REVIEW (completed)

An 8-phase code review was completed to improve maintainability, type safety, and performance:

| Phase | What | Result |
|-------|------|--------|
| 1 | Dead code removal | -3,278 lines, 2 deprecated files deleted, ~417 debug statements removed |
| 2 | Split monolithic index.ts | 2,003 → 160 lines, 14 focused route modules |
| 3 | Data access layer | 22 typed db functions in src/db/, 3 duplicate utilities consolidated |
| 4 | Type safety | 65 type definitions centralized, 34/34 unsafe casts eliminated (0 remaining) |
| 5 | CSS class extraction | 1,050 → 555 inline styles (47% reduction), component class library established |
| 6 | Handler consolidation | 11 reusable handler utilities, -213 lines of boilerplate |
| 7 | Agent pipeline optimization | 4 N+1 query patterns fixed, ~30-70 fewer queries per cron cycle, cron jitter added |
| 8 | Performance audit | 9 composite indexes added, 3 KV-cached endpoints, 7 unbounded queries fixed |

---

## 4. KNOWN TECHNICAL DEBT

We are transparent about what needs improvement. These items are prioritized and scheduled.

### High Priority — Frontend Architecture

**The SPA (app.js) is a monolithic vanilla JavaScript file.**

This is the most significant technical debt. The 9,631-line file uses template literals for rendering, has 555 remaining inline styles, and lacks component reuse. It was built for speed during the MVP phase and it works — but it does not scale for a team.

**Plan:** Full migration to React + TypeScript + Tailwind CSS + shadcn/ui. See Section 5.

### Medium Priority — Test Coverage

**No automated test suite exists.**

The platform has been validated through manual testing and live production data. However, there are no unit tests, integration tests, or end-to-end tests.

**Plan:** Implement testing in phases during the React migration:
- Phase 1: API integration tests for critical paths (auth, brand scan, agent execution, takedown creation)
- Phase 2: React component tests with Vitest + React Testing Library
- Phase 3: End-to-end tests with Playwright for key user flows
- Target: 70%+ coverage on business-critical paths within 3 months

### Resolved — Backend Naming (2026-07-17)

**Was:** internal references used "trust-radar" (the pre-rebrand name) —
the Cloudflare Worker, package folder, and GitHub repo directory.

**Now:** the backend package renamed `packages/trust-radar` →
`packages/averrow-worker`, the deployed Worker `trust-radar` → `averrow`,
and the GitHub repo `cleerox-svg/averrow` → `cleerox-svg/averrow`.
Display strings and feed outbound User-Agents were swept to Averrow.

**Intentionally kept** (not a naming cosmetic — renaming these is a data
migration or a breaking wire-contract change): the D1 databases
(`trust-radar-v2`, `trust-radar-v2-audit`, `trust-radar-dns-queue`), the R2
bucket (`trust-radar-trademark-assets`), the Analytics Engine dataset
(`trust_radar_d1_reads`), the outbound webhook headers
(`X-Trust-Radar-Signature`/`-Event`/`-Delivery`, UA `TrustRadar-Webhook/1.0`),
and the frozen legacy `public/manifest.json` PWA name. See
`docs/TERMINOLOGY_LEXICON_2026-07.md` for the full decision record.

### Low Priority — Remaining Inline Styles

555 inline style attributes remain in app.js. A CSS component class library is established and these can be systematically replaced. This becomes moot once the React migration replaces the SPA entirely.

### Low Priority — Handler Migration

45 handler files have TODO comments for migration to the handler-utils pattern established in the code review. The pattern is proven (3 handlers refactored), remaining handlers work correctly — they just have more boilerplate than necessary.

---

## 5. FRONTEND MIGRATION PLAN — React

### Target Architecture

| Concern | Technology | Rationale |
|---------|-----------|-----------|
| Framework | React 18+ with Vite | Fast builds, excellent DX, largest ecosystem |
| Language | TypeScript (strict) | Already used server-side, consistent stack |
| Styling | Tailwind CSS | Utility-first, no runtime CSS, existing class library maps directly |
| Components | shadcn/ui (Radix primitives) | Accessible, customizable, professional quality |
| State | TanStack Query (React Query) | Server state management, caching, optimistic updates |
| Routing | TanStack Router or React Router v7 | Type-safe routing |
| Tables | TanStack Table | Sorting, filtering, pagination, column pinning |
| Charts | Recharts or Tremor | React-native charting, compatible with Tailwind |
| Maps | deck.gl + MapLibre GL (keep) | Already excellent, no change needed |
| Forms | React Hook Form + Zod | Validation already uses Zod server-side |
| Testing | Vitest + React Testing Library + Playwright | Unit, component, and E2E |

### Migration Strategy

The migration is **incremental, not a rewrite**. The API layer stays exactly as-is. Only the frontend changes.

**Phase 1: Scaffold + Auth (Week 1)**
- Vite + React + TypeScript + Tailwind project inside the monorepo
- API client layer with TanStack Query hooks
- Authentication flow (Google OAuth, JWT refresh)
- Layout shell (nav, sidebar, footer)
- Deploy alongside existing SPA — feature flag to switch

**Phase 2: Core Views (Weeks 2-3)**
- Observatory (deck.gl integration — already React-compatible)
- Brands hub + detail
- Providers hub + detail
- Campaigns hub + detail

**Phase 3: Admin Views (Weeks 3-4)**
- Dashboard with stat cards
- Agent Config + Operations
- Spam Trap command center
- Takedown SOC queue (with Sparrow evidence panel)
- Lead management (Kanban + Pipeline views)

**Phase 4: Tenant Views (Week 5)**
- Organization dashboard
- Brand monitoring config
- Takedown workflow
- Webhook/SIEM settings

**Phase 5: Polish + Testing (Week 6)**
- Accessibility audit
- Performance optimization (code splitting, lazy loading)
- E2E test suite for critical flows
- Remove legacy app.js

### Component Library Design

The Averrow design system (documented in `AVERROW_UI_STANDARD.md` and `RESTRUCTURE_SPEC.md`) maps directly to React components:

```
src/components/
  ui/              — shadcn/ui primitives (Button, Card, Badge, Table, etc.)
  layout/          — Shell, Sidebar, TopBar, Footer
  agents/          — AgentCard, AgentDetail, AgentHealth
  brands/          — BrandCard, BrandDetail, ThreatList
  observatory/     — ObservatoryMap, ThreatArc, FilterPanel
  takedowns/       — TakedownQueue, EvidencePanel, SubmissionDraft
  charts/          — ThreatTrend, AgentActivity, ExposureGauge
```

Each component is self-contained with its own types, styles (Tailwind), and test file. Maximum 200 lines per component.

---

## 6. PRODUCT ROADMAP — NEXT 6 MONTHS

### Q2 2026 (Now → June)

| Priority | Feature | Status |
|----------|---------|--------|
| 1 | Sparrow takedown pipeline | ✅ Phases 1-5 complete, testing |
| 2 | React frontend migration | Starting |
| 3 | AI phishing detection from spam trap captures | Planned |
| 4 | Test suite (API + component + E2E) | With React migration |
| 5 | Feed expansion — HIBP stealer logs, abuse.ch, VirusTotal community | Planned |

### Q3 2026 (July → September)

| Priority | Feature | Status |
|----------|---------|--------|
| 1 | SSO — SAML 2.0 / OIDC (enterprise requirement) | Designed |
| 2 | Stripe payments — self-serve billing | Planned |
| 3 | External takedown API submissions (Google Safe Browsing, Netcraft, APWG) | Planned |
| 4 | DocuSign ClickWrap attestation for org onboarding | Planned |
| 5 | SCIM provisioning (Okta, Azure AD, Google Workspace) | Columns ready |

### Q4 2026 (October → December)

| Priority | Feature | Status |
|----------|---------|--------|
| 1 | Premium feed integrations (Recorded Future, CrowdStrike, DomainTools) | Planned |
| 2 | Social media API integrations (Twitter/X, Reddit) | Planned |
| 3 | Dark web / Telegram monitoring | Research |
| 4 | AI-powered detection of AI-generated phishing attacks | Research |
| 5 | Dynamic agent scaling ("Flight Controller" meta-agent) | Concept |
| 6 | DKIM2 interoperability | Tracking IETF progress |

---

## 7. SCALING CONSIDERATIONS

### Current Capacity

The platform currently handles:
- 9,300+ monitored brands
- 20,000+ threat records
- 45+ feed ingestion cycles per day
- 7 AI agents executing on schedule
- All on a single Cloudflare Worker with D1

### Scaling Path

**D1 (SQLite):** Cloudflare D1 supports up to 10GB per database with read replication. Our current database is well under 1GB. For the next 12-18 months, D1 is sufficient. If we exceed D1's limits, the migration path is Cloudflare Hyperdrive → Neon PostgreSQL (serverless Postgres) with minimal code changes since our db/ layer abstracts all queries.

**Workers:** Cloudflare Workers scale automatically. No configuration needed. Each request gets its own isolate. We can handle thousands of concurrent users without any infrastructure changes.

**AI Costs:** Current Haiku API usage is under $10/month. At 100 paying customers with full agent activity, projected AI cost is $200-500/month — well within margins at $799+/month per customer.

**Multi-Region:** Cloudflare is already global. D1 read replicas can be enabled per-region when needed. No architectural changes required.

---

## 8. SECURITY POSTURE

- All data encrypted at rest (Cloudflare D1/KV/R2 — AES-256)
- All traffic encrypted in transit (TLS 1.3, Cloudflare SSL)
- JWT authentication with 15-minute access tokens + 7-day refresh tokens
- HMAC-SHA256 signed webhook delivery
- RBAC with role hierarchy (viewer < analyst < admin < owner < super_admin)
- Full audit trail on all state-changing operations
- CORS restricted to platform domains
- CSP headers on all rendered pages
- No credentials stored in code — all secrets in Cloudflare environment variables
- Google OAuth for authentication — no password storage
- Rate limiting on public endpoints

---

## 9. WHY THIS APPROACH

The platform was built by a single developer working from mobile. Every architectural decision optimized for:

1. **Ship speed:** Cloudflare Workers + D1 means zero infrastructure management. Deploy in seconds.
2. **Cost efficiency:** Under $25/month total infrastructure. No burn rate problem.
3. **Correctness:** TypeScript strict mode, centralized types, 0 unsafe casts, typed database layer.
4. **Maintainability:** 14 route modules, 22 db functions, 11 handler utilities, comprehensive code review completed.

The vanilla JS frontend was a conscious tradeoff — it let us ship the full platform in weeks instead of months. The React migration is the natural next step now that the product is validated and the API surface is stable.

The codebase is not perfect. But it is honest, well-organized, and built on a solid foundation that scales. Every piece of technical debt is documented, prioritized, and has a plan.
