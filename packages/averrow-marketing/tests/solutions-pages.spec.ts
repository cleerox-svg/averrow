import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Section 9A (Solutions): the role hub, the five role pages, the retired URLs
 * (/solutions/startups, /solutions/mid-market, /partners, /press, /careers),
 * and the shared nav and footer that list them.
 *
 * Guarded here:
 *  - every page carries the CTA pair ("Scan your domain" -> /scan, "Book a
 *    demo" -> /demo) in the hero and the closing block, and the MSSP page adds
 *    "Talk to us about partnering" -> /contact;
 *  - no horizontal scroll at 390px in both themes, and no text under 12px;
 *  - banned phrases stay out (docs/DISCLOSURE_REGISTER.md rows L35-L47, §3.11):
 *    a multi-client console, white-label (except as "not available"), "data
 *    layer", an email-alert "Live" tile, any price, any SLA, AI claims,
 *    response-time promises, real-looking domains;
 *  - the truthful details: Averrow SOC wording, plan labels, the MSSP
 *    "not available yet" line, the Off / Semi-auto / Auto modes;
 *  - retired URLs: public/_redirects (what Cloudflare serves) and the
 *    meta-refresh stubs that keep working under astro preview;
 *  - nav, footer and sitemap match.
 */

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PAGES = [
  { path: "/solutions", h1: /start from the job you do/i, crumb: false },
  { path: "/solutions/security-teams", h1: /brand phishing in the queue you already work/i, crumb: true },
  { path: "/solutions/brand-and-legal", h1: /find who is using your name, and what to do next/i, crumb: true },
  { path: "/solutions/fraud-and-customer-trust", h1: /turn what customers report into takedowns/i, crumb: true },
  { path: "/solutions/teams-without-a-soc", h1: /the first pass on brand threats, done for you/i, crumb: true },
  { path: "/solutions/mssp", h1: /brand threat intelligence for your clients, in your own tools/i, crumb: true },
];

async function open(page: Page, p: string, theme: "dark" | "light" = "dark") {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("averrow-theme", t);
    } catch {
      /* private mode */
    }
  }, theme);
  await page.route("**/api/v1/public/stats", (route) => route.abort());
  const res = await page.goto(p);
  expect(res?.status(), `${p} status`).toBeLessThan(400);
}

// ── render + CTA pair ───────────────────────────────────────────────────

test.describe("solutions pages render with the CTA pair", () => {
  test.use({ viewport: DESKTOP });

  for (const pg of PAGES) {
    test(pg.path, async ({ page }) => {
      await open(page, pg.path);
      await expect(page).toHaveTitle(/— Averrow$/);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveText(pg.h1);

      const pairs = page.locator("#content [data-cta-pair]");
      expect(await pairs.count()).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < (await pairs.count()); i++) {
        const scan = pairs.nth(i).getByRole("link", { name: "Scan your domain" });
        const demo = pairs.nth(i).getByRole("link", { name: "Book a demo" });
        await expect(scan).toHaveAttribute("href", /\/scan$/);
        await expect(scan).toHaveClass(/btn-primary/);
        await expect(demo).toHaveAttribute("href", /\/demo$/);
        await expect(demo).toHaveClass(/btn-outline/);
      }
      await expect(page.locator(".ph [data-cta-pair]")).toHaveCount(1);
      await expect(page.locator(".pc [data-cta-pair]")).toHaveCount(1);

      // Breadcrumb points back to the Solutions hub on every role page.
      await expect(page.locator(".pp-crumb")).toHaveCount(pg.crumb ? 1 : 0);
      if (pg.crumb) await expect(page.locator(".pp-crumb a")).toHaveAttribute("href", /\/solutions$/);
      // The Solutions hub lights up in the nav.
      await expect(page.locator(".nav-link.is-active")).toHaveAttribute("data-path", "/solutions");
    });
  }

  test("/solutions/mssp: the closing block adds 'Talk to us about partnering' -> /contact", async ({ page }) => {
    await open(page, "/solutions/mssp");
    const lead = page.locator(".pc a[data-cta='mssp-partner']");
    await expect(lead).toHaveCount(1);
    await expect(lead).toHaveText("Talk to us about partnering");
    await expect(lead).toHaveAttribute("href", /\/contact\?interest=partnership$/);
  });

  test("/solutions: five role cards, each with a real sample and a link that resolves", async ({ page }) => {
    await open(page, "/solutions");
    const cards = page.locator(".sh-card:not(.sh-help)");
    await expect(cards).toHaveCount(5);
    const hrefs = await cards.locator("h3 a.sh-link").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(hrefs.map((h) => (h ?? "").replace(/\/$/, ""))).toEqual([
      "/solutions/security-teams",
      "/solutions/brand-and-legal",
      "/solutions/fraud-and-customer-trust",
      "/solutions/teams-without-a-soc",
      "/solutions/mssp",
    ]);
    for (let i = 0; i < 5; i++) {
      expect(await cards.nth(i).locator(".sr-r").count(), `card ${i} sample rows`).toBeGreaterThanOrEqual(2);
      await expect(cards.nth(i).locator(".sh-tag")).toHaveText("Illustrative sample");
      await expect(cards.nth(i).locator("svg")).toHaveCount(0);
    }
    for (const h of hrefs) expect((await page.request.get(h ?? "")).status(), `card link ${h}`).toBe(200);
  });

  test("/solutions: the heading text is the link, the sample sits outside it, and the cards line up", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/solutions");
    const cards = page.locator(".sh-card");
    // Six cells: five roles plus the "Not sure?" scan card, so the last row isn't half empty.
    await expect(cards).toHaveCount(6);
    await expect(page.locator(".sh-help a")).toHaveAttribute("href", /\/scan$/);
    // No card is wrapped in an anchor, and no anchor contains the sample.
    await expect(page.locator("a.sh-card")).toHaveCount(0);
    await expect(page.locator("a:has(.sh-sample)")).toHaveCount(0);
    // One link per card, named by the heading text.
    for (let i = 0; i < 6; i++) await expect(cards.nth(i).locator("a")).toHaveCount(1);
    // The stretched ::after makes the whole card clickable.
    // Clicking the description text (not the heading) still follows the link, via the stretched ::after.
    await Promise.all([page.waitForURL(/\/solutions\/security-teams/), cards.first().locator("p").click({ force: true })]);
  });

  test("/solutions: samples and CTAs align across a row, in 3 columns at 1280, 1 at 390", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, "/solutions");
    const geo = await page.locator(".sh-card").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        const s = e.querySelector(".sh-sample")?.getBoundingClientRect();
        const g = e.querySelector(".sh-go")!.getBoundingClientRect();
        return { top: Math.round(r.top), h: Math.round(r.height), sampleBottom: s ? Math.round(s.bottom) : null, goBottom: Math.round(g.bottom) };
      }),
    );
    const rows = new Map<number, typeof geo>();
    for (const g of geo) rows.set(g.top, [...(rows.get(g.top) ?? []), g]);
    expect([...rows.values()].map((r) => r.length)).toEqual([3, 3]);
    for (const row of rows.values()) {
      expect(new Set(row.map((c) => c.h)).size, "equal card heights in a row").toBe(1);
      expect(new Set(row.map((c) => c.goBottom)).size, "CTAs share a baseline").toBe(1);
    }
    for (const row of rows.values()) {
      const sb = row.map((c) => c.sampleBottom).filter((v) => v !== null);
      expect(new Set(sb).size, "samples share a bottom edge").toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const lefts = await page.locator(".sh-card").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);
  });

  test("/solutions: no card title contains a forced line break", async ({ page }) => {
    await open(page, "/solutions");
    await expect(page.locator(".sh-card h3 br")).toHaveCount(0);
  });

  test("RelatedSurfaces reads the Platform and Solutions dropdowns (source prop)", async ({ page }) => {
    await open(page, "/solutions/security-teams");
    const sections = page.locator("section.rs");
    await expect(sections).toHaveCount(2);
    const platform = await sections.nth(0).locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(platform).toEqual(["/platform/lookalike-domains", "/platform/threat-detection", "/platform/takedowns", "/platform/campaign-intelligence"]);
    const roles = await sections.nth(1).locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
    expect(roles).toEqual(["/solutions/teams-without-a-soc", "/solutions/mssp"]);
  });
});

// ── truthful details ────────────────────────────────────────────────────

test.describe("what each page says, and doesn't", () => {
  test.use({ viewport: DESKTOP });

  test("security teams: hourly certificates, integrations only on Business and above, STIX on request, source count not typed", async ({ page }) => {
    await open(page, "/solutions/security-teams");
    await expect(page.locator("#how-it-works")).toContainText("every hour");
    const statuses = await page.locator("#integrations li em").allTextContents();
    expect(statuses.length).toBe(6);
    for (const s of statuses) expect(["Business and Enterprise", "On request"]).toContain(s.trim());
    await expect(page.locator("#integrations li", { hasText: "STIX 2.1" }).locator("em")).toHaveText("On request");
    await expect(page.locator("#integrations")).toContainText(/set up with our team/);
    await expect(page.locator("#takedowns")).toContainText(/Off .* Semi-auto .* Auto/);
    // The source figure comes from proof.ts sourcesLabel (stats.json active_feeds >= 40 reads "40+"), never an exact count.
    // StepList renders its text twice (desktop grid and phone list), so every match must be the same label.
    const text = (await page.locator(".pp").textContent()) ?? "";
    const figures = [...text.matchAll(/\b(\d+\+?) threat and intelligence sources/g)].map((m) => m[1]);
    for (const f of figures) expect(f).toBe("40+");
    expect(text).not.toMatch(/\b4[1-9] (?:threat|sources)/);
  });

  test("brand and legal: six networks, Apple App Store only, trademark Business and above, authorization", async ({ page }) => {
    await open(page, "/solutions/brand-and-legal");
    await expect(page.locator("#profiles")).toContainText("X, LinkedIn, Instagram, TikTok, GitHub and YouTube");
    await expect(page.locator("#profiles")).toContainText(/handles only/i);
    await expect(page.locator("#executives")).not.toContainText(/linkedin/i);
    await expect(page.locator("#apps")).toContainText(/Apple App Store/);
    await expect(page.locator("#apps")).toContainText(/Google Play isn't covered/);
    await expect(page.locator("#trademark")).toContainText(/Business and above/);
    await expect(page.locator("#trademark")).toContainText(/adds no detection source/i);
    await expect(page.locator("#authorization")).toContainText(/can't submit a takedown without your approval or your signed rules/i);
    await expect(page.locator("#authorization")).toContainText(/We don't file those for you/);
  });

  test("fraud and customer trust: each offer carries its plan, Abuse Mailbox is Enterprise", async ({ page }) => {
    await open(page, "/solutions/fraud-and-customer-trust");
    await expect(page.locator("#abuse-mailbox .ps-eyebrow")).toHaveText(/Abuse Mailbox · Enterprise/);
    await expect(page.locator("#takedowns .ps-eyebrow")).toHaveText(/Phishing-site takedowns · Professional\+/);
    await expect(page.locator("#takedowns .ft-mode h3")).toHaveText(["Off", "Semi-auto", "Auto"]);
    await expect(page.locator("#takedowns")).toContainText("Nothing is filed without your approval or your signed rules");
  });

  test("teams without a SOC: Averrow SOC wording, what staff can't do, no response-time promise", async ({ page }) => {
    await open(page, "/solutions/teams-without-a-soc");
    const managed = page.locator("#managed");
    await expect(managed).toContainText("marked as Averrow SOC");
    await expect(managed).toContainText(/acknowledge them, change their status and take them on/i);
    await expect(managed).toContainText(/never submit a takedown without your authorization/i);
    await expect(managed).toContainText(/can't sign or revoke the authorization/i);
    await expect(managed).toContainText(/can't create or edit your investigations/i);
    await expect(managed).toContainText(/Staff are never named/);
    // Staff alert actions do not reach the customer's audit log, so the page must not say they do.
    expect(((await page.locator(".pp").textContent()) ?? "")).not.toMatch(/audit[- ]log/i);
    // Takedowns: staff may draft; nothing is filed without approval or signed rules. The records row
    // limits itself to investigations and the authorization.
    const records = page.locator("#scope tr", { hasText: "Your records" });
    await expect(records).toContainText("Your investigations and your takedown authorization");
    await expect(records).toContainText("Our analysts may draft takedowns; nothing is filed without your approval or signed rules.");
    await expect(records).not.toContainText(/takedown requests/i);
    await expect(page.locator("#triage")).toContainText("Automatic triage runs on most finding types before you see them");
    await expect(page.locator("#triage")).not.toContainText("every finding");
    await expect(page.locator("#scope")).toContainText(/promised response or resolution times/i);
    const text = (await page.locator(".pp").textContent()) ?? "";
    expect(text).not.toMatch(/within (?:\d+|one|an?|a few) (?:minutes?|hours?|business days?|days?)/i);
    expect(text).not.toMatch(/\bguarantee[sd]?\b(?! that)/i);
  });

  test("mssp: one organisation per client, set up by us, one login across orgs is plainly not available yet", async ({ page }) => {
    await open(page, "/solutions/mssp");
    await expect(page.locator("#model")).toContainText(/its own isolated organisation/i);
    await expect(page.locator("#model")).toContainText(/Our team creates it with you/);
    await expect(page.locator("#availability")).toContainText(/One login across several client organisations\.\s*On the roadmap and not available yet/);
    await expect(page.locator("#availability")).toContainText(/White-label is not available/);
    await expect(page.locator("#availability")).toContainText(/You can't add clients yourself/);
    await expect(page.locator("#availability")).toContainText(/Everyone in an organisation sees every brand/);
    const statuses = await page.locator("#integrations li em").allTextContents();
    for (const s of statuses) expect(["Business and Enterprise", "On request", "Roadmap"]).toContain(s.trim());
    // Absorbed from /partners: the integrations and STIX on request, nothing live.
    await expect(page.locator("#integrations li", { hasText: "STIX 2.1" }).locator("em")).toHaveText("On request");
    await expect(page.locator("#integrations")).not.toContainText(/\blive\b/i);
    await expect(page.locator("#integrations")).not.toContainText(/email/i);
  });

  test("/scan carries the 'why new companies get targeted' copy below the form", async ({ page }) => {
    await open(page, "/scan");
    const why = page.locator("#scanInput .scan-why");
    await expect(why).toHaveCount(1);
    await expect(why.locator("h2")).toHaveText("Why new companies get targeted");
    await expect(why.locator("li")).toHaveCount(3);
    // It sits below the form.
    const [form, sec] = await Promise.all([page.locator("#scanForm").boundingBox(), why.boundingBox()]);
    expect(sec!.y).toBeGreaterThan(form!.y + form!.height - 1);
  });
});

// ── banned phrases ──────────────────────────────────────────────────────

const BANNED: Array<[string, RegExp]> = [
  ["multi-client console", /multi-client console|multi-tenant console|manage all your clients/i],
  ["data layer", /data[- ]layer/i],
  ["Live (status tile)", /\bLive\b/],
  ["email alert delivery", /email alert|alerts? (?:by|via|over) email|alert delivery|push notification/i],
  ["a price", /\$\s?\d|per month|\/mo\b|\bUSD\b|\bCAD\b/i],
  ["SLA", /\bSLA\b|service[- ]level/i],
  ["AI claims", /\bAI\b|\bAI-powered\b|machine learning|\bLLM\b/],
  ["real-time / 24/7", /real-?time|24\/7/i],
  ["self-serve", /self-?serve|one-click/i],
  ["per-member brand scoping", /per-member|brand[- ]level (?:access|scoping)/i],
  ["aviation framing", /aviat|military|arrow heritage|cockpit/i],
  ["invented customers", /\bour customers include\b|trusted by|case stud/i],
  ["add a client without new infrastructure", /without (?:spinning up )?new infrastructure/i],
];

test.describe("banned phrases", () => {
  test.use({ viewport: DESKTOP });

  for (const pg of PAGES) {
    test(`${pg.path}: none of the banned claims, no real domains`, async ({ page }) => {
      await open(page, pg.path);
      // textContent also covers the collapsed mobile copies.
      const text = (await page.locator(".pp").textContent()) ?? "";
      const meta = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
      const all = `${text}\n${meta}`;
      expect(text.length).toBeGreaterThan(500);
      for (const [name, re] of BANNED) expect(all, `${pg.path} matched "${name}"`).not.toMatch(re);

      // White-label may only appear as "not available".
      for (const m of all.matchAll(/white-?label/gi)) {
        const near = all.slice(Math.max(0, m.index! - 40), m.index! + 120);
        expect(near, `${pg.path} white-label outside a "not available" line`).toMatch(/not available/i);
      }
      // One login across client organisations is never offered as existing.
      for (const m of all.matchAll(/one login across/gi)) {
        expect(all.slice(m.index!, m.index! + 160), `${pg.path} one login across orgs`).toMatch(/roadmap|not available/i);
      }

      // Only the fictional .example world appears in samples (averrow.com is ours).
      const real = (text.match(/\b[a-z0-9-]+\.(?:com|net|org|io|co|ca|app|dev|ai|info)\b/gi) ?? []).filter((d) => d.toLowerCase() !== "averrow.com");
      expect(real, `${pg.path} shows real-looking domains`).toEqual([]);
      // The proof strip, when present, is dated.
      const strip = page.locator("[data-proof-strip]");
      if (await strip.count()) await expect(strip.locator("time")).toHaveCount(1);
    });
  }
});

// ── layout: no horizontal scroll, 12px floor ────────────────────────────

test.describe("mobile (390px)", () => {
  test.use({ viewport: PHONE });

  for (const theme of ["dark", "light"] as const) {
    for (const pg of PAGES) {
      test(`no horizontal scroll, ${theme}: ${pg.path}`, async ({ page }) => {
        await open(page, pg.path, theme);
        await page.waitForLoadState("networkidle").catch(() => {});
        // Open every disclosure: the expanded state is the widest.
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
        const m = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          vw: window.innerWidth,
        }));
        expect(Math.max(m.doc, m.body), `${pg.path} scrollWidth vs viewport ${m.vw}`).toBeLessThanOrEqual(m.vw);
      });
    }
  }
});

test.describe("type size", () => {
  for (const [name, vp] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
    test.describe(name, () => {
      test.use({ viewport: vp });
      for (const pg of PAGES) {
        test(`${pg.path}: every visible text node is >= 12px`, async ({ page }) => {
          await open(page, pg.path);
          await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
          const small = await page.evaluate(() => {
            const out: string[] = [];
            const seen = new Set<Element>();
            const walker = document.createTreeWalker(document.querySelector("#content") ?? document.body, NodeFilter.SHOW_TEXT);
            for (let t = walker.nextNode(); t; t = walker.nextNode()) {
              const el = t.parentElement;
              if (!el || seen.has(el) || !t.textContent?.trim()) continue;
              seen.add(el);
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.closest(".st-sr, [hidden]")) continue;
              const size = parseFloat(cs.fontSize);
              if (size < 11.99) out.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} "${t.textContent.trim().slice(0, 28)}" ${size}px`);
            }
            return out;
          });
          expect(small, `${pg.path} text below 12px`).toEqual([]);
        });
      }
    });
  }
});

// ── retired URLs ────────────────────────────────────────────────────────

const REDIRECTS: Array<[string, string]> = [
  ["/solutions/startups", "/scan"],
  ["/solutions/mid-market", "/solutions/teams-without-a-soc"],
  ["/partners", "/solutions/mssp"],
  ["/press", "/company#press"],
  ["/careers", "/company#careers"],
];

test.describe("redirects", () => {
  test("public/_redirects maps each retired URL with a 301 (what Cloudflare serves)", () => {
    const rules = fs
      .readFileSync(path.join(ROOT, "public/_redirects"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/\s+/));
    for (const [from, to] of REDIRECTS) {
      for (const f of [from, `${from}/`]) {
        const rule = rules.find((r) => r[0] === f);
        expect(rule, `rule for ${f}`).toBeTruthy();
        expect(rule?.[1]).toBe(to);
        expect(rule?.[2]).toBe("301");
      }
    }
  });

  for (const [from, to] of REDIRECTS) {
    test(`${from} lands on ${to} (the stub)`, async ({ page }) => {
      await page.goto(from);
      const [toPath, toHash] = to.split("#");
      await page.waitForURL((u) => u.pathname.replace(/\/$/, "") === toPath && (toHash ? u.hash === `#${toHash}` : true));
      const u = new URL(page.url());
      expect(u.pathname.replace(/\/$/, "")).toBe(toPath);
      if (toHash) expect(u.hash).toBe(`#${toHash}`);
    });
  }

  test("the stubs are noindex, point at the destination, carry no canonical, and are not in the sitemap", async ({ request }) => {
    for (const [from, to] of REDIRECTS) {
      const html = await (await request.get(from)).text();
      expect(html, from).toContain('name="robots" content="noindex"');
      expect(html, from).toContain(`url=${to}`);
      expect(html, from).not.toContain('rel="canonical"');
    }
    const map = await (await request.get("/sitemap.xml")).text();
    for (const [from] of REDIRECTS) expect(map, `${from} in the sitemap`).not.toContain(`https://averrow.com${from}<`);
    for (const p of ["/solutions", "/solutions/security-teams", "/solutions/brand-and-legal", "/solutions/fraud-and-customer-trust", "/solutions/teams-without-a-soc", "/solutions/mssp"]) {
      expect(map, `${p} missing from the sitemap`).toContain(`https://averrow.com${p}<`);
    }
  });

  test("no internal link on the built pages points at a retired URL", async ({ request }) => {
    const pages = ["/", "/platform", "/pricing", "/docs", "/docs/getting-started", ...PAGES.map((p) => p.path), "/scan", "/company"];
    for (const p of pages) {
      const html = await (await request.get(p)).text();
      for (const old of ['href="/partners', 'href="/solutions/startups', 'href="/solutions/mid-market', 'href="/press"', 'href="/careers"']) {
        expect(html, `${p} links to ${old}`).not.toContain(old);
      }
    }
  });
});

// ── nav + footer ────────────────────────────────────────────────────────

test.describe("nav and footer", () => {
  test.use({ viewport: DESKTOP });

  const SOLUTIONS = ["/solutions", "/solutions/security-teams", "/solutions/brand-and-legal", "/solutions/fraud-and-customer-trust", "/solutions/teams-without-a-soc", "/solutions/mssp"];
  const COMPANY = ["/company", "/about", "/why-averrow", "/contact"];

  const hrefsIn = (page: Page, sel: string) =>
    page.locator(sel).evaluateAll((as) => as.map((a) => ((a as HTMLAnchorElement).getAttribute("href") ?? "").replace(/\/$/, "") || "/"));

  test("Solutions dropdown: the hub, four role pages and MSSPs", async ({ page }) => {
    await open(page, "/");
    expect(await hrefsIn(page, ".nav-item:has(> .nav-link[data-path='/solutions']) .nav-menu a")).toEqual(SOLUTIONS);
  });

  test("Company dropdown: Company, About, Why Averrow, Contact (Press and Careers are anchors on /company)", async ({ page }) => {
    await open(page, "/");
    expect(await hrefsIn(page, ".nav-item:has(> .nav-link[data-path='/company']) .nav-menu a")).toEqual(COMPANY);
  });

  test("footer Solutions and Company columns match the dropdowns", async ({ page }) => {
    await open(page, "/");
    const col = (title: string) => page.locator(".footer-col", { has: page.locator(".footer-col-title", { hasText: new RegExp(`^${title}$`) }) });
    const sol = await hrefsIn(page, ".footer-col:has(.footer-col-title:text-is('Solutions')) a");
    expect(sol.slice(0, SOLUTIONS.length)).toEqual(SOLUTIONS);
    expect(await hrefsIn(page, ".footer-col:has(.footer-col-title:text-is('Company')) a")).toEqual(COMPANY);
    // No retired link survives in the footer.
    const all = await page.locator(".footer a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
    for (const old of ["/partners", "/press", "/careers", "/solutions/startups", "/solutions/mid-market"]) expect(all).not.toContain(old);
    await expect(col("Solutions")).toHaveCount(1);
  });

  test("the Company hub lights up on About, Why Averrow and Contact; Security lights Research (its footer home)", async ({ page }) => {
    for (const p of ["/company", "/about", "/why-averrow", "/contact"]) {
      await open(page, p);
      await expect(page.locator(".nav-link.is-active"), p).toHaveAttribute("data-path", "/company");
    }
    await open(page, "/security");
    await expect(page.locator(".nav-link.is-active")).toHaveAttribute("data-path", "/resources");
    // Not in the Company dropdown, and the footer lists it under Research.
    expect(await hrefsIn(page, ".nav-item:has(> .nav-link[data-path='/company']) .nav-menu a")).not.toContain("/security");
    expect(await hrefsIn(page, ".footer-col:has(.footer-col-title:text-is('Research')) a")).toContain("/security");
  });

  test("footer: Solutions lists only the role pages; Plans, scan, demo and log in sit under Get started", async ({ page }) => {
    await open(page, "/");
    expect(await hrefsIn(page, ".footer-col:has(.footer-col-title:text-is('Solutions')) a")).toEqual(SOLUTIONS);
    expect(await hrefsIn(page, ".footer-col:has(.footer-col-title:text-is('Get started')) a")).toEqual(["/pricing", "/scan", "/demo", "/login"]);
  });
});
