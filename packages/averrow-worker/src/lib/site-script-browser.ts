// Averrow — Cloudflare Browser Rendering driver for Site Script Watch
// (lib/site-script-scan.ts): renders a brand's OWN home page and records the
// scripts it runs and the hosts it contacts.
//
// Reuses the page-capture browser plumbing (lib/page-capture-browser.ts):
// the same Browser Rendering launch, the same request interceptor (per-page
// host cap + the DoH-resolved SSRF guard on EVERY http(s) navigation and
// sub-resource, non-http(s) / media / font aborts), dialog / popup
// handling, download deny, a cleared cookie jar and the decoded-size tracker
// that decides whether a body may be read. Navigation only: no clicks, no
// typing, no form submits. Everything the page returns is attacker-
// influenced data (a compromised site is the point), so every list and
// string is capped and validated here.
//
// Collected (passively — no request is issued beyond what the page makes):
//   scripts   every `<script>` in the final DOM (src resolved, `type`,
//             SRI `integrity`, inline text), plus every main-frame script
//             RESPONSE (catches loaders that inject and remove their tag),
//             each external body hashed (SHA-256) when its decoded size is
//             known to be ≤ NET_MAX_BODY_BYTES; inline text is normalised
//             (normaliseInlineScriptText) then hashed
//   requests  main-frame requests and child-frame document loads (an
//             injected iframe's host), with the script that initiated each
//             request when the browser reports one
// Accepted gaps: WebSocket connections bypass request interception (neither
// guarded nor recorded); a request past the per-page host cap is aborted and
// still recorded as contacted (the page tried it).

import type { Browser, HTTPRequest, HTTPResponse, Page } from "@cloudflare/puppeteer";
import { DESKTOP_UA, DESKTOP_VIEWPORT, makePageHostBudget, sha256Hex } from "./page-capture";
import { hardenPage, interceptRequest, launchBrowser, openPageCdp, orTimeout } from "./page-capture-browser";
import {
  NET_MAX_BODY_BYTES,
  NET_MAX_REQUESTS,
  NET_MAX_URL_LENGTH,
  NetworkCollector,
  bodyFetchVerdict,
  type BodySizeTracker,
} from "./page-capture-network";
import { isExecutableScriptType, normaliseInlineScriptText, type ContactedRequest, type ScannedScript } from "./site-script-watch";
import type { RawSiteScan, SiteScanDriver, SiteScanRequest } from "./site-script-scan";

/** `<script>` tags read from the DOM. */
export const SITE_SCAN_MAX_SCRIPT_TAGS = 300;
/** Main-frame script responses whose bodies may be hashed. */
export const SITE_SCAN_MAX_SCRIPT_RESPONSES = 200;
/** Inline script text read per tag (characters); longer text is cut in the page. */
export const SITE_SCAN_INLINE_MAX_CHARS = 200_000;
/** Inline script text read across all tags (characters). */
export const SITE_SCAN_INLINE_TOTAL_CHARS = 2_000_000;
/** Post-load settle so late-loading tags (tag managers, skimmer loaders) fire. */
export const SITE_SCAN_SETTLE_MS = 3_000;
/** Time allowed to read + hash script bodies after the page settled. */
export const SITE_SCAN_HASH_BUDGET_MS = 6_000;

// Runs inside the page (a string: the Worker's TS config has no DOM lib).
// `s.src` is the resolved absolute URL; text is cut per tag and in total,
// and a tag whose text did not fit is returned with `text: null, cut: true`.
const EXTRACT_SCRIPTS = `(() => {
  let budget = ${SITE_SCAN_INLINE_TOTAL_CHARS};
  return Array.from(document.scripts).slice(0, ${SITE_SCAN_MAX_SCRIPT_TAGS}).map((s) => {
    const hasSrc = s.hasAttribute('src');
    let text = null;
    let cut = false;
    if (!hasSrc) {
      const t = String(s.text || '');
      if (t.length > ${SITE_SCAN_INLINE_MAX_CHARS} || t.length > budget) { cut = true; }
      else { text = t; budget -= t.length; }
    }
    return {
      src: hasSrc ? String(s.src || '') : null,
      type: s.hasAttribute('type') ? String(s.getAttribute('type')) : null,
      integrity: s.hasAttribute('integrity') ? String(s.getAttribute('integrity')) : null,
      text,
      cut,
    };
  });
})()`;

interface ScriptTag {
  src: string | null;
  type: string | null;
  integrity: string | null;
  text: string | null;
  cut: boolean;
}

const optStr = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** Validate the in-page result (untrusted data). Exported for tests. */
export function asScriptTags(v: unknown): ScriptTag[] {
  if (!Array.isArray(v)) return [];
  const out: ScriptTag[] = [];
  for (const raw of v.slice(0, SITE_SCAN_MAX_SCRIPT_TAGS)) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    out.push({
      src: optStr(o["src"], NET_MAX_URL_LENGTH),
      type: optStr(o["type"], 128),
      integrity: optStr(o["integrity"], 1024),
      text: optStr(o["text"], SITE_SCAN_INLINE_MAX_CHARS),
      cut: o["cut"] === true,
    });
  }
  return out;
}

/** URL without its fragment (scripts are keyed on it). */
function stripFragment(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

/**
 * The script behind a request, from the browser's initiator record: the
 * first call frame with a URL (a `script`-type initiator only; a parser-
 * initiated request has none). Exported for tests.
 */
export function scriptInitiatorUrl(initiator: unknown): string | null {
  const o = (initiator && typeof initiator === "object" ? initiator : {}) as Record<string, unknown>;
  if (o["type"] !== "script") return null;
  let stack = o["stack"] as Record<string, unknown> | undefined;
  for (let depth = 0; stack && typeof stack === "object" && depth < 8; depth++) {
    const frames = Array.isArray(stack["callFrames"]) ? (stack["callFrames"] as unknown[]) : [];
    for (const f of frames.slice(0, 50)) {
      const url = (f && typeof f === "object" ? (f as Record<string, unknown>)["url"] : null);
      if (typeof url === "string" && /^https?:\/\//i.test(url)) return url.slice(0, NET_MAX_URL_LENGTH);
    }
    stack = stack["parent"] as Record<string, unknown> | undefined;
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CONTACT_SCHEMES = /^(?:https?|wss?):/i;

interface ScriptResponse {
  url: string;
  res: HTTPResponse;
  requestId: string | null;
}

/** Hash the bodies of recorded script responses within a time budget. */
async function hashScriptBodies(
  responses: ScriptResponse[],
  sizes: BodySizeTracker,
  budgetMs: number,
): Promise<{ byUrl: Map<string, string>; hashed: number; skipped: number }> {
  const byUrl = new Map<string, string>();
  let hashed = 0;
  let skipped = 0;
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (const r of responses) {
    const key = stripFragment(r.url);
    if (byUrl.has(key)) continue;
    const left = deadline - Date.now();
    if (left <= 50) {
      skipped++;
      continue;
    }
    try {
      const status = r.res.status();
      if (status < 200 || status >= 300) {
        skipped++;
        continue;
      }
      const verdict = bodyFetchVerdict(r.res.headers() ?? {}, r.requestId ? sizes.probe(r.requestId) : null);
      if (verdict !== "fetch") {
        skipped++;
        continue;
      }
      const got = await orTimeout(r.res.buffer(), left);
      if (!(got instanceof Uint8Array) || got.byteLength > NET_MAX_BODY_BYTES) {
        // Never hash a partial body: a cut hash would churn body_changed.
        skipped++;
        continue;
      }
      byUrl.set(key, await sha256Hex(got));
      hashed++;
    } catch {
      skipped++;
    }
  }
  return { byUrl, hashed, skipped };
}

/** Exported for the fake-page wiring test. */
export async function scanSiteOnPage(browser: Browser, req: SiteScanRequest): Promise<RawSiteScan> {
  const deadline = Date.now() + req.timeoutMs;
  const remaining = (cap: number): number => Math.max(1_000, Math.min(cap, deadline - Date.now() - 1_000));
  const page: Page = await browser.newPage();
  const chain: string[] = [];
  const recording = { on: true };
  const blocked: { reason: string | null; retryable: boolean } = { reason: null, retryable: false };
  const budget = makePageHostBudget();
  const net = new NetworkCollector();
  const requests: ContactedRequest[] = [];
  const seenUrls = new Set<string>();
  let requestsDropped = 0;
  const scriptResponses: ScriptResponse[] = [];

  const onAbort = (): void => { page.close().catch(() => undefined); };
  if (req.signal.aborted) onAbort();
  else req.signal.addEventListener("abort", onAbort, { once: true });

  const recordContact = (r: HTTPRequest): void => {
    try {
      if (!recording.on) return;
      const url = r.url();
      if (!CONTACT_SCHEMES.test(url)) return;
      const main = page.mainFrame();
      const frame = r.frame();
      const childDocument = r.isNavigationRequest() && frame !== null && frame.parentFrame() === main;
      if (frame !== main && !childDocument) return;
      const u = stripFragment(url).slice(0, NET_MAX_URL_LENGTH);
      if (seenUrls.has(u)) return;
      if (requests.length >= NET_MAX_REQUESTS) {
        requestsDropped++;
        return;
      }
      seenUrls.add(u);
      let initiator: string | null = null;
      try { initiator = scriptInitiatorUrl(r.initiator()); } catch { initiator = null; }
      requests.push({ url: u, initiator_url: initiator });
    } catch { /* evidence only */ }
  };

  try {
    hardenPage(page);
    const { sizes } = await openPageCdp(page);
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      recordContact(r);
      void interceptRequest(r, page, { guard: req.guard, chain, recording, blocked, budget, net });
    });
    page.on("response", (res) => {
      try {
        if (!recording.on || scriptResponses.length >= SITE_SCAN_MAX_SCRIPT_RESPONSES) return;
        const rq = res.request();
        if (rq.resourceType() !== "script" || rq.frame() !== page.mainFrame()) return;
        // `id` (the CDP requestId) is @internal in the typings but present at runtime.
        const id = (rq as unknown as { id?: unknown }).id;
        scriptResponses.push({ url: res.url().slice(0, NET_MAX_URL_LENGTH), res, requestId: typeof id === "string" ? id : null });
      } catch { /* evidence only */ }
    });

    await page.setViewport({ ...DESKTOP_VIEWPORT });
    await page.setUserAgent(DESKTOP_UA);

    let httpStatus: number | null = null;
    let navError: string | null = null;
    try {
      const res = await page.goto(req.targetUrl, { waitUntil: "load", timeout: remaining(15_000) });
      httpStatus = res ? res.status() : null;
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
    }
    const committed = page.url() !== "about:blank" && page.url() !== "";
    if (!committed) {
      if (blocked.reason) {
        return {
          finalUrl: null, httpStatus: null, scripts: [], requests: [], blockedNavigation: blocked.reason,
          blockedRetryable: blocked.retryable, hostCapHit: budget.capped, requestsDropped: 0,
          bodiesHashed: 0, bodiesSkipped: 0, inlineCut: 0,
        };
      }
      throw new Error(`navigation failed: ${navError ?? "page did not load"}`);
    }
    await sleep(Math.min(SITE_SCAN_SETTLE_MS, Math.max(0, deadline - Date.now() - 10_000)));
    recording.on = false;
    net.freeze();

    const finalUrl = page.url();
    const tags = asScriptTags(await page.evaluate(EXTRACT_SCRIPTS));
    const hashed = await hashScriptBodies(
      scriptResponses,
      sizes,
      Math.min(SITE_SCAN_HASH_BUDGET_MS, deadline - Date.now() - 2_000),
    );

    const scripts: ScannedScript[] = [];
    let inlineCut = 0;
    for (const t of tags) {
      if (t.src !== null) {
        scripts.push({
          url: t.src,
          sha256: hashed.byUrl.get(stripFragment(t.src)) ?? null,
          integrity: t.integrity,
          type: t.type,
          page_url: finalUrl,
        });
        continue;
      }
      if (!isExecutableScriptType(t.type)) {
        // Data block: passed through so the diff counts it, never hashed.
        scripts.push({ inline: true, type: t.type, sha256: null, page_url: finalUrl });
        continue;
      }
      if (t.text === null) {
        if (t.cut) inlineCut++;
        continue;
      }
      const normalised = normaliseInlineScriptText(t.text);
      if (normalised === "") continue;
      scripts.push({
        inline: true,
        type: t.type,
        sha256: await sha256Hex(new TextEncoder().encode(normalised)),
        page_url: finalUrl,
      });
    }
    // Script responses with no tag left in the DOM (injected and removed,
    // dynamic import): integrity unknown, so not captured (undefined).
    for (const r of scriptResponses) {
      scripts.push({ url: r.url, sha256: hashed.byUrl.get(stripFragment(r.url)) ?? null, page_url: finalUrl });
    }

    return {
      finalUrl,
      httpStatus,
      scripts,
      requests,
      blockedNavigation: blocked.reason,
      blockedRetryable: blocked.retryable,
      hostCapHit: budget.capped,
      requestsDropped,
      bodiesHashed: hashed.hashed,
      bodiesSkipped: hashed.skipped,
      inlineCut,
    };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
    await page.close().catch(() => undefined);
  }
}

/** One browser session per run (one site per run today). */
export function puppeteerSiteScanDriver(binding: Fetcher): SiteScanDriver {
  return {
    async open() {
      const browser = await launchBrowser(binding);
      return {
        scan: (req) => scanSiteOnPage(browser, req),
        close: async () => {
          await browser.close();
        },
      };
    },
  };
}
