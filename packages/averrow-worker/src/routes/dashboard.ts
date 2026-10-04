import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, requireStaff, requireStaffMutation, isAuthContext, getOrgScope, requirePermission } from "../middleware/auth";
import { roleHasPermission } from "../lib/role-permissions";
import { json } from "../lib/cors";
import { handleStats, handleSourceMix, handleQualityTrend } from "../handlers/stats";
import {
  handleObservatoryNodes, handleObservatoryArcs, handleObservatoryLive,
  handleObservatoryBrandArcs, handleObservatoryStats, handleObservatoryOperations,
  handleObservatoryHeatmap,
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
import {
  handleTrendVolume, handleTrendBrands, handleTrendProviders,
  handleTrendTLDs, handleTrendTypes, handleTrendCompare,
  handleTrendIntelligence, handleTrendThreatVolume, handleTrendBrandMomentum,
  handleTrendProviderMomentum, handleTrendNexusActive,
} from "../handlers/trends";

export function registerDashboardRoutes(router: RouterType<IRequest>): void {
  // ─── Dashboard Stats (v1) ─────────────────────────────────────────
  // Staff-only. These were registered with no auth check. They only return
  // platform-wide aggregates over the `scans` table, but no UI calls them
  // any more (ops, tenant, marketing, worker templates and the legacy SPA
  // were all checked), so they are gated, not left public. requireStaff
  // lets the read-only auditor seat through. The public aggregate is
  // /api/stats/public (or /api/v1/public/stats).
  router.get("/api/dashboard/stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleStats(request, env);
  });
  router.get("/api/dashboard/sources", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSourceMix(request, env);
  });
  router.get("/api/dashboard/trend", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleQualityTrend(request, env);
  });

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

  // /api/heatmap (the scan-submitter heatmap) was removed in PR-E: scans no
  // longer store requester IP or coordinates, and nothing called it. The
  // path now falls through to the /api/* 404 catch-all. The public threat
  // map is /api/observatory/heatmap.

  // ─── Observatory (staff-only) ──────────────────────────────────────
  // Formerly unauthenticated. `/live` returns recent malicious
  // domains/URLs with the targeted brand's name, `/arcs` carries
  // `brand_name` per corridor, and `/brand-arcs?brand_id=` accepted any
  // brand id — together they let an anonymous caller learn which
  // customer brands are under attack. The only callers are the staff
  // ops SPA (averrow-ops, Bearer JWT), the frozen legacy SPA (sends its
  // Bearer token), the MCP smoke probe (service JWT, `auditor` role —
  // passes requireStaff) and Navigator's cache pre-warm (calls the
  // handlers directly, not through these routes). No public/marketing
  // surface or tenant SPA calls them, so every route is gated with
  // requireStaff and the KV cache keys (`observatory_*`) only ever back
  // a staff audience — no public/staff response mixing.
  // Pinned by test/observatory-routes-auth.test.ts.
  const observatoryRoutes: ReadonlyArray<[string, (request: Request, env: Env) => Promise<Response>]> = [
    ["/api/observatory/nodes",      handleObservatoryNodes],
    ["/api/observatory/arcs",       handleObservatoryArcs],
    ["/api/observatory/live",       handleObservatoryLive],
    ["/api/observatory/brand-arcs", handleObservatoryBrandArcs],
    ["/api/observatory/stats",      handleObservatoryStats],
    ["/api/observatory/heatmap",    handleObservatoryHeatmap],
    ["/api/observatory/operations", handleObservatoryOperations],
  ];
  for (const [path, handler] of observatoryRoutes) {
    router.get(path, async (request: Request, env: Env) => {
      const ctx = await requireStaff(request, env);
      if (!isAuthContext(ctx)) return ctx;
      return handler(request, env);
    });
  }

  // ─── Signals ──────────────────────────────────────────────────────
  // GET is staff-only (appsec, 2026-10): handleSignals reads the GLOBAL
  // `scans` table — every user's scans plus anonymous homepage scans — so
  // it must never be reachable unauthenticated or by a tenant `client`.
  // No first-party UI calls it; requireStaff admits auditor (read-only).
  router.get("/api/signals", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleSignals(request, env);
  });
  router.post("/api/signals", async (request: Request, env: Env) => {
    const ctx = await requireStaffMutation(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleIngestSignal(request, env, ctx.userId);
  });

  // ─── Alerts ───────────────────────────────────────────────────────
  // Staff-only surface (H1, 2026-06-10 audit). Tenant alerts live at
  // /api/orgs/:orgId/alerts (handlers/tenantData.ts) and are unaffected.
  //
  // PR-C (owner decision 2026-10-04): platform-wide for staff — getOrgScope
  // returns null for every staff role (isPlatformStaff), so the handlers
  // apply no filter. Reads use the staff guard (every staff role, incl.
  // auditor).
  // Mutations: requirePermission('edit_alerts') — super_admin, admin,
  // analyst, support (lib/role-permissions.ts); sales, billing, auditor and
  // client get 403. bulk-takedown additionally needs manage_takedowns. Stricter than requireStaffMutation, so the
  // staff-mutation-routes pin accepts it.
  router.get("/api/alerts/stats", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleAlertStats(request, env, scope);
  });
  router.get("/api/alerts/triage-summary", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleAlertTriageSummary(request, env, scope);
  });
  router.get("/api/alerts/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleGetAlert(request, env, request.params["id"] ?? "", scope);
  });
  router.patch("/api/alerts/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requirePermission("edit_alerts")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleUpdateAlert(request, env, request.params["id"] ?? "", ctx.userId, scope);
  });
  router.get("/api/alerts", async (request: Request, env: Env) => {
    const ctx = await requireStaff(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleListAlerts(request, env, scope);
  });
  router.post("/api/alerts/bulk-acknowledge", async (request: Request, env: Env) => {
    const ctx = await requirePermission("edit_alerts")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    const scope = await getOrgScope(ctx, env.DB);
    return handleBulkAcknowledge(request, env, ctx.userId, scope);
  });
  // bulk-takedown also creates takedown_requests, so it needs BOTH
  // edit_alerts and manage_takedowns (super_admin, admin, analyst). support
  // holds edit_alerts but not manage_takedowns → 403.
  router.post("/api/alerts/bulk-takedown", async (request: Request, env: Env) => {
    const ctx = await requirePermission("edit_alerts")(request, env);
    if (!isAuthContext(ctx)) return ctx;
    if (!roleHasPermission(ctx.role, "manage_takedowns")) {
      return json(
        { success: false, error: "Forbidden: requires 'manage_takedowns' permission" },
        403,
        request.headers.get("Origin"),
      );
    }
    const scope = await getOrgScope(ctx, env.DB);
    return handleBulkTakedown(request, env, ctx.userId, scope);
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
    return handleUpdateSubscription(request, env, request.params["brandId"] ?? "", ctx.userId, ctx.role);
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
