import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySecurityHeaders, buildContentSecurityPolicy, cspAllowsTurnstile } from "../src/middleware/security";

describe("applySecurityHeaders", () => {
  function makeResponse(body = "ok", status = 200) {
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }

  it("adds X-Frame-Options: DENY", () => {
    const res = applySecurityHeaders(makeResponse());
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("adds X-Content-Type-Options: nosniff", () => {
    const res = applySecurityHeaders(makeResponse());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("adds X-XSS-Protection", () => {
    const res = applySecurityHeaders(makeResponse());
    expect(res.headers.get("X-XSS-Protection")).toBe("1; mode=block");
  });

  it("adds Strict-Transport-Security", () => {
    const res = applySecurityHeaders(makeResponse());
    const hsts = res.headers.get("Strict-Transport-Security");
    expect(hsts).toContain("max-age=31536000");
    expect(hsts).toContain("includeSubDomains");
  });

  it("adds Content-Security-Policy", () => {
    const res = applySecurityHeaders(makeResponse());
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  // Cloudflare Turnstile on the free scan (/scan): script, iframe and
  // siteverify-adjacent calls come from challenges.cloudflare.com only.
  const directive = (csp: string, name: string) =>
    csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

  it("allows exactly challenges.cloudflare.com for Turnstile in script/frame/connect-src on scan paths", () => {
    for (const path of ["/", "/scan", "/scan/", "/assess", "/assess/abc/results"]) {
      const csp = applySecurityHeaders(makeResponse(), path).headers.get("Content-Security-Policy")!;
      for (const name of ["script-src", "connect-src"]) {
        expect(directive(csp, name).split(/\s+/)).toContain("https://challenges.cloudflare.com");
      }
      expect(directive(csp, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
      expect(csp).not.toMatch(/https:\/\/\*\.cloudflare\.com/);
      expect(directive(csp, "default-src")).toBe("default-src 'self'");
    }
  });

  it("scopes Turnstile sources to the scan paths only (appsec L1)", () => {
    for (const path of [undefined, "/api/brand-scan/public", "/ops/", "/scanner", "/assessment", "/legacy"]) {
      const csp = applySecurityHeaders(makeResponse(), path).headers.get("Content-Security-Policy")!;
      expect(csp).not.toContain("challenges.cloudflare.com");
      expect(directive(csp, "frame-src")).toBe("");
      expect(cspAllowsTurnstile(path)).toBe(false);
    }
  });

  it("static-asset CSP (public/_headers) matches the Worker CSP for the scan pages", () => {
    // Static pages such as / and /scan/ are served by ASSETS before the
    // Worker runs, so they get the _headers policy, not applySecurityHeaders.
    // _headers can't widen CSP per path (duplicate headers are comma-joined
    // into a second, intersecting policy), so it carries the scan-page
    // policy site-wide.
    const headersFile = readFileSync(join(__dirname, "../public/_headers"), "utf8");
    const line = headersFile.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"))!;
    const fileCsp = line.trim().slice("Content-Security-Policy:".length).trim();
    expect(fileCsp).toBe(buildContentSecurityPolicy("/scan/"));
  });

  it("never allows a public JS CDN as a script or style source", () => {
    // A shared CDN in script-src lets injected markup load any package's
    // code from it; nothing on the platform loads from these hosts.
    for (const path of [undefined, "/", "/scan/", "/ops/", "/tenant/", "/status"]) {
      const csp = buildContentSecurityPolicy(path);
      for (const host of ["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com"]) {
        expect(directive(csp, "script-src")).not.toContain(host);
        expect(directive(csp, "style-src")).not.toContain(host);
      }
    }
  });

  it("pins script-src to an exact allowlist", () => {
    // Positive allowlist: any new script source must be added here on
    // purpose, not slipped into the policy.
    expect(directive(buildContentSecurityPolicy("/ops/"), "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
    );
    expect(directive(buildContentSecurityPolicy("/scan/"), "script-src")).toBe(
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
    );
  });

  it("allows no scheme-wide connect source and no plugins", () => {
    const csp = buildContentSecurityPolicy("/ops/");
    expect(directive(csp, "connect-src").split(" ")).not.toContain("wss:");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
  });

  it("adds Referrer-Policy", () => {
    const res = applySecurityHeaders(makeResponse());
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("adds Permissions-Policy", () => {
    const res = applySecurityHeaders(makeResponse());
    const pp = res.headers.get("Permissions-Policy");
    expect(pp).toContain("camera=()");
    expect(pp).toContain("microphone=()");
  });

  it("preserves original status code", () => {
    const res = applySecurityHeaders(makeResponse("not found", 404));
    expect(res.status).toBe(404);
  });

  it("preserves original Content-Type", () => {
    const res = applySecurityHeaders(makeResponse());
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves original body", async () => {
    const res = applySecurityHeaders(makeResponse("test-body"));
    const body = await res.text();
    expect(body).toBe("test-body");
  });
});
