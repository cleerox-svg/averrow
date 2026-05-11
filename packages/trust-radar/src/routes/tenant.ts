import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, isAuthContext } from "../middleware/auth";
import {
  handleGetOwnOrg, handleListOrgMembers, handleOrgInvite,
  handleRemoveOrgMember, handleUpdateOrgMember,
  handleAssignOrgBrand, handleRemoveOrgBrand, handleListOrgBrands,
  handleListOrgInvites, handleRevokeOrgInvite, handleResendOrgInvite,
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
  handleCreateTakedown, handleUpdateTakedown,
} from "../handlers/takedowns";
import {
  handleListTenantModules, handleAdminModuleAction, handleAdminSyncPlanModules,
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
import {
  handleGetAppStoreModuleSummary, handleGetBrandAppStoreFindings,
} from "../handlers/tenantAppStoreModule";
import {
  handleGetDarkWebModuleSummary, handleGetBrandDarkWebFindings,
} from "../handlers/tenantDarkWebModule";
import {
  handleGetAbuseMailboxModuleSummary, handleListAbuseInboxMessages,
} from "../handlers/tenantAbuseMailboxModule";
import {
  handleGetTrademarkModuleSummary, handleGetBrandTrademarkFindings,
} from "../handlers/tenantTrademarkModule";
import {
  handleGetThreatActorModuleSummary, handleGetThreatActorDetail,
} from "../handlers/tenantThreatActorModule";
import {
  handleListTenantTakedowns, handleGetTenantTakedownDetail,
} from "../handlers/tenantTakedowns";
import {
  handleGetTenantBilling,
  handleCreateCheckoutSession,
  handleCreatePortalSession,
} from "../handlers/tenantBilling";

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
  router.post("/api/orgs/:orgId/invites/:inviteId/resend", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleResendOrgInvite(request, env, request.params["orgId"] ?? "", request.params["inviteId"] ?? "", ctx);
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
  //
  // GET list + detail are registered farther down (under "Takedowns —
  // tenant-facing list + detail") via handleListTenantTakedowns +
  // handleGetTenantTakedownDetail. Those return the totals-rollup
  // shape the tenant page expects. itty-router takes the first
  // matching registration, so duplicate GETs HERE would shadow the
  // newer handlers and tenant pages would render blank against the
  // legacy shape — exactly the bug we just hit.
  //
  // POST + PATCH stay here because /v2 (averrow-ops) consumes the
  // legacy create + update handlers and they don't need the tenant
  // totals envelope.
  router.post("/api/orgs/:orgId/takedowns", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateTakedown(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/takedowns/:takedownId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateTakedown(request, env, request.params["orgId"] ?? "", request.params["takedownId"] ?? "", ctx);
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
  // Super-admin "sync now": aligns an org's org_modules rows with
  // their current plan_id. Useful for enterprise / custom-billed
  // orgs that bypass the Stripe webhook path. Body optional.
  router.post("/api/admin/orgs/:orgId/sync-plan-modules", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminSyncPlanModules(request, env, request.params["orgId"] ?? "", ctx);
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

  // ─── Module surfaces — App Store Impersonation (v3 Phase B) ────
  router.get("/api/orgs/:orgId/modules/app-store", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetAppStoreModuleSummary(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/app-store/brands/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandAppStoreFindings(
      request, env,
      request.params["orgId"] ?? "",
      request.params["brandId"] ?? "",
      ctx,
    );
  });

  // ─── Module surfaces — Dark Web Monitoring (v3 Phase B) ────────
  router.get("/api/orgs/:orgId/modules/dark-web", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetDarkWebModuleSummary(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/dark-web/brands/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandDarkWebFindings(
      request, env,
      request.params["orgId"] ?? "",
      request.params["brandId"] ?? "",
      ctx,
    );
  });

  // ─── Module surfaces — Abuse Mailbox (v3 Phase B) ──────────────
  router.get("/api/orgs/:orgId/modules/abuse-mailbox", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetAbuseMailboxModuleSummary(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/abuse-mailbox/messages", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListAbuseInboxMessages(request, env, request.params["orgId"] ?? "", ctx);
  });

  // ─── Module surfaces — Trademark Infringement (v3 Phase B) ─────
  router.get("/api/orgs/:orgId/modules/trademark", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetTrademarkModuleSummary(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/trademark/brands/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetBrandTrademarkFindings(
      request, env,
      request.params["orgId"] ?? "",
      request.params["brandId"] ?? "",
      ctx,
    );
  });

  // ─── Module surfaces — Threat-Actor Intelligence (v3 Phase B) ──
  router.get("/api/orgs/:orgId/modules/threat-actor", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetThreatActorModuleSummary(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/threat-actor/actors/:actorId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetThreatActorDetail(
      request, env,
      request.params["orgId"] ?? "",
      request.params["actorId"] ?? "",
      ctx,
    );
  });

  // ─── Takedowns — tenant-facing list + detail (v3 Phase C) ──────
  router.get("/api/orgs/:orgId/takedowns", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListTenantTakedowns(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/takedowns/:takedownId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetTenantTakedownDetail(
      request, env,
      request.params["orgId"] ?? "",
      request.params["takedownId"] ?? "",
      ctx,
    );
  });

  // ─── Billing — tenant-facing read (v3 Phase D Stripe sprint 5) ──
  router.get("/api/orgs/:orgId/billing", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetTenantBilling(request, env, request.params["orgId"] ?? "", ctx);
  });

  // ─── Billing — Checkout + portal redirect (v3 Phase D sprint 6) ──
  router.post("/api/orgs/:orgId/billing/checkout-session", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateCheckoutSession(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/billing/portal-session", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreatePortalSession(request, env, request.params["orgId"] ?? "", ctx);
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
