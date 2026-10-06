// G37: /team is a spam-trap honeypot. It must name no people, must not claim
// to be the Averrow team, must carry noindex (meta + header), and must stay
// out of the sitemap and robots.txt — while still publishing trap addresses.

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { serveHoneypotPage, HONEYPOT_X_ROBOTS_TAG, trapMailDomain } from "../src/honeypot";
import { registerPublicRoutes } from "../src/routes/public";
import { renderRobotsTxt, renderSitemapXml } from "../src/templates/robots-sitemap";
import type { Env } from "../src/types";

// Every person name, title and team claim the page (and the retired
// templates/team.ts) ever carried.
const FORBIDDEN = [
  "Claude Leroux", "Sarah Chen", "James Wilson", "Jennifer Smith", "Michael Patel",
  "Lisa Rodriguez", "Michael Brown", "Emily Davis", "David Lee",
  "sarah.chen", "james.wilson",
  "CEO", "CTO", "Founder", "VP Engineering", "Head of Threat Research",
  "Lead Data Engineer", "Director of Operations", "Chief Security Officer",
  "Our Team", "leadership", "The people behind",
];

describe("/team honeypot page", () => {
  it("names no people, titles or team claims", async () => {
    const html = await serveHoneypotPage("team").text();
    for (const s of FORBIDDEN) expect(html, s).not.toContain(s);
  });

  it("carries noindex in a meta tag and the X-Robots-Tag header", async () => {
    const res = serveHoneypotPage("team");
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex,nofollow">');
    expect(res.headers.get("X-Robots-Tag")).toBe(HONEYPOT_X_ROBOTS_TAG);
    expect(HONEYPOT_X_ROBOTS_TAG).toContain("noindex");
  });

  it("still publishes trap addresses for harvesters, on a Worker-routed mail domain", async () => {
    const html = await serveHoneypotPage("team", "averrow.com").text();
    expect(html).toContain("mailto:hr-hp01@averrow.ca");
    expect(html).toMatch(/mailto:spider-honey-team-\d{8}@averrow\.ca/);
    expect(html).toMatch(/spider-honey-team-footer-\d{8}@averrow\.ca/);
  });

  it("never publishes an @averrow.com address (Google Workspace MX rejects unknown users)", async () => {
    for (const page of ["team", "careers", "contact"]) {
      const html = await serveHoneypotPage(page, "averrow.com").text();
      expect(html, page).not.toMatch(/[\w.+-]+@averrow\.com/);
    }
  });

  it("maps web domains to Email-Routing mail domains", () => {
    expect(trapMailDomain("averrow.com")).toBe("averrow.ca");
    expect(trapMailDomain("www.averrow.com")).toBe("averrow.ca");
    expect(trapMailDomain("averrow-staging.workers.dev")).toBe("averrow.ca");
    expect(trapMailDomain("trustradar.ca")).toBe("trustradar.ca");
    expect(trapMailDomain("www.lrxradar.com")).toBe("lrxradar.com");
    expect(trapMailDomain("averrow.ca")).toBe("averrow.ca");
  });

  it("points a human visitor at the real contact form", async () => {
    const html = await serveHoneypotPage("team").text();
    expect(html).toContain('href="/contact"');
  });

  it("the router fallback /team serves the same neutral, noindex page", async () => {
    const router: RouterType<IRequest> = Router();
    registerPublicRoutes(router);
    const res = (await router.fetch(new Request("https://averrow-staging.workers.dev/team"), {} as Env)) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain('content="noindex,nofollow"');
    for (const s of FORBIDDEN) expect(html, s).not.toContain(s);
  });
});

describe("/team is not advertised", () => {
  it("is absent from the fallback sitemap", () => {
    expect(renderSitemapXml()).not.toContain("/team<");
    expect(renderSitemapXml()).not.toMatch(/averrow\.com\/team\b/);
  });

  it("is not named in robots.txt (that would advertise it)", () => {
    expect(renderRobotsTxt()).not.toMatch(/\/team(?!-directory)/);
  });
});
