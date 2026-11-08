import { test, expect, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";

/*
 * Homepage hero, G5 H4A (components/hero/OperationHero.astro +
 * scripts/hero.ts). Runs in chromium, firefox and webkit (playwright.config
 * projects): the owner asked for the animation to work in every engine.
 *
 * Strings asserted here are the approved ones in
 * docs/brand/HERO_COPY_2026-11.md (register §3.13).
 */

const DISCLOSURE = "Fictional example · operation mapping is on the Enterprise plan";
const STEPS = ["Domain found", "Infrastructure linked", "Operation mapped", "Takedowns filed"];
const LONG_CAPTIONS = [
  "acme-payroll-login.example turns up in phishing intelligence and is matched to Acme.",
  "Shared hosting and one shared TLS certificate tie it to 13 more phishing domains.",
  "On Enterprise, the cluster becomes one operation. A known actor is shown only where public reporting names one; this one is fictional. Related findings, shown dashed, are reviewed alongside.",
  "Takedowns are filed for each domain under your authorization, at the automation level you choose. Status updates as registrars and hosts act.",
];
const LIVE_CAPTION_2 = "Shared hosting and one TLS certificate tie it to 13 more phishing domains.";
const HERO_CHUNK = /\/_astro\/hero\.[\w-]+\.js$/;

const stepButton = (p: Page, n: number) => p.locator(`#hero button[data-step="${n}"]`);
const current = (p: Page) => p.locator('#hero button[data-step][aria-current="step"]');

async function expectStaticFinished(p: Page) {
  const hero = p.locator("#hero");
  await expect(hero.locator("svg.poster:visible")).toHaveCount(1);
  await expect(hero.locator("svg.poster:visible")).toContainText("OP-2291");
  await expect(hero.locator("svg.poster:visible")).toContainText("Known actor: FX-114 (fictional)");
  const list = hero.locator("ol.sl");
  await expect(list).toBeVisible();
  await expect(list.locator("li")).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(list.locator("li").nth(i)).toContainText(STEPS[i]);
    await expect(list.locator("li").nth(i)).toContainText(LONG_CAPTIONS[i]);
  }
  await expect(hero.getByText(DISCLOSURE)).toBeVisible();
  await expect(hero.locator("[data-hero-card]")).toContainText(/8\s*taken down\s*4\s*submitted\s*2\s*to approve/);
  await expect(hero.locator("[data-hero-rail]")).toBeHidden();
  await expect(hero).not.toHaveClass(/\blive\b/);
}

test.describe("hero: static states", () => {
  test("no JS: finished poster, four steps with captions, disclosure", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.goto("/");
    await expectStaticFinished(p);
    // The scan form still posts without JS.
    await expect(p.locator("form#scanForm")).toHaveAttribute("action", /\/assess$/);
    await ctx.close();
  });

  test("reduced motion: finished state, no hero script, no animation frames", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    await ctx.addInitScript(() => {
      const w = window as unknown as { __frames: number };
      w.__frames = 0;
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => {
        w.__frames++;
        return raf(cb);
      };
    });
    const p = await ctx.newPage();
    const chunks: string[] = [];
    p.on("request", (r) => HERO_CHUNK.test(new URL(r.url()).pathname) && chunks.push(r.url()));
    await p.goto("/");
    await p.waitForLoadState("load");
    await p.waitForTimeout(2500);
    await expectStaticFinished(p);
    expect(chunks, "hero script must not load under reduced motion").toEqual([]);
    expect(await p.evaluate(() => (window as unknown as { __frames: number }).__frames)).toBe(0);
    await ctx.close();
  });
});

test.describe("hero: animated", () => {
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#hero")).toHaveClass(/\blive\b/, { timeout: 10_000 });
  });

  test("auto-plays from step 1 with the disclosure always visible", async ({ page: p }) => {
    await expect(p.locator("#hero").getByText(DISCLOSURE)).toBeVisible();
    await expect(p.locator("#hero ol.sl")).toBeHidden();
    await expect(p.locator("#hero [data-hero-rail]")).toBeVisible();
    // Step 1 lasts ~2.9 s, then step 2 takes over.
    await expect(current(p)).toHaveAttribute("data-step", /^[12]$/);
    await expect(current(p)).toHaveAttribute("data-step", "2", { timeout: 6000 });
    await expect(p.locator("#hero [data-live-cap]")).toHaveText(LIVE_CAPTION_2);
    // Silent while it plays on its own; announces once the visitor takes control.
    await expect(p.locator("#hero [data-live-cap]")).toHaveAttribute("aria-live", "off");
    await stepButton(p, 3).click();
    await expect(p.locator("#hero [data-live-cap]")).toHaveAttribute("aria-live", "polite");
  });

  test("pause stops progression; play resumes", async ({ page: p }) => {
    const pp = p.locator("#hero [data-pp]");
    await expect(pp).toHaveAccessibleName("Pause step animation");
    await pp.click();
    await expect(pp).toHaveAccessibleName("Play step animation");
    const step = await current(p).getAttribute("data-step");
    const fills = () => p.locator("#hero .sb .fl").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform));
    const before = await fills();
    await p.waitForTimeout(3500);
    await expect(current(p)).toHaveAttribute("data-step", step as string);
    expect(await fills()).toEqual(before);
    await pp.click();
    await expect(pp).toHaveAccessibleName("Pause step animation");
    await expect(current(p)).not.toHaveAttribute("data-step", step as string, { timeout: 6000 });
  });

  test("clicking a step jumps to it and holds there", async ({ page: p }) => {
    await stepButton(p, 2).click();
    await expect(current(p)).toHaveAttribute("data-step", "2");
    await expect(p.locator("#hero [data-live-cap]")).toHaveText(LIVE_CAPTION_2);
    await expect(p.locator("#hero [data-pp]")).toHaveAccessibleName("Play step animation");
    await p.waitForTimeout(3500);
    await expect(current(p)).toHaveAttribute("data-step", "2");
    await stepButton(p, 4).click();
    await expect(current(p)).toHaveAttribute("data-step", "4");
    // The finished card shows the approved counts.
    await expect(p.locator("#hero [data-hero-card]")).toContainText(/8\s*taken down\s*4\s*submitted\s*2\s*to approve/, { timeout: 3000 });
  });

  test("keyboard: CTAs, then the four steps, then pause", async ({ page: p }) => {
    for (let i = 1; i <= 4; i++) await expect(stepButton(p, i)).toHaveAccessibleName(`Step ${i} of 4: ${STEPS[i - 1]}`);
    await p.locator("#hero").getByRole("link", { name: "Book a demo" }).focus();
    const order: string[] = [];
    for (let i = 0; i < 5; i++) {
      await p.keyboard.press("Tab");
      order.push(await p.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
    }
    expect(order).toEqual([...STEPS.map((s, i) => `Step ${i + 1} of 4: ${s}`), "Pause step animation"]);
    // Enter on a focused step jumps to it.
    await stepButton(p, 3).focus();
    await p.keyboard.press("Enter");
    await expect(current(p)).toHaveAttribute("data-step", "3");
  });
});

test("hero script: one chunk, at most 6 KB gzipped, requested after load", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "no-preference" });
  const p = await ctx.newPage();
  const bodies: Buffer[] = [];
  p.on("response", async (r) => {
    if (HERO_CHUNK.test(new URL(r.url()).pathname)) bodies.push(await r.body());
  });
  await p.goto("/");
  await expect(p.locator("#hero")).toHaveClass(/\blive\b/, { timeout: 10_000 });
  await expect.poll(() => bodies.length).toBe(1);
  const gz = gzipSync(bodies[0], { level: 9 }).length;
  expect(gz, `hero chunk is ${gz} B gzipped`).toBeLessThanOrEqual(6 * 1024);
  const t = await p.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    const res = performance.getEntriesByType("resource").find((e) => /\/_astro\/hero\./.test(e.name));
    return { load: nav.loadEventStart, start: res?.startTime ?? -1 };
  });
  expect(t.start, "hero chunk must be requested after the load event").toBeGreaterThanOrEqual(t.load);
  await ctx.close();
});

// axe: @axe-core/playwright is not a dependency of this package, so no axe
// pass here (noted in the PR). The a11y contract is asserted directly above:
// accessible names, aria-current, aria-live, focus order, figcaption.
test("figure has a screen-reader caption and the canvas is hidden from AT", async ({ page: p }) => {
  await p.goto("/");
  const fig = p.locator("#hero figure");
  await expect(fig).toHaveAccessibleName(/Fictional example of Enterprise operation mapping, in four steps/);
  await expect(fig.locator("canvas")).toHaveAttribute("aria-hidden", "true");
  await expect(fig.locator("svg.poster").first()).toHaveAttribute("aria-hidden", "true");
});

// ── Canvas, frames, theme, rest and fade-pause (review M1/M4) ─────────────

type W = Window & { __frames: number };

/** Counts requestAnimationFrame calls; optionally fast-forwards the story. */
async function liveHero(browser: import("@playwright/test").Browser, speed?: number) {
  const ctx = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((sp) => {
    const w = window as unknown as W & { __heroSpeed?: number };
    w.__frames = 0;
    if (sp) w.__heroSpeed = sp;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      w.__frames++;
      return raf(cb);
    };
  }, speed ?? 0);
  const p = await ctx.newPage();
  await p.goto("/");
  await expect(p.locator("#hero")).toHaveClass(/\blive\b/, { timeout: 10_000 });
  return { ctx, p };
}

const frames = (p: Page) => p.evaluate(() => (window as unknown as W).__frames);

/** Painted pixels on the hero canvas, and their average colour. */
const canvasPixels = (p: Page) =>
  p.evaluate(() => {
    const c = document.querySelector("#hero canvas") as HTMLCanvasElement;
    const d = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    const sum = [0, 0, 0];
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 20) {
        n++;
        sum[0] += d[i - 3];
        sum[1] += d[i - 2];
        sum[2] += d[i - 1];
      }
    }
    return { painted: n, avg: n ? sum.map((v) => Math.round(v / n)).join(",") : "" };
  });

test("the canvas draws mid-play and at rest", async ({ browser }) => {
  const { ctx, p } = await liveHero(browser);
  await p.waitForTimeout(3500);
  expect((await canvasPixels(p)).painted, "mid-play").toBeGreaterThan(800);
  await stepButton(p, 4).click();
  await p.waitForTimeout(800);
  expect((await canvasPixels(p)).painted, "at rest").toBeGreaterThan(5000);
  await ctx.close();
});

test("theme toggle re-reads the colour tokens", async ({ browser }) => {
  const { ctx, p } = await liveHero(browser);
  await stepButton(p, 4).click();
  await p.waitForTimeout(800);
  const dark = await canvasPixels(p);
  await p.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect.poll(async () => (await canvasPixels(p)).avg).not.toBe(dark.avg);
  await ctx.close();
});

test("off-screen: no animation frames; back on screen: it resumes", async ({ browser }) => {
  const { ctx, p } = await liveHero(browser);
  // `html { scroll-behavior: smooth }` would animate a plain scrollTo, so on a
  // slow runner the hero could still be on screen when counting starts.
  // Jump instantly and wait until the hero has really left the viewport.
  await p.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await expect
    .poll(() => p.evaluate(() => document.querySelector("#hero")!.getBoundingClientRect().bottom))
    .toBeLessThan(0);
  await p.waitForTimeout(500);
  let f0 = await frames(p);
  await p.waitForTimeout(1500);
  expect((await frames(p)) - f0, "frames while off-screen").toBe(0);
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await p.waitForTimeout(500);
  f0 = await frames(p);
  await p.waitForTimeout(1000);
  expect((await frames(p)) - f0, "frames once visible again").toBeGreaterThan(5);
  await ctx.close();
});

test("after three plays it rests on the finished operation", async ({ browser }) => {
  test.setTimeout(60_000);
  // 20x speed: three ~16 s plays take ~2.5 s.
  const { ctx, p } = await liveHero(browser, 20);
  await expect(p.locator("#hero [data-pp]")).toHaveAttribute("data-state", "paused", { timeout: 20_000 });
  await expect(p.locator("#hero [data-pp]")).toHaveAccessibleName("Play step animation");
  await expect(current(p)).toHaveAttribute("data-step", "4");
  await expect(p.locator("#hero [data-hero-card]")).toContainText(/8\s*taken down\s*4\s*submitted\s*2\s*to approve/);
  await expect(p.locator("#hero [data-hero-card]")).toHaveCSS("opacity", "1");
  expect((await canvasPixels(p)).painted).toBeGreaterThan(5000);
  const f0 = await frames(p);
  await p.waitForTimeout(1200);
  expect((await frames(p)) - f0, "frames at rest").toBe(0);
  await ctx.close();
});

test("pausing during the fade-out settles on the finished operation", async ({ browser }) => {
  test.setTimeout(60_000);
  const { ctx, p } = await liveHero(browser);
  // Wait for the end-of-play fade: the card was fully shown, now fading.
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __seen?: boolean };
      const o = Number((document.querySelector("#hero [data-hero-card]") as HTMLElement).style.opacity);
      if (o > 0.99) w.__seen = true;
      return !!w.__seen && o < 0.6;
    },
    null,
    { polling: 16, timeout: 30_000 },
  );
  await p.locator("#hero [data-pp]").click();
  await p.waitForTimeout(600);
  await expect(current(p)).toHaveAttribute("data-step", "4");
  await expect(p.locator("#hero [data-hero-card]")).toHaveCSS("opacity", "1");
  expect((await canvasPixels(p)).painted, "a full frame, not a ghost").toBeGreaterThan(5000);
  await ctx.close();
});
