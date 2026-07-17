import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { json } from "../lib/cors";
// R6 cutover: marketing pages (/, /platform, /about, /pricing, /security,
// /contact, /report-abuse, /blog, /changelog) are now served as static
// HTML from packages/averrow-marketing via the Workers ASSETS binding.
// The router.get() handlers for those routes have been retired below.
// Worker-served routes remain for paths with dynamic behaviour
// (auth, scan, status incidents, etc.).
//
// homepage.ts is kept to power /legacy (renderHomepage wrapped with a
// banner) and the /assess/:id/results scan-results page.
import { renderHomepage, renderAssessResults } from "../templates/homepage";
import { renderScanPage } from "../templates/scan";
import { renderStatusPage } from "../templates/status";
import { renderPrivacyPage } from "../templates/privacy";
import { renderTermsPage } from "../templates/terms";
import { renderTeamPage } from "../templates/team";
import { renderNotFoundPage } from "../templates/not-found";
import { renderAdminPortalPage, renderInternalStaffPage } from "../templates/honeypot-pages";
import { renderRobotsTxt, renderSitemapXml } from "../templates/robots-sitemap";
import { handleContactSubmission } from "../handlers/contact";
import { handleScanPage } from "../handlers/scanPage";
import { handlePublicBrandScan } from "../handlers/brandScan";
import {
  handlePublicStats, handlePublicGeo, handlePublicAssess, handlePublicLeadCapture,
  handlePublicMonitor, handlePublicFeeds, publicAssessIpLimit,
} from "../handlers/public";
import { handlePublicStats as handlePublicStatsV2 } from "../handlers/stats";
import { handlePublicEmailSecurity } from "../handlers/emailSecurity";

const htmlPage = (render: () => string) => () =>
  new Response(render(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=600",
    },
  });

/** Wraps the old homepage with a legacy banner */
function renderLegacyHomepage(): string {
  const banner = `<div style="background:#C83C3C;color:white;padding:8px 16px;font-family:monospace;font-size:12px;text-align:center;position:sticky;top:0;z-index:9999">\u26A0 You are viewing the legacy interface. <a href="/v2" style="color:white;text-decoration:underline">Switch to Averrow v2 \u2192</a></div>`;
  const html = renderHomepage();
  return html.replace(/<body([^>]*)>/, `<body$1>${banner}`);
}

// ─── Legacy redirects (old admin routes → /v2 equivalents) ──────
const LEGACY_REDIRECTS: Record<string, string> = {
  '/admin':               '/v2/admin',
  '/admin/dashboard':     '/v2/admin',
  '/admin/users':         '/v2/admin/users',
  '/admin/organizations': '/v2/admin/users',
  '/admin/feeds':         '/v2/feeds',
  '/admin/agent-config':  '/v2/agents',
  '/admin/audit':         '/v2/admin/audit',
  '/admin/spam-trap':     '/v2/admin/spam-trap',
  '/admin/takedowns':     '/v2/admin/takedowns',
  '/observatory':         '/v2',
  '/brands':              '/v2/brands',
};

export function registerPublicRoutes(router: RouterType<IRequest>): void {
  // ─── Root, marketing pages — served by Workers ASSETS binding ─────
  //
  // After the R6 cutover the homepage, platform, about, pricing,
  // security, contact, report-abuse, blog, and changelog routes are
  // pre-rendered HTML files under public/ (built by
  // packages/averrow-marketing). The ASSETS binding picks them up
  // before any route handler runs, so the Worker no longer registers
  // /, /platform, /about, /pricing, /security, /contact,
  // /report-abuse, /blog, /blog/<slug>, /blog/feed.xml, /changelog,
  // and /changelog/feed.xml. The dynamic-stats fetch that used to
  // live on / moves to R7 (build-time fetch in averrow-marketing).

  // ─── Legacy redirects (old admin routes → /v2) ──────────────────
  for (const [oldPath, newPath] of Object.entries(LEGACY_REDIRECTS)) {
    router.get(oldPath, (request: Request) => {
      const url = new URL(request.url);
      return Response.redirect(`${url.origin}${newPath}`, 302);
    });
  }

  // ─── /login → React /v2/login ────────────────────────────────────
  // Previously this redirected straight to /api/auth/login (Google
  // OAuth). That short-circuited the React Login page so users only
  // ever saw Google as an option — passkey + magic-link were
  // unreachable. Send them to /v2/login instead so the React page
  // surfaces all three auth methods.
  router.get("/login", (request: Request) => {
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}/v2/login`, 302);
  });

  // ─── Legacy escape hatch — old homepage at /legacy ──────────────
  router.get("/legacy", () =>
    new Response(renderLegacyHomepage(), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=600",
      },
    })
  );

  // ─── Public Assessment ───────────────────────────────────────────
  router.post("/assess", async (request: Request, env: Env) => {
    // H4(c): this form path triggers the same paid AI scan as
    // /api/v1/public/assess, so it shares the same per-IP 10/hour
    // KV bucket instead of the looser shared 30/min 'scan' preset.
    const limited = await publicAssessIpLimit(request, env);
    if (limited) return limited;
    try {
      const ct = request.headers.get("Content-Type") ?? "";
      let domain: string | undefined;
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await request.formData();
        domain = (form.get("domain") as string)?.toLowerCase().trim();
      } else {
        const body = await request.json() as { domain?: string };
        domain = body.domain?.toLowerCase().trim();
      }
      domain = domain?.replace(/^https?:\/\//, "").split("/")[0];
      if (!domain || !domain.includes(".")) {
        return Response.redirect(new URL("/", request.url).toString(), 302);
      }
      const scanRequest = new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": request.headers.get("Origin") ?? "" },
        body: JSON.stringify({ domain }),
      });
      const scanRes = await handlePublicBrandScan(scanRequest, env);
      const scanData = await scanRes.json() as { success: boolean; data?: { domain: string; trustScore: number } };
      if (!scanData.success) {
        return Response.redirect(new URL("/", request.url).toString(), 302);
      }
      const row = await env.DB.prepare(
        "SELECT id FROM brand_scans WHERE domain = ? ORDER BY created_at DESC LIMIT 1"
      ).bind(domain).first<{ id: string }>();
      const id = row?.id ?? "unknown";
      return Response.redirect(new URL(`/assess/${id}/results`, request.url).toString(), 303);
    } catch {
      return Response.redirect(new URL("/", request.url).toString(), 302);
    }
  });

  router.get("/assess/:id/results", (request: Request & { params: Record<string, string> }) =>
    new Response(renderAssessResults(request.params["id"] ?? ""), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );

  // ─── Redirect ────────────────────────────────────────────────────
  router.get("/dashboard/social", () => Response.redirect("/social", 302));

  // ─── Corporate Site Pages ─────────────────────────────────────────
  // /platform, /about, /pricing, /security — see R6 cutover note at
  // top of file. These are now static HTML served by the ASSETS
  // binding.

  // ─── Public platform status page ──────────────────────────────────
  // Server-renders the 30-day uptime rollup and a small inline script
  // re-fetches /api/v1/public/platform-status every 60s. No auth.
  // Cache headers shorter than the marketing pages — operators want
  // fresh data here, and the worker-side 60s KV cache absorbs the
  // load. CDN may revalidate after 30s.
  router.get("/status", async (_request: Request, env: Env) => {
    const html = await renderStatusPage(env);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=30, s-maxage=60",
      },
    });
  });
  // RSS feed of public incidents — standard format for status-page
  // feed readers and customer monitoring tools. Must be registered
  // BEFORE /status/incidents/:id (and ideally before /status/incidents
  // too) so itty-router resolves the more specific path first.
  router.get("/status/feed.xml", async (request: Request, env: Env) => {
    const { renderIncidentFeed } = await import("../templates/incident-feed");
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const xml = await renderIncidentFeed(env, baseUrl);
    return new Response(xml, {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        // 5min cache aligns with RSS reader poll cadences and the
        // <ttl>5</ttl> we advertise inside the feed.
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    });
  });

  // Public incident archive — full history (newest first, grouped
  // by month). /status itself only shows the five most recent
  // resolved; this is the long-tail. Must be registered BEFORE the
  // permalink below so itty-router doesn't treat "incidents" as an
  // :id parameter.
  router.get("/status/incidents", async (_request: Request, env: Env) => {
    const { renderIncidentArchivePage } = await import("../templates/incident-archive");
    const html = await renderIncidentArchivePage(env);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60, s-maxage=120",
      },
    });
  });

  // Public incident permalink — server-rendered, mirrors the
  // /api/v1/public/incidents visibility gate (lib/incidents.toPublicShape).
  // Returns a 404 shell when the incident is missing, internal-only,
  // or has no public_title — same response body, different HTTP status,
  // so crawlers don't index a non-existent / unpublished incident.
  router.get("/status/incidents/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const { renderIncidentDetailPage } = await import("../templates/incident-detail");
    const id = request.params["id"] ?? "";
    const result = await renderIncidentDetailPage(env, id);
    return new Response(result.html, {
      status: result.found ? 200 : 404,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Cache slightly longer than /status — detail mutates only
        // when the operator posts a new update, which the 60s window
        // catches naturally. 404s get a shorter window so a newly
        // promoted incident becomes reachable quickly.
        "Cache-Control": result.found
          ? "public, max-age=60, s-maxage=120"
          : "public, max-age=15, s-maxage=30",
      },
    });
  });
  // /blog, /blog/<slug>, /blog/feed.xml, /changelog, /changelog/feed.xml,
  // /contact, /report-abuse — all served as static HTML by the ASSETS
  // binding now (built by packages/averrow-marketing).

  // Common alternate path users may guess. ASSETS doesn't handle
  // redirects, so this one stays Worker-side.
  router.get("/report-phishing", () => Response.redirect("/report-abuse", 302));

  // RFC 8058 List-Unsubscribe one-click target for abuse-mailbox
  // responder emails (ack + determination). Gmail (and other clients
  // honouring `List-Unsubscribe-Post: List-Unsubscribe=One-Click`)
  // POSTs to this URL with no auth and no body. Token is HMAC of the
  // email so a bot can't opt random addresses out by guessing.
  // Accepts GET too as a manual-click fallback.
  router.post("/api/abuse-mailbox/unsubscribe", async (request: Request, env: Env) => {
    const { handleAbuseMailboxUnsubscribe } = await import("../handlers/abuseMailboxUnsubscribe");
    return handleAbuseMailboxUnsubscribe(request, env);
  });
  router.get("/api/abuse-mailbox/unsubscribe", async (request: Request, env: Env) => {
    const { handleAbuseMailboxUnsubscribe } = await import("../handlers/abuseMailboxUnsubscribe");
    return handleAbuseMailboxUnsubscribe(request, env);
  });

  // /privacy and /terms are inline templates until they get ported in
  // a follow-up — they're rarely-changing legal content, lowest priority
  // for the Astro migration.
  router.get("/privacy", htmlPage(renderPrivacyPage));
  router.get("/terms", htmlPage(renderTermsPage));

  // ─── Spider Trap Honeypot Pages ─────────────────────────────────────
  router.get("/team", htmlPage(renderTeamPage));
  router.get("/admin-portal", htmlPage(renderAdminPortalPage));
  router.get("/internal-staff", htmlPage(renderInternalStaffPage));

  // ─── robots.txt & sitemap.xml ──────────────────────────────────────
  router.get("/robots.txt", () =>
    new Response(renderRobotsTxt(), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    })
  );
  router.get("/sitemap.xml", () =>
    new Response(renderSitemapXml(), {
      headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    })
  );

  // ─── Contact Form Submission ─────────────────────────────────────
  router.post("/api/contact", async (request: Request, env: Env) => {
    return handleContactSubmission(request, env);
  });

  // ─── Public Brand Exposure Scan Page ─────────────────────────────
  router.get("/scan", () =>
    new Response(renderScanPage(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  );

  router.get("/scan/:id", (request: Request & { params: Record<string, string> }, env: Env) =>
    handleScanPage(request, env, request.params["id"] ?? "")
  );

  // ─── Qualified Report (sharable via token, no auth required) ─────
  // Admin generates the report via POST /api/admin/leads/:id/qualified-report;
  // the response includes a share URL that lands here. Token-only access —
  // tokens are 32-byte random URL-safe strings, presence + non-expired is auth.
  router.get("/qualified-report/:token", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const { handleViewQualifiedReport } = await import("../handlers/qualifiedReport");
    return handleViewQualifiedReport(request, env, request.params["token"] ?? "");
  });

  // ─── WebSocket — ThreatPushHub Durable Object ─────────────────────
  router.get("/ws/threats", async (request: Request, env: Env) => {
    const id = env.THREAT_PUSH_HUB.idFromName("global");
    const hub = env.THREAT_PUSH_HUB.get(id);
    return hub.fetch(request);
  });

  // ─── Public API endpoints (no auth) ──────────────────────────────
  router.get("/api/v1/public/stats", (request: Request, env: Env) => handlePublicStats(request, env));
  router.get("/api/v1/public/geo", (request: Request, env: Env) => handlePublicGeo(request, env));
  router.get("/api/v1/public/feeds", (request: Request, env: Env) => handlePublicFeeds(request, env));
  router.post("/api/v1/public/assess", (request: Request, env: Env) => handlePublicAssess(request, env));
  router.post("/api/v1/public/leads", (request: Request, env: Env) => handlePublicLeadCapture(request, env));
  router.post("/api/v1/public/monitor", (request: Request, env: Env) => handlePublicMonitor(request, env));
  router.get("/api/v1/public/email-security/:domain", async (request: Request & { params: Record<string, string> }, env: Env) =>
    handlePublicEmailSecurity(request, env, request.params["domain"] ?? "")
  );
  router.get("/api/stats/public", (request: Request, env: Env) => handlePublicStatsV2(request, env));

  // Public platform status — feeds the Home banner (Phase 2) and the
  // public status page (Phase 3). No auth: the data is just per-day
  // uptime, nothing customer-specific. KV-cached 60s in the handler so
  // anonymous traffic can't hammer D1.
  router.get("/api/v1/public/platform-status", async (request: Request, env: Env) => {
    const { handlePlatformStatus } = await import("../handlers/platform-status");
    return handlePlatformStatus(request, env);
  });

  // Public incidents — only rows with visibility='public' AND
  // public_title set are returned. Drives the open-incidents banner
  // and the recent-incidents list on /status. Internal titles +
  // descriptions are NEVER exposed here; see lib/incidents.toPublicShape.
  router.get("/api/v1/public/incidents", async (request: Request, env: Env) => {
    const { handlePublicIncidents } = await import("../handlers/incidents");
    return handlePublicIncidents(request, env);
  });

  // Latest platform milestone — feeds the Home celebration banner.
  // Public because it's a marketing-grade stat (e.g. "1,000,000 threats
  // ingested") and we want it visible without auth on the public-facing
  // pages too. KV-cache hint set in the handler.
  router.get("/api/v1/public/milestones/latest", async (request: Request, env: Env) => {
    const { handleLatestMilestone } = await import("../handlers/milestones");
    return handleLatestMilestone(request, env);
  });

  // ─── React app — serve v2/index.html for all /v2/* routes ────────
  router.get("/v2/*", async (request: Request, env: Env) => {
    const url = new URL(request.url);
    // Try to serve the exact file (JS, CSS, assets)
    const assetResponse = await env.ASSETS.fetch(new Request(new URL(url.pathname, request.url).toString()));
    if (assetResponse.ok && !url.pathname.endsWith('/') && url.pathname.includes('.')) {
      return assetResponse;
    }
    // Otherwise serve v2/index.html for client-side routing
    const htmlResponse = await env.ASSETS.fetch(new Request(new URL("/v2/index.html", request.url).toString()));
    return new Response(htmlResponse.body, {
      status: htmlResponse.status,
      headers: {
        // The Workers Headers type doesn't declare .entries() but the runtime supports it.
        ...Object.fromEntries((htmlResponse.headers as unknown as { entries(): IterableIterator<[string, string]> }).entries()),
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  });

  // ─── Static assets fallback (SPA) ────────────────────────────────
  //
  // Deep-link refresh handling for the two React SPAs that live under
  // path prefixes:
  //   /v2/*      → averrow-ops    (staff back office) — shell at /v2/index.html
  //   /tenant/*  → averrow-tenant (customers)         — shell at /tenant/index.html
  //
  // ASSETS handles the happy path (file exists). When a 404 falls
  // through, we re-issue the request against the matching SPA shell
  // so the React Router can take over client-side. Without this the
  // catch-all would route every /tenant/<slug> refresh into the
  // legacy /dashboard.html shell, which renders its own "Page not
  // found" (the bug the user just hit).
  router.all("*", async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return json({ success: false, error: "Not found" }, 404, request.headers.get("Origin"));
    }
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }

    // SPA shell fallbacks. /v2 + /tenant are React Router apps — any
    // sub-path that isn't a real file should serve their respective
    // index.html so the client router decides what to render.
    if (url.pathname.startsWith("/v2/") || url.pathname === "/v2") {
      const shell = await env.ASSETS.fetch(new Request(new URL("/v2/index.html", request.url).toString()));
      if (shell.status !== 404) return shell;
    }
    if (url.pathname.startsWith("/tenant/") || url.pathname === "/tenant") {
      const shell = await env.ASSETS.fetch(new Request(new URL("/tenant/index.html", request.url).toString()));
      if (shell.status !== 404) return shell;
    }

    // Last-ditch fallback: render the Worker's branded 404 page.
    // Note: /dashboard.html (the legacy SPA shell) is intentionally
    // no longer the catch-all — that surface was retired with the
    // marketing-site Astro cutover and isn't a sensible fallback
    // for unknown paths.
    return new Response(renderNotFoundPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
}
