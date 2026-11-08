import { expect, test, type Page, type Request } from "@playwright/test";

/*
 * Marketing motion (M1 tokens, page transitions, lazy GSAP scroll sequences).
 *
 * Runs in chromium, mobile and — via the firefox / webkit
 * projects in playwright.config.ts — Firefox and WebKit, because the owner
 * requirement is that motion actually runs for everyone in every browser.
 *
 * The GSAP core code lives in the lazy `sequences` chunk
 * (src/lib/motion/sequences.ts); the initial bundle only carries the small
 * loader (src/lib/motion/loader.ts).
 */

const isMotionChunk = (url: string) => /\/_astro\/sequences\.[^/]+\.js$/.test(url) || /gsap/i.test(url);

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

const ANIMATED =
  "[data-motion-head], [data-motion-items] > *, [data-motion='stagger'] > *, .num-bar-f, [data-stat]";

/** Every animated element (and every live number), with computed opacity and inline style. */
async function motionState(page: Page) {
  return page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => el.getClientRects().length > 0);
    return els.map((el) => ({
      opacity: getComputedStyle(el).opacity,
      inlineOpacity: el.style.opacity,
      inlineTransform: el.style.transform,
      text: el.hasAttribute("data-stat") ? (el.textContent ?? "") : "",
    }));
  }, ANIMATED);
}

/** Place a section's top `offset` px below the top of the viewport. */
async function placeSection(page: Page, selector: string, offset: number) {
  await page.evaluate(
    ({ selector, offset }) => {
      const el = document.querySelector(selector)!;
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - offset);
    },
    { selector, offset },
  );
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

  test("a section below the fold really animates: hidden start, then fully visible", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const vh = await page.evaluate(() => window.innerHeight);
    // Within the loader's 320 px margin but still below the fold.
    const chunk = page.waitForResponse((r) => isMotionChunk(r.url()), { timeout: 10_000 });
    await placeSection(page, "#takedown-flow", vh + 120);
    await chunk;
    await page.waitForTimeout(300);

    const run = await page.evaluate(async () => {
      const section = document.querySelector<HTMLElement>("#takedown-flow")!;
      const items = Array.from(section.querySelectorAll<HTMLElement>("[data-motion-head], [data-motion-items] > *")).filter(
        (el) => el.getClientRects().length > 0,
      );
      const before = items.map((el) => Number(getComputedStyle(el).opacity));
      window.scrollTo(0, section.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.4);
      let min = 1;
      let moved = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 1200) {
        await new Promise((r) => requestAnimationFrame(r));
        for (const el of items) {
          min = Math.min(min, Number(getComputedStyle(el).opacity));
          if (el.style.transform && el.style.transform !== "none") moved = true;
        }
      }
      const after = items.map((el) => ({ o: getComputedStyle(el).opacity, s: el.getAttribute("style") ?? "" }));
      return { before, min, moved, after };
    });
    expect(Math.max(...run.before), "start state applied while below the fold").toBe(0);
    expect(run.min).toBeLessThan(1);
    expect(run.moved, "items travel in").toBe(true);
    for (const a of run.after) {
      expect(a.o).toBe("1");
      expect(a.s).not.toMatch(/opacity|transform/);
    }
  });

  test("after scrolling, everything ends visible and numbers never change", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const before = (await motionState(page)).map((s) => s.text);
    expect(before.length).toBeGreaterThan(10);
    await scrollThrough(page);
    await page.waitForTimeout(1200);
    const after = await motionState(page);
    for (const s of after) {
      expect(s.opacity).toBe("1");
      expect(s.inlineOpacity).toBe("");
      expect(s.inlineTransform).toBe("");
    }
    expect(after.map((s) => s.text)).toEqual(before);
  });

  test("numbers are readable immediately: no count-up while the section enters", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const rendered = await page.locator("#by-the-numbers [data-stat]").allTextContents();
    await page.locator("#by-the-numbers").scrollIntoViewIfNeeded();
    for (let i = 0; i < 6; i++) {
      expect(await page.locator("#by-the-numbers [data-stat]").allTextContents()).toEqual(rendered);
      await page.waitForTimeout(80);
    }
  });

  test("a live stats change shows the new number at once with a short colour settle", async ({ page }) => {
    await page.route("**/api/v1/public/stats", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { threats_today: 4321, proof: { generated_at: new Date().toISOString() } } }),
      }),
    );
    await page.goto("/", { waitUntil: "networkidle" });
    const today = page.locator('#by-the-numbers [data-stat="today"]');
    await expect(today).toHaveText("4,321");
    await expect(today).toHaveClass(/num-updated/);
    const anim = await today.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: cs.animationDuration };
    });
    expect(anim.name).toBe("num-settle");
    expect(parseFloat(anim.dur) * (anim.dur.endsWith("ms") ? 1 : 1000)).toBeLessThanOrEqual(400);
    // Unchanged values get no settle.
    await expect(page.locator('#by-the-numbers [data-stat="brands"]')).not.toHaveClass(/num-updated/);
  });

  for (const hash of ["#by-the-numbers", "#coverage", "#takedown-flow"]) {
    test(`deep link /${hash} lands on its section and stays there`, async ({ page }) => {
      const hits = trackMotionChunk(page);
      await page.goto(`/${hash}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      const top = await page.evaluate((h) => document.querySelector(h)!.getBoundingClientRect().top, hash);
      expect(Math.abs(top), `${hash} top is ${top}px from the viewport top`).toBeLessThanOrEqual(120);
      // The chunk loaded (sections near the target) and moved nothing.
      expect(hits.length).toBeGreaterThan(0);
      const state = await page.evaluate(
        ({ h, sel }) =>
          Array.from(document.querySelector(h)!.querySelectorAll<HTMLElement>(sel))
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => getComputedStyle(el).opacity),
        { h: hash, sel: ANIMATED },
      );
      expect(state.length).toBeGreaterThan(0);
      expect(state.every((o) => o === "1"), "target section is never hidden").toBe(true);
    });
  }

  test("/platform lists end visible after scrolling", async ({ page }) => {
    await page.goto("/platform", { waitUntil: "networkidle" });
    await scrollThrough(page);
    await page.waitForTimeout(1200);
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
    await expect(page.locator("#by-the-numbers [data-stat]").first()).not.toHaveText("0");
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

  test("view-transition names are unique on every page checked", async ({ page }) => {
    for (const path of ["/", "/platform", "/pricing", "/blog"]) {
      await page.goto(path);
      const names = await page.evaluate(() =>
        Array.from(document.querySelectorAll("*"))
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => getComputedStyle(el).getPropertyValue("view-transition-name"))
          .filter((n) => n && n !== "none"),
      );
      expect(new Set(names).size, `${path}: ${names.join(",")}`).toBe(names.length);
      if (await page.evaluate(() => CSS.supports("view-transition-name", "none"))) {
        expect(names.sort()).toEqual(["root", "site-logo", "site-nav"]);
      }
    }
  });

  test("navigating between pages runs a transition in every engine", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __vt?: Record<string, unknown> };
      w.__vt = { pagereveal: false, has: false, ready: "pending" };
      window.addEventListener("pagereveal", (e) => {
        const vt = (e as Event & { viewTransition?: { ready: Promise<void>; finished: Promise<void> } }).viewTransition;
        w.__vt = { pagereveal: true, has: !!vt, ready: vt ? "pending" : "none" };
        vt?.ready.then(
          () => (w.__vt!.ready = "resolved"),
          (err: unknown) => (w.__vt!.ready = `rejected: ${String((err as Error)?.name ?? err)}`),
        );
      });
    });
    await page.goto("/");
    const native = await page.evaluate(() => "CSSViewTransitionRule" in window);
    // A real in-page link navigation (address-bar loads never transition).
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href = "/platform";
      a.textContent = "go";
      document.body.append(a);
      a.click();
    });
    await page.waitForURL("**/platform");

    if (native) {
      // Chromium / Safari: the cross-document transition starts and is not skipped.
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __vt: { ready: string } }).__vt.ready), { timeout: 5000 })
        .toBe("resolved");
      const vt = await page.evaluate(() => (window as unknown as { __vt: { has: boolean } }).__vt);
      expect(vt.has).toBe(true);
    } else {
      // Firefox: the fallback fade runs on <main>.
      expect(await page.locator("html").getAttribute("data-vt")).toBe("fallback");
      const anim = await page.evaluate(() => getComputedStyle(document.querySelector("main")!).animationName);
      expect(anim).toBe("page-in");
    }
  });

  test("direct entry gets no fallback fade", async ({ page }) => {
    await page.goto("/");
    expect(await page.locator("html").getAttribute("data-vt")).toBeNull();
  });
});
