import { test, expect, type Page, type Response } from "@playwright/test";
import { gzipSync } from "node:zlib";

/*
 * Performance budgets for the marketing homepage (facelift Phase 5).
 *
 * Measured in Chromium against the local `astro preview` build, with no
 * CPU or network throttling. The numbers are a regression tripwire, not a
 * field-data claim: they catch a change that adds a heavy script, a layout
 * jump or a new font family, not a slow network.
 *
 * Baseline on `/` (2026-11-08, master @ 15c1bf85, local `astro preview`,
 * Playwright 1.59.1 Chromium headless, 3 runs):
 *   LCP          408-708 ms               -> budget 2.0 s   (the Phase 5 target)
 *   CLS          0.0085-0.0089            -> budget 0.05    (the Phase 5 target)
 *   JS (gzip)    50,704 B in 5 files      -> budget 61,440 B (60 KB; +21%)
 *                (React client runtime 43.8 KB of it)
 *   Font bytes   87,472 B in 5 woff2      -> budget 105,000 B (+20%; the
 *                (Plus Jakarta Sans + 4x IBM Plex Mono, fonts.gstatic.com)
 *                Phase 5 ceiling is 150 KB)
 *
 * JS and font budgets sit ~20% above the measured baseline. When a change
 * moves the baseline on purpose, re-measure (the test prints the numbers)
 * and update both the comment and the constant in the same PR.
 *
 * JS size is the gzip size of every script body the page loaded, computed
 * here with zlib, so the budget does not depend on whether the preview
 * server compresses. Font size is the bytes of every font response
 * (woff2 is already compressed). Both count same-origin and third-party
 * requests.
 */

const LCP_BUDGET_MS = 2000;
const CLS_BUDGET = 0.05;
const JS_BUDGET_BYTES = 60 * 1024;
const FONT_BUDGET_BYTES = 105_000;

type Collected = { jsGzipBytes: number; fontBytes: number; js: string[]; fonts: string[] };

function collect(page: Page): { done: () => Promise<Collected> } {
  const pending: Promise<void>[] = [];
  const out: Collected = { jsGzipBytes: 0, fontBytes: 0, js: [], fonts: [] };
  page.on("response", (res: Response) => {
    const type = res.request().resourceType();
    if (type !== "script" && type !== "font") return;
    if (res.status() < 200 || res.status() >= 300) return;
    pending.push(
      res
        .body()
        .then((body) => {
          if (type === "script") {
            const gz = gzipSync(body).length;
            out.jsGzipBytes += gz;
            out.js.push(`${res.url()} (${gz} B gz)`);
          } else {
            out.fontBytes += body.length;
            out.fonts.push(`${res.url()} (${body.length} B)`);
          }
        })
        .catch(() => {
          // A body that can't be read (redirect, aborted) is not a loaded resource.
        }),
    );
  });
  return {
    done: async () => {
      await Promise.all(pending);
      return out;
    },
  };
}

test.describe("homepage performance budget", () => {

  test("/ stays within LCP, CLS, JS and font budgets", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "budgets are measured on the desktop chromium project (LCP/CLS observers are Chromium-only)");

    // Observers must be registered before any paint, so install them as an
    // init script. `buffered: true` also replays entries emitted earlier.
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      w.__lcp = 0;
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__lcp = e.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      // CLS as web-vitals defines it: the largest session window of shifts
      // (gap < 1 s, window < 5 s), ignoring shifts right after user input.
      let windowValue = 0;
      let windowStart = 0;
      let lastTs = 0;
      new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const e = raw as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (e.hadRecentInput) continue;
          if (windowValue > 0 && (e.startTime - lastTs >= 1000 || e.startTime - windowStart >= 5000)) {
            windowValue = 0;
          }
          if (windowValue === 0) windowStart = e.startTime;
          windowValue += e.value;
          lastTs = e.startTime;
          w.__cls = Math.max(w.__cls, windowValue);
        }
      }).observe({ type: "layout-shift", buffered: true });
    });

    const resources = collect(page);
    await page.goto("/", { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    // Let late shifts (font swap, hydration) land before reading.
    await page.waitForTimeout(500);

    const { lcp, cls } = await page.evaluate(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      return { lcp: w.__lcp, cls: w.__cls };
    });
    const r = await resources.done();

    const summary = [
      `LCP ${Math.round(lcp)} ms (budget ${LCP_BUDGET_MS})`,
      `CLS ${cls.toFixed(4)} (budget ${CLS_BUDGET})`,
      `JS ${r.jsGzipBytes} B gz in ${r.js.length} files (budget ${JS_BUDGET_BYTES})`,
      `fonts ${r.fontBytes} B in ${r.fonts.length} files (budget ${FONT_BUDGET_BYTES})`,
      ...r.js.map((s) => `  js   ${s}`),
      ...r.fonts.map((s) => `  font ${s}`),
    ].join("\n");
    console.log(`[perf-budget] /\n${summary}`);
    testInfo.annotations.push({ type: "perf", description: summary });

    expect(lcp, "LCP was never reported").toBeGreaterThan(0);
    expect(lcp, `LCP over budget\n${summary}`).toBeLessThanOrEqual(LCP_BUDGET_MS);
    expect(cls, `CLS over budget\n${summary}`).toBeLessThanOrEqual(CLS_BUDGET);
    expect(r.jsGzipBytes, `JS over budget\n${summary}`).toBeLessThanOrEqual(JS_BUDGET_BYTES);
    expect(r.fontBytes, `font bytes over budget\n${summary}`).toBeLessThanOrEqual(FONT_BUDGET_BYTES);
  });
});
