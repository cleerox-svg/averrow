# Pathfinder cron decision — operator memo

**Status:** Memo (Phase 0 step 7 — operator decision pending)
**Date:** 2026-05-07
**Recommendation:** **Option C** — pull v0 design partners from the §8.6.2 directional cluster manually; defer Pathfinder cron decision to post-v0
**Phase:** Phase 0 step 7
**Related:** `.claude/plans/v3.md` §2.7 (Pathfinder), §8.6.2 (directional cluster), `docs/v3/PHASE_0_AUDIT.md`, `cron/orchestrator.ts:948-953`

---

## 1. The question

Pathfinder is the customer-targeting engine — given the 9,682 brands the platform already monitors, score them against a customer-fit rubric and surface qualified outbound leads.

It was demoted to manual trigger on 2026-04-29 per `cron/orchestrator.ts:948-953` (Phase 2.6 of the agent audit). The Phase 0 audit (2026-05-06) flagged this as a Phase 0 decision:

> **Pathfinder cron decision** — re-enable post-Tranco-fix, defer to v0 post-launch, or use §8.6.2 directional cluster for v0 design partners.

This memo captures the three options, the empirical state, and a recommendation. **Operator decision required** — this PR doesn't flip any cron.

---

## 2. Empirical state (live `trust-radar-v2`, 2026-05-07)

### Pathfinder run history (90 days)

```sql
SELECT status, COUNT(*) AS n, ROUND(AVG(duration_ms),0) AS avg_ms, MAX(started_at) AS last_run
FROM agent_runs
WHERE agent_id = 'pathfinder' AND started_at > datetime('now','-90 days')
GROUP BY status;
```

| Status | Count | Avg duration | Last run |
|---|---:|---:|---|
| `success` | 206 | 6.4s | 2026-04-28 19:11 UTC |
| `partial` | 23 | — | 2026-04-24 20:22 UTC |
| `failed` | 15 | 9.7s | 2026-04-10 08:00 UTC |

The agent itself works — 206 successful runs, 6.4s avg. The 23 partials are pre-cron-demote; the 15 failures cluster around 2026-04-10. **Last successful run was 9 days ago, 1 day after the cron-demote.**

### Lead pool

```sql
SELECT COUNT(*) AS total_leads, COUNT(DISTINCT DATE(created_at)) AS distinct_days,
       MIN(created_at), MAX(created_at)
FROM sales_leads;
```

| Field | Value |
|---|---|
| Total leads | **70** |
| Distinct creation days | **4** (2026-03-24, 04-10, 04-17, 04-24) |
| First lead | 2026-03-24 15:16 UTC |
| Last lead | 2026-04-24 21:14 UTC |
| Leads in last 30d | 60 |
| Leads in last 90d | 70 |

206 successful runs created 70 leads on 4 distinct days. **The KV-throttle (1 lead-creation per 7 days per brand) is the binding constraint, not the cron schedule.** Re-enabling cron at the previous cadence wouldn't grow the pool — Phase 1 was already throttled.

### Status progression

70 leads, breakdown: 64 new / 4 rejected / 2 researched / **0 qualified, 0 meeting-booked**. The funnel hasn't progressed past the second status — there's no qualification signal to optimize against.

### Customer-fit signal blockers (carry forward from PHASE_0_AUDIT.md)

1. **`brands.tranco_rank` 0% populated** — size-tiering logic that depends on rank is currently a no-op
2. **`brands.sector` 31.7% populated** — half the lead pool has `sector=null`
3. **NEW finding (2026-05-07):** the densest empirical cluster (US tech × F-grade × ≥10 threats = 6 brands) is **all platform-abuse mirages** (pages.dev, office.com, forms.gle, etc.) — not customer-fit

Pathfinder is scoring against a contaminated signal until blockers 1-3 close.

---

## 3. The three options

### Option A — Re-enable cron post-Tranco-fix

**Action:** Source the Tranco list, bulk-update `brands.tranco_rank`, then revert the demote (delete `cron/orchestrator.ts:948-953` block, restore Pathfinder dispatch).

**Cost:**
- ~2 hours engineering for the Tranco loader
- KV-throttle stays at 7 days, so cron-or-not, the funnel grows ~10 leads/week max under current throttle
- Each Pathfinder run uses Haiku for the Phase 2 enrichment — call it ~$0.001/lead × 10 leads/week = $0.04/month

**What it produces:**
- Continuous lead generation against a less-broken signal (Tranco + sector + email-grade together)
- More leads to collect status-progression data → eventually closes §5.2

**Risks:**
- Sector classification still 31.7% — sector-conditioned scoring will mis-score the 68.3% of brands with `sector=null` for a couple of months while `brand_enricher` drains
- Platform-abuse mirage contamination (Phase 0 step 1 finding) means top-scoring leads will keep being `pages.dev` / `office.com` until a `customer_fit_eligible` flag exists. Outbound to "Pages" looks bad
- KV-throttle binding: even with cron back, lead pool growth is ~10/week. **6+ months to N=500.**

### Option B — Defer the cron decision to v0 post-launch

**Action:** Leave Pathfinder in manual-trigger mode. Operators run it explicitly before sales pushes via `POST /api/agents/pathfinder/trigger`. Revisit when v0 ships and there's revenue pressure to grow outbound.

**Cost:**
- Zero now
- Pathfinder dev work on hold — fixes for the platform-mirage contamination, sector backfill dependency, etc. all wait for the cron to come back

**What it produces:**
- 70 leads stay in the pool; status progression accumulates as operators work them by hand
- v0 design partners come from elsewhere (see Option C)
- Decision delayed to a moment when there's better data and a paying-customer cohort to anchor "customer-fit" against

**Risks:**
- Manual-trigger Pathfinder will drift further (if the agent's contract changes between now and v0 post-launch, unsupervised re-enable could surprise). Mitigation: keep `pathfinder.ts` test coverage current
- Ops-side dependency on operator memory: somebody has to remember to run it

### Option C — Use §8.6.2 directional cluster for v0 design partners (RECOMMENDED)

**Action:** Skip Pathfinder for v0 lead-gen. Operator hand-curates the v0 design-partner outreach list directly from the population-level proxy:

```sql
-- The 412-brand "tech × {D,F}" cluster, with platform-abuse mirages
-- and infrastructure domains filtered out manually.
SELECT name, canonical_domain, sector, email_security_grade,
       threat_count, hq_country
FROM brands
WHERE sector = 'tech'
  AND email_security_grade IN ('D', 'F')
  AND canonical_domain NOT IN (
    -- Platform-abuse mirages (PHASE_0_AUDIT.md §4)
    'pages.dev','forms.gle','business.site','office.com',
    'openx.net','adrta.com','onrender.com','iana.org',
    'shorturl.at','curl.se','chrome.com','arin.net'
  )
  AND name NOT LIKE '%cdn%'
  AND name NOT LIKE '%cloud%'
ORDER BY threat_count DESC
LIMIT 100;
```

Operator picks 20-30 from this list to seed v0 design-partner outreach. No Pathfinder cron involvement.

**Cost:**
- ~30 minutes of operator time to pick + dedupe + enrich the manual list
- Zero engineering work
- Zero Haiku spend

**What it produces:**
- v0 outreach happens **immediately** without waiting for the four PHASE_0_AUDIT blockers to close
- Each design partner becomes a known empirical customer-fit anchor — those 20-30 brands become the seed corpus for re-running §8.6 once v0 has paying customers
- Pathfinder cron decision properly defers to a moment when (a) there's real customer-fit data to score against, and (b) the four blockers have closed

**Risks:**
- Manual list quality depends on operator judgment, not automated scoring. Mitigation: operator already has the platform context to dedupe mirages by hand
- 30-min upfront cost has to be repeated each time the list refreshes. Mitigation: the §8.6.2 cluster doesn't change weekly; refresh cadence is monthly at most

---

## 4. Recommendation

**Option C** for v0 design-partner sourcing. **Defer Options A and B** until after the v0 cohort signs and pays.

Why C beats A: A produces noisy leads against a contaminated signal until the four blockers close. The first few weeks of "Pathfinder cron back on" would generate 30-40 leads where the top 6 are `pages.dev`-style mirages, and the operator burns cycles filtering them out. C skips that entirely by going straight to operator-curated outreach.

Why C beats B: B keeps Pathfinder warm but unused — it's a smaller version of A's problem (no progress + no obvious moment to revisit). C creates a forcing function: when v0 closes 3-5 design partners, the operator has empirical customer-fit data to RE-tune Pathfinder against.

### Sequence after Option C is taken

| Trigger | Next action | When |
|---|---|---|
| v0 ships (Phase v0 exit) | Run §8.6 audit again with the actual customer cohort as ground truth | Post-launch week 1 |
| §8.6 re-audit closes blocker #4 (platform-abuse mirage filter) | Add `customer_fit_eligible` column to `brands`; backfill via the manual-list heuristics from C | Post-launch week 2-3 |
| Tranco list sourced + bulk-loaded (blocker #2) | Re-run §8.6; Pathfinder scoring rubric updates to use rank tier | Post-launch week 3-4 |
| Sector backfill ≥ 50% (blocker #3) | All four blockers closed; Pathfinder scoring is reliable | Post-launch ~6-8 weeks |
| All blockers closed AND lead pool ≥ 500 | **Now** is when Option A makes sense — re-enable cron with confidence | Post-launch ~3-4 months |

This sequence inverts the original framing: instead of "fix Pathfinder then ship v0", we ship v0 with manual targeting, use the v0 cohort as the empirical anchor, and resurrect Pathfinder against a known-good signal.

---

## 5. What this memo does NOT decide

- **The actual outreach list** — Option C requires the operator to write the 20-30 names. That's a separate workstream, not a docs PR.
- **Tranco import bug fix priority** — independent track. Worth ~2 hours whenever the operator picks a slot for it; doesn't gate v0.
- **Sector backfill acceleration** — `brand_enricher` runs at 250-300/day. That cadence ships sector classification at ~50% in 25 days. No need to refactor unless the timeline tightens.
- **Pathfinder code changes** — none required for any of A/B/C. The cron-demote line stays as-is until A is chosen.

---

## 6. Open questions for the operator

| # | Question |
|---|---|
| Q1 | Pick A, B, or C — or modify? |
| Q2 | If C: who runs the manual list query and curates the 20-30 outreach names? Operator alone, or operator + sales contractor? |
| Q3 | If C: does the v0 outreach copy reference the platform's existing data on the prospect ("we already see 12 phishing domains targeting your brand") or stay generic? |
| Q4 | If A or B: anyone want to pick up the Tranco import bug fix as a side task before that path opens? |

---

## 7. References

- `.claude/plans/v3.md` §2.7 (Pathfinder description, demote note)
- `docs/v3/PHASE_0_AUDIT.md` §9 (four Phase 0 blockers)
- `docs/v3/PHASE_0_AUDIT.md` §10 (directional v0 targeting conclusion)
- `packages/trust-radar/src/agents/pathfinder.ts` — agent implementation
- `packages/trust-radar/src/cron/orchestrator.ts:948-953` — current demote
- ADR-001, ADR-002 — schema + migration (Pathfinder lives on v2 throughout v3 build; convergence happens in `averrow-ops` per §5.1)
