# ARCHITECT finding: "Schedule Vacuum" investigation

**Finding under review:** ARCHITECT reports that all 38 feeds in the
`repo.feeds` section of the generated manifest have `schedule: null` and
concluded the feeds are dormant. Meanwhile, `feed_pull_history` has 13K+
rows, so feeds are clearly running on a regular cadence.

**Verdict: option (b) — the manifest observation is correct, the
"dormant" conclusion is wrong.** Feeds are dispatched via a runtime
mechanism that the repo collector cannot see by design.

Do not patch `repo-fs.ts` to paper over this. The right fix lives in a
different collector. See "Recommendation" below.

---

## What the manifest actually says

```
$ grep -c '"schedule": null' \
    packages/averrow-worker/src/agents/architect/manifest.generated.ts
38
```

All 38 entries in `REPO_MANIFEST.feeds` have `schedule: null`. That is a
faithful rendering of what the repo collector is looking at — the feed
TypeScript modules — because those modules genuinely do not declare a
schedule in code.

`packages/averrow-worker/src/feeds/types.ts:19` defines the entire
`FeedModule` contract:

```ts
export interface FeedModule {
  ingest(ctx: FeedContext): Promise<FeedResult>;
}
```

One field. No `schedule`, no `interval`, no cron metadata. A per-file
source walker cannot discover a schedule that was never written into
the source. The collector at
`packages/averrow-worker/src/agents/architect/collectors/repo-fs.ts:387`
is explicit about this:

```ts
schedule: null, // feeds don't self-describe schedule; cron orchestrator decides
```

That comment is accurate. The repo collector is not broken.

---

## How feeds are actually dispatched

The real dispatch chain, end to end:

1. **Cloudflare Cron Trigger** wakes the Worker hourly.
   `packages/averrow-worker/wrangler.toml:26-27`:
   ```toml
   [triggers]
   crons = ["0 * * * *"]
   ```

2. **`handleScheduled`** (`src/cron/orchestrator.ts:13`) runs on every
   cron tick. It uses `event.scheduledTime` to gate which sub-jobs fire
   this tick. The ingest-feed gate is at `orchestrator.ts:57`:
   ```ts
   if (minute === 0 || minute === 30) {
     const result = await runJob('threat_feed_scan',
       () => runThreatFeedScan(env));
   }
   ```

3. **`runThreatFeedScan`** (`orchestrator.ts:259`) dynamic-imports
   `runAllFeeds` from `lib/feedRunner.ts` and hands it the
   `feedModules` registry from `feeds/index.ts`:
   ```ts
   const { runAllFeeds } = await import('../lib/feedRunner');
   feedResult = await runAllFeeds(env, feedModules);
   ```

4. **`runAllFeeds`** (`lib/feedRunner.ts:207`) pulls the schedule from
   D1 — this is the runtime source of truth the manifest cannot see:
   ```ts
   const configs = await env.DB.prepare(
     "SELECT * FROM feed_configs WHERE enabled = 1"
   ).all<FeedConfigRow>();
   ```
   The `FeedConfigRow` shape at `lib/feedRunner.ts:86` shows the
   schedule column: `schedule_cron: string`. Every enabled row carries
   its own cron pattern.

5. **`shouldRunNow(config, status, now)`** (`lib/feedRunner.ts:294`)
   decides per feed whether to fire this tick. It parses
   `config.schedule_cron` via `parseCronIntervalMs` and compares the
   interval against `feed_status.last_successful_pull`:
   ```ts
   const intervalMs = parseCronIntervalMs(config.schedule_cron);
   const lastRun = new Date(...).getTime();
   return now.getTime() - lastRun >= intervalMs - 60_000;
   ```

6. Eligible feeds run concurrently via `Promise.allSettled(...)` at
   `lib/feedRunner.ts:270`. Each `FeedModule.ingest()` writes a row to
   `feed_pull_history` via `runFeed()` at `lib/feedRunner.ts:105`, which
   is exactly the table that has 13K+ rows.

So the short version: **the code defines the `ingest()` function, the
database row defines the schedule, and the cron orchestrator joins the
two at runtime.** There is no schedule in the repo, so the repo
collector reports `schedule: null`. The feeds are very much alive.

### Migration provenance

`feed_configs.schedule_cron` is seeded by D1 migrations. Examples:

- `migrations/0017_cloudflare_feeds_retry.sql:9` — `cloudflare_scanner`
  at `*/30 * * * *`, `cloudflare_email` at `0 6 * * *`.
- 14 migration files in total contain `INSERT ... INTO feed_configs`
  statements with explicit `schedule_cron` values.

Each row can be hot-edited in prod (admin routes exist) without a
deploy, which is exactly why the schedule lives in D1 and not in
TypeScript.

---

## Why none of the existing collectors surface this

All three Phase 1 collectors were checked:

| Collector           | Reads `feed_configs.schedule_cron`? | Why not |
| ------------------- | ----------------------------------- | ------- |
| `collectors/repo-fs.ts`      | No | Node fs walker, never touches D1. By contract must not import Worker runtime. |
| `collectors/data-layer.ts`   | No | Lists tables + row counts + bytes + growth via `sqlite_master`/`dbstat`. Never reads row contents. |
| `collectors/ops.ts`          | No | Aggregates `agent_runs` + `budget_ledger`. Does not join `feed_configs` or `feed_pull_history`. |

Grep confirms: `feed_configs` and `schedule_cron` appear **zero** times
under `src/agents/architect/collectors/`. The runtime schedule is in a
blind spot for every Phase 1 collector.

So when the Phase 2 feeds analyzer at
`src/agents/architect/analysis/analyzer.ts` reads `repo.feeds`, it sees
38 rows of `schedule: null` and — without any contradictory signal
from `ops` — concludes "dormant". That is Haiku doing its job on an
incomplete bundle, not a model hallucination.

---

## Recommendation

Do **not** modify `collectors/repo-fs.ts`. Its contract is "walk the
source tree" and the source tree genuinely does not contain a
schedule. Stuffing runtime state into it would:

- Break the "Node fs only, no Worker runtime, no D1" boundary that
  `repo-fs.ts` calls out in its top-of-file docblock
  (`collectors/repo-fs.ts:1-20`).
- Split the source-of-truth for per-feed runtime state across two
  collectors, making future drift harder to spot.

The right fix is to surface feed runtime state through the collector
that already has a D1 handle. Two viable shapes, ordered by smallest
diff:

1. **Extend `collectors/data-layer.ts`** with a dedicated
   `feed_runtime` section that joins `feed_configs` and
   `feed_status`:
   ```sql
   SELECT fc.feed_name, fc.schedule_cron, fc.enabled, fc.feed_type,
          fs.last_successful_pull, fs.health_status, fs.last_error
     FROM feed_configs fc
     LEFT JOIN feed_status fs ON fs.feed_name = fc.feed_name
   ```
   Add matching `FeedRuntimeRow[]` to `DataLayerInventory` in
   `agents/architect/types.ts`. The Phase 2 feeds analyzer then joins
   `repo.feeds[].name` to `data_layer.feed_runtime[].feed_name` and
   has a real "scheduled vs dormant vs disabled" signal.

2. **New collector `collectors/feed-runtime.ts`**, mirrored on
   `collectors/ops.ts`. Cleaner conceptually but adds a fourth
   collector and a new bundle slice — only worth it if more runtime
   feed signals land later (queue depth per feed, byte throughput per
   feed, etc.).

Either way, the Phase 2 feeds analyzer at
`analysis/analyzer.ts:analyzeFeeds` should take the runtime slice as
an input and explicitly down-weight `schedule: null` when the runtime
row says `enabled = 1` with a recent `last_successful_pull`. The
current prompt treats `schedule: null` as load-bearing; it isn't.

**Also worth fixing alongside (same PR scope):** the Phase 2
`analyzeFeeds` prompt should be amended to note that
`repo.feeds[].schedule` is always `null` by design and must not be
used as a liveness signal. Belt-and-braces against regression if the
data-layer extension is ever reverted.

No feed code needs to change. No repo collector code needs to change.
The fix is an additive extension to the bundle surface + a prompt
tweak in the feeds analyzer.

---

## Reproduction commands

```bash
# Prove the manifest reports 38 nulls:
grep -c '"schedule": null' \
  packages/averrow-worker/src/agents/architect/manifest.generated.ts

# Prove feeds have no schedule field in TypeScript:
grep -rn 'schedule' packages/averrow-worker/src/feeds/types.ts

# Prove the dispatch chain reads from D1:
grep -n 'feed_configs' packages/averrow-worker/src/lib/feedRunner.ts

# Prove no collector reads feed_configs:
grep -rn 'feed_configs\|schedule_cron' \
  packages/averrow-worker/src/agents/architect/collectors/
```

Expected output: `38`, no match, matches in `feedRunner.ts`, no match
in collectors.

---

## Investigation date

2026-04-09
