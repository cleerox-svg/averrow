// Averrow — Incident auto-resolve / recovery
//
// Hourly check (called from orchestrator) that promotes auto-created
// incidents from `investigating` / `identified` to `monitoring` once
// their underlying symptom has cleared. The operator confirms
// `resolved` manually — per planning thread, we don't auto-close so
// flapping signals can't prematurely retire an incident that's still
// causing customer impact.
//
// Recovery signal per affected_components slug:
//   feed:<name>          — successful pull in feed_pull_history within
//                          the last hour
//   agent:<name>         — successful run in agent_runs within the
//                          last hour
//   category:feeds       — platform_status.feeds.realtime = operational
//   category:agents      — platform_status.agents.realtime = operational
//   category:processing  — platform_status.processing.realtime = operational
//   system:* / unknown   — skip (no automated signal yet — operator
//                          must close manually)
//
// An incident is considered recovered when EVERY relevant component
// has cleared. Mixed signals (feeds OK, agents still failing) keep
// the incident in its current state.

import type { Env } from "../types";
import { computePlatformStatus } from "./platform-status";
import { appendSystemUpdate, transitionStatus, type IncidentRow } from "./incidents";
import type { CategoryStatus } from "@averrow/shared";

interface RecoveryCheckResult {
  /** Incidents we transitioned to monitoring this run. */
  recovered: number;
  /** Incidents we evaluated but signals were still bad. */
  stillFailing: number;
  /** Incidents we skipped (manual source, only-skip components, etc.). */
  skipped: number;
}

const RECOVERY_WINDOW_MINUTES = 60;

/**
 * Walks all open auto-created incidents and promotes the recovered
 * ones to `monitoring`. Wrapped + best-effort — the orchestrator
 * tick must not fail if this throws.
 */
export async function runIncidentRecoverySweep(env: Env): Promise<RecoveryCheckResult> {
  const result: RecoveryCheckResult = { recovered: 0, stillFailing: 0, skipped: 0 };

  // Only auto-created, not-yet-resolved, not-yet-monitoring. Once an
  // incident hits `monitoring` the operator owns the close decision —
  // we don't keep nudging.
  const open = await env.DB.prepare(
    `SELECT * FROM incidents
      WHERE source LIKE 'auto:%'
        AND status IN ('investigating', 'identified')
      ORDER BY created_at ASC`,
  ).all<IncidentRow>();

  if (open.results.length === 0) return result;

  // Compute platform status once and reuse for category-level checks
  // — every incident with a category:* component lands here.
  let platformStatus: Awaited<ReturnType<typeof computePlatformStatus>> | null = null;
  try {
    platformStatus = await computePlatformStatus(env);
  } catch {
    platformStatus = null;
  }

  for (const incident of open.results) {
    try {
      const verdict = await evaluateRecovery(env, incident, platformStatus);
      if (verdict.recovered) {
        await transitionStatus(env, incident.id, "monitoring");
        await appendSystemUpdate(env, {
          incidentId: incident.id,
          message: `Auto-promoted to monitoring — ${verdict.reason}. Operator: confirm resolved when stable.`,
          eventType: "status_transition",
        });
        result.recovered++;
      } else if (verdict.evaluated) {
        result.stillFailing++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      // Per-incident failure must not break the sweep.
      console.error(
        `[incidentRecovery] ${incident.id} evaluation failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

interface RecoveryVerdict {
  /** True if every relevant component has recovered. */
  recovered: boolean;
  /** True if at least one component had a checkable signal — false
   *  means the incident is purely manual-close (no auto-resolve). */
  evaluated: boolean;
  /** Operator-friendly summary for the timeline message. */
  reason: string;
}

async function evaluateRecovery(
  env: Env,
  incident: IncidentRow,
  platformStatus: Awaited<ReturnType<typeof computePlatformStatus>> | null,
): Promise<RecoveryVerdict> {
  const components = parseComponents(incident.affected_components);
  if (components.length === 0) {
    return { recovered: false, evaluated: false, reason: "no affected_components" };
  }

  const checks: Array<{ component: string; ok: boolean | "skipped"; detail: string }> = [];

  for (const slug of components) {
    if (slug.startsWith("feed:")) {
      const feedName = slug.slice(5);
      const ok = await feedRecovered(env, feedName);
      checks.push({ component: slug, ok, detail: ok ? `${feedName} pulled` : `${feedName} silent` });
    } else if (slug.startsWith("agent:")) {
      const agentId = slug.slice(6);
      const ok = await agentRecovered(env, agentId);
      checks.push({ component: slug, ok, detail: ok ? `${agentId} healthy` : `${agentId} failing` });
    } else if (slug === "category:feeds") {
      const ok = categoryRecovered(platformStatus, "feeds");
      checks.push({ component: slug, ok, detail: detailForCategory(platformStatus, "feeds") });
    } else if (slug === "category:agents") {
      const ok = categoryRecovered(platformStatus, "agents");
      checks.push({ component: slug, ok, detail: detailForCategory(platformStatus, "agents") });
    } else if (slug === "category:processing") {
      const ok = categoryRecovered(platformStatus, "processing");
      checks.push({ component: slug, ok, detail: detailForCategory(platformStatus, "processing") });
    } else {
      // system:resend, unknown slugs — no automated signal yet. Skip
      // means we don't promote; operator owns this one.
      checks.push({ component: slug, ok: "skipped", detail: "no auto-resolve signal" });
    }
  }

  const checkable = checks.filter((c) => c.ok !== "skipped");
  if (checkable.length === 0) {
    return { recovered: false, evaluated: false, reason: "all components manual-close" };
  }

  const allClear = checkable.every((c) => c.ok === true);
  if (allClear) {
    const summary = checkable.map((c) => c.detail).join("; ");
    return { recovered: true, evaluated: true, reason: summary };
  }

  const failing = checkable.filter((c) => c.ok === false).map((c) => c.detail).join("; ");
  return { recovered: false, evaluated: true, reason: `still failing: ${failing}` };
}

function parseComponents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

async function feedRecovered(env: Env, feedName: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM feed_pull_history
      WHERE feed_name = ?
        AND status = 'success'
        AND started_at >= datetime('now', '-' || ? || ' minutes')
      LIMIT 1`,
  ).bind(feedName, RECOVERY_WINDOW_MINUTES).first<{ ok: number }>();
  return !!row;
}

async function agentRecovered(env: Env, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM agent_runs
      WHERE agent_id = ?
        AND status = 'success'
        AND started_at >= datetime('now', '-' || ? || ' minutes')
      LIMIT 1`,
  ).bind(agentId, RECOVERY_WINDOW_MINUTES).first<{ ok: number }>();
  return !!row;
}

function categoryRecovered(
  status: Awaited<ReturnType<typeof computePlatformStatus>> | null,
  category: "feeds" | "agents" | "processing",
): boolean {
  if (!status) return false;
  const cat = status.categories.find((c) => c.category === category);
  return cat?.realtime === ("operational" as CategoryStatus);
}

function detailForCategory(
  status: Awaited<ReturnType<typeof computePlatformStatus>> | null,
  category: "feeds" | "agents" | "processing",
): string {
  if (!status) return `${category}: no status data`;
  const cat = status.categories.find((c) => c.category === category);
  if (!cat) return `${category}: no rollup`;
  return `${category}: ${cat.realtime} (${cat.realtime_note})`;
}
