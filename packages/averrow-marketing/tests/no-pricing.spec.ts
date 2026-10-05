import { test, expect } from "@playwright/test";

/*
 * Guard: the marketing site intentionally shows no prices (owner decision,
 * commit da1bbe5; /pricing is the "Plans" page). Every built page in the
 * sitemap is scanned for price-shaped text. Only price-SHAPED patterns are
 * matched, so the blog's breach statistics ("$4.88 million", "$2.9B") pass.
 */

const FORBIDDEN: Array<[string, RegExp]> = [
  ["per-month dollar amount", /\$\s?\d[\d,]*(\s?\/\s?mo|\s?per month)/i],
  ["1,499", /1,499/],
  ["3,999", /3,999/],
  ["1,199", /1,199/],
  ["3,199", /3,199/],
  ["billed annually", /billed annually/i],
  ["14-day", /14-day/i],
  ["free trial", /free trial/i],
  ["priceCurrency", /priceCurrency/],
];

test.describe("no public pricing", () => {
  test("every sitemap page is free of price-shaped content", async ({ page, request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.ok(), "sitemap.xml must be served").toBe(true);
    const paths = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
    expect(paths.length, "sitemap should list the built pages").toBeGreaterThan(10);

    const offenders: string[] = [];
    let scanned = 0;
    for (const path of paths) {
      const resp = await page.goto(path);
      // Some sitemap URLs (/scan, /status, /privacy, /terms) are served by the
      // Worker, not built by Astro, so a bare preview 404s on them. Skip those.
      if (!resp || resp.status() === 404) continue;
      expect(resp.ok(), `${path} should load`).toBe(true);
      scanned++;
      // Visible text plus text inside collapsed <details>/hidden nodes (a hidden
      // price is still a published price); scripts/styles excluded.
      const text = await page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script,style,noscript").forEach((n) => n.remove());
        return clone.textContent ?? "";
      });
      // priceCurrency lives in JSON-LD / microdata, not rendered text: check source too.
      const source = await resp!.text();
      for (const [label, re] of FORBIDDEN) {
        if (re.test(text) || (label === "priceCurrency" && (re.test(source) || (await page.locator("[itemprop=priceCurrency]").count()) > 0))) {
          offenders.push(`${path}: ${label}`);
        }
      }
    }
    expect(scanned, "most sitemap pages should be built and scanned").toBeGreaterThan(30);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("/pricing: no currency amounts, paid-plan CTAs go to /demo or /contact", async ({ page }) => {
    await page.goto("/pricing");
    const amounts = await page.locator(".price-amount").allTextContents();
    for (const a of amounts) expect(a, `price-amount "${a}"`).not.toMatch(/[$€£]|\d/);

    for (const plan of ["professional", "business", "enterprise"]) {
      const cta = page.locator(`[data-cta="pricing-${plan}"]`);
      await expect(cta, plan).toHaveCount(1);
      await expect(cta, plan).toHaveAttribute("href", /^\/(demo|contact)\/?$/);
    }
  });
});
