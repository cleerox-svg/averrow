// Platform milestones — celebrate growth across the platform's headline
// counters. Each metric is a row in the METRICS registry below; Navigator
// evaluates all of them at the end of every 5-min tick.
//
// Metrics:
//   1. threats_ingested    — COUNT(*) FROM threats. Active threats currently
//                            in the threats table. May dip when rows resolve.
//   2. total_ingested      — SUM(records_ingested) FROM feed_pull_history.
//                            Lifetime ingest volume. Only goes up. Same number
//                            the /feeds page surfaces as "TOTAL INGESTED".
//   3. brands_monitored    — COUNT(*) FROM brands. Brand catalog size.
//   4. clusters_mapped     — COUNT(*) FROM infrastructure_clusters. NEXUS ops.
//   5. providers_cataloged — COUNT(*) FROM hosting_providers.
//   6. campaigns_tracked   — COUNT(*) FROM campaigns.
//
// Every metric fires against its own ladder (LARGE for the high-volume
// counters, MID for the smaller registries). The platform_milestones PK is
// composite (metric, value), so each metric crosses 100K / 1M / 10M
// independently. The Home banner reads the most-recent genuine row across
// every metric and labels accordingly.
//
// Cold-start seeding: the first time a metric is ever evaluated we silently
// "seed" every threshold it has ALREADY passed (notes='seed') instead of
// celebrating them — otherwise adding a metric would throw a "just now" party
// for a crossing that happened weeks ago. Only crossings that happen AFTER a
// metric is initialized are celebrated. A metric counts as initialized once it
// has a genuine (non-seed) row OR a KV init flag (milestone:init:<metric>).
//
// Cost: each metric is a single cached aggregate + one SELECT on the milestone
// table + ≤1 INSERT per crossing. Idempotent under the composite PK.

import type { Env } from '../types';
import { cachedCount } from './cached-count';

// High-volume counters: threats, lifetime ingest, brand catalog.
const LARGE_LADDER = [
  100_000,
  200_000,
  250_000,
  300_000,
  350_000,
  400_000,
  450_000,
  500_000,
  750_000,
  1_000_000,
  1_500_000,
  2_000_000,
  3_000_000,
  5_000_000,
  7_500_000,
  10_000_000,
  25_000_000,
  50_000_000,
  100_000_000,
] as const;

// Smaller registries: clusters, providers, campaigns. Finer steps at the
// low end so a few-thousand-row table still gets meaningful milestones.
const MID_LADDER = [
  1_000,
  2_500,
  5_000,
  10_000,
  25_000,
  50_000,
  100_000,
  250_000,
  500_000,
  1_000_000,
  2_500_000,
  5_000_000,
  10_000_000,
] as const;

export type MilestoneMetric =
  | "threats_ingested"
  | "total_ingested"
  | "brands_monitored"
  | "clusters_mapped"
  | "providers_cataloged"
  | "campaigns_tracked";

interface MetricDef {
  metric: MilestoneMetric;
  /** Human label — banner copy lives in the frontend; this is for logs. */
  label: string;
  ladder: readonly number[];
  count: (env: Env) => Promise<number>;
}

const METRICS: readonly MetricDef[] = [
  {
    metric: "threats_ingested",
    label: "threats ingested",
    ladder: LARGE_LADDER,
    // TTL 3600s: shared with the dashboard/admin `count.threats.total` entry
    // so all callers warm one cache. Milestones advance slowly, so a 1h lag
    // is invisible to operators. Navigator fires every 300s → ~1 miss/hour.
    count: (env) =>
      cachedCount(env, "count.threats.total", 3600, async () => {
        const row = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM threats`)
          .first<{ n: number }>();
        return row?.n ?? 0;
      }),
  },
  {
    metric: "total_ingested",
    label: "total ingested",
    ladder: LARGE_LADDER,
    count: (env) =>
      cachedCount(env, "count.feed_pulls.total_ingested", 1800, async () => {
        const row = await env.DB
          .prepare(
            `SELECT COALESCE(SUM(records_ingested), 0) AS n FROM feed_pull_history`,
          )
          .first<{ n: number }>();
        return row?.n ?? 0;
      }),
  },
  {
    metric: "brands_monitored",
    label: "brands monitored",
    ladder: LARGE_LADDER,
    count: (env) =>
      cachedCount(env, "count.brands.total", 3600, async () => {
        const row = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM brands`)
          .first<{ n: number }>();
        return row?.n ?? 0;
      }),
  },
  {
    metric: "clusters_mapped",
    label: "infrastructure clusters mapped",
    ladder: MID_LADDER,
    count: (env) =>
      cachedCount(env, "count.clusters.total", 3600, async () => {
        const row = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM infrastructure_clusters`)
          .first<{ n: number }>();
        return row?.n ?? 0;
      }),
  },
  {
    metric: "providers_cataloged",
    label: "hosting providers cataloged",
    ladder: MID_LADDER,
    count: (env) =>
      cachedCount(env, "count.providers.total", 3600, async () => {
        const row = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM hosting_providers`)
          .first<{ n: number }>();
        return row?.n ?? 0;
      }),
  },
  {
    metric: "campaigns_tracked",
    label: "threat campaigns tracked",
    ladder: MID_LADDER,
    count: (env) =>
      cachedCount(env, "count.campaigns.total", 3600, async () => {
        const row = await env.DB
          .prepare(`SELECT COUNT(*) AS n FROM campaigns`)
          .first<{ n: number }>();
        return row?.n ?? 0;
      }),
  },
];

export interface MilestoneRow {
  value: number;
  metric: string;
  fired_at: string;
  agent_run_id: string | null;
  notes: string | null;
}

export interface MilestoneCheckResult {
  metric: MilestoneMetric;
  current: number;
  fired: number[];
}

async function insertMilestone(
  db: D1Database,
  metric: string,
  value: number,
  agentRunId: string | null | undefined,
  notes: string | null,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO platform_milestones
            (metric, value, fired_at, agent_run_id, notes)
         VALUES (?, ?, datetime('now'), ?, ?)`,
      )
      .bind(metric, value, agentRunId ?? null, notes)
      .run();
    return true;
  } catch (err) {
    // Non-fatal: re-attempt next tick.
    console.error(`[platform-milestones] insert failed for ${metric}=${value}:`, err);
    return false;
  }
}

async function evaluateMetric(
  env: Env,
  def: MetricDef,
  agentRunId?: string | null,
): Promise<MilestoneCheckResult> {
  const current = await def.count(env);

  // Pull every fired value for THIS metric so the diff stays metric-scoped —
  // composite PK means 1M under threats_ingested doesn't suppress 1M under
  // total_ingested. `notes` distinguishes genuine celebrations from seeds.
  const firedRows = await env.DB
    .prepare(`SELECT value, notes FROM platform_milestones WHERE metric = ?`)
    .bind(def.metric)
    .all<{ value: number; notes: string | null }>();
  const rows = firedRows.results ?? [];
  const alreadyFired = new Set(rows.map((r) => r.value));
  const hasGenuineRows = rows.some((r) => !r.notes);

  const crossed = def.ladder.filter(
    (v) => current >= v && !alreadyFired.has(v),
  );

  // Initialized = has a real celebration on record OR a KV seed flag. A
  // brand-new metric is initialized on its first evaluation (even if nothing
  // has crossed yet) so the NEXT crossing celebrates instead of seeding.
  const seedKey = `milestone:init:${def.metric}`;
  const initialized =
    hasGenuineRows || (await env.CACHE.get(seedKey)) !== null;

  if (!initialized) {
    // Cold start: silently record already-passed thresholds, no celebration.
    for (const v of crossed) {
      await insertMilestone(env.DB, def.metric, v, agentRunId, "seed");
    }
    // No TTL — the flag is permanent; the metric only cold-starts once.
    await env.CACHE.put(seedKey, new Date().toISOString());
    return { metric: def.metric, current, fired: [] };
  }

  const fired: number[] = [];
  for (const v of crossed) {
    if (await insertMilestone(env.DB, def.metric, v, agentRunId, null)) {
      fired.push(v);
    }
  }
  return { metric: def.metric, current, fired };
}

/**
 * Evaluate every registered metric. Each is isolated — one metric's failure
 * (e.g. a missing table) never blocks the others. Called from Navigator on
 * every 5-min tick.
 */
export async function checkAllMilestones(
  env: Env,
  agentRunId?: string | null,
): Promise<MilestoneCheckResult[]> {
  const results: MilestoneCheckResult[] = [];
  for (const def of METRICS) {
    try {
      results.push(await evaluateMetric(env, def, agentRunId));
    } catch (err) {
      console.error(`[platform-milestones] ${def.metric} check failed:`, err);
      results.push({ metric: def.metric, current: 0, fired: [] });
    }
  }
  return results;
}

/**
 * Most-recent genuine milestone across ALL metrics. Drives the Home banner —
 * operators see the freshest real celebration regardless of which metric
 * crossed. Seed rows (silent cold-start backfill) are excluded; the value
 * tiebreak surfaces the most impressive threshold when several land at once.
 */
export async function getLatestMilestone(
  db: D1Database,
): Promise<MilestoneRow | null> {
  return await db
    .prepare(
      `SELECT value, metric, fired_at, agent_run_id, notes
         FROM platform_milestones
        WHERE COALESCE(notes, '') <> 'seed'
        ORDER BY fired_at DESC, value DESC
        LIMIT 1`,
    )
    .first<MilestoneRow>();
}

/** For diagnostics. Returns the union of every metric's ladder. */
export function listMilestoneTargets(): readonly number[] {
  return Array.from(new Set([...LARGE_LADDER, ...MID_LADDER])).sort(
    (a, b) => a - b,
  );
}
