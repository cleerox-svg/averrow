// Averrow Trust Radar — Cloudflare Worker entry point
import { Router } from "itty-router";
import { handleOptions } from "./lib/cors";
import { applySecurityHeaders } from "./middleware/security";
import { handleDmarcEmail } from "./dmarc-receiver";
import type { EmailMessage } from "./dmarc-receiver";
import { handleSpamTrapEmail } from "./spam-trap";
import { serveHoneypotPage } from "./honeypot";
import { serveLrxRadarPage } from "./templates/honeypot-lrx";
import { renderAdminPortalPage, renderInternalStaffPage } from "./templates/honeypot-pages";
import { logHoneypotVisit } from "./lib/honeypot-visit-logger";
import type { Env } from "./types";
import { handleScheduled } from "./cron/orchestrator";

// ─── Route modules ──────────────────────────────────────────────────
import { registerPublicRoutes } from "./routes/public";
import { registerAuthRoutes } from "./routes/auth";
import { registerScanRoutes } from "./routes/scan";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerBrandRoutes } from "./routes/brands";
import { registerThreatRoutes } from "./routes/threats";
import { registerInvestigationRoutes } from "./routes/investigations";
import { registerAdminRoutes } from "./routes/admin";
import { registerTenantRoutes } from "./routes/tenant";
import { registerStripeRoutes } from "./routes/stripe";
import { registerAgentRoutes } from "./routes/agents";
import { registerSpamTrapRoutes } from "./routes/spam-trap";
import { registerEmailSecurityRoutes } from "./routes/email-security";
import { registerFeedRoutes } from "./routes/feeds";
import { registerExportRoutes } from "./routes/export";
import { registerSparrowRoutes } from "./routes/sparrow";
import { registerThreatActorRoutes } from "./routes/threatActors";

export { ThreatPushHub } from "./durableObjects/ThreatPushHub";
export { CertStreamMonitor } from "./durableObjects/CertStreamMonitor";
export { CartographerBackfillWorkflow } from "./workflows/cartographerBackfill";
export { CartographerMainWorkflow } from "./workflows/cartographerMain";
export { NexusWorkflow } from "./workflows/nexusRun";
export { GeoipRefreshWorkflow } from "./workflows/geoipRefresh";

// ─── Honeypot Domain Server ─────────────────────────────────────────
async function serveHoneypotDomain(url: URL, env: Env): Promise<Response> {
  const hostname = url.hostname;
  const path = url.pathname;

  const pageMap: Record<string, string> = {
    "/": "index", "/contact": "contact", "/team": "team", "/about": "team",
    "/robots.txt": "robots", "/sitemap.xml": "sitemap",
  };
  const page = pageMap[path];
  if (!page) return new Response("Not Found", { status: 404 });

  const kvKey = `honeypot-site:${hostname}:${page}`;
  const content = await env.CACHE.get(kvKey);
  if (!content) return new Response("Not Found", { status: 404 });

  const contentType = page === "sitemap"
    ? "application/xml"
    : page === "robots"
      ? "text/plain"
      : "text/html";

  return new Response(content, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
}

// ─── Router setup ────────────────────────────────────────────────────
const router = Router();

// CORS preflight
router.options("*", (request: Request) => handleOptions(request));

// Register all route modules
registerAuthRoutes(router);
registerScanRoutes(router);
registerDashboardRoutes(router);
registerBrandRoutes(router);
registerThreatRoutes(router);
registerInvestigationRoutes(router);
registerFeedRoutes(router);
registerExportRoutes(router);
registerAgentRoutes(router);
registerSpamTrapRoutes(router);
registerSparrowRoutes(router);
registerThreatActorRoutes(router);
registerEmailSecurityRoutes(router);
registerTenantRoutes(router);
registerStripeRoutes(router);
registerAdminRoutes(router);
// Public routes + SPA fallback must be last
registerPublicRoutes(router);

// ─── Worker export ───────────────────────────────────────────────────
export default {
  scheduled: handleScheduled,

  // Legacy queue consumer drain — kept until Cloudflare-side consumer
  // relationship is deregistered via CLI (see wrangler.toml comments).
  async queue(
    batch: MessageBatch<unknown>,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    for (const msg of batch.messages) {
      msg.ack();
    }
  },

  async email(message: { from: string; to: string; headers: Headers; raw: ReadableStream<Uint8Array>; rawSize: number; setReject(r: string): void; forward(to: string, headers?: Headers): Promise<void> }, env: Env, ctx: ExecutionContext): Promise<void> {
    // Accept ALL emails — never reject/bounce (Google/Microsoft stop sending on bounces)
    const to = message.to;

    if (to === "dmarc_rua@averrow.com" || to === "dmarc_rua@trustradar.ca") {
      ctx.waitUntil(handleDmarcEmail(message, env));
      return;
    }

    // Abuse Mailbox: customer-tenant aliases like
    // verify-acme@averrow.com or report-acme@averrow.com.
    // Resolved per-org via org_abuse_aliases.
    const localPart = (to.split("@")[0] ?? "").toLowerCase();
    if (localPart.startsWith("verify-") || localPart.startsWith("verify_") ||
        localPart.startsWith("report-") || localPart.startsWith("abuse-")) {
      const { handleAbuseMailboxEmail } = await import("./handlers/abuseMailboxEmail");
      ctx.waitUntil(handleAbuseMailboxEmail(message, env));
      return;
    }

    ctx.waitUntil(handleSpamTrapEmail(message as unknown as EmailMessage, env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // www → non-www redirect for averrow.com
      if (url.hostname === "www.averrow.com" && !url.pathname.startsWith("/api/")) {
        return Response.redirect(`https://averrow.com${url.pathname}${url.search}`, 301);
      }
      // averrow.ca → averrow.com redirect
      if ((url.hostname === "averrow.ca" || url.hostname === "www.averrow.ca") && !url.pathname.startsWith("/api/")) {
        return Response.redirect(`https://averrow.com${url.pathname}${url.search}`, 301);
      }
      // Legacy trustradar.ca → averrow.com 301 redirect
      if ((url.hostname === "trustradar.ca" || url.hostname === "www.trustradar.ca") && !url.pathname.startsWith("/api/")) {
        return Response.redirect(`https://averrow.com${url.pathname}${url.search}`, 301);
      }
      // www.lrxradar.com → lrxradar.com redirect
      if (url.hostname === "www.lrxradar.com" && !url.pathname.startsWith("/api/")) {
        return Response.redirect(`https://lrxradar.com${url.pathname}${url.search}`, 301);
      }

      // Honeypot domain routing — serve KV-stored sites for throwaway domains
      const knownDomains = ["averrow.com", "www.averrow.com", "averrow.ca", "www.averrow.ca", "trustradar.ca", "www.trustradar.ca", "lrxradar.com", "www.lrxradar.com"];
      if (!knownDomains.includes(url.hostname)) {
        const honeypotDomains = await env.CACHE.get("honeypot:domains").then(
          v => v ? JSON.parse(v) as string[] : [],
        ).catch(() => [] as string[]);
        if (honeypotDomains.includes(url.hostname)) {
          return applySecurityHeaders(await serveHoneypotDomain(url, env));
        }
      }

      // lrxradar.com serves as a full honeypot site
      if (url.hostname === "lrxradar.com") {
        ctx.waitUntil(logHoneypotVisit(env, request, `lrxradar:${url.pathname}`));
        return applySecurityHeaders(serveLrxRadarPage(url.pathname));
      }

      // Honeypot pages on averrow.com — /team, /careers, /admin-portal, /internal-staff
      if (["averrow.com", "www.averrow.com"].includes(url.hostname)) {
        const honeypotPages = ["/team", "/careers"];
        if (honeypotPages.includes(url.pathname)) {
          const serveDomain = url.hostname.replace(/^www\./, "");
          ctx.waitUntil(logHoneypotVisit(env, request, url.pathname));
          return applySecurityHeaders(serveHoneypotPage(url.pathname.slice(1), serveDomain));
        }
        if (url.pathname === "/admin-portal") {
          ctx.waitUntil(logHoneypotVisit(env, request, "/admin-portal"));
          // Pull the live roster (auto-seeded weekly by the Recon agent)
          // so harvesters scraping us see a different set on each visit
          // window. readRoster() is best-effort — DB errors fall through
          // to the built-in default roster inside the renderer.
          const { readRoster } = await import('./lib/auto-seeder-planter');
          const roster = await readRoster(env, 'auto-seeder:averrow.com:/admin-portal', 16);
          return applySecurityHeaders(new Response(renderAdminPortalPage(roster), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" },
          }));
        }
        if (url.pathname === "/internal-staff") {
          ctx.waitUntil(logHoneypotVisit(env, request, "/internal-staff"));
          const { readRoster } = await import('./lib/auto-seeder-planter');
          const roster = await readRoster(env, 'auto-seeder:averrow.com:/internal-staff', 16);
          return applySecurityHeaders(new Response(renderInternalStaffPage(roster), {
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=86400" },
          }));
        }
      }

      // ─── Debug: manual enrichment/social runner trigger ────────────
      if (url.pathname === '/api/debug/run-enrichment' && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }

        const { runAllEnrichmentFeeds, runAllSocialFeeds } = await import('./lib/feedRunner');
        const { enrichmentModules: eMods, socialModules: sMods } = await import('./feeds/index');

        // Check feed_configs state for diagnostics
        let feedConfigRows: { feed_name: string; feed_type: string; enabled: number }[] = [];
        try {
          const fc = await env.DB.prepare(
            "SELECT feed_name, feed_type, enabled FROM feed_configs WHERE feed_type IN ('enrichment', 'social')"
          ).all<{ feed_name: string; feed_type: string; enabled: number }>();
          feedConfigRows = fc.results;
        } catch (err) {
          feedConfigRows = [];
        }

        const enrichResult = await runAllEnrichmentFeeds(env, eMods);
        const socialResult = await runAllSocialFeeds(env, sMods);
        return Response.json({
          enrichment: enrichResult,
          social: socialResult,
          diagnostics: {
            enrichmentModulesRegistered: Object.keys(eMods),
            socialModulesRegistered: Object.keys(sMods),
            feedConfigRows,
          },
        });
      }

      // ─── Internal agent trigger endpoints ─────────────────────────
      // ─── Internal cube/cache rebuild endpoints (POST) ─────────
      // Out-of-band rebuild for the dark-web + app-store brand summary
      // cubes. Cheap and idempotent — INSERT OR REPLACE keyed on
      // brand_id. Use when you don't want to wait for cube_healer's
      // next 6-hour tick (cron `12 */6 * * *`).
      if (url.pathname === '/api/internal/cubes/brand-summaries/rebuild' && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const { buildDarkWebBrandSummary, buildAppStoreBrandSummary } = await import('./lib/cube-builder');
        const [dw, as] = await Promise.all([
          buildDarkWebBrandSummary(env),
          buildAppStoreBrandSummary(env),
        ]);
        return Response.json({
          triggered: true,
          dark_web_brand_summary: dw,
          app_store_brand_summary: as,
        });
      }

      // GET /api/internal/geoip-status
      // MCP-callable read of getGeoMmdbStatus(): row count, shadow
      // table progress, recent_attempts, oldest running refresh
      // age. Same shape as the admin endpoint but bypasses JWT —
      // operator-tooling triage from MCP.
      if (url.pathname === '/api/internal/geoip-status' && request.method === 'GET') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const { getGeoMmdbStatus } = await import('./lib/geoip-mmdb');
        const status = await getGeoMmdbStatus(env);
        return Response.json({ success: true, data: status });
      }

      // POST /api/internal/geoip-refresh
      // MCP-callable refresh trigger. Same semantics as the admin
      // endpoint: optional `forceReload` body bypasses the
      // skip-if-current guard.
      if (url.pathname === '/api/internal/geoip-refresh' && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        let forceReload = false;
        try {
          const body = await request.json().catch(() => null) as { forceReload?: boolean } | null;
          if (body && typeof body.forceReload === 'boolean') forceReload = body.forceReload;
        } catch { /* missing/invalid body is fine */ }
        const { agentModules } = await import('./agents/index');
        const { executeAgent } = await import('./lib/agentRunner');
        const mod = agentModules['geoip_refresh'];
        if (!mod) return new Response('geoip_refresh agent not registered', { status: 500 });
        const result = await executeAgent(
          env,
          mod,
          { trigger: 'mcp_internal', forceReload },
          'api',
          'event',
        );
        return Response.json({ success: true, data: result });
      }

      // GET /api/internal/taxii/discover?root_url=<url>&auth_type=<type>&api_key_env=<env_var>&username=<u>
      // Operator helper for adding new TAXII collections without
      // guessing collection IDs (which bit us on the OTX seed —
      // see PR #1271). Auto-detects whether the URL is a discovery
      // resource or an api_root resource, then walks collections/
      // for each api_root and returns a flat inventory.
      //
      // Auth params are optional — most public TAXII feeds
      // (EclecticIQ, OTX user_AlienVault) accept anonymous
      // discovery. For private collections, pass auth_type=basic
      // or bearer + the env var name holding the secret.
      //
      // Used by scripts/taxii-discover.sh.
      if (url.pathname === '/api/internal/taxii/discover' && request.method === 'GET') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const rootUrl = url.searchParams.get('root_url');
        if (!rootUrl) {
          return Response.json({ success: false, error: 'root_url query param is required' }, { status: 400 });
        }
        const authType = url.searchParams.get('auth_type') ?? 'none';
        const username = url.searchParams.get('username') ?? '';
        const apiKeyEnv = url.searchParams.get('api_key_env');
        const apiKey = apiKeyEnv
          ? ((env as unknown as Record<string, string | undefined>)[apiKeyEnv] ?? '')
          : '';
        const taxiiAuth = authType === 'bearer'
          ? { type: 'bearer' as const, token: apiKey }
          : authType === 'basic'
            ? { type: 'basic' as const, username, password: apiKey }
            : { type: 'none' as const };
        const { discoverTaxiiServer } = await import('./lib/taxii-client');
        const report = await discoverTaxiiServer({ root_url: rootUrl, auth: taxiiAuth });
        return Response.json({ success: true, data: report });
      }

      // POST /api/internal/notifications/sweep-stale-platform
      // Marks platform_* notifications older than ?olderThanMinutes
      // as state='done'. Used to clear pre-fix stale alerts from
      // operator devices without waiting for them to age out.
      // Default cutoff: 60 minutes.
      if (url.pathname === '/api/internal/notifications/sweep-stale-platform' && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const minutes = parseInt(url.searchParams.get('olderThanMinutes') ?? '60', 10);
        const result = await env.DB.prepare(
          `UPDATE notifications
              SET state = 'done',
                  done_at = datetime('now'),
                  updated_at = datetime('now')
            WHERE type LIKE 'platform_%'
              AND state != 'done'
              AND created_at < datetime('now', '-' || ? || ' minutes')`
        ).bind(minutes).run();
        // Diagnostic state breakdown so a swept=0 result is
        // explainable (e.g. rows already done vs no rows at all).
        const byState = await env.DB.prepare(
          `SELECT state, COUNT(*) AS n FROM notifications
            WHERE type LIKE 'platform_%' GROUP BY state`
        ).all<{ state: string; n: number }>();
        return Response.json({
          swept: result.meta.changes,
          older_than_minutes: minutes,
          state_breakdown: byState.results,
        });
      }

      if (url.pathname.startsWith('/api/internal/agents/') && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }

        if (url.pathname === '/api/internal/agents/cartographer/run') {
          const { agentModules } = await import('./agents/index');
          const { executeAgent } = await import('./lib/agentRunner');
          const mod = agentModules["cartographer"];
          if (mod) ctx.waitUntil(executeAgent(env, mod, { trigger: 'manual' }, "api", "event"));
          return Response.json({ triggered: true, agent: 'cartographer' });
        }

        if (url.pathname === '/api/internal/agents/nexus/run') {
          const { agentModules } = await import('./agents/index');
          const { executeAgent } = await import('./lib/agentRunner');
          const mod = agentModules["nexus"];
          if (mod) ctx.waitUntil(executeAgent(env, mod, {}, "api", "event"));
          return Response.json({ triggered: true, agent: 'nexus' });
        }

        if (url.pathname === '/api/internal/agents/cartographer/backfill') {
          const { agentModules } = await import('./agents/index');
          const { executeAgent } = await import('./lib/agentRunner');
          const mod = agentModules["cartographer"];
          if (mod) {
            const batches = 10;
            ctx.waitUntil((async () => {
              for (let i = 0; i < batches; i++) {
                await executeAgent(env, mod, { trigger: 'backfill', batch: i + 1 }, "api", "event");
                if (i < batches - 1) await new Promise(r => setTimeout(r, 2000));
              }
            })());
          }
          return Response.json({ triggered: true, agent: 'cartographer', batches: 10 });
        }

        // Durable backfill workflow — replaces fragile batch endpoint
        if (url.pathname === '/api/internal/agents/cartographer/backfill-workflow') {
          const instance = await env.CARTOGRAPHER_BACKFILL.create({
            params: { batchSize: 500, startOffset: 0 }
          });
          return Response.json({
            instanceId: instance.id,
            message: 'Backfill workflow started',
          });
        }

        // NEXUS durable workflow — on-demand correlation run
        if (url.pathname === '/api/internal/agents/nexus/workflow') {
          const id = crypto.randomUUID();
          const instance = await env.NEXUS_RUN.create({ id, params: {} });
          return Response.json({ triggered: true, instanceId: instance.id });
        }

        // Cartographer main workflow — on-demand cart run via the
        // durable workflow path. PR-M ships this as the manual
        // validation hook before PR-O flips the cron over. Identical
        // behavior to the cron path post-PR-O.
        if (url.pathname === '/api/internal/agents/cartographer/main-workflow') {
          const id = crypto.randomUUID();
          const instance = await env.CARTOGRAPHER_MAIN.create({ id, params: {} });
          return Response.json({ triggered: true, instanceId: instance.id });
        }
      }

      // ─── Internal GET endpoints (AVERROW_INTERNAL_SECRET auth, for MCP server) ──
      if (url.pathname.startsWith('/api/internal/') && request.method === 'GET') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }

        if (url.pathname === '/api/internal/platform-diagnostics') {
          const { handlePlatformDiagnostics } = await import('./handlers/diagnostics');
          return handlePlatformDiagnostics(request, env);
        }
        if (url.pathname === '/api/internal/platform-status') {
          const { handlePlatformStatus } = await import('./handlers/platform-status');
          return handlePlatformStatus(request, env);
        }
        if (url.pathname === '/api/internal/notification-delivery-audit') {
          const { handleNotificationDeliveryAudit } = await import('./handlers/notification-delivery-audit');
          return handleNotificationDeliveryAudit(request, env);
        }
        if (url.pathname === '/api/internal/cartographer-health') {
          const { handleCartographerHealth } = await import('./handlers/cartographer-health');
          return handleCartographerHealth(request, env);
        }
        if (url.pathname === '/api/internal/d1-health') {
          const { handleD1Health } = await import('./handlers/d1-health');
          return handleD1Health(request, env);
        }
        if (url.pathname === '/api/internal/system-health') {
          const { handleSystemHealth } = await import('./handlers/admin');
          return handleSystemHealth(request, env);
        }
        if (url.pathname === '/api/internal/pipeline-status') {
          const { handlePipelineStatus } = await import('./handlers/admin');
          return handlePipelineStatus(request, env);
        }
        if (url.pathname === '/api/internal/stats') {
          const { handleAdminStats } = await import('./handlers/admin');
          return handleAdminStats(request, env);
        }
        if (url.pathname === '/api/internal/budget/status') {
          const { handleBudgetStatus } = await import('./handlers/budget');
          return handleBudgetStatus(request, env);
        }
        if (url.pathname === '/api/internal/budget/ledger-health') {
          const { handleBudgetLedgerHealth } = await import('./handlers/admin');
          return handleBudgetLedgerHealth(request, env);
        }
        if (url.pathname.startsWith('/api/internal/agents/') && url.pathname.endsWith('/health')) {
          const agentName = url.pathname.replace('/api/internal/agents/', '').replace('/health', '');
          const { handleAgentHealth } = await import('./handlers/agents');
          return handleAgentHealth(request, env, agentName);
        }
      }

      // Mint a service-account JWT for averrow-mcp UI verification tools.
      // Internal secret authenticates the caller; the response carries a
      // 90-day user JWT for SERVICE_ACCOUNT_ID. See handleMintServiceJwt
      // for the rationale.
      if (url.pathname === '/api/internal/auth/mint-service-jwt' && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const { handleMintServiceJwt } = await import('./handlers/auth');
        return handleMintServiceJwt(request, env);
      }

      // Manual briefing email trigger
      if (url.pathname === '/api/internal/briefing/send' && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const { generateAndEmailBriefing } = await import('./handlers/briefing');
        const result = await generateAndEmailBriefing(env, 'manual:admin');
        return Response.json(result);
      }

      // Get workflow status (GET, still requires auth)
      if (url.pathname.startsWith('/api/internal/agents/cartographer/backfill-workflow/')
          && request.method === 'GET') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const instanceId = url.pathname.split('/').pop()!;
        const instance = await env.CARTOGRAPHER_BACKFILL.get(instanceId);
        const status = await instance.status();
        return Response.json(status);
      }

      // NEXUS workflow status (GET, requires auth)
      if (url.pathname.startsWith('/api/internal/agents/nexus/workflow/')
          && request.method === 'GET') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const instanceId = url.pathname.split('/').pop()!;
        const instance = await env.NEXUS_RUN.get(instanceId);
        const status = await instance.status();
        return Response.json(status);
      }

      // ─── CertStream Durable Object endpoints ────────────────────
      if (url.pathname === '/api/certstream/stats' && request.method === 'GET') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const csId = env.CERTSTREAM_MONITOR.idFromName('certstream-primary');
        const csStub = env.CERTSTREAM_MONITOR.get(csId);
        return csStub.fetch(new Request('https://internal/stats'));
      }

      if (url.pathname === '/api/certstream/reload-brands' && request.method === 'POST') {
        const internalSecret = (env as unknown as Record<string, unknown>).AVERROW_INTERNAL_SECRET as string | undefined;
        const authHeader = request.headers.get('Authorization');
        if (!internalSecret || authHeader !== `Bearer ${internalSecret}`) {
          return new Response('Unauthorized', { status: 401 });
        }
        const csId = env.CERTSTREAM_MONITOR.idFromName('certstream-primary');
        const csStub = env.CERTSTREAM_MONITOR.get(csId);
        return csStub.fetch(new Request('https://internal/reload-brands'));
      }

      // Flight Control health snapshot endpoint
      if (url.pathname === '/api/v1/agents/health' && request.method === 'GET') {
        const { requireAuth: reqAuth, isAuthContext: isAuth } = await import('./middleware/auth');
        const authResult = await reqAuth(request, env);
        if (!isAuth(authResult)) return authResult;

        const snapshot = await env.DB.prepare(`
          SELECT details, created_at
          FROM agent_outputs
          WHERE agent_id = 'flight_control' AND type = 'diagnostic'
          ORDER BY created_at DESC
          LIMIT 1
        `).first<{ details: string; created_at: string }>();

        if (!snapshot) {
          return Response.json({ status: 'no_data', message: 'Flight Control has not run yet' });
        }

        const parsed = JSON.parse(snapshot.details) as Record<string, unknown>;
        return Response.json({
          ...parsed,
          snapshot_age_seconds: Math.round(
            (Date.now() - new Date(snapshot.created_at + 'Z').getTime()) / 1000
          ),
        });
      }

      // Agent outputs endpoint (ticker feed)
      if (url.pathname === '/api/v1/agents/outputs' && request.method === 'GET') {
        const { requireAuth: reqAuth2, isAuthContext: isAuth2 } = await import('./middleware/auth');
        const authResult2 = await reqAuth2(request, env);
        if (!isAuth2(authResult2)) return authResult2;
        const limit = Math.min(50, parseInt(url.searchParams.get('limit') ?? '10'));
        const severityParam = url.searchParams.get('severity');
        const allowed = ['critical', 'high', 'medium', 'low', 'info'];
        const severities = severityParam
          ? severityParam.split(',').map(s => s.trim()).filter(s => allowed.includes(s))
          : ['critical', 'high'];

        const placeholders = severities.map(() => '?').join(',');
        const rows = await env.DB.prepare(`
          SELECT agent_id, type, summary, severity, created_at
          FROM agent_outputs
          WHERE severity IN (${placeholders})
            AND summary IS NOT NULL
            AND LENGTH(summary) > 10
            AND created_at >= datetime('now', '-24 hours')
          ORDER BY created_at DESC
          LIMIT ?
        `).bind(...severities, limit).all();

        return Response.json({ success: true, data: rows.results });
      }

      // Agent activity log endpoint
      if (url.pathname === '/api/v1/agents/activity' && request.method === 'GET') {
        const { requireAuth: reqAuth3, isAuthContext: isAuth3 } = await import('./middleware/auth');
        const authResult3 = await reqAuth3(request, env);
        if (!isAuth3(authResult3)) return authResult3;
        const limit = parseInt(url.searchParams.get('limit') ?? '50');
        const agentId = url.searchParams.get('agent_id');

        const query = agentId
          ? `SELECT * FROM agent_activity_log WHERE agent_id = ?
             ORDER BY created_at DESC LIMIT ?`
          : `SELECT * FROM agent_activity_log
             ORDER BY created_at DESC LIMIT ?`;

        const params = agentId ? [agentId, limit] : [limit];
        const result = await env.DB.prepare(query).bind(...params).all();
        return Response.json({ data: result.results });
      }

      const response = await router.fetch(request, env, ctx);
      return applySecurityHeaders(response);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      // Log internally but never expose details to client
      try {
        await env.DB.prepare(
          "INSERT INTO agent_outputs (id, agent_id, type, summary, created_at) VALUES (?, 'sentinel', 'diagnostic', ?, datetime('now'))"
        ).bind(
          'err-' + Date.now(),
          'WORKER ERROR: ' + err.message + ' | ' + (err.stack?.substring(0, 300) ?? '')
        ).run();
      } catch { /* DB write failed — don't mask the original error */ }
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
