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
// popups closed. Network evidence (lib/page-capture-network.ts) is collected
// PASSIVELY from what the browser already does: the `request` event it fires,
// the final main-document response `page.goto` returned (headers + the body
// the browser already downloaded) and `page.cookies()` — no extra request is
// ever issued, and any collection failure is a flag, never a failed capture.
// Accepted gap: WebSocket connections bypass request
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
import {
  BodySizeTracker,
  NET_COOKIE_CLEAR_TIMEOUT_MS,
  NET_FINISH_TIMEOUT_MS,
  NetworkCollector,
  type AbortKind,
  type NetworkEvidence,
} from "./page-capture-network";

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
  net: NetworkCollector;
}): Promise<void> {
  if (req.isInterceptResolutionHandled()) return;
  const url = req.url();
  const scheme = schemeOf(url);
  // Log first (cannot throw: the collector swallows its own failures), then
  // decide. Every abort is recorded so the log says what we cut off.
  try { ctx.net.noteRequest(req.method(), url, req.resourceType()); } catch { /* evidence only */ }
  const abort = async (kind: AbortKind): Promise<void> => {
    try { ctx.net.noteAbort(kind, req.method(), url); } catch { /* evidence only */ }
    await req.abort("blockedbyclient");
  };
  try {
    // Per-page unique-host cap (fail closed): a request to a NEW host past
    // CAPTURE_MAX_HOSTS_PER_PAGE is aborted before any DoH lookup.
    if (scheme === "http:" || scheme === "https:") {
      let host = "";
      try { host = new URL(url).hostname; } catch { host = ""; }
      if (!host || !ctx.budget.admit(host)) {
        await abort("host_cap");
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
        await abort("guard");
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
      await abort("scheme");
      return;
    }
    const type = req.resourceType();
    if (type === "media" || type === "font") {
      await abort("resource");
      return;
    }
    // Sub-resources get the same DNS-resolved check as navigations (the
    // guard's per-run cache keeps repeat hosts to one DoH lookup).
    const verdict = await ctx.guard(url);
    if (!verdict.ok) {
      await abort("guard");
      return;
    }
    await req.continue();
  } catch {
    // Already resolved / page closed — nothing to do.
  }
}

/** Exported for the fake-page wiring test (test/page-capture-browser-net.test.ts). */
export async function captureOnPage(browser: Browser, req: CaptureRequest): Promise<RawCapture> {
  const deadline = Date.now() + req.timeoutMs;
  const remaining = (cap: number): number => Math.max(1_000, Math.min(cap, deadline - Date.now() - 1_000));
  const page = await browser.newPage();
  const chain: string[] = [];
  const recording = { on: true };
  const blocked: { reason: string | null; retryable: boolean } = { reason: null, retryable: false };
  const budget = makePageHostBudget();
  const net = new NetworkCollector();
  // Hard timeout from the caller → close the page NOW so in-flight work
  // dies with it instead of running into the next capture.
  const onAbort = (): void => { page.close().catch(() => undefined); };
  if (req.signal.aborted) onAbort();
  else req.signal.addEventListener("abort", onAbort, { once: true });
  try {
    page.on("dialog", (d) => { d.dismiss().catch(() => undefined); });
    page.on("popup", (p) => { if (p) p.close().catch(() => undefined); });
    // One CDP session: download deny, a clean cookie jar, and the decoded size
    // of every response (so the main document's body is read only when its
    // real size is known to be small). Each step is time-boxed and best-effort;
    // if the jar cannot be cleared this capture records NO cookies (a previous
    // page's cookies must never be attributed to this one).
    const sizes = new BodySizeTracker();
    let cookiesTrusted = false;
    let cdp: Awaited<ReturnType<Page["createCDPSession"]>> | null = null;
    try {
      cdp = await orTimeout(page.createCDPSession(), NET_COOKIE_CLEAR_TIMEOUT_MS);
    } catch { cdp = null; }
    if (cdp) {
      const session = cdp;
      try { await session.send("Page.setDownloadBehavior", { behavior: "deny" }); } catch { /* interception below still never saves a file */ }
      try {
        cookiesTrusted = (await orTimeout(session.send("Network.clearBrowserCookies").then(() => true), NET_COOKIE_CLEAR_TIMEOUT_MS)) === true;
      } catch { cookiesTrusted = false; }
      try {
        session.on("Network.dataReceived", (e) => { sizes.noteData(e.requestId, e.dataLength); });
        session.on("Network.loadingFinished", (e) => { sizes.noteFinished(e.requestId); });
        await orTimeout(session.send("Network.enable"), NET_COOKIE_CLEAR_TIMEOUT_MS);
      } catch { /* no size knowledge → the body is only read on a strict Content-Length check */ }
    }
    await page.setRequestInterception(true);
    page.on("request", (r) => { void decide(r, page, { guard: req.guard, chain, recording, blocked, budget, net }); });

    await page.setViewport({ ...DESKTOP_VIEWPORT });
    await page.setUserAgent(DESKTOP_UA);

    let httpStatus: number | null = null;
    let navError: string | null = null;
    let mainResponse: Awaited<ReturnType<Page["goto"]>> = null;
    try {
      const res = await page.goto(req.targetUrl, { waitUntil: "load", timeout: remaining(12_000) });
      mainResponse = res;
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
    net.freeze();

    // Read the response body + cookies while the screenshot is taken (both
    // are already in the browser); they must be done before the mobile
    // reload below replaces the document. finishNetwork never throws.
    const netBudget = Math.max(500, Math.min(NET_FINISH_TIMEOUT_MS, deadline - Date.now() - 6_000));
    const networkP = finishNetwork(net, mainResponse, page, netBudget, sizes, cookiesTrusted);

    const finalUrl = page.url();
    const desktopPng = new Uint8Array(await page.screenshot({ type: "png", fullPage: false }));
    const extracted = asExtracted(await page.evaluate(EXTRACT_SCRIPT));
    const network = await networkP;

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
      network,
    };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
    await page.close().catch(() => undefined);
  }
}

/** Resolve to null when `p` has not settled within `ms` (a late result is ignored). */
function orTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => undefined);
  return Promise.race([p, new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); })])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Collect the network evidence; any failure becomes a `failed` evidence
 *  (no object is stored for it), never an exception. */
async function finishNetwork(
  net: NetworkCollector,
  response: Awaited<ReturnType<Page["goto"]>>,
  page: Page,
  timeoutMs: number,
  sizes: BodySizeTracker,
  cookiesTrusted: boolean,
): Promise<NetworkEvidence> {
  try {
    let probe = null;
    try {
      // `id` (the CDP requestId) is @internal in the typings but present at runtime.
      const id = response ? (response.request() as unknown as { id?: unknown }).id : undefined;
      probe = typeof id === "string" ? sizes.probe(id) : null;
    } catch { probe = null; }
    return await net.finish(response, page, timeoutMs, { probe, cookiesTrusted });
  } catch {
    return {
      status: "failed", main_response: null, requests: [], requests_total: 0, requests_dropped: 0,
      requests_complete: false, aborted: { guard: 0, host_cap: 0, scheme: 0, resource: 0 },
      cookies: null, cookies_dropped: 0, cookies_clipped: false,
    };
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
