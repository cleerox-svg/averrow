// Navigator — lightweight agent on the every-5-min cron schedule.
//
// Navigator finds network coordinates (IP addresses) for domains before
// Cartographer maps their physical coordinates (lat/lng). Navigator finds
// the path; Cartographer maps the terrain.
//
// Previously known as `fast_tick` (implementation detail describing HOW it
// runs, not WHAT it does). Historical agent_runs rows use 'fast_tick' —
// both IDs are valid and queries spanning this transition should handle both.
//
// Cloudflare sub-hour crons have a 30-second CPU ceiling. This handler
// must stay LEAN: no agent execution, no Haiku calls, no Flight Control.
//
// Current responsibilities:
//   1. Drain pending agent_events (mark done, no routing — just housekeeping)
//   2. Run one DNS backfill batch (200 domains, 8s soft cap) — PRIMARY MISSION
//   3. Refresh the three OLAP cubes (geo + provider + brand) for the current
//      and previous UTC hour — catches retroactive cartographer enrichment
//      and keeps Observatory aggregates in sync with raw threats.
//   4. Pre-warm KV caches for heavy page-load endpoints.
//
// Budget: ~15s typical (DNS 13-18s + cube <1s), well under the 30s hard ceiling.

import type { Env } from '../types';
import type { AgentModule, AgentResult, AgentContext, AgentOutputEntry } from '../lib/agentRunner';
import {
  checkAndFireThreatMilestones,
  checkAndFireIngestionMilestones,
} from '../lib/platform-milestones';
import { runDomainGeoBackfillBatch, type DnsBackfillResult } from '../lib/dns-backfill';
import { reconcileDnsQueue, backfillDnsQueueHistory, type ReconcileResult } from '../lib/dns-queue-reconciler';
import { reapDnsQueue, type ReaperResult } from '../lib/dns-queue-reaper';
import { reapOrphanFeedPullHistory } from '../lib/feed-pull-reaper';
import { reapOrphanAgentRuns } from '../lib/agent-runs-reaper';
import { buildGeoCubeForHour, buildProviderCubeForHour, buildBrandCubeForHour, buildStatusCubeForHour, buildArcsCubeForHour, getCubeSourceWatermark } from '../lib/cube-builder';
import type { CubeBuildResult } from '../lib/cube-builder';
import { handleObservatoryNodes, handleObservatoryArcs, handleObservatoryStats, handleObservatoryLive, handleObservatoryOperations } from '../handlers/observatory';
import { handleDashboardOverview, handleDashboardTopBrands } from '../handlers/dashboard';
import { handleListAgents } from '../handlers/agents';
import { handleListOperations, handleOperationsStats } from '../handlers/operations';
import { handleListBrands, handleBrandStats } from '../handlers/brands';
import { handleListThreatActors, handleThreatActorStats } from '../handlers/threatActors';
import { handleListBreaches, handleListATOEvents, handleListEmailAuth, handleListCloudIncidents } from '../handlers/intel';
import { getBudgetState, shouldSkipNonEssentialWarms, recordNavigatorSkip, DAILY_BUDGET, WARN_THRESHOLD } from '../lib/d1-budget';

/** Canonical agent_id written to agent_runs / agent_outputs / agent_events. */
export const NAVIGATOR_AGENT_ID = 'navigator';

/**
 * Historical agent_id used before the rename. agent_runs rows written prior
 * to the transition still carry this ID — any query that needs the full run
 * history for Navigator should filter on IN (NAVIGATOR_AGENT_ID, NAVIGATOR_LEGACY_AGENT_ID).
 */
export const NAVIGATOR_LEGACY_AGENT_ID = 'fast_tick';

/** How many agent_events to drain per tick. */
const EVENT_DRAIN_LIMIT = 50;

/** Default DNS batch size — conservative for 30s ceiling. */
const DNS_BATCH_SIZE = 200;

/**
 * Navigator-wide soft cap (ms). If we've spent this long across all phases,
 * skip any remaining cube refresh work. Leaves ~5s headroom under the 30s
 * Cloudflare sub-hour cron hard ceiling for the final agent_runs INSERT.
 */
const NAVIGATOR_SOFT_CAP_MS = 25_000;

/**
 * Format a Date as a 'YYYY-MM-DD HH:00:00' UTC hour bucket string, the exact
 * format cube-builder.ts expects. Uses getUTC* explicitly — D1's datetime('now')
 * and all stored created_at timestamps are UTC, so a local-time mismatch here
 * would bucket cube rows into the wrong hour.
 */
function formatHourBucketUTC(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:00:00`;
}

/** Internal result type returned by runNavigatorImpl(). The agent wrapper
 *  (navigatorAgent.execute) converts this into an AgentResult so the
 *  standard runner persists agent_runs + agent_outputs lifecycle. */
interface NavigatorImplResult {
  status: 'success' | 'partial' | 'failed';
  eventsDrained: number;
  itemsEnriched: number;
  errorMessage: string | null;
  cubeRows: number;
  cubeErrors: string[];
  /** Forwarded so the agent wrapper can emit a per-tick diagnostic. */
  dnsResult: DnsBackfillResult | null;
  /** DNS-queue reconciler outcome — surfaced to agent_outputs so
   *  operators can watch parity converge before PR-3 flips reads. */
  reconcileResult: ReconcileResult;
  /** DNS-queue reaper outcome — emitted on the once-per-day tick
   *  (hour===0). null on every other tick. */
  reaperResult: ReaperResult | null;
}

async function runNavigatorImpl(
  env: Env,
  _ctx: ExecutionContext,
  scheduledTime: Date,
): Promise<NavigatorImplResult> {
  const start = Date.now();
  const isOverCap = () => Date.now() - start > NAVIGATOR_SOFT_CAP_MS;
  console.log(`[navigator] start ${scheduledTime.toISOString()}`);

  let eventsDrained = 0;
  let dnsResult = { processed: 0, resolved: 0, enriched: 0, graduatedDead: 0, durationMs: 0, softCapHit: false, readSource: 'threats' as 'queue' | 'threats' };
  let reconcileResult: ReconcileResult = {
    skipped: true, reason: 'not_run', enqueued: 0, scanned: 0,
    cursorBefore: null, cursorAfter: null, cursorLagMinutes: 0,
    queueSize: 0, durationMs: 0,
    batchesAttempted: 0, batchesFailed: 0,
  };
  let reaperResult: ReaperResult | null = null;
  let status: 'success' | 'partial' | 'failed' = 'success';
  let errorMessage: string | undefined;

  try {
    // ── 1. Drain stale pending agent_events ──
    // The hourly tick's processAgentEvents does full routing + execution.
    // Here we only mark old pending events as 'done' so they don't pile up
    // between hourly ticks. Events younger than 5 min are left for the
    // hourly tick to route properly.
    try {
      const stale = await env.DB.prepare(`
        UPDATE agent_events
        SET status = 'done', processed_at = datetime('now')
        WHERE status = 'pending'
          AND created_at <= datetime('now', '-5 minutes')
        LIMIT ?
      `).bind(EVENT_DRAIN_LIMIT).run();
      // D1 .run() returns meta with changes count
      eventsDrained = stale.meta?.changes ?? 0;
      if (eventsDrained > 0) {
        console.log(`[navigator] drained ${eventsDrained} stale agent_events`);
      }
    } catch (err) {
      console.error('[navigator] event drain error:', err);
      // Non-fatal — continue to DNS backfill
    }

    // ── 1b. Reap orphan feed_pull_history rows ──
    try {
      const reapedCount = await reapOrphanFeedPullHistory(env);
      if (reapedCount > 0) {
        console.warn(`[navigator] reaped ${reapedCount} orphan feed_pull_history rows (status=partial, > 15min)`);
      }
    } catch (err) {
      console.error('[navigator] orphan pull-history reap error:', err);
      // Non-fatal — continue to DNS backfill
    }

    // ── 1c. Reap orphan agent_runs rows ──
    // Same architectural pattern as 1b, applied to the agent_runs
    // lifecycle. Without this, the diagnostic surfaces killed_runs
    // but the rows themselves stay 'partial' forever, and downstream
    // metrics (avg_duration_ms, last_completed_at) drift.
    try {
      const reapedAgentCount = await reapOrphanAgentRuns(env);
      if (reapedAgentCount > 0) {
        console.warn(`[navigator] reaped ${reapedAgentCount} orphan agent_runs rows (status=partial, past per-agent ceiling)`);
      }
    } catch (err) {
      console.error('[navigator] orphan agent_runs reap error:', err);
      // Non-fatal — continue to DNS backfill
    }

    // ── 2. DNS backfill batch ──
    dnsResult = await runDomainGeoBackfillBatch(env, {
      batchSize: DNS_BATCH_SIZE,
      timeoutMs: 8000,
    });

    console.log(
      `[navigator] dns-backfill: source=${dnsResult.readSource} processed=${dnsResult.processed} resolved=${dnsResult.resolved} enriched=${dnsResult.enriched} graduatedDead=${dnsResult.graduatedDead} softCapHit=${dnsResult.softCapHit} duration=${dnsResult.durationMs}ms`,
    );

    if (dnsResult.softCapHit || dnsResult.enriched < dnsResult.resolved) {
      status = 'partial';
    }

    // ── 2b. DNS queue reconcile (PR-BI cursor architecture) ──
    // Cursor-paginated enqueue: reads only threats added since the
    // last cursor (~37 rows/tick at current inflow) and INSERT OR
    // IGNOREs them into dns_queue. Stale-row removal lives in the
    // reaper (phase 2c, daily). Never throws — if DNS_QUEUE_DB is
    // unbound it returns {skipped:true} silently.
    try {
      reconcileResult = await reconcileDnsQueue(env);
      if (!reconcileResult.skipped) {
        console.log(
          `[navigator] dns-queue-reconcile: scanned=${reconcileResult.scanned} enqueued=${reconcileResult.enqueued} queue=${reconcileResult.queueSize} cursor=${reconcileResult.cursorBefore ?? 'null'}→${reconcileResult.cursorAfter ?? 'unchanged'} lag=${reconcileResult.cursorLagMinutes}m duration=${reconcileResult.durationMs}ms`,
        );
      }
    } catch (err) {
      // Belt-and-suspenders — the reconciler already catches its own
      // errors. This try/catch ensures any escape doesn't degrade
      // Navigator's overall status.
      console.error('[navigator] dns-queue-reconcile escape:', err);
    }

    // ── 2b-2. DNS queue historical backfill (one-time tail drain) ──
    // The forward reconciler above only enqueues threats newer than its
    // cursor. This drains the pre-cursor backlog (~63K unresolved-DNS
    // threats found outside the queue in the 2026-05-27 audit) one
    // bounded page per tick, then self-terminates via a KV done flag
    // (zero D1 cost thereafter). Never throws.
    try {
      const bf = await backfillDnsQueueHistory(env);
      if (!bf.skipped && bf.scanned > 0) {
        console.log(
          `[navigator] dns-queue-backfill: scanned=${bf.scanned} enqueued=${bf.enqueued} cursor→${bf.cursorAfter ?? 'unchanged'} done=${bf.done} duration=${bf.durationMs}ms`,
        );
      }
    } catch (err) {
      console.error('[navigator] dns-queue-backfill escape:', err);
    }

    // ── 2c. DNS queue reaper (PR-BI, daily) ──
    // Sweeps stale rows whose underlying threat is no longer a
    // candidate (status flipped, deleted, etc). Runs once per day
    // gated on hour===0. Hour-only gate (no minute check) per
    // CLAUDE.md §6 cron-audit rule — Navigator fires every 5 min
    // and the reaper is idempotent under KV-throttle if multiple
    // ticks within hour 0 race. Bounded ~17K reads/run; comfortably
    // fits the 25s Navigator soft-cap.
    if (scheduledTime.getUTCHours() === 0) {
      try {
        reaperResult = await reapDnsQueue(env);
        if (!reaperResult.skipped) {
          console.log(
            `[navigator] dns-queue-reap: scanned=${reaperResult.scanned} candidates=${reaperResult.candidatesInThreats} stale_removed=${reaperResult.staleRemoved} exhausted_marked=${reaperResult.exhaustedMarked} softCap=${reaperResult.softCapHit ? 'YES' : 'no'} duration=${reaperResult.durationMs}ms`,
          );
        }
      } catch (err) {
        console.error('[navigator] dns-queue-reap escape:', err);
      }
    }
  } catch (err) {
    status = 'failed';
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error('[navigator] fatal error:', errorMessage);
  }

  // ── 3. Cube refresh ──
  // Rebuild current hour + previous hour for both cubes. Previous-hour rebuild
  // catches cartographer's retroactive lat/lng enrichment so cube aggregates
  // don't drift from raw threats. Hours further back are left alone — the
  // admin backfill endpoint handles historical rebuilds.
  //
  // cube-builder functions catch their own errors and return {error} results;
  // the outer try is purely defensive. A cube failure never fails Navigator
  // overall — it just downgrades status from 'success' to 'partial'.
  const cubeResults: {
    currentHour: { geo: CubeBuildResult | null; provider: CubeBuildResult | null; brand: CubeBuildResult | null; status: CubeBuildResult | null; arcs: CubeBuildResult | null };
    prevHour: { geo: CubeBuildResult | null; provider: CubeBuildResult | null; brand: CubeBuildResult | null; status: CubeBuildResult | null; arcs: CubeBuildResult | null };
    totalRows: number;
    totalMs: number;
    errors: string[];
    prevHourSkipped: boolean;
  } = {
    currentHour: { geo: null, provider: null, brand: null, status: null, arcs: null },
    prevHour: { geo: null, provider: null, brand: null, status: null, arcs: null },
    totalRows: 0,
    totalMs: 0,
    errors: [],
    prevHourSkipped: false,
  };

  if (status !== 'failed') {
    try {
      if (!isOverCap()) {
        const currentHourBucket = formatHourBucketUTC(scheduledTime);
        const prevHourBucket = formatHourBucketUTC(new Date(scheduledTime.getTime() - 60 * 60 * 1000));

        // Current hour — geo
        if (!isOverCap()) {
          const r = await buildGeoCubeForHour(env, currentHourBucket);
          cubeResults.currentHour.geo = r;
          cubeResults.totalMs += r.durationMs;
          if (r.error) cubeResults.errors.push(`geo ${currentHourBucket}: ${r.error}`);
          else cubeResults.totalRows += r.rowsWritten;
        }
        // Current hour — provider
        if (!isOverCap()) {
          const r = await buildProviderCubeForHour(env, currentHourBucket);
          cubeResults.currentHour.provider = r;
          cubeResults.totalMs += r.durationMs;
          if (r.error) cubeResults.errors.push(`provider ${currentHourBucket}: ${r.error}`);
          else cubeResults.totalRows += r.rowsWritten;
        }
        // Current hour — brand
        if (!isOverCap()) {
          const r = await buildBrandCubeForHour(env, currentHourBucket);
          cubeResults.currentHour.brand = r;
          cubeResults.totalMs += r.durationMs;
          if (r.error) cubeResults.errors.push(`brand ${currentHourBucket}: ${r.error}`);
          else cubeResults.totalRows += r.rowsWritten;
        }
        // Current hour — status
        if (!isOverCap()) {
          const r = await buildStatusCubeForHour(env, currentHourBucket);
          cubeResults.currentHour.status = r;
          cubeResults.totalMs += r.durationMs;
          if (r.error) cubeResults.errors.push(`status ${currentHourBucket}: ${r.error}`);
          else cubeResults.totalRows += r.rowsWritten;
        }
        // Current hour — arcs (PR-Z)
        if (!isOverCap()) {
          const r = await buildArcsCubeForHour(env, currentHourBucket);
          cubeResults.currentHour.arcs = r;
          cubeResults.totalMs += r.durationMs;
          if (r.error) cubeResults.errors.push(`arcs ${currentHourBucket}: ${r.error}`);
          else cubeResults.totalRows += r.rowsWritten;
        }
        // Previous-hour rebuilds — gated by a stale-check watermark.
        //
        // Pre-2026-05-20 the prev-hour block fired on every 5-min tick
        // (12 rebuilds/hour × 5 cubes = the dominant cube-write driver
        // in the diagnostics top-write attribution). But once an hour
        // ticks over, the prev hour's threats are mostly stable —
        // feeds occasionally backfill late within the first few minutes,
        // but the per-tick rebuild after that produces zero new data.
        //
        // Strategy: take a cheap "shape" probe of the prev hour's
        // threats (MAX created_at + COUNT). Compare against the
        // watermark stored in KV after the LAST successful rebuild.
        // If unchanged, skip all 5 prev-hour cubes for this tick.
        //
        // Status transitions (active → remediated) on past hours are
        // NOT detected by this watermark — they're handled by the
        // 6-hourly cube-healer's full 30-day rebuild, same as before.
        // The 5-min cadence was never the right place to chase those.
        const prevHourWatermarkKey = `cube:built:prev_hour:${prevHourBucket}`;
        let prevHourWatermark: string | null = null;
        let shouldRebuildPrev = true;
        try {
          prevHourWatermark = await getCubeSourceWatermark(env, prevHourBucket);
          const lastBuilt = await env.CACHE.get(prevHourWatermarkKey);
          if (lastBuilt === prevHourWatermark) {
            shouldRebuildPrev = false;
            cubeResults.prevHourSkipped = true;
          }
        } catch (e) {
          // Watermark probe failed → fall through to rebuild. The
          // existing behavior is the safe default; we only skip on
          // confirmed-stable.
          cubeResults.errors.push(`prev_hour_watermark: ${e instanceof Error ? e.message : String(e)}`);
        }

        if (shouldRebuildPrev) {
          // Previous hour — geo
          if (!isOverCap()) {
            const r = await buildGeoCubeForHour(env, prevHourBucket);
            cubeResults.prevHour.geo = r;
            cubeResults.totalMs += r.durationMs;
            if (r.error) cubeResults.errors.push(`geo ${prevHourBucket}: ${r.error}`);
            else cubeResults.totalRows += r.rowsWritten;
          }
          // Previous hour — provider
          if (!isOverCap()) {
            const r = await buildProviderCubeForHour(env, prevHourBucket);
            cubeResults.prevHour.provider = r;
            cubeResults.totalMs += r.durationMs;
            if (r.error) cubeResults.errors.push(`provider ${prevHourBucket}: ${r.error}`);
            else cubeResults.totalRows += r.rowsWritten;
          }
          // Previous hour — brand
          if (!isOverCap()) {
            const r = await buildBrandCubeForHour(env, prevHourBucket);
            cubeResults.prevHour.brand = r;
            cubeResults.totalMs += r.durationMs;
            if (r.error) cubeResults.errors.push(`brand ${prevHourBucket}: ${r.error}`);
            else cubeResults.totalRows += r.rowsWritten;
          }
          // Previous hour — status
          if (!isOverCap()) {
            const r = await buildStatusCubeForHour(env, prevHourBucket);
            cubeResults.prevHour.status = r;
            cubeResults.totalMs += r.durationMs;
            if (r.error) cubeResults.errors.push(`status ${prevHourBucket}: ${r.error}`);
            else cubeResults.totalRows += r.rowsWritten;
          }
          // Previous hour — arcs (PR-Z)
          if (!isOverCap()) {
            const r = await buildArcsCubeForHour(env, prevHourBucket);
            cubeResults.prevHour.arcs = r;
            cubeResults.totalMs += r.durationMs;
            if (r.error) cubeResults.errors.push(`arcs ${prevHourBucket}: ${r.error}`);
            else cubeResults.totalRows += r.rowsWritten;
          }

          // Store watermark only AFTER a fully-clean rebuild — any
          // per-cube error means the next tick should retry rather
          // than trust the watermark. 2h TTL is plenty: the cube-
          // healer's 6h pass would rewrite the cube anyway, but a
          // KV miss before then just causes one extra rebuild,
          // which is the pre-fix behavior so a safe degradation.
          const noPrevHourErrors = cubeResults.errors.every(e => !e.includes(prevHourBucket));
          if (noPrevHourErrors && prevHourWatermark !== null) {
            try {
              await env.CACHE.put(prevHourWatermarkKey, prevHourWatermark, { expirationTtl: 7200 });
            } catch (e) {
              // Non-fatal — next tick will see the cache miss and rebuild.
              console.warn('[navigator] prev_hour watermark cache write failed:', e);
            }
          }
        }
      } else {
        cubeResults.errors.push('skipped: over soft cap from DNS phase');
      }
    } catch (e) {
      // Defensive: cube-builder functions shouldn't throw, but if they do,
      // log and continue — cube failures never fail Navigator overall.
      cubeResults.errors.push(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Cube errors downgrade to 'partial' but never to 'failed'.
    if (cubeResults.errors.length > 0 && status === 'success') {
      status = 'partial';
    }
  }

  // ── 4. Cache pre-warming ──
  // Call handler functions with synthetic requests to populate KV caches.
  // Each handler checks KV (miss on first call after TTL), runs DB queries,
  // stores result in KV, returns response (discarded here). Next real user
  // request hits warm KV cache instead of cold DB queries.
  //
  // Tiered by scheduled minute. Navigator fires every 5 min, but only the
  // Observatory 7d hot path needs that cadence — it's what the landing
  // page renders. Alternate-period toggles, dashboard, and deep-nav
  // modules are kept warm on slower cadences so Navigator doesn't
  // recompute the same page-load queries 288 times a day just because
  // someone *might* visit.
  //
  //   Phase A   — every 5 min  (Observatory 7d + live + operations)
  //   Phase A2  — every 15 min (Observatory 24h/30d alt periods)
  //   Phase B   — every 15 min (Dashboard + agents + operations)
  //   Phase C   — every 30 min (Brands + Threat Actors + Intelligence)
  //
  // Math at ~8,640 ticks/month if Navigator runs clean:
  //   A:  21,600 warms (was 43,200 before throttle, -50%)
  //   A2: 17,280 (was 51,840, -67%)
  //   B:  14,400 (was 43,200, -67%)
  //   C:  11,520 (was 69,120, -83%)
  // Total: ~65K warms/month, down from ~207K (-69%). Phase A throttled
  // from every-5-min to every-10-min as part of the D1-budget cleanup;
  // pairs with the 15-min KV TTL on Observatory endpoints so cold-load
  // UX stays well under the cache-miss window.
  const minute = scheduledTime.getUTCMinutes();
  const runPhaseA  = minute % 10 === 0;  // :00, :10, :20, :30, :40, :50
  const runPhaseA2 = minute % 15 === 0;  // :00, :15, :30, :45
  const runPhaseB  = minute % 15 === 0;
  const runPhaseC  = minute % 30 === 0;  // :00, :30

  // ── D1 read-budget soft-cap ──────────────────────────────────────
  // If we're already over 95% of the daily ceiling, skip Phase A2/B/C.
  // Phase A still runs because it's the user-facing landing page; the
  // optional warms (alt periods, deep-nav modules) get dropped first.
  // Hourly-cached, so this costs at most one CF GraphQL call/hour.
  const budgetState = await getBudgetState(env);
  const skipNonEssential = shouldSkipNonEssentialWarms(budgetState);
  if (skipNonEssential) {
    console.warn(
      `[navigator] D1 budget over SKIP threshold — read=${budgetState!.rowsRead24h.toLocaleString()} ` +
      `daily=${DAILY_BUDGET.toLocaleString()} pct=${((budgetState!.rowsRead24h / DAILY_BUDGET) * 100).toFixed(1)}% — ` +
      `skipping Phase A2/B/C this tick`,
    );
    // Diagnostics signal — bump the 24h skip counter + last_skip_at
    // so platform-diagnostics can prove the soft-cap is actually
    // firing (not just configured).
    await recordNavigatorSkip(env);
  } else if (budgetState && budgetState.rowsRead24h >= WARN_THRESHOLD) {
    console.warn(
      `[navigator] D1 budget in WARN zone — read=${budgetState.rowsRead24h.toLocaleString()} ` +
      `daily=${DAILY_BUDGET.toLocaleString()} pct=${((budgetState.rowsRead24h / DAILY_BUDGET) * 100).toFixed(1)}%`,
    );
  }

  let cacheWarmed = 0;
  if (!isOverCap() && status !== 'failed') {
    const warmStart = Date.now();
    const fakeReq = (path: string) => new Request(`https://averrow.com${path}`);
    try {
      // Phase A: Observatory endpoints (highest impact — 10-15s cold load)
      // Run the 5 Observatory queries in parallel for maximum throughput.
      // Throttled to every 10 min — endpoints cache for 15 min so the
      // landing page still hits warm cache on every visit.
      if (runPhaseA) {
        const obsResults = await Promise.allSettled([
          handleObservatoryNodes(fakeReq('/api/observatory/nodes?period=7d'), env),
          handleObservatoryArcs(fakeReq('/api/observatory/arcs?period=7d'), env),
          handleObservatoryStats(fakeReq('/api/observatory/stats?period=7d'), env),
          handleObservatoryLive(fakeReq('/api/observatory/live?limit=20'), env),
          handleObservatoryOperations(fakeReq('/api/observatory/operations?limit=5'), env),
        ]);
        cacheWarmed += obsResults.filter(r => r.status === 'fulfilled').length;
      }

      // Phase A2: Observatory alternate periods (24h/30d) — every 15 min
      if (runPhaseA2 && !isOverCap() && !skipNonEssential) {
        const altResults = await Promise.allSettled([
          handleObservatoryNodes(fakeReq('/api/observatory/nodes?period=24h'), env),
          handleObservatoryArcs(fakeReq('/api/observatory/arcs?period=24h'), env),
          handleObservatoryStats(fakeReq('/api/observatory/stats?period=24h'), env),
          handleObservatoryNodes(fakeReq('/api/observatory/nodes?period=30d'), env),
          handleObservatoryArcs(fakeReq('/api/observatory/arcs?period=30d'), env),
          handleObservatoryStats(fakeReq('/api/observatory/stats?period=30d'), env),
        ]);
        cacheWarmed += altResults.filter(r => r.status === 'fulfilled').length;
      }

      // Phase B: Dashboard + agents + operations — every 15 min
      if (runPhaseB && !isOverCap() && !skipNonEssential) {
        const pageResults = await Promise.allSettled([
          handleDashboardOverview(fakeReq('/api/dashboard/overview'), env),
          handleDashboardTopBrands(fakeReq('/api/dashboard/top-brands'), env),
          handleListAgents(fakeReq('/api/agents'), env),
          handleListOperations(fakeReq('/api/v1/operations'), env),
          handleOperationsStats(fakeReq('/api/v1/operations/stats'), env),
        ]);
        cacheWarmed += pageResults.filter(r => r.status === 'fulfilled').length;
      }

      // Phase C: Brands, Threat Actors, Intelligence — every 30 min
      if (runPhaseC && !isOverCap() && !skipNonEssential) {
        const moduleResults = await Promise.allSettled([
          handleListBrands(fakeReq('/api/brands?limit=50&sort=threats'), env),
          handleBrandStats(fakeReq('/api/brands/stats'), env),
          handleListThreatActors(fakeReq('/api/threat-actors?limit=50'), env),
          handleThreatActorStats(fakeReq('/api/threat-actors/stats'), env),
          handleListBreaches(fakeReq('/api/breaches?limit=50'), env),
          handleListATOEvents(fakeReq('/api/ato-events?limit=50'), env),
          handleListEmailAuth(fakeReq('/api/email-auth?limit=50'), env),
          handleListCloudIncidents(fakeReq('/api/cloud-incidents?limit=50'), env),
        ]);
        cacheWarmed += moduleResults.filter(r => r.status === 'fulfilled').length;
      }

      console.log(`[navigator] cache-warm: ${cacheWarmed} endpoints warmed in ${Date.now() - warmStart}ms (A=${runPhaseA} A2=${runPhaseA2} B=${runPhaseB} C=${runPhaseC})`);
    } catch (e) {
      console.error('[navigator] cache-warm error:', e instanceof Error ? e.message : String(e));
    }
  }

  // ── 5. Build result struct ──
  // The standard runner (executeAgent) writes the agent_runs row from
  // navigatorAgent.execute()'s AgentResult. Per-stage failures travel
  // back as agent_outputs diagnostics via the wrapper below.
  const durationMs = Date.now() - start;
  const errorParts: string[] = [];
  if (errorMessage) errorParts.push(`dns: ${errorMessage}`);
  if (cubeResults.errors.length > 0) {
    errorParts.push(`cube: ${cubeResults.errors.join('; ')}`);
  }
  const finalErrorMessage = errorParts.length > 0 ? errorParts.join(' | ') : null;

  console.log(
    `[navigator] done status=${status} events_drained=${eventsDrained} processed=${dnsResult.processed} resolved=${dnsResult.resolved} enriched=${dnsResult.enriched} cube_rows=${cubeResults.totalRows} cube_ms=${cubeResults.totalMs} cube_errors=${cubeResults.errors.length} cache_warmed=${cacheWarmed} d1_skip=${skipNonEssential} d1_read24h=${budgetState?.rowsRead24h ?? 'unknown'} softCapHit=${dnsResult.softCapHit} duration=${durationMs}ms`,
  );

  return {
    status,
    eventsDrained,
    itemsEnriched: dnsResult.enriched,
    errorMessage: finalErrorMessage,
    cubeRows: cubeResults.totalRows,
    cubeErrors: cubeResults.errors,
    dnsResult,
    reconcileResult,
    reaperResult,
  };
}

// ─── AgentModule wrapper ─────────────────────────────────────────
//
// Phase 2.4 of the agent audit: navigator was a hidden agent — its
// own dedicated cron, its own raw INSERT into agent_runs, no
// AgentModule. Now wraps the impl in the standard runner pattern
// per AGENT_STANDARD §3-4.
//
// The dedicated `*/5 * * * *` cron entry is unchanged. The orchestrator
// dispatches via executeAgent() instead of calling runNavigator()
// directly, so the agent_runs lifecycle, FC stall recovery, and
// circuit breaker all work uniformly.

export const navigatorAgent: AgentModule = {
  name: 'navigator',
  displayName: 'Navigator',
  description: 'DNS resolution — independent 5-min cron',
  color: '#38BDF8',
  trigger: 'scheduled',
  requiresApproval: false,
  // Navigator runs every 5 min — a 30-min threshold tolerates ~6
  // missed ticks before FC flags it stalled. Cost guard exempt:
  // Navigator does DNS / KV / cube work, no AI calls.
  stallThresholdMinutes: 30,
  parallelMax: 1,
  costGuard: 'exempt',
  // No AI calls — DNS / KV / cube only. Cap=0 surfaces regressions.
  budget: { monthlyTokenCap: 0 },
  // Direct SQL surface is one UPDATE on agent_events; the cube + DNS
  // work goes through lib/cube-builder + lib/dns-resolver helpers.
  reads: [],
  writes: [
    { kind: 'd1_table', name: 'agent_events' },
    // PR-2 reconciler — INSERT/UPDATE/DELETE on the dns_queue side
    // DB. Declared so the architect resource-drift check sees it.
    { kind: 'd1_table', name: 'dns_queue' },
  ],
  outputs: [],
  status: 'active',
  category: 'intelligence',
  pipelinePosition: 2,

  async execute(ctx: AgentContext): Promise<AgentResult> {
    // The orchestrator passes scheduledTime via input so per-tick
    // hour-bucket math survives cron jitter (CLAUDE.md cron-audit
    // rule — never derive from `new Date()`).
    const inputScheduledTime = ctx.input.scheduledTime;
    const scheduledTime =
      typeof inputScheduledTime === 'string'
        ? new Date(inputScheduledTime)
        : inputScheduledTime instanceof Date
          ? inputScheduledTime
          : new Date();

    // ExecutionContext is threaded through ctx.input._executionCtx
    // (matches flightControlAgent's pattern). Falls back to a no-op
    // for non-cron call sites — the impl only uses it for waitUntil
    // best-effort tasks.
    const execCtx = (ctx.input._executionCtx as ExecutionContext | undefined)
      ?? ({ waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext);

    const result = await runNavigatorImpl(ctx.env, execCtx, scheduledTime);

    // Surface partial-stage failures as severity='high' diagnostic
    // agent_outputs so operators see them in the Agents UI even
    // though agent_runs.status will land as 'success' (limitation
    // documented in Phase 2.3 / cube_healer migration; lifted in
    // Phase 4 when AgentResult gains a `partial: boolean` field).
    const agentOutputs: AgentOutputEntry[] = [];

    // Platform milestones (best-effort — never blocks the agent return).
    // Cheap: two aggregate queries + a few SELECTs on the milestone
    // table, all indexed. Fires the celebration banner via the public
    // endpoint /api/v1/public/milestones/latest when a new threshold
    // is crossed under EITHER metric.
    let threatMilestones = { metric: 'threats_ingested', current: 0, fired: [] as number[] };
    let ingestMilestones = { metric: 'total_ingested',   current: 0, fired: [] as number[] };
    try {
      threatMilestones = await checkAndFireThreatMilestones(ctx.env, ctx.runId);
    } catch (err) {
      console.error('[navigator] threat milestone check failed:', err);
    }
    try {
      ingestMilestones = await checkAndFireIngestionMilestones(ctx.env, ctx.runId);
    } catch (err) {
      console.error('[navigator] ingestion milestone check failed:', err);
    }
    const allFired = [
      ...threatMilestones.fired.map((v) => `threats_ingested=${v}`),
      ...ingestMilestones.fired.map((v) => `total_ingested=${v}`),
    ];
    if (allFired.length > 0) {
      agentOutputs.push({
        type: 'diagnostic',
        summary: `milestone(s) crossed: ${allFired.join(', ')}`,
        severity: 'info',
        details: {
          threats_ingested_current: threatMilestones.current,
          threats_ingested_fired:   threatMilestones.fired,
          total_ingested_current:   ingestMilestones.current,
          total_ingested_fired:     ingestMilestones.fired,
        },
      });
    }
    if (result.errorMessage) {
      agentOutputs.push({
        type: 'diagnostic',
        summary: `Navigator partial failure: ${result.errorMessage}`,
        severity: 'high',
        details: {
          eventsDrained: result.eventsDrained,
          itemsEnriched: result.itemsEnriched,
          cubeRows: result.cubeRows,
          cubeErrors: result.cubeErrors,
        },
      });
    }

    // Always emit a DNS-throughput diagnostic so per-tick numbers
    // are queryable after the fact. Prior to this we only had
    // ephemeral console logs and `agent_runs.records_processed`,
    // which only counts enriched + events_drained — invisible to
    // the resolution and stamping work that dominates a normal
    // tick. Diagnostic queries (`SELECT details FROM agent_outputs
    // WHERE agent_id='navigator' AND type='dns_throughput'`) can
    // now distinguish "SELECT empty" from "softCapHit early" from
    // "all transient" without re-deploying instrumentation.
    if (result.dnsResult) {
      const dr = result.dnsResult;
      const severity = dr.softCapHit ? 'medium' : 'info';
      agentOutputs.push({
        type: 'diagnostic',
        summary: `dns-backfill: source=${dr.readSource} processed=${dr.processed} resolved=${dr.resolved} dead=${dr.graduatedDead} enriched_rows=${dr.enriched} softCap=${dr.softCapHit ? 'YES' : 'no'} ${dr.durationMs}ms`,
        severity,
        details: {
          read_source: dr.readSource,
          processed: dr.processed,
          resolved: dr.resolved,
          graduated_dead: dr.graduatedDead,
          enriched_rows: dr.enriched,
          soft_cap_hit: dr.softCapHit,
          duration_ms: dr.durationMs,
        },
      });
    }

    // DNS-queue reconciler diagnostic (PR-BI cursor architecture).
    // `cursor_lag_minutes` is the key health signal: if it grows
    // unbounded, threats are being ingested faster than the
    // reconciler is enqueuing. Steady-state lag should hover near
    // 0-5 min. Batch failures medium-severity; high lag (>30 min,
    // ie 6+ stalled ticks) also medium.
    {
      const rr = result.reconcileResult;
      const errSuffix = rr.batchesFailed > 0
        ? ` batchFails=${rr.batchesFailed}/${rr.batchesAttempted} err="${(rr.lastError ?? '').slice(0, 120)}"`
        : '';
      agentOutputs.push({
        type: 'diagnostic',
        summary: rr.skipped
          ? `dns-queue-reconcile: SKIPPED (${rr.reason ?? 'unknown'})`
          : `dns-queue-reconcile: scanned=${rr.scanned} enqueued=${rr.enqueued} queue=${rr.queueSize} lag=${rr.cursorLagMinutes}m ${rr.durationMs}ms${errSuffix}`,
        severity: rr.skipped || rr.batchesFailed > 0 ? 'medium'
          : rr.cursorLagMinutes > 30 ? 'medium'
          : 'info',
        details: {
          skipped: rr.skipped,
          reason: rr.reason,
          scanned: rr.scanned,
          enqueued: rr.enqueued,
          cursor_before: rr.cursorBefore,
          cursor_after: rr.cursorAfter,
          cursor_lag_minutes: rr.cursorLagMinutes,
          queue_size: rr.queueSize,
          duration_ms: rr.durationMs,
          batches_attempted: rr.batchesAttempted,
          batches_failed: rr.batchesFailed,
          last_error: rr.lastError,
        },
      });
    }

    // DNS-queue reaper diagnostic (PR-BI, hour===0 only).
    // `stale_removed` is the daily clean-up volume. Spikes can mean
    // a feed mass-deactivated threats; sustained low values are
    // normal steady-state. softCapHit means the queue is growing
    // faster than the reaper can sweep — escalate to medium.
    if (result.reaperResult) {
      const rp = result.reaperResult;
      const errSuffix = rp.batchesFailed > 0
        ? ` batchFails=${rp.batchesFailed}/${rp.batchesAttempted} err="${(rp.lastError ?? '').slice(0, 120)}"`
        : '';
      agentOutputs.push({
        type: 'diagnostic',
        summary: rp.skipped
          ? `dns-queue-reap: SKIPPED (${rp.reason ?? 'unknown'})`
          : `dns-queue-reap: scanned=${rp.scanned} candidates=${rp.candidatesInThreats} stale_removed=${rp.staleRemoved} softCap=${rp.softCapHit ? 'YES' : 'no'} ${rp.durationMs}ms${errSuffix}`,
        severity: rp.skipped || rp.batchesFailed > 0 || rp.softCapHit ? 'medium' : 'info',
        details: {
          skipped: rp.skipped,
          reason: rp.reason,
          scanned: rp.scanned,
          candidates_in_threats: rp.candidatesInThreats,
          stale_removed: rp.staleRemoved,
          delta: rp.delta,
          soft_cap_hit: rp.softCapHit,
          duration_ms: rp.durationMs,
          batches_attempted: rp.batchesAttempted,
          batches_failed: rp.batchesFailed,
          last_error: rp.lastError,
        },
      });
    }

    return {
      itemsProcessed: result.itemsEnriched + result.eventsDrained,
      itemsCreated: result.cubeRows,
      itemsUpdated: 0,
      output: {
        status: result.status,
        eventsDrained: result.eventsDrained,
        itemsEnriched: result.itemsEnriched,
        cubeRows: result.cubeRows,
        cubeErrors: result.cubeErrors.length,
        threats_ingested_fired: threatMilestones.fired,
        total_ingested_fired:   ingestMilestones.fired,
        threats_ingested_current: threatMilestones.current,
        total_ingested_current:   ingestMilestones.current,
      },
      agentOutputs,
    };
  },
};
