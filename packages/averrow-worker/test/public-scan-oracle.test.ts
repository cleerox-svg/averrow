// Detection-oracle follow-up to the public-scan XSS fix (2026-10-05).
//
// An anonymous caller must not be able to learn whether a domain is in
// Averrow's threat data from any public scan surface:
//   1. /api/brand-scan/public (+ its result lookup): the response is public
//      DNS facts only and is identical whether or not the domain is in
//      threat data; the stored staff score/feed count still are.
//   2. POST /api/v1/public/assess: no threat/provider/campaign counts,
//      threat types, monitored status or spam-trap data, and the score /
//      grade / text are email-posture only.
//   3. POST /api/scan/report: retired → 410.
//   4. POST /api/v1/public/leads: caller-supplied grade / trust_score /
//      assessment_id are never trusted.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import type { Env } from "../src/types";

vi.mock("../src/lib/agentRunner", async (orig) => {
  const actual = await orig<typeof import("../src/lib/agentRunner")>();
  return {
    ...actual,
    // Threat-derived staff score/text, like the real public_trust_check.
    runSyncAgent: vi.fn(async (_env: unknown, _agent: unknown, input: { threatCount: number }) => ({
      status: "success",
      data: {
        trustScore: Math.max(0, 100 - input.threatCount * 2),
        grade: input.threatCount > 20 ? "F" : "A",
        assessmentText: `Brand faces ${input.threatCount} known threats in the wild right now.`,
        aiSucceeded: false,
      },
    })),
  };
});

const { handlePublicBrandScan, handlePublicBrandScanResult } = await import("../src/handlers/brandScan");
const { handlePublicAssess, handlePublicLeadCapture, handlePublicMonitor } = await import("../src/handlers/public");
const { registerScanRoutes } = await import("../src/routes/scan");
const { registerPublicRoutes } = await import("../src/routes/public");
const { renderHomepage } = await import("../src/templates/homepage");

// ─── D1 stub driven by a per-test responder ────────────────────────────

type Responder = (sql: string, binds: unknown[]) => unknown;
interface Call { sql: string; binds: unknown[] }

function makeEnv(respond: Responder = () => null): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind: (...args: unknown[]) => { binds = args; return stmt; },
        async first<T>() { calls.push({ sql, binds }); return respond(sql, binds) as T; },
        async run() { calls.push({ sql, binds }); return { success: true, meta: { changes: 1 } }; },
        async all<T>() {
          calls.push({ sql, binds });
          const r = respond(sql, binds);
          return { results: (Array.isArray(r) ? r : []) as T[] };
        },
      };
      return stmt;
    },
  };
  const kv = new Map<string, string>();
  const cache = {
    async get(k: string) { return kv.get(k) ?? null; },
    async put(k: string, v: string) { kv.set(k, v); },
  };
  return { env: { DB: db, CACHE: cache, AI_MODE: "rules_only" } as unknown as Env, calls };
}

function jsonReq(path: string, body: unknown, ip = "203.0.113.7"): Request {
  return new Request(`https://averrow.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

// DNS-over-HTTPS stub: SPF softfail, no DMARC, one MX — identical for
// every test so only the threat data varies.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("type=TXT") && !u.includes("_dmarc") && !u.includes("_domainkey") && !u.includes("_bimi")) {
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: "\"v=spf1 include:x ~all\"" }] }));
    }
    if (u.includes("type=MX")) {
      return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15, data: "10 mx.acme.example." }] }));
    }
    return new Response(JSON.stringify({ Status: 3 }));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const threatRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, threat_type: "phishing", severity: "high", source_feed: "x", created_at: "2026-10-01" }));

// ─── 1. /api/brand-scan/public ─────────────────────────────────────────

describe("free scan response carries no threat-data signal", () => {
  async function scan(feedHits: number) {
    const s = makeEnv((sql) => (/FROM threats/.test(sql) ? threatRows(feedHits) : null));
    const res = await handlePublicBrandScan(jsonReq("/api/brand-scan/public", { domain: "acme.example" }), s.env);
    const body = await res.json() as { data: Record<string, unknown> };
    const insert = s.calls.find((c) => /INSERT INTO brand_scans/.test(c.sql))!;
    return { data: body.data, insert, calls: s.calls };
  }
  const strip = ({ id: _id, checked_at: _at, ...rest }: Record<string, unknown>) => rest;

  it("returns the same data whether or not the domain is in threat data", async () => {
    const clean = await scan(0);
    const hit = await scan(12);
    expect(strip(hit.data)).toEqual(strip(clean.data));
    expect(JSON.stringify(hit.data)).not.toMatch(/feed|threat|score/i);
  });

  it("never reads threat data; trust_score and feed_mentions are NULL on public rows (appsec M2)", async () => {
    const hit = await scan(12);
    expect(hit.calls.some((c) => /FROM threats/.test(c.sql))).toBe(false);
    expect(hit.insert.sql).toMatch(/'completed', NULL, \?, \?, NULL,/);
  });
});

describe("free scan result lookup", () => {
  it("returns only the stored public view, never feed_mentions/trust_score", async () => {
    const view = {
      v: 1, checked_at: "2026-10-05T00:00:00.000Z",
      email: { grade: "C", spf: { status: "soft" }, dkim: { found: false }, dmarc: { policy: "missing" }, mx: { present: true }, bimi: { present: false } },
      lookalikes: { checked: 40, registered: 2 },
      feed_mentions: 12,
    };
    const id = "0b7d6f9e-1c2a-4b3c-8d4e-5f6a7b8c9d0e";
    const s = makeEnv(() => ({ id, domain: "acme.example", public_view: JSON.stringify(view) }));
    const res = await handlePublicBrandScanResult(new Request("https://averrow.com/x"), s.env, id);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(["checked_at", "domain", "email", "id", "lookalikes"]);
    expect(JSON.stringify(body)).not.toMatch(/feed|trust_score/i);
    // The SELECT never reads the staff columns.
    expect(s.calls[0]!.sql).not.toMatch(/feed_mentions|trust_score/);
  });
});

describe("legacy homepage widget", () => {
  it("hands results to /scan and renders no score/threat copy itself", () => {
    const html = renderHomepage();
    expect(html).toContain("window.location.href = '/scan/?id=' + encodeURIComponent(data.data.id)");
    expect(html).not.toContain("function summaryFor");
    expect(html).not.toContain("feedMentions");
    expect(html).not.toContain("/api/leads");
  });
});

// ─── 2. POST /api/v1/public/assess ────────────────────────────────────

describe("POST /api/v1/public/assess", () => {
  function assessEnv(threats: number, monitored: boolean) {
    return makeEnv((sql) => {
      if (/FROM brands b\s+JOIN monitored_brands/.test(sql)) return monitored ? { id: "b1", name: "Acme Secret Customer" } : null;
      if (/FROM threat_cube_brand/.test(sql)) return [{ threat_type: "phishing", count: threats }];
      if (/COUNT\(\*\) as c FROM threats/.test(sql)) return { c: threats };
      if (/COUNT\(DISTINCT/.test(sql)) return { c: threats ? 3 : 0 };
      if (/spam_trap_captures/.test(sql)) return { count: threats ? 40 : 0, ips: threats ? 9 : 0 };
      return null;
    });
  }

  const FORBIDDEN = ["threat_count", "provider_count", "campaign_count", "threat_types", "is_monitored", "spam_trap"];

  async function assess(threats: number, monitored: boolean) {
    const s = assessEnv(threats, monitored);
    const res = await handlePublicAssess(jsonReq("/api/v1/public/assess", { domain: "www.acme.example" }), s.env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    return { data: body.data, calls: s.calls };
  }

  it("response is identical for a clean domain and a heavily-targeted monitored one", async () => {
    const clean = await assess(0, false);
    const hit = await assess(80, true);
    const strip = (d: Record<string, unknown>) => {
      const { assessment_id: _id, assessed_at: _at, ...rest } = d;
      return rest;
    };
    expect(strip(hit.data)).toEqual(strip(clean.data));
    for (const k of FORBIDDEN) expect(hit.data).not.toHaveProperty(k);
    expect(hit.data.brand_name).toBe("Acme");
    expect(JSON.stringify(strip(hit.data))).not.toMatch(/threat|Secret Customer|80/i);
    expect(hit.data.trust_score).toBe(65);
    expect(hit.data.grade).toBe("D");
  });

  it("keeps the threat-derived staff values on the stored row", async () => {
    const { calls } = await assess(80, true);
    const insert = calls.find((c) => /INSERT INTO assessments/.test(c.sql))!;
    expect(insert.binds[2]).toBe(0); // staff trust_score = 100 - 80*2 → 0
    expect(JSON.parse(insert.binds[5] as string)).toMatchObject({ threat_count: 80, is_monitored: true });
    expect(JSON.parse(insert.binds[6] as string)).toMatchObject({ public: { trust_score: 65, version: 1 } });
  });

  it("never replays a pre-fix row (no public view) and replays a post-fix one", async () => {
    const legacy = makeEnv((sql) => {
      if (/FROM assessments/.test(sql)) return { id: "old", domain: "acme.example", score_breakdown: null, completed_at: "2026-10-05" };
      return null;
    });
    const r1 = await handlePublicAssess(jsonReq("/api/v1/public/assess", { domain: "acme.example" }), legacy.env);
    const d1 = (await r1.json() as { data: Record<string, unknown> }).data;
    expect(d1.assessment_id).not.toBe("old");

    const view = { version: 1, brand_name: "Acme", trust_score: 65, grade: "D", assessment_text: "x".repeat(60), spf_policy: "softfail", dmarc_policy: null };
    const fresh = makeEnv((sql) => {
      if (/FROM assessments/.test(sql)) return { id: "new1", domain: "acme.example", score_breakdown: JSON.stringify({ public: view }), completed_at: "2026-10-05" };
      return null;
    });
    const r2 = await handlePublicAssess(jsonReq("/api/v1/public/assess", { domain: "acme.example" }), fresh.env);
    const d2 = (await r2.json() as { data: Record<string, unknown> }).data;
    expect(d2).toMatchObject({ assessment_id: "new1", trust_score: 65 });
    // No `cached` flag — "someone assessed this domain in the last 24h"
    // is itself a signal.
    expect(d2).not.toHaveProperty("cached");
    for (const k of FORBIDDEN) expect(d2).not.toHaveProperty(k);
    expect(fresh.calls.some((c) => /FROM threats/.test(c.sql))).toBe(false);
  });
});

// ─── 3. POST /api/scan/report ─────────────────────────────────────────

describe("POST /api/scan/report", () => {
  it("is retired with 410 Gone and touches nothing", async () => {
    const r: RouterType<IRequest> = Router();
    registerScanRoutes(r);
    registerPublicRoutes(r);
    const s = makeEnv();
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = (await r.fetch(jsonReq("/api/scan/report", { domain: "acme.example" }), s.env, ctx)) as Response;
    expect(res.status).toBe(410);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/retired/i);
    expect(s.calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─── 4. POST /api/v1/public/leads ─────────────────────────────────────

describe("POST /api/v1/public/leads", () => {
  const lead = { email: "pat@acme.example", name: "Pat", company: "Acme" };
  const inserts = (calls: Call[], table: string) => calls.filter((c) => new RegExp(`INSERT INTO ${table}\\b`).test(c.sql));

  it("ignores caller trust_score/grade and a non-existent assessment_id (placeholder has no score)", async () => {
    const s = makeEnv(() => null);
    const res = await handlePublicLeadCapture(jsonReq("/api/v1/public/leads", {
      ...lead, domain: "acme.example", trust_score: 99, grade: "A", assessment_id: "assess_forged",
    }), s.env);
    expect(res.status).toBe(201);
    const [placeholder] = inserts(s.calls, "assessments");
    expect(placeholder).toBeDefined();
    expect(placeholder!.sql).toMatch(/VALUES \(\?, \?, NULL, NULL\)/);
    expect(placeholder!.binds).toHaveLength(2);
    expect(placeholder!.binds[0]).not.toBe("assess_forged");
    expect(placeholder!.binds).not.toContain(99);
    expect(placeholder!.binds).not.toContain("A");
    const [leadRow] = inserts(s.calls, "leads");
    expect(leadRow!.binds[1]).toBe(placeholder!.binds[0]);
  });

  it("links an assessment_id that exists, without writing an assessment", async () => {
    const s = makeEnv((sql, binds) => (/WHERE id = \?/.test(sql) && binds[0] === "assess_real" ? { id: "assess_real" } : null));
    const res = await handlePublicLeadCapture(jsonReq("/api/v1/public/leads", {
      ...lead, assessment_id: "assess_real", trust_score: 5, grade: "F",
    }), s.env);
    expect(res.status).toBe(201);
    expect(inserts(s.calls, "assessments")).toEqual([]);
    expect(inserts(s.calls, "leads")[0]!.binds[1]).toBe("assess_real");
  });

  it("falls back to the latest real assessment for the domain", async () => {
    const s = makeEnv((sql, binds) => (/WHERE domain = \?/.test(sql) && binds[0] === "acme.example" ? { id: "assess_latest" } : null));
    const res = await handlePublicLeadCapture(jsonReq("/api/v1/public/leads", { ...lead, domain: "https://www.acme.example/" }), s.env);
    expect(res.status).toBe(201);
    expect(inserts(s.calls, "assessments")).toEqual([]);
    expect(inserts(s.calls, "leads")[0]!.binds[1]).toBe("assess_latest");
  });

  it("rejects non-string required fields with 400", async () => {
    const s = makeEnv();
    const res = await handlePublicLeadCapture(jsonReq("/api/v1/public/leads", { ...lead, email: ["pat@acme.example"] }), s.env);
    expect(res.status).toBe(400);
    expect(s.calls.filter((c) => /INSERT/.test(c.sql))).toEqual([]);
  });
});

// ─── 5. POST /api/v1/public/monitor ───────────────────────────────────

describe("POST /api/v1/public/monitor", () => {
  async function monitor(brandExists: boolean, threats: number, body: Record<string, unknown> = {}) {
    const s = makeEnv((sql) => {
      if (/SELECT id FROM brands WHERE canonical_domain/.test(sql)) return brandExists ? { id: "brand_catalog_123" } : null;
      if (/FROM threats/.test(sql)) return { n: threats };
      return null;
    });
    const res = await handlePublicMonitor(jsonReq("/api/v1/public/monitor", { domain: "acme.example", ...body }), s.env);
    expect(res.status).toBe(201);
    const json = await res.json() as { data: Record<string, unknown> };
    return { data: json.data, calls: s.calls };
  }

  it("returns an identical response whether the brand was already in the catalog or not", async () => {
    const existing = await monitor(true, 500);
    const created = await monitor(false, 0);
    expect(existing.data).toEqual(created.data);
    expect(existing.data).toEqual({
      domain: "acme.example",
      brand_name: "Acme",
      monitoring: true,
      message: expect.any(String),
    });
    expect(existing.data).not.toHaveProperty("brand_id");
    expect(existing.data).not.toHaveProperty("existing_threats");
  });

  it("never queries the threats table", async () => {
    const { calls } = await monitor(false, 500);
    expect(calls.some((c) => /FROM threats/.test(c.sql))).toBe(false);
  });

  it("lead placeholder assessment carries no score/grade", async () => {
    const { calls } = await monitor(false, 0, { email: "pat@acme.example", company: "Acme" });
    const placeholder = calls.find((c) => /INSERT INTO assessments/.test(c.sql))!;
    expect(placeholder.sql).toMatch(/VALUES \(\?, \?, NULL, NULL\)/);
    const lead = calls.find((c) => /INSERT INTO leads/.test(c.sql))!;
    expect(lead.binds[1]).toBe(placeholder.binds[0]);
  });
});
