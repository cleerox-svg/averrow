// G37: /team is a spam-trap honeypot. It must name no people, must not claim
// to be the Averrow team, must carry noindex (meta + header), and must stay
// out of the sitemap and robots.txt — while still publishing trap addresses.

import { describe, it, expect } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { serveHoneypotPage, honeypotHtmlResponse, HONEYPOT_X_ROBOTS_TAG, trapMailDomain } from "../src/honeypot";
import { serveLrxRadarPage } from "../src/templates/honeypot-lrx";
import {
  renderAdminPortalPage, renderInternalStaffPage, renderTeamDirectoryPage, renderStaffContactsPage,
} from "../src/templates/honeypot-pages";
import type { RosterEntry } from "../src/lib/auto-seeder-planter";
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

// G37 follow-up: every OTHER honeypot page — the lrxradar.com trap site, the
// four roster bait pages, /careers — names no real or invented person and
// never names LRX Enterprises Inc. (Averrow's real parent company).

// Every invented person any honeypot template ever carried.
const OLD_INVENTED_NAMES = [
  ...FORBIDDEN.slice(0, 9),
  "Michael Torres", "Robert Taylor", "Lisa Martinez", "Kevin Park", "Amanda White",
  "Chris Johnson", "Rachel Kim", "Tom Harris", "Emily Wilson", "Marcus Bennett",
  "Sophie Lee", "Daniel Foster", "Hannah Murphy", "Owen Hughes", "Zoe Bailey",
  "Lucas Reyes", "Chloe Cooper", "Henry Singh",
];
// Job titles and person-card wording the old pages used.
const OLD_TITLES = [
  "CEO", "CTO", "Founder", "VP Engineering", "Head of Threat Research", "IT Director",
  "DevOps Lead", "Department Leads", "Operations Director", "Senior Consultant",
  "Account Executive", "Marketing Director", "Compliance Officer", "Our Team",
  "Senior Threat Intelligence Analyst", "Product Manager",
];
// First names drawn by the auto-seeder planter plus the old templates.
const FIRST_NAME_POOL = [
  "Sarah", "James", "Emily", "Michael", "Olivia", "David", "Emma", "Robert", "Sophia",
  "William", "Ava", "Daniel", "Mia", "Matthew", "Isabella", "Andrew", "Charlotte", "Ryan",
  "Amelia", "Nathan", "Lisa", "Kevin", "Amanda", "Chris", "Rachel", "Tom", "Jessica",
  "Brian", "Megan", "Eric", "Sophie", "Marcus", "Hannah", "Ethan", "Maya", "Owen", "Zoe",
  "Lucas", "Chloe", "Henry", "Claude", "Jennifer",
];
const POOL_NAME_RE = new RegExp(`\\b(?:${FIRST_NAME_POOL.join("|")})\\s+[A-Z][a-z]*\\.?`);
const FIRST_LAST_RE = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/;

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** Text of <title> and of every element whose class names a person card's name/title slot. */
function titleElementTexts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<title>([^<]*)<\/title>/g)) out.push(m[1] ?? "");
  for (const m of html.matchAll(/<(\w+)[^>]*class="[^"]*\b(?:[\w-]*name|[\w-]*title)\b[^"]*"[^>]*>([^<]*)</g)) {
    out.push(m[2] ?? "");
  }
  return out;
}

// A roster as readRoster() returns it: name-shaped local parts with
// synthesized display names and titles, on routed and non-routed domains.
const LIVE_ROSTER: RosterEntry[] = [
  { email: "sarah.chen@averrow.ca", name: "Sarah Chen", title: "Operations Director", id: 1 },
  { email: "jwilson@lrxradar.com", name: "J. Wilson", title: "IT Director", id: 2 },
  { email: "kevin.park@averrow.com", name: "Kevin Park", title: "DevOps Lead", id: 3 },
];

interface RenderedPage { label: string; html: string; robotsHeader: string | null }

async function allHoneypotPages(): Promise<RenderedPage[]> {
  const pages: RenderedPage[] = [];
  const add = async (label: string, res: Response) =>
    pages.push({ label, robotsHeader: res.headers.get("X-Robots-Tag"), html: await res.text() });

  for (const path of ["/", "/contact", "/team", "/about", "/unknown"]) {
    await add(`lrxradar.com${path}`, serveLrxRadarPage(path));
  }
  for (const page of ["team", "careers", "contact"]) {
    await add(`honeypot:${page}`, serveHoneypotPage(page, "averrow.com"));
  }
  const renderers = { renderAdminPortalPage, renderInternalStaffPage, renderTeamDirectoryPage, renderStaffContactsPage };
  for (const [name, render] of Object.entries(renderers)) {
    for (const domain of ["averrow.com", "lrxradar.com"]) {
      for (const [rosterLabel, roster] of [["default", undefined], ["live", LIVE_ROSTER]] as const) {
        await add(`${name}(${domain}, ${rosterLabel})`, honeypotHtmlResponse(render(roster ? [...roster] : undefined, domain)));
      }
    }
  }
  return pages;
}

describe("every honeypot page", () => {
  it("names no invented person, job title or person card", async () => {
    for (const p of await allHoneypotPages()) {
      const text = visibleText(p.html);
      for (const s of [...OLD_INVENTED_NAMES, ...OLD_TITLES]) expect(text, `${p.label}: ${s}`).not.toContain(s);
      expect(text, p.label).not.toMatch(POOL_NAME_RE);
      expect(p.html, p.label).not.toMatch(/team-card|hp-card-name|class="name"/);
      for (const t of titleElementTexts(p.html)) {
        expect(t, `${p.label}: title element "${t}"`).not.toMatch(FIRST_LAST_RE);
        expect(t, p.label).not.toMatch(POOL_NAME_RE);
      }
    }
  });

  it("never names LRX Enterprises", async () => {
    for (const p of await allHoneypotPages()) {
      expect(p.html, p.label).not.toMatch(/LRX Enterprises/i);
    }
  });

  it("carries noindex in a meta tag and the X-Robots-Tag header", async () => {
    for (const p of await allHoneypotPages()) {
      expect(p.html, p.label).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(p.robotsHeader, p.label).toBe(HONEYPOT_X_ROBOTS_TAG);
    }
  });

  it("publishes trap addresses only on Worker-routed mail domains", async () => {
    for (const p of await allHoneypotPages()) {
      expect(p.html, p.label).toMatch(/mailto:[\w.+-]+@(?:averrow\.ca|trustradar\.ca|lrxradar\.com)/);
      // averrow.com's Workspace MX rejects unknown users: never a trap there.
      expect(p.html, p.label).not.toMatch(/mailto:[\w.+-]+@averrow\.com/);
    }
  });

  it("roster pages keep live seeded addresses on routed domains and drop the rest", () => {
    const html = renderAdminPortalPage([...LIVE_ROSTER], "averrow.com");
    expect(html).toContain("mailto:sarah.chen@averrow.ca");
    expect(html).toContain("mailto:jwilson@lrxradar.com");
    expect(html).not.toContain("kevin.park@averrow.com");
    // Default roster on the page's trap mail domain when nothing routable is seeded.
    const fallback = renderStaffContactsPage([LIVE_ROSTER[2]!], "averrow.com");
    expect(fallback).toMatch(/mailto:[\w-]+-hp\d+@averrow\.ca/);
    expect(renderTeamDirectoryPage(undefined, "lrxradar.com")).toMatch(/mailto:[\w-]+-hp\d+@lrxradar\.com/);
  });

  it("lrxradar.com keeps its robots.txt and sitemap as they were", async () => {
    expect(await serveLrxRadarPage("/robots.txt").text()).toBe(
      "User-agent: *\nAllow: /\nSitemap: https://lrxradar.com/sitemap.xml\n",
    );
    expect(await serveLrxRadarPage("/sitemap.xml").text()).toContain("https://lrxradar.com/team");
  });

  it("the router fallbacks for /admin-portal and /internal-staff are neutral and noindex", async () => {
    const router: RouterType<IRequest> = Router();
    registerPublicRoutes(router);
    for (const path of ["/admin-portal", "/internal-staff"]) {
      const res = (await router.fetch(new Request(`https://averrow-staging.workers.dev${path}`), {} as Env)) as Response;
      expect(res.status, path).toBe(200);
      expect(res.headers.get("X-Robots-Tag"), path).toBe(HONEYPOT_X_ROBOTS_TAG);
      const html = await res.text();
      expect(html, path).toContain('content="noindex,nofollow"');
      for (const s of OLD_INVENTED_NAMES) expect(html, `${path}: ${s}`).not.toContain(s);
      expect(html, path).not.toMatch(/LRX Enterprises/);
    }
  });
});
