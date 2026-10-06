import { test, expect, type Page } from "@playwright/test";

/*
 * Responsive / horizontal-overflow guard for the marketing site.
 *
 * Why this exists: the platform's UI changes had been shipping with
 * static-only responsive review (nothing rendered at a real viewport)
 * because the browser MCP tooling hardcodes the Chrome *channel* and
 * couldn't launch. `@playwright/test`'s default chromium resolves via
 * PLAYWRIGHT_BROWSERS_PATH to the pre-installed browser, so it DOES run
 * here — this spec turns "did anyone check it on mobile?" into a gate.
 *
 * What it asserts: for every key route at mobile / tablet / desktop
 * widths, the page must not scroll horizontally (a page wider than its
 * own viewport is the #1 responsive defect and is almost always a bug).
 * On failure the assertion names the widest offending element so the
 * regression is easy to locate.
 *
 * Run:
 *   pnpm --filter @averrow/marketing test:responsive
 * It reuses playwright.config.ts's webServer (build + preview) and the
 * pre-installed chromium, so no extra setup is needed.
 *
 * Extending to the SPAs (averrow-ops / averrow-tenant): those pages sit
 * behind cookie-refresh auth, so a full-app render needs a live backend.
 * The proven pattern for validating a single authed component's layout
 * is to mount it in isolation in a real browser with the network layer
 * stubbed (real Tailwind build, mocked `@/lib/api` returning the
 * `{ data }` envelope the hooks read, and a mock `useAuth`). See
 * docs/VISUAL_QA.md for the recipe.
 */

// Curated key routes — the highest-traffic + most-recently-changed pages.
// Add a route here when you ship a new marketing page.
const ROUTES = [
  "/",
  "/platform/",
  "/platform/lookalike-domains/",
  "/platform/impersonation/",
  "/platform/takedowns/",
  "/platform/abuse-mailbox/",
  "/platform/campaign-intelligence/",
  "/platform/email-security/",
  "/platform/threat-detection/",
  "/why-averrow/",
  "/pricing/",
  "/solutions/",
  "/solutions/mssp/",
  "/resources/",
  "/resources/sample-operation-report/",
  "/resources/methodology/",
  "/changelog/",
  "/company/",
  "/contact/",
  "/blog/",
  "/security/",
];

// Representative breakpoints: small phone, tablet, desktop.
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

/** Returns overflow details when the document is wider than its viewport. */
async function findHorizontalOverflow(page: Page, viewportWidth: number) {
  return page.evaluate((vw) => {
    const doc = document.documentElement;
    const scrollWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0);
    if (scrollWidth <= vw + 1) return null;
    // Identify the widest element spilling past the right edge — the culprit.
    let worst: { tag: string; cls: string; overflowPx: number; width: number } | null = null;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0) {
        const overflowPx = Math.round(r.right - vw);
        if (!worst || overflowPx > worst.overflowPx) {
          worst = {
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === "string" ? el.className : "").slice(0, 80),
            overflowPx,
            width: Math.round(r.width),
          };
        }
      }
    }
    return { scrollWidth, worst };
  }, viewportWidth);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const route of ROUTES) {
      test(`no horizontal overflow: ${route}`, async ({ page }) => {
        const res = await page.goto(route, { waitUntil: "load" });
        expect(res?.ok(), `route ${route} should load`).toBeTruthy();
        // Let fonts/layout settle so late-loading assets can't shift width.
        await page.waitForLoadState("networkidle").catch(() => {});

        const overflow = await findHorizontalOverflow(page, vp.width);
        const detail = overflow
          ? `scrollWidth=${overflow.scrollWidth} (viewport ${vp.width}) — ` +
            (overflow.worst
              ? `widest offender: <${overflow.worst.tag} class="${overflow.worst.cls}"> ` +
                `spills +${overflow.worst.overflowPx}px (width ${overflow.worst.width}px)`
              : "no single element crosses the edge (margin- or body-level overflow)")
          : "";
        expect(overflow, `${route} @${vp.name}: ${detail}`).toBeNull();
      });
    }
  });
}

/*
 * The nav must stay on ONE row at every desktop width we care about.
 * (It used to wrap "Why Averrow" / "Free Scan" / "Get a Demo" at 1440.)
 * 1024 is below the point where the secondary "Book a demo" button is
 * dropped, so it is checked separately for overflow only.
 */
for (const width of [1024, 1280, 1440]) {
  test.describe(`nav on one row @${width}`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`nav does not wrap or overflow`, async ({ page }) => {
      await page.goto("/", { waitUntil: "load" });
      const m = await page.evaluate(() => {
        const inner = document.querySelector(".nav-inner") as HTMLElement;
        const items = Array.from(
          document.querySelectorAll<HTMLElement>(".nav-inner .nav-brand, .nav-link, .nav-login, .nav-cta"),
        ).filter((el) => el.offsetParent !== null);
        const tops = items.map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2));
        const maxHeight = Math.max(...items.map((el) => el.getBoundingClientRect().height));
        return {
          navHeight: inner.getBoundingClientRect().height,
          centreSpread: Math.max(...tops) - Math.min(...tops),
          maxItemHeight: maxHeight,
          overflow: inner.scrollWidth - inner.clientWidth,
          count: items.length,
        };
      });
      expect(m.count).toBeGreaterThanOrEqual(8);
      expect(m.navHeight, "nav bar height").toBeLessThanOrEqual(64);
      expect(m.centreSpread, "all nav items share one row").toBeLessThanOrEqual(6);
      expect(m.maxItemHeight, "no nav item wraps to two lines").toBeLessThanOrEqual(44);
      expect(m.overflow, "nav content overflows its container").toBeLessThanOrEqual(0);
    });
  });
}

test("homepage story: tabs scroll in a row at 390 and the page does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const s = page.locator("#operation-story");
  await s.scrollIntoViewIfNeeded();
  const m = await page.evaluate(() => {
    const ol = document.querySelector("#operation-story [data-steps]") as HTMLElement;
    return { doc: document.documentElement.scrollWidth, vw: window.innerWidth, scrolls: ol.scrollWidth > ol.clientWidth, flex: getComputedStyle(ol).display };
  });
  expect(m.doc).toBeLessThanOrEqual(m.vw);
  expect(m.flex).toBe("flex");
  expect(m.scrolls).toBe(true);
  // No layout shift between steps: the stage height is constant.
  const h = async () => (await s.locator("[data-stage]").boundingBox())!.height;
  const before = await h();
  for (const i of [1, 2, 3, 4]) {
    await s.getByRole("tab").nth(i).click();
    expect(Math.abs((await h()) - before)).toBeLessThan(1);
  }
});
