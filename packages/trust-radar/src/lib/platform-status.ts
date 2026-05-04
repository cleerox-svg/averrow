// Averrow — Platform Status Calculator
//
// Source-of-truth for "is the platform up?" — produces a 30-day rolling
// daily uptime rollup across three categories: Feeds, Agents, Processing.
//
// Read by:
//   - GET /api/admin/platform-status      (Home banner, ops console)
//   - GET /api/internal/platform-status   (averrow-mcp, status page worker)
//   - handlers/diagnostics.ts             (so /platform-diagnostics doesn't drift)
//
// The April 2026 ingest blackout (commit 50cb1e4) revealed that the static
// "ALL SYSTEMS OPERATIONAL" badge on Home was lying for 82 hours. This
// module replaces that lie with a derivation from agent_runs +
// feed_pull_history. If the orchestrator stops dispatching, agent_runs
// stops growing; if D1 falls over, every agent's run-count drops; if
// ingest feeds go silent, records_ingested collapses. All three are
// captured here.

import type { Env } from "../types";

// Shared types live in @averrow/shared so the React UI consumes the
// exact same shape the worker emits. Re-exported here so existing
// imports (handlers/platform-status, etc.) keep working.
export type {
  CategoryStatus,
  CategoryKey,
  DailyPoint,
  CategoryRollup,
  PlatformStatus,
} from "@averrow/shared";
import type { CategoryStatus, CategoryKey, DailyPoint, CategoryRollup, PlatformStatus } from "@averrow/shared";

// ─── Thresholds ───────────────────────────────────────────────────
// Tuned against the 50cb1e4 outage so Apr 30–May 2 land in 'outage'
// while normal-cadence days land in 'operational'. Move these into
// system_config later if operators want to override per-environment.

const FEEDS_OPERATIONAL = 85;
const FEEDS_DEGRADED = 50;

const AGENTS_OPERATIONAL = 95;
const AGENTS_DEGRADED = 80;

const PROCESSING_OPERATIONAL = 95;
const PROCESSING_DEGRADED = 85;

// ─── Helpers ──────────────────────────────────────────────────────

function classify(pct: number, opThresh: number, degThresh: number): CategoryStatus {
  if (pct >= opThresh) return "operational";
  if (pct >= degThresh) return "degraded";
  return "outage";
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Build a list of YYYY-MM-DD strings, oldest first, length=days, ending YESTERDAY (UTC). */
function buildDaySeries(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  // Start at yesterday so we don't include the partial current UTC day in
  // the historical roll-up. "Right now" is captured by `realtime` instead.
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() - days);
  for (let i = 0; i < days; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    out.push(dayKey(cursor));
  }
  return out;
}

function worstStatus(a: CategoryStatus, b: CategoryStatus): CategoryStatus {
  const order: Record<CategoryStatus, number> = { operational: 0, degraded: 1, outage: 2 };
  return order[a] >= order[b] ? a : b;
}

// ─── Per-category daily computations ──────────────────────────────

interface FeedDayRow {
  day: string;
  success_pulls: number;
  total_pulls: number;
  records: number;
}

async function computeFeedsDaily(env: Env, days: string[]): Promise<DailyPoint[]> {
  // Pull successful-pull and records-ingested counts per day across the
  // entire ingest path. Enrichment feeds are excluded — their separate
  // `runAllEnrichmentFeeds` code path stayed up during the 50cb1e4
  // blackout, so including them would have masked the outage entirely.
  const earliest = days[0]!;

  const rows = await env.DB.prepare(`
    SELECT date(fph.started_at) AS day,
           SUM(CASE WHEN fph.status = 'success' THEN 1 ELSE 0 END) AS success_pulls,
           COUNT(*) AS total_pulls,
           COALESCE(SUM(CASE WHEN fph.status = 'success' THEN fph.records_ingested END), 0) AS records
      FROM feed_pull_history fph
      LEFT JOIN feed_configs fc ON fc.feed_name = fph.feed_name
     WHERE fph.started_at >= ? || 'T00:00:00Z'
       AND COALESCE(fc.feed_type, 'ingest') = 'ingest'
     GROUP BY day
  `).bind(earliest).all<FeedDayRow>();

  const byDay = new Map<string, FeedDayRow>();
  for (const r of rows.results) byDay.set(r.day, r);

  // Establish a baseline from the days that DID have activity. Median is
  // robust to single-day spikes (e.g. urlhaus dumping 1000 fresh IOCs on
  // its weekly catch-up).
  const successCounts = rows.results.map(r => r.success_pulls).filter(n => n > 0);
  const recordCounts = rows.results.map(r => r.records).filter(n => n > 0);
  const baselineSuccess = median(successCounts) || 1;
  const baselineRecords = median(recordCounts) || 1;

  return days.map(day => {
    const row = byDay.get(day);
    if (!row || row.success_pulls === 0) {
      return {
        date: day,
        status: "outage" as const,
        uptime_pct: 0,
        note: "no successful ingest pulls",
      };
    }
    // Take the worse of pulls-vs-baseline and records-vs-baseline. Pulls
    // catches "code path broken" (50cb1e4); records catches "feeds returning
    // empty bodies" (the feodo JSON regression).
    const pullsUptime = clamp((row.success_pulls / baselineSuccess) * 100, 0, 100);
    const recordsUptime = clamp((row.records / baselineRecords) * 100, 0, 100);
    const uptime = Math.min(pullsUptime, recordsUptime);
    const status = classify(uptime, FEEDS_OPERATIONAL, FEEDS_DEGRADED);
    let note: string | undefined;
    if (status !== "operational") {
      note = recordsUptime < pullsUptime
        ? `records ${Math.round(recordsUptime)}% of baseline`
        : `pulls ${Math.round(pullsUptime)}% of baseline`;
    }
    return { date: day, status, uptime_pct: Math.round(uptime), ...(note ? { note } : {}) };
  });
}

interface AgentDayRow {
  day: string;
  total_runs: number;
  successes: number;
}

async function computeAgentsDaily(env: Env, days: string[]): Promise<DailyPoint[]> {
  const earliest = days[0]!;
  const rows = await env.DB.prepare(`
    SELECT date(started_at) AS day,
           COUNT(*) AS total_runs,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes
      FROM agent_runs
     WHERE started_at >= ?
     GROUP BY day
  `).bind(earliest).all<AgentDayRow>();

  const byDay = new Map<string, AgentDayRow>();
  for (const r of rows.results) byDay.set(r.day, r);

  return days.map(day => {
    const row = byDay.get(day);
    if (!row || row.total_runs === 0) {
      return { date: day, status: "outage" as const, uptime_pct: 0, note: "no agent runs" };
    }
    const uptime = (row.successes / row.total_runs) * 100;
    const status = classify(uptime, AGENTS_OPERATIONAL, AGENTS_DEGRADED);
    return {
      date: day,
      status,
      uptime_pct: Math.round(uptime),
      ...(status !== "operational"
        ? { note: `${row.total_runs - row.successes}/${row.total_runs} runs failed` }
        : {}),
    };
  });
}

interface ProcessingDayRow {
  day: string;
  navigator_runs: number;
  fc_runs: number;
  sentinel_runs: number;
}

// Expected daily counts derived from the cron schedule in CLAUDE.md §6.
// If we change the cron cadence (e.g. lengthen FC), update both places.
const EXPECTED_NAVIGATOR_PER_DAY = 288; // every 5 min
const EXPECTED_FC_PER_DAY = 24; // hourly
const EXPECTED_SENTINEL_PER_DAY = 12; // every 2 h (orchestrator-driven)

async function computeProcessingDaily(env: Env, days: string[]): Promise<DailyPoint[]> {
  // Processing health is a proxy for "can the worker write to D1 on each
  // expected cron tick?". If D1 is unhealthy or the worker is failing to
  // start, every cron's row count drops. If a single cron breaks, only
  // that counter drops. Both surface here.
  //
  // Navigator's historical agent_id was 'fast_tick' (per CLAUDE.md §6).
  const earliest = days[0]!;
  const rows = await env.DB.prepare(`
    SELECT date(started_at) AS day,
           SUM(CASE WHEN agent_id IN ('navigator', 'fast_tick') THEN 1 ELSE 0 END) AS navigator_runs,
           SUM(CASE WHEN agent_id = 'flight_control' THEN 1 ELSE 0 END) AS fc_runs,
           SUM(CASE WHEN agent_id = 'sentinel' THEN 1 ELSE 0 END) AS sentinel_runs
      FROM agent_runs
     WHERE started_at >= ?
     GROUP BY day
  `).bind(earliest).all<ProcessingDayRow>();

  const byDay = new Map<string, ProcessingDayRow>();
  for (const r of rows.results) byDay.set(r.day, r);

  return days.map(day => {
    const row = byDay.get(day);
    if (!row) {
      return { date: day, status: "outage" as const, uptime_pct: 0, note: "no cron writes" };
    }
    const navPct = clamp((row.navigator_runs / EXPECTED_NAVIGATOR_PER_DAY) * 100, 0, 100);
    const fcPct = clamp((row.fc_runs / EXPECTED_FC_PER_DAY) * 100, 0, 100);
    const sentinelPct = clamp((row.sentinel_runs / EXPECTED_SENTINEL_PER_DAY) * 100, 0, 100);
    const uptime = (navPct + fcPct + sentinelPct) / 3;
    const status = classify(uptime, PROCESSING_OPERATIONAL, PROCESSING_DEGRADED);
    let note: string | undefined;
    if (status !== "operational") {
      const worst = [
        { name: "navigator", pct: navPct },
        { name: "flight_control", pct: fcPct },
        { name: "sentinel", pct: sentinelPct },
      ].sort((a, b) => a.pct - b.pct)[0]!;
      note = `${worst.name} ${Math.round(worst.pct)}% of expected`;
    }
    return { date: day, status, uptime_pct: Math.round(uptime), ...(note ? { note } : {}) };
  });
}

// ─── Realtime (last 6h) per-category checks ───────────────────────

// Tunable absolute thresholds for the 6h ingest-feeds check. Ground truth
// from the 50cb1e4 outage:
//   normal day  → 200+ successful ingest pulls / 24h → ~50 / 6h
//   outage day  →   ~0 successful ingest pulls / 24h →   0 / 6h
// Anything < 5 in 6h is unambiguously broken. 5–20 is degraded.
const FEEDS_REALTIME_OPERATIONAL_PULLS = 20;
const FEEDS_REALTIME_DEGRADED_PULLS = 5;

interface RealtimeFeedsRow { success_pulls: number; records: number }

async function computeFeedsRealtime(env: Env): Promise<{ status: CategoryStatus; note: string }> {
  const row = await env.DB.prepare(`
    SELECT SUM(CASE WHEN fph.status = 'success' THEN 1 ELSE 0 END) AS success_pulls,
           COALESCE(SUM(CASE WHEN fph.status = 'success' THEN fph.records_ingested END), 0) AS records
      FROM feed_pull_history fph
      LEFT JOIN feed_configs fc ON fc.feed_name = fph.feed_name
     WHERE fph.started_at >= datetime('now', '-6 hours')
       AND COALESCE(fc.feed_type, 'ingest') = 'ingest'
  `).first<RealtimeFeedsRow>();

  const successPulls = row?.success_pulls ?? 0;
  if (successPulls === 0) {
    return { status: "outage", note: "no successful ingest pulls in 6h" };
  }
  if (successPulls < FEEDS_REALTIME_DEGRADED_PULLS) {
    return { status: "outage", note: `only ${successPulls} ingest pulls in 6h` };
  }
  if (successPulls < FEEDS_REALTIME_OPERATIONAL_PULLS) {
    return { status: "degraded", note: `${successPulls} ingest pulls in 6h (low)` };
  }
  return { status: "operational", note: `${successPulls} ingest pulls in 6h` };
}

async function computeAgentsRealtime(env: Env): Promise<{ status: CategoryStatus; note: string }> {
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes
      FROM agent_runs
     WHERE started_at >= datetime('now', '-6 hours')
  `).first<{ total: number; successes: number }>();

  const total = row?.total ?? 0;
  const successes = row?.successes ?? 0;
  if (total === 0) {
    return { status: "outage", note: "no agent runs in 6h" };
  }
  const uptime = (successes / total) * 100;
  const status = classify(uptime, AGENTS_OPERATIONAL, AGENTS_DEGRADED);
  return {
    status,
    note: status === "operational"
      ? `${successes}/${total} runs succeeded in 6h`
      : `${total - successes}/${total} runs failed in 6h`,
  };
}

async function computeProcessingRealtime(env: Env): Promise<{ status: CategoryStatus; note: string }> {
  // 6h expected: nav 72, fc 6, sentinel 3
  const row = await env.DB.prepare(`
    SELECT SUM(CASE WHEN agent_id IN ('navigator', 'fast_tick') THEN 1 ELSE 0 END) AS navigator_runs,
           SUM(CASE WHEN agent_id = 'flight_control' THEN 1 ELSE 0 END) AS fc_runs,
           SUM(CASE WHEN agent_id = 'sentinel' THEN 1 ELSE 0 END) AS sentinel_runs
      FROM agent_runs
     WHERE started_at >= datetime('now', '-6 hours')
  `).first<{ navigator_runs: number; fc_runs: number; sentinel_runs: number }>();

  const nav = row?.navigator_runs ?? 0;
  const fc = row?.fc_runs ?? 0;
  const sentinel = row?.sentinel_runs ?? 0;
  const navPct = clamp((nav / 72) * 100, 0, 100);
  const fcPct = clamp((fc / 6) * 100, 0, 100);
  const sentinelPct = clamp((sentinel / 3) * 100, 0, 100);
  const uptime = (navPct + fcPct + sentinelPct) / 3;
  const status = classify(uptime, PROCESSING_OPERATIONAL, PROCESSING_DEGRADED);
  if (status === "operational") {
    return { status, note: `nav=${nav}, fc=${fc}, sentinel=${sentinel} in 6h` };
  }
  const worst = [
    { name: "navigator", pct: navPct, actual: nav, expected: 72 },
    { name: "flight_control", pct: fcPct, actual: fc, expected: 6 },
    { name: "sentinel", pct: sentinelPct, actual: sentinel, expected: 3 },
  ].sort((a, b) => a.pct - b.pct)[0]!;
  return {
    status,
    note: `${worst.name} ${worst.actual}/${worst.expected} expected in 6h`,
  };
}

// ─── Public entry point ───────────────────────────────────────────

export interface ComputeOptions {
  /** Defaults to 30. */
  windowDays?: number;
  /** Inject a clock for tests. */
  now?: Date;
}

export async function computePlatformStatus(
  env: Env,
  options: ComputeOptions = {},
): Promise<PlatformStatus> {
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? new Date();
  const days = buildDaySeries(windowDays, now);

  // Each category query is independent — issue them in parallel.
  const [feedsDaily, agentsDaily, processingDaily] = await Promise.all([
    computeFeedsDaily(env, days),
    computeAgentsDaily(env, days),
    computeProcessingDaily(env, days),
  ]);

  const [feedsRT, agentsRT, processingRT] = await Promise.all([
    computeFeedsRealtime(env),
    computeAgentsRealtime(env),
    computeProcessingRealtime(env),
  ]);

  const buildRollup = (
    category: CategoryKey,
    daily: DailyPoint[],
    realtime: { status: CategoryStatus; note: string },
  ): CategoryRollup => {
    const last = daily[daily.length - 1]!;
    const uptime30 = daily.reduce((s, d) => s + d.uptime_pct, 0) / daily.length;
    return {
      category,
      current: last.status,
      uptime_30d_pct: Math.round(uptime30 * 10) / 10,
      daily,
      realtime: realtime.status,
      realtime_note: realtime.note,
    };
  };

  const rollups: CategoryRollup[] = [
    buildRollup("feeds", feedsDaily, feedsRT),
    buildRollup("agents", agentsDaily, agentsRT),
    buildRollup("processing", processingDaily, processingRT),
  ];

  const overall = rollups
    .map(r => r.realtime)
    .reduce<CategoryStatus>((worst, s) => worstStatus(worst, s), "operational");

  const overallNote = overall === "operational"
    ? "All systems operational"
    : rollups
        .filter(r => r.realtime !== "operational")
        .map(r => `${r.category}: ${r.realtime_note}`)
        .join("; ");

  return {
    generated_at: new Date().toISOString(),
    overall,
    overall_note: overallNote,
    categories: rollups,
    window_days: windowDays,
  };
}
