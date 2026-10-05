// Stored XSS + detection-oracle fix for the public brand scan
// (2026-10-05).
//
//   1. POST /assess, POST /api/brand-scan/public and POST /api/leads reject
//      a domain that is not a strict hostname, with no DB write.
//   2. The public scan JSON carries no feed-mention flag, and the public
//      result lookup never selects feed_mentions.
//   (The Worker-rendered /assess results page and /scan page were retired
//   2026-10-05; results render on the Astro /scan page.)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerScanRoutes } from "../src/routes/scan";
import { registerPublicRoutes } from "../src/routes/public";
import {
  handlePublicBrandScan, handlePublicBrandScanResult, handleLeadCapture,
} from "../src/handlers/brandScan";
import { renderHomepage } from "../src/templates/homepage";
import type { Env } from "../src/types";

const MALICIOUS = "<img src=x onerror=alert(1)>.com";

interface Stub {
  env: Env;
  sqls: string[];
  binds: unknown[][];
}

/** D1 stub: records SQL + binds; SELECTs on threats return `feedRows`. */
function makeEnv(feedRows: Array<Record<string, unknown>> = [], firstRow: unknown = null): Stub {
  const sqls: string[] = [];
  const binds: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      sqls.push(sql);
      const stmt = {
        bind: (...args: unknown[]) => { binds.push(args); return stmt; },
        async first<T>() { return firstRow as T; },
        async run() { return { success: true, meta: { changes: 1 } }; },
        async all<T>() {
          return { results: (/FROM threats/.test(sql) ? feedRows : []) as T[] };
        },
      };
      return stmt;
    },
  };
  const cache = { async get() { return null; }, async put() {} };
  return { env: { DB: db, CACHE: cache } as unknown as Env, sqls, binds };
}

function jsonReq(path: string, body: unknown): Request {
  return new Request(`https://averrow.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const writes = (s: Stub) => s.sqls.filter((q) => /^\s*INSERT|^\s*UPDATE/i.test(q));

beforeEach(() => {
  // checkDNS → DNS-over-HTTPS. Empty answers; no network in tests.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/brand-scan/public (handlePublicBrandScan)", () => {
  it.each([MALICIOUS, "a b.com", 'x".com', "nodot", "<script>alert(1)</script>.com"])(
    "rejects %j with 400 and writes nothing",
    async (domain) => {
      const s = makeEnv();
      const res = await handlePublicBrandScan(jsonReq("/api/brand-scan/public", { domain }), s.env);
      expect(res.status).toBe(400);
      expect(s.sqls).toEqual([]);
    },
  );

  it("rejects a non-string domain and a malformed body with 400", async () => {
    const s = makeEnv();
    expect((await handlePublicBrandScan(jsonReq("/x", { domain: ["a.com"] }), s.env)).status).toBe(400);
    const bad = new Request("https://averrow.com/x", { method: "POST", body: "{not json" });
    expect((await handlePublicBrandScan(bad, s.env)).status).toBe(400);
    expect(s.sqls).toEqual([]);
  });

  it("stores the normalised hostname and returns no feed-mention flag even when the domain is in threat data", async () => {
    const feedRows = [{ id: "t1", threat_type: "phishing", severity: "high", source_feed: "x", created_at: "2026-10-01" }];
    const s = makeEnv(feedRows);
    const res = await handlePublicBrandScan(
      jsonReq("/api/brand-scan/public", { domain: "HTTPS://Acme.Example/login" }), s.env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data.domain).toBe("acme.example");
    expect(Object.keys(body.data).sort()).toEqual(["checked_at", "domain", "email", "id", "lookalikes"]);
    expect(JSON.stringify(body)).not.toMatch(/feed/i);

    // The staff-side count is still stored on the row.
    const insertIdx = s.sqls.findIndex((q) => /INSERT INTO brand_scans/.test(q));
    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(s.sqls[insertIdx]).toContain("feed_mentions");
    const insertBinds = s.binds.find((b) => b.includes("acme.example") && b.includes(1));
    expect(insertBinds).toBeDefined();
  });
});

describe("GET /api/brand-scan/public/:id (handlePublicBrandScanResult)", () => {
  it("404s a legacy row with no public view, and a non-UUID id without a query", async () => {
    const id = "0b7d6f9e-1c2a-4b3c-8d4e-5f6a7b8c9d0e";
    const s = makeEnv([], { id, domain: "acme.example", public_view: null });
    const res = await handlePublicBrandScanResult(new Request(`https://averrow.com/api/brand-scan/public/${id}`), s.env, id);
    expect(res.status).toBe(404);
    const s2 = makeEnv();
    const res2 = await handlePublicBrandScanResult(new Request("https://averrow.com/x"), s2.env, "</script>");
    expect(res2.status).toBe(404);
    expect(s2.sqls).toEqual([]);
  });
});

describe("POST /api/leads (handleLeadCapture)", () => {
  const lead = { email: "pat@other.example", consent: true };

  it("rejects a malicious domain with 400 and writes nothing", async () => {
    const s = makeEnv();
    const res = await handleLeadCapture(jsonReq("/api/leads", { ...lead, domain: MALICIOUS }), s.env);
    expect(res.status).toBe(400);
    expect(writes(s)).toEqual([]);
  });

  it("stores the normalised domain when valid, and rejects a missing domain", async () => {
    const s = makeEnv();
    const res = await handleLeadCapture(jsonReq("/api/leads", { ...lead, domain: " https://Acme.Example/ " }), s.env);
    expect(res.status).toBe(200);
    const insert = s.binds.find((b) => b.includes("pat@other.example"));
    expect(insert).toContain("acme.example");

    const s2 = makeEnv();
    expect((await handleLeadCapture(jsonReq("/api/leads", lead), s2.env)).status).toBe(400);
    expect(writes(s2)).toEqual([]);
  });
});

describe("POST /assess (form route)", () => {
  function router(): RouterType<IRequest> {
    const r = Router();
    registerScanRoutes(r);
    registerPublicRoutes(r);
    return r;
  }
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  it("redirects home with no scan and no DB write for a malicious domain", async () => {
    const s = makeEnv();
    const req = new Request("https://averrow.com/assess", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ domain: MALICIOUS }).toString(),
    });
    const res = (await router().fetch(req, s.env, ctx)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://averrow.com/");
    expect(s.sqls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("homepage widget template", () => {
  it("homepage scan widget escapes the domain and error text, and drops the feed pill", () => {
    const html = renderHomepage();
    expect(html).not.toContain("feedMentions");
    expect(html).toContain(">Scanning ' + esc(domain)");
    expect(html).toContain("esc(data.error || 'Unknown error')");
  });
});
