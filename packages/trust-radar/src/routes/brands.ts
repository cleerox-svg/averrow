import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, requireAdmin, isAuthContext, getOrgScope } from "../middleware/auth";
import {
  handleListBrands, handleTopTargetedBrands, handleMonitoredBrands,
  handleAddMonitoredBrand, handleRemoveMonitoredBrand, handleGetBrand,
  handleBrandThreats, handleBrandThreatLocations, handleBrandThreatTimeline,
  handleBrandProviders, handleBrandCampaigns, handleBrandStats, handleBrandMovers,
  handleGetBrandAnalysis, handleGenerateBrandAnalysis,
  handleBrandDeepScan,
  handleCleanFalsePositives,
  handleGetBrandSocialConfig, handleUpdateBrandSocialConfig,
  handleGetBrandSocialProfiles, handleClassifySocialProfile,
  handleDiscoverSocialLinks,
  handleReassessSocialProfile,
  handleComputeBrandScore,
} from "../handlers/brands";
import {
  handleCreateBrand as handleCreateBrandProfile,
  handleListBrands as handleListBrandProfiles,
  handleGetBrand as handleGetBrandProfile,
  handleUpdateBrand as handleUpdateBrandProfile,
  handleDeleteBrand as handleDeleteBrandProfile,
  handleUpdateHandles as handleUpdateBrandHandles,
  handleGetHandles as handleGetBrandHandles,
} from "../handlers/brandProfiles";
import {
  handleSocialOverview, handleBrandSocialMonitor, handleSocialAlerts, handleTriggerSocialScan,
} from "../handlers/socialMonitor";
import {
  handleListSafeDomains, handleAddSafeDomain, handleBulkAddSafeDomains, handleDeleteSafeDomain,
} from "../handlers/safeDomains";
import {
  handleListLookalikes, handleGenerateLookalikes,
  handleUpdateLookalike, handleScanLookalikes,
} from "../handlers/lookalikeDomains";
import {
  handleListAppStoreListings, handleTriggerAppStoreScan,
  handleUpdateAppStoreListing, handleUpdateOfficialApps,
  handleAppStoreOverview,
} from "../handlers/appStoreMonitor";
import {
  handleListDarkWebMentions, handleTriggerDarkWebScan,
  handleUpdateDarkWebMention, handleDarkWebOverview,
} from "../handlers/darkWebMonitor";
import {
  handleListCertificates, handleCertStats,
  handleUpdateCertificate, handleTriggerCTScan,
} from "../handlers/ctMonitor";
import {
  handleListNarratives, handleGetNarrative,
  handleGenerateNarrative, handleUpdateNarrative,
} from "../handlers/narratives";
import { handleBrandReport } from "../handlers/reports";
import {
  handleGetThreatAssessment, handleGetThreatAssessmentHistory,
} from "../handlers/threatAssessment";

export function registerBrandRoutes(router: RouterType<IRequest>): void {
  // ─── Brands ───────────────────────────────────────────────────────
  router.get("/api/brands", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleListBrands(request, env, scope);
  });
  router.get("/api/brands/top-targeted", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTopTargetedBrands(request, env);
  });
  router.get("/api/brands/monitored", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMonitoredBrands(request, env);
  });
  router.get("/api/brands/stats", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandStats(request, env);
  });
  // /api/brands/movers must be defined before /api/brands/:id below
  // so itty-router doesn't intercept "movers" as the :id param.
  router.get("/api/brands/movers", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandMovers(request, env);
  });
  router.post("/api/brands/monitor", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAddMonitoredBrand(request, env, ctx.userId);
  });
  router.delete("/api/brands/monitor/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRemoveMonitoredBrand(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.get("/api/brands/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrand(request, env, request.params["id"] ?? "");
  });
  router.get("/api/brands/:id/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandThreats(request, env, request.params["id"] ?? "");
  });
  router.get("/api/brands/:id/threats/locations", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandThreatLocations(request, env, request.params["id"] ?? "");
  });
  router.get("/api/brands/:id/threats/timeline", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandThreatTimeline(request, env, request.params["id"] ?? "");
  });
  router.get("/api/brands/:id/providers", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandProviders(request, env, request.params["id"] ?? "");
  });
  router.get("/api/brands/:id/campaigns", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandCampaigns(request, env, request.params["id"] ?? "");
  });
  router.get("/api/brands/:id/analysis", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandAnalysis(request, env, request.params["id"] ?? "");
  });
  router.post("/api/brands/:id/analysis", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGenerateBrandAnalysis(request, env, request.params["id"] ?? "");
  });
  router.post("/api/brands/:id/deep-scan", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandDeepScan(request, env, request.params["id"] ?? "");
  });
  router.get("/api/brands/:id/report", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandReport(request, env, request.params["id"] ?? "");
  });
  router.post("/api/brands/:id/clean-false-positives", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCleanFalsePositives(request, env, request.params["id"] ?? "");
  });

  // ─── Brand Safe Domains ───────────────────────────────────────────
  router.get("/api/brands/:id/safe-domains", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListSafeDomains(request, env, request.params["id"] ?? "");
  });
  router.post("/api/brands/:id/safe-domains", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAddSafeDomain(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/brands/:id/safe-domains/bulk", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBulkAddSafeDomains(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.delete("/api/brands/:id/safe-domains/:domainId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeleteSafeDomain(request, env, request.params["id"] ?? "", request.params["domainId"] ?? "");
  });

  // ─── Social Monitoring (integrated with brands) ───────────────────
  router.get("/api/brands/:id/social-config", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandSocialConfig(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.patch("/api/brands/:id/social-config", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateBrandSocialConfig(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.get("/api/brands/:id/social-profiles", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandSocialProfiles(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.patch("/api/brands/:id/social-profiles/:profileId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleClassifySocialProfile(request, env, request.params["id"] ?? "", request.params["profileId"] ?? "", ctx.userId);
  });
  router.post("/api/brands/:id/discover-social", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDiscoverSocialLinks(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/brands/:id/social-profiles/:profileId/assess", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleReassessSocialProfile(request, env, request.params["id"] ?? "", request.params["profileId"] ?? "", ctx.userId);
  });
  router.post("/api/brands/:id/compute-score", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleComputeBrandScore(request, env, request.params["id"] ?? "");
  });

  // ─── Threat Assessment (per brand) ───────────────────────────────
  router.get("/api/brand/:brandId/threat-assessment/history", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetThreatAssessmentHistory(request, env, request.params["brandId"] ?? "");
  });
  router.get("/api/brand/:brandId/threat-assessment", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetThreatAssessment(request, env, request.params["brandId"] ?? "");
  });

  // ─── Brand Profiles (Social Monitoring) ──────────────────────────
  router.post("/api/brand-profiles", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateBrandProfile(request, env, ctx.userId);
  });
  router.get("/api/brand-profiles", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListBrandProfiles(request, env, ctx.userId);
  });
  router.get("/api/brand-profiles/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandProfile(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.patch("/api/brand-profiles/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateBrandProfile(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.delete("/api/brand-profiles/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeleteBrandProfile(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/brand-profiles/:id/handles", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateBrandHandles(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.get("/api/brand-profiles/:id/handles", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandHandles(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // ─── Social Monitoring Dashboard ─────────────────────────────────
  router.get("/api/social/monitor", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSocialOverview(request, env, ctx.userId);
  });
  router.get("/api/social/monitor/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBrandSocialMonitor(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.get("/api/social/alerts", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSocialAlerts(request, env, ctx.userId);
  });
  router.post("/api/social/scan/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerSocialScan(request, env, request.params["brandId"] ?? "", ctx.userId);
  });

  // ─── Lookalike Domain Monitoring ─────────────────────────────────
  router.get("/api/lookalikes/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListLookalikes(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.post("/api/lookalikes/:brandId/generate", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGenerateLookalikes(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.patch("/api/lookalikes/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateLookalike(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/lookalikes/:brandId/scan", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleScanLookalikes(request, env, request.params["brandId"] ?? "", ctx.userId);
  });

  // ─── App Store Impersonation Monitoring ──────────────────────────
  router.get("/api/appstore/overview", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAppStoreOverview(request, env, ctx);
  });
  router.get("/api/appstore/monitor/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListAppStoreListings(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.post("/api/appstore/scan/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerAppStoreScan(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.patch("/api/appstore/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateAppStoreListing(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.patch("/api/brands/:brandId/official-apps", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateOfficialApps(request, env, request.params["brandId"] ?? "", ctx.userId);
  });

  // ─── Dark-Web Mention Monitoring ─────────────────────────────────
  router.get("/api/darkweb/overview", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDarkWebOverview(request, env, ctx);
  });
  router.get("/api/darkweb/mentions/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListDarkWebMentions(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.post("/api/darkweb/scan/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerDarkWebScan(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.patch("/api/darkweb/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateDarkWebMention(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // ─── Certificate Transparency Monitoring ─────────────────────────
  router.get("/api/ct/certificates/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListCertificates(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.get("/api/ct/certificates/:brandId/stats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCertStats(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.patch("/api/ct/certificates/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateCertificate(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/ct/scan/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTriggerCTScan(request, env, request.params["brandId"] ?? "", ctx.userId);
  });

  // ─── Threat Narratives ────────────────────────────────────────────
  // Note: :brandId/:id must be registered before :brandId to avoid route collision
  router.get("/api/narratives/:brandId/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetNarrative(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/narratives/:brandId/generate", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGenerateNarrative(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.patch("/api/narratives/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateNarrative(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.get("/api/narratives/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListNarratives(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
}
