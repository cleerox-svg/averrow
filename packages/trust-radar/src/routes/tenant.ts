import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, isAuthContext } from "../middleware/auth";
import {
  handleGetOwnOrg, handleListOrgMembers, handleOrgInvite,
  handleRemoveOrgMember, handleUpdateOrgMember,
  handleAssignOrgBrand, handleRemoveOrgBrand, handleListOrgBrands,
  handleListOrgInvites, handleRevokeOrgInvite,
  handleUpdateWebhook, handleRegenerateSecret, handleTestWebhook, handleGetWebhookConfig,
  handleListApiKeys, handleCreateApiKey, handleRevokeApiKey,
  handleListIntegrations, handleCreateIntegration, handleUpdateIntegration,
  handleDeleteIntegration, handleTestIntegration,
} from "../handlers/organizations";
import {
  handleTenantDashboard, handleTenantAlerts, handleTenantUpdateAlert,
  handleTenantBrandDetail, handleTenantBrandThreats, handleTenantBrandSocialProfiles,
  handleGetMonitoringConfig, handleUpdateMonitoringConfig,
} from "../handlers/tenantData";
import {
  handleCreateTakedown, handleListTakedowns, handleGetTakedown, handleUpdateTakedown,
} from "../handlers/takedowns";
import {
  handleListTenantModules, handleAdminModuleAction,
} from "../handlers/tenantModules";
import {
  handleGetActiveAuthorization, handleAdminRecordAuthorization, handleRevokeAuthorization,
} from "../handlers/takedownAuthorizations";
import {
  handleGetDomainModuleSummary, handleGetBrandDomainFindings,
} from "../handlers/tenantDomainModule";
import {
  handleGetSocialModuleSummary, handleGetBrandSocialFindings,
} from "../handlers/tenantSocialModule";

export function registerTenantRoutes(router: RouterType<IRequest>): void {
  // ─── Organizations (org-scoped) ───────────────────────────────────
  router.get("/api/orgs/:orgId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetOwnOrg(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/members", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListOrgMembers(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/invite", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleOrgInvite(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/members/:userId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRemoveOrgMember(request, env, request.params["orgId"] ?? "", request.params["userId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/members/:userId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateOrgMember(request, env, request.params["orgId"] ?? "", request.params["userId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/brands", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAssignOrgBrand(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/brands/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRemoveOrgBrand(request, env, request.params["orgId"] ?? "", request.params["brandId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/brands", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListOrgBrands(request, env, request.params["orgId"] ?? "", ctx);
  });

  // ─── Team Management: Invites ─────────────────────────────────────
  router.get("/api/orgs/:orgId/invites", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListOrgInvites(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/invites/:inviteId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRevokeOrgInvite(request, env, request.params["orgId"] ?? "", request.params["inviteId"] ?? "", ctx);
  });

  // ─── API Keys ──────────────────────────────────────────────────────
  router.get("/api/orgs/:orgId/api-keys", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListApiKeys(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/api-keys", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateApiKey(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/api-keys/:keyId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRevokeApiKey(request, env, request.params["orgId"] ?? "", request.params["keyId"] ?? "", ctx);
  });

  // ─── Integrations ────────────────────────────────────────────────
  router.get("/api/orgs/:orgId/integrations", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListIntegrations(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/integrations", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateIntegration(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/integrations/:integrationId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateIntegration(request, env, request.params["orgId"] ?? "", request.params["integrationId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/integrations/:integrationId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeleteIntegration(request, env, request.params["orgId"] ?? "", request.params["integrationId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/integrations/:integrationId/test", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTestIntegration(request, env, request.params["orgId"] ?? "", request.params["integrationId"] ?? "", ctx);
  });

  // ─── Webhook Management ───────────────────────────────────────────
  router.get("/api/orgs/:orgId/webhook", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetWebhookConfig(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/webhook", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateWebhook(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/webhook/regenerate-secret", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRegenerateSecret(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/webhook/test", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTestWebhook(request, env, request.params["orgId"] ?? "", ctx);
  });

  // ─── Tenant Data ──────────────────────────────────────────────────
  router.get("/api/orgs/:orgId/dashboard", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantDashboard(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/alerts", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantAlerts(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/alerts/:alertId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantUpdateAlert(request, env, request.params["orgId"] ?? "", request.params["alertId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/brands/:brandId/detail", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantBrandDetail(request, env, request.params["orgId"] ?? "", request.params["brandId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/brands/:brandId/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantBrandThreats(request, env, request.params["orgId"] ?? "", request.params["brandId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/brands/:brandId/social-profiles", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantBrandSocialProfiles(request, env, request.params["orgId"] ?? "", request.params["brandId"] ?? "", ctx);
  });

  // ─── Takedown Requests (org-scoped) ──────────────────────────────
  router.post("/api/orgs/:orgId/takedowns", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateTakedown(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/takedowns", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListTakedowns(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/takedowns/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetTakedown(request, env, request.params["orgId"] ?? "", request.params["id"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/takedowns/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateTakedown(request, env, request.params["orgId"] ?? "", request.params["id"] ?? "", ctx);
  });

  // ─── Modules (v3 Phase A) ─────────────────────────────────────
  // Tenant read: list of modules + per-module monthly usage
  router.get("/api/orgs/:orgId/modules", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListTenantModules(request, env, request.params["orgId"] ?? "", ctx);
  });
  // Super-admin activate / suspend — eventually called by Stripe webhook too
  router.post("/api/admin/orgs/:orgId/modules", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminModuleAction(request, env, request.params["orgId"] ?? "", ctx);
  });

  // ─── Takedown Authorization (v3 Phase A) ──────────────────────
  // Tenant + super_admin can read; super_admin records (until the
  // tenant-side signing UI lands in Phase B); admin/owner of the
  // org can revoke. See `lib/takedown-authorizations.ts`.
  router.get("/api/orgs/:orgId/takedown-authorization", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetActiveAuthorization(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/admin/orgs/:orgId/takedown-authorization", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminRecordAuthorization(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/takedown-authorization", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRevokeAuthorization(request, env, request.params["orgId"] ?? "", ctx);
  });

  // ─── Module surfaces — Domain Monitoring (v3 Phase B) ─────────
  router.get("/api/orgs/:orgId/modules/domain", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetDomainModuleSummary(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/domain/brands/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandDomainFindings(
      request, env,
      request.params["orgId"] ?? "",
      request.params["brandId"] ?? "",
      ctx,
    );
  });

  // ─── Module surfaces — Social Media Impersonation (v3 Phase B) ─
  router.get("/api/orgs/:orgId/modules/social", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetSocialModuleSummary(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/social/brands/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandSocialFindings(
      request, env,
      request.params["orgId"] ?? "",
      request.params["brandId"] ?? "",
      ctx,
    );
  });

  // ─── Monitoring Config (org-brand scoped) ────────────────────────
  router.get("/api/orgs/:orgId/brands/:brandId/monitoring-config", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetMonitoringConfig(request, env, request.params["orgId"] ?? "", request.params["brandId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/brands/:brandId/monitoring-config", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateMonitoringConfig(request, env, request.params["orgId"] ?? "", request.params["brandId"] ?? "", ctx);
  });
}
