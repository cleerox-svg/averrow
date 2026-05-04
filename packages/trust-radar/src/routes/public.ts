import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { rateLimit } from "../middleware/rateLimit";
import { json } from "../lib/cors";
import { renderHomepage, renderAssessResults } from "../templates/homepage";
import { renderScanPage } from "../templates/scan";
import { renderPlatformPage } from "../templates/platform";
import { renderAboutPage } from "../templates/about";
import { renderPricingPage } from "../templates/pricing";
import { renderSecurityPage } from "../templates/security";
import { renderBlogPage } from "../templates/blog";
import { renderBlogPost1 } from "../templates/blog-post-1";
import { renderBlogPost2 } from "../templates/blog-post-2";
import { renderBlogPost3 } from "../templates/blog-post-3";
import { renderBlogPost4 } from "../templates/blog-post-4";
import { renderChangelogPage } from "../templates/changelog";
import { renderContactPage } from "../templates/contact";
import { renderNotFoundPage } from "../templates/not-found";
import { renderPrivacyPage } from "../templates/privacy";
import { renderTermsPage } from "../templates/terms";
import { renderTeamPage } from "../templates/team";
import { renderAdminPortalPage, renderInternalStaffPage } from "../templates/honeypot-pages";
import { renderRobotsTxt, renderSitemapXml } from "../templates/robots-sitemap";
import { handleContactSubmission } from "../handlers/contact";
import { handleScanPage } from "../handlers/scanPage";
import { handlePublicBrandScan } from "../handlers/brandScan";
import {
  handlePublicStats, handlePublicGeo, handlePublicAssess, handlePublicLeadCapture,
  handlePublicMonitor, handlePublicFeeds,
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
  // ─── Root — always serve public homepage ───────────────────────────
  // The React app at /v2 handles its own auth. We don't redirect based
  // on cookies here because stale/expired cookies send users into the
  // app login screen instead of showing the public marketing site.
  //
  // Stats are server-rendered so the marketing numbers track the
  // platform's actual state. lib/public-stats.ts caches the underlying
  // D1 reads in KV (10min TTL) — homepage cache (5min) sits in front
  // of that, so most loads cost zero D1 reads.
  router.get("/", async (_request: Request, env: Env) => {
    const { getPublicStats } = await import("../lib/public-stats");
    const stats = await getPublicStats(env);
    return new Response(renderHomepage(stats), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=600",
      },
    });
  });

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
    const limited = await rateLimit(request, env, "scan");
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
  router.get("/platform", htmlPage(renderPlatformPage));
  router.get("/about", htmlPage(renderAboutPage));
  router.get("/pricing", htmlPage(renderPricingPage));
  router.get("/security", htmlPage(renderSecurityPage));
  router.get("/blog", htmlPage(renderBlogPage));
  router.get("/blog/email-security-posture-brand-defense", htmlPage(renderBlogPost1));
  router.get("/blog/cost-brand-impersonation-mid-market", htmlPage(renderBlogPost2));
  router.get("/blog/ai-powered-threat-narratives", htmlPage(renderBlogPost3));
  router.get("/blog/lookalike-domains-threat-hiding", htmlPage(renderBlogPost4));
  router.get("/changelog", htmlPage(renderChangelogPage));
  router.get("/contact", htmlPage(renderContactPage));
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
  router.all("*", async (request: Request, env: Env) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return json({ success: false, error: "Not found" }, 404, request.headers.get("Origin"));
    }
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status !== 404) {
      return assetResponse;
    }
    const spaFallback = await env.ASSETS.fetch(new Request(new URL("/dashboard.html", request.url).toString()));
    if (spaFallback.status !== 404) return spaFallback;
    return new Response(renderNotFoundPage(), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
}
