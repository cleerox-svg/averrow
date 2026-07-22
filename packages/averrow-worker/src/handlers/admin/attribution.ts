// Averrow — Admin handlers: attribution
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


// ─── Attribution Backlog (PR-B from 2026-05-16 audit) ────────────
//
// GET /api/admin/agents/attribution-backlog
//
// Returns infrastructure_clusters with `actor_id IS NULL`, ordered
// by threat_count DESC. Used by the admin "Attribution Backlog"
// queue at /admin/agents/attribution-backlog where an analyst can
// see the biggest unattributed clusters and route them for human
// attribution.
//
// Background (audit finding #6):
//   - 2,334 of 2,483 clusters (94%) have no actor_id
//   - Attributor called Haiku for 1,330 of them → 1,325 returned
//     'unknown' → 0.4% resolution rate
//   - Most clusters carry 1,000+ threats — high-value evidence
//     sitting unattributed
//
// Cached 5 min in KV. Returns up to 50 clusters per call. No
// mutations — this PR is read-only surfacing; attribution-action
// endpoints come in a follow-up.
export async function handleAttributionBacklog(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);

    // v2: pagination + q search + dismissed rows excluded. TTL dropped
    // 300s → 60s so attribute/dismiss mutations surface quickly (the UI
    // also drops mutated rows optimistically).
    const cacheKey = `attribution-backlog:v2:${limit}:${offset}:${q}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json(JSON.parse(cached), 200, origin);

    // Search matches the human-visible identifiers: name, ASNs, countries.
    const like = q ? `%${q.replace(/[%_]/g, "")}%` : null;
    const listStmt = env.DB.prepare(`
        SELECT id, cluster_name, asns, countries, threat_count,
               confidence_score, status, first_detected, last_seen,
               attribution_attempted_at, nexus_brief, agent_notes
          FROM infrastructure_clusters
         WHERE actor_id IS NULL
           AND attribution_dismissed_at IS NULL${like ? " AND (cluster_name LIKE ? OR asns LIKE ? OR countries LIKE ?)" : ""}
         ORDER BY threat_count DESC
         LIMIT ? OFFSET ?
      `);
    const [rowsRes, totalsRes] = await Promise.all([
      (like ? listStmt.bind(like, like, like, limit, offset) : listStmt.bind(limit, offset)).all<{
        id: string;
        cluster_name: string | null;
        asns: string | null;
        countries: string | null;
        threat_count: number | null;
        confidence_score: number | null;
        status: string | null;
        first_detected: string | null;
        last_seen: string | null;
        attribution_attempted_at: string | null;
        nexus_brief: string | null;
        agent_notes: string | null;
      }>(),
      env.DB.prepare(`
        SELECT
          COUNT(*)                                                       AS total_clusters,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NULL
                   THEN 1 ELSE 0 END)                                    AS unattributed,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NULL
                    AND attribution_attempted_at IS NOT NULL
                   THEN 1 ELSE 0 END)                                    AS attempted_unknown,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NULL
                    AND attribution_attempted_at IS NULL
                   THEN 1 ELSE 0 END)                                    AS never_attempted,
          SUM(CASE WHEN actor_id IS NULL
                    AND attribution_dismissed_at IS NOT NULL
                   THEN 1 ELSE 0 END)                                    AS dismissed
        FROM infrastructure_clusters
      `).first<{
        total_clusters: number;
        unattributed: number;
        attempted_unknown: number;
        never_attempted: number;
        dismissed: number;
      }>(),
    ]);

    // Trim the noisier text fields to avoid bloating the payload;
    // operator drills into the cluster detail page for the full view.
    const items = (rowsRes.results ?? []).map(r => ({
      id:                       r.id,
      cluster_name:             r.cluster_name,
      asns:                     r.asns,
      countries:                r.countries,
      threat_count:             r.threat_count ?? 0,
      confidence_score:         r.confidence_score,
      status:                   r.status,
      first_detected:           r.first_detected,
      last_seen:                r.last_seen,
      attribution_attempted_at: r.attribution_attempted_at,
      nexus_brief_preview:      r.nexus_brief?.slice(0, 200) ?? null,
      agent_notes_preview:      r.agent_notes?.slice(0, 200) ?? null,
    }));

    const body = {
      success: true,
      data: {
        items,
        totals: {
          total_clusters:    totalsRes?.total_clusters    ?? 0,
          unattributed:      totalsRes?.unattributed      ?? 0,
          attempted_unknown: totalsRes?.attempted_unknown ?? 0,
          never_attempted:   totalsRes?.never_attempted   ?? 0,
          dismissed:         totalsRes?.dismissed         ?? 0,
        },
        limit,
        offset,
        generated_at: new Date().toISOString(),
      },
    };
    await env.CACHE.put(cacheKey, JSON.stringify(body), { expirationTtl: 60 });
    return json(body, 200, origin);
  } catch (err) {
    return json({
      success: false,
      error: err instanceof Error ? err.message : "An internal error occurred",
    }, 500, origin);
  }
}

// ─── Attribution actions (backlog follow-up) ─────────────────────
//
// The manual half of the attributor: a human assigns an actor to a
// cluster (or dismisses it as unattributable). Mirrors the agent's
// write pattern — set infrastructure_clusters.actor_id, then fan the
// attribution out to the cluster's threats via threat_attributions
// (source='manual', confidence='confirmed'). Dismiss stamps
// attribution_dismissed_at so the backlog stops surfacing the row.

export async function handleAttributeCluster(
  request: Request,
  env: Env,
  clusterId: string,
  adminUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!clusterId || clusterId.length > 64) {
    return json({ success: false, error: "Invalid cluster id" }, 400, origin);
  }
  const body = await request.json().catch(() => null) as { actor_id?: unknown } | null;
  const actorId = body && typeof body.actor_id === "string" ? body.actor_id.trim() : "";
  if (!actorId || actorId.length > 64) {
    return json({ success: false, error: "actor_id required" }, 400, origin);
  }

  const [cluster, actor] = await Promise.all([
    env.DB.prepare(
      "SELECT id, cluster_name FROM infrastructure_clusters WHERE id = ?",
    ).bind(clusterId).first<{ id: string; cluster_name: string | null }>(),
    env.DB.prepare(
      "SELECT id, name FROM threat_actors WHERE id = ?",
    ).bind(actorId).first<{ id: string; name: string }>(),
  ]);
  if (!cluster) return json({ success: false, error: "Cluster not found" }, 404, origin);
  if (!actor)   return json({ success: false, error: "Threat actor not found" }, 404, origin);

  await env.DB.prepare(
    `UPDATE infrastructure_clusters
        SET actor_id = ?, attribution_attempted_at = datetime('now'),
            attribution_dismissed_at = NULL
      WHERE id = ?`,
  ).bind(actorId, clusterId).run();

  // Fan out to the cluster's threats — same shape the attributor agent
  // writes, but source='manual' + confidence='confirmed' (a human said so).
  const { recordAttribution } = await import("../../lib/otx-attribution");
  const threats = await env.DB.prepare(
    "SELECT id FROM threats WHERE cluster_id = ?",
  ).bind(clusterId).all<{ id: string }>();
  let fannedOut = 0;
  for (const t of threats.results ?? []) {
    await recordAttribution(env.DB, {
      id: `tat_manual_${clusterId}_${t.id}`,
      threatId: t.id,
      actorId,
      source: "manual",
      sourcePulseId: clusterId,
      sourcePulseName: cluster.cluster_name ?? null,
      actorNameRaw: actor.name,
      confidence: "confirmed",
    });
    fannedOut++;
  }

  await audit(env, {
    action: "cluster_attributed",
    userId: adminUserId,
    resourceType: "infrastructure_cluster",
    resourceId: clusterId,
    details: { actor_id: actorId, actor_name: actor.name, threats_fanned_out: fannedOut },
    request,
  });

  return json({
    success: true,
    data: { cluster_id: clusterId, actor_id: actorId, actor_name: actor.name, threats_fanned_out: fannedOut },
  }, 200, origin);
}

export async function handleDismissClusterAttribution(
  request: Request,
  env: Env,
  clusterId: string,
  adminUserId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!clusterId || clusterId.length > 64) {
    return json({ success: false, error: "Invalid cluster id" }, 400, origin);
  }
  const res = await env.DB.prepare(
    `UPDATE infrastructure_clusters
        SET attribution_dismissed_at = datetime('now')
      WHERE id = ? AND actor_id IS NULL`,
  ).bind(clusterId).run();
  if ((res.meta?.changes ?? 0) === 0) {
    return json({ success: false, error: "Cluster not found (or already attributed)" }, 404, origin);
  }

  await audit(env, {
    action: "cluster_attribution_dismissed",
    userId: adminUserId,
    resourceType: "infrastructure_cluster",
    resourceId: clusterId,
    details: {},
    request,
  });

  return json({ success: true, data: { cluster_id: clusterId, dismissed: true } }, 200, origin);
}

