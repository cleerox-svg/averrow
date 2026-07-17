# LRX Platform — Product Boundaries
## imprsn8 vs Averrow — Canonical Separation

**Last updated: March 2026**
**Purpose:** Prevent feature drift between products. Before adding any feature to either platform, consult this document.

> **DECOMMISSIONED (2026-07-12):** `imprsn8` has been removed from this
> monorepo — package, Worker, and Cloudflare resources torn down. This
> document is retained for historical context on the two-product boundary
> that shaped Averrow's social-monitoring scope, but every reference
> to `imprsn8` below describes a product that no longer exists. Averrow's
> own social monitoring (see "Averrow Social Monitoring" below
> and `docs/AI_AGENTS.md`) has since shipped independently of the imprsn8
> split described here.

---

## The One-Line Test

**Ask:** Who is the customer and what are they protecting?

| Answer | Platform |
|---|---|
| A **creator, influencer, or their talent team** protecting a personal identity | **imprsn8** |
| A **company or brand** protecting their corporate identity, domains, and infrastructure | **Averrow** |

---

## imprsn8 — Creator Identity & Impersonation Defense

**Domain:** imprsn8.com  
**Customer:** Influencers, creators, celebrities, talent managers, agencies  
**Core question it answers:** "Is someone pretending to be me online?"

### What imprsn8 owns

| Feature | Description |
|---|---|
| Influencer identity fingerprinting | Username patterns, avatar hash, bio keywords, link-in-bio domains |
| Social platform impersonation detection | Lookalike accounts on Instagram, TikTok, X, YouTube |
| Threat scoring | AI-powered similarity scoring (handle distance, avatar match, bio copy, posting cadence) |
| Threat types | `full_clone`, `handle_squat`, `bio_copy`, `avatar_copy`, `scam_campaign`, `deepfake_media`, `unofficial_clips`, `voice_clone` |
| Takedown workflows | Platform report generation, DMCA notices, HITL approval queue |
| Creator dashboard | Personal risk view, auto-action toggle, verified accounts, false positive marking |
| Talent manager dashboard | Roster view, dossier cards, signal feed, operations queue |
| Super admin | All clients, invite management, global overrides |
| Compliance audit log | All actions taken, by whom, when |

### What imprsn8 does NOT own

- Domain registration/DNS threat intel → Averrow
- Phishing site detection → Averrow  
- Corporate brand monitoring → Averrow
- Email security posture → Averrow
- Anything targeting a security team / CISO audience
- Enterprise SSO, SIEM integration, multi-tenant org management at scale

### imprsn8 user roles

```
super_admin → talent_manager → influencer
```

The platform is personal. An influencer is a person, not a company. A talent manager manages people, not brands. This is the defining characteristic.

---

## Averrow — Enterprise Brand & Infrastructure Threat Intelligence

**Domain:** trustradar.ca  
**Customer:** Security teams, brand protection teams, CISOs, IT administrators at companies  
**Core question it answers:** "Is someone attacking my company's digital assets?"

### What Averrow owns

| Feature | Description |
|---|---|
| Domain/URL threat scoring | Newly registered domains, phishing site detection, typosquatting |
| DNS & certificate monitoring | Suspicious cert issuance, DNS hijacking signals |
| Email security posture | DMARC, DKIM, SPF assessment |
| Corporate social brand monitoring | Company handle squatting, logo misuse, brand mention threats on social platforms |
| Threat intelligence feeds | URLhaus, OpenPhish, PhishTank, CF Scanner, custom feeds |
| AI threat assessment | Analyst agent, Observer briefings, correlation scoring |
| Spam trap network | Honeypot infrastructure for phishing intelligence |
| Multi-tenant architecture | Org-level isolation, team management, role-based access at org level |
| Takedowns | Corporate brand enforcement, domain abuse reporting |
| SIEM / webhook integration | Enterprise notification pipeline |

### What Averrow does NOT own

- Individual creator/influencer impersonation → imprsn8
- Personal brand scoring → imprsn8
- Talent management workflows → imprsn8
- Anything where the protected entity is a person, not a company

### Averrow user roles

```
super_admin → analyst → org_admin → org_member
```

The platform is organizational. Even a solo founder using Averrow is protecting a company's assets.

---

## The Shared Backend (packages/api + Railway)

These features are infrastructure — they serve both products and live in neither product's UI:

- JWT auth primitives (separate issuer claims: `iss: imprsn8` vs `iss: trust-radar`)
- Haiku AI agent calling pattern
- Email delivery (Resend)
- KV rate limiting pattern
- D1 migration pipeline
- Cloudflare deploy workflow

**Rule:** If a feature touches `packages/api`, it must work for both products or be explicitly namespaced to one.

---

## Where Social Monitoring Lives — The Key Distinction

This is the most likely source of future confusion. Both platforms monitor social media. Here is the exact line:

| Scenario | Platform |
|---|---|
| `@NikeOfficial` on TikTok is impersonating Nike's brand | **Averrow** — corporate brand |
| `@jadeholloway.real` on TikTok is impersonating influencer Jade Holloway | **imprsn8** — creator identity |
| A fake Instagram account is selling counterfeit products using a company logo | **Averrow** |
| A fake YouTube channel is reposting a creator's videos and running ads | **imprsn8** |
| A threat actor registered `n1ke-official.com` to phish customers | **Averrow** |
| A threat actor registered `jadeholloway-fanpage.com` to scam fans | **imprsn8** (if creator-centric) or **Averrow** (if corporate brand) |

**The tie-breaker:** Is the harmed party a person or a company? Person → imprsn8. Company → Averrow.

---

## Code Separation Rules

### Never do this:
- Import imprsn8 handlers into Averrow routes or vice versa
- Share a D1 database between the two products
- Use the same JWT secret (different secrets, different `iss` claims)
- Reference Averrow domain URLs in imprsn8 UI code
- Reference imprsn8 domain URLs in Averrow UI code

### Always do this:
- New features go through the one-line test first
- Social monitoring features get explicitly tagged as imprsn8 or Averrow before build
- Any shared utility goes into `packages/api` or a new `packages/shared` library — never copied between products

---

## Averrow Social Monitoring — What Needs To Be Built

This is the **missing workstream** that caused the original confusion. Averrow needs its own social monitoring module. It does NOT exist yet.

### Scope (future Claude Code prompt — separate from imprsn8 Phase A)

**Tables needed in Averrow D1:**
```sql
brand_social_profiles    -- verified company handles (Nike, Apple, etc.)
social_threats           -- suspected impersonator accounts targeting a brand
social_scan_jobs         -- scan history
```

**Feeds needed:**
- Company handle monitoring on Instagram, TikTok, X, YouTube
- Brand mention + logo detection (Phase 2 — image hash matching)
- Domain-to-social correlation (e.g. if `n1ke.com` is a known phishing domain, flag `@n1ke_official`)

**UI placement in Averrow:**
- New tab in the Observatory dashboard: "Social Threats"
- Integrated into the existing brand risk scoring (social threat count contributes to overall brand risk)
- Analyst agent updated to factor social threats into its assessment

**Key difference from imprsn8:**
- No dossier card UI — it's a threat feed table, consistent with Averrow's SOC/analyst aesthetic
- No talent manager role — Averrow has `analyst` and `org_admin`
- Takedown workflow is simpler — generate report URL, log it, done. No DMCA generator in v1.

---

## Current Status Summary

| | imprsn8 | Averrow Social |
|---|---|---|
| Backend handlers | ✅ Complete (18 migrations, 40+ routes) | ❌ Not built |
| Database schema | ✅ `impersonation_reports`, `influencer_profiles` etc. | ❌ Tables don't exist |
| UI | ❌ Templates broken — Phase A fixes this | ❌ Not built |
| AI agents | ⚠️ Partially wired | ⚠️ Needs social-specific agent |
| Phase A prompt | ✅ Ready to run | N/A |

---

*This document should be updated any time a new feature is added to either platform that touches social monitoring, takedowns, or identity protection.*
