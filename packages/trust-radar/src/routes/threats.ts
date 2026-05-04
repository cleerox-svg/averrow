import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, requireAdmin, isAuthContext, getOrgScope } from "../middleware/auth";
import { rateLimitCustom } from "../middleware/rateLimit";
import {
  handleListThreats, handleThreatStats, handleGetThreat, handleUpdateThreat,
  handleListBriefings, handleGetBriefing, handleListSocialIOCs, handleEnrichGeo,
  handleEnrichAll, handleDailySnapshots, handleGeoClusters, handleAttackFlows,
  handleRecentThreats,
} from "../handlers/threats";
import { handleCorrelations } from "../handlers/correlations";
import { handleThreatInflow } from "../handlers/threat-inflow";
import { handleGenerateBriefing, handleLatestBriefing, handleListBriefingHistory } from "../handlers/briefing";
import {
  handleListCampaignsV2, handleCampaignStats, handleGetCampaign,
  handleCampaignThreats, handleCampaignInfrastructure, handleCampaignBrands,
  handleCampaignTimeline,
} from "../handlers/campaigns";
import {
  handleListOperations, handleOperationsStats,
  handleOperationTimeline, handleOperationThreats,
} from "../handlers/operations";
import {
  handleListGeopoliticalCampaigns, handleGetGeopoliticalCampaign,
  handleGeoCampaignThreats, handleGeoCampaignTimeline,
  handleGeoCampaignBrands, handleGeoCampaignAsns,
  handleGeoCampaignAttackTypes, handleGeoCampaignStats,
  handleGeoCampaignAssessment,
} from "../handlers/geopolitical";
import {
  handleListBreaches, handleListATOEvents, handleUpdateATOEvent,
  handleListEmailAuth, handleListCloudIncidents, handleTrustScoreHistory,
} from "../handlers/intel";
import {
  handleProviderStats, handleListProviders, handleWorstProviders, handleImprovingProviders, handleProviderMovers,
  handleGetProvider, handleProviderDrilldown, handleProviderBrands,
  handleProviderTimeline, handleProviderLocations,
  handleProviderIntelligence, handleListProvidersV2, handleListClusters, handleProviderClusters,
} from "../handlers/providers";
import { handleThreatFeedStats } from "../handlers/threatAssessment";

export function registerThreatRoutes(router: RouterType<IRequest>): void {
  // ─── Threats ──────────────────────────────────────────────────────
  router.get("/api/threats/correlations", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCorrelations(request, env);
  });
  router.get("/api/threats/stats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatStats(request, env);
  });
  router.get("/api/threats/heatmap", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const url = new URL(request.url);
    const period = url.searchParams.get("period") || "7d";
    const limit = Math.min(Number(url.searchParams.get("limit") || "10000"), 10000);
    const origin = request.headers.get("Origin") || "*";

    // KV cache: heatmap returns up to 10K rows from raw threats — cache for 2 minutes.
    const cacheKey = `threats_heatmap:${period}:${limit}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin },
      });
    }

    const { getDbContext, getReadSession, attachBookmark } = await import("../lib/db");
    const dbCtx = getDbContext(request);
    const session = getReadSession(env, dbCtx);
    const dayMap: Record<string, string> = { "24h": "-1 days", "7d": "-7 days", "30d": "-30 days", "90d": "-90 days" };
    const interval = dayMap[period] || "-7 days";
    const rows = await session.prepare(`
      SELECT lat, lng, severity, threat_type
      FROM threats
      WHERE lat IS NOT NULL AND lng IS NOT NULL
        AND lat != 0 AND lng != 0
        AND created_at >= datetime('now', ?)
      LIMIT ?
    `).bind(interval, limit).all();
    const body = JSON.stringify({ data: rows.results });
    await env.CACHE.put(cacheKey, body, { expirationTtl: 300 });
    const resp = new Response(body, {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin },
    });
    return attachBookmark(resp, session);
  });
  router.get("/api/threats/geo-clusters", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoClusters(request, env);
  });
  router.get("/api/threats/attack-flows", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAttackFlows(request, env);
  });
  router.get("/api/threats/recent", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRecentThreats(request, env);
  });
  // Stacked-area inflow chart on the Threats page. Reads the
  // threat_cube_status cube (no raw threats COUNTs) so it stays cheap
  // at 113K+ threats. Accepts ?window=24h|7d.
  router.get("/api/threats/inflow", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatInflow(request, env);
  });
  router.get("/api/threats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleListThreats(request, env, scope);
  });
  router.get("/api/threats/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetThreat(request, env, request.params["id"] ?? "");
  });
  router.patch("/api/threats/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateThreat(request, env, request.params["id"] ?? "");
  });

  // ─── Threat Feed Stats ────────────────────────────────────────────
  router.get("/api/threat-feeds/stats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleThreatFeedStats(request, env);
  });

  // ─── Briefings ────────────────────────────────────────────────────
  router.post("/api/briefings/generate", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const rl = await rateLimitCustom(request, env, { key: "briefing", maxRequests: 5, windowSeconds: 60 }, ctx.userId);
    if (rl) return rl;
    return handleGenerateBriefing(request, env, ctx.userId);
  });
  router.get("/api/briefings/latest", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleLatestBriefing(request, env);
  });
  router.get("/api/briefings/history", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListBriefingHistory(request, env);
  });
  router.get("/api/briefings", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListBriefings(request, env);
  });
  router.get("/api/briefings/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBriefing(request, env, request.params["id"] ?? "");
  });

  // ─── Social IOCs ──────────────────────────────────────────────────
  router.get("/api/social-iocs", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListSocialIOCs(request, env);
  });

  // ─── Operations (NEXUS infrastructure clusters) ─────────────────
  router.get("/api/v1/operations/stats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleOperationsStats(request, env);
  });
  router.get("/api/v1/operations", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListOperations(request, env);
  });
  router.get("/api/v1/operations/:id/timeline", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleOperationTimeline(request, env, request.params["id"] ?? "");
  });
  router.get("/api/v1/operations/:id/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleOperationThreats(request, env, request.params["id"] ?? "");
  });

  // ─── Geopolitical Campaigns ───────────────────────────────────────
  router.get("/api/campaigns/geo", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListGeopoliticalCampaigns(request, env);
  });
  router.get("/api/campaigns/geo/:slug", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetGeopoliticalCampaign(request, env, request.params["slug"] ?? "");
  });
  router.get("/api/campaigns/geo/:slug/stats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoCampaignStats(request, env, request.params["slug"] ?? "");
  });
  router.get("/api/campaigns/geo/:slug/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoCampaignThreats(request, env, request.params["slug"] ?? "");
  });
  router.get("/api/campaigns/geo/:slug/timeline", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoCampaignTimeline(request, env, request.params["slug"] ?? "");
  });
  router.get("/api/campaigns/geo/:slug/brands", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoCampaignBrands(request, env, request.params["slug"] ?? "");
  });
  router.get("/api/campaigns/geo/:slug/asns", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoCampaignAsns(request, env, request.params["slug"] ?? "");
  });
  router.get("/api/campaigns/geo/:slug/attack-types", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoCampaignAttackTypes(request, env, request.params["slug"] ?? "");
  });
  router.post("/api/campaigns/geo/:slug/assessment", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGeoCampaignAssessment(request, env, request.params["slug"] ?? "");
  });

  // ─── Campaign Clusters ────────────────────────────────────────────
  router.get("/api/campaigns/stats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCampaignStats(request, env);
  });
  router.get("/api/campaigns", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListCampaignsV2(request, env);
  });
  router.get("/api/campaigns/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetCampaign(request, env, request.params["id"] ?? "");
  });
  router.get("/api/campaigns/:id/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCampaignThreats(request, env, request.params["id"] ?? "");
  });
  router.get("/api/campaigns/:id/infrastructure", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCampaignInfrastructure(request, env, request.params["id"] ?? "");
  });
  router.get("/api/campaigns/:id/brands", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCampaignBrands(request, env, request.params["id"] ?? "");
  });
  router.get("/api/campaigns/:id/timeline", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCampaignTimeline(request, env, request.params["id"] ?? "");
  });

  // ─── Intel: Breach Checks ─────────────────────────────────────────
  router.get("/api/breaches", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListBreaches(request, env);
  });

  // ─── Intel: Account Takeover ──────────────────────────────────────
  router.get("/api/ato-events", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListATOEvents(request, env);
  });
  router.patch("/api/ato-events/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateATOEvent(request, env, request.params["id"] ?? "");
  });

  // ─── Intel: Email Auth Reports ────────────────────────────────────
  router.get("/api/email-auth", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListEmailAuth(request, env);
  });

  // ─── Intel: Cloud Incidents ───────────────────────────────────────
  router.get("/api/cloud-incidents", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListCloudIncidents(request, env);
  });

  // ─── Trust Score History ──────────────────────────────────────────
  router.get("/api/trust-scores", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrustScoreHistory(request, env);
  });

  // ─── Hosting Provider Intelligence ───────────────────────────────
  router.get("/api/providers/intelligence", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderIntelligence(request, env);
  });
  router.get("/api/providers/v2", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListProvidersV2(request, env);
  });
  router.get("/api/providers/clusters", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListClusters(request, env);
  });
  router.get("/api/providers/stats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderStats(request, env);
  });
  router.get("/api/providers/worst", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleWorstProviders(request, env);
  });
  // /api/providers/movers must be defined before /api/providers/:id
  // below so itty-router doesn't intercept "movers" as the :id param.
  router.get("/api/providers/movers", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderMovers(request, env);
  });
  router.get("/api/providers/improving", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleImprovingProviders(request, env);
  });
  router.get("/api/providers", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListProviders(request, env);
  });
  router.get("/api/providers/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetProvider(request, env, request.params["id"] ?? "");
  });
  router.get("/api/providers/:id/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderDrilldown(request, env, request.params["id"] ?? "");
  });
  router.get("/api/providers/:id/clusters", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderClusters(request, env, request.params["id"] ?? "");
  });
  router.get("/api/providers/:id/brands", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderBrands(request, env, request.params["id"] ?? "");
  });
  router.get("/api/providers/:id/timeline", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderTimeline(request, env, request.params["id"] ?? "");
  });
  router.get("/api/providers/:id/locations", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleProviderLocations(request, env, request.params["id"] ?? "");
  });
}
