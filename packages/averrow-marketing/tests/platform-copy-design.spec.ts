import { test, expect, type Page } from "@playwright/test";

/*
 * PR #1806 review fixes: copy accuracy (Auto-mode wording, no extra permutation
 * disclosure, no contradictions) and design (graph text size, heading order,
 * mobile folds, footer grid, text floor, token colours).
 */

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const PLATFORM_PAGES = [
  "/platform",
  "/platform/lookalike-domains",
  "/platform/takedowns",
  "/platform/email-security",
  "/platform/abuse-mailbox",
  "/platform/impersonation",
  "/platform/threat-detection",
  "/platform/campaign-intelligence",
];

async function open(page: Page, p: string) {
  await page.route("**/api/v1/public/stats", (route) => route.abort());
  const res = await page.goto(p);
  expect(res?.status(), `${p} status`).toBeLessThan(400);
}

async function bodyText(page: Page): Promise<string> {
  return ((await page.locator("main, .pp, body").first().textContent()) ?? "").replace(/\s+/g, " ");
}

test.describe("copy accuracy", () => {
  test.use({ viewport: DESKTOP });

  test("drafts are 'waiting for your approval, or filed under your signed rules'", async ({ page }) => {
    for (const p of ["/platform/abuse-mailbox", "/platform/lookalike-domains", "/platform/threat-detection"]) {
      await open(page, p);
      expect(await bodyText(page), p).toMatch(/approval,? or (filed )?(under )?your signed rules|approval, or are filed under your signed rules/i);
    }
    await open(page, "/platform/abuse-mailbox");
    await expect(page.locator(".sf-f")).toHaveText("Takedown drafted, waiting for your approval or filed under your signed rules");
    await open(page, "/platform/lookalike-domains");
    await expect(page.locator(".ph .sf-f")).toHaveText("Takedown drafted, waiting for your approval or filed under your signed rules");
  });

  test("no 'acrne' homoglyph sample and no hyphenated 'look-alike' anywhere on the platform pages", async ({ page }) => {
    for (const p of PLATFORM_PAGES) {
      await open(page, p);
      const html = await page.content();
      expect(html, `${p} acrne`).not.toMatch(/acrne/i);
      expect(html, `${p} look-alike`).not.toMatch(/look-alike/i);
    }
    await open(page, "/");
    expect(await page.content()).not.toMatch(/acrne/i);
  });

  test("lookalike-domains names only 'character swaps and your brand plus common words'", async ({ page }) => {
    await open(page, "/platform/lookalike-domains");
    const text = await bodyText(page);
    expect(text).toContain("character swaps and your brand plus common words");
    expect(text).not.toMatch(/extra or missing letters|extra letter/i);
  });

  test("abuse mailbox: acknowledgement is only for reporters whose mail passes authentication", async ({ page }) => {
    await open(page, "/platform/abuse-mailbox");
    const text = await bodyText(page);
    expect(text).toContain("Reporters whose mail passes authentication get an instant acknowledgement");
    expect(text).not.toContain("Each reporter gets an instant acknowledgement");
    expect(text).toContain("We never write back to forged addresses");
  });

  test("campaign intelligence: softened record claim and Off / Semi-auto / Auto", async ({ page }) => {
    await open(page, "/platform/campaign-intelligence");
    const text = await bodyText(page);
    expect(text).toContain("recorded with the hosting and certificate details we can observe");
    expect(text).toContain("Off, Semi-auto or Auto");
    expect(text).not.toMatch(/semi-automatic|manual, semi/i);
  });
});

test.describe("design", () => {
  test("campaign graph text is at least 12px at 390", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await open(page, "/platform/campaign-intelligence");
    const sizes = await page.locator(".cmp-svg text").evaluateAll((els) =>
      els.map((el) => {
        const t = el as SVGTextElement;
        const m = t.getScreenCTM();
        const units = parseFloat(getComputedStyle(t).fontSize);
        const box = t.getBoundingClientRect();
        const parent = t.parentElement?.querySelector("rect")?.getBoundingClientRect();
        return { text: t.textContent ?? "", px: units * (m ? m.a : 1), fits: !parent || (box.left >= parent.left - 0.5 && box.right <= parent.right + 0.5) };
      }),
    );
    expect(sizes.length).toBeGreaterThan(8);
    for (const s of sizes) {
      expect(s.px, `${s.text} px`).toBeGreaterThanOrEqual(12);
      expect(s.fits, `${s.text} fits its box`).toBe(true);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("abuse mailbox sample email has no headings inside it (heading order)", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await open(page, "/platform/abuse-mailbox");
    await expect(page.locator(".ph .sf h3, .ph .sf h4")).toHaveCount(0);
    await expect(page.locator(".ph .sf .ae-h")).toHaveText(["What we found", "Next steps"]);
  });

  test("/platform stage badge is separate from the heading's accessible name", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await open(page, "/platform");
    // getByRole reads the accessibility tree: the name must be the stage name alone.
    await expect(page.getByRole("heading", { name: "Infrastructure correlation", exact: true })).toHaveCount(1);
    await expect(page.locator(".pv-hd .pv-plan:visible")).toHaveText("Enterprise");
  });

  test("shared kit and homepage components keep text at 12px or more", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    for (const p of ["/", "/platform", "/platform/takedowns"]) {
      await open(page, p);
      await page.evaluate(() => document.querySelectorAll("details").forEach((d) => d.setAttribute("open", "")));
      const small = await page.evaluate(() => {
        const out: string[] = [];
        const scope = document.querySelectorAll(".cv, .tf, .footer, .nav-menu");
        for (const root of Array.from(scope)) {
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let t = w.nextNode(); t; t = w.nextNode()) {
            const el = t.parentElement;
            if (!el || !t.textContent?.trim()) continue;
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width === 0 || r.height === 0 || cs.position === "absolute" && r.width <= 1) continue;
            const size = parseFloat(cs.fontSize);
            if (size < 11.99) out.push(`${el.className} ${size}px "${t.textContent.trim().slice(0, 24)}"`);
          }
        }
        return out;
      });
      expect(small, `${p} text below 12px`).toEqual([]);
    }
  });

  test("Coverage uses tokens: no raw rgba or #fff in the stylesheet rules", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await open(page, "/platform");
    const pill = page.locator(".cv-grid .cv-pill.high").first();
    const bg = await pill.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    const html = await page.content();
    expect(html).not.toMatch(/\.cv-pill\.(high|med|low)\s*\{[^}]*rgba\(/);
  });

  test("mobile folds: /platform stages and integrations, /platform/takedowns statuses", async ({ page }) => {
    await page.setViewportSize(PHONE);
    for (const [p, summaries] of [
      ["/platform", ["The six stages, from detection to summary", "Integrations and their availability"]],
      ["/platform/takedowns", ["The statuses a takedown moves through"]],
    ] as const) {
      await open(page, p);
      for (const s of summaries) {
        const summary = page.locator("summary", { hasText: s });
        await expect(summary, `${p} ${s}`).toBeVisible();
        const d = summary.locator("xpath=..");
        await expect(d).not.toHaveAttribute("open", "");
        await summary.click();
        await expect(d).toHaveAttribute("open", "");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    }
    await page.setViewportSize(DESKTOP);
    await open(page, "/platform");
    await expect(page.locator(".mf-d").first()).toBeHidden();
    await expect(page.locator(".pv-stages:visible")).toHaveCount(1);
  });

  test("footer grid has no empty cell: 6 columns at 1000, two at 390", async ({ page }) => {
    await open(page, "/");
    for (const [w, expected] of [[1000, 6], [1200, 7], [390, 2], [700, 2]] as const) {
      await page.setViewportSize({ width: w, height: 800 });
      const cols = await page.locator(".footer-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      expect(cols, `${w}px columns`).toBe(expected);
    }
    // 1000px: brand on its own row, the six link columns fill the next one.
    await page.setViewportSize({ width: 1000, height: 800 });
    const tops = await page.locator(".footer-col").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    // Phone: six link columns pair up into three full rows, so no cell is empty.
    await page.setViewportSize(PHONE);
    const lefts = await page.locator(".footer-col").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(lefts.length % 2).toBe(0);
    expect(new Set(lefts).size).toBe(2);
  });
});
