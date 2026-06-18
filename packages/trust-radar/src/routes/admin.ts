import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAdmin, requireSuperAdmin, requireSales, requirePermission, isAuthContext } from "../middleware/auth";
import { json } from "../lib/cors";
import {
  handleAdminStats, handleAdminListUsers, handleAdminUpdateUser, handleAdminHealth, handleSystemHealth,
  handleBackfillClassifications, handleBackfillGeo, handleBackfillDomainGeo, handleBackfillBrandMatch,
  handleBackfillBrandEnrichment, handleBackfillBrandSector,
  handleBackfillSafeDomains, handleImportTranco, handleAdminListBrands,
  handleBulkMonitor, handleBulkDeleteBrands, handleBackfillAiAttribution,
  handleBackfillSocialConfig, handleBackfillSaasTechniques,
  handleBudgetLedgerHealth,
  handleCubeBackfill,
  handlePipelineStatus,
  handlePipelineDetail,
  handleD1Budget,
  handleMetricsAiSpend,
  handleMetricsAiCostOptimization,
  handleMetricsGeoCoverage,
  handleMetricsFeedFailures,
  handleAttributionBacklog,
} from "../handlers/admin";
import { handleListSessionEvents, handleForceLogout } from "../handlers/sessions";
import { handleCreateInvite, handleListInvites, handleRevokeInvite } from "../handlers/invites";
import {
  handleCreateOrg, handleListOrgs, handleGetOrg, handleUpdateOrg,
  handleSearchBrands,
} from "../handlers/organizations";
import {
  handleAdminListTakedowns, handleAdminUpdateTakedown,
} from "../handlers/takedowns";
import {
  handleGenerateVapidKeys, handleGetPushConfig, handleUpdatePushConfig, handlePushTest,
} from "../handlers/adminPush";
import { handleListLeads, handleUpdateLead, handleGetLead } from "../handlers/brandScan";
import {
  handleListSalesLeads, handleGetSalesLead, handleUpdateSalesLead,
  handleApproveLead, handleSendLead, handleRespondLead,
  handleBookLead, handleConvertLead, handleDeclineLead,
  handleDeleteSalesLead, handleLeadActivity, handleSalesLeadStats,
} from "../handlers/salesLeads";
import { handleListAuditLog, handleExportAuditLog } from "../handlers/audit";
import { handleEnrichGeo, handleEnrichAll, handleDailySnapshots } from "../handlers/threats";
import { handleBudgetStatus, handleBudgetBreakdown, handleBudgetConfigPatch } from "../handlers/budget";
import { handlePlatformDiagnostics } from "../handlers/diagnostics";
import { handlePlatformStatus } from "../handlers/platform-status";
import { handleNotificationDeliveryAudit } from "../handlers/notification-delivery-audit";
import {
  handleListIncidents, handleGetIncident, handleCreateIncident,
  handleAppendIncidentUpdate, handlePromoteIncident, handleTransitionIncidentStatus,
  handleEditIncidentUpdatePublicCopy,
} from "../handlers/incidents";
import { handleCartographerHealth } from "../handlers/cartographer-health";
import { handleD1Health } from "../handlers/d1-health";
import { handleGenerateQualifiedReport, handleRenewQualifiedReport } from "../handlers/qualifiedReport";
import {
  handleListPricingPlans, handleListModulePrices, handleGetCustomerPricing,
  handleUpdatePricingPlan, handleUpdateModulePrice,
  handleCreatePricingOverride, handleRevokePricingOverride,
} from "../handlers/adminPricing";
import { handleSendLeadOutreach, handleConvertLeadToTenant } from "../handlers/leadConversion";
import {
  handleListPendingApprovals, handleGetApproval, handleGetReviewBundle,
  handleApproveAgent, handleRejectAgent, handleRequestChangesAgent,
} from "../handlers/agent-approvals";
import { handleAgentModuleMetadata } from "../handlers/agent-module-metadata";

export function registerAdminRoutes(router: RouterType<IRequest>): void {
  // ─── Admin Stats & Health ─────────────────────────────────────────
  router.get("/api/admin/stats", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminStats(request, env);
  });
  router.get("/api/admin/pipeline-status", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePipelineStatus(request, env);
  });
  // Pipeline drill-down detail — must be defined after the bare
  // /api/admin/pipeline-status above so itty-router doesn't
  // intercept ":id" before the list route runs.
  router.get(
    "/api/admin/pipeline-status/:id",
    async (request: Request & { params: Record<string, string> }, env: Env) => {
      const ctx = await requireAdmin(request, env);
      if (!isAuthContext(ctx)) return ctx;
      return handlePipelineDetail(request, env, request.params["id"] ?? "");
    },
  );
  // Metrics page — D1 Budget section.
  router.get("/api/admin/metrics/d1-budget", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleD1Budget(request, env);
  });
  router.get("/api/admin/metrics/ai-spend", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMetricsAiSpend(request, env);
  });
  // Sibling of /ai-spend, focused on the cost-reduction plan tracked in
  // /root/.claude/plans/can-you-review-the-purring-pearl.md. Returns
  // per-call efficiency metrics for the three focus agents +
  // cartographer's 30-day daily series + the static lever roster.
  router.get("/api/admin/metrics/ai-cost-optimization", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMetricsAiCostOptimization(request, env);
  });
  router.get("/api/admin/metrics/geo-coverage", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMetricsGeoCoverage(request, env);
  });
  router.get("/api/admin/metrics/feed-failures", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMetricsFeedFailures(request, env);
  });
  router.get("/api/admin/health", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminHealth(request, env);
  });
  // PR-AA — Averrow self abuse-mailbox (super_admin only). Bound to
  // the `_averrow_platform` synthetic org seeded by migration 0180.
  router.get("/api/admin/abuse-mailbox", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleAdminAbuseMailboxSummary } = await import("../handlers/adminAbuseMailbox");
    return handleAdminAbuseMailboxSummary(request, env, ctx);
  });
  router.get("/api/admin/abuse-mailbox/messages", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleAdminAbuseMailboxMessages } = await import("../handlers/adminAbuseMailbox");
    return handleAdminAbuseMailboxMessages(request, env, ctx);
  });
  // PR-AS — per-message detail (raw body / headers / URL list / attachments)
  router.get("/api/admin/abuse-mailbox/messages/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleAdminAbuseMailboxMessageDetail } = await import("../handlers/adminAbuseMailbox");
    return handleAdminAbuseMailboxMessageDetail(request, env, request.params["id"] ?? "", ctx);
  });
  // PR-BD — status transition (new | investigating | resolved | dismissed)
  router.patch("/api/admin/abuse-mailbox/messages/:id/status", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleAdminAbuseMailboxMessageStatusUpdate } = await import("../handlers/adminAbuseMailbox");
    return handleAdminAbuseMailboxMessageStatusUpdate(request, env, request.params["id"] ?? "", ctx);
  });
  // PR-BD — Intel summary aggregated over deep_analysis rows
  router.get("/api/admin/abuse-mailbox/intel", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleAdminAbuseMailboxIntel } = await import("../handlers/adminAbuseMailbox");
    return handleAdminAbuseMailboxIntel(request, env, ctx);
  });

  // WS-B #4 — one-shot bulk re-encrypt of org_integrations.config_encrypted.
  // Super-admin only because it round-trips every integration credential
  // through the master key. Idempotent — safe to call repeatedly.
  router.post("/api/admin/integrations/rewrap", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleBulkRewrapIntegrations } = await import("../handlers/organizations");
    return handleBulkRewrapIntegrations(request, env);
  });

  // Wave 2.1 PR-AF — seed-domain config (admin-gated). Operator
  // surface for the auto-seeder target list. See
  // docs/SEED_DOMAINS_RUNBOOK.md for the workflow.
  router.get("/api/admin/seed-domains", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleListSeedDomains } = await import("../handlers/seedDomains");
    return handleListSeedDomains(request, env);
  });
  router.post("/api/admin/seed-domains", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleAddSeedDomain } = await import("../handlers/seedDomains");
    return handleAddSeedDomain(request, env);
  });
  router.patch("/api/admin/seed-domains/:domain", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handlePatchSeedDomain } = await import("../handlers/seedDomains");
    return handlePatchSeedDomain(request, env);
  });
  router.delete("/api/admin/seed-domains/:domain", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleDeleteSeedDomain } = await import("../handlers/seedDomains");
    return handleDeleteSeedDomain(request, env);
  });

  router.get("/api/admin/system-health", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSystemHealth(request, env);
  });
  router.get("/api/admin/budget/ledger-health", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBudgetLedgerHealth(request, env);
  });
  router.get("/api/admin/platform-diagnostics", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePlatformDiagnostics(request, env);
  });
  // Lightweight 30-day uptime rollup feeding the Home banner + (Phase 3)
  // public status page. Cached 60s in KV; pass ?refresh=1 to bypass.
  router.get("/api/admin/platform-status", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePlatformStatus(request, env);
  });
  // Per-channel delivery audit for platform_* notifications. Built after
  // the 50cb1e4 outage where alerts fired but no operator saw them.
  router.get("/api/admin/notification-delivery-audit", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleNotificationDeliveryAudit(request, env);
  });

  // ─── NX5 Notification Center (super-admin only) ────────────────────
  // Activity stats + per-type system-wide mutes. Powers
  // /v2/notifications/admin in averrow-ops.
  router.get("/api/admin/notifications/stats", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleNotificationStats } = await import("../handlers/notificationAdmin");
    return handleNotificationStats(request, env);
  });
  router.get("/api/admin/notifications/mutes", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleListNotificationMutes } = await import("../handlers/notificationAdmin");
    return handleListNotificationMutes(request, env);
  });
  router.post("/api/admin/notifications/mute", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleCreateNotificationMute } = await import("../handlers/notificationAdmin");
    return handleCreateNotificationMute(request, env, ctx.userId);
  });
  router.delete("/api/admin/notifications/mute/:type", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleDeleteNotificationMute } = await import("../handlers/notificationAdmin");
    return handleDeleteNotificationMute(request, env, request.params["type"] ?? "");
  });

  // ─── Incidents (migration 0132) ───────────────────────────────────
  // Auto-created from critical platform_* notifications, operator-
  // managed via this surface, and selectively promoted to /status.
  router.get("/api/admin/incidents", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListIncidents(request, env);
  });
  router.post("/api/admin/incidents", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateIncident(request, env, ctx.userId);
  });
  router.get("/api/admin/incidents/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetIncident(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/incidents/:id/updates", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAppendIncidentUpdate(request, env, request.params["id"] ?? "", ctx.userId);
  });
  // Edit any existing update's public copy (operator OR system rows).
  // Lets the auto-create trigger row + recovery sweep messages get a
  // sanitized public_message so they can surface on /status.
  router.patch("/api/admin/incidents/:id/updates/:updateId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleEditIncidentUpdatePublicCopy(
      request, env,
      request.params["id"] ?? "",
      request.params["updateId"] ?? "",
      ctx.userId,
    );
  });
  router.post("/api/admin/incidents/:id/transition", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTransitionIncidentStatus(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/admin/incidents/:id/promote", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePromoteIncident(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // ─── Attribution backlog (PR-B from 2026-05-16 audit) ───────────
  // Lists infrastructure_clusters with actor_id IS NULL, top-N by
  // threat_count, for the /admin/agents/attribution-backlog queue.
  router.get("/api/admin/agents/attribution-backlog", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAttributionBacklog(request, env);
  });

  // ─── Agent deployment approval (AGENT_STANDARD §12.1) ──────────
  // Phase 5.4a — endpoints only. Phase 5.4b will integrate the runner
  // gate that creates pending rows on first run + the /agents/:id/review
  // UI. All routes are super_admin-gated.
  router.get("/api/admin/agents/approvals/pending", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListPendingApprovals(request, env);
  });
  router.get("/api/admin/agents/approvals/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetApproval(request, env, request.params["id"] ?? "");
  });
  router.get("/api/admin/agents/approvals/:id/review-bundle", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetReviewBundle(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/agents/approvals/:id/approve", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleApproveAgent(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/admin/agents/approvals/:id/reject", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRejectAgent(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/admin/agents/approvals/:id/request-changes", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRequestChangesAgent(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // ─── Agent module-metadata endpoint (Phase 5.5) ────────────────
  // Returns the AgentModule's declared fields (supervision, budget,
  // reads/writes, outputs, etc.) plus the current-month rollup for
  // budget-vs-spend rendering on the agent detail UI.
  router.get("/api/admin/agents/:id/module-metadata", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAgentModuleMetadata(request, env, request.params["id"] ?? "");
  });
  router.get("/api/admin/cartographer-health", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCartographerHealth(request, env);
  });
  router.get("/api/admin/d1-health", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleD1Health(request, env);
  });

  // Sales-qualified Brand Risk Plan — generate a deeper, sharable
  // report for a qualified scan_leads row. Returns a share URL with
  // a 30-day TTL token; admin sends the URL to the prospect post-call.
  router.post("/api/admin/leads/:id/qualified-report", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGenerateQualifiedReport(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // Send templated outreach email with the qualified-report share URL.
  // Requires a previously-generated qualified report (404s otherwise).
  router.post("/api/admin/leads/:id/outreach", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSendLeadOutreach(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // Renew the most recent qualified report for a lead: fresh payload +
  // fresh 30-day expiry, same share_token, so a link already sent to the
  // prospect stays alive through a long sales cycle.
  router.post("/api/admin/leads/:id/qualified-report/renew", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRenewQualifiedReport(request, env, request.params["id"] ?? "");
  });

  // One-click: generate a fresh qualified report AND email it to the
  // prospect in a single call. Composes the generate + outreach handlers;
  // neither reads the request body, so reusing `request` is safe.
  router.post("/api/admin/leads/:id/report-and-outreach", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const id = request.params["id"] ?? "";
    const genRes = await handleGenerateQualifiedReport(request, env, id, ctx.userId);
    const genData = await genRes.clone().json() as { success: boolean };
    if (!genData.success) return genRes; // surface the generate error as-is
    return handleSendLeadOutreach(request, env, id, ctx.userId);
  });

  // Convert a qualified lead to a tenant organization. Creates org +
  // adds super_admin as owner-role member + auto-creates/links the
  // brand for monitoring. Independent of outreach (deals close on calls).
  router.post("/api/admin/leads/:id/convert-to-tenant", async (request: Request & { params: Record<string, string> }, env: Env, workerCtx: ExecutionContext) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleConvertLeadToTenant(request, env, request.params["id"] ?? "", ctx.userId, workerCtx);
  });

  // ─── Admin Users ──────────────────────────────────────────────────
  router.get("/api/admin/users", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminListUsers(request, env);
  });
  router.patch("/api/admin/users/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminUpdateUser(request, env, request.params["id"] ?? "", ctx.userId, ctx.role);
  });

  // ─── Session Events ───────────────────────────────────────────────
  router.get("/api/admin/sessions", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListSessionEvents(request, env);
  });
  router.post("/api/admin/users/:id/force-logout", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleForceLogout(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // ─── Invites ──────────────────────────────────────────────────────
  // M4 (2026-06-10 audit): gated on the `manage_invites` permission
  // (sales + admin + super_admin per lib/role-permissions.ts) so sales
  // staff can send invites per the documented RBAC model. The
  // role-escalation check stays in handleCreateInvite: non-super_admins
  // (including sales) cannot invite admin or super_admin roles.
  router.post("/api/admin/invites", async (request: Request, env: Env) => {
    const ctx = await requirePermission("manage_invites")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateInvite(request, env, ctx.userId, ctx.role);
  });
  router.get("/api/admin/invites", async (request: Request, env: Env) => {
    const ctx = await requirePermission("manage_invites")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListInvites(request, env);
  });
  router.delete("/api/admin/invites/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("manage_invites")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRevokeInvite(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // ─── Organizations ────────────────────────────────────────────────
  // M4 (2026-06-10 audit): reads are gated on `read_customers`
  // (analyst/sales/support + admin/super_admin per role-permissions)
  // so sales + support staff can browse customer data. Mutations
  // (create/update org) stay super_admin — the matrix only documents
  // a read permission for customer data.
  router.post("/api/admin/organizations", async (request: Request, env: Env, workerCtx: ExecutionContext) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreateOrg(request, env, ctx.userId, workerCtx);
  });
  router.get("/api/admin/organizations", async (request: Request, env: Env) => {
    const ctx = await requirePermission("read_customers")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListOrgs(request, env);
  });
  router.get("/api/admin/organizations/:orgId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("read_customers")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetOrg(request, env, request.params["orgId"] ?? "");
  });
  router.patch("/api/admin/organizations/:orgId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateOrg(request, env, request.params["orgId"] ?? "");
  });

  // ─── Customers (Stripe + pricing surface) ─────────────────────
  // /api/admin/customers/* mirrors /api/admin/organizations/* but
  // adds the Stripe + pricing read endpoints. The averrow-ops
  // sidebar entry "Organizations" is being renamed to "Customers"
  // in a sibling sprint.
  //
  // M4 (2026-06-10 audit): permission-gated per role-permissions —
  // reads on `view_billing`, mutations on `edit_pricing`. Both flags
  // grant sales + billing (+ admin/super_admin), matching CLAUDE.md §7
  // ("sales — edit pricing", "billing — Stripe + pricing only").
  // handlers/adminPricing.ts enforces the same flags internally.
  router.get("/api/admin/customers/:orgId/pricing", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("view_billing")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetCustomerPricing(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.get("/api/admin/pricing/plans", async (request: Request, env: Env) => {
    const ctx = await requirePermission("view_billing")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListPricingPlans(request, env, ctx);
  });
  router.get("/api/admin/pricing/modules", async (request: Request, env: Env) => {
    const ctx = await requirePermission("view_billing")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListModulePrices(request, env, ctx);
  });
  router.patch("/api/admin/pricing/plans/:planId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("edit_pricing")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdatePricingPlan(request, env, request.params["planId"] ?? "", ctx);
  });
  router.patch("/api/admin/pricing/modules/:moduleKey", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("edit_pricing")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateModulePrice(request, env, request.params["moduleKey"] ?? "", ctx);
  });
  router.post("/api/admin/customers/:orgId/pricing-overrides", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("edit_pricing")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCreatePricingOverride(request, env, request.params["orgId"] ?? "", ctx);
  });
  router.patch("/api/admin/customers/:orgId/pricing-overrides/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("edit_pricing")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRevokePricingOverride(
      request, env,
      request.params["orgId"] ?? "",
      request.params["id"] ?? "",
      ctx,
    );
  });
  router.get("/api/admin/brands/search", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSearchBrands(request, env);
  });

  // ─── Takedown Queue ──────────────────────────────────────────────
  // M4 (2026-06-10 audit): gated on `manage_takedowns` (analyst +
  // admin/super_admin per role-permissions) so SOC analysts can work
  // the takedown queue per the documented RBAC model.
  router.get("/api/admin/takedowns", async (request: Request, env: Env) => {
    const ctx = await requirePermission("manage_takedowns")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminListTakedowns(request, env);
  });
  router.patch("/api/admin/takedowns/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("manage_takedowns")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminUpdateTakedown(request, env, request.params["id"] ?? "", ctx);
  });

  // ─── Leads Management ─────────────────────────────────────────────
  router.get("/api/admin/leads", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListLeads(request, env);
  });
  // Single lead + live customer intel snapshot (drill-down view).
  router.get("/api/admin/leads/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetLead(request, env, request.params["id"] ?? "");
  });
  router.patch("/api/admin/leads/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateLead(request, env, request.params["id"] ?? "");
  });

  // ─── Sales Leads (Prospector) ─────────────────────────────────────
  // M4 (2026-06-10 audit): the lead lifecycle (read, update, status
  // transitions, activity log, firmographic refresh) is the sales
  // team's core workflow, so these use the requireSales sub-role
  // guard (sales + admin + super_admin). No permission flag covers
  // prospect data in role-permissions.ts — the named role guard is
  // the documented mechanism here. DELETE stays super_admin: it
  // irreversibly removes the lead AND its activity log.
  router.get("/api/admin/sales-leads", async (request: Request, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListSalesLeads(request, env);
  });
  router.get("/api/admin/sales-leads/stats", async (request: Request, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSalesLeadStats(request, env);
  });
  router.get("/api/admin/sales-leads/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetSalesLead(request, env, request.params["id"] ?? "");
  });
  router.patch("/api/admin/sales-leads/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateSalesLead(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/sales-leads/:id/approve", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleApproveLead(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/sales-leads/:id/send", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSendLead(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/sales-leads/:id/respond", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleRespondLead(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/sales-leads/:id/book", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBookLead(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/sales-leads/:id/convert", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleConvertLead(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/sales-leads/:id/decline", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeclineLead(request, env, request.params["id"] ?? "");
  });
  router.delete("/api/admin/sales-leads/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeleteSalesLead(request, env, request.params["id"] ?? "");
  });
  router.get("/api/admin/sales-leads/:id/activity", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleLeadActivity(request, env, request.params["id"] ?? "");
  });
  router.post("/api/admin/sales-leads/:id/refresh-firmographics", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSales(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleRefreshLeadFirmographics } = await import("../handlers/salesLeads");
    return handleRefreshLeadFirmographics(request, env, request.params["id"] ?? "");
  });

  // ─── Pathfinder AI Enrichment ─────────────────────────────────────
  router.post("/api/admin/pathfinder-enrich", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { enrichLeadWithAI } = await import("../agents/pathfinder");
    const result = await enrichLeadWithAI(env);
    return json({ success: true, data: result });
  });

  // ─── Audit Log ────────────────────────────────────────────────────
  router.get("/api/admin/audit", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListAuditLog(request, env);
  });
  router.get("/api/admin/audit/export", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleExportAuditLog(request, env);
  });

  // ─── Backfill Endpoints ───────────────────────────────────────────
  router.post("/api/admin/backfill-classifications", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillClassifications(request, env);
  });
  router.post("/api/admin/backfill-saas-techniques", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillSaasTechniques(request, env);
  });
  router.post("/api/admin/backfill-geo", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillGeo(request, env);
  });
  router.post("/api/admin/backfill-domain-geo", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillDomainGeo(request, env);
  });
  // Triggers the geoip_refresh agent on demand. Same auth +
  // permission contour as the other backfill endpoints; reuses
  // the agentRunner lifecycle so a manual refresh writes its own
  // agent_runs row alongside scheduled runs.
  router.post("/api/admin/geoip-refresh", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    // Optional body: { forceReload: true } bypasses the
    // skip-if-current guard. Use when the operator wants to
    // re-import the same MaxMind release (e.g. after schema
    // changes or partial loads). No body / forceReload=false
    // means: poll for a new release, re-import only if changed.
    let forceReload = false;
    try {
      const body = await request.json().catch(() => null) as { forceReload?: boolean } | null;
      if (body && typeof body.forceReload === 'boolean') forceReload = body.forceReload;
    } catch { /* missing/invalid body is fine */ }
    const { geoipRefreshAgent } = await import("../agents/geoip-refresh");
    const { executeAgent } = await import("../lib/agentRunner");
    try {
      const result = await executeAgent(
        env,
        geoipRefreshAgent,
        { trigger: 'admin_manual', forceReload },
        'admin',
        'manual',
      );
      return new Response(JSON.stringify({ success: true, data: result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  });
  // Operator-uploaded GeoIP archive import. Lets us bootstrap
  // geo_ip_ranges without burning the daily MaxMind quota: the
  // operator downloads `GeoLite2-City-CSV_<release>.zip` via their
  // browser session (no API quota), uploads to the GEOIP_STAGING
  // R2 bucket, and POSTs here with the R2 key + the matching sha256
  // (from MaxMind's `.zip.sha256` file).
  //
  // The endpoint creates a geo_ip_refresh_log row and dispatches
  // the existing GeoipRefreshWorkflow with `r2Key` set — same
  // workflow scaffolding (shadow table, atomic swap, finalize)
  // just sourcing bytes from R2 instead of MaxMind. Stamps
  // `source_version = <full sha256>` on success so the next Sunday
  // auto-poll's skip-if-current check matches and no-ops.
  //
  // Returns 202 Accepted with the workflow instance ID — the
  // import takes ~30 minutes to complete. Operator polls
  // `/api/admin/geoip-status` to track progress.
  router.post("/api/admin/geoip/import-from-r2", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;

    const url = new URL(request.url);
    const r2Key = url.searchParams.get("key");
    const sha256 = url.searchParams.get("sha256");
    if (!r2Key) {
      return new Response(JSON.stringify({ success: false, error: "missing required ?key=<r2-object-key>" }),
        { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (!sha256 || !/^[0-9a-f]{40,}$/i.test(sha256)) {
      return new Response(JSON.stringify({ success: false, error: "missing or malformed ?sha256=<full-hex> (from MaxMind .zip.sha256)" }),
        { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (!env.GEOIP_STAGING) {
      return new Response(JSON.stringify({ success: false, error: "GEOIP_STAGING (R2) binding not configured. Add `[[r2_buckets]]` to wrangler.toml and redeploy." }),
        { status: 503, headers: { "Content-Type": "application/json" } });
    }
    if (!env.GEOIP_REFRESH) {
      return new Response(JSON.stringify({ success: false, error: "GEOIP_REFRESH (Workflow) binding not configured." }),
        { status: 503, headers: { "Content-Type": "application/json" } });
    }
    if (!env.GEOIP_DB) {
      return new Response(JSON.stringify({ success: false, error: "GEOIP_DB (D1) binding not configured." }),
        { status: 503, headers: { "Content-Type": "application/json" } });
    }

    // Verify the R2 object exists before opening a refresh log row.
    const head = await env.GEOIP_STAGING.head(r2Key).catch(() => null);
    if (!head) {
      return new Response(JSON.stringify({
        success: false,
        error: `R2 object not found at GEOIP_STAGING/${r2Key}. Upload first via \`wrangler r2 object put geoip-staging/${r2Key} --file=...\`.`,
      }), { status: 404, headers: { "Content-Type": "application/json" } });
    }

    const refreshId = `geoip_refresh_r2_${Date.now()}`;
    try {
      await env.GEOIP_DB.prepare(`
        INSERT INTO geo_ip_refresh_log (id, source, status, started_at, source_version, error_message)
        VALUES (?, 'maxmind-geolite2-city', 'running', datetime('now'), ?, ?)
      `).bind(
        refreshId,
        sha256.slice(0, 12),
        `Manual R2 import: key=${r2Key} size=${head.size}b sha256=${sha256.slice(0, 12)}...`,
      ).run();
    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: `Failed to open refresh log row: ${err instanceof Error ? err.message : String(err)}. ` +
               `Likely the geoip-db migrations haven't been applied — run \`wrangler d1 migrations apply geoip-db --remote\`.`,
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    let workflowInstanceId: string;
    try {
      const instance = await env.GEOIP_REFRESH.create({
        params: { refreshLogId: refreshId, r2Key, r2Sha256: sha256, forceReload: true },
      });
      workflowInstanceId = instance.id;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        await env.GEOIP_DB.prepare(`
          UPDATE geo_ip_refresh_log
          SET status = 'failed', completed_at = datetime('now'), error_message = ?
          WHERE id = ?
        `).bind(`Workflow dispatch failed: ${errMsg}`, refreshId).run();
      } catch { /* best-effort */ }
      return new Response(JSON.stringify({ success: false, error: `Workflow dispatch failed: ${errMsg}` }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      success: true,
      data: {
        refresh_log_id: refreshId,
        workflow_instance_id: workflowInstanceId,
        r2_key: r2Key,
        r2_size_bytes: head.size,
        sha256_first12: sha256.slice(0, 12),
        message: "Workflow dispatched. Import takes ~30 minutes. Poll /api/admin/geoip-status to track progress.",
      },
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  });

  router.get("/api/admin/geoip-status", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { getGeoMmdbStatus } = await import("../lib/geoip-mmdb");
    const status = await getGeoMmdbStatus(env);
    return new Response(JSON.stringify({ success: true, data: status }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  router.post("/api/admin/backfill-brand-match", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillBrandMatch(request, env);
  });
  // Tier 1 alert auto-triage backfill — drains the queue of 'new'
  // alerts that meet the conservative auto-dismiss criteria
  // (vt_checked + vt_malicious=0, gsb_checked + gsb_flagged=0,
  // greynoise=benign-or-null, seclookup<30). Idempotent: each call
  // processes up to `?limit=N` alerts (default 500) and stamps them
  // as `false_positive` with the rule-name in resolution_notes.
  // Operators run repeatedly until `scanned < limit` (queue drained).
  // See lib/alert-triage.ts for the rule definition.
  // Tier 3 — AI second-opinion on alerts that survived rule-based
  // triage. Calls Haiku once per alert, stamps the verdict +
  // reasoning into ai_assessment, and auto-dismisses only when the
  // AI says `likely_safe` with confidence >= 90. Bounded batch
  // size keeps AI cost predictable. Idempotent — alerts with
  // ai_assessment already set are skipped, so re-running is a
  // no-op for already-judged alerts. See lib/alert-ai-judge.ts.
  // Reconcile bell notifications against recently auto-dismissed
  // alerts. The two tables aren't FK-linked so this is a
  // brand_id + time-window heuristic; clears notifications where
  // their underlying alert has been auto-triaged. See
  // lib/notification-cleanup.ts for the correlation strategy.
  router.post("/api/admin/notifications/cleanup-dismissed", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;

    const url = new URL(request.url);
    const lookbackParam = url.searchParams.get('lookback_hours');
    const windowParam = url.searchParams.get('window_minutes');
    const limitParam = url.searchParams.get('limit');

    const opts: { lookbackHours?: number; windowMinutes?: number; limit?: number } = {};
    if (lookbackParam) opts.lookbackHours = Math.max(1, Math.min(720, parseInt(lookbackParam, 10)));
    if (windowParam) opts.windowMinutes = Math.max(1, Math.min(1440, parseInt(windowParam, 10)));
    if (limitParam) opts.limit = Math.max(1, Math.min(2000, parseInt(limitParam, 10)));

    try {
      const { reconcileNotificationsForDismissedAlerts } = await import("../lib/notification-cleanup");
      const result = await reconcileNotificationsForDismissedAlerts(env.DB, opts);
      return new Response(JSON.stringify({ success: true, data: result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ success: false, error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  router.post("/api/admin/alerts/run-ai-judge", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;

    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10))) : 50;
    const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;

    try {
      const { runAlertJudgeBackfill } = await import("../lib/alert-ai-judge");
      const result = await runAlertJudgeBackfill(env, { limit, offset });
      return new Response(JSON.stringify({ success: true, data: result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ success: false, error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // Abuse Mailbox AI classifier — operator runs this to classify the
  // pending pile after the Email Worker drops new rows in. Idempotent
  // on retry; parse-failure rows stay in 'pending'.
  router.post("/api/admin/abuse-mailbox/run-classifier", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;

    const url = new URL(request.url);
    const limitParam  = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit  = limitParam  ? Math.max(1, Math.min(200, parseInt(limitParam,  10))) : 50;
    const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;

    try {
      const { runAbuseClassifierBackfill } = await import("../lib/abuse-mailbox-classifier");
      const result = await runAbuseClassifierBackfill(env, { limit, offset });
      return new Response(JSON.stringify({ success: true, data: result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ success: false, error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });

  // PR-AT — manual unthrottle. Clears the rate-limit flag on a specific
  // message so the next classifier backfill pass picks it up. Useful
  // when a legit submitter happens to share a sending domain with a
  // bad actor, or when an operator wants to inspect a throttled flood
  // sample after review.
  router.post("/api/admin/abuse-mailbox/messages/:id/unthrottle", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const id = request.params["id"] ?? "";
    if (!id || id.length > 64) {
      return new Response(JSON.stringify({ success: false, error: "Invalid message id" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const res = await env.DB.prepare(
      `UPDATE abuse_inbox_messages
       SET throttled = 0, throttle_reason = NULL, updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(id).run();
    return new Response(JSON.stringify({
      success: true,
      data: { id, rows_changed: res.meta?.changes ?? 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  router.post("/api/admin/alerts/backfill-triage", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;

    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const thresholdParam = url.searchParams.get('threshold');
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10))) : 500;
    const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;
    const impersonationThreshold = thresholdParam ? Number(thresholdParam) : undefined;

    try {
      const { runAlertTriageBackfill } = await import("../lib/alert-triage");
      const result = await runAlertTriageBackfill(env.DB, { limit, offset, impersonationThreshold });
      return new Response(JSON.stringify({ success: true, data: result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ success: false, error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  });
  router.post("/api/admin/backfill-brand-enrichment", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillBrandEnrichment(request, env);
  });
  router.post("/api/admin/backfill-brand-sector", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillBrandSector(request, env);
  });
  router.post("/api/admin/backfill-safe-domains", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillSafeDomains(request, env);
  });
  router.post("/api/admin/backfill-ai-attribution", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillAiAttribution(request, env);
  });
  router.post("/api/admin/import-tranco", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleImportTranco(request, env);
  });
  router.post("/api/admin/brand-scores/recompute-all", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleRecomputeBrandScores } = await import("../handlers/admin");
    return handleRecomputeBrandScores(request, env);
  });
  router.post("/api/admin/brand-firmographics/enrich", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleBackfillBrandFirmographics } = await import("../handlers/admin");
    return handleBackfillBrandFirmographics(request, env);
  });
  router.get("/api/admin/brand-candidates", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleListBrandCandidates } = await import("../handlers/admin");
    return handleListBrandCandidates(request, env);
  });
  router.post("/api/admin/brand-candidates/aggregate", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleAggregateBrandCandidates } = await import("../handlers/admin");
    return handleAggregateBrandCandidates(request, env);
  });
  router.post("/api/admin/brand-candidates/:id/promote", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handlePromoteBrandCandidate } = await import("../handlers/admin");
    return handlePromoteBrandCandidate(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/admin/brand-candidates/:id/reject", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const { handleRejectBrandCandidate } = await import("../handlers/admin");
    return handleRejectBrandCandidate(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/admin/backfill-social-config", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBackfillSocialConfig(request, env);
  });
  router.post("/api/admin/cube-backfill", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleCubeBackfill(request, env);
  });

  // ─── Brand Administration ─────────────────────────────────────────
  router.get("/api/admin/brands", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAdminListBrands(request, env);
  });
  router.post("/api/admin/brands/bulk-monitor", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBulkMonitor(request, env, ctx.userId);
  });
  router.post("/api/admin/brands/bulk-delete", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBulkDeleteBrands(request, env, ctx.userId);
  });

  // ─── Social Discovery Batch ───────────────────────────────────────
  router.post("/api/admin/discover-social-batch", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    try {
      const body = await request.json().catch(() => ({})) as { limit?: number };
      const limit = Math.min(Math.max(body.limit ?? 10, 1), 50);
      const { runSocialDiscoveryBatch } = await import("../scanners/social-monitor");
      const result = await runSocialDiscoveryBatch(env, limit);
      return json({ success: true, data: result });
    } catch (err) {
      return json({ success: false, error: "An internal error occurred" }, 500);
    }
  });

  // ─── AI Budget Management ─────────────────────────────────────────
  router.get("/api/admin/budget/status", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBudgetStatus(request, env);
  });
  router.get("/api/admin/budget/breakdown", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBudgetBreakdown(request, env);
  });
  router.patch("/api/admin/budget/config", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBudgetConfigPatch(request, env);
  });

  // ─── Enrichment Utilities ─────────────────────────────────────────
  router.post("/api/threats/enrich-geo", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleEnrichGeo(request, env);
  });
  router.post("/api/threats/enrich-all", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleEnrichAll(request, env);
  });
  router.post("/api/snapshots/generate", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDailySnapshots(request, env);
  });

  // ─── Honeypot Site Generator ──────────────────────────────────────
  router.post("/api/admin/honeypot/generate", async (request: Request, env: Env) => {
    const ctx = await requireAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;

    const body = await request.json() as {
      hostname: string;
      businessName: string;
      businessType: string;
      city: string;
      seedCount?: number;
    };

    if (!body.hostname || !body.businessName || !body.businessType || !body.city) {
      return Response.json({ success: false, error: "Missing required fields: hostname, businessName, businessType, city" }, { status: 400 });
    }

    const seedCount = body.seedCount || 5;

    try {
      // Phase 3.6 of agent audit: honeypot rendering is now a sync
      // agent. Address synthesis stays as pure helpers (no AI), only
      // the three Haiku page renders go through the runner so the
      // lifecycle is observable via agent_runs.
      const { generateTrapAddresses, generateTeamMembers } = await import("../honeypot-generator");
      const { runSyncAgent } = await import("../lib/agentRunner");
      const { honeypotGeneratorAgent } = await import("../agents/honeypot-generator");

      const traps = generateTrapAddresses(body.hostname, seedCount);
      const trapAddresses = traps.map(t => ({ address: t.address, role: t.role }));
      const teamMembers = generateTeamMembers(body.hostname, trapAddresses, Math.min(seedCount, 5));

      const agentRun = await runSyncAgent<{
        index: string; contact: string; team: string; sitemap: string; robots: string;
      }>(env, honeypotGeneratorAgent, {
        hostname: body.hostname,
        businessName: body.businessName,
        businessType: body.businessType,
        city: body.city,
        trapAddresses,
        teamMembers,
      });

      if (!agentRun.data) {
        return Response.json(
          { success: false, error: agentRun.error ?? "Honeypot site generation failed" },
          { status: 500 },
        );
      }
      const site = agentRun.data;

      await Promise.all([
        env.CACHE.put(`honeypot-site:${body.hostname}:index`, site.index, { expirationTtl: 86400 * 365 }),
        env.CACHE.put(`honeypot-site:${body.hostname}:contact`, site.contact, { expirationTtl: 86400 * 365 }),
        env.CACHE.put(`honeypot-site:${body.hostname}:team`, site.team, { expirationTtl: 86400 * 365 }),
        env.CACHE.put(`honeypot-site:${body.hostname}:sitemap`, site.sitemap, { expirationTtl: 86400 * 365 }),
        env.CACHE.put(`honeypot-site:${body.hostname}:robots`, site.robots, { expirationTtl: 86400 * 365 }),
      ]);

      const existingDomains = await env.CACHE.get("honeypot:domains").then(
        v => v ? JSON.parse(v) as string[] : [],
      ).catch(() => [] as string[]);
      if (!existingDomains.includes(body.hostname)) {
        existingDomains.push(body.hostname);
        await env.CACHE.put("honeypot:domains", JSON.stringify(existingDomains), { expirationTtl: 86400 * 365 });
      }

      const campaignId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO seed_campaigns (id, name, channel, status, addresses_seeded, created_at)
         VALUES (?, ?, 'honeypot', 'active', ?, datetime('now'))`
      ).bind(campaignId, `Honeypot: ${body.hostname}`, seedCount).run();

      for (const trap of traps) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO seed_addresses (address, domain, channel, campaign_id, is_active, seeded_at, total_catches)
           VALUES (?, ?, 'honeypot', ?, 1, datetime('now'), 0)`
        ).bind(trap.address, body.hostname, campaignId).run();
      }

      try {
        await env.AUDIT_DB.prepare(
          `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, outcome, details, ip_address, timestamp)
           VALUES (?, ?, 'honeypot_generate', 'honeypot', ?, 'success', ?, ?, datetime('now'))`
        ).bind(
          crypto.randomUUID(),
          ctx.userId,
          body.hostname,
          JSON.stringify({ seedCount, businessName: body.businessName }),
          request.headers.get("CF-Connecting-IP") || "unknown",
        ).run();
      } catch { /* non-fatal */ }

      return Response.json({
        success: true,
        data: {
          hostname: body.hostname,
          pages: ["index", "contact", "team", "sitemap", "robots"],
          seedAddresses: traps.map(t => t.address),
          campaignId,
          teamMembers: teamMembers.map(m => ({ name: m.name, title: m.title, email: m.email })),
        },
      });
    } catch (err) {
      console.error("[honeypot-generate] error:", err);
      return Response.json({ success: false, error: "An internal error occurred" }, { status: 500 });
    }
  });

  // ─── Web Push admin (super_admin only) ───────────────────────────
  // Bootstrap + ops endpoints for the Web Push backend introduced in PR 3a.
  // See handlers/adminPush.ts for the operator runbook in the file header.
  router.post("/api/admin/push/generate-vapid-keys", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGenerateVapidKeys(request, env);
  });
  router.get("/api/admin/push/config", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetPushConfig(request, env);
  });
  router.put("/api/admin/push/config", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdatePushConfig(request, env);
  });
  router.post("/api/admin/push/test", async (request: Request, env: Env) => {
    const ctx = await requireSuperAdmin(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePushTest(request, env, ctx.userId);
  });
}
