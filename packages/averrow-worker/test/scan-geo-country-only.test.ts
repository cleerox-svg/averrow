// PR-E (owner decision 2026-10-04: "Country only, from Cloudflare").
//
// handleScan used to geolocate the requester by sending their
// CF-Connecting-IP to ipapi.co (a third-party disclosure) and to store
// ip_address / lat / lng / geo_city on the `scans` row, which fed the
// staff /api/heatmap. Now:
//   1. no fetch to ipapi.co (or anywhere carrying the client IP);
//   2. the scans INSERT carries no IP, city or coordinates — country only,
//      read from `request.cf.country`;
//   3. 'XX' / 'T1' / missing cf → null country;
//   4. the /scan/:id share page has no "Scan Origin" row;
//   5. /api/heatmap is gone and 404s through the real router.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Router } from "itty-router";
import { handleScan, scanCountryFromRequest } from "../src/handlers/scan";
import { handleScanPage } from "../src/handlers/scanPage";
import { renderScanResult } from "../src/templates/scan-result";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { registerPublicRoutes } from "../src/routes/public";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

interface Stmt {
  sql: string;
  binds: unknown[];
}

interface DomainCacheRow {
  domain: string;
  trust_score: number;
  risk_level: string;
  flags: string;
  metadata: string;
}

const CLIENT_IP = "203.0.113.77";

function makeEnv(opts: { domainCache?: DomainCacheRow | null; scanRow?: Record<string, unknown> | null } = {}): {
  env: Env;
  stmts: Stmt[];
} {
  const stmts: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      const stmt: Stmt = { sql, binds: [] };
      stmts.push(stmt);
      const bound = {
        async first<T>(): Promise<T | null> {
          if (/FROM domain_cache/.test(sql)) return (opts.domainCache ?? null) as T | null;
          if (/FROM scans/.test(sql)) return (opts.scanRow ?? null) as T | null;
          return null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
      };
      return {
        bind(...args: unknown[]) {
          stmt.binds = args;
          return bound;
        },
        ...bound,
      };
    },
  };
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  return { env: { DB: db, CACHE: cache } as unknown as Env, stmts };
}

function scanRequest(cf?: Record<string, unknown>): Request {
  const req = new Request("https://averrow.com/api/scan/public", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": CLIENT_IP,
      "X-Forwarded-For": `${CLIENT_IP}, 10.0.0.1`,
    },
    body: JSON.stringify({ url: "https://example.com/login" }),
  });
  if (cf !== undefined) Object.defineProperty(req, "cf", { value: cf });
  return req;
}

function scanInsert(stmts: Stmt[]): Stmt {
  const insert = stmts.find((s) => /INSERT INTO scans/.test(s.sql));
  expect(insert).toBeDefined();
  return insert as Stmt;
}

function assertNoIpGeo(stmt: Stmt): void {
  for (const col of ["ip_address", "lat", "lng", "geo_city"]) {
    expect(stmt.sql).not.toMatch(new RegExp(`\\b${col}\\b`));
  }
  expect(stmt.binds).not.toContain(CLIENT_IP);
  // Columns and placeholders line up (literal `1` for cached is not a bind).
  const cols = /\(([^)]*)\)\s*VALUES/.exec(stmt.sql)?.[1]?.split(",").map((c) => c.trim()) ?? [];
  const values = /VALUES\s*\(([^)]*)\)/.exec(stmt.sql)?.[1]?.split(",").map((v) => v.trim()) ?? [];
  expect(cols.length).toBe(values.length);
  expect(values.filter((v) => v === "?").length).toBe(stmt.binds.length);
}

function bindFor(stmt: Stmt, column: string): unknown {
  const cols = /\(([^)]*)\)\s*VALUES/.exec(stmt.sql)?.[1]?.split(",").map((c) => c.trim()) ?? [];
  const values = /VALUES\s*\(([^)]*)\)/.exec(stmt.sql)?.[1]?.split(",").map((v) => v.trim()) ?? [];
  const idx = cols.indexOf(column);
  expect(idx).toBeGreaterThanOrEqual(0);
  const bindIdx = values.slice(0, idx).filter((v) => v === "?").length;
  return stmt.binds[bindIdx];
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchedUrls(): string[] {
  return fetchMock.mock.calls.map((c: unknown[]) => {
    const input = c[0];
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
    return String(input);
  });
}

describe("scanCountryFromRequest", () => {
  it("returns the uppercase code and English name from cf.country", () => {
    const c = scanCountryFromRequest(scanRequest({ country: "ca" }));
    expect(c.code).toBe("CA");
    expect(c.name).toBe("Canada");
  });

  for (const country of ["XX", "T1", "", "  ", "CAN", 42]) {
    it(`cf.country=${JSON.stringify(country)} → null`, () => {
      expect(scanCountryFromRequest(scanRequest({ country }))).toEqual({ code: null, name: null });
    });
  }

  it("missing cf → null", () => {
    expect(scanCountryFromRequest(scanRequest())).toEqual({ code: null, name: null });
  });
});

describe("handleScan — country only, no third-party IP disclosure", () => {
  it("fresh scan: no ipapi fetch, no IP/city/coords stored, country from cf", async () => {
    const { env, stmts } = makeEnv();
    const res = await handleScan(scanRequest({ country: "DE", city: "Berlin", latitude: "52.5", longitude: "13.4" }), env);
    expect(res.status).toBe(200);

    expect(fetchedUrls().some((u) => u.includes("ipapi"))).toBe(false);
    expect(fetchedUrls().some((u) => u.includes(CLIENT_IP))).toBe(false);
    // No `scans WHERE ip_address = ?` cache lookup any more.
    expect(stmts.some((s) => /FROM scans/.test(s.sql))).toBe(false);

    const insert = scanInsert(stmts);
    assertNoIpGeo(insert);
    expect(insert.binds).not.toContain("Berlin");
    expect(bindFor(insert, "geo_country_code")).toBe("DE");
    expect(bindFor(insert, "geo_country")).toBe("Germany");
  });

  it("cached-domain scan: same rules on the second INSERT", async () => {
    const { env, stmts } = makeEnv({
      domainCache: {
        domain: "example.com",
        trust_score: 90,
        risk_level: "safe",
        flags: "[]",
        metadata: "{}",
      },
    });
    const res = await handleScan(scanRequest({ country: "FR" }), env);
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; data: { cached: boolean } }>();
    expect(body.data.cached).toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    const insert = scanInsert(stmts);
    assertNoIpGeo(insert);
    expect(bindFor(insert, "geo_country_code")).toBe("FR");
    expect(bindFor(insert, "geo_country")).toBe("France");
  });

  for (const cf of [{ country: "XX" }, { country: "T1" }, undefined]) {
    it(`cf=${JSON.stringify(cf)} stores a null country`, async () => {
      const { env, stmts } = makeEnv();
      await handleScan(scanRequest(cf), env);
      const insert = scanInsert(stmts);
      assertNoIpGeo(insert);
      expect(bindFor(insert, "geo_country_code")).toBeNull();
      expect(bindFor(insert, "geo_country")).toBeNull();
      expect(fetchedUrls().some((u) => u.includes("ipapi"))).toBe(false);
    });
  }
});

describe("scan share page — no Scan Origin", () => {
  const record = {
    id: "scan_1",
    url: "https://example.com/login",
    domain: "example.com",
    trust_score: 72,
    risk_level: "low",
    flags: [],
    metadata: {},
    cached: 0,
    created_at: "2026-10-04T00:00:00Z",
  };

  it("renderScanResult has no Scan Origin row", () => {
    expect(renderScanResult(record)).not.toContain("Scan Origin");
  });

  it("handleScanPage selects no geo columns and renders no Scan Origin", async () => {
    const { env, stmts } = makeEnv({
      scanRow: { ...record, flags: "[]", metadata: "{}", geo_city: "Berlin", geo_country: "Germany" },
    });
    const res = await handleScanPage(new Request("https://averrow.com/scan/scan_1"), env, "scan_1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Scan Origin");
    expect(html).not.toContain("Berlin");
    const select = stmts.find((s) => /FROM scans/.test(s.sql));
    expect(select?.sql).not.toMatch(/geo_city|geo_country|ip_address|\blat\b|\blng\b/);
  });
});

describe("/api/heatmap — removed", () => {
  const SECRET = "test-secret-scan-geo-country-only";

  function routerEnv(): Env {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              async first<T>() {
                return { status: "active" } as unknown as T;
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    };
    const cache = { async get() { return null; }, async put() {} };
    return { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env;
  }

  for (const role of [null, "client", "analyst", "super_admin"] as Array<UserRole | null>) {
    for (const path of ["/api/heatmap", "/api/heatmap?hours=24&filter=phishing"]) {
      it(`GET ${path} as ${role ?? "anonymous"} → 404 via the /api/* catch-all`, async () => {
        const router = Router();
        registerDashboardRoutes(router);
        registerPublicRoutes(router);
        const headers: Record<string, string> = {};
        if (role) {
          headers.Authorization = `Bearer ${await signJWT(
            { sub: `user_${role}`, email: `${role}@averrow.local`, role },
            SECRET,
            300,
          )}`;
        }
        const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
        const res = (await router.fetch(
          new Request(`https://averrow.com${path}`, { method: "GET", headers }),
          routerEnv(),
          ctx,
        )) as Response;
        expect(res.status).toBe(404);
        const body = await res.json<{ success: boolean; error: string }>();
        expect(body).toEqual({ success: false, error: "Not found" });
      });
    }
  }
});
