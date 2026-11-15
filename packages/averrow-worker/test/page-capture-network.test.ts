// Network evidence for page captures (migration 0335, lib/page-capture-network.ts)
// and the IOK exactness switch it drives (lib/iok-engine.ts):
//   - the collector's hard caps and failure isolation, on fake response / page
//     objects (no browser is launched; what is unverified against the real
//     Browser Rendering service is listed in docs/PHISH_PAGE_CAPTURE_SPEC);
//   - the evidence object's shape;
//   - the same rule is approximate on a capture without the artifact and exact
//     on one that has it, and a rule that NEGATES a field never matches on a
//     capture that lacks that field exactly.
// Storage, hashing, the sweep and exposure are in test/page-capture.test.ts and
// test/iok-kit-matches-exposure.test.ts.

import { describe, it, expect } from "vitest";
import {
  NET_MAX_BODY_BYTES,
  NET_MAX_COOKIES,
  NET_MAX_COOKIE_VALUE,
  NET_MAX_HEADERS,
  NET_MAX_HEADER_VALUE,
  NET_MAX_REQUESTS,
  NET_MAX_URL_LENGTH,
  NET_MAX_OBJECT_BYTES,
  NetworkCollector,
  canonicalHeaderKey,
  cookieDomainMatches,
  headerEntries,
  serializeNetworkEvidence,
  summarizeNetworkEvidence,
  toIokNetworkInput,
  type CookiePageLike,
  type MainResponseLike,
  type NetworkEvidence,
} from "../src/lib/page-capture-network";
import { CAPTURE_HTML_MAX_BYTES } from "../src/lib/page-capture";
import { BodySizeTracker, NET_MAX_BODY_FETCH_BYTES, bodyFetchVerdict, decodeBody } from "../src/lib/page-capture-network";
import { IOK_LIST_MAX, buildIokEvidence, evaluateIokRules, type IokRule } from "../src/lib/iok-engine";
import { IOK_RULESET } from "../src/lib/iok-ruleset";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function response(over: Partial<{ status: number; url: string; headers: Record<string, string>; body: Uint8Array | (() => Promise<Uint8Array>) }> = {}): MainResponseLike {
  const body = over.body ?? enc("<html>served</html>");
  return {
    url: () => over.url ?? "https://kit.test/login",
    status: () => over.status ?? 200,
    headers: () => over.headers ?? {
      "content-type": "text/html", server: "Apache",
      // The decoded size is only known (without CDP events) from Content-Length with no Content-Encoding.
      "content-length": typeof body === "function" ? "10" : String(body.byteLength),
    },
    buffer: typeof body === "function" ? body : async () => body,
  };
}

function page(cookies: Array<Record<string, unknown>> | (() => Promise<never>), url = "https://kit.test/login"): CookiePageLike {
  return {
    url: () => url,
    cookies: typeof cookies === "function" ? cookies : async () => cookies,
  };
}

describe("network evidence — constants", () => {
  it("the raw body cap equals the stored rendered-HTML cap", () => {
    expect(NET_MAX_BODY_BYTES).toBe(CAPTURE_HTML_MAX_BYTES);
  });
});

describe("network collector — hard caps", () => {
  it("caps the request list, dedups, and clips URLs", async () => {
    const c = new NetworkCollector();
    c.noteRequest("get", "https://kit.test/a", "script");
    c.noteRequest("GET", "https://kit.test/a", "script"); // duplicate: counted, not stored
    for (let i = 0; i < NET_MAX_REQUESTS + 25; i++) c.noteRequest("GET", `https://kit.test/r${i}`, "image");
    c.noteRequest("GET", `https://kit.test/${"x".repeat(NET_MAX_URL_LENGTH * 2)}`, "xhr");
    const ev = await c.finish(response(), page([]));
    expect(ev.requests.length).toBe(NET_MAX_REQUESTS);
    expect(ev.requests[0]).toEqual({ m: "GET", t: "script", u: "https://kit.test/a" });
    expect(ev.requests_total).toBe(NET_MAX_REQUESTS + 25 + 3);
    expect(ev.requests_dropped).toBeGreaterThan(0);
    expect(ev.requests_complete).toBe(false); // cap hit → not exact
    expect(ev.requests.every((r) => r.u.length <= NET_MAX_URL_LENGTH)).toBe(true);
  });

  it("clips a long URL and keeps a short log exact", async () => {
    const c = new NetworkCollector();
    c.noteRequest("GET", `https://kit.test/${"y".repeat(NET_MAX_URL_LENGTH * 2)}`, "document");
    const ev = await c.finish(response(), page([]));
    expect(ev.requests[0]!.u.length).toBe(NET_MAX_URL_LENGTH);
    expect(ev.requests_complete).toBe(true);
  });

  it("caps header count and value size and says the headers are incomplete", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < NET_MAX_HEADERS + 20; i++) many[`x-h${i}`] = "v";
    const r = headerEntries(many);
    expect(r.entries.length).toBe(NET_MAX_HEADERS);
    expect(r.complete).toBe(false);
    const big = headerEntries({ "x-big": "z".repeat(NET_MAX_HEADER_VALUE + 50) });
    expect(big.entries[0]!.length).toBe("X-Big: ".length + NET_MAX_HEADER_VALUE);
    expect(big.complete).toBe(false);
  });

  it("splits CDP's newline-joined repeated headers and renders IOK's canonical names, sorted", () => {
    const r = headerEntries({ "x-powered-by": "PHP/8.1", "set-cookie": "a=1\nb=2", "content-type": "text/html" });
    expect(r).toEqual({ complete: true, entries: ["Content-Type: text/html", "Set-Cookie: a=1", "Set-Cookie: b=2", "X-Powered-By: PHP/8.1"] });
    expect(canonicalHeaderKey("x-powered-by")).toBe("X-Powered-By");
    expect(canonicalHeaderKey("ETAG")).toBe("Etag");
    expect(canonicalHeaderKey("bad header")).toBe("bad header"); // Go leaves a non-token name alone
  });

  it("caps cookies, clips values, and keeps only the page's own origin", async () => {
    const jar = Array.from({ length: NET_MAX_COOKIES + 10 }, (_, i) => ({ name: `c${i}`, value: "v", domain: "kit.test", path: "/", secure: true, httpOnly: false }));
    jar.push({ name: "tracker", value: "t", domain: ".ads.example", path: "/", secure: false, httpOnly: false });
    jar.unshift({ name: "long", value: "L".repeat(NET_MAX_COOKIE_VALUE + 30), domain: ".kit.test", path: "/", secure: false, httpOnly: true });
    const ev = await new NetworkCollector().finish(response(), page(jar));
    expect(ev.cookies!.length).toBe(NET_MAX_COOKIES);
    expect(ev.cookies![0]!.value.length).toBe(NET_MAX_COOKIE_VALUE);
    expect(ev.cookies_clipped).toBe(true);
    expect(ev.cookies_dropped).toBeGreaterThan(0);
    expect(ev.cookies!.some((c) => c.name === "tracker")).toBe(false);
    expect(cookieDomainMatches(".kit.test", "a.kit.test")).toBe(true);
    expect(cookieDomainMatches("kit.test", "evilkit.test")).toBe(false);
  });

  it("cuts the body at the cap and flags it; never fetches one declared far over the cap", async () => {
    // A probe that says "small" while the browser then hands back more (it lied / raced): still cut at the cap.
    const big = new Uint8Array(NET_MAX_BODY_BYTES + 100).fill(97);
    const small = { exceeded: false, finished: true, bytes: 10 };
    const ev = await new NetworkCollector().finish(response({ body: big }), page([]), 3000, { probe: small });
    expect(ev.main_response!.body_truncated).toBe(true);
    expect(ev.main_response!.body_bytes).toBe(NET_MAX_BODY_BYTES);
    expect(ev.main_response!.body!.length).toBe(NET_MAX_BODY_BYTES);

    let called = false;
    const huge = response({ headers: { "content-length": String(50 * 1024 * 1024) }, body: async () => { called = true; return new Uint8Array(1); } });
    const ev2 = await new NetworkCollector().finish(huge, page([]));
    expect(called).toBe(false);
    expect(ev2.main_response).toMatchObject({ body: null, body_skipped: "too_large" });
    expect(ev2.main_response!.headers.length).toBeGreaterThan(0); // headers still kept
  });

  it("a hostile object over the size budget loses the body, not the capture", () => {
    const ev = {
      status: "complete", requests: [], requests_total: 0, requests_dropped: 0, requests_complete: true,
      aborted: { guard: 0, host_cap: 0, scheme: 0, resource: 0 }, cookies: [], cookies_dropped: 0, cookies_clipped: false,
      main_response: { url: "u", status: 200, headers: [], headers_complete: true, body: "é".repeat(NET_MAX_OBJECT_BYTES), body_bytes: 1, body_truncated: false, body_skipped: null },
    } as NetworkEvidence;
    const ser = serializeNetworkEvidence(ev, { capture_id: "pc_x", captured_at: "2026-11-15T00:00:00Z" });
    expect(ser.bytes.byteLength).toBeLessThan(NET_MAX_OBJECT_BYTES);
    expect(ser.evidence.status).toBe("partial");
    expect(ser.evidence.main_response).toMatchObject({ body: null, body_skipped: "too_large" });
  });
});

describe("network collector — failure isolation", () => {
  it("garbage events never throw", () => {
    const c = new NetworkCollector();
    expect(() => {
      c.noteRequest(undefined, undefined, undefined);
      c.noteRequest({}, 42, null);
      c.noteAbort("guard", undefined, undefined);
    }).not.toThrow();
  });

  it("a body that rejects keeps the headers; cookies that throw are 'unreadable', not a failure", async () => {
    const c = new NetworkCollector();
    c.noteRequest("GET", "https://kit.test/login", "document");
    const ev = await c.finish(
      response({ body: async () => { throw new Error("No resource with given identifier found"); } }),
      page(async () => { throw new Error("page closed"); }),
    );
    expect(ev.status).toBe("partial");
    expect(ev.main_response).toMatchObject({ body: null, body_skipped: "unavailable" });
    expect(ev.main_response!.headers.length).toBeGreaterThan(0);
    expect(ev.cookies).toBeNull();
    // The unreadable parts become 'absent' fields, never an empty list claimed as real.
    const input = toIokNetworkInput(ev);
    expect(input).toMatchObject({ rawHtml: null, cookies: null });
    expect(input.headers).not.toBeNull();
  });

  it("a hanging body or cookie read is cut at the deadline", async () => {
    const never = (): Promise<never> => new Promise(() => undefined);
    const t0 = Date.now();
    const ev = await new NetworkCollector().finish(response({ body: never }), page(never), 300);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(ev.main_response).toMatchObject({ body: null, body_skipped: "timeout" });
    expect(ev.cookies).toBeNull();
  });

  it("nothing obtained is 'failed' (no object is stored for it)", async () => {
    const ev = await new NetworkCollector().finish(null, null);
    expect(ev.status).toBe("failed");
    expect(ev.main_response).toBeNull();
  });

  it("a response whose accessors throw does not throw out of finish()", async () => {
    const bad = { url: () => { throw new Error("x"); }, status: () => 200, headers: () => ({}), buffer: async () => new Uint8Array(0) } as MainResponseLike;
    const ev = await new NetworkCollector().finish(bad, null);
    expect(ev.status).toBe("failed");
  });

  it("events after freeze() are not evidence (the mobile reload)", async () => {
    const c = new NetworkCollector();
    c.noteRequest("GET", "https://kit.test/a", "document");
    c.freeze();
    c.noteRequest("GET", "https://kit.test/mobile-only", "document");
    c.noteAbort("guard", "GET", "https://kit.test/a");
    const ev = await c.finish(response(), page([]));
    expect(ev.requests.map((r) => r.u)).toEqual(["https://kit.test/a"]);
    expect(ev.aborted.guard).toBe(0);
  });

  it("a request our interception cut off makes the log non-exact (a blocked response cannot request what it would have)", async () => {
    const c = new NetworkCollector();
    c.noteRequest("GET", "https://kit.test/login", "document");
    c.noteRequest("GET", "https://cdn.blocked.test/x.js", "script");
    c.noteAbort("host_cap", "GET", "https://cdn.blocked.test/x.js");
    const ev = await c.finish(response(), page([]));
    expect(ev.requests_complete).toBe(false);
    expect(ev.requests.find((r) => r.u.includes("blocked"))!.b).toBe(1);
    // A blocked font spawns nothing: it does not downgrade the log.
    const f = new NetworkCollector();
    f.noteRequest("GET", "https://kit.test/login", "document");
    f.noteRequest("GET", "https://kit.test/f.woff2", "font");
    f.noteAbort("resource", "GET", "https://kit.test/f.woff2");
    expect((await f.finish(response(), page([]))).requests_complete).toBe(true);
  });
});

describe("network evidence object", () => {
  it("serialises to one compact JSON object with its envelope, and the summary holds counters only", async () => {
    const c = new NetworkCollector();
    c.noteRequest("GET", "https://kit.test/login", "document");
    const ev = await c.finish(
      response({ headers: { "x-powered-by": "PHP/8.1", "set-cookie": "PHPSESSID=abc; path=/", "content-length": "19" } }),
      page([{ name: "PHPSESSID", value: "abc", domain: "kit.test", path: "/", secure: true, httpOnly: true }]),
    );
    expect(ev.status).toBe("complete");
    const ser = serializeNetworkEvidence(ev, { capture_id: "pc_1", captured_at: "2026-11-15T00:00:00.000Z" });
    const obj = JSON.parse(new TextDecoder().decode(ser.bytes)) as Record<string, unknown>;
    expect(Object.keys(obj).sort()).toEqual([
      "aborted", "capture_id", "captured_at", "cookies", "cookies_clipped", "cookies_dropped", "main_response",
      "requests", "requests_complete", "requests_dropped", "requests_total", "status", "version",
    ]);
    expect(obj["version"]).toBe(1);
    expect((obj["main_response"] as { headers: string[] }).headers).toContain("X-Powered-By: PHP/8.1");
    const sum = summarizeNetworkEvidence(ser.evidence);
    expect(sum).toEqual({ status: "complete", requests: 1, cookies: 1, headers: 3, body_bytes: enc("<html>served</html>").byteLength });
    expect(JSON.stringify(sum)).not.toContain("abc"); // no value in what reaches D1 / meta.json
  });
});

// ─── The IOK exactness switch ────────────────────────────────────────

const byId = (id: string): IokRule => {
  const r = IOK_RULESET.rules.find((x) => x.id === id);
  if (!r) throw new Error(`rule ${id} not vendored`);
  return r;
};
const base = { title: "t", finalUrl: "https://kit.test/", targetUrl: "https://kit.test/", redirectChain: ["https://kit.test/"] };
const inputOf = (over: Partial<ReturnType<typeof toIokNetworkInput>>): ReturnType<typeof toIokNetworkInput> => ({
  rawHtml: null, rawHtmlTruncated: false, headers: null, headersComplete: false, cookies: null, requests: null, requestsComplete: false, ...over,
});
const run = (rules: IokRule[], html: string, network: ReturnType<typeof toIokNetworkInput> | null) => {
  const e = buildIokEvidence({ ...base, html, network });
  return { e, out: evaluateIokRules({ rules }, e) };
};

describe("IOK exactness: same rule, approximate on an old capture, exact on a new one", () => {
  const rule: IokRule = {
    id: "needs-html", title: "needs html", tags: [],
    sel: { s: [[{ f: "html", op: "contains", v: ["KITMARK"] }]] },
    cond: { t: "ref", n: "s" },
  };

  it("html: DOM stand-in is approximate; the response as served is exact", () => {
    const legacy = run([rule], "<html>KITMARK</html>", null);
    expect(legacy.out.matches.map((m) => [m.rule_id, m.approximate_fields])).toEqual([["needs-html", ["html"]]]);
    const fresh = run([rule], "<html>KITMARK</html>", inputOf({ rawHtml: "<html>KITMARK</html>" }));
    expect(fresh.out.matches.map((m) => [m.rule_id, m.approximate_fields])).toEqual([["needs-html", []]]);
  });

  it("html: a string a SCRIPT injected over-matches on an old capture and no longer does on a new one", () => {
    const injectedDom = "<html><body>KITMARK</body></html>"; // only in the DOM
    expect(run([rule], injectedDom, null).out.matches).toHaveLength(1);
    expect(run([rule], injectedDom, inputOf({ rawHtml: "<html><script>document.body.append('KIT'+'MARK')</script></html>" })).out.matches).toHaveLength(0);
  });

  it("requests: a referenced-but-never-requested URL over-matches before and not after; a fetch/XHR is seen after", () => {
    const req: IokRule = { id: "needs-req", title: "r", tags: [], sel: { s: [[{ f: "requests", op: "contains", v: ["/gate.php"] }]] }, cond: { t: "ref", n: "s" } };
    const lazyMarkup = "<html><img src=\"/gate.php\"></html>";
    expect(run([req], lazyMarkup, null).out.matches.map((m) => m.approximate_fields)).toEqual([["requests"]]);
    const log = inputOf({ requests: ["https://kit.test/"], requestsComplete: true });
    expect(run([req], lazyMarkup, log).out.matches).toHaveLength(0);
    const xhr = inputOf({ requests: ["https://kit.test/", "https://kit.test/gate.php"], requestsComplete: true });
    const r = run([req], "<html></html>", xhr);
    expect(r.out.matches.map((m) => [m.rule_id, m.approximate_fields])).toEqual([["needs-req", []]]);
  });

  it("a cut artifact is a subset, never exact", () => {
    expect(run([rule], "x", inputOf({ rawHtml: "KITMARK", rawHtmlTruncated: true })).out.matches[0]!.approximate_fields).toEqual(["html"]);
    const log = inputOf({ requests: Array.from({ length: IOK_LIST_MAX + 5 }, (_, i) => `https://kit.test/${i}`), requestsComplete: true });
    expect(buildIokEvidence({ ...base, html: "", network: log }).fidelity?.requests).toBe("subset");
    expect(buildIokEvidence({ ...base, html: "", network: inputOf({ headers: ["A: b"], headersComplete: false }) }).fidelity?.headers).toBe("subset");
  });

  it("cookies are a subset (own origin only) and headers/cookies are absent without the artifact", () => {
    const cookies = inputOf({ cookies: ["PHPSESSID=x"] });
    expect(buildIokEvidence({ ...base, html: "", network: cookies }).fidelity?.cookies).toBe("subset");
    expect(buildIokEvidence({ ...base, html: "", network: null }).fidelity).toEqual({});
  });

  it("the rules that were dropped only for missing headers / cookies are vendored and fire on exact fields", () => {
    const cazanova = byId("cazanova-cookie");
    expect(run([cazanova], "", null).out.matches).toHaveLength(0); // no cookies on an old capture
    const withCookie = run([cazanova], "", inputOf({ cookies: ["cazanova=1; x"] , headers: [], headersComplete: true }));
    expect(withCookie.out.matches.map((m) => [m.rule_id, m.approximate_fields])).toEqual([["cazanova-cookie", ["cookies"]]]);

    const fake404 = byId("fake-404-page");
    const page404 = "<html><title>404 Not Found</title><p>The requested URL was not found on this server.</p></html>";
    expect(run([fake404], page404, null).out.matches).toHaveLength(0); // needs PHP header or cookie
    const php = run([fake404], page404, inputOf({ rawHtml: page404, headers: ["X-Powered-By: PHP/8.1"], headersComplete: true }));
    expect(php.out.matches.map((m) => [m.rule_id, m.approximate_fields])).toEqual([["fake-404-page", []]]);
  });
});

describe("IOK negation safety — a missing artifact must not make `not X` true", () => {
  const kimsuky = byId("kimsuky-nginx-fake-error-9b43f670"); // fakeHTML and not nginxHeader
  const fakeHtml = [
    "<meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\">", "<body bgcolor=\"white\">", "<center>", "<h1>404 Not Found</h1>",
    "</center>", "<hr>", "<center>nginx</center>",
  ].join("\n");

  it("negates the headers field, so it is only evaluable with exact headers", async () => {
    const { negatedFieldsOf } = await import("../src/lib/iok-engine");
    expect(negatedFieldsOf(kimsuky)).toEqual(["headers"]);
  });

  it("capture without headers: not applicable, no match (an empty list must not satisfy `not nginxHeader`)", () => {
    const { out } = run([kimsuky], fakeHtml, inputOf({ rawHtml: fakeHtml }));
    expect(out).toMatchObject({ matches: [], not_applicable: 1, evaluated: 0, skipped: 0, budget_exhausted: false, status: "complete" });
    const legacy = run([kimsuky], fakeHtml, null).out;
    expect(legacy).toMatchObject({ matches: [], not_applicable: 1 });
  });

  it("capture with CUT headers (subset): still not applicable", () => {
    const { out } = run([kimsuky], fakeHtml, inputOf({ rawHtml: fakeHtml, headers: ["Server: Apache"], headersComplete: false }));
    expect(out).toMatchObject({ matches: [], not_applicable: 1 });
  });

  it("capture with exact headers: nginx header present → no match; absent → match", () => {
    const withNginx = run([kimsuky], fakeHtml, inputOf({ rawHtml: fakeHtml, headers: ["Server: nginx/1.18"], headersComplete: true })).out;
    expect(withNginx.matches).toHaveLength(0);
    expect(withNginx.not_applicable).toBe(0);
    const fake = run([kimsuky], fakeHtml, inputOf({ rawHtml: fakeHtml, headers: ["Server: Apache"], headersComplete: true })).out;
    expect(fake.matches.map((m) => m.rule_id)).toEqual(["kimsuky-nginx-fake-error-9b43f670"]);
  });

  it("a negated html rule needs the response as served, not the DOM stand-in", () => {
    const neg: IokRule = {
      id: "neg-html", title: "n", tags: [],
      sel: { a: [[{ f: "dom", op: "contains", v: ["<form"] }]], b: [[{ f: "html", op: "contains", v: ["<noscript>"] }]] },
      cond: { t: "and", c: [{ t: "ref", n: "a" }, { t: "not", c: { t: "ref", n: "b" } }] },
    };
    expect(run([neg], "<form>", null).out).toMatchObject({ matches: [], not_applicable: 1 });
    expect(run([neg], "<form>", inputOf({ rawHtml: "<form>", rawHtmlTruncated: true })).out).toMatchObject({ matches: [], not_applicable: 1 });
    expect(run([neg], "<form>", inputOf({ rawHtml: "<form>" })).out.matches.map((m) => m.rule_id)).toEqual(["neg-html"]);
    expect(run([neg], "<form>", inputOf({ rawHtml: "<form><noscript>" })).out.matches).toHaveLength(0);
  });

  it("a rule negating a field that can never be exact (cookies, title) is never evaluated, even if hand-added to the JSON", () => {
    const neg: IokRule = {
      id: "neg-cookie", title: "n", tags: [],
      sel: { a: [[{ f: "dom", op: "contains", v: ["x"] }]], c: [[{ f: "cookies", op: "startswith", v: ["sid="] }]] },
      cond: { t: "and", c: [{ t: "ref", n: "a" }, { t: "not", c: { t: "ref", n: "c" } }] },
    };
    expect(run([neg], "x", inputOf({ cookies: [], headers: [], headersComplete: true })).out).toMatchObject({ matches: [], not_applicable: 1 });
  });

  it("not_applicable does not change kit_eval_status semantics: a budget stop is still 'partial'", () => {
    const e = buildIokEvidence({ ...base, html: "x".repeat(1000), network: null });
    const out = evaluateIokRules(IOK_RULESET, e, { workBudget: 10 });
    expect(out.status).toBe("partial");
    expect(out.skipped + out.evaluated + out.not_applicable).toBe(IOK_RULESET.rules.length);
  });
});

describe("IOK evidence caps with network input", () => {
  it("headers / cookies lists and entries are capped before evaluation", () => {
    const e = buildIokEvidence({
      ...base, html: "",
      network: inputOf({
        headers: Array.from({ length: IOK_LIST_MAX + 40 }, (_, i) => `H${i}: ${"v".repeat(20_000)}`), headersComplete: true,
        cookies: Array.from({ length: IOK_LIST_MAX + 40 }, (_, i) => `c${i}=v`),
      }),
    });
    expect(e.headers!.length).toBe(IOK_LIST_MAX);
    expect(Math.max(...e.headers!.map((h) => h.length))).toBeLessThanOrEqual(8_192);
    expect(e.cookies!.length).toBe(IOK_LIST_MAX);
    expect(e.clipped).toBe(true);
    expect(e.fidelity?.headers).toBe("subset");
  });
});

describe("body size gate — the body is read only when the decoded size is known and small", () => {
  const html = { "content-type": "text/html" };
  it("headers only: needs Content-Length, within the cap, no Content-Encoding, not chunked", () => {
    expect(bodyFetchVerdict({ ...html }, null)).toBe("unknown"); // no Content-Length
    expect(bodyFetchVerdict({ ...html, "content-length": "100", "content-encoding": "gzip" }, null)).toBe("unknown");
    expect(bodyFetchVerdict({ ...html, "content-length": "100", "content-encoding": "br" }, null)).toBe("unknown");
    expect(bodyFetchVerdict({ ...html, "content-length": "100", "transfer-encoding": "chunked" }, null)).toBe("unknown");
    expect(bodyFetchVerdict({ ...html, "content-length": "abc" }, null)).toBe("unknown");
    expect(bodyFetchVerdict({ ...html, "content-length": String(NET_MAX_BODY_FETCH_BYTES + 1) }, null)).toBe("too_large");
    expect(bodyFetchVerdict({ ...html, "content-length": "1234" }, null)).toBe("fetch");
    expect(bodyFetchVerdict({ ...html, "content-length": "1234", "content-encoding": "identity" }, null)).toBe("fetch");
  });

  it("a CDP-decoded total overrides the headers in both directions", () => {
    const t = new BodySizeTracker();
    t.noteData("a", 500); t.noteData("a", 700); t.noteFinished("a");
    expect(bodyFetchVerdict({ ...html, "content-encoding": "gzip" }, t.probe("a"))).toBe("fetch");
    t.noteData("b", NET_MAX_BODY_FETCH_BYTES); t.noteData("b", 1);
    expect(bodyFetchVerdict({ ...html, "content-length": "10" }, t.probe("b"))).toBe("too_large"); // exceeded, even unfinished
    t.noteData("c", 10); // not finished: total not final → fall back to headers (none) → unknown
    expect(bodyFetchVerdict({ ...html }, t.probe("c"))).toBe("unknown");
  });

  it("the tracker is bounded and ignores garbage", () => {
    const t = new BodySizeTracker();
    for (let i = 0; i < 1000; i++) t.noteData(`r${i}`, 1);
    t.noteData(42, "x"); t.noteData("z", -5); t.noteFinished({});
    expect(t.probe("r0").bytes).toBe(1);
    expect(t.probe("r999").bytes).toBeNull(); // beyond the first 500 ids
    expect(t.probe("z").bytes).toBeNull();
  });

  it("collector: no Content-Length / gzip → buffer() is never called; known small → called", async () => {
    let calls = 0;
    const mk = (headers: Record<string, string>): MainResponseLike => ({ url: () => "https://kit.test/login", status: () => 200, headers: () => headers, buffer: async () => { calls++; return enc("ok"); } });
    await new NetworkCollector().finish(mk({ "content-type": "text/html" }), page([]));
    await new NetworkCollector().finish(mk({ "content-length": "2", "content-encoding": "gzip" }), page([]));
    expect(calls).toBe(0);
    const ev = await new NetworkCollector().finish(mk({ "content-length": "2" }), page([]));
    expect(calls).toBe(1);
    expect(ev.main_response!.body).toBe("ok");
  });

  it("a body that arrives only after the timeout is dropped, and the verdict already bounded its size", async () => {
    const slow = response({ body: () => new Promise<Uint8Array>((r) => setTimeout(() => r(enc("late")), 400)) });
    const ev = await new NetworkCollector().finish(slow, page([]), 250);
    expect(ev.main_response).toMatchObject({ body: null, body_skipped: "timeout" });
  });
});

describe("main response vs the document the page ended on", () => {
  const fake404 = byId("kimsuky-nginx-fake-error-9b43f670");
  const FAKE = ["<meta http-equiv=\"Content-Type\" content=\"text/html; charset=windows-1252\">", "<body bgcolor=\"white\">", "<center>", "<h1>404 Not Found</h1>", "</center>", "<hr>", "<center>nginx</center>"].join("\n");

  it("lander -> kit redirect: headers and body belong to the lander, so they are a subset and negating rules do not run", async () => {
    const lander = response({ url: "https://lander.test/go", headers: { "content-length": "5", server: "Apache" }, body: enc("hello") });
    const ev = await new NetworkCollector().finish(lander, page([], "https://kit.test/login"));
    expect(ev.main_response!.matches_final).toBe(false);
    const input = toIokNetworkInput(ev);
    expect(input.mainMatchesFinal).toBe(false);
    const built = buildIokEvidence({ ...base, html: FAKE, network: { ...input, rawHtml: FAKE, headersComplete: true } });
    expect(built.fidelity).toMatchObject({ html: "subset", headers: "subset" });
    const out = evaluateIokRules({ rules: [fake404] }, built);
    expect(out).toMatchObject({ matches: [], not_applicable: 1 });
  });

  it("same document (fragment / trailing hash ignored) stays exact", async () => {
    const same = response({ url: "https://kit.test/login", headers: { "content-length": "5" }, body: enc("hello") });
    const ev = await new NetworkCollector().finish(same, page([], "https://kit.test/login#step2"));
    expect(ev.main_response!.matches_final).toBe(true);
    const built = buildIokEvidence({ ...base, html: "x", network: toIokNetworkInput(ev) });
    expect(built.fidelity).toMatchObject({ html: "exact", headers: "exact" });
  });
});

describe("response charset", () => {
  it("windows-1252 page: decoded with its charset; non-ASCII bytes make html a subset, never exact", async () => {
    const bytes = new Uint8Array([...enc("<html>caf"), 0xe9, ...enc("</html>")]); // "café" in windows-1252
    const d = decodeBody(bytes, "text/html; charset=windows-1252");
    expect(d.text).toBe("<html>caf\u00e9</html>");
    expect(d).toMatchObject({ charset: "windows-1252", exact: false });
    const ev = await new NetworkCollector().finish(
      response({ headers: { "content-type": "text/html; charset=windows-1252", "content-length": String(bytes.byteLength) }, body: bytes }), page([]));
    expect(ev.main_response).toMatchObject({ body_charset: "windows-1252", body_text_exact: false });
    expect(buildIokEvidence({ ...base, html: "", network: toIokNetworkInput(ev) }).fidelity?.html).toBe("subset");
  });

  it("an ASCII-only page in any charset, and clean UTF-8, are exact; invalid UTF-8 / an unsupported label are not", () => {
    expect(decodeBody(enc("<html>plain</html>"), "text/html; charset=windows-1252").exact).toBe(true);
    expect(decodeBody(enc("<html>caf\u00e9</html>"), "text/html; charset=utf-8").exact).toBe(true);
    expect(decodeBody(enc("<html>caf\u00e9</html>"), "text/html").exact).toBe(true);
    const bad = new Uint8Array([...enc("<html>"), 0xff, 0xfe]);
    expect(decodeBody(bad, "text/html")).toMatchObject({ exact: false });
    expect(decodeBody(enc("<html>plain</html>"), "text/html; charset=x-not-a-charset")).toMatchObject({ exact: false, charset: "x-not-a-charset" });
  });
});

describe("cookies without an attributable origin", () => {
  it("an empty / unparseable page URL records no cookies at all", async () => {
    const jar = [{ name: "sid", value: "v", domain: "", path: "/", secure: false, httpOnly: false }];
    expect((await new NetworkCollector().finish(response(), page(jar, ""))).cookies).toBeNull();
    expect((await new NetworkCollector().finish(response(), page(jar, "not a url"))).cookies).toBeNull();
  });

  it("an untrusted jar (clearing failed) is never read", async () => {
    let read = false;
    const p: CookiePageLike = { url: () => "https://kit.test/login", cookies: async () => { read = true; return []; } };
    const ev = await new NetworkCollector().finish(response(), p, 3000, { cookiesTrusted: false });
    expect(read).toBe(false);
    expect(ev.cookies).toBeNull();
  });
});

describe("subset vs approximate (staff wording)", () => {
  it("approximate_fields lists every non-exact field; subset_fields says which of them are incomplete evidence rather than over-matchable", () => {
    const rule: IokRule = {
      id: "mix", title: "mix", tags: [],
      sel: { s: [[{ f: "html", op: "contains", v: ["K"] }, { f: "cookies", op: "startswith", v: ["sid="] }, { f: "title", op: "contains", v: ["T"] }]] },
      cond: { t: "ref", n: "s" },
    };
    const legacy = buildIokEvidence({ ...base, title: "T", html: "K", network: null });
    // No network evidence: html approximates, cookies has no data (so cannot match this rule at all).
    expect(evaluateIokRules({ rules: [rule] }, legacy).matches).toHaveLength(0);
    const fresh = buildIokEvidence({ ...base, title: "T", html: "x", network: inputOf({ rawHtml: "K", cookies: ["sid=1"], headers: [], headersComplete: true }) });
    const m = evaluateIokRules({ rules: [rule] }, fresh).matches[0]!;
    expect(m.approximate_fields).toEqual(["cookies", "title"]);
    expect(m.subset_fields).toEqual(["cookies", "title"]); // html is exact here
    const approxOnly: IokRule = { id: "a", title: "a", tags: [], sel: { s: [[{ f: "html", op: "contains", v: ["K"] }]] }, cond: { t: "ref", n: "s" } };
    const old = evaluateIokRules({ rules: [approxOnly] }, buildIokEvidence({ ...base, html: "K", network: null })).matches[0]!;
    expect(old).toMatchObject({ approximate_fields: ["html"], subset_fields: [] });
  });
});
