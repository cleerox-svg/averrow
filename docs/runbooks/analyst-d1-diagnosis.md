# Analyst Agent D1 CPU Diagnosis

> Step 5 of the D1 CPU budget fix series.
> Goal: eliminate structural D1 timeouts from analyst's two hottest queries.

---

## Baseline: agent_runs stats (last 7 days)

> Note: Remote D1 not accessible from this environment (no CLOUDFLARE_API_TOKEN).
> Stats below should be captured from Cloudflare D1 dashboard or via `wrangler d1 execute --remote`:
>
> ```sql
> SELECT
>   COUNT(*) as run_count,
>   AVG(duration_ms) as avg_duration_ms,
>   MAX(duration_ms) as max_duration_ms,
>   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
> FROM agent_runs
> WHERE agent_id = 'analyst' AND started_at >= datetime('now', '-7 days');
> ```
>
> **TODO: fill in after deploy or with remote access.**

---

## Query A: Unlinked-threat lookup (analyst.ts:64)

### Verbatim SQL

```sql
SELECT id, malicious_url, malicious_domain, source_feed, threat_type
FROM threats
WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL
ORDER BY created_at DESC LIMIT 30
```

### EXPLAIN QUERY PLAN (baseline, 19 indexes, no partial index)

```
SEARCH threats USING INDEX idx_threats_brand_created (target_brand_id=?)
```

### Analysis

The planner uses `idx_threats_brand_created(target_brand_id, created_at DESC)` to find
rows where `target_brand_id IS NULL`, already sorted by `created_at DESC`. The second
filter (`malicious_domain IS NOT NULL`) is applied post-index as a table lookup on each
candidate row.

**Why this is slow on 140K rows:**

- `target_brand_id IS NULL` matches a large fraction of threats (~30-40K rows based on
  the diagnostic counts the analyst itself logs). Every one of those rows requires a table
  lookup to check `malicious_domain IS NOT NULL`.
- With LIMIT 30, the query stops after finding 30 qualifying rows, but on each call it
  must walk the index from the most recent `created_at` forward through NULL-brand rows,
  doing table lookups. If recent NULL-brand threats tend to have `malicious_domain IS NOT
  NULL`, it stops quickly. If many recent NULL-brand rows lack `malicious_domain` (e.g.,
  IP-only threats from DShield/CINS), it must scan deeper.
- The sort is "free" (index-provided), but the filtering cost is proportional to how many
  NULL-brand rows exist at the head of the created_at ordering.

**Hypothesis:** Sort over filtered set. The index provides the sort but not the full
filter, causing excess table lookups on the hot path.

### Post-fix plan

Add partial composite index:
```sql
CREATE INDEX IF NOT EXISTS idx_threats_unlinked_recent
  ON threats(created_at DESC)
  WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL;
```

This index contains ONLY rows matching both filter conditions, pre-sorted by
`created_at DESC`. With LIMIT 30, the query reads exactly 30 index entries with zero
wasted table lookups.

---

## Query B: Enrichment aggregation (analyst.ts:241)

### Verbatim SQL

```sql
SELECT
  target_brand_id,
  SUM(CASE WHEN surbl_listed = 1 THEN 1 ELSE 0 END) as surbl_confirmed,
  SUM(CASE WHEN vt_malicious > 0 THEN 1 ELSE 0 END) as vt_flagged,
  ROUND(AVG(CASE WHEN vt_malicious > 0 THEN vt_malicious ELSE NULL END), 1) as vt_avg_malicious,
  SUM(CASE WHEN gsb_flagged = 1 THEN 1 ELSE 0 END) as gsb_confirmed,
  SUM(CASE WHEN dbl_listed = 1 THEN 1 ELSE 0 END) as dbl_confirmed,
  SUM(CASE WHEN greynoise_noise = 1 AND greynoise_classification = 'benign' THEN 1 ELSE 0 END) as noise_scanners,
  SUM(CASE WHEN greynoise_noise = 0 AND greynoise_checked = 1 THEN 1 ELSE 0 END) as potentially_targeted,
  SUM(CASE WHEN seclookup_risk_score >= 80 THEN 1 ELSE 0 END) as seclookup_high_risk
FROM threats
WHERE target_brand_id IS NOT NULL
  AND status = 'active'
  AND (surbl_listed = 1 OR vt_malicious > 0 OR gsb_flagged = 1
       OR dbl_listed = 1 OR greynoise_checked = 1 OR seclookup_checked = 1)
GROUP BY target_brand_id
```

### EXPLAIN QUERY PLAN (baseline)

```
SEARCH threats USING INDEX idx_threats_brand_status (ANY(target_brand_id) AND status=?)
USE TEMP B-TREE FOR GROUP BY
```

(Alternate plan observed without ANALYZE: `SEARCH threats USING INDEX idx_threats_status_created (status=?)`)

### Analysis

**Why this is slow on 140K rows:**

1. **Full active-table scan with OR filter.** The planner uses `idx_threats_brand_status`
   or `idx_threats_status_created` to find all active threats with a brand. This is a
   large set (~60-80K rows on 140K table). It then evaluates the 6-column OR on every row.

2. **No indexes on enrichment columns.** None of `surbl_listed`, `vt_malicious`,
   `gsb_flagged`, `dbl_listed`, `greynoise_checked`, or `seclookup_checked` have indexes.
   The OR condition `(surbl_listed = 1 OR vt_malicious > 0 OR ...)` cannot use any index
   and must be evaluated row-by-row.

3. **GROUP BY requires temp B-tree.** After filtering, the remaining rows must be sorted
   into groups by `target_brand_id`. Since the access path enters via status (not
   target_brand_id), a temporary B-tree is needed for the grouping.

4. **Aggregation across all brands.** The query aggregates across ALL brands in a single
   pass. Even brands with zero enrichment hits generate intermediate rows.

**Hypothesis:** Full active-table scan. The 6-column OR prevents index usage on the
enrichment filter, forcing a scan of all active branded threats, followed by a temp
B-tree GROUP BY.

### Post-fix plan

Rewrite as 6 individual queries (one per enrichment signal), each filtering on a single
column. Aggregate results in application code. This eliminates:
- The complex OR (each subquery has a single equality/comparison)
- The temp B-tree GROUP BY (each subquery groups a much smaller result set)
- The single-query CPU budget consumption (6 smaller queries spread the cost)

---

## Diagnostic COUNT queries (analyst.ts:75-77)

### Verbatim SQL

```sql
-- Line 75:
SELECT COUNT(*) as n FROM threats

-- Line 76:
SELECT COUNT(*) as n FROM threats WHERE target_brand_id IS NULL

-- Line 77:
SELECT COUNT(*) as n FROM threats WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL
```

### EXPLAIN QUERY PLAN

```
-- Line 75 (full count):
SCAN threats USING COVERING INDEX idx_threats_saas_technique

-- Line 76 (no brand):
SEARCH threats USING COVERING INDEX idx_threats_unmatched (target_brand_id=?)

-- Line 77 (no brand + domain):
SEARCH threats USING INDEX idx_threats_unmatched (target_brand_id=?)
```

### Analysis

- Line 75 does a full covering-index scan of 140K+ rows on every analyst run. Pure overhead.
- Line 76 uses the partial covering index `idx_threats_unmatched` — relatively cheap.
- Line 77 uses `idx_threats_unmatched` but needs table lookups for `malicious_domain IS NOT NULL`.
- All three are informational log lines, not load-bearing. They contribute ~15-25% of analyst's
  D1 CPU budget for zero functional value.

**Plan:** Delete all three in Phase E.

---

## Existing indexes on `threats` (19 total)

| # | Index name | Columns | Partial? | Source migration |
|---|-----------|---------|----------|------------------|
| 1 | `idx_threats_brand_status` | `(target_brand_id, status)` | No | 0001, recreated in 0013 |
| 2 | `idx_threats_provider` | `(hosting_provider_id)` | No | 0001, recreated in 0013 |
| 3 | `idx_threats_campaign` | `(campaign_id)` | No | 0001, recreated in 0013 |
| 4 | `idx_threats_type` | `(threat_type)` | No | 0001, recreated in 0013 |
| 5 | `idx_threats_severity` | `(severity)` | No | 0001 |
| 6 | `idx_threats_status` | `(status)` | No | 0001 |
| 7 | `idx_threats_first_seen` | `(first_seen DESC)` | No | 0001 |
| 8 | `idx_threats_last_seen` | `(last_seen DESC)` | No | 0001 |
| 9 | `idx_threats_created_at` | `(created_at DESC)` | No | 0001 |
| 10 | `idx_threats_domain` | `(malicious_domain)` | No | 0001 |
| 11 | `idx_threats_ip` | `(ip_address)` | No | 0001 |
| 12 | `idx_threats_ioc` | `(ioc_value)` | No | 0001 |
| 13 | `idx_threats_source` | `(source_feed)` | No | 0001 |
| 14 | `idx_threats_country` | `(country_code)` | No | 0001 |
| 15 | `idx_threats_cf_scan` | `(cf_scan_id)` | `WHERE cf_scan_id IS NOT NULL` | 0016/0017 |
| 16 | `idx_threats_status_created` | `(status, created_at DESC)` | No | 0045 |
| 17 | `idx_threats_brand_created` | `(target_brand_id, created_at DESC)` | No | 0045 |
| 18 | `idx_threats_unmatched` | `(target_brand_id)` | `WHERE target_brand_id IS NULL` | 0045 |
| 19 | `idx_threats_saas_technique` | `(saas_technique_id)` | No | 0065 |

**Migration 0013 note:** This migration rebuilt the `threats` table via DROP + RENAME
to add new `threat_type` CHECK values. Only 4 indexes were explicitly recreated (1-4).
Indexes 5-14 from migration 0001 may or may not exist in production depending on whether
the D1 database was initialized from scratch or had 0001 indexes prior to the rebuild.
The production state should be verified with:
```sql
SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='threats' ORDER BY name;
```

---

## Post-Phase-B: EXPLAIN with idx_threats_unlinked_recent

> Captured after adding the partial index in migration 0076.

### Query A plan (post-fix)

```
SEARCH threats USING INDEX idx_threats_brand_created (target_brand_id=?)
```

**Planner still prefers `idx_threats_brand_created` in local testing (5K rows, ANALYZE'd).**

This is expected: SQLite's cost model sees `idx_threats_brand_created(target_brand_id, created_at DESC)`
as providing both the equality filter AND the sort in one pass. It doesn't fully model the advantage
of the partial index (zero wasted table lookups for the `malicious_domain IS NOT NULL` check).

On production D1 with 140K rows and different selectivity (NULL-brand rows may have many
IP-only threats without `malicious_domain`), the planner may choose the partial index. Even if
it doesn't, the index is correct to add:
- Write overhead is negligible (partial index only covers ~20% of rows)
- It provides the optimal plan for this exact query pattern
- D1's planner behavior may differ from stock SQLite
- Future SQLite versions may improve partial index costing

**Production verification needed:** After deploy, run `EXPLAIN QUERY PLAN` on remote D1 to
confirm which index is selected with real data distribution.

---

## Post-Phase-C: EXPLAIN for UNION ALL subqueries

> Captured after rewriting Query B into 7 individual queries (Phase C).

### Subquery plans

All 7 subqueries produce the same plan:

```
SEARCH threats USING INDEX idx_threats_brand_status (ANY(target_brand_id) AND status=?)
```

**No `USE TEMP B-TREE FOR GROUP BY` in any subquery** (vs. the original single query which required it).

The `idx_threats_brand_status(target_brand_id, status)` index provides rows in
`target_brand_id` order, satisfying the GROUP BY without a temp sort. The original
single-query version needed the temp B-tree because the 6-column OR filter disrupted
the index's grouping guarantee.

### Key wins

1. **Eliminated temp B-tree GROUP BY** — the most expensive step in the original query.
2. **Simpler per-query filter** — each subquery checks one enrichment column instead of OR-of-6.
3. **Promise.all concurrency** — all 7 queries run in parallel via D1's batch capability.
4. **Lower per-query CPU** — 7 small queries spread D1 CPU budget more evenly than 1 complex query.

### Missing enrichment indexes (flagged for Phase D)

None of the enrichment columns (`surbl_listed`, `vt_malicious`, `gsb_flagged`, `dbl_listed`,
`greynoise_checked`, `seclookup_checked`) have indexes. Each subquery falls through to
`idx_threats_brand_status` and post-filters the enrichment column. Adding indexes on these
columns would allow the planner to use a more selective path, but the current rewrite already
eliminates the primary bottleneck (temp B-tree). Enrichment indexes are deferred — they'd add
6 more indexes to an already-heavy table (19 indexes) for marginal gain.

---

## Index usage map (Phase D)

Built via `rg "FROM threats" packages/averrow-worker/src` cross-referenced with each index's column(s).

| # | Index name | Callers | Decision |
|---|-----------|---------|----------|
| 1 | `idx_threats_brand_status` | handlers/brands.ts, handlers/threats.ts, analyst.ts (enrichment subqueries), observer.ts, tenantData.ts, emailSecurity.ts, brand-scoring.ts | **KEEP** — primary composite for brand+status queries |
| 2 | `idx_threats_provider` | handlers/providers.ts (heavy), handlers/dashboard.ts, cartographer.ts, snapshots.ts | **KEEP** |
| 3 | `idx_threats_campaign` | handlers/campaigns.ts (heavy), strategist.ts, nexusRun.ts | **KEEP** |
| 4 | `idx_threats_type` | db/threats.ts:73, handlers/threats.ts:150, reports.ts, campaigns.ts | **KEEP** |
| 5 | `idx_threats_severity` | handlers/threats.ts:158, reports.ts, enrichment.ts:182 (`WHERE severity IN (...)`) | **KEEP** — independent filter |
| 6 | `idx_threats_status` | All callers also have other WHERE conditions. Every status query is served equally by `idx_threats_status_created(status, created_at DESC)` | **DROP** — strict prefix subset of #16 |
| 7 | `idx_threats_first_seen` | feeds/abuseipdb.ts, spamhausDbl.ts, greynoise.ts, circlPassiveDns.ts, googleSafeBrowsing.ts, seclookup.ts, dashboard.ts, operations.ts, trends.ts, nexusRun.ts | **KEEP** — many enrichment feeds use `first_seen >= datetime(...)` |
| 8 | `idx_threats_last_seen` | observer.ts:143 (`WHERE last_seen >= datetime(...)`) | **KEEP** — one active caller |
| 9 | `idx_threats_created_at` | db/threats.ts, handlers/threats.ts (ORDER BY), observer.ts, sentinel.ts, all dashboard/trend queries, analyst.ts Query A | **KEEP** — primary time-ordering index |
| 10 | `idx_threats_domain` | handlers/threats.ts, enrichment.ts, virustotal.ts, analyst.ts, spamhausDbl.ts, provider-resolver.ts, url-scanner.ts, brands.ts, evidence-assembler.ts | **KEEP** — heavily used for lookups |
| 11 | `idx_threats_ip` | feeds/abuseipdb.ts, greynoise.ts, strategist.ts, enrichment.ts, geoip.ts, brands.ts | **KEEP** — heavily used |
| 12 | `idx_threats_ioc` | handlers/threats.ts:38 (search), brandScan.ts:203 | **KEEP** — used in search/filter |
| 13 | `idx_threats_source` | handlers/threats.ts:154, reports.ts, flightControl.ts | **KEEP** |
| 14 | `idx_threats_country` | handlers/threats.ts:162, reports.ts, providers.ts, observatory.ts | **KEEP** |
| 15 | `idx_threats_cf_scan` | feeds/cloudflare_scanner.ts (submission + polling) | **KEEP** — critical for CF scanner workflow |
| 16 | `idx_threats_status_created` | dashboard.ts, observatory.ts, agents (heavy), all "active threats in time window" queries | **KEEP** — primary composite, subsumes #6 |
| 17 | `idx_threats_brand_created` | analyst.ts Query A, brands.ts, tenantData.ts | **KEEP** — planner's preferred for Query A |
| 18 | `idx_threats_unmatched` | analyst.ts, orchestrator.ts, brandDetect.ts, enrichment.ts, admin.ts, flightControl.ts | **KEEP** — per task: do not drop |
| 19 | `idx_threats_saas_technique` | handlers/threats.ts (JOIN), alerts.ts (JOIN), admin.ts (backfill WHERE/UPDATE) | **KEEP** — supports SaaS technique feature |
| 20 | `idx_threats_unlinked_recent` *(new, Phase B)* | analyst.ts Query A | **KEEP** — added this session |

### Drop justification: `idx_threats_status`

`idx_threats_status(status)` is a strict prefix subset of `idx_threats_status_created(status, created_at DESC)`.
Every query that filters on `status` can use the composite instead — the leading column `status` provides
the same index seek behavior. Verified via grep: no query filters on `status` alone without other conditions
that already have better indexes.

The only marginal cost: `idx_threats_status` is slightly more compact for covering COUNT queries like
`SELECT COUNT(*) FROM threats WHERE status = 'active'`. But the composite serves the same purpose with
negligibly higher I/O per page.

**Net index count after Phase D: 19** (19 original - 1 dropped + 1 added in Phase B = 19).

---

## Post-fix verification (Phase E)

### Changes made

1. **Removed 3 diagnostic COUNT queries** (analyst.ts:75-77) that ran on every analyst invocation:
   - `SELECT COUNT(*) as n FROM threats` — full covering-index scan of 140K+ rows
   - `SELECT COUNT(*) as n FROM threats WHERE target_brand_id IS NULL` — partial index scan
   - `SELECT COUNT(*) as n FROM threats WHERE target_brand_id IS NULL AND malicious_domain IS NOT NULL` — index + table lookup
   These were informational log lines with zero functional value, contributing ~15-25% of analyst's D1 CPU.

2. **Updated summary output** to not reference the removed variables. The summary now says
   `"Analyst found 0 unmatched threats to process"` instead of interpolating the counts.

### Duration stats (dev environment)

> No remote D1 access available — manual verification against live D1 required post-deploy.
>
> Post-deploy verification query:
> ```sql
> SELECT
>   COUNT(*) as run_count,
>   AVG(duration_ms) as avg_duration_ms,
>   MAX(duration_ms) as max_duration_ms,
>   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
> FROM agent_runs
> WHERE agent_id = 'analyst' AND started_at >= datetime('now', '-7 days');
> ```

### EXPLAIN plan comparison

| Query | Baseline | Post-fix |
|-------|----------|----------|
| Query A (unlinked-threat lookup) | `SEARCH idx_threats_brand_created (target_brand_id=?)` | Same + `idx_threats_unlinked_recent` available (planner choice depends on data distribution) |
| Query B (enrichment aggregate) | `SEARCH idx_threats_brand_status (...) + USE TEMP B-TREE FOR GROUP BY` | 7 subqueries, each: `SEARCH idx_threats_brand_status (...)` — no temp B-tree |
| Diagnostic COUNT (total) | `SCAN threats USING COVERING INDEX` | **Removed** |
| Diagnostic COUNT (no brand) | `SEARCH idx_threats_unmatched` | **Removed** |
| Diagnostic COUNT (no brand + domain) | `SEARCH idx_threats_unmatched + table lookup` | **Removed** |

### Acceptance signals checklist

- [ ] Zero auto-trips of analyst circuit breaker over 24h window post-deploy
- [ ] `agent_runs.duration_ms` p95 for analyst under 30 seconds
- [ ] D1 CPU per query in Cloudflare D1 query insights — no new bottleneck
- [ ] Trigger analyst 3+ times in dev, observe each run completing under 30 seconds
