import { describe, it, expect } from "vitest";
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
