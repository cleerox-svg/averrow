// Averrow — Admin handlers: dashboard
// Split from handlers/admin.ts (S3.4a). Behavior-preserving move.

import { z } from "zod";
import { json, corsHeaders } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env, UserRole, UserStatus } from "../../types";
import { runSyncAgent } from "../../lib/agentRunner";
import { adminClassifyAgent, type AdminClassifyOutput } from "../../agents/admin-classify";
import { callAnthropicJSON } from "../../lib/anthropic";
import { estimateCost } from "../../lib/budgetManager";
import { HOT_PATH_HAIKU } from "../../lib/ai-models";
import { enrichThreatsGeo, PRIVATE_IP_SQL_FILTER } from "../../lib/geoip";
import { fuzzyMatchBrand } from "../../lib/brandDetect";
import { cachedCount } from "../../lib/cached-count";
import { cachedValue } from "../../lib/cached-value";
import { getReadSession, getDbContext } from "../../lib/db";
import { computeFeedSeverity } from "../../lib/feed-severity";
import type { AuthContext } from "../../middleware/auth";
import { classifySaasTechnique } from "../../lib/saas-classifier";
import { BudgetManager, type BudgetStatus } from "../../lib/budgetManager";
import {
  buildGeoCubeForHour,
  buildProviderCubeForHour,
  buildBrandCubeForHour,
  buildStatusCubeForHour,
  buildArcsCubeForHour,
  countGeoCubeForHour,
  countProviderCubeForHour,
  countBrandCubeForHour,
  countStatusCubeForHour,
  countArcsCubeForHour,
} from "../../lib/cube-builder";
import { handleSystemHealth } from "./health";
import { handlePipelineStatus } from "./pipeline";
import { handleMetricsFeedFailures } from "./metrics";


// ─── Admin Dashboard Snapshot (P5 — Tier 2a) ─────────────────────
//
// GET /api/admin/dashboard
//
// ONE KV-cached composite the /admin LANDING reads instead of fanning
// out to ~6 independently-cached endpoints. Composes the slices the
// landing + VerdictBand need by REUSING the existing handlers'
// internals (each is already KV-cached), exactly like handleD1Budget
// composes the diagnostics helpers.
//
// Contract rules:
//   - Each slice is INDEPENDENTLY NULLABLE. A partial failure of any
//     source degrades that slice to `null` — never a thrown 500. The
//     frontend treats a null slice as "unknown", never "healthy".
//   - Additive: this does NOT replace the underlying endpoints; they
//     keep serving their still-live consumers unchanged.
//   - The composite does no direct D1 — it only calls sub-handlers
//     that read replicas / cubes / pre-computed columns / KV per §8.

/** Threat totals + 24h agent/feed health + 14d trend. Source: handleSystemHealth. */
export interface DashboardThreatHealthSlice {
  threats: { total: number; today: number; week: number };
  agents_24h: { total: number; successes: number; errors: number };
  feeds_24h: { pulls: number; ingested: number };
  active_sessions: number;
  trend_14d: Array<{ day: string; count: number }>;
}

/** Budget status + top spenders. Source: handleBudgetStatus + handleBudgetBreakdown. */
export interface DashboardBudgetSlice {
  status: BudgetStatus;
  top_agents: Array<{ agent_id: string; cost_usd: number; calls: number }>;
}

/** Feeds needing attention. Source: handleMetricsFeedFailures.
 *
 * `at_risk` mirrors the `feedRiskTier` split that the Tier-1 VerdictBand
 * computed client-side (metrics/FeedFailures.tsx), so the band's feeds
 * contributor reads the same signal it always did:
 *   - a feed AUTO-paused from consecutive failures
 *     (`paused_reason === 'auto:consecutive_failures'`) → `critical`,
 *     EVEN THOUGH `enabled === 0`. This is the core "OPERATIONAL while a
 *     feed is dead" guard — a dead feed must escalate, not be dropped.
 *   - `>= 80%` to auto-pause / high failure rate → `critical`
 *   - `60-79%` to auto-pause / failing → `high`
 * MANUALLY paused/disabled feeds (any other `paused_reason`, or an orphan
 * with no config row) are operator intent, NOT a health signal — they are
 * excluded so the band stays OPERATIONAL for a deliberately-disabled feed.
 */
export interface DashboardFeedsSlice {
  at_risk_count: number;
  at_risk: Array<{
    feed_name: string;
    display_name: string;
    /** Pre-computed tier so the frontend maps directly (no re-derivation
     *  from verdict labels). 'critical' = auto-paused-from-failures or
     *  >=80% to auto-pause / high failure rate; 'high' = 60-79% or failing. */
    severity: 'critical' | 'high';
    verdict: { tone: string; label: string };
    failure_rate_pct: number;
    pct_to_auto_pause: number;
    enabled: boolean;
    /** `feed_configs.paused_reason`; 'auto:consecutive_failures' marks a
     *  feed that died from failures (distinct from an operator pause). */
    paused_reason: string | null;
  }>;
  totals_24h: {
    total_pulls: number;
    total_success: number;
    total_failed: number;
    feeds_active: number;
  };
}

/** Pipeline health signal. Source: handlePipelineStatus.
 *
 * `worst_tone` reflects ONLY genuine pipeline problems: a real backlog that
 * is GROWING (tone 'failed' → 'critical') or STALE/unmeasured (tone
 * 'pending' → 'warning'), or a reference dataset that is genuinely
 * EMPTY/FAILED (tone 'failed' → 'critical'). The GeoIP reference dataset's
 * BENIGN states — SETUP (an OPTIONAL binding that may be permanently
 * unconfigured), REFRESHING, and STALE 7-14d (all tone 'pending') — do NOT
 * degrade the band, so an env where GeoIP is a non-problem still reads
 * green. `needs_attention_count` counts exactly the pipelines that drive
 * `worst_tone`, and each `concerning` row carries a `severity` so the
 * frontend renders a neutral "N pipelines need attention" without forcing
 * "growing/stale" wording onto a non-backlog dataset. */
export interface DashboardPipelineSlice {
  worst_tone: "critical" | "warning" | "ok" | "unknown";
  needs_attention_count: number;
  total_pipelines: number;
  concerning: Array<{
    id: string;
    label: string;
    severity: "critical" | "warning";
    verdict: { tone: string; label: string };
    trend_direction: string;
    count: number;
  }>;
}

/** Email-security posture summary. Source: handleEmailSecurityStats. */
export interface DashboardEmailSecuritySlice {
  total_scanned: number;
  total_unscanned: number;
  average_score: number;
  grade_distribution: Array<{ grade: string; count: number }>;
  worst_count: number;
}

export interface DashboardSnapshot {
  threat_health: DashboardThreatHealthSlice | null;
  budget: DashboardBudgetSlice | null;
  feeds: DashboardFeedsSlice | null;
  pipeline: DashboardPipelineSlice | null;
  email_security: DashboardEmailSecuritySlice | null;
  generated_at: string;
}

/** Base key for the two role-scoped dashboard-snapshot KV entries
 *  (`:sa` for super_admin, `:admin` for plain admin). Exported so
 *  mutation handlers that invalidate the snapshot (e.g. budget config
 *  patch in handlers/budget.ts) reference the SAME string instead of
 *  re-typing it. See `dashboardSnapshotCacheKeys()`. */
export const DASHBOARD_SNAPSHOT_CACHE_KEY = "admin:dashboard_snapshot:v1";

/** Both role-scoped snapshot cache keys — the complete set a writer must
 *  bust to fully invalidate the composite for every audience. */
export function dashboardSnapshotCacheKeys(): [string, string] {
  return [`${DASHBOARD_SNAPSHOT_CACHE_KEY}:sa`, `${DASHBOARD_SNAPSHOT_CACHE_KEY}:admin`];
}
const DASHBOARD_SNAPSHOT_TTL = 75; // ~60-90s window per spec

/** Parse a sub-handler's `{ success?, data }` body into its `data`,
 *  degrading any non-ok / `success:false` / parse failure to null. */
async function readSnapshotSlice<T>(res: Response): Promise<T | null> {
  try {
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: unknown };
    if (body && body.success === false) return null;
    return (body?.data ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Call a sub-handler and shape its data, swallowing any throw to null. */
async function snapshotSlice<TRaw, TOut>(
  produce: () => Promise<Response>,
  shape: (raw: TRaw) => TOut | null,
): Promise<TOut | null> {
  try {
    const raw = await readSnapshotSlice<TRaw>(await produce());
    return raw === null ? null : shape(raw);
  } catch {
    return null;
  }
}

export async function handleAdminDashboard(
  request: Request,
  env: Env,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  // RBAC boundary: the `threat_health` slice reuses handleSystemHealth,
  // whose own route (/api/admin/system-health) is requireSuperAdmin. This
  // composite is only requireAdmin, so including threat_health for a plain
  // admin would widen that boundary. Gate the slice to super_admin; plain
  // admins get threat_health: null (the contract makes every slice
  // nullable and the frontend reads null as "absent/unknown"). The other
  // four slices (budget/pipeline/feeds/email_security) are requireAdmin /
  // requireStaff at their own routes, so they stay for all admins.
  const includeThreatHealth = ctx.role === "super_admin";

  // Cache is keyed by whether threat_health is present so a super_admin's
  // populated slice never leaks to a plain admin via the shared cache (and
  // vice versa).
  const cacheKey = includeThreatHealth
    ? `${DASHBOARD_SNAPSHOT_CACHE_KEY}:sa`
    : `${DASHBOARD_SNAPSHOT_CACHE_KEY}:admin`;

  const cached = await env.CACHE.get(cacheKey);
  if (cached) return json(JSON.parse(cached), 200, origin);

  // Synthetic request for the sub-handlers — they only read query params
  // and route replica context off the URL, never auth (this endpoint is
  // already requireAdmin-gated at the route layer).
  //
  // SECURITY INVARIANT: every handler composed here MUST be a global,
  // unscoped platform aggregate — it must NOT read auth or per-user/org
  // scope off the request (no getOrgScope, no brand/org filtering). The
  // synthetic request carries no identity, so composing an org-scoped
  // handler would surface unscoped global data. Gate role-sensitive slices
  // explicitly (see threat_health / super_admin below), never by relying on
  // a sub-handler's own request-derived scoping.
  const syntheticReq = () => new Request("https://averrow.com/api/admin/dashboard");

  // Lazy-load the cross-file handlers (budget + email-security live in
  // sibling handler modules). System-health / feed-failures / pipeline
  // are in THIS module.
  const { handleBudgetStatus, handleBudgetBreakdown } = await import("../budget");
  const { handleEmailSecurityStats } = await import("../emailSecurity");

  type SystemHealthRaw = {
    threats: { total: number; today: number; week: number };
    agents: { total: number; successes: number; errors: number };
    feeds: { pulls: number; ingested: number };
    sessions: { count: number };
    trend: Array<{ day: string; count: number }>;
  };
  type FeedFailuresRaw = {
    totals_24h: { total_pulls: number; total_success: number; total_failed: number; feeds_active: number };
    per_feed: Array<{
      feed_name: string;
      display_name: string;
      enabled: boolean;
      // `pulls` + `paused_reason` are needed to replicate FeedFailures.tsx's
      // feedRiskTier: pulls gates the failure-rate tier, and paused_reason
      // distinguishes an auto-pause-from-failures (a signal) from an
      // operator pause/disable (not a signal).
      pulls: number;
      paused_reason: string | null;
      failure_rate_pct: number;
      pct_to_auto_pause: number;
      verdict: { tone: string; label: string };
    }>;
  };
  type PipelineRaw = Array<{
    id: string;
    label: string;
    verdict: { tone: string; label: string };
    trend_direction: string;
    count: number;
  }>;
  type EmailRaw = {
    total_scanned: number;
    total_unscanned: number;
    average_score: number;
    grade_distribution: Array<{ grade: string; count: number }>;
    worst_brands: unknown[];
  };
  type BreakdownRaw = Array<{ agent_id: string; cost_usd: number; calls: number }>;

  // Super_admin only: skip the work entirely for plain admins — don't
  // compute-then-null, just never call handleSystemHealth.
  const threatHealthPromise: Promise<DashboardThreatHealthSlice | null> = includeThreatHealth
    ? snapshotSlice<SystemHealthRaw, DashboardThreatHealthSlice>(
        () => handleSystemHealth(syntheticReq(), env),
        (sh) => ({
          threats: sh.threats,
          agents_24h: sh.agents,
          feeds_24h: sh.feeds,
          active_sessions: sh.sessions?.count ?? 0,
          trend_14d: sh.trend ?? [],
        }),
      )
    : Promise.resolve(null);

  const [threatHealth, budgetStatus, budgetBreakdown, feeds, pipeline, emailSecurity] = await Promise.all([
    threatHealthPromise,
    // Budget is a two-source slice: status is the core, breakdown augments.
    snapshotSlice<BudgetStatus, BudgetStatus>(
      () => handleBudgetStatus(syntheticReq(), env),
      (s) => s,
    ),
    snapshotSlice<BreakdownRaw, BreakdownRaw>(
      () => handleBudgetBreakdown(syntheticReq(), env),
      (b) => b,
    ),
    snapshotSlice<FeedFailuresRaw, DashboardFeedsSlice>(
      () => handleMetricsFeedFailures(syntheticReq(), env),
      (ff) => {
        // Replicate FeedFailures.tsx's feedRiskTier so the band's feeds
        // contributor reads the SAME signal it did pre-Tier-2a. An
        // AUTO-paused feed (died from consecutive failures) is `enabled=0`
        // but must escalate to critical — this is the "OPERATIONAL while a
        // feed is dead" guard. A MANUALLY paused/disabled feed (any other
        // paused_reason, or an orphan) is operator intent → not a signal.
        const scored = ff.per_feed
          .map((f) => ({ f, severity: computeFeedSeverity(f) }))
          .filter((x): x is { f: FeedFailuresRaw["per_feed"][number]; severity: "critical" | "high" } => x.severity !== null)
          // Critical first, then closest-to-auto-pause, so the 20-cap keeps
          // the worst rows even if the source ordering buried a PAUSED row.
          .sort((a, b) => {
            if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
            if (b.f.pct_to_auto_pause !== a.f.pct_to_auto_pause) return b.f.pct_to_auto_pause - a.f.pct_to_auto_pause;
            return b.f.failure_rate_pct - a.f.failure_rate_pct;
          });
        return {
          at_risk_count: scored.length,
          at_risk: scored.slice(0, 20).map(({ f, severity }) => ({
            feed_name: f.feed_name,
            display_name: f.display_name,
            severity,
            verdict: f.verdict,
            failure_rate_pct: f.failure_rate_pct,
            pct_to_auto_pause: f.pct_to_auto_pause,
            enabled: f.enabled,
            paused_reason: f.paused_reason,
          })),
          totals_24h: {
            total_pulls: ff.totals_24h.total_pulls,
            total_success: ff.totals_24h.total_success,
            total_failed: ff.totals_24h.total_failed,
            feeds_active: ff.totals_24h.feeds_active,
          },
        };
      },
    ),
    snapshotSlice<PipelineRaw, DashboardPipelineSlice>(
      () => handlePipelineStatus(syntheticReq(), env),
      (pipes) => {
        // The GeoIP row is a synthetic REFERENCE dataset (not a draining
        // backlog). Its benign states — SETUP (an OPTIONAL binding, so it
        // can be permanently unconfigured), REFRESHING, STALE 7-14d — all
        // carry tone 'pending' and must NOT degrade the band. Only a
        // genuinely broken reference dataset (EMPTY / FAILED / STALE>14d,
        // all tone 'failed') is a real problem. Real backlogs escalate on
        // tone 'failed' (GROWING → critical) and tone 'pending' (STALE /
        // unmeasured → warning). Everything else is not a signal.
        const REFERENCE_PIPELINE_IDS = new Set(["geoip"]);
        const problemSeverity = (p: PipelineRaw[number]): "critical" | "warning" | null => {
          const tone = p.verdict.tone;
          if (REFERENCE_PIPELINE_IDS.has(p.id)) {
            return tone === "failed" ? "critical" : null;
          }
          if (tone === "failed") return "critical";
          if (tone === "pending") return "warning";
          return null;
        };
        const problems = pipes
          .map((p) => ({ p, severity: problemSeverity(p) }))
          .filter((x): x is { p: PipelineRaw[number]; severity: "critical" | "warning" } => x.severity !== null);
        const worst_tone: DashboardPipelineSlice["worst_tone"] =
          pipes.length === 0
            ? "unknown"
            : problems.some((x) => x.severity === "critical")
              ? "critical"
              : problems.some((x) => x.severity === "warning")
                ? "warning"
                : "ok";
        return {
          worst_tone,
          needs_attention_count: problems.length,
          total_pipelines: pipes.length,
          concerning: problems.slice(0, 20).map(({ p, severity }) => ({
            id: p.id,
            label: p.label,
            severity,
            verdict: p.verdict,
            trend_direction: p.trend_direction,
            count: p.count,
          })),
        };
      },
    ),
    snapshotSlice<EmailRaw, DashboardEmailSecuritySlice>(
      () => handleEmailSecurityStats(syntheticReq(), env),
      (es) => ({
        total_scanned: es.total_scanned,
        total_unscanned: es.total_unscanned,
        average_score: es.average_score,
        grade_distribution: es.grade_distribution ?? [],
        worst_count: Array.isArray(es.worst_brands) ? es.worst_brands.length : 0,
      }),
    ),
  ]);

  const budget: DashboardBudgetSlice | null = budgetStatus
    ? { status: budgetStatus, top_agents: (budgetBreakdown ?? []).slice(0, 8) }
    : null;

  const snapshot: DashboardSnapshot = {
    threat_health: threatHealth,
    budget,
    feeds,
    pipeline,
    email_security: emailSecurity,
    generated_at: new Date().toISOString(),
  };

  const body = { success: true, data: snapshot };
  await env.CACHE.put(cacheKey, JSON.stringify(body), {
    expirationTtl: DASHBOARD_SNAPSHOT_TTL,
  });
  return json(body, 200, origin);
}
