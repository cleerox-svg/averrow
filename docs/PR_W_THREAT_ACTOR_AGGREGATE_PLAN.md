# PR-W (Planning) — Threat-actor aggregate without a full-table GROUP BY

**Status:** plan only — no code yet.

**Problem:** the query that powers the "Top threat actors by brands targeted" panel on the Trends surface scans an average of **2.1M rows per call** (per CF `d1QueriesAdaptiveGroups`). At ~20 calls/24h it accounts for **~42M D1 reads/day**, ranking #4 in our heaviest queries.

Query (`lib/threat-aggregates.ts:264`):

```sql
SELECT tai.threat_actor_id AS id, ta.name AS name,
       COUNT(DISTINCT t.id)                AS threat_count,
       COUNT(DISTINCT t.target_brand_id)   AS brand_count
FROM threats t
JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
JOIN threat_actors ta                ON ta.id   = tai.threat_actor_id
WHERE <slice>
GROUP BY tai.threat_actor_id, ta.name
HAVING COUNT(DISTINCT t.target_brand_id) >= 2
ORDER BY brand_count DESC, threat_count DESC LIMIT 5
```

The query has no cube to fall back to because the natural aggregation dimension is **`asn → threat_actor_id`**, which only exists via `threat_actor_infrastructure`. Even the existing `idx_threats_asn_type_unclustered` doesn't help — the JOIN is on `asn`, not a precomputed actor id.

---

## Three viable patterns

### Option A — Pre-computed columns on `threat_actors`

Add columns:

```sql
ALTER TABLE threat_actors ADD COLUMN threat_count_7d  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threat_actors ADD COLUMN brand_count_7d   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threat_actors ADD COLUMN threat_count_30d INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threat_actors ADD COLUMN brand_count_30d  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threat_actors ADD COLUMN brand_count_all  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threat_actors ADD COLUMN aggregates_updated_at TEXT;
```

Maintenance: a small batch in the **strategist** agent's 6-hourly run (already iterating actors) recomputes the windowed counts via the cube. Per-actor work:

```sql
SELECT COUNT(*) AS threats, COUNT(DISTINCT target_brand_id) AS brands
FROM threats t
JOIN threat_actor_infrastructure tai ON tai.asn = t.asn
WHERE tai.threat_actor_id = ? AND t.created_at >= datetime('now','-7 days')
```

That's still a JOIN scan, but bounded to one actor — `idx_threats_asn_type_unclustered` (and the 7-day partial range) drops it to ~5-50K rows per actor. With ~hundreds of actors this is ~5M rows total spread across the 6h cron tick — vs 42M reads/day in the current call path.

Page query becomes:

```sql
SELECT id, name, threat_count_7d, brand_count_7d
FROM threat_actors
WHERE brand_count_7d >= 2
ORDER BY brand_count_7d DESC, threat_count_7d DESC LIMIT 5
```

Reads ≤ N(actors). **Estimated daily savings: ~40M reads.**

**Tradeoffs:** counts are stale up to 6h. For an executive-summary panel that's acceptable. Adding fresher freshness requires reactive updates inside the analyst pipeline (post-attribution hook).

### Option B — New cube `threat_cube_actor`

Schema mirrors `threat_cube_provider`:

```sql
CREATE TABLE threat_cube_actor (
  hour_bucket       TEXT NOT NULL,
  threat_actor_id   TEXT NOT NULL,
  target_brand_id   TEXT,
  threat_type       TEXT NOT NULL,
  threat_count      INTEGER NOT NULL,
  PRIMARY KEY (hour_bucket, threat_actor_id, target_brand_id, threat_type)
);
```

Builder: a sibling of `buildProviderCubeForHour()` in `lib/cube-builder.ts`. Called from Navigator (every 5 min) for current + previous hour, and from cube-healer for the 30-day backfill.

Page query:

```sql
SELECT threat_actor_id, SUM(threat_count) AS threats,
       COUNT(DISTINCT target_brand_id) AS brands
FROM threat_cube_actor
WHERE hour_bucket >= datetime('now','-7 days')
GROUP BY threat_actor_id
HAVING COUNT(DISTINCT target_brand_id) >= 2
ORDER BY brands DESC, threats DESC LIMIT 5
```

24 hour-buckets × ~hundreds actors = ~10K rows per call. **Estimated daily savings: ~40M reads.**

**Tradeoffs:** more complex than (A). Adds a 5-min builder cost on Navigator. Wins when we need flexible slicing (per-week, per-type, per-brand) without re-running per-actor — i.e. when more surfaces start consuming actor aggregates.

### Option C — Daily snapshot table (`threat_actor_daily_stats`)

```sql
CREATE TABLE threat_actor_daily_stats (
  snapshot_day      TEXT NOT NULL,
  threat_actor_id   TEXT NOT NULL,
  threat_count_24h  INTEGER NOT NULL,
  brand_count_24h   INTEGER NOT NULL,
  PRIMARY KEY (snapshot_day, threat_actor_id)
);
```

Refreshed by a `daily_actor_stats` agent at 00:30 UTC (after the per-day window closes). Page query rolls up a 7-day slice with a simple SUM/COUNT DISTINCT.

**Tradeoffs:** daily granularity is too coarse for a "this week" panel — would need to combine with Option A for intra-day fidelity. Skip unless we add a "7-day actor leaderboard" surface that doesn't need sub-day freshness.

---

## Recommendation

**Ship Option A.** Smallest schema change, lowest maintenance cost, fits the existing strategist agent's 6-hourly tick. The cube (Option B) is the right answer **if** we add 2-3 more actor-aggregate surfaces (per-week, per-actor-vs-brand correlations, etc.); without that demand it's overengineering.

## Implementation sketch (Option A)

1. Migration `migrations/0XXX_threat_actor_aggregate_columns.sql`:
   - `ALTER TABLE threat_actors ADD COLUMN ...` for the 5 new columns
2. `lib/threat-actor-aggregates.ts`:
   - `recomputeActorAggregates(env, db)` — iterates actors, runs the per-actor windowed query, writes back columns
3. `agents/strategist.ts`:
   - Call `recomputeActorAggregates()` once per execute(), bounded to actors that have new infrastructure rows since `aggregates_updated_at`
4. `lib/threat-aggregates.ts:264`:
   - Replace the JOIN-and-GROUP query with a `SELECT id, name, brand_count_7d, threat_count_7d FROM threat_actors WHERE brand_count_7d >= 2 ORDER BY brand_count_7d DESC LIMIT 5`
5. Verification:
   - Spot-check the new vs old query against 5 known actors — diff should be 0 (same result)
   - Check `d1_top_queries_24h` 24h post-deploy — the old query should fall out of the top-20
   - Check `d1_attribution_24h` for the consumer endpoint — rows_read should drop ~80-95%

## Risk + rollback

The migration is **additive** (`ADD COLUMN DEFAULT 0`) — no destructive changes. Rollback: keep the columns in place and revert the SELECT change in `lib/threat-aggregates.ts` — the original JOIN query still works against the unchanged threats table.

## Why not "just add an index"

`idx_threats_asn_type_unclustered` already covers `(asn, threat_type)` and didn't help — the cost is in the **GROUP BY + COUNT DISTINCT** over the joined slice, not the lookup. No additional index changes the planner's path here.
