import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, isAuthContext } from "../middleware/auth";
import {
  handleGetOwnOrg, handleListOrgMembers, handleOrgInvite,
  handleRemoveOrgMember, handleUpdateOrgMember,
  handleAssignOrgBrand, handleRemoveOrgBrand, handleListOrgBrands,
  handleListOrgInvites, handleRevokeOrgInvite, handleResendOrgInvite, handleTransferOwnership,
  handleUpdateWebhook, handleRegenerateSecret, handleTestWebhook, handleGetWebhookConfig,
  handleListApiKeys, handleCreateApiKey, handleRevokeApiKey,
  handleListIntegrations, handleCreateIntegration, handleUpdateIntegration,
  handleDeleteIntegration, handleTestIntegration,
} from "../handlers/organizations";
import {
  handleTenantDashboard, handleTenantAlerts, handleTenantAlertDetail, handleTenantUpdateAlert, handleTenantBulkUpdateAlerts, handleTenantAuditLog,
  handleTenantOrgThreats, handleTenantThreatDetail,
  handleTenantBrandDetail, handleTenantBrandThreats, handleTenantBrandSocialProfiles,
  handleGetMonitoringConfig, handleUpdateMonitoringConfig,
} from "../handlers/tenantData";
import {
  handleCreateTakedown, handleUpdateTakedown,
} from "../handlers/takedowns";
import {
  handleListTenantModules, handleAdminModuleAction, handleAdminSyncPlanModules,
  handleAdminBulkSyncPlanModules,
} from "../handlers/tenantModules";
import {
  handleGetActiveAuthorization, handleAdminRecordAuthorization, handleRecordAuthorization,
  handleRevokeAuthorization,
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
  handleGetOrgDarkWebMentions,
} from "../handlers/tenantDarkWebModule";
import {
  handleGetAbuseMailboxModuleSummary, handleListAbuseInboxMessages,
} from "../handlers/tenantAbuseMailboxModule";
import {
  handleGetTrademarkModuleSummary, handleGetBrandTrademarkFindings,
  handleUploadTrademarkAsset, handleServeTrademarkAssetImage, handleDeleteTrademarkAsset,
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
import {
  handleListInvestigations, handleCreateInvestigation, handleGetInvestigation,
  handleUpdateInvestigation, handleAddInvestigationItem, handleRemoveInvestigationItem,
  handleAddInvestigationNote,
} from "../handlers/tenantInvestigations";

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
  router.post("/api/orgs/:orgId/transfer-ownership", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTransferOwnership(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/brands", async (request: Request & { params: Record<string, string> }, env: Env, workerCtx: ExecutionContext) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAssignOrgBrand(request, env, request.params["orgId"] ?? "", ctx, workerCtx);
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
  router.get("/api/orgs/:orgId/audit-log", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantAuditLog(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/threats", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantOrgThreats(request, env, request.params["orgId"] ?? "", ctx);
  });
  // Single-threat detail — enrichment backing for a threat-sourced
  // signal's Intelligence Card. Registered after the list GET so the
  // bare /threats path still matches the list.
  router.get("/api/orgs/:orgId/threats/:threatId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantThreatDetail(request, env, request.params["orgId"] ?? "", request.params["threatId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/alerts/bulk", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantBulkUpdateAlerts(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/alerts/:alertId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantUpdateAlert(request, env, request.params["orgId"] ?? "", request.params["alertId"] ?? "", ctx);
  });
  // Single-signal detail for the Intelligence Card (deep-linkable).
  router.get("/api/orgs/:orgId/alerts/:alertId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTenantAlertDetail(request, env, request.params["orgId"] ?? "", request.params["alertId"] ?? "", ctx);
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
  // Bulk-sync companion to the 0164 plan_id backfill. Walks every
  // org with a plan_id and re-runs syncOrgModulesToPlan. Run once
  // after the migration ships; idempotent.
  router.post("/api/admin/orgs/sync-all-plan-modules", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminBulkSyncPlanModules(request, env, ctx);
  });

  // ─── Takedown Authorization ───────────────────────────────────
  // Tenant + super_admin can read; org admin/owner can sign or
  // revoke; super_admin can also record on a tenant's behalf via
  // the /admin/ path for support-style cases. See
  // `lib/takedown-authorizations.ts`.
  router.get("/api/orgs/:orgId/takedown-authorization", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetActiveAuthorization(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/takedown-authorization", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRecordAuthorization(request, env, request.params["orgId"] ?? "", ctx);
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
  router.get("/api/orgs/:orgId/modules/dark-web/mentions", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetOrgDarkWebMentions(request, env, request.params["orgId"] ?? "", ctx);
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
  // PR-AS — per-message detail (raw body / headers / URL list / attachments)
  router.get("/api/orgs/:orgId/modules/abuse-mailbox/messages/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleGetAbuseInboxMessageDetail } = await import("../handlers/tenantAbuseMailboxModule");
    return handleGetAbuseInboxMessageDetail(
      request, env, request.params["orgId"] ?? "", request.params["id"] ?? "", ctx,
    );
  });
  // PR-BD — status transition (new | investigating | resolved | dismissed)
  router.patch("/api/orgs/:orgId/modules/abuse-mailbox/messages/:id/status", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleUpdateAbuseInboxMessageStatus } = await import("../handlers/tenantAbuseMailboxModule");
    return handleUpdateAbuseInboxMessageStatus(
      request, env, request.params["orgId"] ?? "", request.params["id"] ?? "", ctx,
    );
  });
  // PR-BD — Intel summary aggregated over deep_analysis rows
  router.get("/api/orgs/:orgId/modules/abuse-mailbox/intel", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleGetAbuseMailboxIntel } = await import("../handlers/tenantAbuseMailboxModule");
    return handleGetAbuseMailboxIntel(request, env, request.params["orgId"] ?? "", ctx);
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
  router.post("/api/orgs/:orgId/modules/trademark/brands/:brandId/assets", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUploadTrademarkAsset(request, env, request.params["orgId"] ?? "", request.params["brandId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/modules/trademark/assets/:assetId/image", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleServeTrademarkAssetImage(request, env, request.params["orgId"] ?? "", request.params["assetId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/modules/trademark/assets/:assetId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeleteTrademarkAsset(request, env, request.params["orgId"] ?? "", request.params["assetId"] ?? "", ctx);
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

  // ─── Investigations / Cases (org-scoped) ─────────────────────────
  // TENANT_ANALYST_UX_RESEARCH_2026-06 #7. Reads are member-visible;
  // every mutation is analyst+ (enforced in the handlers). Collection
  // routes register before /:investigationId so the bare path matches
  // the list.
  router.get("/api/orgs/:orgId/investigations", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListInvestigations(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/investigations", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateInvestigation(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/orgs/:orgId/investigations/:investigationId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetInvestigation(request, env, request.params["orgId"] ?? "", request.params["investigationId"] ?? "", ctx);
  });
  router.patch("/api/orgs/:orgId/investigations/:investigationId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateInvestigation(request, env, request.params["orgId"] ?? "", request.params["investigationId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/investigations/:investigationId/items", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAddInvestigationItem(request, env, request.params["orgId"] ?? "", request.params["investigationId"] ?? "", ctx);
  });
  router.delete("/api/orgs/:orgId/investigations/:investigationId/items/:itemId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRemoveInvestigationItem(request, env, request.params["orgId"] ?? "", request.params["investigationId"] ?? "", request.params["itemId"] ?? "", ctx);
  });
  router.post("/api/orgs/:orgId/investigations/:investigationId/notes", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAddInvestigationNote(request, env, request.params["orgId"] ?? "", request.params["investigationId"] ?? "", ctx);
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
