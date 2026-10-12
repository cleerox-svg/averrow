// Averrow — Cloudflare Browser Rendering driver for lib/page-capture.ts
// (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md §4).
//
// The only file that imports `@cloudflare/puppeteer`. It implements the
// `CaptureDriver` interface so the capture pipeline stays unit-testable with
// a fake driver (no browser is ever launched in tests).
//
// Navigation ONLY: this driver never clicks, types, focuses inputs, submits
// forms or follows `javascript:` / `data:` navigations. Every navigation
// request (initial, redirects, frames) passes the SSRF guard before it may
// continue; sub-resources with non-http(s) schemes (other than inline
// data:/blob:), statically-blocked hosts, media and fonts are aborted;
// downloads are denied at the CDP level; dialogs are dismissed and popups
// closed.

import puppeteer from "@cloudflare/puppeteer";
import type { Browser, HTTPRequest, Page } from "@cloudflare/puppeteer";
import { pageFetchHostStaticBlockReason } from "./url-guard";
import {
  DESKTOP_UA,
  DESKTOP_VIEWPORT,
  MOBILE_UA,
  MOBILE_VIEWPORT,
  type CaptureDriver,
  type CaptureRequest,
  type CaptureSession,
  type RawCapture,
} from "./page-capture";

/** Session keep-alive while a batch is processed (ms). */
const KEEP_ALIVE_MS = 60_000;
/** Post-load settle so client-rendered kits paint. */
const SETTLE_MS = 1_500;
const MAX_BODY_TEXT = 8_192;
const MAX_FORMS = 50;

// Runs inside the page. A string (not a function) so the Worker's TS config
// needs no DOM lib; the result is validated below as untrusted data.
const EXTRACT_SCRIPT = `(() => {
  const forms = Array.from(document.forms).slice(0, ${MAX_FORMS}).map((f) => f.getAttribute('action') || '');
  const text = document.body ? String(document.body.innerText || '') : '';
  return { title: String(document.title || ''), forms, text: text.slice(0, ${MAX_BODY_TEXT}) };
})()`;

interface Extracted {
  title: string;
  forms: string[];
  text: string;
}

function asExtracted(v: unknown): Extracted {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const forms = Array.isArray(o["forms"]) ? o["forms"].filter((x): x is string => typeof x === "string") : [];
  return {
    title: typeof o["title"] === "string" ? o["title"] : "",
    forms: forms.slice(0, MAX_FORMS),
    text: typeof o["text"] === "string" ? o["text"].slice(0, MAX_BODY_TEXT) : "",
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function schemeOf(url: string): string {
  const i = url.indexOf(":");
  return i > 0 ? url.slice(0, i + 1).toLowerCase() : "";
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function decide(req: HTTPRequest, page: Page, ctx: {
  guard: CaptureRequest["guard"];
  chain: string[];
  recording: { on: boolean };
  blocked: { reason: string | null };
}): Promise<void> {
  if (req.isInterceptResolutionHandled()) return;
  const url = req.url();
  const scheme = schemeOf(url);
  try {
    if (req.isNavigationRequest()) {
      const mainFrame = req.frame() === page.mainFrame();
      if (mainFrame && ctx.recording.on && ctx.chain[ctx.chain.length - 1] !== url) ctx.chain.push(url);
      const verdict = await ctx.guard(url);
      if (!verdict.ok) {
        if (mainFrame && ctx.blocked.reason === null) ctx.blocked.reason = `${url.slice(0, 200)} (${verdict.reason})`;
        await req.abort("blockedbyclient");
        return;
      }
      await req.continue();
      return;
    }
    if (scheme === "data:" || scheme === "blob:") {
      await req.continue();
      return;
    }
    if (scheme !== "http:" && scheme !== "https:") {
      await req.abort("blockedbyclient");
      return;
    }
    const type = req.resourceType();
    if (type === "media" || type === "font") {
      await req.abort("blockedbyclient");
      return;
    }
    const host = hostOf(url);
    if (!host || pageFetchHostStaticBlockReason(host)) {
      await req.abort("blockedbyclient");
      return;
    }
    await req.continue();
  } catch {
    // Already resolved / page closed — nothing to do.
  }
}

async function captureOnPage(browser: Browser, req: CaptureRequest): Promise<RawCapture> {
  const deadline = Date.now() + req.timeoutMs;
  const remaining = (cap: number): number => Math.max(1_000, Math.min(cap, deadline - Date.now() - 1_000));
  const page = await browser.newPage();
  const chain: string[] = [];
  const recording = { on: true };
  const blocked: { reason: string | null } = { reason: null };
  try {
    page.on("dialog", (d) => { d.dismiss().catch(() => undefined); });
    page.on("popup", (p) => { if (p) p.close().catch(() => undefined); });
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });
    } catch { /* best-effort: interception below still never saves a file */ }
    await page.setRequestInterception(true);
    page.on("request", (r) => { void decide(r, page, { guard: req.guard, chain, recording, blocked }); });

    await page.setViewport({ ...DESKTOP_VIEWPORT });
    await page.setUserAgent(DESKTOP_UA);

    let httpStatus: number | null = null;
    let navError: string | null = null;
    try {
      const res = await page.goto(req.targetUrl, { waitUntil: "load", timeout: remaining(12_000) });
      httpStatus = res ? res.status() : null;
    } catch (err) {
      // A slow page that committed still gets screenshotted; a page that
      // never committed (DNS, refused, guard abort) is an error.
      navError = err instanceof Error ? err.message : String(err);
    }
    const committed = page.url() !== "about:blank" && page.url() !== "";
    if (!committed) {
      if (blocked.reason) {
        return emptyCapture(chain, blocked.reason);
      }
      throw new Error(`navigation failed: ${navError ?? "page did not load"}`);
    }
    await sleep(Math.min(SETTLE_MS, Math.max(0, deadline - Date.now() - 8_000)));
    recording.on = false;

    const finalUrl = page.url();
    const desktopPng = new Uint8Array(await page.screenshot({ type: "png", fullPage: false }));
    const html = await page.content();
    const extracted = asExtracted(await page.evaluate(EXTRACT_SCRIPT));

    let mobilePng: Uint8Array | null = null;
    if (deadline - Date.now() > 3_000) {
      try {
        await page.setViewport({ ...MOBILE_VIEWPORT, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
        await page.setUserAgent(MOBILE_UA);
        // The mobile UA only reaches the server on a fresh request.
        await page.reload({ waitUntil: "load", timeout: remaining(6_000) }).catch(() => null);
        mobilePng = new Uint8Array(await page.screenshot({ type: "png", fullPage: false }));
      } catch {
        mobilePng = null;
      }
    }

    return {
      finalUrl,
      httpStatus,
      redirectChain: chain,
      title: extracted.title,
      formActions: extracted.forms,
      bodyText: extracted.text,
      html,
      desktopPng,
      mobilePng,
      blockedNavigation: blocked.reason,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function emptyCapture(chain: string[], blockedReason: string): RawCapture {
  return {
    finalUrl: null, httpStatus: null, redirectChain: chain, title: "", formActions: [],
    bodyText: "", html: "", desktopPng: null, mobilePng: null, blockedNavigation: blockedReason,
  };
}

/** One browser session per cron run; pages are captured sequentially. */
export function puppeteerCaptureDriver(binding: Fetcher): CaptureDriver {
  return {
    async open(): Promise<CaptureSession> {
      const browser = await puppeteer.launch(binding, { keep_alive: KEEP_ALIVE_MS });
      return {
        capture: (req) => captureOnPage(browser, req),
        close: async () => {
          await browser.close();
        },
      };
    },
  };
}
