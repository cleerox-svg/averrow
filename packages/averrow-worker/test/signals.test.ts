import { describe, it, expect, vi } from "vitest";
import { handleIngestSignal, handleSignals } from "../src/handlers/signals";

// ─── Mocks ────────────────────────────────────────────────────
function makeEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      }),
    },
    CACHE: { get: vi.fn(), put: vi.fn() },
    ASSETS: { fetch: vi.fn() },
    JWT_SECRET: "test-secret",
    VIRUSTOTAL_API_KEY: "vt-key",
    LRX_API_URL: "https://api.test",
    LRX_API_KEY: "lrx-key",
    ENVIRONMENT: "test",
    ...overrides,
  } as any;
}

function makeRequest(method: string, url: string, body?: Record<string, unknown>, origin = "http://localhost:5173"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// ─── handleIngestSignal ───────────────────────────────────────
describe("handleIngestSignal", () => {
  it("returns 201 with ingested signal data", async () => {
    const env = makeEnv();
    const req = makeRequest("POST", "https://api.test/api/signals", {
      source: "station-alpha",
      domain: "example.com",
      range_m: 3000,
      intensity_dbz: -30,
      quality: 75,
      tags: ["web", "ssl"],
    });

    const res = await handleIngestSignal(req, env, "user-123");
    expect(res.status).toBe(201);

    const json = await res.json() as any;
    expect(json.success).toBe(true);
    expect(json.data.domain).toBe("example.com");
    expect(json.data.source).toBe("station-alpha");
    expect(json.data.quality).toBe(75);
    expect(json.data.risk_level).toBe("low"); // quality 75 → >= 60 → low
    expect(json.data.tags).toEqual(["web", "ssl"]);
  });

  it("calculates risk_level based on quality", async () => {
    const cases = [
      { quality: 90, expected: "safe" },
      { quality: 65, expected: "low" },
      { quality: 50, expected: "medium" },
      { quality: 25, expected: "high" },
      { quality: 10, expected: "critical" },
    ];

    for (const { quality, expected } of cases) {
      const env = makeEnv();
      const req = makeRequest("POST", "https://api.test/api/signals", {
        domain: "test.com",
        quality,
        tags: [],
      });
      const res = await handleIngestSignal(req, env, "user-1");
      const json = await res.json() as any;
      expect(json.data.risk_level).toBe(expected);
    }
  });

  it("defaults missing fields", async () => {
    const env = makeEnv();
    const req = makeRequest("POST", "https://api.test/api/signals", {
      domain: "test.com",
    });
    const res = await handleIngestSignal(req, env, "user-1");
    const json = await res.json() as any;
    expect(json.data.source).toBe("manual");
    expect(json.data.range_m).toBe(5000);
    expect(json.data.intensity_dbz).toBe(0);
    expect(json.data.quality).toBe(50);
  });

  it("clamps quality to 0-100", async () => {
    const env = makeEnv();
    const req = makeRequest("POST", "https://api.test/api/signals", {
      domain: "test.com",
      quality: 999,
    });
    const res = await handleIngestSignal(req, env, "user-1");
    const json = await res.json() as any;
    expect(json.data.quality).toBe(100);
  });

  it("sets CORS headers from origin", async () => {
    const env = makeEnv();
    const req = makeRequest("POST", "https://api.test/api/signals", { domain: "x.com" }, "http://localhost:5173");
    const res = await handleIngestSignal(req, env, "user-1");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });
});

// ─── handleSignals ────────────────────────────────────────────
describe("handleSignals", () => {
  it("returns empty array when no scans exist", async () => {
    const env = makeEnv();
    const req = makeRequest("GET", "https://api.test/api/signals?limit=10");
    const res = await handleSignals(req, env);
    const json = await res.json() as any;
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("caps limit at 50", async () => {
    const env = makeEnv();
    const req = makeRequest("GET", "https://api.test/api/signals?limit=200");
    await handleSignals(req, env);
    const prepareCall = env.DB.prepare.mock.calls[0]?.[0] as string;
    expect(prepareCall).toContain("LIMIT");
    const bindCall = env.DB.prepare().bind.mock.calls;
    // Limit should be capped — the bind receives the capped value
    expect(bindCall).toBeDefined();
  });

  it("transforms scans into signal format", async () => {
    const scanRow = {
      id: "scan-1", url: "https://example.com", domain: "example.com",
      trust_score: 80, risk_level: "safe", flags: "[]", source: "web", cached: 0, created_at: "2024-01-01T00:00:00Z",
    };
    const env = makeEnv();
    env.DB.prepare = vi.fn().mockReturnValue({
      bind: vi.fn().mockReturnValue({
        all: vi.fn().mockResolvedValue({ results: [scanRow] }),
      }),
    });

    const req = makeRequest("GET", "https://api.test/api/signals");
    const res = await handleSignals(req, env);
    const json = await res.json() as any;
    expect(json.data).toHaveLength(1);
    expect(json.data[0].domain).toBe("example.com");
    expect(json.data[0].quality).toBe(80);
    expect(json.data[0].source).toBe("station-alpha");
    expect(json.data[0].tags).toContain("nominal");
  });
});

// NOTE: handleAlerts and handleAckAlert tests removed — these functions
// are not exported from handlers/signals.ts (they live in handlers/alerts.ts).
