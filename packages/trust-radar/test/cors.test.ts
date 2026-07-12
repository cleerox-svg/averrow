import { describe, it, expect } from "vitest";
import { corsHeaders, handleOptions, json } from "../src/lib/cors";

const DEV_ENV = { ENVIRONMENT: "development" };
const TEST_ENV = { ENVIRONMENT: "test" };
const STAGING_ENV = { ENVIRONMENT: "staging" };
const PROD_ENV = { ENVIRONMENT: "production" };

describe("corsHeaders", () => {
  it("returns a production origin when it is in the whitelist", () => {
    const headers = corsHeaders("https://averrow.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://averrow.com");
  });

  it("defaults to first allowed origin for unknown origins", () => {
    const headers = corsHeaders("https://evil.com");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://averrow.com");
  });

  it("defaults to first allowed origin for null origin", () => {
    const headers = corsHeaders(null);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://averrow.com");
  });

  it("includes required CORS methods", () => {
    const headers = corsHeaders(null);
    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
  });

  it("includes Authorization in allowed headers", () => {
    const headers = corsHeaders(null);
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
  });

  describe("localhost origin env-gating (F2 hardening — allowlist)", () => {
    it("allows localhost origins in an allowlisted dev/test environment", () => {
      expect(corsHeaders("http://localhost:5173", DEV_ENV)["Access-Control-Allow-Origin"])
        .toBe("http://localhost:5173");
      expect(corsHeaders("http://localhost:3000", DEV_ENV)["Access-Control-Allow-Origin"])
        .toBe("http://localhost:3000");
      expect(corsHeaders("http://localhost:5173", TEST_ENV)["Access-Control-Allow-Origin"])
        .toBe("http://localhost:5173");
      expect(corsHeaders("http://localhost:3000", TEST_ENV)["Access-Control-Allow-Origin"])
        .toBe("http://localhost:3000");
    });

    it("does NOT reflect localhost origins on staging (public domain, shared prod D1)", () => {
      expect(corsHeaders("http://localhost:5173", STAGING_ENV)["Access-Control-Allow-Origin"])
        .toBe("https://averrow.com");
      expect(corsHeaders("http://localhost:3000", STAGING_ENV)["Access-Control-Allow-Origin"])
        .toBe("https://averrow.com");
    });

    it("does NOT reflect localhost origins in production (falls back to prod origin)", () => {
      expect(corsHeaders("http://localhost:5173", PROD_ENV)["Access-Control-Allow-Origin"])
        .toBe("https://averrow.com");
      expect(corsHeaders("http://localhost:3000", PROD_ENV)["Access-Control-Allow-Origin"])
        .toBe("https://averrow.com");
    });

    it("does NOT reflect localhost for an unrecognized environment value", () => {
      expect(corsHeaders("http://localhost:5173", { ENVIRONMENT: "preview" })["Access-Control-Allow-Origin"])
        .toBe("https://averrow.com");
    });

    it("defaults to the production (no-localhost) whitelist when env is omitted", () => {
      expect(corsHeaders("http://localhost:5173")["Access-Control-Allow-Origin"])
        .toBe("https://averrow.com");
    });

    it("still allows production origins in an allowlisted dev/test environment", () => {
      expect(corsHeaders("https://averrow.com", DEV_ENV)["Access-Control-Allow-Origin"])
        .toBe("https://averrow.com");
    });
  });
});

describe("handleOptions", () => {
  it("returns 204 with CORS headers", () => {
    const req = new Request("https://api.test/api/signals", {
      method: "OPTIONS",
      headers: { Origin: "https://averrow.com" },
    });
    const res = handleOptions(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://averrow.com");
  });

  it("reflects localhost preflight only in a non-production environment", () => {
    const req = new Request("https://api.test/api/signals", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    expect(handleOptions(req, DEV_ENV).headers.get("Access-Control-Allow-Origin"))
      .toBe("http://localhost:5173");
    expect(handleOptions(req, PROD_ENV).headers.get("Access-Control-Allow-Origin"))
      .toBe("https://averrow.com");
  });
});

describe("json helper", () => {
  it("returns JSON response with correct status", async () => {
    const res = json({ success: true, data: "test" }, 201, "https://averrow.com");
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json() as { data: string };
    expect(body.data).toBe("test");
  });

  it("defaults to status 200", async () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
  });

  it("gates localhost origin on env like corsHeaders", () => {
    expect(json({ ok: true }, 200, "http://localhost:5173", DEV_ENV).headers.get("Access-Control-Allow-Origin"))
      .toBe("http://localhost:5173");
    expect(json({ ok: true }, 200, "http://localhost:5173", PROD_ENV).headers.get("Access-Control-Allow-Origin"))
      .toBe("https://averrow.com");
  });
});
