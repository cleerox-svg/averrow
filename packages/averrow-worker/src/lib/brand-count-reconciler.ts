/**
 * Brand threat-counter reconciler.
 *
 * brands.threat_count / brands.last_threat_seen are pre-computed columns
 * (CLAUDE.md §8: "use them, don't re-derive") but drifted permanently
 * because several brand-link paths set threats.target_brand_id without
 * bumping the counter (analyst keyword pre-match was the highest-volume
 * offender; feedRunner inserts, watchdog escalations, and the spam-trap
 * extra-URL loop also skip it) and no job owned the recompute — the
 * hosting_providers counters have cartographer as their owner; brands
 * had no equivalent.
 *
 * Audit 2026-07-07: 4,420 of 9,853 linked brands (45%) had a wrong
 * counter, 3,246 stuck at 0 despite live threats. Beyond the Brands
 * page sort, the mastodon/reddit feeds gate eligibility on
 * threat_count > 0, so stuck-at-zero brands were silently excluded
 * from social monitoring.
 *
 * Strategy: one GROUP BY over threats(target_brand_id) per run
 * (index-driven via idx_threats_brand_status), diffed in memory
 * against the non-zero counters, then batched UPDATEs for drifted
 * rows only. Steady-state this touches only the rows the incremental
 * writers missed since the last run. Semantics for threat_count:
 * COUNT(*) of ALL linked threats regardless of status — parity with
 * the two existing authoritative recompute sites in handlers/brands.ts
 * (add-monitored and deep-scan flows).
 *
 * The same pass also reconciles brands.active_threat_count (the
 * active-only pre-computed counter read by the tenant dashboard +
 * email-security stats). Its primary maintainer is the change-guarded
 * whole-table sync in lib/brand-active-counts.ts (enrichment Stage 5);
 * this reconciler is its drift safety-net, computed for free from the
 * same GROUP BY via a conditional SUM.
 *
 * Runs inside the cube_healer agent (6-hourly cron) — same "healer"
 * pattern that bounds cube drift. Stamps its result into KV
 * (metrics:brand_threat_count_drift) for platform-diagnostics.
 */

import type { Env } from '../types';

export interface BrandCountReconcileResult {
  brandsChecked: number;
  drifted: number;
  fixed: number;
}

export const BRAND_DRIFT_METRIC_KEY = 'metrics:brand_threat_count_drift';
const BATCH_SIZE = 100;

export async function reconcileBrandThreatCounts(env: Env): Promise<BrandCountReconcileResult> {
  const [agg, current] = await Promise.all([
    env.DB.prepare(
      `SELECT target_brand_id AS id, COUNT(*) AS n,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_n,
              MAX(last_seen) AS latest
         FROM threats
        WHERE target_brand_id IS NOT NULL
        GROUP BY target_brand_id`,
    ).all<{ id: string; n: number; active_n: number; latest: string | null }>(),
    env.DB.prepare(
      `SELECT id, threat_count, active_threat_count FROM brands
        WHERE threat_count != 0 OR active_threat_count != 0`,
    ).all<{ id: string; threat_count: number; active_threat_count: number }>(),
  ]);

  const currentMap = new Map(
    current.results.map((r) => [r.id, r]),
  );
  const liveIds = new Set<string>();
  const fixes: D1PreparedStatement[] = [];

  for (const row of agg.results) {
    liveIds.add(row.id);
    const cur = currentMap.get(row.id);
    const activeN = row.active_n ?? 0;
    if ((cur?.threat_count ?? 0) !== row.n || (cur?.active_threat_count ?? 0) !== activeN) {
      // COALESCE keeps an existing last_threat_seen when the aggregate
      // has no timestamp (last_seen NULL on every linked row).
      fixes.push(
        env.DB.prepare(
          `UPDATE brands
              SET threat_count = ?,
                  active_threat_count = ?,
                  last_threat_seen = COALESCE(?, last_threat_seen)
            WHERE id = ?`,
        ).bind(row.n, activeN, row.latest, row.id),
      );
    }
  }

  // Counter is non-zero but no linked threats remain (links removed or
  // threats deleted) — zero both counters so the social-feed eligibility
  // gate, list sort, and the active-only reads stop trusting a phantom
  // count.
  for (const row of current.results) {
    if (!liveIds.has(row.id)) {
      fixes.push(
        env.DB.prepare(
          `UPDATE brands SET threat_count = 0, active_threat_count = 0 WHERE id = ?`,
        ).bind(row.id),
      );
    }
  }

  let fixed = 0;
  for (let i = 0; i < fixes.length; i += BATCH_SIZE) {
    const res = await env.DB.batch(fixes.slice(i, i + BATCH_SIZE));
    fixed += res.reduce((s, r) => s + (r.meta?.changes ?? 0), 0);
  }

  const result: BrandCountReconcileResult = {
    brandsChecked: liveIds.size,
    drifted: fixes.length,
    fixed,
  };

  // Best-effort telemetry stamp — read back by platform-diagnostics as
  // `brand_count_drift`. Persistent large `drifted` between runs means
  // a new writer is skipping the counter again.
  try {
    await env.CACHE.put(
      BRAND_DRIFT_METRIC_KEY,
      JSON.stringify({ ...result, checked_at: new Date().toISOString() }),
      { expirationTtl: 7 * 24 * 3600 },
    );
  } catch {
    // metric stamp only — never fail the reconcile over KV
  }

  return result;
}
