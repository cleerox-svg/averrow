// Averrow — Cloudflare Browser Rendering driver for lib/page-capture.ts
// (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md §4).
//
// The only file that imports `@cloudflare/puppeteer`. It implements the
// `CaptureDriver` interface so the capture pipeline stays unit-testable with
// a fake driver (no browser is ever launched in tests).
//
// Navigation ONLY: this driver never clicks, types, focuses inputs, submits
// forms or follows `javascript:` / `data:` navigations. EVERY intercepted
// http(s) request — navigations (initial, redirects, frames) and
// sub-resources alike — passes the SSRF guard (scheme + static block-list +
// DoH-resolved IP check, per-run cache) before it may continue; non-http(s)
// sub-resources (other than inline data:/blob:), media and fonts are
// aborted; downloads are denied at the CDP level; dialogs are dismissed and
// popups closed. Accepted gap: WebSocket connections bypass request
// interception and are not guarded (the browser runs on Cloudflare's
// network, not ours). On the hard per-page timeout the caller aborts
// `req.signal` and the page is closed immediately.

import puppeteer from "@cloudflare/puppeteer";
import type { Browser, HTTPRequest, Page } from "@cloudflare/puppeteer";
import {
  CAPTURE_HTML_MAX_BYTES,
  makePageHostBudget,
  type PageHostBudget,
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
// needs no DOM lib; the result is validated below as untrusted data. The
// HTML is serialized and CAPPED in the page (never page.content(), which
// would ship an arbitrarily large DOM over CDP first); capHtml then caps the
// UTF-8 bytes exactly.
const EXTRACT_SCRIPT = `(() => {
  const forms = Array.from(document.forms).slice(0, ${MAX_FORMS}).map((f) => f.getAttribute('action') || '');
  const text = document.body ? String(document.body.innerText || '') : '';
  const root = document.documentElement;
  const html = root ? String(root.outerHTML || '') : '';
  return {
    title: String(document.title || ''),
    forms,
    text: text.slice(0, ${MAX_BODY_TEXT}),
    html: html.slice(0, ${CAPTURE_HTML_MAX_BYTES}),
  };
})()`;

interface Extracted {
  title: string;
  forms: string[];
  text: string;
  html: string;
}

function asExtracted(v: unknown): Extracted {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const forms = Array.isArray(o["forms"]) ? o["forms"].filter((x): x is string => typeof x === "string") : [];
  return {
    title: typeof o["title"] === "string" ? o["title"] : "",
    forms: forms.slice(0, MAX_FORMS),
    text: typeof o["text"] === "string" ? o["text"].slice(0, MAX_BODY_TEXT) : "",
    html: typeof o["html"] === "string" ? o["html"].slice(0, CAPTURE_HTML_MAX_BYTES) : "",
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function schemeOf(url: string): string {
  const i = url.indexOf(":");
  return i > 0 ? url.slice(0, i + 1).toLowerCase() : "";
}

async function decide(req: HTTPRequest, page: Page, ctx: {
  guard: CaptureRequest["guard"];
  chain: string[];
  recording: { on: boolean };
  blocked: { reason: string | null; retryable: boolean };
  budget: PageHostBudget;
}): Promise<void> {
  if (req.isInterceptResolutionHandled()) return;
  const url = req.url();
  const scheme = schemeOf(url);
  try {
    // Per-page unique-host cap (fail closed): a request to a NEW host past
    // CAPTURE_MAX_HOSTS_PER_PAGE is aborted before any DoH lookup.
    if (scheme === "http:" || scheme === "https:") {
      let host = "";
      try { host = new URL(url).hostname; } catch { host = ""; }
      if (!host || !ctx.budget.admit(host)) {
        await req.abort("blockedbyclient");
        return;
      }
    }
    if (req.isNavigationRequest()) {
      const mainFrame = req.frame() === page.mainFrame();
      if (mainFrame && ctx.recording.on && ctx.chain[ctx.chain.length - 1] !== url) ctx.chain.push(url);
      const verdict = await ctx.guard(url);
      if (!verdict.ok) {
        if (mainFrame && ctx.blocked.reason === null) {
          ctx.blocked.reason = `${url.slice(0, 200)} (${verdict.reason})`;
          ctx.blocked.retryable = verdict.retryable;
        }
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
    // Sub-resources get the same DNS-resolved check as navigations (the
    // guard's per-run cache keeps repeat hosts to one DoH lookup).
    const verdict = await ctx.guard(url);
    if (!verdict.ok) {
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
  const blocked: { reason: string | null; retryable: boolean } = { reason: null, retryable: false };
  const budget = makePageHostBudget();
  // Hard timeout from the caller → close the page NOW so in-flight work
  // dies with it instead of running into the next capture.
  const onAbort = (): void => { page.close().catch(() => undefined); };
  if (req.signal.aborted) onAbort();
  else req.signal.addEventListener("abort", onAbort, { once: true });
  try {
    page.on("dialog", (d) => { d.dismiss().catch(() => undefined); });
    page.on("popup", (p) => { if (p) p.close().catch(() => undefined); });
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Page.setDownloadBehavior", { behavior: "deny" });
    } catch { /* best-effort: interception below still never saves a file */ }
    await page.setRequestInterception(true);
    page.on("request", (r) => { void decide(r, page, { guard: req.guard, chain, recording, blocked, budget }); });

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
        return emptyCapture(chain, blocked.reason, blocked.retryable);
      }
      throw new Error(`navigation failed: ${navError ?? "page did not load"}`);
    }
    await sleep(Math.min(SETTLE_MS, Math.max(0, deadline - Date.now() - 8_000)));
    recording.on = false;

    const finalUrl = page.url();
    const desktopPng = new Uint8Array(await page.screenshot({ type: "png", fullPage: false }));
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
      html: extracted.html,
      desktopPng,
      mobilePng,
      blockedNavigation: blocked.reason,
      blockedRetryable: blocked.retryable,
      hostCapHit: budget.capped,
    };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
    await page.close().catch(() => undefined);
  }
}

function emptyCapture(chain: string[], blockedReason: string, retryable: boolean): RawCapture {
  return {
    finalUrl: null, httpStatus: null, redirectChain: chain, title: "", formActions: [],
    bodyText: "", html: "", desktopPng: null, mobilePng: null, blockedNavigation: blockedReason,
    blockedRetryable: retryable,
  };
}

/** One browser session per cron run; pages are captured sequentially. */
export function puppeteerCaptureDriver(binding: Fetcher): CaptureDriver {
  return {
    async open(): Promise<CaptureSession> {
      const browser = await puppeteer.launch(binding, { keep_alive: KEEP_ALIVE_MS });
      return {
        capture: (req) => captureOnPage(browser, req),
        // Called from runPageCapture's finally on every path.
        close: async () => {
          await browser.close();
        },
      };
    },
  };
}
