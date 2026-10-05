import { test, expect, type Page } from "@playwright/test";
import { COVERAGE } from "../src/lib/coverage";
import { lookalikes30dLabel } from "../src/lib/proof";

/*
 * Homepage "Coverage" section (Section 4): eight surfaces that must match
 * the hero chips one-to-one, carry the right plan tag, link to real pages,
 * and collapse to <details> on phones. Also the pricing-page row that backs
 * the "Executive impersonation" tile.
 *
 * The section renders both a desktop grid (.cv-grid) and a mobile list
 * (.cv-list) and hides one by CSS, so each test pins an explicit viewport
 * instead of inheriting the project's device size.
 */

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const EXPECTED_PLAN: Record<string, string> = {
  "Lookalike domains": "Professional+",
  "TLS certificates": "Professional+",
  "Email authentication": "Professional+",
  "Social profiles": "Professional+",
  "Executive impersonation": "Professional+",
  "App stores": "Professional+",
  "Dark web": "Business+",
  "Abuse mailbox": "Enterprise",
};

async function openHome(page: Page) {
  // Preview server has no API; make the live-refresh path fail explicitly so
  // the build-time snapshot is what renders.
  await page.route("**/api/v1/public/stats", (route) => route.abort());
  await page.goto("/");
}

// ── pure function ───────────────────────────────────────────────────────

test("lookalikes30dLabel never yields 0: rounds live, else fallback, else null", () => {
  expect(lookalikes30dLabel(2481, "2,300+")).toBe("2,400+");
  expect(lookalikes30dLabel(0, "2,300+")).toBe("2,300+");
  expect(lookalikes30dLabel(null, "2,300+")).toBe("2,300+");
  expect(lookalikes30dLabel(undefined, undefined)).toBeNull();
  expect(lookalikes30dLabel(0, "")).toBeNull();
  expect(lookalikes30dLabel(0, null)).toBeNull();
});

// ── desktop ─────────────────────────────────────────────────────────────

test.describe("Coverage section (desktop)", () => {
  test.use({ viewport: DESKTOP });

  test("renders exactly 8 tiles whose names match the hero chips in order", async ({ page }) => {
    await openHome(page);
    const tiles = page.locator("#coverage .cv-grid > li");
    await expect(tiles).toHaveCount(8);
    const tileNames = await tiles.locator(".cv-tn").allTextContents();
    const chipNames = (await page.locator(".cover-chip").allTextContents()).map((t) => t.trim());
    expect(chipNames).toHaveLength(8);
    expect(tileNames.map((t) => t.trim())).toEqual(chipNames);
    expect(chipNames).toEqual(COVERAGE.map((c) => c.name));
  });

  test("plan tags: Dark web Business+, Abuse mailbox Enterprise, the rest Professional+", async ({ page }) => {
    await openHome(page);
    const tiles = page.locator("#coverage .cv-grid > li");
    const n = await tiles.count();
    const seen: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const name = ((await tiles.nth(i).locator(".cv-tn").textContent()) ?? "").trim();
      // Compact tiles show a short visual label ("Pro+") with the full label in
      // .cv-sr; big/wide tiles print the full label directly. Assert on the full one.
      const tag = tiles.nth(i).locator(".cv-pl");
      const sr = tag.locator(".cv-sr");
      seen[name] = (((await sr.count()) ? await sr.textContent() : await tag.textContent()) ?? "").trim();
    }
    expect(seen).toEqual(EXPECTED_PLAN);
  });

  test("every tile link resolves to a built page and its anchor exists", async ({ page }) => {
    await openHome(page);
    const hrefs = await page.locator("#coverage .cv-grid .cv-tn a").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
    // Every surface has a link today; a missing one would silently drop below 8.
    expect(hrefs).toHaveLength(COVERAGE.filter((c) => c.link).length);
    expect(hrefs).toHaveLength(8);
    // Also cover the "Compare plans" header link.
    hrefs.push((await page.locator("#coverage .cv-cmp").getAttribute("href")) ?? "");

    for (const href of new Set(hrefs)) {
      expect(href, "href present").toBeTruthy();
      const [path, hash] = href.split("#");
      const res = await page.request.get(path);
      expect(res.status(), `${href} should resolve`).toBe(200);
      if (hash) {
        const html = await res.text();
        expect(html, `${path} should contain id="${hash}"`).toMatch(new RegExp(`\\bid=["']${hash}["']`));
      }
    }
    // The anchors named in the spec are actually used.
    for (const a of ["#compare", "#lookalike", "#what-we-monitor"]) {
      expect(hrefs.some((h) => h.endsWith(a)), `some tile links to ${a}`).toBe(true);
    }
  });

  test("lookalike proof line shows a number, never 0, or is absent", async ({ page }) => {
    await openHome(page);
    const proof = page.locator("#coverage .cv-grid .cv-proof");
    const count = await proof.count();
    expect(count).toBeLessThanOrEqual(1);
    if (count === 1) {
      const figure = ((await proof.locator("b").textContent()) ?? "").trim();
      expect(figure).toMatch(/^[\d,]+\+?$/);
      expect(Number(figure.replace(/[^\d]/g, ""))).toBeGreaterThan(0);
      await expect(proof).toContainText("registered lookalikes found in the last 30 days");
    }
    // Wherever it appears (desktop or mobile copy) it must not be a bare 0.
    for (const b of await page.locator("#coverage .cv-proof b").allTextContents()) {
      expect(b.trim()).not.toMatch(/^0\+?$/);
    }
  });
});

// ── phone ───────────────────────────────────────────────────────────────

test.describe("Coverage section (390px)", () => {
  test.use({ viewport: PHONE });

  test("no horizontal scroll; grid hidden, list visible", async ({ page }) => {
    await openHome(page);
    await page.locator("#coverage").scrollIntoViewIfNeeded();
    await expect(page.locator("#coverage .cv-grid")).toBeHidden();
    await expect(page.locator("#coverage .cv-list")).toBeVisible();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth, "page wider than viewport").toBeLessThanOrEqual(clientWidth);

    // Expanded tiles must not introduce overflow either.
    const all = page.locator("#coverage .cv-list details");
    for (let i = 0; i < (await all.count()); i++) await all.nth(i).locator("summary").click();
    const after = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(after).toBeLessThanOrEqual(0);
  });

  test("tiles are <details> that expand on click", async ({ page }) => {
    await openHome(page);
    const items = page.locator("#coverage .cv-list details");
    await expect(items).toHaveCount(8);
    const first = items.first();
    await first.scrollIntoViewIfNeeded();
    await expect(first).not.toHaveAttribute("open", /.*/);
    await expect(first.locator(".cv-db")).toBeHidden();
    await first.locator("summary").click();
    await expect(first).toHaveAttribute("open", "");
    await expect(first.locator(".cv-db")).toBeVisible();
    await expect(first.locator(".cv-more")).toHaveAttribute("href", /\/platform\/threat-detection#lookalike$/);
    await first.locator("summary").click();
    await expect(first).not.toHaveAttribute("open", /.*/);
  });

  test("mobile plan tags expose the full plan name to assistive tech", async ({ page }) => {
    await openHome(page);
    const items = page.locator("#coverage .cv-list details");
    const seen: Record<string, string> = {};
    for (let i = 0; i < (await items.count()); i++) {
      const name = ((await items.nth(i).locator("summary .cv-tn").textContent()) ?? "").trim();
      seen[name] = ((await items.nth(i).locator("summary .cv-sr").textContent()) ?? "").trim();
    }
    expect(seen).toEqual(EXPECTED_PLAN);
  });
});

// ── pricing ─────────────────────────────────────────────────────────────

test("pricing: Executive Impersonation row is Free ✗ and Professional ✓", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.locator("#compare")).toBeVisible();
  const row = page.locator("#compare .compare-table tbody tr", { has: page.locator("td:first-child", { hasText: /^Executive Impersonation$/ }) });
  await expect(row).toHaveCount(1);
  const cells = row.locator("td");
  await expect(cells).toHaveCount(5); // feature, Free, Professional, Business, Enterprise
  await expect(cells.nth(1)).toHaveText("✗");
  await expect(cells.nth(1)).toHaveClass(/ct-no/);
  await expect(cells.nth(2)).toHaveText("✓");
  await expect(cells.nth(2)).toHaveClass(/ct-yes/);
  // Column headers line up with the cells we asserted on.
  const heads = await page.locator("#compare .compare-table thead th").allTextContents();
  expect(heads[1]).toMatch(/Free/i);
  expect(heads[2]).toMatch(/Professional/i);
});
