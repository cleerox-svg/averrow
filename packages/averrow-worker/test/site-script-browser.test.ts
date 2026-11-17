// Wiring of the Site Script Watch driver (lib/site-script-browser.ts →
// scanSiteOnPage) against a FAKE browser page: events are fired by hand,
// nothing is launched. Proves OUR wiring — which requests are recorded, the
// shared SSRF interceptor still aborts, script bodies are hashed only when
// their size is known, DOM tags and network responses merge. What the real
// Browser Rendering service returns for `initiator()` / `buffer()` is NOT
// proven here.

import { describe, it, expect, vi } from "vitest";

vi.mock("@cloudflare/puppeteer", () => ({ default: {} }));

import { scanSiteOnPage } from "../src/lib/site-script-browser";
import { makeNavigationGuard, sha256Hex } from "../src/lib/page-capture";
import { normaliseInlineScriptText } from "../src/lib/site-script-watch";

type Handler = (arg: unknown) => void;
const PUBLIC_IP = "93.184.216.34";
const resolveHost = async (host: string): Promise<string[]> => (host.startsWith("private-") ? ["10.0.0.7"] : [PUBLIC_IP]);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function fakeBrowser() {
  const handlers = new Map<string, Handler[]>();
  const mainFrame = { parentFrame: () => null };
  const childFrame = { parentFrame: () => mainFrame };
  const decisions = new Map<string, string>();
  let currentUrl = "about:blank";
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
  const scriptResponse = (url: string, body: string, headers: Record<string, string>) => ({
    url: () => url,
    status: () => 200,
    headers: () => headers,
    request: () => ({ resourceType: () => "script", frame: () => mainFrame, id: `R:${url}` }),
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
      return { status: () => 200 };
    },
    evaluate: async () => [
      { src: "https://acme.com/app.js", type: null, integrity: "sha384-abc", text: null, cut: false },
      { src: "https://skim.example/x.js", type: null, integrity: null, text: null, cut: false },
      { src: null, type: null, integrity: null, text: "  var nonce = '0123456789abcdef0123456789abcdef';  ", cut: false },
      { src: null, type: "application/ld+json", integrity: null, text: "{}", cut: false },
      { src: null, type: null, integrity: null, text: null, cut: true },
    ],
    close: async () => undefined,
  };
  return { browser: { newPage: async () => page } as unknown as Parameters<typeof scanSiteOnPage>[0], decisions };
}

describe("scanSiteOnPage wiring (fake page)", () => {
  it("records main-frame + child-document requests, hashes known-size bodies, merges DOM and network scripts", async () => {
    const fb = fakeBrowser();
    const raw = await scanSiteOnPage(fb.browser, {
      targetUrl: "https://acme.com/",
      timeoutMs: 10_500,
      guard: makeNavigationGuard(resolveHost),
      signal: new AbortController().signal,
    });

    expect(raw.finalUrl).toBe("https://acme.com/");
    // The shared interceptor still guards sub-resources.
    expect(fb.decisions.get("https://private-intranet.example/probe")).toBe("abort");
    expect(fb.decisions.get("https://skim.example/x.js")).toBe("continue");

    expect(raw.requests).toEqual([
      { url: "https://acme.com/", initiator_url: null },
      { url: "https://acme.com/app.js", initiator_url: null },
      { url: "https://skim.example/x.js", initiator_url: null },
      { url: "https://exfil.example/c?d=1", initiator_url: "https://skim.example/x.js" },
      { url: "https://private-intranet.example/probe", initiator_url: null },
      { url: "https://ads.example/frame", initiator_url: null },
    ]);

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
  });
});
