import { describe, it, expect, vi } from "vitest";
import {
  pageFetchHostStaticBlockReason,
  resolvedIpBlockReason,
} from "../src/lib/url-guard";
import {
  fetchSuspectPage,
  assertResolvedHostSafe,
  followToFinalResponse,
  enforceResponseLimits,
  extractJsRedirectTargets,
  type FetchDeps,
} from "../src/lib/page-fetch";

// ─── Test helpers ─────────────────────────────────────────────────

function htmlResponse(body: string, init: { status?: number; contentLength?: number } = {}): Response {
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
  if (init.contentLength !== undefined) headers["content-length"] = String(init.contentLength);
  return new Response(body, { status: init.status ?? 200, headers });
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** Deps whose resolver maps host→IPs and fetcher maps URL→Response. */
function makeDeps(opts: {
  resolve?: (host: string) => string[];
  fetch?: (url: string) => Response;
}): { deps: FetchDeps; fetchSpy: ReturnType<typeof vi.fn>; resolveSpy: ReturnType<typeof vi.fn> } {
  const resolveSpy = vi.fn(async (host: string) => (opts.resolve ? opts.resolve(host) : ["93.184.216.34"]));
  const fetchSpy = vi.fn(async (url: string) => {
    if (opts.fetch) return opts.fetch(url);
    return htmlResponse("<html></html>");
  });
  return { deps: { resolve: resolveSpy, fetchImpl: fetchSpy }, fetchSpy, resolveSpy };
}

// ─── url-guard block helpers (reused, not re-implemented) ─────────

describe("url-guard page-fetch block helpers", () => {
  it("resolvedIpBlockReason blocks the cloud metadata address", () => {
    expect(resolvedIpBlockReason("169.254.169.254")).not.toBeNull();
  });
  it("resolvedIpBlockReason blocks private + loopback + CGNAT ranges", () => {
    expect(resolvedIpBlockReason("10.0.0.5")).not.toBeNull();
    expect(resolvedIpBlockReason("127.0.0.1")).not.toBeNull();
    expect(resolvedIpBlockReason("192.168.1.1")).not.toBeNull();
    expect(resolvedIpBlockReason("172.16.0.1")).not.toBeNull();
    expect(resolvedIpBlockReason("100.64.0.1")).not.toBeNull();
    expect(resolvedIpBlockReason("::1")).not.toBeNull();
    expect(resolvedIpBlockReason("fd00::1")).not.toBeNull();
    expect(resolvedIpBlockReason("::ffff:10.0.0.1")).not.toBeNull();
  });
  it("resolvedIpBlockReason allows a public IP", () => {
    expect(resolvedIpBlockReason("93.184.216.34")).toBeNull();
  });
  it("pageFetchHostStaticBlockReason rejects IP-literal + localhost + internal suffixes", () => {
    expect(pageFetchHostStaticBlockReason("127.0.0.1")).not.toBeNull();
    expect(pageFetchHostStaticBlockReason("169.254.169.254")).not.toBeNull();
    expect(pageFetchHostStaticBlockReason("localhost")).not.toBeNull();
    expect(pageFetchHostStaticBlockReason("foo.local")).not.toBeNull();
    expect(pageFetchHostStaticBlockReason("svc.internal")).not.toBeNull();
    expect(pageFetchHostStaticBlockReason("x.workers.dev")).not.toBeNull();
    expect(pageFetchHostStaticBlockReason("averrow.com")).not.toBeNull();
  });
  it("pageFetchHostStaticBlockReason allows a normal public hostname", () => {
    expect(pageFetchHostStaticBlockReason("acme-secure-login.com")).toBeNull();
  });
});

// ─── Resolve-then-validate (DNS rebinding) ────────────────────────

describe("assertResolvedHostSafe — DNS-rebinding defense", () => {
  it("blocks a public hostname that resolves to the metadata IP", async () => {
    const { deps } = makeDeps({ resolve: () => ["169.254.169.254"] });
    const r = await assertResolvedHostSafe("evil.example", deps, new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked).toBe(true);
  });

  it("blocks when ANY of several resolved IPs is private", async () => {
    const { deps } = makeDeps({ resolve: () => ["93.184.216.34", "10.0.0.9"] });
    const r = await assertResolvedHostSafe("evil.example", deps, new Map());
    expect(r.ok).toBe(false);
  });

  it("fails closed on an unresolvable host (never fetched)", async () => {
    const { deps } = makeDeps({ resolve: () => [] });
    const r = await assertResolvedHostSafe("nx.example", deps, new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked).toBe(false); // transient, not a hard block
  });

  it("allows a host resolving only to public IPs", async () => {
    const { deps } = makeDeps({ resolve: () => ["93.184.216.34"] });
    const r = await assertResolvedHostSafe("acme-secure.com", deps, new Map());
    expect(r.ok).toBe(true);
  });
});

// ─── Redirect handling ────────────────────────────────────────────

describe("followToFinalResponse — redirects", () => {
  it("rejects a disallowed-scheme start URL", async () => {
    const { deps } = makeDeps({});
    const r = await followToFinalResponse(new URL("ftp://x/"), deps, Date.now() + 5000, new Map());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blocked).toBe(true);
      expect(r.reason).toContain("disallowed_scheme");
    }
  });

  it("rejects when redirects exceed the hop limit", async () => {
    const { deps } = makeDeps({ fetch: () => redirectResponse("https://acme-secure.com/next") });
    const r = await followToFinalResponse(
      new URL("https://acme-secure.com/"), deps, Date.now() + 5000, new Map(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_redirects");
  });

  it("blocks a redirect that points at a private-resolving host", async () => {
    const resolve = (host: string) => (host === "acme-secure.com" ? ["93.184.216.34"] : ["10.0.0.5"]);
    const { deps } = makeDeps({
      resolve,
      fetch: (url) => (url.includes("acme-secure.com") ? redirectResponse("https://internal.evil/") : htmlResponse("<html></html>")),
    });
    const r = await followToFinalResponse(
      new URL("https://acme-secure.com/"), deps, Date.now() + 5000, new Map(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blocked).toBe(true);
  });

  it("returns the final non-redirect response after one hop", async () => {
    let call = 0;
    const { deps } = makeDeps({
      fetch: () => (call++ === 0 ? redirectResponse("https://acme-secure.com/final") : htmlResponse("<html>ok</html>")),
    });
    const r = await followToFinalResponse(
      new URL("https://acme-secure.com/"), deps, Date.now() + 5000, new Map(),
    );
    expect(r.ok).toBe(true);
  });
});

// ─── Size cap + content-type gate ─────────────────────────────────

describe("enforceResponseLimits — size + content-type", () => {
  it("rejects a non-html content-type", async () => {
    const res = new Response("plain", { headers: { "content-type": "text/plain" } });
    const r = await enforceResponseLimits(res, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non_html_content_type");
  });

  it("rejects a declared-oversize response without streaming it", async () => {
    const res = htmlResponse("<html></html>", { contentLength: 10_000_000 });
    const r = await enforceResponseLimits(res, 512 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("oversize_declared");
  });

  it("rejects a streamed body that exceeds the cap", async () => {
    const res = htmlResponse("x".repeat(50));
    const r = await enforceResponseLimits(res, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("oversize");
  });

  it("accepts an html body under the cap", async () => {
    const res = htmlResponse("<html><body>hi</body></html>");
    const r = await enforceResponseLimits(res, 512 * 1024);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.length).toBeGreaterThan(0);
  });
});

// ─── fetchSuspectPage orchestration (rejection paths) ─────────────

describe("fetchSuspectPage — SSRF rejections", () => {
  it("blocks an IP-literal host at the static gate before any I/O", async () => {
    const { deps, fetchSpy, resolveSpy } = makeDeps({});
    const r = await fetchSuspectPage("127.0.0.1", { deps });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("blocks a DNS-rebinding host (public name → metadata IP) without fetching the page", async () => {
    const { deps, fetchSpy } = makeDeps({ resolve: () => ["169.254.169.254"] });
    const r = await fetchSuspectPage("phish.example", { deps });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
    // The page itself is never fetched.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("phish.example");
    }
  });

  it("blocks a redirect to a disallowed scheme", async () => {
    const { deps } = makeDeps({ fetch: () => redirectResponse("ftp://evil/") });
    const r = await fetchSuspectPage("acme-secure.com", { deps });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it("rejects (not blocked) a non-html page", async () => {
    const { deps } = makeDeps({
      fetch: () => new Response("nope", { status: 200, headers: { "content-type": "application/json" } }),
    });
    const r = await fetchSuspectPage("acme-secure.com", { deps });
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toBe("non_html_content_type");
    expect(r.httpStatus).toBe(200);
  });

  it("rejects an oversize declared page", async () => {
    const { deps } = makeDeps({ fetch: () => htmlResponse("<html></html>", { contentLength: 5_000_000 }) });
    const r = await fetchSuspectPage("acme-secure.com", { deps });
    expect(r.ok).toBe(false);
    expect(r.rejectedReason).toBe("oversize_declared");
  });
});

// ─── JS redirect extraction (no catastrophic backtracking) ────────

describe("extractJsRedirectTargets", () => {
  it("pulls a location.href assignment target", () => {
    expect(extractJsRedirectTargets(`window.location.href = "https://acme.com/verify";`))
      .toContain("https://acme.com/verify");
  });
  it("pulls a location.replace() target", () => {
    expect(extractJsRedirectTargets(`location.replace('https://acme.com/x')`))
      .toContain("https://acme.com/x");
  });
  it("returns empty for script with no redirect", () => {
    expect(extractJsRedirectTargets(`console.log("hello world")`)).toEqual([]);
  });
});
