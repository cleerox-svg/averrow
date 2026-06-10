# Averrow Improvement Plan — June 2026

**Source:** `docs/PLATFORM_ASSESSMENT_2026-06.md` (June 10, 2026 assessment).
**Goal:** Close the gaps between the platform's strong detection layer and (a) a
defensible paid tier, (b) a working revenue flywheel — while preserving the
minimal-cost operating model.

**Format:** Waves of PR-sized sessions. Each session is one branch + one PR, follows
CLAUDE.md standards (tsc clean, API_REFERENCE.md updated, agent_runs/agent_events
patterns, prepared statements, cubes/pre-computed columns over raw scans). Sessions
within a wave are ordered by dependency; sessions across waves can interleave when
blocked on external dependencies.

**Status legend:** ⬜ not started · 🟡 in progress · ✅ landed

## Working agreement — human-in-the-loop gates

No session is built without explicit approval. The process for every session:

1. **Scope check (before any code):** a short written proposal — exact files to touch,
   schema/migration changes, new endpoints, rollout flags, what could break — posted
   for approval. Nothing is written until the scope is approved.
2. **Build:** implementation lands on a feature branch as a **draft PR** with tests
   and tsc clean. Draft PRs are never merged by Claude.
3. **Review gate:** owner reviews the PR; anything touching customer-visible behavior,
   outbound email, billing, or data deletion gets called out explicitly in the PR
   description with its kill-switch.
4. **Live-fire gate:** anything that sends external traffic (takedown emails, GSB/APWG
   submissions, customer digests) ships dark behind a config flag, default off. The
   owner flips the flag.

Decisions that are always the owner's: pricing/billing changes, MSA/legal text,
anything sent to a customer or third party, agent retirement/promotion, and external
service signups (APWG, Web Risk, Stripe).

---

## Wave 1 — Make the $1,499 tier defensible (P0)

The assessment's core finding: detection is strong, but takedowns are ~20% built
(drafts queued, never sent) and the tenant app has 5 GA blockers. Until Wave 1 lands,
the paid tier is "monitoring + report drafts," which DoppelDown commoditizes at $49/mo.

### S1 — Takedown email delivery 🟡 (PR open — ships dark, TAKEDOWN_SEND_MODE='draft')
Convert the email-draft submitter from `queued` to actually **sent**.
- Wire Resend (already used in `lib/briefing-email.ts`, `lib/lead-outreach-email.ts`,
  `lib/invite-email.ts`, etc.) into `lib/takedown-submitters/email-draft.ts` and
  `followup-draft.ts`. Outcome becomes `submitted` with the Resend message id stored
  in `takedown_submissions.response_body` / `ticket_id`.
- Gate on `auto_submit_enabled` per provider AND a signed org takedown authorization
  (`takedown_authorizations`) — fall back to `queued` (current behavior) otherwise.
- Add a per-run send cap + dry-run env flag (`TAKEDOWN_SEND_MODE=draft|live`) so
  rollout is reversible.
- Sparrow Phase H SLA follow-ups inherit the same path automatically.
- **Acceptance:** a takedown created against a provider with `abuse_email` +
  authorization produces a real outbound email; audit row records outcome=submitted;
  kill-switch verified.
- Est: 2–3 days. Dependencies: none. Cost impact: ~$0 (Resend volume is tiny).

### S2 — Browser-blocklist submitters (GSB + APWG eCX) ⬜
The industry's cheap path to minutes-fast disruption without registrar relationships.
This is what lets marketing anchor on **time-to-blocklist**.
- New submitters in `lib/takedown-submitters/`: `gsb-report.ts` (Google Safe Browsing
  phishing report; evaluate Web Risk Submission API — requires Google vetting — vs the
  public report endpoint) and `apwg-ecx.ts` (APWG eCrime Exchange member API).
- Dispatcher (`takedown-submitters/index.ts`) fires blocklist submitters **in parallel
  with** the abuse-desk email, not instead of it.
- Record per-channel outcomes; add `time_to_blocklist` stamp on the takedown row.
- **External dependency (start now, in parallel):** APWG membership application and
  Web Risk submission access are people-tasks, not code. Until granted, land the code
  behind config flags.
- **Acceptance:** confirmed phishing threat → GSB/APWG submissions recorded with
  timestamps; diagnostics surface per-channel success rates.
- Est: 3–4 days code + external lead time. Depends on: S1 (dispatcher changes).

### S3 — Evidence packages ⬜
Table stakes at every competitor; partial scaffolding exists (`evidence_assembler`).
- Per-takedown evidence bundle: screenshot (Cloudflare Browser Rendering API), DNS
  records (DoH), RDAP/WHOIS snapshot, HTTP response headers, VT/GSB verdicts already
  on the threat, timestamps. Store in R2 (`trust-radar-trademark-assets` pattern; new
  bucket or prefix `evidence/`).
- Attach bundle links to the outbound takedown email (S1) and the tenant takedown
  detail page.
- **Acceptance:** takedown detail shows downloadable evidence bundle; outbound abuse
  email references it; collection failures degrade gracefully (bundle is best-effort).
- Est: 4–5 days. Depends on: S1.

### S4 — Tenant weekly digest email ⬜
#1 customer-expectation gap. The briefing pipeline exists but is super-admin-only.
- New `handleTenantDigest` (org-scoped: org's brands → new threats, alerts by severity,
  takedown progress, email-posture changes for the week) + Resend template.
- Honor `monitoring_config.weekly_digest` and notification preferences; dispatch from
  the orchestrator at a fixed hour gate (hour-only check per the cron-audit rule).
- **Acceptance:** org with digest enabled receives one weekly email scoped to its
  brands only; unsubscribe/preference path works; no cross-org data in any digest.
- Est: 3 days. Dependencies: none.

### S5 — Export: CSV + PDF executive summary ⬜
- CSV streaming export for alerts and threats (`GET /api/orgs/:orgId/alerts/export`,
  same for threats; respect filters; cap rows; `requireAuth` + org scoping).
- PDF executive summary per brand (HTML template → Browser Rendering PDF; reuse the
  brand_report agent content shape, but render server-side without AI by default).
- **Acceptance:** tenant can download CSV of filtered alerts and a branded PDF summary;
  exports are org-scoped; endpoints documented in API_REFERENCE.md.
- Est: 4 days. Dependencies: none (shares Browser Rendering setup with S3).

### S6 — Billing completion ⬜
- Create Stripe Products/Prices (dashboard task — **owner action**), populate
  `stripe_price_id` on the pricing tiers (migration 0153 left them NULL).
- Past-due banner in tenant app (`useBillingStatus()` hook reading org billing_status).
- Surface module-usage vs plan limits on the billing page.
- **Acceptance:** end-to-end test-mode checkout → webhook → org_modules sync → banner
  clears; past-due org sees the banner.
- Est: 2 days code + owner's Stripe dashboard work. Dependencies: none.

### S7 — Auto-submission policy + MSA ⬜
- ~~Monthly cap enforcement~~ — pulled forward into S1 (consent boundary).
  Remaining: `high_risk_requires_per_takedown_approval` enforcement + the
  per-takedown approval surface in averrow-tenant.
- **Owner action:** legal review of the MSA text in `lib/takedown-msa.ts` (currently
  placeholder). Code ships behind the existing signature flow regardless.
- **Acceptance:** org without signed MSA gets drafts only; signed org gets auto-send
  within scope/caps; cap breach falls back to queued + notification.
- Est: 2 days. Depends on: S1.

**Wave 1 total: ~3–4 working weeks.** Exit criteria: a paying customer's confirmed
phishing threat goes detection → evidence → abuse email + blocklist submission without
operator touch, and the customer sees it in-app, in the digest, and in exports.

---

## Wave 2 — Close the revenue flywheel (P1)

### S8 — ICP enforcement in Pathfinder ⬜
The "mid-market North American" vision as actual WHERE clauses.
- Add `company_country` (ISO code) to `sales_leads` + brand firmographics; normalize
  from existing `company_hq` free text (rule-based + Haiku fallback for ambiguous,
  one-time backfill).
- Phase 1 gates: reject leads outside US/CA (configurable list); score boost for
  revenue_band ∈ {50-250M, 250M-1B} and employee_band ∈ {250-1K, 1K-10K}; hard-reject
  only on the existing enterprise/service-provider rules (don't starve the pipeline —
  missing firmographics ≠ reject, scored lower instead).
- Restore Pathfinder to a weekly dedicated cron (own minute slot per wrangler.toml
  conventions; keep the KV throttle as a guard), with `agent_configs.enabled` as the
  kill-switch.
- **Acceptance:** weekly run produces leads where 100% of geo-known leads are NA and
  ICP-band leads rank above off-band; UI shows country + band filters working.
- Est: 4 days. Dependencies: none.

### S9 — DMARC RUA onboarding flow ⬜
Delivers most of the Proofpoint/Mimecast vision's value with zero vendor APIs — the
RUA ingestion pipeline (`dmarc-receiver.ts`) is already complete.
- Tenant-guided setup: show the org the exact `rua=mailto:dmarc_rua@averrow.com` tag
  to add, verify via the posture scanner that it's live, then unlock a per-domain
  DMARC failure dashboard (data already lands in `dmarc_daily_stats`).
- Per-org scoping of DMARC report views (reports keyed by domain → org_brands).
- Surface failure-source IPs with geo + correlation against existing threats.
- **Acceptance:** a tenant adds the rua tag, the app detects it within a scan cycle,
  and the dashboard populates from the next aggregate report; alerts fire on failure
  spikes per existing thresholds.
- Est: 4–5 days. Dependencies: none.

### S10 — Provider integrations (deferred, demand-driven) ⬜
Proofpoint/Mimecast/IronPort APIs only when a paying customer on that stack asks.
Keep the MX-based provider detection as the trigger ("we see you're on Proofpoint —
want deeper integration?"). No code until then.

**Wave 2 total: ~2 weeks.** Exit criteria: the lead pipeline refreshes itself weekly
with ICP-true prospects, and email-security signal becomes an onboarding hook instead
of a roadmap promise.

---

## Wave 3 — Hygiene that protects velocity (P3, cheap and parallel)

### S11 — Documentation truth-up ✅ (PRs #1480/#1481, merged 2026-06-10)
Per the staleness audit, in priority order:
1. Rewrite ARCHITECTURE.md cron section from wrangler.toml:43-83 (30 min).
2. Purge 29 ghost routes from API_REFERENCE.md; add the ~40 missing legit routes
   (passkeys, approvals, metrics, magic-link, brand aggregates) (3 h).
3. Archive AVERROW_MASTER_PLAN.md §2 "Current State" (or rewrite with live metrics).
4. AI_AGENTS.md display-name ↔ file-name mapping table (include campaign-hunter,
   landed 2026-06-10).
5. Spot-fix PLATFORM_DATA_DEPENDENCIES.md.
- Est: 1–2 days total. Can run any time.

### S12 — UI/UX fixes ⬜
1. `/v2/login` split light/dark background bug (visible in the assessment screenshot).
2. `--text-muted` contrast bump to ≥0.35 alpha; `:focus-visible` amber outline.
3. Global error toast for failed mutations (replace silent `.catch(() => {})`).
4. Tenant service worker + install banner so the PWA flow documented in CLAUDE.md is
   actually reachable.
5. Light-theme completion pass (defer if time-boxed; track separately).
- Est: 3–4 days. Can run any time.

### S13 — Agent registry cleanup ⬜
Resolve the 11 "retired but still wired to live CTAs" zombies: for each, either
(a) re-promote to `active` (public_trust_check, brand_deep_scan are customer-facing
and should be active), or (b) remove the dispatching handler and the dead route.
Update AI_AGENTS.md to match. Est: 1–2 days.

---

## Wave 4 — Detection depth (P2, demand-driven, after Waves 1–2)

- Google Play app-store coverage (parity with iOS classifier).
- Alert grouping/correlation ("3 lookalikes registered same day" → one incident).
- Telegram dark-web channels; HIBP Pro when a customer's plan funds it.
- Spam-trap completeness: attachment SHA256 population, idempotent threat IDs,
  GeoIP enrichment of capture IPs (small, could slot into any gap week).

---

## External / owner actions (start immediately — these gate code, not vice versa)

| Action | Gates | Lead time |
|---|---|---|
| APWG eCrime Exchange membership | S2 | weeks |
| Google Web Risk Submission API access request | S2 | weeks |
| Stripe Products/Prices created in dashboard | S6 | hours |
| MSA legal review | S7 auto-send GA | days–weeks |

## Success metrics (track in platform diagnostics)

- **Time-to-blocklist** (threat confirmed → GSB/APWG submitted): target < 30 min.
- **Takedown submissions/week** actually sent (not queued) and per-provider success rate.
- **GA blocker burn-down:** digest, export, billing, auto-send — all green.
- **Lead pipeline:** ICP-true leads/week from the restored Pathfinder cron.
- **Cost guardrail:** monthly opex stays < 1× single Professional seat ($1,499);
  AI spend per the existing budget ledger.

## Sequencing summary

```
Week 1:  S1 (send) ──► S7 (policy)        S11 (docs)        [owner: APWG/WebRisk/Stripe apps]
Week 2:  S2 (blocklists, flagged)         S4 (digest)
Week 3:  S3 (evidence)                    S5 (export)        S12 (UI fixes)
Week 4:  S6 (billing) + Wave-1 hardening / closed-beta onboarding
Week 5:  S8 (ICP + cron)                  S13 (agent cleanup)
Week 6:  S9 (DMARC onboarding)            → Wave 4 backlog as demand dictates
```
