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
  { path: "/",             title: /Averrow/,             heading: /under attack/i },
  { path: "/platform",     title: /Platform/,            heading: /one platform/i },
  { path: "/pricing",      title: /Pricing/,             heading: /one platform\. one price/i },
  { path: "/about",        title: /About/,               heading: /built from a heritage/i },
  { path: "/security",     title: /Security/,            heading: /security & trust/i },
  { path: "/contact",      title: /Contact/,             heading: /get in touch/i },
  { path: "/report-abuse", title: /Report Brand Abuse/,  heading: /saw something suspicious/i },
  { path: "/blog",         title: /Blog/,                heading: /insights & intelligence/i },
  { path: "/changelog",    title: /Changelog/,           heading: /what.s new/i },
];

for (const page of PAGES) {
  test(`${page.path} loads with correct title + heading`, async ({ page: p }) => {
    const consoleErrors: string[] = [];
    p.on("console", msg => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const response = await p.goto(page.path);
    expect(response?.status(), `HTTP status for ${page.path}`).toBeLessThan(400);
    await expect(p).toHaveTitle(page.title);
    await expect(p.locator("h1").first()).toContainText(page.heading);

    // No console errors except favicon-related noise local browsers
    // sometimes emit (mark them as expected).
    const real = consoleErrors.filter(
      e => !/favicon|net::ERR_BLOCKED/i.test(e),
    );
    expect(real, `Console errors on ${page.path}:\n${real.join("\n")}`).toHaveLength(0);
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
  ]) {
    expect(body, `sitemap missing ${p}`).toContain(p);
  }
});

test("theme cycle button switches between auto/dark/light", async ({ page: p }) => {
  await p.goto("/");
  const html = p.locator("html");
  const button = p.locator(".theme-toggle").first();
  await expect(button).toBeVisible();

  const before = await html.getAttribute("data-theme");
  expect(before).toMatch(/dark|light/);

  await button.click();
  await p.waitForTimeout(50);
  const after = await html.getAttribute("data-theme");
  // We can't predict the next value without knowing OS theme, but it
  // must be one of dark|light and the localStorage entry should be set.
  expect(after).toMatch(/dark|light/);
  const stored = await p.evaluate(() => localStorage.getItem("averrow-theme"));
  expect(stored).toMatch(/auto|dark|light/);
});
