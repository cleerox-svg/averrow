// Wiring of the network collector into the Browser Rendering driver
// (lib/page-capture-browser.ts → captureOnPage), against a FAKE browser page:
// events are fired by hand, nothing is launched. What this proves is OUR
// wiring (what is logged, when the body / cookies are read, what a failure
// does). What the real Browser Rendering service returns for
// `response.buffer()` / `page.cookies()` / the `request` event is NOT proven
// here — see the "unverified" list in docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md.

import { describe, it, expect, vi } from "vitest";

vi.mock("@cloudflare/puppeteer", () => ({ default: {} }));

import { captureOnPage } from "../src/lib/page-capture-browser";
import type { CaptureRequest } from "../src/lib/page-capture";

type Handler = (arg: unknown) => void;

function fakeRequest(url: string, o: { type?: string; method?: string; nav?: boolean; main?: boolean } = {}) {
  const calls: string[] = [];
  const mainFrame = {};
  return {
    calls,
    req: {
      isInterceptResolutionHandled: () => false,
      url: () => url,
      method: () => o.method ?? "GET",
      resourceType: () => o.type ?? "other",
      isNavigationRequest: () => o.nav === true,
      frame: () => (o.main === false ? {} : mainFrame),
      continue: async () => { calls.push("continue"); },
      abort: async () => { calls.push("abort"); },
    },
    mainFrame,
  };
}

interface FakeOpts {
  /** CDP size events fired during goto: decoded chunk lengths for request R1, then loadingFinished. */
  dataEvents?: number[];
  finished?: boolean;
  clearHangs?: boolean;
  responseHeaders?: Record<string, string>;
  body?: () => Promise<Uint8Array>;
  cookies?: () => Promise<unknown[]>;
  noResponse?: boolean;
}

function fakeBrowser(o: FakeOpts = {}) {
  const order: string[] = [];
  const handlers = new Map<string, Handler>();
  const cdpSent: string[] = [];
  const cdpHandlers = new Map<string, Handler>();
  let bodyCalls = 0;
  const frame = {};
  let currentUrl = "about:blank";
  const emit = async (url: string, opts: Parameters<typeof fakeRequest>[1] = {}) => {
    const f = fakeRequest(url, opts);
    // Same frame object as the page's main frame for navigations.
    (f.req as { frame: () => unknown }).frame = () => (opts.main === false ? {} : frame);
    handlers.get("request")!(f.req);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return f.calls;
  };
  const response = o.noResponse ? null : {
    status: () => 200,
    url: () => "https://kit.test/login",
    headers: () => o.responseHeaders ?? { "x-powered-by": "PHP/8.1", "content-type": "text/html", "content-length": "22" },
    request: () => ({ id: "R1" }),
    buffer: async () => {
      bodyCalls++;
      if (o.body) return o.body();
      order.push("body");
      return new TextEncoder().encode("<html>as served</html>");
    },
  };
  const page = {
    on: (ev: string, h: Handler) => { handlers.set(ev, h); },
    setRequestInterception: async () => undefined,
    createCDPSession: async () => ({
      send: async (m: string) => {
        cdpSent.push(m);
        if (m === "Network.clearBrowserCookies" && o.clearHangs) await new Promise(() => undefined);
      },
      on: (ev: string, h: Handler) => { cdpHandlers.set(ev, h); },
    }),
    setViewport: async () => undefined,
    setUserAgent: async () => undefined,
    mainFrame: () => frame,
    url: () => currentUrl,
    goto: async (url: string) => {
      currentUrl = "https://kit.test/login";
      await emit(url, { type: "document", nav: true });
      await emit("https://kit.test/app.js", { type: "script" });
      await emit("https://kit.test/f.woff2", { type: "font" });
      await emit("https://blocked.test/x.js", { type: "script" });
      await emit("https://kit.test/gate.php", { type: "xhr", method: "POST" });
      for (const len of o.dataEvents ?? []) cdpHandlers.get("Network.dataReceived")?.({ requestId: "R1", dataLength: len });
      if (o.finished) cdpHandlers.get("Network.loadingFinished")?.({ requestId: "R1" });
      return response;
    },
    screenshot: async () => new Uint8Array([1, 2, 3]),
    evaluate: async () => ({ title: "Sign in", forms: [], text: "hello", html: "<html>rendered</html>" }),
    reload: async () => { order.push("reload"); await emit("https://kit.test/mobile-only.js", { type: "script" }); return null; },
    cookies: o.cookies ?? (async () => { order.push("cookies"); return [{ name: "PHPSESSID", value: "v", domain: "kit.test", path: "/", secure: true, httpOnly: true }]; }),
    close: async () => undefined,
  };
  return { browser: { newPage: async () => page } as never, order, cdpSent, bodyCalls: () => bodyCalls };
}

const guard = async (url: string) => (url.includes("blocked.test") ? { ok: false as const, reason: "private", retryable: false } : { ok: true as const });
const request = (timeoutMs: number): CaptureRequest => ({ targetUrl: "https://kit.test/login", timeoutMs, guard, signal: new AbortController().signal });

describe("captureOnPage → network evidence", () => {
  it("logs requests (incl. what our interception cut), reads headers/body/cookies before the mobile reload, ignores the reload's requests", async () => {
    const f = fakeBrowser();
    const raw = await captureOnPage(f.browser, request(12_000));
    const net = raw.network!;
    expect(net.status).toBe("complete");
    expect(net.requests.map((r) => [r.m, r.t, r.u, r.b ?? 0])).toEqual([
      ["GET", "document", "https://kit.test/login", 0],
      ["GET", "script", "https://kit.test/app.js", 0],
      ["GET", "font", "https://kit.test/f.woff2", 1], // media/font are aborted by the driver
      ["GET", "script", "https://blocked.test/x.js", 1], // refused by the SSRF guard
      ["POST", "xhr", "https://kit.test/gate.php", 0],
    ]);
    expect(net.aborted).toEqual({ guard: 1, host_cap: 0, scheme: 0, resource: 1 });
    expect(net.requests_complete).toBe(false); // a guard abort cut off what that response would have requested
    expect(net.main_response).toMatchObject({ status: 200, body: "<html>as served</html>", headers: ["Content-Length: 22", "Content-Type: text/html", "X-Powered-By: PHP/8.1"] });
    expect(net.cookies).toEqual([{ name: "PHPSESSID", value: "v", domain: "kit.test", path: "/", secure: true, httpOnly: true }]);
    // The reload (mobile UA) came after the body and cookies were read, and is not evidence.
    expect(f.order.indexOf("reload")).toBeGreaterThan(f.order.indexOf("body"));
    expect(f.order.indexOf("reload")).toBeGreaterThan(f.order.indexOf("cookies"));
    expect(net.requests.some((r) => r.u.includes("mobile-only"))).toBe(false);
    // Each capture starts with an empty cookie jar (the context is shared in a run).
    expect(f.cdpSent).toContain("Network.clearBrowserCookies");
    // Screenshots / DOM are unaffected.
    expect(raw.html).toBe("<html>rendered</html>");
    expect(raw.desktopPng).not.toBeNull();
  });

  it("collection failures never fail the capture: body gone and cookies throwing → partial evidence, same screenshots", async () => {
    const f = fakeBrowser({
      body: async () => { throw new Error("Could not load body for this request."); },
      cookies: async () => { throw new Error("Session closed"); },
    });
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(raw.desktopPng).not.toBeNull();
    expect(raw.html).toBe("<html>rendered</html>");
    expect(raw.network).toMatchObject({ status: "partial", cookies: null });
    expect(raw.network!.main_response).toMatchObject({ body: null, body_skipped: "unavailable" });
    expect(raw.network!.main_response!.headers).toContain("X-Powered-By: PHP/8.1");
  });

  it("no main response (navigation timed out after committing): requests and cookies are kept, no headers / body", async () => {
    const f = fakeBrowser({ noResponse: true });
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(raw.network!.status).toBe("partial");
    expect(raw.network!.main_response).toBeNull();
    expect(raw.network!.requests.length).toBe(5);
    expect(raw.httpStatus).toBeNull();
  });

  it("a hanging body read is cut at the collector's deadline and does not hold the capture", async () => {
    const f = fakeBrowser({ body: () => new Promise(() => undefined), cookies: () => new Promise(() => undefined) });
    const t0 = Date.now();
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(raw.network!.main_response).toMatchObject({ body: null, body_skipped: "timeout" });
    expect(raw.network!.cookies).toBeNull();
    expect(raw.desktopPng).not.toBeNull();
  });
});

describe("captureOnPage → the body is read only when its decoded size is known to be small", () => {
  it("compressed response: Content-Length is the wire size, so CDP's decoded total decides — small → read", async () => {
    const f = fakeBrowser({ responseHeaders: { "content-type": "text/html", "content-encoding": "gzip", "content-length": "9" }, dataEvents: [10, 12], finished: true });
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(f.bodyCalls()).toBe(1);
    expect(raw.network!.main_response).toMatchObject({ body: "<html>as served</html>", body_skipped: null });
  });

  it("a decompression bomb (tiny on the wire, huge decoded) is never read", async () => {
    const f = fakeBrowser({
      responseHeaders: { "content-type": "text/html", "content-encoding": "gzip", "content-length": "800" },
      dataEvents: [1_000_000, 1_000_000, 1_000_000], // 3 MB decoded > the 2 MB cap
      finished: true,
    });
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(f.bodyCalls()).toBe(0);
    expect(raw.network!.main_response).toMatchObject({ body: null, body_skipped: "too_large" });
    expect(raw.desktopPng).not.toBeNull();
  });

  it("an endless / chunked response that exceeds the cap mid-stream is never read, even before it finishes", async () => {
    const f = fakeBrowser({ responseHeaders: { "content-type": "text/html", "transfer-encoding": "chunked" }, dataEvents: [1_500_000, 1_500_000], finished: false });
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(f.bodyCalls()).toBe(0);
    expect(raw.network!.main_response!.body_skipped).toBe("too_large");
  });

  it("no size knowledge and no Content-Length: not read", async () => {
    const f = fakeBrowser({ responseHeaders: { "content-type": "text/html" } });
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(f.bodyCalls()).toBe(0);
    expect(raw.network!.main_response).toMatchObject({ body: null, body_skipped: "unavailable" });
    expect(raw.network!.status).toBe("partial");
  });

  it("no size knowledge, Content-Length present but Content-Encoding gzip: not read", async () => {
    const f = fakeBrowser({ responseHeaders: { "content-type": "text/html", "content-encoding": "gzip", "content-length": "20" } });
    await captureOnPage(f.browser, request(8_600));
    expect(f.bodyCalls()).toBe(0);
  });

  it("no size knowledge, plain Content-Length within the cap: read", async () => {
    const f = fakeBrowser();
    await captureOnPage(f.browser, request(8_600));
    expect(f.bodyCalls()).toBe(1);
  });
});

describe("captureOnPage → cookie jar clearing", () => {
  it("a clear that hangs is cut at ~1 s and this capture records NO cookies (never a previous page's)", async () => {
    const f = fakeBrowser({ clearHangs: true });
    const t0 = Date.now();
    const raw = await captureOnPage(f.browser, request(8_600));
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(raw.network!.cookies).toBeNull();
    expect(raw.network!.status).toBe("partial");
    expect(raw.desktopPng).not.toBeNull();
  });
});
