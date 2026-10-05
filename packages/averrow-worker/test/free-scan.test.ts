// Free scan (Section 7, 2026-10-05): contract, grade mapping, lookalike
// cache/budget, prospect report hygiene, lead auto-delivery, consent,
// brand_scans retention and the /scan route changes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import type { Env } from "../src/types";

// The report's narrative agent: force the deterministic (rules_only) path.
vi.mock("../src/lib/agentRunner", async (orig) => {
  const actual = await orig<typeof import("../src/lib/agentRunner")>();
  return { ...actual, runSyncAgent: vi.fn(async () => ({ runId: "r", status: "success", data: null })) };
});

const { handlePublicBrandScan, handlePublicBrandScanResult, handleLeadCapture } = await import("../src/handlers/brandScan");
const { buildReportPayload } = await import("../src/handlers/qualifiedReport");
const { renderQualifiedReportHTML } = await import("../src/templates/qualifiedReport");
const { deterministicNarrative, deterministicPlan } = await import("../src/agents/qualified-report");
const {
  toPublicEmailView, spfStatusFrom, dmarcPolicyFrom, emailMatchesScannedDomain, parseStoredPublicView,
} = await import("../src/lib/free-scan-view");
const {
  selectLikelyLookalikes, getScanLookalikes, checkRegistrations, lookalikeCacheKey, LOOKALIKE_CACHE_TTL_SECONDS,
} = await import("../src/lib/scan-lookalikes");
const { calculateEmailSecurityScore } = await import("../src/email-security");
const { purgeExpiredBrandScans, BRAND_SCAN_PURGE_SQL } = await import("../src/lib/brand-scan-retention");
const { registerScanRoutes } = await import("../src/routes/scan");
const { registerPublicRoutes } = await import("../src/routes/public");

// ─── Stubs ─────────────────────────────────────────────────────────────

type Responder = (sql: string, binds: unknown[]) => unknown;
interface Call { sql: string; binds: unknown[] }

function makeEnv(respond: Responder = () => null, kvInit: Record<string, string> = {}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind: (...args: unknown[]) => { binds = args; return stmt; },
        async first<T>() { calls.push({ sql, binds }); return respond(sql, binds) as T; },
        async run() {
          calls.push({ sql, binds });
          const r = respond(sql, binds) as { changes?: number } | null;
          return { success: true, meta: { changes: r?.changes ?? 1 } };
        },
        async all<T>() {
          calls.push({ sql, binds });
          const r = respond(sql, binds);
          return { results: (Array.isArray(r) ? r : []) as T[] };
        },
      };
      return stmt;
    },
  };
  const kv = new Map<string, string>(Object.entries(kvInit));
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  const cache = {
    async get(k: string) { return kv.get(k) ?? null; },
    async put(k: string, v: string, o?: { expirationTtl?: number }) { kv.set(k, v); puts.push({ key: k, value: v, ttl: o?.expirationTtl }); },
  };
  const assets = { fetch: vi.fn(async () => new Response("static scan page", { status: 200, headers: { "content-type": "text/html" } })) };
  const env = { DB: db, CACHE: cache, ASSETS: assets, AI_MODE: "rules_only", RESEND_API_KEY: "re_test" } as unknown as Env;
  return { env, calls, kv, puts, assets };
}

function jsonReq(path: string, body: unknown): Request {
  return new Request(`https://averrow.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

interface Sent { to: string[]; subject: string; html: string; text: string }

/**
 * DoH + Resend stub. Domain posture: SPF -all, DMARC reject with rua,
 * DKIM on `google`, MX present, no BIMI → grade A+. NS lookups: names in
 * `registered` exist, everything else NXDOMAIN.
 */
function stubNetwork(opts: { registered?: string[]; resendOk?: boolean } = {}) {
  const registered = new Set(opts.registered ?? []);
  const sent: Sent[] = [];
  const nsQueries: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.hostname === "api.resend.com") {
      sent.push(JSON.parse(String(init?.body)) as Sent);
      return opts.resendOk === false
        ? new Response(JSON.stringify({ message: "nope" }), { status: 500 })
        : new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }
    const name = u.searchParams.get("name") ?? "";
    const type = u.searchParams.get("type");
    const ok = (Answer: Array<{ type: number; data: string }>) => new Response(JSON.stringify({ Status: 0, Answer }));
    if (type === "NS") {
      nsQueries.push(name);
      return registered.has(name) ? ok([{ type: 2, data: "ns1.parking.example." }]) : new Response(JSON.stringify({ Status: 3 }));
    }
    if (type === "TXT" && name === "acme.example") return ok([{ type: 16, data: "\"v=spf1 include:_spf.google.com -all\"" }]);
    if (type === "TXT" && name === "_dmarc.acme.example") return ok([{ type: 16, data: "\"v=DMARC1; p=reject; rua=mailto:d@acme.example\"" }]);
    if (type === "TXT" && name === "google._domainkey.acme.example") return ok([{ type: 16, data: "\"v=DKIM1; k=rsa; p=MIIB\"" }]);
    if (type === "MX" && name === "acme.example") return ok([{ type: 15, data: "1 aspmx.l.google.com." }]);
    return new Response(JSON.stringify({ Status: 3 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, sent, nsQueries };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const THREAT_ROW = { id: "t1", threat_type: "phishing", severity: "high", source_feed: "phishtank", created_at: "2026-10-01" };

const EMAIL_KEYS = ["bimi", "dkim", "dmarc", "grade", "mx", "spf"];

// ─── 1. Contract ───────────────────────────────────────────────────────

describe("POST /api/brand-scan/public contract", () => {
  it("returns exactly the public shape, with the engine's grade and counts only", async () => {
    stubNetwork({ registered: ["acme.net", "acme.org"] });
    const s = makeEnv((sql) => (/FROM threats/.test(sql) ? [THREAT_ROW] : null));
    const res = await handlePublicBrandScan(jsonReq("/api/brand-scan/public", { domain: "www.Acme.Example" }), s.env);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    const d = body.data as {
      id: string; domain: string; checked_at: string;
      email: Record<string, unknown>; lookalikes: Record<string, unknown>;
    };
    expect(Object.keys(d).sort()).toEqual(["checked_at", "domain", "email", "id", "lookalikes"]);
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.domain).toBe("acme.example");
    expect(Number.isNaN(Date.parse(d.checked_at))).toBe(false);
    expect(Object.keys(d.email).sort()).toEqual(EMAIL_KEYS);
    expect(d.email).toEqual({
      grade: "A+", spf: { status: "pass" }, dkim: { found: true }, dmarc: { policy: "reject" },
      mx: { present: true }, bimi: { present: false },
    });
    expect(d.lookalikes).toEqual({ checked: 40, registered: 2 });
    // No threat signal, no selectors, no lookalike names.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/feed|threat|trust|score|phishtank|google|acme\.net|selector/i);

    // Staff fields + names stored on the row.
    const insert = s.calls.find((c) => /INSERT INTO brand_scans/.test(c.sql))!;
    expect(insert.sql).toMatch(/feed_mentions/);
    expect(insert.binds[5]).toBe(1); // feed_mentions
    expect(JSON.parse(insert.binds[7] as string)).toEqual(["acme.net", "acme.org"]);
    expect(parseStoredPublicView(insert.binds[8] as string)?.email.grade).toBe("A+");
  });

  it("GET /:id returns the same data shape; unknown → 404", async () => {
    stubNetwork();
    const s = makeEnv();
    const post = await handlePublicBrandScan(jsonReq("/api/brand-scan/public", { domain: "acme.example" }), s.env);
    const posted = (await post.json() as { data: { id: string } }).data;
    const insert = s.calls.find((c) => /INSERT INTO brand_scans/.test(c.sql))!;
    const row = { id: posted.id, domain: "acme.example", public_view: insert.binds[8] };

    const g = makeEnv((sql) => (/FROM brand_scans WHERE id = \?/.test(sql) ? row : null));
    const res = await handlePublicBrandScanResult(new Request("https://averrow.com/x"), g.env, posted.id);
    expect(res.status).toBe(200);
    expect((await res.json() as { data: unknown }).data).toEqual(posted);

    const missing = makeEnv(() => null);
    const r404 = await handlePublicBrandScanResult(new Request("https://averrow.com/x"), missing.env, "0b7d6f9e-1c2a-4b3c-8d4e-5f6a7b8c9d0e");
    expect(r404.status).toBe(404);
  });

  it("the stored view is re-allowlisted on read (extra JSON keys never leak)", () => {
    const v = parseStoredPublicView(JSON.stringify({
      v: 1, checked_at: "x", feed_mentions: 9,
      email: { grade: "B", spf: { status: "soft", record: "v=spf1" }, dkim: { found: true, selectors: ["google"] }, dmarc: { policy: "none" }, mx: { present: true }, bimi: { present: false } },
      lookalikes: { checked: 3, registered: 1, names: ["acme.net"] },
    }));
    expect(JSON.stringify(v)).not.toMatch(/feed|record|selectors|names/);
  });
});

// ─── 2. Grade mapping ──────────────────────────────────────────────────

describe("email grade mapping", () => {
  const base = {
    dmarc: { exists: true, policy: "reject", pct: 100, rua: "mailto:x@y", ruf: null, raw: "v=DMARC1" },
    spf: { exists: true, policy: "-all", includes: 1, tooManyLookups: false, raw: "v=spf1 -all" },
    dkim: { exists: true, selectorsFound: ["google"], raw: null },
    mx: { exists: true, providers: ["Google Workspace"] },
  };

  it("uses the engine's own A+–F scale", () => {
    expect(calculateEmailSecurityScore(base).grade).toBe("A+");
    const none = {
      dmarc: { ...base.dmarc, exists: false, policy: null, rua: null },
      spf: { ...base.spf, exists: false, policy: null },
      dkim: { exists: false, selectorsFound: [], raw: null },
      mx: { exists: false, providers: [] },
    };
    expect(calculateEmailSecurityScore(none).grade).toBe("F");
  });

  it("maps SPF qualifiers and DMARC policies to the public vocabulary", () => {
    expect(spfStatusFrom(true, "-all")).toBe("pass");
    expect(spfStatusFrom(true, "~all")).toBe("soft");
    expect(spfStatusFrom(true, "?all")).toBe("neutral");
    expect(spfStatusFrom(true, "+all")).toBe("neutral");
    expect(spfStatusFrom(true, null)).toBe("neutral");
    expect(spfStatusFrom(false, null)).toBe("missing");
    expect(dmarcPolicyFrom(true, "reject")).toBe("reject");
    expect(dmarcPolicyFrom(true, "QUARANTINE")).toBe("quarantine");
    expect(dmarcPolicyFrom(true, "none")).toBe("none");
    expect(dmarcPolicyFrom(true, null)).toBe("none");
    expect(dmarcPolicyFrom(false, null)).toBe("missing");
  });

  it("toPublicEmailView exposes DKIM as found/not-found only and BIMI as presence", () => {
    const view = toPublicEmailView({
      domain: "acme.example", score: 95, grade: "A+",
      dmarc: { exists: true, policy: "reject", pct: 100, rua: null, ruf: null, reporting_enabled: false, record: null },
      spf: { exists: true, policy: "~all", too_many_lookups: false, record: null },
      dkim: { exists: true, selectors_found: ["selector1", "mandrill"] },
      mx: { exists: true, providers: [] },
      bimi: { record: "v=BIMI1; l=https://x/logo.svg", svg_url: null, vmc_url: null, vmc_valid: false, vmc_expiry: null, grade: "A" },
      recommendations: [], scanned_at: "", scan_duration_ms: 0,
    });
    expect(view).toEqual({
      grade: "A+", spf: { status: "soft" }, dkim: { found: true }, dmarc: { policy: "reject" },
      mx: { present: true }, bimi: { present: true },
    });
    expect(JSON.stringify(view)).not.toMatch(/selector|mandrill/);
  });
});

// ─── 3. Lookalikes: sample, cache, budget ──────────────────────────────

describe("lookalike sample", () => {
  it("is at most 40 valid ASCII hostnames, other TLDs first, never the domain itself", () => {
    const picks = selectLikelyLookalikes("acmecorp.com");
    expect(picks.length).toBe(40);
    expect(new Set(picks).size).toBe(40);
    expect(picks).not.toContain("acmecorp.com");
    for (const d of picks) expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    expect(picks.slice(0, 3)).toEqual(["acmecorp.net", "acmecorp.org", "acmecorp.info"]);
    expect(picks).toContain("acmecrop.com"); // transposition
    expect(picks).toContain("secure-acmecorp.com"); // keyword
  });
});

describe("lookalike cache + time budget", () => {
  it("miss: checks live and caches a complete result for 24h under scan:lookalikes:<domain>", async () => {
    const net = stubNetwork({ registered: ["acme.net"] });
    const s = makeEnv();
    const r = await getScanLookalikes(s.env, "acme.example");
    expect(r).toEqual({ checked: 40, registered: ["acme.net"], cached: false });
    expect(net.nsQueries.length).toBe(40);
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0]!.key).toBe("scan:lookalikes:acme.example");
    expect(s.puts[0]!.ttl).toBe(LOOKALIKE_CACHE_TTL_SECONDS);
    expect(LOOKALIKE_CACHE_TTL_SECONDS).toBe(86_400);
  });

  it("hit: no DNS lookups", async () => {
    const net = stubNetwork();
    const s = makeEnv(() => null, {
      [lookalikeCacheKey("acme.example")]: JSON.stringify({ v: 1, checked: 40, registered: ["acme.net", "acme.org"] }),
    });
    const r = await getScanLookalikes(s.env, "acme.example");
    expect(r).toEqual({ checked: 40, registered: ["acme.net", "acme.org"], cached: true });
    expect(net.fetchMock).not.toHaveBeenCalled();
  });

  it("budget: hung lookups are cut off, partial results are returned but not cached", async () => {
    // Every lookup hangs forever (ignores abort) — only the timers bound it.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const s = makeEnv();
    const started = Date.now();
    const r = await getScanLookalikes(s.env, "acme.example", { budgetMs: 120, lookupTimeoutMs: 50, concurrency: 4 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.checked).toBe(0);
    expect(r.registered).toEqual([]);
    expect(s.puts).toEqual([]);
  });

  it("never runs more than `concurrency` lookups at once", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return new Response(JSON.stringify({ Status: 3 }));
    }));
    const r = await checkRegistrations(selectLikelyLookalikes("acmecorp.com"), { concurrency: 5, budgetMs: 5_000 });
    expect(peak).toBeLessThanOrEqual(5);
    expect(r).toMatchObject({ checked: 40, complete: true, registered: [] });
  });
});

// ─── 4. Prospect report ────────────────────────────────────────────────

const SCAN_ID = "0b7d6f9e-1c2a-4b3c-8d4e-5f6a7b8c9d0e";
const STORED_VIEW = JSON.stringify({
  v: 1, checked_at: "2026-10-05T00:00:00.000Z",
  email: { grade: "C", spf: { status: "soft" }, dkim: { found: false }, dmarc: { policy: "none" }, mx: { present: true }, bimi: { present: false } },
  lookalikes: { checked: 40, registered: 2 },
});

function reportResponder(opts: { brand?: boolean; threats?: number } = {}): Responder {
  return (sql) => {
    if (/FROM brands WHERE canonical_domain/.test(sql)) return opts.brand ? { id: "b1", name: "Acme", email_security_grade: "C" } : null;
    if (/registered_lookalikes, public_view FROM brand_scans/.test(sql)) return { registered_lookalikes: JSON.stringify(["acme.net", "acme-login.example"]), public_view: STORED_VIEW };
    if (/SELECT severity, COUNT/.test(sql)) return opts.threats ? [{ severity: "high", n: opts.threats }] : [];
    if (/FROM threats WHERE target_brand_id/.test(sql)) return opts.threats ? [{ id: "t1", threat_type: "phishing", severity: "high", malicious_domain: "acme-login.example", ip_address: null, country_code: "US", first_seen: "2026-10-01" }] : [];
    if (/hosting_providers/.test(sql)) return opts.threats ? [{ name: "Example Hosting", threat_count: opts.threats }] : [];
    if (/SUM\(CASE WHEN registered = 1/.test(sql)) return { total: 12, registered: 1 };
    if (/SELECT domain FROM lookalike_domains/.test(sql)) return [{ domain: "acme-secure.example" }];
    if (/COUNT\(\*\) AS n FROM lookalike_domains/.test(sql)) return { n: 12 };
    return null;
  };
}

describe("prospect report", () => {
  it("queries lookalike_domains by brand_id (no target_brand) and never selects source_feed/asn", async () => {
    stubNetwork();
    const s = makeEnv(reportResponder({ brand: true, threats: 3 }));
    await buildReportPayload(s.env, { domain: "acme.example", company: null, scanId: SCAN_ID });
    const sqls = s.calls.map((c) => c.sql).join("\n");
    expect(sqls).not.toMatch(/target_brand\b(?!_id)/);
    expect(sqls).toMatch(/FROM lookalike_domains WHERE brand_id = \?/);
    expect(sqls).not.toMatch(/source_feed|hp\.asn|malicious_domain LIKE/);
  });

  it("lists registered lookalike names + email findings + watch list; no feed/vendor/social/unsourced stat", async () => {
    stubNetwork();
    const s = makeEnv(reportResponder({ brand: true, threats: 3 }));
    const payload = await buildReportPayload(s.env, { domain: "acme.example", company: null, scanId: SCAN_ID });
    expect(payload.lookalikes.names).toEqual(["acme-login.example", "acme-secure.example", "acme.net"]);
    expect(payload.email_security).toMatchObject({ grade: "C", spf: "soft", dmarc: "none", dkim_found: false, mx_count: 1, bimi_present: false });
    const html = renderQualifiedReportHTML(payload);
    expect(html).toContain("acme-secure.example");
    expect(html).toContain("What Averrow Would Watch");
    expect(html).toMatch(/Soft fail/);
    expect(html).not.toMatch(/breach|IBM|4%|social|LinkedIn|Twitter|ASN|Source<\/th>|phishtank|urlhaus|openphish/i);
  });

  it("an old stored payload (source_feed, ASN, breach value) renders without them", () => {
    const old = {
      brand: { domain: "acme.example", name: null }, generated_at: "2026-09-01T00:00:00Z",
      executive_summary: { risk_grade: "HIGH", key_findings: ["x"] },
      email_security: { grade: "D", spf: "~all", dmarc: null, dkim_found: false, mx_count: 2 },
      active_threats: { total: 1, by_severity: { high: 1 }, samples: [{ id: "t", threat_type: "phishing", severity: "high", source_feed: "phishtank", malicious_domain: "x.example", ip_address: null, country_code: "US", first_seen: "2026-09-01" }] },
      infrastructure: { top_hosting_providers: [{ name: "Example Hosting", asn: "AS64500", threat_count: 1 }], top_countries: [], campaigns_caught_in: [] },
      lookalikes: { registered_count: 0, possible_count: 0 },
      narrative: "n".repeat(70), remediation_plan: "1. a\n2. b",
      roi: { analyst_hours_saved_per_year: 3500, analyst_dollars_saved_per_year: 262500, takedowns_per_year_projected: 72, breach_prevention_value_per_year: 178000, total_value_per_year: 440500 },
    };
    const html = renderQualifiedReportHTML(old as unknown as Parameters<typeof renderQualifiedReportHTML>[0]);
    expect(html).not.toMatch(/phishtank|AS64500|178,000|440,500|breach/i);
    expect(html).toContain("Example Hosting");
  });

  it("narrative and plan are conditional on the counts", () => {
    const zero = {
      domain: "acme.example", companyName: "acme.example", totalThreats: 0, topProviders: [], topCountries: [],
      campaignCount: 0, registeredLookalikes: 0, emailGrade: "A+" as const, spfPolicy: "pass", dmarcPolicy: "reject",
    };
    const n0 = deterministicNarrative(zero);
    expect(n0).not.toMatch(/impersonation .*observed|has been observed/i);
    expect(n0).toMatch(/no active threats/i);
    const p0 = deterministicPlan(zero);
    expect(p0).not.toMatch(/takedown|social|LinkedIn/i);
    expect(p0.length).toBeGreaterThanOrEqual(80);
    expect(n0.length).toBeGreaterThanOrEqual(60);

    const hot = { ...zero, totalThreats: 7, registeredLookalikes: 3, emailGrade: "D" as const, spfPolicy: "soft", dmarcPolicy: "none" };
    expect(deterministicNarrative(hot)).toMatch(/7 active threats/);
    expect(deterministicPlan(hot)).toMatch(/takedowns/);
  });

  it("zero-count report: no impersonation claim in findings", async () => {
    stubNetwork();
    const s = makeEnv((sql) => (/registered_lookalikes, public_view/.test(sql)
      ? { registered_lookalikes: "[]", public_view: STORED_VIEW }
      : null));
    const payload = await buildReportPayload(s.env, { domain: "acme.example", company: null, scanId: SCAN_ID });
    expect(payload.active_threats.total).toBe(0);
    expect(payload.executive_summary.key_findings.join(" ")).toMatch(/No active threats or registered lookalike domains/);
    // No brand row → no threat queries at all.
    expect(s.calls.some((c) => /FROM threats/.test(c.sql))).toBe(false);
  });
});

// ─── 5. Lead capture: consent + auto-delivery ──────────────────────────

describe("POST /api/leads validation", () => {
  const ok = { email: "pat@acme.example", domain: "acme.example", scan_id: SCAN_ID, consent: true };
  const writes = (calls: Call[]) => calls.filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.sql));

  it.each([
    ["consent missing", { ...ok, consent: undefined }],
    ["consent false", { ...ok, consent: false }],
    ["consent as string", { ...ok, consent: "true" }],
    ["invalid email", { ...ok, email: "not-an-email" }],
    ["free-mail", { ...ok, email: "pat@gmail.com" }],
    ["bad domain", { ...ok, domain: "<b>.com" }],
    ["bad scan id", { ...ok, scan_id: "s1" }],
  ])("%s → 400, nothing written or sent", async (_n, body) => {
    const net = stubNetwork();
    const s = makeEnv();
    const res = await handleLeadCapture(jsonReq("/api/leads", body), s.env);
    expect(res.status).toBe(400);
    expect(writes(s.calls)).toEqual([]);
    expect(net.sent).toEqual([]);
  });
});

describe("POST /api/leads auto-delivery", () => {
  function leadEnv(kv: Record<string, string> = {}) {
    return makeEnv((sql) => {
      if (/SELECT id FROM brand_scans WHERE id = \? AND domain = \?/.test(sql)) return { id: SCAN_ID };
      return reportResponder()(sql, []);
    }, kv);
  }
  const prospectMail = (sent: Sent[], email: string) => sent.filter((m) => m.to.includes(email));

  async function capture(email: string, extra: Record<string, unknown> = {}, opts: { resendOk?: boolean; kv?: Record<string, string> } = {}) {
    const net = stubNetwork({ resendOk: opts.resendOk });
    const s = leadEnv(opts.kv);
    const res = await handleLeadCapture(jsonReq("/api/leads", { email, domain: "acme.example", scan_id: SCAN_ID, consent: true, ...extra }), s.env);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Record<string, unknown> };
    return { body, s, net };
  }

  it("matching domain → report generated and its link emailed (delivery: emailed)", async () => {
    const { body, s, net } = await capture("Pat@Acme.Example");
    expect(body).toEqual({ success: true, data: { delivery: "emailed" } });
    const report = s.calls.find((c) => /INSERT INTO qualified_reports/.test(c.sql))!;
    expect(report.binds[6]).toBe("auto:lead_capture");
    const mine = prospectMail(net.sent, "pat@acme.example");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.html).toContain(`https://averrow.com/qualified-report/${report.binds[3] as string}`);
    // Sales still hears about it.
    expect(net.sent.some((m) => m.to.includes("sales@averrow.com"))).toBe(true);
    // Lead row links the scan + consent.
    const lead = s.calls.find((c) => /INSERT INTO scan_leads/.test(c.sql))!;
    expect(lead.sql).toMatch(/scan_id, consent_at/);
    expect(lead.binds).toContain(SCAN_ID);
  });

  it("subdomain of the scanned domain also matches", async () => {
    const { body } = await capture("pat@mail.acme.example");
    expect(body.data.delivery).toBe("emailed");
  });

  it("non-matching domain → team_follow_up, no report, short confirmation without any caller name", async () => {
    const { body, s, net } = await capture("pat@agency.example", { name: "Patricia Smith", company: "Agency Co" });
    expect(body.data).toEqual({ delivery: "team_follow_up" });
    expect(s.calls.some((c) => /INSERT INTO qualified_reports/.test(c.sql))).toBe(false);
    const mine = prospectMail(net.sent, "pat@agency.example");
    expect(mine).toHaveLength(1);
    const all = `${mine[0]!.subject}\n${mine[0]!.html}\n${mine[0]!.text}`;
    expect(all).not.toMatch(/Patricia|Smith|Agency Co/);
    expect(all).not.toMatch(/check your inbox|qualified-report|Threat Interceptor|Defense Grade|Intercept|AI-first/i);
    expect(all).toMatch(/follow up/);
  });

  it("report email failure falls back to team_follow_up", async () => {
    const { body } = await capture("pat@acme.example", {}, { resendOk: false });
    expect(body.data.delivery).toBe("team_follow_up");
  });

  it("per-address daily cap: no prospect email, team_follow_up", async () => {
    const { body, s, net } = await capture("pat@acme.example", {}, { kv: { "lead:mail:pat@acme.example": "3" } });
    expect(body.data.delivery).toBe("team_follow_up");
    expect(prospectMail(net.sent, "pat@acme.example")).toEqual([]);
    expect(s.calls.some((c) => /INSERT INTO qualified_reports/.test(c.sql))).toBe(false);
  });

  it("emailMatchesScannedDomain edge cases", () => {
    expect(emailMatchesScannedDomain("a@acme.example", "www.acme.example")).toBe(true);
    expect(emailMatchesScannedDomain("a@notacme.example", "acme.example")).toBe(false);
    expect(emailMatchesScannedDomain("a@acme.example.evil.test", "acme.example")).toBe(false);
    expect(emailMatchesScannedDomain("a@foo.co.uk", "co.uk")).toBe(false);
    expect(emailMatchesScannedDomain("a@co.uk", "co.uk")).toBe(true);
    expect(emailMatchesScannedDomain("a@shop.acme.co.uk", "acme.co.uk")).toBe(true);
  });
});

// ─── 6. Retention ──────────────────────────────────────────────────────

describe("brand_scans retention", () => {
  it("deletes in batches by created_at older than 90 days until a short batch", async () => {
    const changes = [500, 500, 37];
    const s = makeEnv((sql) => (/DELETE FROM brand_scans/.test(sql) ? { changes: changes.shift() ?? 0 } : null));
    const r = await purgeExpiredBrandScans(s.env);
    expect(r).toEqual({ deleted: 1037, batches: 3, more_remaining: false, error: null });
    expect(s.calls).toHaveLength(3);
    for (const c of s.calls) {
      expect(c.sql).toBe(BRAND_SCAN_PURGE_SQL);
      expect(c.binds).toEqual(["-90 days", 500]);
    }
    expect(BRAND_SCAN_PURGE_SQL).toMatch(/created_at < datetime\('now', \?\)/);
    expect(BRAND_SCAN_PURGE_SQL).not.toMatch(/scan_leads/);
  });

  it("stops at maxBatches and reports more_remaining; captures errors", async () => {
    const s = makeEnv(() => ({ changes: 10 }));
    expect(await purgeExpiredBrandScans(s.env, { batchSize: 10, maxBatches: 2 })).toMatchObject({ deleted: 20, batches: 2, more_remaining: true });
    const bad = { DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as Env;
    expect(await purgeExpiredBrandScans(bad)).toMatchObject({ deleted: 0, error: "d1 down" });
  });

  it("Navigator calls it from the hour-0 maintenance block (hour-only gate)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/cron/navigator.ts", import.meta.url), "utf8");
    const i = src.indexOf("brandScanPurgeResult = await purgeExpiredBrandScans");
    expect(i).toBeGreaterThan(0);
    const gate = src.lastIndexOf("if (", i);
    expect(src.slice(gate, i)).toMatch(/scheduledTime\.getUTCHours\(\) === 0/);
    expect(src.slice(gate, i)).not.toMatch(/getUTCMinutes/);
  });
});

// ─── 7. Routes ─────────────────────────────────────────────────────────

describe("route changes", () => {
  function router(): RouterType<IRequest> {
    const r = Router();
    registerScanRoutes(r);
    registerPublicRoutes(r);
    return r;
  }
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  beforeEach(() => { stubNetwork(); });

  it("GET /assess/:id/results → 301 /scan/?id=:id", async () => {
    const s = makeEnv();
    const res = (await router().fetch(new Request(`https://averrow.com/assess/${SCAN_ID}/results`), s.env, ctx)) as Response;
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`https://averrow.com/scan/?id=${SCAN_ID}`);
  });

  it("POST /assess runs the scan and 303s to /scan/?id=<new id>", async () => {
    const s = makeEnv();
    const req = new Request("https://averrow.com/assess", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.7" },
      body: new URLSearchParams({ domain: "acme.example" }).toString(),
    });
    const res = (await router().fetch(req, s.env, ctx)) as Response;
    expect(res.status).toBe(303);
    const insert = s.calls.find((c) => /INSERT INTO brand_scans/.test(c.sql))!;
    expect(res.headers.get("Location")).toBe(`https://averrow.com/scan/?id=${insert.binds[0] as string}`);
  });

  it("GET /scan is no longer a Worker route — it falls through to static assets", async () => {
    const s = makeEnv();
    const res = (await router().fetch(new Request("https://averrow.com/scan"), s.env, ctx)) as Response;
    expect(s.assets.fetch).toHaveBeenCalled();
    expect(await res.text()).toBe("static scan page");
  });
});
