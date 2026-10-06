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
  { path: "/",             title: /Averrow/,             heading: /who is attacking your brand/i },
  { path: "/platform",     title: /Platform/,            heading: /every place your brand is impersonated/i },
  { path: "/pricing",      title: /^Plans — Averrow/,     heading: /plans built around\s*what you need watched/i },
  // Keep this loose: copy on About changes, the page's subject (threat actors) does not.
  { path: "/about",        title: /About/,               heading: /threat actors/i },
  { path: "/security",     title: /Security/,            heading: /security & trust/i },
  { path: "/contact",      title: /Contact/,             heading: /get in touch/i },
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
    await expect(p.locator("h1")).toHaveText(/See who is attacking your brand, and shut them down\./);

    const form = p.locator("form#scanForm");
    await expect(form).toHaveAttribute("action", /\/assess$/);
    await expect(form).toHaveAttribute("method", /post/i);
    await expect(form.locator('input[name="domain"]')).toBeVisible();
    await expect(form.getByRole("button", { name: /scan your domain/i })).toBeVisible();
  });

  test("no fake live feed, no retired claims", async ({ page: p }) => {
    await p.goto("/");
    const text = (await p.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("live threat feed");
    expect(text).not.toContain("<5min");
    expect(text).not.toContain("ai agents");
    expect(text).not.toContain("42-agent");
    expect(text).not.toContain("beavertooth");
    await expect(p.getByText("Illustrative example · names changed")).toBeVisible();
  });

  test("platform band is dated and shows real numbers", async ({ page: p }) => {
    await p.goto("/");
    const band = p.locator(".band-grid");
    await expect(band.locator(".band-lbl")).toContainText(/From the platform · updated \d{1,2} \w{3} \d{4}/);
    await expect(band.locator(".band-m")).toHaveCount(5);
    await expect(band).toContainText("40+");
    await expect(p.locator(".cover-chip")).toHaveCount(8);
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

test.describe("homepage: follow one operation", () => {
  const TITLES = [
    "A lookalike is registered",
    "It goes live",
    "It isn't alone",
    "It spreads beyond domains",
    "It comes down",
  ];

  test("renders five steps, the illustrative label and working links", async ({ page: p, request }) => {
    await p.goto("/");
    const s = p.locator("#operation-story");
    await expect(s.getByRole("heading", { level: 2 })).toContainText("From one fake domain");
    await expect(s.getByRole("tab")).toHaveCount(5);
    await expect(s.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await expect(s.getByRole("tabpanel")).toHaveCount(1); // only the active panel is exposed
    await expect(s).toContainText("Illustrative example · names and domains changed · timings vary by operation");
    // The removed six-card section is gone.
    await expect(p.getByText("Automated analysis", { exact: true })).toHaveCount(0);
    // Step 1 makes no timing claim.
    await expect(s.getByRole("tabpanel")).toContainText("new-registration data");
    expect((await s.innerText()).toLowerCase()).not.toContain("within hours");

    // /scan is served by the Worker (same href as the nav CTA), so the preview server can't resolve it.
    await expect(s.getByRole("link", { name: "Scan your domain" })).toHaveAttribute("href", "/scan");
    const sample = s.getByRole("link", { name: /View the sample report/ });
    const href = await sample.getAttribute("href");
    expect(href).toMatch(/\/resources\/sample-operation-report$/);
    expect((await request.get(href!)).status()).toBeLessThan(400);
  });

  test("keyboard navigation changes the active step", async ({ page: p }) => {
    await p.goto("/");
    const tabs = p.locator("#operation-story").getByRole("tab");
    await tabs.first().focus();
    await p.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabs.nth(1)).toBeFocused();
    await p.keyboard.press("End");
    await expect(tabs.nth(4)).toHaveAttribute("aria-selected", "true");
    await expect(p.locator("#operation-story [role=tabpanel]:visible")).toContainText("8 of 14");
    await expect(p.locator("#operation-story [data-graph]")).toHaveAttribute("aria-label", /step 5 of 5/);
    await p.keyboard.press("Home");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    await p.keyboard.press("ArrowLeft"); // wraps
    await expect(tabs.nth(4)).toHaveAttribute("aria-selected", "true");
  });

  test("does not auto-advance under reduced motion", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const p = await ctx.newPage();
    await p.goto("/");
    await p.locator("#operation-story").scrollIntoViewIfNeeded();
    await p.waitForTimeout(6000);
    await expect(p.locator("#operation-story").getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
    await ctx.close();
  });

  test("auto-advances once, then stops, when motion is allowed", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "no-preference" });
    const p = await ctx.newPage();
    await p.goto("/");
    const tabs = p.locator("#operation-story").getByRole("tab");
    await p.locator("#operation-story [data-body]").scrollIntoViewIfNeeded();
    await expect(p.getByRole("button", { name: "Pause automatic advance" })).toBeVisible();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true", { timeout: 10000 });
    // Any interaction stops it and hides the control.
    await tabs.nth(1).click();
    await p.mouse.move(0, 0);
    await p.waitForTimeout(7200);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(p.locator(".os-ctl")).toBeHidden();
    await ctx.close();
  });

  test("pauses on hover and the pause control toggles", async ({ browser }, info) => {
    test.skip(info.project.name === "mobile", "hover is a pointer affordance; the control scrolls the story out of view on a phone");
    test.setTimeout(60_000);
    const ctx = await browser.newContext({ reducedMotion: "no-preference" });
    const p = await ctx.newPage();
    await p.goto("/");
    const s = p.locator("#operation-story");
    const tabs = s.getByRole("tab");
    await s.locator("[data-body]").scrollIntoViewIfNeeded();
    // Hover pauses.
    await s.locator("[data-stage]").hover();
    await p.waitForTimeout(7200);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    // Button: Pause -> Play, no advance while paused.
    const btn = s.locator(".os-ctl");
    await btn.click();
    await expect(btn).toHaveText("Play");
    await p.mouse.move(0, 0);
    await p.waitForTimeout(7200);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    // Play resumes.
    await btn.click();
    await expect(btn).toHaveText("Pause");
    await p.mouse.move(0, 0);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true", { timeout: 10000 });
    await ctx.close();
  });

  test("is fully readable with JavaScript disabled", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.goto("/");
    const s = p.locator("#operation-story");
    for (const t of TITLES) await expect(s.getByRole("heading", { level: 3, name: t })).toBeVisible();
    await expect(s.getByText("OP-2291 · Payroll-portal phishing kit")).toBeVisible();
    await expect(s.getByText("8 of 14")).toBeVisible();
    await expect(s.locator("svg[role=img]")).toHaveAttribute("aria-label", /14 domains/);
    await expect(s.getByRole("tab")).toHaveCount(0);
    await expect(s.locator(".os-ctl")).toHaveCount(0);
    await ctx.close();
  });
});
