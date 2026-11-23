// cloudflare_scanner against the real URL Scanner v2 response shapes
// (2026-11-23). Prod logged `submitted=0, errors=31..42` every run because
// the submit path read the v1 envelope (`success` + `result.uuid`) while v2
// `POST /v2/scan` answers with a TOP-LEVEL `{ uuid, api, visibility, url,
// message, result: "<report URL>" }`. Every accepted scan counted as an
// error, cf_scan_id was never stored and the same URLs were resubmitted
// every hour. v2 `GET /v2/result/{uuid}` is 404 while running and 200 with
// top-level `task`, `page`, `verdicts` when done.

import { describe, it, expect, afterEach, vi } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import {
  cloudflare_scanner,
  parseSubmitUuid,
  parseScanResult,
  cfErrorMessage,
  CF_AUTH_PROBE_PATH,
} from "../src/feeds/cloudflare_scanner";
import type { Env } from "../src/types";

const NOW = Date.parse("2026-11-23T10:07:00Z");
const sqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const UUID_A = "095be615-a8ad-4c33-8e9c-c7612fbf6c9f";
const UUID_B = "1c2d3e4f-0000-4c33-8e9c-c7612fbf6c90";

/** v2 submit 200 (developers.cloudflare.com/radar/investigate/url-scanner). */
const v2Submit = (uuid: string, url: string) => ({
  uuid,
  api: `https://api.cloudflare.com/client/v4/accounts/acct/urlscanner/v2/result/${uuid}`,
  visibility: "unlisted",
  url,
  message: "Submission successful",
  result: `https://radar.cloudflare.com/scan/${uuid}`,
  options: { useragent: "Mozilla/5.0" },
});

/** v2 result 200 (finished scan), trimmed to the fields the module reads plus neighbours. */
const v2Result = (uuid: string, opts: { malicious: boolean; categories?: string[]; country?: string; ip?: string; success?: boolean }) => ({
  task: {
    uuid,
    url: "https://login-acme.example/",
    domain: "login-acme.example",
    apexDomain: "login-acme.example",
    success: opts.success ?? true,
    status: "Finished",
    visibility: "unlisted",
    time: "2026-11-23T10:00:00.000Z",
  },
  page: {
    url: "https://login-acme.example/",
    domain: "login-acme.example",
    ip: opts.ip ?? "203.0.113.7",
    country: opts.country ?? "NL",
    asn: "AS64500",
    status: "200",
  },
  verdicts: {
    overall: { malicious: opts.malicious, hasVerdicts: opts.malicious, categories: opts.categories ?? [], tags: [] },
  },
  meta: { processors: { phishing: opts.malicious ? ["Acme"] : [] } },
  lists: { ips: [opts.ip ?? "203.0.113.7"] },
});

describe("parseSubmitUuid", () => {
  it("reads the v2 top-level uuid (its `result` is a report URL string, not an envelope)", () => {
    expect(parseSubmitUuid(v2Submit(UUID_A, "https://x.example/"))).toBe(UUID_A);
  });
  it("still accepts the v1 envelope", () => {
    expect(parseSubmitUuid({ success: true, result: { uuid: UUID_B } })).toBe(UUID_B);
    expect(parseSubmitUuid({ success: false, result: { uuid: UUID_B } })).toBeNull();
  });
  it("rejects bodies with no usable id", () => {
    expect(parseSubmitUuid(null)).toBeNull();
    expect(parseSubmitUuid({ message: "Submission successful" })).toBeNull();
    expect(parseSubmitUuid({ uuid: "" })).toBeNull();
    expect(parseSubmitUuid({ uuid: "has space" })).toBeNull();
  });
});

describe("parseScanResult", () => {
  it("maps a finished malicious v2 scan to a verdict with categories, ip and country", () => {
    expect(parseScanResult(v2Result(UUID_A, { malicious: true, categories: ["Phishing"] }))).toEqual({
      kind: "verdict", malicious: true, categories: ["Phishing"], ip: "203.0.113.7", country: "NL",
    });
  });
  it("maps a finished benign v2 scan to malicious=false", () => {
    expect(parseScanResult(v2Result(UUID_A, { malicious: false }))).toMatchObject({ kind: "verdict", malicious: false, categories: [] });
  });
  it("a failed task (DNS error, blocked fetch) or a body with no verdicts is 'failed'", () => {
    expect(parseScanResult(v2Result(UUID_A, { malicious: false, success: false }))).toEqual({ kind: "failed" });
    expect(parseScanResult({ task: { uuid: UUID_A, status: "Finished", success: true }, page: {} })).toEqual({ kind: "failed" });
    expect(parseScanResult({ success: false, errors: [{ message: "scan failed" }] })).toEqual({ kind: "failed" });
  });
  it("a 200 still Queued / InProgress is pending", () => {
    expect(parseScanResult({ task: { uuid: UUID_A, status: "InProgress" } })).toEqual({ kind: "pending" });
    expect(parseScanResult({ task: { uuid: UUID_A, status: "Queued" } })).toEqual({ kind: "pending" });
  });
  it("only stores a 2-letter country code and an IP-shaped page.ip", () => {
    expect(parseScanResult(v2Result(UUID_A, { malicious: false, country: "Netherlands", ip: "not an ip" })))
      .toMatchObject({ country: null, ip: null });
    expect(parseScanResult(v2Result(UUID_A, { malicious: false, country: "us", ip: "2001:db8::1" })))
      .toMatchObject({ country: "US", ip: "2001:db8::1" });
  });
  it("still accepts the v1 envelope", () => {
    expect(parseScanResult({ success: true, result: { scan: { verdicts: { overall: { malicious: true, categories: ["Malware"] } }, page: { ip: "198.51.100.1", country: "DE" } } } }))
      .toEqual({ kind: "verdict", malicious: true, categories: ["Malware"], ip: "198.51.100.1", country: "DE" });
  });
});

describe("cfErrorMessage", () => {
  it("prefers errors[].message / title / detail, then top-level fields, then raw; truncates", () => {
    expect(cfErrorMessage(JSON.stringify({ success: false, errors: [{ code: 1, message: "DNS Error - Could not resolve domain." }] })))
      .toBe("DNS Error - Could not resolve domain.");
    expect(cfErrorMessage(JSON.stringify({ errors: [{ title: "Scan prevented", detail: "x" }] }))).toBe("Scan prevented");
    expect(cfErrorMessage(JSON.stringify({ message: "Too many requests" }))).toBe("Too many requests");
    expect(cfErrorMessage("upstream\n  down")).toBe("upstream down");
    expect(cfErrorMessage("x".repeat(500), 20)).toBe(`${"x".repeat(20)}…`);
  });
});

// ─── ingest() against v2 responses ───────────────────────────────

type Handler = (url: string, method: string, body: string | undefined) => { status: number; body: unknown };

function stubFetch(handler: Handler): Array<{ url: string; method: string }> {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method });
    const { status, body } = handler(String(input), method, init?.body as string | undefined);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return calls;
}

async function runIngest(db: SqliteDb) {
  const ctx = {
    env: { DB: d1FromSqlite(db), CACHE: fakeKv(), CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok-1" } as unknown as Env,
    feedName: "cloudflare_scanner",
    feedUrl: "",
  };
  const run = cloudflare_scanner.ingest(ctx);
  let done = false;
  void run.finally(() => { done = true; }).catch(() => {});
  while (!done) await vi.advanceTimersByTimeAsync(1_000);
  return run;
}

function lastDiag(db: SqliteDb): { summary: string; details: Record<string, unknown> } {
  const row = db.prepare("SELECT summary, details FROM agent_outputs WHERE id LIKE 'diag_cf_done_%' ORDER BY rowid DESC LIMIT 1")
    .get() as { summary: string; details: string };
  return { summary: row.summary, details: JSON.parse(row.details) as Record<string, unknown> };
}

const insertThreat = (db: SqliteDb, id: string, url: string, opts: { ageMs?: number; scanId?: string | null; confidence?: number } = {}) => {
  const c = sqliteUtc(NOW - (opts.ageMs ?? 3_600_000));
  const host = new URL(url).hostname;
  db.prepare(`INSERT INTO threats (id, created_at, first_seen, status, severity, threat_type, source_feed,
      malicious_url, malicious_domain, ioc_value, cf_scan_id, confidence_score)
    VALUES (?, ?, ?, 'active', 'high', 'phishing', 'phishtank', ?, ?, ?, ?, ?)`)
    .run(id, c, c, url, host, host, opts.scanId ?? null, opts.confidence ?? 40);
};

describe.skipIf(!hasSqlite())("cloudflare_scanner ingest — v2 shapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submit 200 with a top-level uuid stores cf_scan_id; result 404 keeps it pending (not error, not expired)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    const db = openMigratedDb();
    insertThreat(db, "t1", "https://login-acme.example/a");
    insertThreat(db, "t2", "https://login-acme2.example/b", { ageMs: 7_200_000 }); // older → submitted second, polled first
    const ids = [UUID_A, UUID_B];
    let n = 0;
    const calls = stubFetch((url, method, body) => {
      if (method === "POST") return { status: 200, body: v2Submit(ids[n++]!, JSON.parse(body!).url as string) };
      return { status: 404, body: { errors: [{ message: "Scan is not finished yet." }] } };
    });

    const result = await runIngest(db);
    const rows = db.prepare("SELECT id, cf_scan_id, cf_verdict FROM threats ORDER BY id").all();
    expect(rows).toEqual([
      { id: "t1", cf_scan_id: UUID_A, cf_verdict: null },
      { id: "t2", cf_scan_id: UUID_B, cf_verdict: null },
    ]);
    expect(result.itemsError).toBe(0);
    const { summary, details } = lastDiag(db);
    expect(summary).toMatch(/submitted=2, rejected=0, collected=0, pending=2, failed=0, expired=0, malicious=0, errors=0$/);
    expect(details).toMatchObject({ submitted: 2, pending: 2, errors: 0, first_submit_error: null, first_poll_error: null });

    // Next run: nothing is resubmitted (cf_scan_id is set), both are polled again.
    calls.length = 0;
    await runIngest(db);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(calls.filter((c) => c.method === "GET").map((c) => c.url.split("/").pop()))
      .toEqual([CF_AUTH_PROBE_PATH.split("/").pop(), UUID_B, UUID_A]);
  });

  it("result 200 maps malicious / benign verdicts: confidence, remediation, categories, ip + country backfill", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    const db = openMigratedDb();
    insertThreat(db, "bad", "https://bad.example/", { scanId: UUID_A, confidence: 40 });
    insertThreat(db, "ok", "https://ok.example/", { scanId: UUID_B, confidence: 40 });
    stubFetch((url) => {
      const id = url.split("/").pop();
      if (id === UUID_A) return { status: 200, body: v2Result(UUID_A, { malicious: true, categories: ["Phishing"], country: "NL", ip: "203.0.113.7" }) };
      if (id === UUID_B) return { status: 200, body: v2Result(UUID_B, { malicious: false, country: "United States" }) };
      return { status: 404, body: "" };
    });

    const result = await runIngest(db);
    const rows = db.prepare("SELECT id, cf_verdict, cf_categories, confidence_score, status, ip_address, country_code FROM threats ORDER BY id").all();
    expect(rows).toEqual([
      { id: "bad", cf_verdict: "malicious", cf_categories: '["Phishing"]', confidence_score: 90, status: "active", ip_address: "203.0.113.7", country_code: "NL" },
      // A country NAME is not written into country_code.
      { id: "ok", cf_verdict: "clean", cf_categories: null, confidence_score: 40, status: "remediated", ip_address: "203.0.113.7", country_code: null },
    ]);
    expect(result.itemsNew).toBe(2);
    expect(lastDiag(db).details).toMatchObject({ collected: 2, malicious: 1, errors: 0 });
  });

  it("result 200 with task.success=false retires the scan as 'failed' without touching confidence or status", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    const db = openMigratedDb();
    insertThreat(db, "dead", "https://dead.example/", { scanId: UUID_A, confidence: 40 });
    stubFetch((url) => (url.endsWith(UUID_A)
      ? { status: 200, body: v2Result(UUID_A, { malicious: false, success: false }) }
      : { status: 404, body: "" }));
    await runIngest(db);
    expect(db.prepare("SELECT cf_verdict, confidence_score, status FROM threats WHERE id = 'dead'").get())
      .toEqual({ cf_verdict: "failed", confidence_score: 40, status: "active" });
    expect(lastDiag(db).details).toMatchObject({ failed: 1, errors: 0 });
  });

  it("a 400 submit is terminal: cf_verdict='failed', recorded in details, never resubmitted", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    const db = openMigratedDb();
    insertThreat(db, "nx", "https://nx-domain.example/");
    const calls = stubFetch((_url, method) => (method === "POST"
      ? { status: 400, body: { success: false, errors: [{ code: 1, message: "DNS Error - Could not resolve domain." }] } }
      : { status: 404, body: "" }));

    const result = await runIngest(db);
    expect(db.prepare("SELECT cf_scan_id, cf_verdict FROM threats WHERE id = 'nx'").get()).toEqual({ cf_scan_id: null, cf_verdict: "failed" });
    expect(result.itemsError).toBe(0);
    const { details } = lastDiag(db);
    expect(details).toMatchObject({ rejected: 1, errors: 0, first_submit_rejection: { status: 400, message: "DNS Error - Could not resolve domain." } });

    calls.length = 0;
    await runIngest(db);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("a non-terminal submit failure records the FIRST error (status + CF message) in the diagnostic; 429 stops submitting", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = openMigratedDb();
    for (let i = 0; i < 5; i++) insertThreat(db, `r${i}`, `https://r${i}.example/`, { ageMs: 3_600_000 + i * 1000 });
    let posts = 0;
    stubFetch((_url, method) => {
      if (method !== "POST") return { status: 404, body: "" };
      posts++;
      if (posts === 1) return { status: 500, body: { errors: [{ message: "Internal error" }] } };
      return { status: 429, body: { errors: [{ message: "Rate limit exceeded" }] } };
    });

    const result = await runIngest(db);
    expect(posts).toBe(2); // stopped at the first 429
    expect(result.itemsError).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM threats WHERE cf_scan_id IS NULL AND cf_verdict IS NULL").get()).toEqual({ n: 5 });
    expect(lastDiag(db).details).toMatchObject({
      errors: 2,
      quota_hit: true,
      first_submit_error: { status: 500, message: "Internal error" },
    });
  });

  it("a 2xx submit body without a uuid is an error with the body head recorded", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = openMigratedDb();
    insertThreat(db, "w", "https://w.example/");
    stubFetch((_url, method) => (method === "POST" ? { status: 200, body: { message: "Submission queued" } } : { status: 404, body: "" }));
    await runIngest(db);
    expect(db.prepare("SELECT cf_scan_id, cf_verdict FROM threats WHERE id = 'w'").get()).toEqual({ cf_scan_id: null, cf_verdict: null });
    expect(lastDiag(db).details).toMatchObject({ errors: 1, first_submit_error: { status: 200, message: "no scan uuid in response: Submission queued" } });
  });
});
