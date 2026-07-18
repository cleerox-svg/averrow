import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, requireStaff, requireStaffMutation, isAuthContext, getOrgScope } from "../middleware/auth";
import { handleStats, handleSourceMix, handleQualityTrend } from "../handlers/stats";
import { handleHeatmap } from "../handlers/heatmap";
import {
  handleObservatoryNodes, handleObservatoryArcs, handleObservatoryLive,
  handleObservatoryBrandArcs, handleObservatoryStats, handleObservatoryOperations,
} from "../handlers/observatory";
import { handleDashboardOverview, handleDashboardTopBrands, handleDashboardProviders } from "../handlers/dashboard";
import { handleBrandAdminDashboard } from "../handlers/brandAdminDashboard";
import { handleSignals, handleIngestSignal } from "../handlers/signals";
import { handleListAlerts, handleGetAlert, handleUpdateAlert, handleAlertStats, handleBulkAcknowledge, handleBulkTakedown, handleAlertTriageSummary } from "../handlers/alerts";
import {
  handleListNotificationsV2, handleMarkNotificationReadV2, handleMarkAllNotificationsReadV2,
  handleUnreadCount, handleGetPreferences, handleUpdatePreferences,
  handleSnoozeNotification, handleMarkDone,
  handleGetPreferencesV2, handleUpdatePreferencesV2,
  handleListSubscriptions, handleUpdateSubscription, handleDeleteSubscription,
} from "../handlers/notifications";
import {
  handleSubscribePush, handleUnsubscribePush, handleUnsubscribeByEndpoint,
  handleGetNotificationConfig, handleListPushSubscriptions,
  handleTestNotification,
} from "../handlers/push";
import { handleLatestInsights } from "../handlers/insights";
import {
  handleTrendVolume, handleTrendBrands, handleTrendProviders,
  handleTrendTLDs, handleTrendTypes, handleTrendCompare,
  handleTrendIntelligence, handleTrendThreatVolume, handleTrendBrandMomentum,
  handleTrendProviderMomentum, handleTrendNexusActive,
} from "../handlers/trends";

export function registerDashboardRoutes(router: RouterType<IRequest>): void {
  // ─── Dashboard Stats (v1) ─────────────────────────────────────────
  router.get("/api/dashboard/stats", (request: Request, env: Env) => handleStats(request, env));
  router.get("/api/dashboard/sources", (request: Request, env: Env) => handleSourceMix(request, env));
  router.get("/api/dashboard/trend", (request: Request, env: Env) => handleQualityTrend(request, env));

  // ─── Dashboard v2 (Observatory) ───────────────────────────────────
  router.get("/api/dashboard/overview", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleDashboardOverview(request, env, scope);
  });
  router.get("/api/dashboard/top-brands", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleDashboardTopBrands(request, env, scope);
  });
  router.get("/api/dashboard/providers", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDashboardProviders(request, env);
  });

  // ─── Brand Admin Dashboard (scoped) ───────────────────────────────
  router.get("/api/dashboard/brand-admin", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    if (!scope) {
      // Super admins should use the full dashboard
      return handleDashboardOverview(request, env);
    }
    return handleBrandAdminDashboard(request, env, scope);
  });

  // ─── Public Heatmap ───────────────────────────────────────────────
  router.get("/api/heatmap", (request: Request, env: Env) => handleHeatmap(request, env));

  // ─── Observatory (unauthenticated) ────────────────────────────────
  router.get("/api/observatory/nodes",      (request: Request, env: Env) => handleObservatoryNodes(request, env));
  router.get("/api/observatory/arcs",       (request: Request, env: Env) => handleObservatoryArcs(request, env));
  router.get("/api/observatory/live",       (request: Request, env: Env) => handleObservatoryLive(request, env));
  router.get("/api/observatory/brand-arcs", (request: Request, env: Env) => handleObservatoryBrandArcs(request, env));
  router.get("/api/observatory/stats",      (request: Request, env: Env) => handleObservatoryStats(request, env));
  router.get("/api/observatory/operations", (request: Request, env: Env) => handleObservatoryOperations(request, env));

  // ─── Signals ──────────────────────────────────────────────────────
  router.get("/api/signals", (request: Request, env: Env) => handleSignals(request, env));
  router.post("/api/signals", async (request: Request, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleIngestSignal(request, env, ctx.userId);
  });

  // ─── Alerts ───────────────────────────────────────────────────────
  // Staff-only surface (H1, 2026-06-10 audit). Tenant alerts live at
  // /api/orgs/:orgId/alerts (handlers/tenantData.ts) and are unaffected.
  router.get("/api/alerts/stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAlertStats(request, env, ctx.userId);
  });
  router.get("/api/alerts/triage-summary", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleAlertTriageSummary(request, env, ctx.userId);
  });
  // H2: by-id read/update thread the caller's userId + org scope so the
  // handlers apply the same ownership predicates as handleListAlerts.
  router.get("/api/alerts/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleGetAlert(request, env, request.params["id"] ?? "", ctx.userId, scope);
  });
  router.patch("/api/alerts/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleUpdateAlert(request, env, request.params["id"] ?? "", ctx.userId, scope);
  });
  router.get("/api/alerts", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleListAlerts(request, env, ctx.userId, scope);
  });
  router.post("/api/alerts/bulk-acknowledge", async (request: Request, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBulkAcknowledge(request, env, ctx.userId);
  });
  router.post("/api/alerts/bulk-takedown", async (request: Request, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleBulkTakedown(request, env, ctx.userId);
  });

  // ─── Notifications ────────────────────────────────────────────────
  router.get("/api/notifications", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListNotificationsV2(request, env, ctx.userId);
  });
  router.post("/api/notifications/:id/read", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMarkNotificationReadV2(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/notifications/read-all", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMarkAllNotificationsReadV2(request, env, ctx.userId);
  });
  router.post("/api/notifications/:id/snooze", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSnoozeNotification(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/notifications/:id/done", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMarkDone(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.get("/api/notifications/unread-count", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUnreadCount(request, env, ctx.userId);
  });
  router.get("/api/notifications/preferences", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetPreferences(request, env, ctx.userId);
  });
  router.patch("/api/notifications/preferences", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdatePreferences(request, env, ctx.userId);
  });

  // ─── N5: preferences_v2 — per-channel severity floors + digest mode ─
  router.get("/api/notifications/preferences/v2", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetPreferencesV2(request, env, ctx.userId);
  });
  router.put("/api/notifications/preferences/v2", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdatePreferencesV2(request, env, ctx.userId);
  });

  // ─── N5: subscriptions — per-user × per-brand watch level ───────────
  router.get("/api/notifications/subscriptions", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListSubscriptions(request, env, ctx.userId);
  });
  router.put("/api/notifications/subscriptions/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateSubscription(request, env, request.params["brandId"] ?? "", ctx.userId);
  });
  router.delete("/api/notifications/subscriptions/:brandId", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeleteSubscription(request, env, request.params["brandId"] ?? "", ctx.userId);
  });

  // ─── Web Push (mounted as /api/notifications/* per the FarmTrack
  // ↔ Averrow login standardization). The SPA's PushManager.subscribe
  // call POSTs the resulting subscription here so the dispatcher in
  // lib/notifications.ts knows where to send pushes for this user.
  // See lib/push.ts for the encryption + VAPID details.
  router.get("/api/notifications/config", async (request: Request, env: Env) => {
    return handleGetNotificationConfig(request, env);
  });
  // GET /api/notifications/devices — caller's push devices (push_subscriptions
  // table). Distinct from /api/notifications/subscriptions which lists the
  // per-brand notification_subscriptions watch levels. The two endpoints
  // collided on the same path until the device list moved here.
  router.get("/api/notifications/devices", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListPushSubscriptions(request, env, ctx.userId);
  });
  router.post("/api/notifications/subscribe", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSubscribePush(request, env, ctx.userId);
  });
  router.delete("/api/notifications/unsubscribe", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUnsubscribeByEndpoint(request, env, ctx.userId);
  });
  router.delete("/api/notifications/subscribe/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUnsubscribePush(request, env, request.params["id"] ?? "", ctx.userId);
  });
  router.post("/api/notifications/test", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTestNotification(request, env, ctx.userId);
  });

  // ─── Insights ─────────────────────────────────────────────────────
  router.get("/api/insights/latest", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleLatestInsights(request, env);
  });

  // ─── Trends ───────────────────────────────────────────────────────
  router.get("/api/trends/volume", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendVolume(request, env);
  });
  router.get("/api/trends/brands", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendBrands(request, env);
  });
  router.get("/api/trends/providers", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendProviders(request, env);
  });
  router.get("/api/trends/tlds", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendTLDs(request, env);
  });
  router.get("/api/trends/types", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendTypes(request, env);
  });
  router.get("/api/trends/compare", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendCompare(request, env);
  });

  // ─── Trend Intelligence ───────────────────────────────────────────
  router.get("/api/trends/intelligence", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendIntelligence(request, env);
  });
  router.get("/api/trends/threat-volume", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendThreatVolume(request, env);
  });
  router.get("/api/trends/brand-momentum", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendBrandMomentum(request, env);
  });
  router.get("/api/trends/provider-momentum", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendProviderMomentum(request, env);
  });
  router.get("/api/trends/nexus-active", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleTrendNexusActive(request, env);
  });
}
