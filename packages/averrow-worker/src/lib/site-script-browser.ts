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
//             injected iframe's host), ONE entry per contacted host (first
//             URL, first script initiator the browser reports, request
//             count), capped on distinct hosts; a redirected request's final
//             host is recorded too
//   timing    the DOM is read ~SITE_SCAN_SETTLE_MS after load and again
//             ~SITE_SCAN_SECOND_READ_MS after load (delayed injection); the
//             network is recorded until the second read; both reads merge
//   redirects a script body is hashed under every URL of its redirect
//             chain, so the tag's `src` (the chain's head) gets the hash
// Accepted gaps: WebSocket connections bypass request interception (neither
// guarded nor recorded); a request past the per-page host cap is aborted and
// still recorded as contacted (the page tried it).

import type { Browser, HTTPRequest, HTTPResponse, Page } from "@cloudflare/puppeteer";
import { DESKTOP_UA, DESKTOP_VIEWPORT, makePageHostBudget, sha256Hex } from "./page-capture";
import { hardenPage, interceptRequest, launchBrowser, openPageCdp, orTimeout } from "./page-capture-browser";
import {
  NET_MAX_BODY_BYTES,
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
/**
 * Second DOM + network read, this long after `load`: catches a skimmer that
 * waits out a quick crawler before injecting. Fits the 30 s hard timeout
 * (SITE_SCAN_PAGE_TIMEOUT_MS) — it is shortened when navigation was slow.
 */
export const SITE_SCAN_SECOND_READ_MS = 10_000;
/** Time kept after the second read for body hashing + page close. */
export const SITE_SCAN_TAIL_RESERVE_MS = SITE_SCAN_HASH_BUDGET_MS + 2_000;
/**
 * Per-page host cap for the shared request interceptor. Higher than
 * page_capture's 40 (CAPTURE_MAX_HOSTS_PER_PAGE): a real storefront talks to
 * many vendors, and a host aborted by the cap is a host whose script never
 * ran. The SSRF guard still checks every host.
 */
export const SITE_SCAN_MAX_HOSTS_PER_PAGE = 80;
/** Distinct contacted hosts recorded per scan (one entry per host, with a count). */
export const SITE_SCAN_MAX_CONTACTED_HOSTS = 400;

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
  /** Final (post-redirect) response URL, fragment dropped. */
  url: string;
  /** URL the page asked for (head of the redirect chain); equals `url` when not redirected. */
  requestedUrl: string;
  /** Every URL of the redirect chain (requested → … → final), fragment dropped. */
  aliases: string[];
  res: HTTPResponse;
  requestId: string | null;
}

/**
 * The URLs a script response answers for: every request of its redirect
 * chain (the tag's `src` is the chain's head) plus the final response URL.
 * Fragments dropped, capped, de-duplicated, head first. Exported for tests.
 */
export function redirectAliases(chainUrls: readonly string[], finalUrl: string): string[] {
  const out: string[] = [];
  for (const u of [...chainUrls.slice(0, 20), finalUrl]) {
    const k = stripFragment(u).slice(0, NET_MAX_URL_LENGTH);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Hash the bodies of recorded script responses within a time budget. Each
 * hash is stored under every URL of the response's redirect chain, so a tag
 * whose `src` redirected still gets its body hash.
 */
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
    if (byUrl.has(r.url)) {
      for (const a of r.aliases) if (!byUrl.has(a)) byUrl.set(a, byUrl.get(r.url)!);
      continue;
    }
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
      const sha = await sha256Hex(got);
      for (const a of r.aliases) if (!byUrl.has(a)) byUrl.set(a, sha);
      hashed++;
    } catch {
      skipped++;
    }
  }
  return { byUrl, hashed, skipped };
}

/** Same tag in both DOM reads (merge key). */
function tagKey(t: ScriptTag): string {
  return JSON.stringify([t.src, t.type, t.integrity, t.text, t.cut]);
}

/**
 * Merge the two DOM reads: every tag of the first read, then the tags of the
 * second read that the first did not have (a delayed injection). The cut
 * count is the larger of the two reads' (a cut tag still present is one tag).
 */
export function mergeScriptTagReads(first: readonly ScriptTag[], second: readonly ScriptTag[]): { tags: ScriptTag[]; cut: number } {
  const keys = new Set(first.map(tagKey));
  const tags = [...first];
  for (const t of second) {
    const k = tagKey(t);
    if (keys.has(k)) continue;
    keys.add(k);
    if (!t.cut) tags.push(t);
  }
  const cuts = (ts: readonly ScriptTag[]): number => ts.filter((t) => t.src === null && t.cut).length;
  return { tags: tags.filter((t) => !(t.src === null && t.cut)), cut: Math.max(cuts(first), cuts(second)) };
}

/** Exported for the fake-page wiring test. */
export async function scanSiteOnPage(browser: Browser, req: SiteScanRequest): Promise<RawSiteScan> {
  const deadline = Date.now() + req.timeoutMs;
  const remaining = (cap: number): number => Math.max(1_000, Math.min(cap, deadline - Date.now() - 1_000));
  const page: Page = await browser.newPage();
  const chain: string[] = [];
  const recording = { on: true };
  const blocked: { reason: string | null; retryable: boolean } = { reason: null, retryable: false };
  // Own, higher per-page host cap (page_capture keeps 40); same interceptor + SSRF guard.
  const budget = makePageHostBudget(SITE_SCAN_MAX_HOSTS_PER_PAGE);
  const net = new NetworkCollector();
  // ONE entry per contacted host (first URL + first script initiator + count):
  // the cap is on distinct hosts, so a chatty page cannot crowd a late
  // beacon's host out of the record.
  const contacts = new Map<string, ContactedRequest>();
  let contactedHostsDropped = 0;
  const droppedHosts = new Set<string>();
  const scriptResponses: ScriptResponse[] = [];

  const onAbort = (): void => { page.close().catch(() => undefined); };
  if (req.signal.aborted) onAbort();
  else req.signal.addEventListener("abort", onAbort, { once: true });

  const recordContactUrl = (url: string, initiator: () => string | null): void => {
    if (!CONTACT_SCHEMES.test(url)) return;
    const u = stripFragment(url).slice(0, NET_MAX_URL_LENGTH);
    let host: string;
    try {
      host = new URL(u).hostname.toLowerCase().replace(/\.+$/, "");
    } catch {
      return;
    }
    if (!host) return;
    const prior = contacts.get(host);
    if (prior) {
      prior.count = (prior.count ?? 1) + 1;
      if (!prior.initiator_url) prior.initiator_url = initiator();
      return;
    }
    if (contacts.size >= SITE_SCAN_MAX_CONTACTED_HOSTS) {
      if (!droppedHosts.has(host) && droppedHosts.size < 10_000) {
        droppedHosts.add(host);
        contactedHostsDropped++;
      }
      return;
    }
    contacts.set(host, { url: u, initiator_url: initiator(), count: 1 });
  };

  const recordContact = (r: HTTPRequest): void => {
    try {
      if (!recording.on) return;
      const main = page.mainFrame();
      const frame = r.frame();
      const childDocument = r.isNavigationRequest() && frame !== null && frame.parentFrame() === main;
      if (frame !== main && !childDocument) return;
      recordContactUrl(r.url(), () => {
        try { return scriptInitiatorUrl(r.initiator()); } catch { return null; }
      });
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
        if (!recording.on) return;
        const rq = res.request();
        if (rq.frame() !== page.mainFrame()) return;
        const finalUrl = stripFragment(res.url()).slice(0, NET_MAX_URL_LENGTH);
        let chainUrls: string[] = [];
        try {
          chainUrls = (rq.redirectChain?.() ?? []).map((x) => x.url());
        } catch { chainUrls = []; }
        // The redirect's final host is contacted too (a request to it may
        // never surface as its own `request` event).
        if (chainUrls.length > 0) recordContactUrl(finalUrl, () => null);
        if (rq.resourceType() !== "script" || scriptResponses.length >= SITE_SCAN_MAX_SCRIPT_RESPONSES) return;
        const aliases = redirectAliases(chainUrls, finalUrl);
        // `id` (the CDP requestId) is @internal in the typings but present at runtime.
        const id = (rq as unknown as { id?: unknown }).id;
        scriptResponses.push({
          url: finalUrl,
          requestedUrl: aliases[0] ?? finalUrl,
          aliases,
          res,
          requestId: typeof id === "string" ? id : null,
        });
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
    const loadedAt = Date.now();
    const committed = page.url() !== "about:blank" && page.url() !== "";
    if (!committed) {
      if (blocked.reason) {
        return {
          finalUrl: null, httpStatus: null, scripts: [], requests: [], blockedNavigation: blocked.reason,
          blockedRetryable: blocked.retryable, hostCapHit: budget.capped, contactedHostsDropped: 0,
          bodiesHashed: 0, bodiesSkipped: 0, inlineCut: 0,
        };
      }
      throw new Error(`navigation failed: ${navError ?? "page did not load"}`);
    }
    // Read 1: after a short settle (tag managers, loaders).
    await sleep(Math.min(SITE_SCAN_SETTLE_MS, Math.max(0, deadline - Date.now() - SITE_SCAN_TAIL_RESERVE_MS)));
    const first = asScriptTags(await page.evaluate(EXTRACT_SCRIPTS));
    // Read 2: ~SITE_SCAN_SECOND_READ_MS after load, for delayed injection
    // (skimmers that wait out a quick crawler). The network stays recorded
    // until then. Bounded so hashing + the close still fit the hard timeout.
    await sleep(Math.max(0, Math.min(loadedAt + SITE_SCAN_SECOND_READ_MS - Date.now(), deadline - Date.now() - SITE_SCAN_TAIL_RESERVE_MS)));
    const second = asScriptTags(await page.evaluate(EXTRACT_SCRIPTS));
    recording.on = false;
    net.freeze();

    const finalUrl = page.url();
    const merged = mergeScriptTagReads(first, second);
    const hashed = await hashScriptBodies(
      scriptResponses,
      sizes,
      Math.min(SITE_SCAN_HASH_BUDGET_MS, deadline - Date.now() - 2_000),
    );

    const scripts: ScannedScript[] = [];
    for (const t of merged.tags) {
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
      if (t.text === null) continue;
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
    // dynamic import): integrity unknown, so not captured (undefined). Keyed
    // on the URL the page REQUESTED (the redirect chain's head), so a
    // redirected script is one inventory row with its tag, not two.
    for (const r of scriptResponses) {
      scripts.push({ url: r.requestedUrl, sha256: hashed.byUrl.get(r.requestedUrl) ?? null, page_url: finalUrl });
    }

    return {
      finalUrl,
      httpStatus,
      scripts,
      requests: [...contacts.values()],
      blockedNavigation: blocked.reason,
      blockedRetryable: blocked.retryable,
      hostCapHit: budget.capped,
      contactedHostsDropped,
      bodiesHashed: hashed.hashed,
      bodiesSkipped: hashed.skipped,
      inlineCut: merged.cut,
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
