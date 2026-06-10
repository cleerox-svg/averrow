> Archived 2026-06-10: point-in-time v3 Phase 0 audit (2026-05-07); still cited by kept ADRs in docs/v3/.

# Phase 0 — §8.6 Customer-Profile Audit

**Date run:** 2026-05-07
**DB:** `trust-radar-v2` (`a3776a5f-c07c-4e20-9f3b-8d7f8c7f90c6`)
**Original snapshot:** 2026-05-06 (in `.claude/plans/v3.md` §8.6.1)
**Status:** §5.2 (who do we sell to first) **does NOT close** on this audit. Three blockers carry forward to a Phase 0 prerequisite track. The directional answer from the original audit is **revised downward** — see "New finding" below.

---

## Why this doc exists

The v3 plan (`.claude/plans/v3.md`) lives under `.claude/`, which is gitignored. The §8.6 audit findings need to be tracked, citeable, and comparable across re-audits — so they live here in `docs/v3/`. Plan stays the source of truth for *intent*; this doc is the source of truth for *empirical findings*.

---

## 1. Brand population coverage

```sql
SELECT
  COUNT(*) AS total_brands,
  SUM(CASE WHEN email_security_grade IS NOT NULL THEN 1 ELSE 0 END) AS has_email_grade,
  SUM(CASE WHEN sector IS NOT NULL THEN 1 ELSE 0 END) AS has_sector,
  SUM(CASE WHEN hq_country IS NOT NULL THEN 1 ELSE 0 END) AS has_hq_country,
  SUM(CASE WHEN threat_count > 0 THEN 1 ELSE 0 END) AS has_threats,
  SUM(CASE WHEN tranco_rank IS NOT NULL THEN 1 ELSE 0 END) AS has_tranco_rank
FROM brands;
```

| Field | 2026-05-06 | 2026-05-07 | Δ |
|---|---:|---:|---:|
| total_brands | 9,675 | **9,682** | +7 |
| email_security_grade | 9,675 (100%) | 9,682 (100%) | — |
| sector | 2,982 (31%) | 3,072 (31.7%) | +90 |
| hq_country | 2,731 (28%) | 2,876 (29.7%) | +145 |
| threat_count > 0 | 1,798 | 1,813 | +15 |
| **tranco_rank** | **0 (0%)** | **0 (0%)** | — |

**Carry-forward finding:** `brands.tranco_rank` remains 0% populated. Any v3 size-tiering that depends on `tranco_rank` is a no-op until the Tranco list is sourced and bulk-loaded (~2 hours of engineering — see §8.6.2 prerequisites).

---

## 2. Sales-leads pool — too immature for status-progression signal

```sql
SELECT DATE(sl.created_at) AS day, COUNT(*) AS leads_created,
       ROUND(AVG(sl.prospect_score), 2) AS avg_score,
       SUM(CASE WHEN sl.status = 'researched' THEN 1 ELSE 0 END) AS researched,
       SUM(CASE WHEN sl.status = 'rejected' THEN 1 ELSE 0 END) AS rejected
FROM sales_leads sl
WHERE sl.created_at > datetime('now', '-90 days')
GROUP BY day ORDER BY day DESC;
```

| Day | Leads | Avg score | Researched | Rejected |
|---|---:|---:|---:|---:|
| 2026-04-24 | 20 | 65.00 | 0 | 2 |
| 2026-04-17 | 20 | 68.25 | 0 | 2 |
| 2026-04-10 | 20 | 54.00 | 1 | 0 |
| 2026-03-24 | 10 | 33.00 | 1 | 0 |

- Total leads: **70** (unchanged from 2026-05-06; Pathfinder hasn't run since 04-24)
- Statuses: 64 new, 4 rejected, 2 researched, **0 qualified, 0 meeting-booked**
- Created on **only 4 days** in 90 days — Pathfinder runs as irregular batch dumps, not continuous flow

**Implication:** the `sl.status='qualified'` filter in the original Q2/Q3 was always going to be empty. Re-running with `status` breakdown instead. Lead-pool growth is the binding constraint — until N ≥ 500, no statistically meaningful sweet-spot signal exists.

---

## 3. Q4 — Sectors over-indexing on weak email security

```sql
SELECT sector, COUNT(*) AS total_brands,
       SUM(CASE WHEN email_security_grade IN ('D','F') THEN 1 ELSE 0 END) AS weak_grade_brands,
       ROUND(100.0 * SUM(CASE WHEN email_security_grade IN ('D','F') THEN 1 ELSE 0 END) / COUNT(*), 1) AS weak_pct,
       ROUND(AVG(threat_count), 2) AS avg_threats
FROM brands
WHERE email_security_grade IS NOT NULL AND sector IS NOT NULL
GROUP BY sector HAVING COUNT(*) >= 50
ORDER BY weak_pct DESC;
```

| Sector | Total | D/F | Weak % | Avg threats |
|---|---:|---:|---:|---:|
| other | 408 | 296 | **72.5%** | 3.18 |
| gaming | 118 | 49 | 41.5% | 11.15 |
| **tech** | **1,066** | **412** | **38.6%** | **21.29** |
| finance | 56 | 20 | 35.7% | 2.25 |
| media | 406 | 117 | 28.8% | 16.14 |
| social | 75 | 19 | 25.3% | 4.56 |
| telecom | 73 | 15 | 20.5% | 9.96 |
| ecommerce | 207 | 36 | 17.4% | 24.52 |
| government | 92 | 13 | 14.1% | 7.00 |
| education | 109 | 12 | 11.0% | 2.06 |
| healthcare | 61 | 6 | 9.8% | 5.11 |
| **banking** | **102** | **2** | **2.0%** | 5.43 |

**Confirmed negative findings:**
- **Banking** (2.0% weak) and **healthcare** (9.8% weak) are NOT customer-fit for the email-security pitch. Mature DMARC/SPF/DKIM coverage. Don't market to these sectors on email-grade alone.
- **Education** (11.0% weak) sits alongside healthcare/banking — same conclusion.

**Confirmed positive findings:**
- **Tech** stays the strongest target by absolute volume (1,066 brands; 412 weak; 21.3 avg threats — highest threat-density of any large sector).
- **Gaming + media + telecom** are secondary targets at the F-grade tier (smaller absolute populations but high threat density).

---

## 4. New finding (2026-05-07): the "named cluster" is mostly platform-mirage

The 2026-05-06 audit said:

> **Geographic anchor: US tech with F-grade and ≥10 threats = 6 brands, avg 184.5 threats each.** Smallest sample but highest-density empirical cluster — these are 6 named brands today where the platform's data already proves customer-fit.

The actual brands in that cluster (today, identical query):

```sql
SELECT name, canonical_domain, threat_count, hq_country
FROM brands
WHERE sector = 'tech'
  AND email_security_grade = 'F'
  AND threat_count >= 10
  AND hq_country = 'US'
ORDER BY threat_count DESC;
```

| name | canonical_domain | threat_count | What it actually is |
|---|---|---:|---|
| Pages | pages.dev | 770 | Cloudflare Pages (CF subdomain — abused by phishing kits hosted on CF) |
| Office | office.com | 221 | Microsoft Office (frequent impersonation target — but Microsoft is not buying email security from us) |
| Forms | forms.gle | 63 | Google Forms (abused for credential phishing) |
| Business | business.site | 30 | Google Business profile pages |
| Openx | openx.net | 17 | OpenX ad exchange |
| Adrta | adrta.com | 11 | DSP ad-tracker domain |

**All six are platform-abuse mirages**, not realistic Averrow customers. The high `threat_count` reflects threat operators **abusing** the platform (hosting phishing on `*.pages.dev`, embedding forms in `forms.gle`), not threats **against** the platform's parent company.

Broadening to `threat_count ≥ 5` and removing the obvious mirages produces only four more (`onrender.com`, `iana.org`, `shorturl.at`, `curl.se`) — also platform-abuse / infrastructure / OSS, not customer-fit.

**Revised conclusion:** the empirical "customer-fit cluster identifiable today" is **closer to zero brands**, not six. The original cluster was a measurement artifact of how `threats` accumulates against any domain that gets impersonated, including infrastructure platforms. Brand-data tagging needs an additional column (e.g., `is_platform_abuse_target boolean`, or `customer_fit_eligible boolean`) before the §5.2 question can close on threat-count alone.

This raises a fourth blocker carried into Phase 0 prerequisites — see below.

---

## 5. Q5 — Geographic concentration of high-priority leads

```sql
SELECT b.hq_country, b.sector, COUNT(*) AS lead_count,
       ROUND(AVG(sl.prospect_score), 2) AS avg_score
FROM sales_leads sl JOIN brands b ON sl.brand_id = b.id
WHERE sl.prospect_score >= 50 AND b.hq_country IS NOT NULL
GROUP BY b.hq_country, b.sector
HAVING COUNT(*) >= 2
ORDER BY lead_count DESC, avg_score DESC LIMIT 50;
```

| hq_country | sector | leads | Avg score |
|---|---|---:|---:|
| US | tech | 9 | 68.33 |
| US | (null) | 5 | 59.00 |
| RU | tech | 3 | 65.00 |
| RU | (null) | 3 | 65.00 |

US-tech is the only meaningful cell at this lead pool size. RU rows are likely operator-side targeting noise. No actionable signal on country mix until N grows.

---

## 6. Q1 — Distribution of all brands by email-grade × tranco band

```sql
-- Q1 collapsed: every row is rank_tier='no_rank' because tranco_rank=0 across the board.
```

| email_security_grade | brand_count | avg_threat_count |
|---|---:|---:|
| A | 1,886 | 9.13 |
| A+ | 1,750 | 10.19 |
| B | 1,293 | 8.11 |
| C | 1,145 | 17.03 |
| D | 721 | 2.02 |
| F | **2,887** | 4.33 |

Q1 effectively reduces to a single-axis email-grade histogram because of the `tranco_rank=0` issue. The shape is:
- **F-grade is the largest grade bucket** (2,887 brands — 30% of the corpus). Plenty of ground to mine.
- **A/A+** dominate the high end (3,636 combined, 38%) — these are the "well-postured" populations.
- **D-grade has surprisingly low avg_threat_count (2.0)** — likely because D-grade is an unstable in-between (most weakly-postured brands collapse to F).

---

## 7. Q2/Q3 — Lead-pool sweet-spot identification

These queries depend on a pool of ≥500 status-progressed leads to be meaningful. With 70 leads and 0 qualified, they return shapes but no signal. Numeric findings preserved for re-audit comparison:

**Q2 (sector × grade × lead count):**
- Top cell: `sector=null, grade=F, n=20, avg_score=56.75, researched=1, rejected=2`
- Second-tier: `sector=tech, grade=F, n=6, avg_score=60` (zero status progression)
- The high-`null`-sector load (38 of 70 leads have no sector) is the §8.6.2 sector-backfill blocker manifesting in the lead pool

**Q3 (tranco-band × lead count):**
- Single cell: `rank_band=no_rank, n=61, avg_score=62.62` — Q3 is unable to discriminate until tranco_rank populates

---

## 8. Population-level proxy — sector × grade × threat density

This is the strongest signal currently identifiable. Replaces Q2/Q3 until lead pool grows.

```sql
SELECT sector, email_security_grade, COUNT(*) AS brand_count,
       SUM(CASE WHEN threat_count >= 10 THEN 1 ELSE 0 END) AS gte_10_threats,
       SUM(CASE WHEN threat_count >= 50 THEN 1 ELSE 0 END) AS gte_50_threats,
       ROUND(AVG(threat_count), 1) AS avg_threats
FROM brands
WHERE email_security_grade IN ('D','F')
  AND sector IN ('tech','gaming','media','telecom','social','ecommerce','other')
GROUP BY sector, email_security_grade HAVING brand_count >= 5
ORDER BY gte_10_threats DESC;
```

| Sector × Grade | brands | ≥10 threats | ≥50 threats | Avg threats |
|---|---:|---:|---:|---:|
| **tech × F** | **337** | **20** | **7** | 8.4 |
| other × F | 266 | 8 | 2 | 2.2 |
| tech × D | 75 | 3 | 0 | 1.9 |
| media × F | 89 | 1 | 0 | 0.4 |
| gaming × F | 38 | 1 | 1 | 23.6 |
| media × D | 28 | 1 | 0 | 0.5 |
| social × F | 14 | 1 | 0 | 2.4 |
| gaming × D | 11 | 1 | 0 | 2.5 |
| telecom × F | 8 | 1 | 1 | 18.8 |
| social × D | 5 | 1 | 0 | 3.4 |
| other × D | 30 | 0 | 0 | 0.8 |
| ecommerce × F | 21 | 0 | 0 | 0.1 |
| ecommerce × D | 15 | 0 | 0 | 0.8 |
| telecom × D | 7 | 0 | 0 | 0.7 |

**Read:** `tech × F` is the largest pool (337 brands) and has the most threat-active members (20 with ≥10 threats, 7 with ≥50). With the §4 caveat that the ≥10-threat sub-cluster is dominated by platform-abuse mirages, the **realistic v0 design-partner pool is the broader `tech × F` 337-brand population**, mined by hand to filter out platform-abuse mirages.

---

## 9. Phase 0 prerequisites (carries forward to plan §8.6.2)

Re-audit cannot close §5.2 on this snapshot. Four blockers:

| # | Blocker | Status | Action |
|---|---|---|---|
| 1 | Pathfinder runs irregularly (4 batch days in 90 — has not run since 2026-04-24) | Cron demoted to manual per `cron/orchestrator.ts:948-953` (Phase 2.6 audit) | Decision needed in Phase 0 step 7 — re-enable post-Tranco-fix, defer, or use directional cluster |
| 2 | `tranco_rank` 0% populated | Column exists, data doesn't | Source Tranco list directly (free) → bulk-update `brands.tranco_rank` (~2 hours engineering) |
| 3 | Sector classification at 31.7% | `brand_enricher` averages 250-300 runs/day, ~25 days to drain 6,693-brand backlog | Accept the rate (sector hits ~50% in 25 days, fine for 6-week v0) or refactor `brand-enricher` to batch-classify |
| 4 | **NEW: platform-abuse mirage contamination** | Threat-count signal for "customer fit" is polluted by infra/platform domains (`pages.dev`, `forms.gle`, etc.) | Add brand-side flag (`is_platform_abuse_target` or `customer_fit_eligible`) before relying on `threat_count` ranking. Heuristic candidates: HQ-country-known + non-subdomain TLD + multi-word brand name |

---

## 10. What this audit empirically supports

**Directional conclusions (carry into v0 design-partner targeting):**

1. **Primary v0 target sector:** `tech` with email_security_grade ∈ {D, F} — 412 brands today, scalable to 700+ as sector backfill drains
2. **Secondary targets:** `gaming` × F (49 brands), `media` × F (117 brands), `telecom` × F (15 brands)
3. **Definitively NOT customer-fit at v0:** banking (2% weak), healthcare (9.8%), education (11.0%), finance (35.7% but only 2.25 avg threats — high posture but low impersonation pressure)
4. **Geographic anchor:** US-headquartered, with the caveat that hq_country is only populated on 29.7% of brands

**What this audit does NOT support (against the plan's previous read):**

- "6 named US-tech-F brands today are customer-fit" — **false**. All 6 are platform-abuse mirages.
- "Tranco rank as live size-tiering signal" — **false** until blocker #2 resolves.
- "Sales_leads status progression as sweet-spot signal" — **false** until blocker #1 resolves.

---

## 11. Re-audit cadence

Re-run this audit (same 7 queries) at:
- **First gate:** when blocker #2 (tranco_rank) closes — likely within the first week of Phase 0
- **Second gate:** when blocker #1 (Pathfinder cadence) closes AND lead pool ≥ 500
- **Third gate:** when blocker #3 (sector backfill) reaches ≥ 50% coverage
- **Fourth gate:** before §5.2 can finally close (all four blockers resolved + ≥1 paying v0 customer to anchor "customer-fit" empirically)

When re-running, append a new dated section to this doc; do not overwrite the 2026-05-07 baseline.
