import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySecurityHeaders } from "../src/middleware/security";

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

  it("allows exactly challenges.cloudflare.com for Turnstile in script/frame/connect-src", () => {
    const csp = applySecurityHeaders(makeResponse()).headers.get("Content-Security-Policy")!;
    for (const name of ["script-src", "connect-src"]) {
      expect(directive(csp, name).split(/\s+/)).toContain("https://challenges.cloudflare.com");
    }
    expect(directive(csp, "frame-src")).toBe("frame-src https://challenges.cloudflare.com");
    expect(csp).not.toMatch(/https:\/\/\*\.cloudflare\.com/);
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
  });

  it("static-asset CSP (public/_headers) matches the Worker CSP", () => {
    // Static pages such as /scan/ are served by ASSETS before the Worker
    // runs, so they get the _headers policy, not applySecurityHeaders.
    const headersFile = readFileSync(join(__dirname, "../public/_headers"), "utf8");
    const line = headersFile.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"))!;
    const fileCsp = line.trim().slice("Content-Security-Policy:".length).trim();
    const workerCsp = applySecurityHeaders(makeResponse()).headers.get("Content-Security-Policy");
    expect(fileCsp).toBe(workerCsp);
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
