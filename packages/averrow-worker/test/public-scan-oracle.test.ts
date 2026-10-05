// Detection-oracle follow-up to the public-scan XSS fix (2026-10-05).
//
// An anonymous caller must not be able to learn whether a domain is in
// Averrow's threat data from any public scan surface:
//   1. /api/brand-scan/public (+ the /assess results lookup): the score has
//      no feed-mention component; the stored staff score still does.
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

const {
  handlePublicBrandScan, handlePublicBrandScanResult, publicScoreFromStored, feedMentionPenalty,
} = await import("../src/handlers/brandScan");
const { handlePublicAssess, handlePublicLeadCapture } = await import("../src/handlers/public");
const { registerScanRoutes } = await import("../src/routes/scan");
const { registerPublicRoutes } = await import("../src/routes/public");
const { renderAssessResults, renderHomepage } = await import("../src/templates/homepage");
const { renderScanPage } = await import("../src/templates/scan");

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
    if (u.includes("type=TXT") && !u.includes("_dmarc")) {
      return new Response(JSON.stringify({ Answer: [{ data: "\"v=spf1 include:x ~all\"" }] }));
    }
    if (u.includes("type=MX")) {
      return new Response(JSON.stringify({ Answer: [{ data: "10 mx.acme.example." }] }));
    }
    return new Response(JSON.stringify({}));
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const threatRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, threat_type: "phishing", severity: "high", source_feed: "x", created_at: "2026-10-01" }));

// ─── 1. /api/brand-scan/public ─────────────────────────────────────────

describe("public brand scan score has no feed component", () => {
  async function scan(feedHits: number) {
    const s = makeEnv((sql) => (/FROM threats/.test(sql) ? threatRows(feedHits) : null));
    const res = await handlePublicBrandScan(jsonReq("/api/brand-scan/public", { domain: "acme.example" }), s.env);
    const body = await res.json() as { data: { trustScore: number; riskLevel: string } };
    const insert = s.calls.find((c) => /INSERT INTO brand_scans/.test(c.sql))!;
    return { data: body.data, storedScore: insert.binds[2], storedFeed: insert.binds[5] };
  }

  it("returns the same score/risk whether or not the domain is in threat data", async () => {
    const clean = await scan(0);
    const hit = await scan(12);
    expect(hit.data).toEqual(clean.data);
    // softfail SPF (-10) + no DMARC (-25) → 65; feed never applied publicly.
    expect(clean.data.trustScore).toBe(65);
  });

  it("still stores the staff score (with the feed deduction) and the feed count", async () => {
    const hit = await scan(12);
    expect(hit.storedScore).toBe(65 - 20);
    expect(hit.storedFeed).toBe(12);
  });
});

describe("public scan result lookup", () => {
  it("adds the feed deduction back and never returns feed_mentions", async () => {
    const row = {
      id: "s1", domain: "acme.example", trust_score: 45, spf_policy: "softfail", dmarc_policy: null,
      feed_mentions: 12, lookalikes_found: 0, status: "completed", created_at: "2026-10-05",
    };
    const s = makeEnv(() => row);
    const res = await handlePublicBrandScanResult(new Request("https://averrow.com/x"), s.env, "s1");
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data.trust_score).toBe(65);
    expect(body.data.risk_level).toBe("medium");
    expect(body.data).not.toHaveProperty("feed_mentions");
    expect(JSON.stringify(body)).not.toMatch(/feed/i);
  });

  it("publicScoreFromStored exactly inverts the feed deduction for every reachable stored score", () => {
    // Non-feed deductions: SPF {0,10,15,25} + DMARC {0,8,25} + MX {0,10} + lookalikes {0,5,10,15,20}.
    for (const spf of [0, 10, 15, 25]) for (const dmarc of [0, 8, 25]) for (const mx of [0, 10])
      for (const look of [0, 5, 10, 15, 20]) for (const feed of [0, 1, 3, 6, 11, 50]) {
        const base = 100 - spf - dmarc - mx - look;
        const stored = Math.max(0, base - feedMentionPenalty(feed));
        expect(publicScoreFromStored(stored, feed)).toBe(base);
      }
  });
});

describe("public summary copy is posture-only", () => {
  const threatClaim = /threat activity|active threats|threats detected|detected active/i;

  it("assess results page, homepage widget and /scan make no threat claims", () => {
    const pageScripts = [renderAssessResults("s1"), renderHomepage()].map((h) => {
      const i = h.indexOf("function summaryFor");
      return h.slice(i, h.indexOf("\n}", i));
    });
    for (const fn of pageScripts) {
      expect(fn.length).toBeGreaterThan(50);
      expect(fn).not.toMatch(threatClaim);
    }
    expect(renderScanPage()).not.toMatch(/Active brand abuse/);
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
    expect(d2).toMatchObject({ assessment_id: "new1", trust_score: 65, cached: true });
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
