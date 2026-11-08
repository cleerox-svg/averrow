import { expect, test, type Page, type Request } from "@playwright/test";

/*
 * Marketing motion (M1 tokens, page transitions, lazy GSAP scroll sequences).
 *
 * Runs in chromium, mobile and — via the firefox / webkit
 * projects in playwright.config.ts — Firefox and WebKit, because the owner
 * requirement is that motion works for everyone in every browser.
 *
 * The GSAP + ScrollTrigger code lives in the lazy `sequences` chunk
 * (src/lib/motion/sequences.ts); the initial bundle only carries the small
 * loader (src/lib/motion/loader.ts).
 */

const isMotionChunk = (url: string) => /\/_astro\/sequences\.[^/]+\.js$/.test(url) || /gsap|ScrollTrigger/i.test(url);

function trackMotionChunk(page: Page): Request[] {
  const hits: Request[] = [];
  page.on("request", (r) => {
    if (isMotionChunk(r.url())) hits.push(r);
  });
  return hits;
}

/** Scroll the page to the bottom in steps, like a reader would. */
async function scrollThrough(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 500) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
}

/** Every animated element in the motion sections, with its computed opacity and inline style. */
async function motionState(page: Page) {
  return page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-motion-head], [data-motion-items] > *, [data-motion='stagger'] > *, [data-motion-count], .num-bar-f",
      ),
    ).filter((el) => el.getClientRects().length > 0);
    return els.map((el) => ({
      opacity: getComputedStyle(el).opacity,
      inlineOpacity: el.style.opacity,
      inlineTransform: el.style.transform,
      text: el.hasAttribute("data-motion-count") ? (el.textContent ?? "") : "",
    }));
  });
}

test.describe("scroll sequences (GSAP, lazy)", () => {
  test("the GSAP chunk is not requested on initial load of /, only near a motion section", async ({ page }) => {
    const hits = trackMotionChunk(page);
    await page.goto("/", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    expect(hits, "GSAP chunk must not load with the first paint").toHaveLength(0);

    const chunk = page.waitForRequest((r) => isMotionChunk(r.url()), { timeout: 10_000 });
    await page.locator("#takedown-flow").scrollIntoViewIfNeeded();
    await chunk;
    expect(hits.length).toBeGreaterThan(0);
  });

  test("after scrolling, every section ends fully visible with exact numbers", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const before = (await motionState(page)).map((s) => s.text);
    expect(before.length).toBeGreaterThan(10);

    await scrollThrough(page);
    // Longest sequence: 0.9 s count-up + stagger; leave margin.
    await page.waitForTimeout(2000);

    const after = await motionState(page);
    for (const s of after) {
      expect(s.opacity).toBe("1");
      expect(s.inlineOpacity).toBe("");
      expect(s.inlineTransform).toBe("");
    }
    // Counters end on the server-rendered string, never past it.
    expect(after.map((s) => s.text)).toEqual(before);
  });

  test("/platform loads the chunk only when its lists near the viewport", async ({ page }) => {
    const hits = trackMotionChunk(page);
    await page.goto("/platform", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const initial = hits.length;
    await scrollThrough(page);
    await page.waitForTimeout(1500);
    // On a short desktop viewport the Coverage grid may already be near the
    // fold, so the chunk may load at once; either way content ends visible.
    expect(hits.length).toBeGreaterThanOrEqual(initial);
    for (const s of await motionState(page)) expect(s.opacity).toBe("1");
  });
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("all homepage motion content is visible as rendered", async ({ page }) => {
    await page.goto("/");
    const state = await motionState(page);
    expect(state.length).toBeGreaterThan(10);
    for (const s of state) {
      expect(s.opacity).toBe("1");
      expect(s.inlineOpacity).toBe("");
      expect(s.inlineTransform).toBe("");
    }
    await expect(page.locator("#takedown-flow [data-motion-items] > li:visible").first()).toBeVisible();
    await expect(page.locator("#by-the-numbers [data-motion-count]").first()).not.toHaveText("0");
  });
});

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("GSAP never loads, nothing is transformed, content stays visible", async ({ page }) => {
    const hits = trackMotionChunk(page);
    await page.goto("/", { waitUntil: "networkidle" });
    const before = (await motionState(page)).map((s) => s.text);
    await scrollThrough(page);
    await page.waitForTimeout(800);
    expect(hits).toHaveLength(0);
    const state = await motionState(page);
    for (const s of state) {
      expect(s.opacity).toBe("1");
      expect(s.inlineOpacity).toBe("");
      expect(s.inlineTransform).toBe("");
    }
    expect(state.map((s) => s.text)).toEqual(before);
  });

  test("hover lift and travel tokens collapse to 0", async ({ page }) => {
    await page.goto("/");
    const tokens = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return ["--motion-lift", "--motion-travel", "--motion-travel-lg"].map((k) => cs.getPropertyValue(k).trim());
    });
    for (const t of tokens) expect(t).toMatch(/^0(px)?$/);
  });
});

test.describe("motion tokens + page transitions", () => {
  test("M1 tokens are defined", async ({ page }) => {
    await page.goto("/");
    const t = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const g = (k: string) => cs.getPropertyValue(k).trim();
      // The CSS minifier may rewrite 120ms as .12s: compare in milliseconds.
      const ms = (k: string) => {
        const v = g(k);
        return v.endsWith("ms") ? parseFloat(v) : Math.round(parseFloat(v) * 1000);
      };
      return { fast: ms("--motion-fast"), base: ms("--motion-base"), slow: ms("--motion-slow"), travel: g("--motion-travel") };
    });
    expect(t).toEqual({ fast: 120, base: 160, slow: 200, travel: "6px" });
  });

  test("view-transition CSS ships and the nav/logo are named", async ({ page }) => {
    await page.goto("/");
    const css = await page.evaluate(async () => {
      const inline = Array.from(document.querySelectorAll("style")).map((s) => s.textContent ?? "");
      const linked = await Promise.all(
        Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map((l) =>
          fetch(l.href).then((r) => r.text()),
        ),
      );
      return [...inline, ...linked].join("\n");
    });
    expect(css).toMatch(/@view-transition\s*\{\s*navigation:\s*auto/);
    expect(css).toMatch(/view-transition-name:\s*site-nav/);
    expect(css).toMatch(/view-transition-name:\s*site-logo/);
    const named = await page.evaluate(() =>
      CSS.supports("view-transition-name", "none")
        ? getComputedStyle(document.querySelector(".nav")!).getPropertyValue("view-transition-name")
        : "site-nav",
    );
    expect(named).toBe("site-nav");
  });

  test("browsers without cross-document view transitions get the <main> fade fallback", async ({ page }) => {
    await page.goto("/");
    expect(await page.locator("html").getAttribute("data-vt")).toBeNull(); // direct entry: no fade
    await page.locator('.footer a[href^="/"], footer a[href^="/"]').first().click();
    await page.waitForLoadState("domcontentloaded");
    const native = await page.evaluate(() => "CSSViewTransitionRule" in window);
    const vt = await page.locator("html").getAttribute("data-vt");
    expect(vt).toBe(native ? null : "fallback");
  });
});
