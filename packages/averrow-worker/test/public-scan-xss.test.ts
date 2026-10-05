// Stored XSS + detection-oracle fix for the public brand scan
// (2026-10-05).
//
//   1. POST /assess, POST /api/brand-scan/public and POST /api/leads reject
//      a domain that is not a strict hostname, with no DB write.
//   2. The public scan JSON no longer carries the feed-mention flag, and the
//      public result lookup no longer selects feed_mentions.
//   3. The /assess results page escapes the stored domain / error text it
//      puts into innerHTML, and the scan id can't break out of <script>.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerScanRoutes } from "../src/routes/scan";
import { registerPublicRoutes } from "../src/routes/public";
import {
  handlePublicBrandScan, handlePublicBrandScanResult, handleLeadCapture,
} from "../src/handlers/brandScan";
import { renderAssessResults, renderHomepage } from "../src/templates/homepage";
import { renderScanPage } from "../src/templates/scan";
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
    expect(Object.keys(body.data).sort()).toEqual(["domain", "lookalikesPossible", "riskLevel", "trustScore"]);
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
  it("does not return feed_mentions (read server-side only to strip it from the score)", async () => {
    const s = makeEnv([], {
      id: "s1", domain: "acme.example", trust_score: 70, spf_policy: null, dmarc_policy: null,
      feed_mentions: 3, lookalikes_found: 0, status: "completed", created_at: "2026-10-05",
    });
    const res = await handlePublicBrandScanResult(new Request("https://averrow.com/api/brand-scan/public/s1"), s.env, "s1");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty("feed_mentions");
  });
});

describe("POST /api/leads (handleLeadCapture)", () => {
  const lead = { name: "Pat", email: "pat@acme.example", company: "Acme" };

  it("rejects a malicious domain with 400 and writes nothing", async () => {
    const s = makeEnv();
    const res = await handleLeadCapture(jsonReq("/api/leads", { ...lead, domain: MALICIOUS }), s.env);
    expect(res.status).toBe(400);
    expect(writes(s)).toEqual([]);
  });

  it("stores the normalised domain when valid, and accepts a missing domain", async () => {
    const s = makeEnv();
    const res = await handleLeadCapture(jsonReq("/api/leads", { ...lead, domain: " https://Acme.Example/ " }), s.env);
    expect(res.status).toBe(200);
    const insert = s.binds.find((b) => b.includes("pat@acme.example"));
    expect(insert).toContain("acme.example");

    const s2 = makeEnv();
    expect((await handleLeadCapture(jsonReq("/api/leads", lead), s2.env)).status).toBe(200);
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

// ─── Results page: run the inline script against a tiny fake DOM ────────

interface FakeEl { innerHTML: string; style: Record<string, string>; textContent: string; addEventListener: () => void }

async function runAssessPage(scanId: string, apiResponse: unknown): Promise<{ results: string; fetchedUrl: string }> {
  const html = renderAssessResults(scanId);
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(m).not.toBeNull();
  const els: Record<string, FakeEl> = {};
  const document = {
    getElementById(id: string): FakeEl {
      els[id] ??= { innerHTML: "", style: {}, textContent: "", addEventListener() {} };
      return els[id]!;
    },
  };
  let fetchedUrl = "";
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const fakeFetch = (url: string) => {
    fetchedUrl = url;
    const p = Promise.resolve({ json: () => Promise.resolve(apiResponse) });
    // Resolve after the page's .then chain has run.
    p.then(() => setTimeout(done, 0));
    return p;
  };
  new Function("document", "fetch", m![1]!)(document, fakeFetch);
  await finished;
  return { results: els["results"]?.innerHTML ?? "", fetchedUrl };
}

describe("renderAssessResults — output escaping", () => {
  it("escapes a malicious stored domain everywhere it is rendered", async () => {
    const { results } = await runAssessPage("s1", {
      success: true,
      data: { domain: MALICIOUS, trust_score: 30, spf_policy: '"><svg onload=alert(1)>', dmarc_policy: null, risk_level: "critical" },
    });
    expect(results).not.toContain("<img");
    expect(results).not.toContain("<svg onload");
    expect(results).toContain("&lt;img src=x onerror=alert(1)&gt;.com");
    expect(results).toContain("&quot;&gt;&lt;svg onload=alert(1)&gt;");
  });

  it("escapes the API error text", async () => {
    const { results } = await runAssessPage("s1", { success: false, error: "<img src=x onerror=alert(1)>" });
    expect(results).not.toContain("<img");
    expect(results).toContain("&lt;img");
  });

  it("does not render a feed-mention / active-threats pill", async () => {
    const { results } = await runAssessPage("s1", {
      success: true,
      data: { domain: "acme.example", trust_score: 60, feed_mentions: 12, risk_level: "medium" },
    });
    expect(results).not.toMatch(/active threats/i);
    expect(results).not.toContain("12");
  });

  it("encodes the scan id so a path param can't close the script element", async () => {
    const evil = "</script><script>alert(1)</script>";
    const html = renderAssessResults(evil);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    expect(script).not.toContain("</script");
    expect(script).toContain("\\u003c/script\\u003e");
    const { fetchedUrl } = await runAssessPage(evil, { success: false });
    expect(fetchedUrl).toBe("/api/brand-scan/public/" + encodeURIComponent(evil));
  });
});

describe("/scan and homepage widget templates", () => {
  it("/scan page no longer renders a feed-mention pill and escapes with a full entity map", () => {
    const html = renderScanPage();
    expect(html).not.toContain("feedMentions");
    expect(html).not.toMatch(/Active threats detected/);
    expect(html).toContain("'<': '&lt;'");
    expect(html).toContain("'\"': '&quot;'");
  });

  it("homepage scan widget escapes the domain, error text and pills, and drops the feed pill", () => {
    const html = renderHomepage();
    expect(html).not.toContain("feedMentions");
    expect(html).toContain(">Scanning ' + esc(domain)");
    expect(html).toContain("esc(data.error || 'Unknown error')");
    expect(html).toContain("'<div class=\"result-domain\">' + esc(domain)");
    expect(html).toContain("esc(r.text)");
  });
});
