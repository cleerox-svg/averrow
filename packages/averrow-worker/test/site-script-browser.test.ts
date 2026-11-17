// Wiring of the Site Script Watch driver (lib/site-script-browser.ts →
// scanSiteOnPage) against a FAKE browser page: events are fired by hand,
// nothing is launched. Proves OUR wiring — which requests are recorded, the
// shared SSRF interceptor still aborts, script bodies are hashed only when
// their size is known, DOM tags and network responses merge. What the real
// Browser Rendering service returns for `initiator()` / `buffer()` /
// `redirectChain()` is NOT proven here.

import { describe, it, expect, vi } from "vitest";

vi.mock("@cloudflare/puppeteer", () => ({ default: {} }));

import {
  SITE_SCAN_MAX_CONTACTED_HOSTS,
  SITE_SCAN_MAX_HOSTS_PER_PAGE,
  mergeScriptTagReads,
  redirectAliases,
  scanSiteOnPage,
} from "../src/lib/site-script-browser";
import { CAPTURE_MAX_HOSTS_PER_PAGE, makeNavigationGuard, sha256Hex } from "../src/lib/page-capture";
import { normaliseInlineScriptText } from "../src/lib/site-script-watch";

type Handler = (arg: unknown) => void;
const PUBLIC_IP = "93.184.216.34";
const resolveHost = async (host: string): Promise<string[]> => (host.startsWith("private-") ? ["10.0.0.7"] : [PUBLIC_IP]);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface FakeTag {
  src: string | null;
  type: string | null;
  integrity: string | null;
  text: string | null;
  cut: boolean;
}

interface FakeOptions {
  /** Extra events fired after the standard ones (receives the fire helpers). */
  extra?: (h: FakeHelpers) => Promise<void> | void;
  /** Tags returned by the second DOM read (default: same as the first). */
  secondRead?: FakeTag[];
}

interface FakeHelpers {
  fire: (ev: string, arg: unknown) => void;
  request: (url: string, o?: { type?: string; nav?: boolean; frame?: unknown; initiator?: unknown }) => unknown;
  scriptResponse: (url: string, body: string, headers: Record<string, string>, chain?: string[]) => unknown;
  tick: () => Promise<unknown>;
}

const FIRST_READ: FakeTag[] = [
  { src: "https://acme.com/app.js", type: null, integrity: "sha384-abc", text: null, cut: false },
  { src: "https://skim.example/x.js", type: null, integrity: null, text: null, cut: false },
  { src: null, type: null, integrity: null, text: "  var nonce = '0123456789abcdef0123456789abcdef';  ", cut: false },
  { src: null, type: "application/ld+json", integrity: null, text: "{}", cut: false },
  { src: null, type: null, integrity: null, text: null, cut: true },
];

function fakeBrowser(opts: FakeOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const mainFrame = { parentFrame: () => null };
  const childFrame = { parentFrame: () => mainFrame };
  const decisions = new Map<string, string>();
  let currentUrl = "about:blank";
  let reads = 0;
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const request = (url: string, o: { type?: string; nav?: boolean; frame?: unknown; initiator?: unknown } = {}) => ({
    isInterceptResolutionHandled: () => false,
    url: () => url,
    method: () => "GET",
    resourceType: () => o.type ?? "other",
    isNavigationRequest: () => o.nav === true,
    frame: () => o.frame ?? mainFrame,
    initiator: () => o.initiator,
    continue: async () => { decisions.set(url, "continue"); },
    abort: async () => { decisions.set(url, "abort"); },
  });
  const fire = (ev: string, arg: unknown) => { for (const h of handlers.get(ev) ?? []) h(arg); };
  const scriptResponse = (url: string, body: string, headers: Record<string, string>, chain: string[] = []) => ({
    url: () => url,
    status: () => 200,
    headers: () => headers,
    request: () => ({
      resourceType: () => "script",
      frame: () => mainFrame,
      id: `R:${url}`,
      redirectChain: () => chain.map((u) => ({ url: () => u })),
    }),
    buffer: async () => enc(body),
  });

  const page = {
    on: (ev: string, h: Handler) => { handlers.set(ev, [...(handlers.get(ev) ?? []), h]); },
    createCDPSession: async () => { throw new Error("no cdp in the fake"); },
    setRequestInterception: async () => undefined,
    setViewport: async () => undefined,
    setUserAgent: async () => undefined,
    mainFrame: () => mainFrame,
    url: () => currentUrl,
    goto: async (url: string) => {
      fire("request", request(url, { nav: true, type: "document" }));
      await tick();
      currentUrl = url;
      fire("request", request("https://acme.com/app.js", { type: "script" }));
      fire("request", request("https://acme.com/app.js", { type: "script" })); // duplicate URL
      fire("request", request("https://skim.example/x.js", { type: "script" }));
      fire("request", request("https://exfil.example/c?d=1#frag", {
        type: "xhr",
        initiator: { type: "script", stack: { callFrames: [{ url: "https://skim.example/x.js" }] } },
      }));
      fire("request", request("https://private-intranet.example/probe", { type: "xhr" }));
      fire("request", request("https://ads.example/frame", { nav: true, type: "document", frame: childFrame }));
      fire("request", request("https://ads-inner.example/pixel", { type: "image", frame: childFrame }));
      for (let i = 0; i < 4; i++) await tick();
      fire("response", scriptResponse("https://acme.com/app.js", "console.log(1)", { "content-length": "14" }));
      // gzip with no CDP size knowledge → never read
      fire("response", scriptResponse("https://skim.example/x.js", "evil()", { "content-encoding": "gzip" }));
      fire("response", scriptResponse("https://loader.example/gone.js", "x()", { "content-length": "3" }));
      await opts.extra?.({ fire, request, scriptResponse, tick });
      for (let i = 0; i < 4; i++) await tick();
      return { status: () => 200 };
    },
    evaluate: async () => {
      reads++;
      return reads === 1 ? FIRST_READ : (opts.secondRead ?? FIRST_READ);
    },
    close: async () => undefined,
  };
  return {
    browser: { newPage: async () => page } as unknown as Parameters<typeof scanSiteOnPage>[0],
    decisions,
    reads: () => reads,
  };
}

const run = (fb: ReturnType<typeof fakeBrowser>, timeoutMs = 10_500) =>
  scanSiteOnPage(fb.browser, {
    targetUrl: "https://acme.com/",
    timeoutMs,
    guard: makeNavigationGuard(resolveHost),
    signal: new AbortController().signal,
  });

describe("scanSiteOnPage wiring (fake page)", () => {
  it("records one entry per contacted host, hashes known-size bodies, merges DOM and network scripts", async () => {
    const fb = fakeBrowser();
    const raw = await run(fb);

    expect(raw.finalUrl).toBe("https://acme.com/");
    // The shared interceptor still guards sub-resources.
    expect(fb.decisions.get("https://private-intranet.example/probe")).toBe("abort");
    expect(fb.decisions.get("https://skim.example/x.js")).toBe("continue");

    // One entry per host: first URL, first initiator, request count.
    expect(raw.requests).toEqual([
      { url: "https://acme.com/", initiator_url: null, count: 3 },
      { url: "https://skim.example/x.js", initiator_url: null, count: 1 },
      { url: "https://exfil.example/c?d=1", initiator_url: "https://skim.example/x.js", count: 1 },
      { url: "https://private-intranet.example/probe", initiator_url: null, count: 1 },
      { url: "https://ads.example/frame", initiator_url: null, count: 1 },
    ]);
    expect(raw.contactedHostsDropped).toBe(0);

    const appSha = await sha256Hex(enc("console.log(1)"));
    const inlineSha = await sha256Hex(enc(normaliseInlineScriptText("  var nonce = '0123456789abcdef0123456789abcdef';  ")));
    expect(raw.scripts).toEqual([
      { url: "https://acme.com/app.js", sha256: appSha, integrity: "sha384-abc", type: null, page_url: "https://acme.com/" },
      { url: "https://skim.example/x.js", sha256: null, integrity: null, type: null, page_url: "https://acme.com/" },
      { inline: true, type: null, sha256: inlineSha, page_url: "https://acme.com/" },
      { inline: true, type: "application/ld+json", sha256: null, page_url: "https://acme.com/" },
      { url: "https://acme.com/app.js", sha256: appSha, page_url: "https://acme.com/" },
      { url: "https://skim.example/x.js", sha256: null, page_url: "https://acme.com/" },
      { url: "https://loader.example/gone.js", sha256: await sha256Hex(enc("x()")), page_url: "https://acme.com/" },
    ]);
    expect(raw.inlineCut).toBe(1);
    expect(raw.bodiesHashed).toBe(2);
    expect(raw.bodiesSkipped).toBe(1);
    // Two DOM reads.
    expect(fb.reads()).toBe(2);
  });

  it("a redirected script's body hash lands on the tag's src; the final host is contacted", async () => {
    const fb = fakeBrowser({
      extra: ({ fire, scriptResponse }) => {
        fire("response", scriptResponse("https://cdn2.example/lib.v2.js", "lib()", { "content-length": "5" }, ["https://cdn.example/lib.js"]));
      },
      secondRead: [...FIRST_READ, { src: "https://cdn.example/lib.js", type: null, integrity: null, text: null, cut: false }],
    });
    const raw = await run(fb);
    const libSha = await sha256Hex(enc("lib()"));
    // Tag (added on the second, delayed read) carries the hash of its redirected body.
    expect(raw.scripts).toContainEqual({ url: "https://cdn.example/lib.js", sha256: libSha, integrity: null, type: null, page_url: "https://acme.com/" });
    // The response-only entry is keyed on the REQUESTED URL — never a second row for the final URL.
    expect(raw.scripts).toContainEqual({ url: "https://cdn.example/lib.js", sha256: libSha, page_url: "https://acme.com/" });
    expect(raw.scripts.some((s) => s.url === "https://cdn2.example/lib.v2.js")).toBe(false);
    expect(raw.requests.map((r) => r.url)).toContain("https://cdn2.example/lib.v2.js");
  });

  it("caps contacted hosts on DISTINCT hosts (late new host still recorded after many requests to one host)", async () => {
    const fb = fakeBrowser({
      extra: ({ fire, request }) => {
        for (let i = 0; i < 500; i++) fire("request", request(`https://chatty.example/ping?i=${i}`, { type: "xhr" }));
        fire("request", request("https://late-beacon.example/b", { type: "ping" }));
      },
    });
    const raw = await run(fb);
    expect(raw.requests.find((r) => r.url.startsWith("https://chatty.example/"))?.count).toBe(500);
    expect(raw.requests.map((r) => r.url)).toContain("https://late-beacon.example/b");
    expect(raw.contactedHostsDropped).toBe(0);
  });

  it("drops hosts past SITE_SCAN_MAX_CONTACTED_HOSTS and counts them", async () => {
    const fb = fakeBrowser({
      extra: ({ fire, request }) => {
        for (let i = 0; i < SITE_SCAN_MAX_CONTACTED_HOSTS + 5; i++) fire("request", request(`https://h${i}.example/x`, { type: "xhr" }));
      },
    });
    const raw = await run(fb);
    expect(raw.requests).toHaveLength(SITE_SCAN_MAX_CONTACTED_HOSTS);
    // 5 standard hosts + 400 + 5 new = 410 distinct → 10 dropped.
    expect(raw.contactedHostsDropped).toBe(10);
  });

  it("uses its own per-page interceptor host cap (80; page_capture keeps 40)", async () => {
    expect(SITE_SCAN_MAX_HOSTS_PER_PAGE).toBe(80);
    expect(CAPTURE_MAX_HOSTS_PER_PAGE).toBe(40);
    const fb = fakeBrowser({
      extra: async ({ fire, request, tick }) => {
        for (let i = 0; i < 90; i++) fire("request", request(`https://v${i}.example/s.js`, { type: "script" }));
        for (let i = 0; i < 6; i++) await tick();
      },
    });
    const raw = await run(fb);
    expect(raw.hostCapHit).toBe(true);
    // 4 hosts admitted by the standard events (acme, skim, exfil, ads) + 76 → the 77th vN is refused.
    expect(fb.decisions.get("https://v50.example/s.js")).toBe("continue");
    expect(fb.decisions.get("https://v89.example/s.js")).toBe("abort");
  });
});

describe("pure helpers", () => {
  it("redirectAliases: chain head first, final last, fragments dropped, de-duplicated", () => {
    expect(redirectAliases(["https://a.example/x.js#f", "https://b.example/y.js"], "https://c.example/z.js")).toEqual([
      "https://a.example/x.js",
      "https://b.example/y.js",
      "https://c.example/z.js",
    ]);
    expect(redirectAliases([], "https://c.example/z.js")).toEqual(["https://c.example/z.js"]);
  });

  it("mergeScriptTagReads keeps read 1, adds read 2's new tags, cut count is the max", () => {
    const a = { src: "https://a/x.js", type: null, integrity: null, text: null, cut: false };
    const b = { src: "https://b/y.js", type: null, integrity: null, text: null, cut: false };
    const cut = { src: null, type: null, integrity: null, text: null, cut: true };
    const m = mergeScriptTagReads([a, cut], [a, b, cut, cut]);
    expect(m.tags).toEqual([a, b]);
    expect(m.cut).toBe(2);
  });
});
