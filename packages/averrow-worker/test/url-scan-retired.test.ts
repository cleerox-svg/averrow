// URL-scan feature retired (owner decision 2026-10-04).
//
// Prod D1 never had a `scans` or `domain_cache` table (no migration ever
// created them), so every URL-scan write and read failed in prod. The only
// client was the frozen legacy SPA. Removed:
//   - POST /api/scan, POST /api/scan/public, GET /api/scan/history
//   - the /scan/:id share page
//   - GET /api/signals (a list of `scans` rows; POST /api/signals stays)
//   - /api/dashboard/stats|sources|trend (v1 `scans` aggregates)
//   - /api/export/scans, /api/export/signals (`scans` exports)
//   - the `url_scan` sync agent
// Kept: /api/scan/report, the /scan brand-scan landing page, the brand-scan
// routes, /api/export/alerts (signal_alerts only — its `scans` fallback is
// gone), and the Sparrow `url_scan_results` takedown source (a different
// feature that shares the name).
//
// Also carries the /api/heatmap 404 pins that used to live in
// test/scan-geo-country-only.test.ts (PR-E).
//
// Drives the REAL routers in index.ts order (scan → dashboard → export →
// public, whose `router.all("*")` is the catch-all).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerScanRoutes } from "../src/routes/scan";
import { registerDashboardRoutes } from "../src/routes/dashboard";
import { registerExportRoutes } from "../src/routes/export";
import { registerPublicRoutes } from "../src/routes/public";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

const SECRET = "test-secret-url-scan-retired";
const SRC = resolve(__dirname, "../src");

interface Stub {
  env: Env;
  sqls: string[];
  assetPaths: string[];
}

function makeEnv(): Stub {
  const sqls: string[] = [];
  const assetPaths: string[] = [];
  const bound = {
    // requireAuth: the user must be active.
    async first<T>() {
      return { status: "active" } as unknown as T;
    },
    async run() {
      return { success: true };
    },
    async all<T>() {
      return { results: [] as T[] };
    },
  };
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      return { bind: () => bound, ...bound };
    },
  };
  const cache = { async get() { return null; }, async put() {} };
  // wrangler.toml: [assets] not_found_handling = "404-page" — a missing
  // file comes back as a 404.
  const assets = {
    async fetch(input: Request | string) {
      const url = typeof input === "string" ? input : input.url;
      assetPaths.push(new URL(url).pathname);
      return new Response("asset 404", { status: 404, headers: { "Content-Type": "text/html" } });
    },
  };
  return {
    env: { JWT_SECRET: SECRET, DB: db, CACHE: cache, ASSETS: assets } as unknown as Env,
    sqls,
    assetPaths,
  };
}

function makeRouter(): RouterType<IRequest> {
  const router = Router();
  registerScanRoutes(router);
  registerDashboardRoutes(router);
  registerExportRoutes(router);
  registerPublicRoutes(router);
  return router;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(
  method: string,
  path: string,
  role: UserRole | null,
  stub: Stub,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (role) {
    headers.Authorization = `Bearer ${await signJWT(
      { sub: `user_${role}`, email: `${role}@averrow.local`, role },
      SECRET,
      300,
    )}`;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`https://averrow.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = (await makeRouter().fetch(req, stub.env, ctx)) as Response | undefined;
  if (!res) throw new Error(`${method} ${path}: no route matched`);
  return res;
}

const ROLES: Array<UserRole | null> = [null, "client", "analyst", "auditor", "super_admin"];

const REMOVED_API: Array<[string, string]> = [
  ["POST", "/api/scan"],
  ["POST", "/api/scan/public"],
  ["GET", "/api/scan/history"],
  ["GET", "/api/signals"],
  ["GET", "/api/signals?limit=10"],
  ["GET", "/api/dashboard/stats"],
  ["GET", "/api/dashboard/sources"],
  ["GET", "/api/dashboard/trend"],
  ["GET", "/api/export/scans"],
  ["GET", "/api/export/signals"],
  ["GET", "/api/heatmap"],
  ["GET", "/api/heatmap?hours=24&filter=phishing"],
];

// Case-sensitive SQL keywords so prose ("full-table scans") doesn't match.
const SCANS_SQL = /\b(FROM|INTO|JOIN|UPDATE|TABLE)\s+(scans|domain_cache)\b/;

describe("retired URL-scan API routes 404 via the /api/* catch-all", () => {
  for (const [method, path] of REMOVED_API) {
    for (const role of ROLES) {
      it(`${method} ${path} as ${role ?? "anonymous"} → 404`, async () => {
        const stub = makeEnv();
        const res = await call(
          method,
          path,
          role,
          stub,
          method === "POST" ? { url: "https://example.com/login" } : undefined,
        );
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ success: false, error: "Not found" });
        expect(stub.sqls.some((s) => SCANS_SQL.test(s))).toBe(false);
      });
    }
  }
});

describe("/scan/:id share page is gone", () => {
  for (const role of [null, "super_admin"] as Array<UserRole | null>) {
    it(`GET /scan/scan_123 as ${role ?? "anonymous"} → branded 404, never the share page`, async () => {
      const stub = makeEnv();
      const res = await call("GET", "/scan/scan_123", role, stub);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type") ?? "").toContain("text/html");
      // Fell through to ASSETS (the catch-all), and never queried D1.
      expect(stub.assetPaths).toContain("/scan/scan_123");
      expect(stub.sqls.some((s) => SCANS_SQL.test(s))).toBe(false);
    });
  }

  it("the share-page handler and template no longer exist", () => {
    expect(existsSync(join(SRC, "handlers/scanPage.ts"))).toBe(false);
    expect(existsSync(join(SRC, "templates/scan-result.ts"))).toBe(false);
    expect(existsSync(join(SRC, "handlers/scan.ts"))).toBe(false);
  });
});

describe("kept routes still respond", () => {
  it("POST /api/scan/report is still routed (not the 404 catch-all)", async () => {
    const stub = makeEnv();
    const res = await call("POST", "/api/scan/report", null, stub, {});
    const body = (await res.clone().json().catch(() => null)) as { error?: string } | null;
    expect(body?.error).not.toBe("Not found");
  });

  it("GET /api/export/alerts (staff) responds from signal_alerts without querying scans", async () => {
    const stub = makeEnv();
    const res = await call("GET", "/api/export/alerts", "analyst", stub);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(stub.sqls.some((s) => /FROM signal_alerts/.test(s))).toBe(true);
    expect(stub.sqls.some((s) => SCANS_SQL.test(s))).toBe(false);
  });

  it("GET /api/export/alerts still 401s anonymous", async () => {
    const res = await call("GET", "/api/export/alerts", null, makeEnv());
    expect(res.status).toBe(401);
  });

  it("POST /api/signals (manual ingestion) is still routed and staff-gated", async () => {
    const res = await call("POST", "/api/signals", null, makeEnv(), { domain: "x.com" });
    expect(res.status).toBe(401);
  });
});

describe("url_scan agent removed", () => {
  it("agentModules has no url_scan entry and the module file is gone", async () => {
    const { agentModules } = await import("../src/agents");
    expect(Object.keys(agentModules)).not.toContain("url_scan");
    expect(existsSync(join(SRC, "agents/url-scan.ts"))).toBe(false);
  });
});

describe("source pin: nothing in src reads or writes scans / domain_cache", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|js|mjs)$/.test(name) ? [p] : [];
    });
  }

  it("no SQL mentions FROM/INTO/JOIN/UPDATE scans or domain_cache", () => {
    // Comment lines are skipped: prose like "the JOIN scans ~14 days of
    // rows" (threatActors.ts) is about query cost, not the `scans` table.
    const offenders = walk(SRC).flatMap((f) =>
      readFileSync(f, "utf-8")
        .split("\n")
        .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && SCANS_SQL.test(line))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
