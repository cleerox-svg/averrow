import { test, expect } from "@playwright/test";

/*
 * Smoke tests for the Astro marketing site. One per ported route —
 * enough to catch a build regression that breaks a page entirely,
 * not enough to verify every styling detail. Visual regression goes
 * in a separate suite if/when that gets set up.
 */

const PAGES: Array<{
  path: string;
  title: RegExp;
  heading: RegExp;
}> = [
  { path: "/",             title: /Averrow/,             heading: /brand protection that traces the operation/i },
  { path: "/platform",     title: /Platform/,            heading: /every place your brand is impersonated/i },
  { path: "/pricing",      title: /^Plans — Averrow/,     heading: /plans built around\s*what you need watched/i },
  // Keep this loose: copy on About changes, the page's subject (threat actors) does not.
  { path: "/about",        title: /About/,               heading: /threat actors/i },
  { path: "/security",     title: /Security/,            heading: /security & trust/i },
  { path: "/contact",      title: /Contact/,             heading: /get in touch/i },
  { path: "/demo",         title: /Book a Demo/,         heading: /see averrow on your own domain/i },
  { path: "/company",      title: /Company/,             heading: /the company behind averrow/i },
  { path: "/why-averrow",  title: /Why Averrow/,         heading: /check us before you trust us/i },
  { path: "/report-abuse", title: /Report Brand Abuse/,  heading: /saw something suspicious/i },
  { path: "/blog",         title: /Blog/,                heading: /insights & intelligence/i },
  { path: "/changelog",    title: /Changelog/,           heading: /what.s new/i },
];

for (const page of PAGES) {
  test(`${page.path} loads with correct title + heading`, async ({ page: p }) => {
    const consoleErrors: string[] = [];
    const brokenLocal: string[] = [];
    p.on("console", msg => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    // "Failed to load resource" console lines carry no URL, so judge broken
    // resources by response instead: any same-origin 4xx/5xx counts, except
    // the analytics beacon, the Worker-served public API (live stats refresh; falls back to the build snapshot) and brand/icon files (served by the Worker's static
    // assets, not by the preview server). Third-party failures (fonts blocked in a
    // sandbox, cert errors) are not this site's regressions.
    p.on("response", res => {
      const url = new URL(res.url());
      if (url.origin === new URL(p.url() === "about:blank" ? res.url() : p.url()).origin && res.status() >= 400 && !/^\/(api\/track|api\/v1\/public\/|favicon|icon-|brand\/)/.test(url.pathname)) {
        brokenLocal.push(`${res.status()} ${url.pathname}`);
      }
    });

    const response = await p.goto(page.path);
    expect(response?.status(), `HTTP status for ${page.path}`).toBeLessThan(400);
    await expect(p).toHaveTitle(page.title);
    await expect(p.locator("h1").first()).toContainText(page.heading);

    const real = consoleErrors.filter(
      e => !/favicon|net::ERR_BLOCKED|Failed to load resource/i.test(e),
    );
    expect(real, `Console errors on ${page.path}:\n${real.join("\n")}`).toHaveLength(0);
    expect(brokenLocal, `Broken same-origin resources on ${page.path}`).toHaveLength(0);
  });
}

test("/blog/feed.xml returns valid RSS", async ({ request }) => {
  const res = await request.get("/blog/feed.xml");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('<?xml version="1.0"');
  expect(body).toContain("<rss");
  expect(body).toContain("<channel>");
});

test("/changelog/feed.xml returns valid RSS", async ({ request }) => {
  const res = await request.get("/changelog/feed.xml");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain("<rss");
});

test("/sitemap.xml lists at least the ported routes", async ({ request }) => {
  const res = await request.get("/sitemap.xml");
  expect(res.status()).toBe(200);
  const body = await res.text();
  for (const p of [
    "/about",
    "/platform",
    "/pricing",
    "/security",
    "/contact",
    "/demo",
    "/company",
    "/why-averrow",
    "/blog",
    "/changelog",
    "/report-abuse",
    "/platform/lookalike-domains",
    "/platform/impersonation",
    "/platform/takedowns",
    "/platform/abuse-mailbox",
  ]) {
    expect(body, `sitemap missing ${p}`).toContain(p);
  }
  // Retired URLs are redirects, not pages: never listed.
  for (const gone of ["/platform/ai-agents", "/platform/social-monitoring", "https://averrow.com/abuse-mailbox"]) {
    expect(body, `sitemap must not list ${gone}`).not.toContain(`${gone}<`);
  }
});

test.describe("theme", () => {
  test("defaults to dark even when the OS prefers light", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "light" });
    const p = await ctx.newPage();
    await p.goto("/");
    await expect(p.locator("html")).toHaveAttribute("data-theme", "dark");
    await ctx.close();
  });

  test("footer toggle switches dark <-> light and persists", async ({ page: p }) => {
    await p.goto("/");
    const html = p.locator("html");
    // The toggle moved out of the nav and into the footer.
    await expect(p.locator("nav .theme-toggle")).toHaveCount(0);
    const button = p.locator("footer .theme-toggle");
    await expect(button).toBeVisible();
    await expect(html).toHaveAttribute("data-theme", "dark");

    await button.click();
    await expect(html).toHaveAttribute("data-theme", "light");
    expect(await p.evaluate(() => localStorage.getItem("averrow-theme"))).toBe("light");

    await p.reload();
    await expect(html).toHaveAttribute("data-theme", "light");

    await p.locator("footer .theme-toggle").click();
    await expect(html).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("homepage hero", () => {
  test("H1, lede and scan form", async ({ page: p }) => {
    await p.goto("/");
    await expect(p.locator("h1")).toHaveCount(1);
    await expect(p.locator("h1")).toHaveText(/^Brand protection that traces the operation\.$/);
    await expect(p.locator("h1 em")).toHaveText("traces the operation");
    await expect(p.locator(".hero-eyebrow")).toHaveText("Digital risk protection · threat-actor intelligence");
    const lede = p.locator(".hero-lede").first();
    await expect(lede).toContainText("impersonation accounts and copycat apps");
    await expect(lede).toContainText("and files takedowns for lookalike domains and phishing URLs under your authorization");
    await expect(lede).toContainText("groups phishing domains that share hosting or certificates into one operation");

    const form = p.locator("form#scanForm");
    await expect(form).toHaveAttribute("action", /\/assess$/);
    await expect(form).toHaveAttribute("method", /post/i);
    await expect(form.locator('input[name="domain"]')).toBeVisible();
    await expect(form.getByRole("button", { name: /scan your domain/i })).toBeVisible();
    await expect(p.locator("#hero").getByText("Free scan · no sign-up · no card")).toBeVisible();
    await expect(p.locator("#hero").getByRole("link", { name: "Book a demo" })).toHaveAttribute("href", "/demo");
  });

  test("meta title and description are the approved strings", async ({ page: p }) => {
    await p.goto("/");
    await expect(p).toHaveTitle("Averrow — Brand protection that traces the operation");
    const desc =
      "Find lookalike domains, impersonation accounts and copycat apps aimed at your brand, and file takedowns for lookalike domains and phishing URLs. Free scan, no sign-up.";
    await expect(p.locator('meta[name="description"]')).toHaveAttribute("content", desc);
    await expect(p.locator('meta[property="og:description"]')).toHaveAttribute("content", desc);
    const ld = await p.locator('script[type="application/ld+json"]').first().textContent();
    expect(ld).not.toMatch(/related lookalike domains|fake social profiles|cloned apps/);
    expect(ld).toContain("impersonation accounts and copycat apps");
  });

  test("no fake live feed, no retired claims", async ({ page: p }) => {
    await p.goto("/");
    const text = (await p.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("live threat feed");
    expect(text).not.toContain("<5min");
    expect(text).not.toContain("ai agents");
    expect(text).not.toContain("42-agent");
    expect(text).not.toContain("beavertooth");
    // Register L48/L49/H1-H5: retired hero and story wording.
    for (const banned of ["names changed", "nine lookalikes", "fake profiles", "cloned app"]) {
      expect(text, banned).not.toContain(banned);
    }
    const hero = (await p.locator("#hero").innerText()).toLowerCase();
    for (const banned of ["19 findings", "actor attributed", "queued", "as6450", "/24", "serial", "registrar,", "lookalike domains that"]) {
      expect(hero, banned).not.toContain(banned);
    }
    await expect(p.getByText("Fictional example · operation mapping is on the Enterprise plan")).toBeVisible();
    // The old OperationStory section is gone (the hero tells that story now).
    await expect(p.locator("#operation-story")).toHaveCount(0);
  });

  test("platform band is dated and shows real numbers", async ({ page: p }) => {
    await p.goto("/");
    const band = p.locator(".band-grid");
    await expect(band.locator(".band-lbl")).toContainText(/From the platform · updated \d{1,2} \w{3} \d{4}/);
    await expect(band.locator(".band-m")).toHaveCount(5);
    await expect(band).toContainText("40+");
    await expect(p.locator(".cover-chip")).toHaveCount(8);
  });

  test("section heads follow the hero copy doc", async ({ page: p }) => {
    await p.goto("/");
    await expect(p.locator("#cv-title")).toHaveText("Where attackers pretend to be you.");
    await expect(p.locator(".cta-headline")).toHaveText("See what's aimed at your brand.");
  });
});

test.describe("navigation (desktop bar)", () => {
  test.beforeEach(({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 900, "desktop nav collapses into the hamburger below 900px");
  });

  test("has exactly 5 top-level links and the three actions", async ({ page: p }) => {
    await p.goto("/");
    const nav = p.getByRole("navigation", { name: "Main" });
    const links = nav.locator("ul.nav-links > li.nav-item > a.nav-link");
    await expect(links).toHaveText(["Platform", "Solutions", "Plans", "Research", "Company"]);
    await expect(nav.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    await expect(nav.getByRole("link", { name: "Book a demo" })).toHaveAttribute("href", "/demo");
    await expect(nav.getByRole("link", { name: "Scan your domain" })).toHaveAttribute("href", "/scan");
  });

  test("dropdown opens on keyboard focus", async ({ page: p }) => {
    await p.goto("/");
    const menu = p.locator("li.nav-item", { hasText: "Platform" }).first().locator(".nav-menu");
    await expect(menu).toBeHidden();
    await p.locator("a.nav-link", { hasText: "Platform" }).focus();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: /Email security/ })).toBeVisible();
  });
});

test.describe("navigation (mobile menu)", () => {
  test.beforeEach(({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 900, "mobile menu is only used below 900px");
  });

  test("hamburger menu has the 5 hubs and the actions", async ({ page: p }) => {
    await p.goto("/");
    const toggle = p.getByRole("button", { name: "Toggle menu" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    const menu = p.locator("#mobile-menu");
    await expect(menu).toBeVisible();
    for (const name of ["Platform", "Solutions", "Plans", "Research", "Company", "Log in", "Book a demo", "Scan your domain"]) {
      await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
    }
  });
});
