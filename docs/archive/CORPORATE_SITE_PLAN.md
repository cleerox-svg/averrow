> Archived 2026-06-10: corporate site shipped; plan predates the Averrow rebrand (references trustradar.ca).

# TRUST RADAR — CORPORATE SITE PLAN

## Full Site Architecture & Content Strategy
**Version:** 1.0
**Date:** March 20, 2026
**Parent Company:** LRX Enterprises Inc.
**Domain:** trustradar.ca

---

## SITE MAP

The corporate site serves three audiences simultaneously: prospects evaluating the product, existing customers accessing the dashboard, and security professionals researching the platform. Every page must feel like it belongs to a real, operating cybersecurity company — not a startup template.

```
trustradar.ca/
│
├── PUBLIC MARKETING PAGES
│   ├── /                           → Landing page (BUILT — approved)
│   ├── /platform                   → Platform overview (capabilities at a glance)
│   ├── /platform/threat-detection  → Deep dive: threat feed integration + AI analysis
│   ├── /platform/email-security    → Deep dive: email posture engine
│   ├── /platform/social-monitoring → Deep dive: social brand monitoring
│   ├── /platform/ai-agents         → Deep dive: Analyst + Observer agents
│   ├── /solutions                  → Use cases overview
│   ├── /solutions/mid-market       → For companies without a SOC
│   ├── /solutions/mssp             → For managed security providers
│   ├── /solutions/startups         → For fast-growing companies
│   ├── /pricing                    → Standalone pricing page
│   ├── /scan                       → Free Brand Exposure Report tool
│   ├── /about                      → Company, mission, team, story
│   ├── /blog                       → Blog index
│   ├── /blog/:slug                 → Individual blog posts
│   ├── /resources                  → Whitepapers, guides, reports
│   ├── /contact                    → Contact form + demo request
│   ├── /security                   → Security practices, compliance, responsible disclosure
│   ├── /changelog                  → Product changelog / release notes
│   └── /partners                   → Integration partners + MSSP program
│
├── DOCUMENTATION
│   ├── /docs                       → Documentation hub
│   ├── /docs/getting-started       → Quickstart guide
│   ├── /docs/api                   → API reference
│   ├── /docs/integrations          → SIEM, webhook, STIX integration guides
│   ├── /docs/agents                → AI agent behavior documentation
│   └── /docs/changelog             → API changelog
│
├── AUTH & APPLICATION
│   ├── /login                      → Login page
│   ├── /register                   → Registration page
│   ├── /forgot-password            → Password reset
│   └── /dashboard/*                → Authenticated application (separate concern)
│
└── LEGAL
    ├── /privacy                    → Privacy Policy
    ├── /terms                      → Terms of Service
    └── /dpa                        → Data Processing Agreement
```

---

## PAGE-BY-PAGE SPECIFICATIONS

### 1. PLATFORM OVERVIEW (/platform)

**Purpose:** Single page showing all four capabilities with enough detail to understand what Trust Radar does without needing to visit individual feature pages. Acts as the "product tour."

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ HEADER                                                   │
│ "The Platform"                                           │
│ "Outside-in brand threat intelligence, powered by AI."   │
│                                                          │
│ Capability navigator (sticky horizontal bar):            │
│ [Threat Detection] [Email Security] [Social] [AI Agents] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ARCHITECTURE DIAGRAM (interactive/animated)              │
│ Show how data flows: feeds → scanners → AI agents →      │
│ dashboard. Highlight each section as user scrolls.       │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ CAPABILITY 1: Threat Detection                           │
│ Left: Description + feature bullets                      │
│ Right: Live-looking threat feed visualization            │
│ Feed type badges: Phishing DBs, Malware URLs, Threat Intel, CT Logs, Breach Intel │
│ "How it works" expandable: cron → feed check → AI eval   │
│ CTA: "Learn more →" to /platform/threat-detection        │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ CAPABILITY 2: Email Security Posture Engine              │
│ Right: Description + feature bullets                     │
│ Left: Interactive email posture card (SPF/DKIM/DMARC)    │
│ Unique selling point callout: "No competitor does this"  │
│ CTA: "Learn more →" to /platform/email-security          │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ CAPABILITY 3: Social Brand Monitoring                    │
│ Left: Description + feature bullets                      │
│ Right: Platform grid with status indicators              │
│ Handle permutation example visualization                 │
│ CTA: "Learn more →" to /platform/social-monitoring       │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ CAPABILITY 4: AI Agents                                  │
│ Right: Description + agent profiles                      │
│ Left: Example threat narrative output                    │
│ Agent comparison table: Analyst vs Observer vs Sales      │
│ CTA: "Learn more →" to /platform/ai-agents               │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ INTEGRATION SECTION                                      │
│ "Works with your existing security stack"                │
│ Grid of integration badges: Splunk, QRadar, Sentinel,    │
│ STIX/TAXII, Webhooks, Slack, Email, API                  │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ CTA: "See Pricing" / "Run a Free Scan"                   │
└─────────────────────────────────────────────────────────┘
```

### 2. FEATURE DEEP DIVES (/platform/*)

Each of the four capabilities gets a dedicated page. These are the pages a CISO or security engineer reads before recommending the product.

#### /platform/threat-detection
```
Content:
- What we monitor (feeds, CT logs, DNS, WHOIS)
- How the scanning pipeline works (30-min cron, parallel feeds, deduplication)
- Lookalike domain generation methodology (typosquat, homoglyph, TLD swap, etc.)
- Detection → Assessment → Alert flow diagram
- False positive management (safe domains allowlist)
- Sample threat alert with AI assessment
- Feed coverage table:

  | Feed Type              | Data Collected    | Update Frequency | Coverage        |
  |------------------------|-------------------|-----------------|-----------------|
  | Phishing databases     | Phishing URLs     | Real-time       | Global          |
  | Malware URL feeds      | Malicious URLs    | Hourly          | Global          |
  | Threat URL sources     | Suspicious URLs   | Real-time       | Global          |
  | Certificate Transparency | New certificates | Real-time       | All public CAs  |
  | Credential breach intel | Breached accounts | Daily           | Global          |
  | DNS intelligence       | DNS/routing data  | Real-time       | Global          |

Visual: Animated pipeline diagram showing data flowing through each stage
```

#### /platform/email-security
```
Content:
- Why email security posture matters for brand protection
- What we check: SPF record validation, DKIM multi-selector verification,
  DMARC policy assessment, MX provider detection
- DKIM selector coverage (list of 12+ enterprise selectors we check)
- Grading methodology (A+ through F, what each grade means)
- How email grade integrates with overall brand risk
- Example: "A company with an F email grade and active phishing = CRITICAL"
- Provider-aware scoring explanation (Proofpoint, Mimecast, Google, Microsoft)
- Comparison table: "What email security info other brand protection platforms provide"
  (answer: almost none)

Visual: Interactive email posture checker (mini version of the free scan, just email)
```

#### /platform/social-monitoring
```
Content:
- Platforms monitored (Twitter/X, LinkedIn, Instagram, TikTok, GitHub, YouTube)
- What we detect: impersonation accounts, handle squatting, executive impersonation,
  unauthorized brand usage, logo abuse
- How impersonation scoring works (signals: name similarity, account age, follower count,
  brand keyword usage, verification status, location mismatch)
- Handle permutation methodology (separator variations, suffix/prefix, character substitution)
- Evidence collection for takedown requests
- Platform-specific capabilities table:

  | Platform   | Handle Check | Impersonation Scan | Permutation Check | Evidence |
  |------------|-------------|-------------------|-------------------|----------|
  | Twitter/X  | ✓           | ✓                 | ✓                 | ✓        |
  | LinkedIn   | ✓           | ✓                 | ✓                 | ✓        |
  | Instagram  | ✓           | ✓                 | ✓                 | ✓        |
  | TikTok     | ✓           | ✓                 | ✓                 | ✓        |
  | GitHub     | ✓           | ✓                 | ✓                 | ✓        |
  | YouTube    | ✓           | ✓                 | Partial           | ✓        |

Visual: Social monitoring dashboard mockup showing platform grid + alert detail
```

#### /platform/ai-agents
```
Content:
- Philosophy: "Intelligence, not alerts" — why AI agents matter
- Analyst Agent profile:
  - Role: Evaluates individual threats, correlates signals, generates assessments
  - Trigger: On new threat detection, on-demand scan, social finding
  - Output: Threat narratives, severity scoring, actionable recommendations
  - Example prompt → response showing reasoning chain

- Observer Agent profile:
  - Role: Daily intelligence briefings, trend analysis, email security monitoring
  - Trigger: Daily cron (06:00 UTC)
  - Output: Daily briefing with trend data, new findings, grade changes
  - Example briefing output

- Sales Agent profile (planned):
  - Role: Mines platform data for high-value prospects
  - Status: In development

- How agents correlate across signals:
  "The Analyst doesn't just see a phishing database hit — it sees a phishing hit PLUS
  a DKIM gap PLUS a lookalike domain with MX records, and constructs a narrative
  explaining why this combination is dangerous."

- Powered by advanced AI — transparency about the technology approach

Visual: Agent "conversation" visualization showing how a threat flows through
       detection → Analyst assessment → narrative output
```

### 3. SOLUTIONS PAGES (/solutions/*)

Three use-case pages targeting specific buyer personas.

#### /solutions/mid-market
```
Headline: "Brand protection without a SOC."
Target: Companies 50-500 employees, no dedicated security team
Pain points:
  - "We know we should monitor for brand threats but don't have the team"
  - "Enterprise tools start at $20K+ and require security analysts we don't have"
  - "We found out about impersonation from a customer complaint"
Content:
  - How Trust Radar replaces a 3-person monitoring team with AI agents
  - Cost comparison: SOC analyst ($85K salary) vs Trust Radar ($799/mo)
  - What "continuous monitoring" means in practice (not just a dashboard)
  - Example: A 200-person fintech discovers 4 phishing domains in week 1
CTA: "Start with a free scan" / "See Professional plan"
```

#### /solutions/mssp
```
Headline: "Add brand threat intelligence to your managed services."
Target: Managed Security Service Providers, MSSPs, MDR providers
Pain points:
  - "Our clients ask about brand protection and we don't have an offering"
  - "We need a white-label or multi-tenant solution"
  - "We need API access and STIX export for our SIEM"
Content:
  - Multi-tenant architecture (same Worker, role-based routing, org_id isolation)
  - API-first design for integration with existing MSSP platforms
  - STIX 2.1 export for SIEM/SOAR integration
  - Revenue opportunity: "Offer brand protection at $2K-$4K/client, pay $1,999/mo for 10"
  - White-label capabilities (planned)
CTA: "Request MSSP partnership info" / "See Business plan"
```

#### /solutions/startups
```
Headline: "Protect your brand from day one."
Target: Funded startups, fast-growing companies, companies pre-IPO
Pain points:
  - "We're growing fast and attackers are noticing"
  - "We need to show investors/board we have security monitoring"
  - "We can't justify $20K+/year for brand protection yet"
Content:
  - Why early-stage companies are targets (new domains, incomplete email config)
  - The free scan as a "security audit lite" for board presentations
  - Email security posture as low-hanging fruit (fix your DKIM, improve your score)
  - Growth signals that attract attackers (press coverage, hiring, funding announcements)
CTA: "Run your free scan" / "See Professional plan"
```

### 4. ABOUT PAGE (/about) — Expanded

```
Structure:
┌─────────────────────────────────────────────────────────┐
│ HERO                                                     │
│ "Making brand threat intelligence accessible."           │
│ Subhead about LRX Enterprises Inc. mission               │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ OUR STORY                                                │
│ Why Trust Radar exists — the gap between enterprise      │
│ platforms ($20K-$150K+) and mid-market companies with real     │
│ brand threats. Founded in Canada. AI-native from day 1.  │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ OUR APPROACH                                             │
│ Three principles:                                        │
│                                                          │
│ 1. Outside-In First                                      │
│    "See your brand the way attackers do."                │
│    Works instantly with zero setup — scans the open      │
│    internet and reports what we find. Optionally          │
│    connects to your security platforms for deeper         │
│    signal and autonomous response.                        │
│                                                          │
│ 2. AI-Native                                             │
│    "Intelligence, not alert dumps."                      │
│    AI agents that reason, correlate, and narrate.        │
│    Built with the most advanced AI available from the ground up.       │
│                                                          │
│ 3. Radically Accessible                                  │
│    "Enterprise intelligence without enterprise pricing." │
│    Edge-native architecture keeps costs 10-50x lower     │
│    than traditional platforms.                           │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ COMPANY FACTS (grid)                                     │
│ 🇨🇦 Canadian-incorporated                                │
│ AI-Native — powered by advanced AI agents              │
│ Edge-First — Cloudflare Workers, zero cold starts        │
│ 6+ integrated threat intelligence feeds                  │
│ 1/2 to 2/3 less than incumbent platforms              │
│ SOC 2 compliance roadmap in progress                     │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ TECHNOLOGY                                               │
│ Detailed stack breakdown with explanations of why        │
│ each choice matters (Cloudflare for edge performance,    │
│ D1 for cost, advanced AI for reasoning quality, etc.)         │
│                                                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ CAREERS (when applicable)                                │
│ "We're building the future of accessible brand           │
│  protection. Interested? Get in touch."                  │
│ Email: careers@trustradar.ca                             │
│                                                          │
├─────────────────────────────────────────────────────────┤
│ CTA: "See the platform" / "Run a free scan"             │
└─────────────────────────────────────────────────────────┘
```

### 5. BLOG (/blog)

**Purpose:** SEO, thought leadership, product updates. A real cybersecurity company publishes regularly.

**Initial Posts to Create (legitimate content):**

```
1. "Introducing Trust Radar: AI-Powered Brand Threat Intelligence"
   Type: Product announcement
   Content: What it is, why we built it, what makes it different
   
2. "Why Your Email Security Posture Is Your Brand's Front Door"
   Type: Educational / thought leadership
   Content: How SPF/DKIM/DMARC gaps enable brand impersonation,
   why brand protection platforms should care about email config

3. "The Pricing Problem: Why Brand Protection Shouldn't Require a Six-Figure Budget"
   Type: Market positioning
   Content: Analysis of enterprise brand protection pricing,
   why AI agents change the economics, who gets left behind

4. "How AI-Generated Phishing Is Changing Brand Impersonation"
   Type: Threat intelligence
   Content: Trends in AI-crafted phishing emails and landing pages,
   why signature-based detection fails, how Trust Radar approaches it

5. "Your Brand on Social Media: Who Else Is Using Your Name?"
   Type: Educational
   Content: Handle squatting trends, impersonation techniques,
   what companies should monitor and how to respond

6. "Building Trust Radar on Cloudflare Workers: An Architecture Decision"
   Type: Engineering / behind the scenes
   Content: Why edge computing for a security platform, cost advantages,
   technical tradeoffs
```

**Blog Layout:**
```
Index: Grid of post cards (thumbnail, title, date, category tag, 2-line excerpt)
Filter by category: Product | Threat Intel | Engineering | Company
Post page: Clean editorial layout, wide content column, sidebar with TOC,
           related posts at bottom, share buttons
```

### 6. CONTACT / DEMO REQUEST (/contact)

```
Structure:
┌─────────────────────────────────────────────────────────┐
│ Two-column layout:                                       │
│                                                          │
│ LEFT: Contact form                                       │
│   - Name                                                 │
│   - Work email                                           │
│   - Company                                              │
│   - Company size (dropdown: 1-50, 51-200, 201-500, 500+)│
│   - Interest (dropdown: Free scan, Professional,         │
│     Business, Enterprise, MSSP Partnership, Other)       │
│   - Message (optional textarea)                          │
│   - Submit button                                        │
│                                                          │
│ RIGHT: Contact info                                      │
│   - "Get in touch"                                       │
│   - Email: hello@trustradar.ca                           │
│   - Security issues: security@trustradar.ca              │
│   - Response time: "We respond within 1 business day"    │
│   - LRX Enterprises Inc., Canada                         │
│                                                          │
│   Quick actions:                                         │
│   [Run Free Scan] [View Documentation] [See Pricing]    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 7. SECURITY & TRUST (/security)

**Critical for a cybersecurity company to have this page.**

```
Content:
┌─────────────────────────────────────────────────────────┐
│                                                          │
│ SECURITY PRACTICES                                       │
│ How Trust Radar handles your data:                       │
│ - Data at rest: Encrypted in Cloudflare D1               │
│ - Data in transit: TLS 1.3 everywhere                    │
│ - Authentication: JWT with bcrypt password hashing        │
│ - No agent or network access required for baseline monitoring │
│ - Outside-in scanning works instantly; optional integrations  │
│   available for deeper signal                                 │
│ - API keys rotatable, scoped per permission              │
│                                                          │
│ INFRASTRUCTURE SECURITY                                   │
│ - Cloudflare Workers: isolated V8 execution              │
│ - No shared servers, no container escape surface          │
│ - DDoS protection via Cloudflare                         │
│ - Automatic TLS certificate management                   │
│ - Zero cold-start architecture (no idle state)           │
│                                                          │
│ COMPLIANCE ROADMAP                                        │
│ - SOC 2 Type I: Target Q3 2026                           │
│ - SOC 2 Type II: Target Q1 2027                          │
│ - GDPR: Data processing practices in place               │
│ - PIPEDA: Canadian privacy compliance                    │
│                                                          │
│ RESPONSIBLE DISCLOSURE                                    │
│ "We take security seriously. If you've found a           │
│  vulnerability, please report it to:                     │
│  security@trustradar.ca                                  │
│                                                          │
│  We commit to:                                           │
│  - Acknowledging receipt within 24 hours                 │
│  - Providing an initial assessment within 72 hours       │
│  - Not pursuing legal action for good-faith reports      │
│  - Crediting researchers (with permission)               │
│  - Keeping reporters informed of resolution"             │
│                                                          │
│ THIRD-PARTY SECURITY                                      │
│ - AI: Advanced AI engine (enterprise-grade provider)         │
│ - Infrastructure: Cloudflare (SOC 2, ISO 27001)          │
│ - DNS: Cloudflare DoH (encrypted DNS resolution)         │
│                                                          │
│ DATA HANDLING                                             │
│ - Free scans: Results cached 24h, then deleted           │
│ - Paid monitoring: Data retained while subscription      │
│   is active + 30 days after cancellation                 │
│ - Threat data: Retained indefinitely for intelligence    │
│   (no PII — domain/URL-level data only)                  │
│ - No data sold to third parties                          │
│ - Data export available on request                       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 8. DOCUMENTATION HUB (/docs)

```
Layout: Sidebar navigation + main content area (standard docs pattern)

Sidebar:
├── Getting Started
│   ├── What is Trust Radar?
│   ├── Creating an account
│   ├── Adding your first brand
│   ├── Understanding your Brand Exposure Score
│   └── Setting up alerts
│
├── Platform
│   ├── Threat Detection
│   ├── Email Security Posture
│   ├── Social Brand Monitoring
│   ├── AI Agents (Analyst + Observer)
│   └── Brand Exposure Score methodology
│
├── API Reference
│   ├── Authentication
│   ├── Brands
│   ├── Scans
│   ├── Threats
│   ├── Email Security
│   ├── Social Monitoring
│   ├── Alerts
│   ├── Briefings
│   └── Export (STIX 2.1)
│
├── Integrations
│   ├── Webhooks
│   ├── STIX / TAXII
│   ├── Splunk
│   ├── Microsoft Sentinel
│   ├── Slack notifications
│   └── Email alerts
│
├── Account & Billing
│   ├── Plans & pricing
│   ├── Managing brands
│   ├── Team members (Business+)
│   └── API keys
│
└── Changelog
    └── Release notes (reverse chronological)
```

### 9. CHANGELOG (/changelog)

```
Layout: Reverse-chronological timeline, each entry has:
- Date
- Version tag (if applicable)
- Category badge (Feature | Improvement | Fix | Security)
- Title
- Description (1-3 sentences)

Example entries:
┌────────────────────────────────────────────┐
│ March 20, 2026                              │
│ [Feature] Social Brand Monitoring Launch    │
│ Monitor 6+ social platforms for brand       │
│ impersonation, handle squatting, and        │
│ unauthorized usage. AI-powered scoring.     │
├────────────────────────────────────────────┤
│ March 15, 2026                              │
│ [Improvement] DKIM Selector Expansion       │
│ Added 9 new enterprise DKIM selectors       │
│ including Proofpoint, Mimecast, Barracuda.  │
├────────────────────────────────────────────┤
│ March 10, 2026                              │
│ [Feature] Free Brand Exposure Report        │
│ Instant AI-powered assessment of any        │
│ domain's brand attack surface. No account   │
│ required.                                   │
└────────────────────────────────────────────┘
```

### 10. LEGAL PAGES

#### /privacy — Privacy Policy
```
Standard privacy policy covering:
- What data we collect (account info, scan data, monitoring data)
- How we use it (service delivery, threat intelligence, product improvement)
- Data retention periods
- Third-party processors (Cloudflare, AI provider)
- User rights (access, deletion, export)
- Canadian jurisdiction (PIPEDA compliance)
- Contact: privacy@trustradar.ca

Tone: Clear, readable, not wall-of-legalese. Use headers and plain language.
```

#### /terms — Terms of Service
```
Standard ToS covering:
- Service description
- Account responsibilities
- Acceptable use (no abuse of scanning tools)
- Intellectual property
- Limitation of liability
- Subscription terms (billing, cancellation, refunds)
- Termination
- Canadian governing law

Tone: Same as privacy — clear, professional, readable.
```

#### /dpa — Data Processing Agreement
```
For Business and Enterprise customers who need a DPA.
Standard DPA covering:
- Data processing activities
- Sub-processors (Cloudflare, AI provider)
- Security measures
- Data breach notification
- Data transfer mechanisms
- Audit rights
```

### 11. PARTNERS & INTEGRATIONS (/partners)

```
Two sections:

TECHNOLOGY INTEGRATIONS
Grid showing integration capabilities:
- SIEM: Splunk, Microsoft Sentinel, IBM QRadar
- SOAR: Splunk SOAR, Cortex XSOAR
- Communication: Slack, Microsoft Teams, Email
- Export: STIX 2.1, JSON, CSV, Webhook
- API: REST API with full documentation

Each integration card: logo/icon, name, status (Available | Coming Soon),
brief description of what it does

MSSP PARTNERSHIP PROGRAM
"Offer brand threat intelligence to your clients"
- Multi-tenant architecture
- White-label capabilities (roadmap)
- Volume pricing
- Dedicated partner support
- Co-marketing opportunities
CTA: "Apply for the MSSP program"
```

---

## CONTENT PRODUCTION PLAN

### Priority 1 — Ship with initial corporate site launch
- [x] Landing page (BUILT)
- [ ] /platform (overview)
- [ ] /pricing (standalone — expand from landing page section)
- [ ] /scan (free scan tool)
- [ ] /about (expanded company page)
- [ ] /contact (with demo request form)
- [ ] /security (security practices + responsible disclosure)
- [ ] /privacy (privacy policy)
- [ ] /terms (terms of service)
- [ ] /login + /register (auth pages)

### Priority 2 — Ship within 2 weeks of launch
- [ ] /platform/email-security (deep dive)
- [ ] /platform/threat-detection (deep dive)
- [ ] /platform/social-monitoring (deep dive)
- [ ] /platform/ai-agents (deep dive)
- [ ] /blog (index + first 3 posts)
- [ ] /docs (getting started + API reference)
- [ ] /changelog (initial entries)

### Priority 3 — Ship within 1 month
- [ ] /solutions/mid-market
- [ ] /solutions/mssp
- [ ] /solutions/startups
- [ ] /partners (integrations + MSSP program)
- [ ] /resources (first whitepaper)
- [ ] /dpa
- [ ] /blog (posts 4-6)

---

## DESIGN SYSTEM NOTES FOR INTERIOR PAGES

All pages use the approved design system from the corporate site prototype:
- Light mode default with dark toggle
- Syne / DM Sans / IBM Plex Mono typography
- Teal / Coral / Green accent system
- Nav and footer consistent across all pages

### Page Templates

**Marketing pages** (platform, solutions, about): Full-width hero, alternating content sections, rich visuals, CTAs

**Content pages** (blog posts, docs, legal): Constrained width (720px max), clean editorial layout, sidebar TOC for long content

**Tool pages** (scan, login, register): Centered single-column, minimal chrome, focused on the action

**Reference pages** (docs, API, changelog): Sidebar navigation + content area, code blocks, copy buttons

### Shared Components to Build

```
components/
├── nav.ts              ← Shared navigation (all pages)
├── footer.ts           ← Shared footer (all pages)
├── hero.ts             ← Reusable hero section (marketing pages)
├── feature-row.ts      ← Alternating text+visual rows
├── platform-card.ts    ← Capability card (platform overview)
├── price-card.ts       ← Pricing tier card
├── blog-card.ts        ← Blog post preview card
├── cta-section.ts      ← Bottom-of-page CTA block
├── contact-form.ts     ← Contact/demo request form
├── doc-layout.ts       ← Documentation sidebar + content
├── changelog-entry.ts  ← Changelog timeline entry
├── integration-badge.ts ← Integration partner badge
└── theme-toggle.ts     ← Light/dark mode toggle
```

---

## IMPLEMENTATION NOTES FOR CLAUDE CODE

### How pages work in the Cloudflare Worker SPA

All pages are served by the same Worker. The Worker matches the URL path and returns the appropriate HTML. This is NOT a static site generator — it's a Worker that renders HTML server-side.

```typescript
// Simplified routing in the Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Public marketing pages
    if (path === '/') return renderPage(landingPage, env);
    if (path === '/platform') return renderPage(platformPage, env);
    if (path === '/pricing') return renderPage(pricingPage, env);
    if (path === '/about') return renderPage(aboutPage, env);
    if (path === '/contact') return renderPage(contactPage, env);
    if (path === '/security') return renderPage(securityPage, env);
    if (path === '/blog') return renderPage(blogIndex, env);
    if (path.startsWith('/blog/')) return renderBlogPost(path, env);
    if (path === '/changelog') return renderPage(changelogPage, env);
    if (path === '/scan') return renderPage(scanPage, env);
    // ... etc

    // Auth pages
    if (path === '/login') return renderPage(loginPage, env);
    if (path === '/register') return renderPage(registerPage, env);

    // API routes
    if (path.startsWith('/api/')) return handleAPI(request, env);

    // Dashboard (authenticated)
    if (path.startsWith('/dashboard')) return renderDashboard(request, env);

    // Legal
    if (path === '/privacy') return renderPage(privacyPage, env);
    if (path === '/terms') return renderPage(termsPage, env);

    return new Response('Not Found', { status: 404 });
  }
};
```

### Page rendering pattern

Each page is a function that returns an HTML string. Shared components (nav, footer, head, styles) are composed into a layout wrapper.

```typescript
function renderPage(pageContent: (env: Env) => string, env: Env): Response {
  const html = `
    <!DOCTYPE html>
    <html lang="en" data-theme="light">
    <head>${sharedHead()}</head>
    <body>
      ${sharedNav()}
      ${pageContent(env)}
      ${sharedFooter()}
      ${sharedScripts()}
    </body>
    </html>
  `;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}
```

---

## ADVANCED GRAPHICS & VISUALIZATION PACKAGES

### For Claude Code — Install and Use These

The corporate site and dashboard need rich, animated, data-driven visuals — not static icons and colored divs. Here's what to use and where.

### NPM Packages for the Worker Build

These are installed in `packages/trust-radar/` via pnpm:

```bash
# Visualization & charting (client-side, bundled into Worker output)
pnpm add d3                    # Force-directed graphs, geographic projections, data viz
pnpm add three                 # 3D radar globe, threat network visualization
pnpm add @deck.gl/core @deck.gl/layers  # Geographic threat map (with MapLibre GL)
pnpm add maplibre-gl           # Map tiles for threat geography
pnpm add recharts              # Score trends, email grade history, threat volume charts

# Animation
pnpm add framer-motion         # Page transitions, scroll reveals, micro-interactions
pnpm add @lottiefiles/lottie-player  # Custom animated illustrations (radar sweep, scanning)

# Server-side image generation (for OG cards / shareable reports)
pnpm add @resvg/resvg-wasm    # SVG → PNG rendering in Worker (WASM-based, CF compatible)
pnpm add satori                # HTML/CSS → SVG (Vercel's OG image library, works in Workers)
```

### CDN Resources (loaded client-side, no build step)

```html
<!-- MapLibre GL for geographic threat maps -->
<link href="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css" rel="stylesheet">
<script src="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js"></script>

<!-- CARTO Dark Matter tiles (free, no API key for low volume) -->
<!-- Use in MapLibre: style URL = https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json -->

<!-- Lottie for pre-built animations -->
<script src="https://unpkg.com/@lottiefiles/lottie-player@2.0.4/dist/lottie-player.js"></script>
```

### Where Each Package Is Used

```
┌──────────────────────────────────────────────────────────────────┐
│ PACKAGE           │ WHERE USED              │ WHAT IT RENDERS     │
├───────────────────┼─────────────────────────┼─────────────────────┤
│                   │                         │                     │
│ d3                │ Platform page           │ Architecture flow   │
│                   │ Dashboard /threats      │ diagram with         │
│                   │ Threat narratives       │ animated data paths  │
│                   │                         │ Force-directed       │
│                   │                         │ threat relationship  │
│                   │                         │ graph (nodes =       │
│                   │                         │ domains, edges =     │
│                   │                         │ shared infra)        │
│                   │                         │                     │
│ three (Three.js)  │ Landing page hero       │ 3D radar globe with  │
│                   │ Platform overview       │ threat dots orbiting │
│                   │                         │ Rotating wireframe   │
│                   │                         │ earth with threat    │
│                   │                         │ arcs between source  │
│                   │                         │ and target           │
│                   │                         │                     │
│ deck.gl +         │ Dashboard /threats      │ Geographic threat    │
│ MapLibre GL       │ Threat narratives       │ map showing where    │
│                   │                         │ phishing infra is    │
│                   │                         │ hosted. CARTO Dark   │
│                   │                         │ Matter tiles.        │
│                   │                         │ ScatterplotLayer for │
│                   │                         │ threat locations.    │
│                   │                         │ ArcLayer for attack  │
│                   │                         │ paths.               │
│                   │                         │                     │
│ recharts          │ Dashboard home          │ Brand Exposure Score │
│                   │ /email-security         │ trend (area chart)   │
│                   │ /social monitoring      │ Email grade history  │
│                   │ Reports                 │ Threat volume over   │
│                   │                         │ time (bar chart)     │
│                   │                         │ Social platform      │
│                   │                         │ status over time     │
│                   │                         │                     │
│ framer-motion     │ All pages               │ Page enter/exit      │
│                   │ (React components)      │ transitions.         │
│                   │                         │ Scroll-triggered     │
│                   │                         │ section reveals.     │
│                   │                         │ Card hover lifts.    │
│                   │                         │ Number count-up      │
│                   │                         │ animations for       │
│                   │                         │ stats/scores.        │
│                   │                         │                     │
│ Lottie            │ Landing page            │ Radar sweep loop     │
│                   │ Scan page (loading)     │ Scanning animation   │
│                   │ Agent assessment        │ "AI thinking" dots   │
│                   │ Empty states            │ No-data illustrations│
│                   │                         │                     │
│ satori +          │ /api/scan/report/og     │ Dynamic OG image for │
│ @resvg/resvg-wasm │ Share cards             │ Brand Exposure       │
│                   │                         │ Reports. When        │
│                   │                         │ someone shares a     │
│                   │                         │ report URL on social │
│                   │                         │ media, the preview   │
│                   │                         │ card shows the       │
│                   │                         │ domain, score, and   │
│                   │                         │ grade.               │
│                   │                         │                     │
└───────────────────┴─────────────────────────┴─────────────────────┘
```

### Specific Visual Specifications

#### 1. Landing Page Hero — 3D Radar Globe (Three.js)

```
- Dark wireframe globe (low-poly, ~2000 faces)
- Rotates slowly on Y axis
- Threat nodes rendered as glowing red/amber dots on the globe surface
- Safe nodes as green dots
- Arc lines connecting threat sources to target (brand's country)
- On hover: tooltip showing domain name and threat type
- Camera slightly tilted (15° from equator)
- Ambient light + point light from upper-right
- Performance: requestAnimationFrame with throttle, pause when off-screen
- Fallback: Static SVG radar for mobile / low-performance devices
```

#### 2. Threat Relationship Graph (d3 force-directed)

```
- Used in threat narratives and dashboard threat view
- Nodes: domains, IPs, brand names
- Edges: shared hosting, shared registrar, shared MX, cert overlap
- Node colors: red (threat), amber (suspicious), green (official), gray (infrastructure)
- Node size: proportional to number of connections
- Interactive: click node to see details, drag to rearrange
- Zoom/pan enabled
- Layout: d3.forceSimulation with forceLink, forceManyBody, forceCenter
- Animation: nodes float into position over 1.5s on render
```

#### 3. Geographic Threat Map (deck.gl + MapLibre)

```
- CARTO Dark Matter base tiles (dark theme)
- ScatterplotLayer: threat locations as pulsing red dots
- ArcLayer: arcs from threat origin to brand's HQ location
- HeatmapLayer: density of threats by region
- Tooltip on hover: domain, IP, hosting provider, country
- Zoom level: start at world view, zoom to region on click
- Dark mode only (map tiles are dark, looks wrong on light bg)
  → On light theme, show a simplified version or toggle map bg
```

#### 4. Brand Exposure Score Gauge (SVG + CSS animation)

```
- Circular gauge (270° arc, not full circle)
- Animated fill from 0 to actual score on page load
- Color gradient: green (90+) → wing-blue (70-89) → afterburner amber (50-69) → red (<50)
- Center: large score number with count-up animation
- Below: grade letter (A+ through F)
- Subtle glow effect matching the score color
- Responsive: scales from 120px to 200px diameter
```

#### 5. Shareable Report OG Image (satori + resvg)

```
- Generated server-side by the Worker when a scan report URL is shared
- Endpoint: GET /api/scan/report/:id/og → returns PNG
- Dimensions: 1200x630 (standard OG image)
- Content:
  - Trust Radar logo (top-left)
  - Domain name (large, center)
  - Brand Exposure Score (large gauge)
  - Grade badges for each category (Email: B+, Social: 1 alert, etc.)
  - "Generated by Trust Radar" footer
- Linked in HTML meta tags:
  <meta property="og:image" content="https://trustradar.ca/api/scan/report/:id/og" />
```

#### 6. Scanning Animation (Lottie or CSS)

```
- Used on /scan page while report is generating (3-8 seconds)
- Radar sweep animation (circular sweep, dots appearing)
- Progress indicators for each scan stage:
  ● Email security scan... ✓
  ● Threat feed check... ✓
  ● Lookalike domain scan... (scanning)
  ● Social handle check... (queued)
  ● AI assessment... (queued)
- Each stage transitions from gray → pulsing afterburner amber → green check
- Smooth, not janky — use requestAnimationFrame or Lottie
```

### Cloudflare Worker Compatibility Notes

```
⚠ IMPORTANT: Not all npm packages work in Cloudflare Workers.
Workers use the V8 isolate runtime, NOT Node.js.

WORKS IN WORKERS (server-side):
- satori (HTML → SVG, pure JS)
- @resvg/resvg-wasm (SVG → PNG, WASM-based)
- Any pure JS library without Node.js dependencies

CLIENT-SIDE ONLY (bundled into HTML, runs in browser):
- three (Three.js) — always client-side
- d3 — always client-side
- deck.gl / MapLibre GL — always client-side
- recharts — always client-side (React)
- framer-motion — always client-side (React)
- Lottie player — always client-side

DOES NOT WORK IN WORKERS:
- sharp (uses native binaries — use @resvg/resvg-wasm instead)
- canvas (Node.js native — use satori + resvg instead)
- puppeteer (headless browser — not possible in Workers)
```

### Build Configuration

For the Worker SPA that serves client-side code, graphics libraries are bundled during build:

```typescript
// wrangler.toml additions for large bundles
[build]
command = "pnpm build"

// Consider code splitting for heavy libraries:
// - Three.js (~600KB) → lazy load only on landing page
// - d3 (~250KB) → lazy load on dashboard pages
// - deck.gl + MapLibre (~800KB) → lazy load on threat map view
// - recharts (~200KB) → lazy load on dashboard

// Total bundle without lazy loading: ~2MB+
// With lazy loading per-route: ~100-200KB initial, rest on demand
```

### Claude Code Execution Notes

```
When building pages that use these packages:

1. THREE.JS: Import from CDN in the HTML served by the Worker.
   Do NOT try to bundle Three.js into the Worker itself.
   <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>

2. D3: Same approach — CDN for the SPA, not bundled into Worker.
   <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>

3. RECHARTS: If using React for dashboard components,
   bundle with the client-side build.

4. SATORI + RESVG: These DO run inside the Worker for OG image generation.
   Install as regular dependencies.

5. MAPLIBRE GL: CDN load with CSS.
   Tiles from CARTO (free tier, no API key needed for modest volume).

6. LOTTIE: CDN load the player. Host .lottie/.json animation
   files in Cloudflare R2 or serve inline.
```

---

*This document should be committed alongside the Unified Platform Plan and Backend Assessment.
Referenced by Claude Code sessions building corporate site pages.*
