// D1 step 1 (2026-11-22) — query-plan pins + behaviour for the rewrites of
// the worst recurring full scans on the main DB.
//
//   1. cloudflare_scanner Phase 1: the candidate read is a created_at index
//      range capped at CF_SCAN_CANDIDATE_CAP rows (was a full threats scan +
//      temp-B-tree sort per run); Phase 2 seeks the partial
//      idx_threats_cf_scan (0016). The old Phase 1 plan is pinned as a full
//      SCAN so the comparison stays honest.
//   2. cloudflare_scanner auth gate: 401/403 fails the pull BEFORE any D1
//      read, caches the verdict per token fingerprint, and a cached verdict
//      throws without a request; a 403 on the first submit fails the same way.
//   3. system-health 14-day trend: threatTrend14d returns exactly the rows of
//      the original single GROUP BY, and its three reads are created_at
//      index ranges (the closed-day read is cached per UTC date).
//
// Plans come from the fully migrated schema (every index prod has) with
// ANALYZE stats over a seeded threats table.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import {
  cloudflare_scanner,
  CF_SCAN_CANDIDATES_SQL,
  CF_SCAN_PENDING_SQL,
  CF_SCAN_CANDIDATE_CAP,
  CF_SCAN_SUBMIT_LIMIT,
  CF_SCAN_POLL_LIMIT,
  CF_AUTH_PROBE_PATH,
  CfScannerAuthError,
  cfAuthDeniedKey,
  resolveScannerToken,
} from "../src/feeds/cloudflare_scanner";
import { threatTrend14d, threatTrendBounds } from "../src/handlers/admin/health";
import { pressureAggregate, TOP_TYPOSQUAT_BRANDS_SQL, BRAND_AGGREGATE_TTL_S } from "../src/lib/brand-aggregates";
import type { Env } from "../src/types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-22T15:30:45Z");
const TOTAL = 24_000;
const SPAN_DAYS = 40;

const sqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

function seed(db: SqliteDb): void {
  let x = 11;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const types = ["phishing", "typosquatting", "c2", "malware_distribution", "scanning"];
  db.exec("BEGIN");
  const s = db.prepare(`INSERT INTO threats (id, created_at, first_seen, status, severity, threat_type, source_feed,
      malicious_url, malicious_domain, ioc_value, target_brand_id, cf_scan_id, cf_verdict)
    VALUES (?, ?, ?, 'active', 'high', ?, 'phishtank', ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < TOTAL; i++) {
    const ms = NOW - Math.floor(rnd() * SPAN_DAYS * DAY);
    // A few rows stored in ISO format, as some writers do.
    const created = i % 97 === 0 ? new Date(ms).toISOString() : sqliteUtc(ms);
    const scanned = rnd() < 0.002; // prod: 99.9%+ never submitted
    s.run(`t${String(i).padStart(6, "0")}`, created, created, types[i % types.length]!,
      rnd() < 0.9 ? `https://h${i}.example/login` : null, `h${i}.example`, `h${i}.example`,
      rnd() < 0.2 ? `b${i % 50}` : null,
      scanned ? `scan-${i}` : null, scanned && rnd() < 0.5 ? "clean" : null);
  }
  db.exec("COMMIT");
  db.exec("ANALYZE");
}

function plan(raw: SqliteDb, sql: string, binds: unknown[]): string {
  return (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");
}

const OLD_PHASE1_SQL = `SELECT id, malicious_url FROM threats
       WHERE cf_scan_id IS NULL
         AND malicious_url IS NOT NULL
       ORDER BY
         CASE WHEN target_brand_id IS NOT NULL THEN 0 ELSE 1 END,
         CASE WHEN threat_type = 'phishing' THEN 0
              WHEN threat_type = 'typosquatting' THEN 1
              WHEN threat_type = 'c2' THEN 2
              ELSE 3 END,
         created_at DESC
       LIMIT 50`;

const OLD_TREND_SQL = `SELECT date(created_at) as day, COUNT(*) as count
        FROM threats
        WHERE created_at >= ?
        GROUP BY date(created_at)
        ORDER BY day ASC`;

describe.skipIf(!hasSqlite())("D1 step 1 — query plans on the migrated schema", () => {
  let raw: SqliteDb;
  beforeAll(() => {
    raw = openMigratedDb();
    seed(raw);
  }, 120_000);

  it("old cf_scanner Phase 1 visited every row with a URL, then sorted them all (baseline)", () => {
    const p = plan(raw, OLD_PHASE1_SQL, []);
    // Either a bare SCAN or the `malicious_url IS NOT NULL` range on
    // idx_threats_malicious_url (0278) — ~90% of the table either way (prod:
    // ~1.09M rows read per call), each looked up, then a temp B-tree sort.
    expect(p).toMatch(/SCAN threats|SEARCH threats USING INDEX idx_threats_malicious_url \(malicious_url>\?\)/);
    expect(p).toMatch(/USE TEMP B-TREE FOR ORDER BY/);
    const withUrl = (raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE malicious_url IS NOT NULL").get() as { n: number }).n;
    expect(withUrl / TOTAL).toBeGreaterThan(0.85);
  });

  it("new cf_scanner Phase 1 is a created_at index range capped at CF_SCAN_CANDIDATE_CAP", () => {
    const windowStart = sqliteUtc(NOW - 3 * DAY);
    const p = plan(raw, CF_SCAN_CANDIDATES_SQL, [windowStart, CF_SCAN_CANDIDATE_CAP, CF_SCAN_SUBMIT_LIMIT]);
    expect(p).toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_created\w* \(created_at>\?\)/);
    expect(p).not.toMatch(/SCAN threats(?! USING)/);
    // The priority sort applies to the (≤ cap) subquery rows only.
    expect(p).toMatch(/SCAN recent/);
  });

  it("new cf_scanner Phase 1 returns the same rows as the old query restricted to the window", () => {
    const windowStart = sqliteUtc(NOW - 3 * DAY);
    const got = raw.prepare(CF_SCAN_CANDIDATES_SQL).all(windowStart, CF_SCAN_CANDIDATE_CAP, CF_SCAN_SUBMIT_LIMIT);
    // The window holds < cap rows here, so the cap does not bite and the
    // result must equal the old ordering over the windowed set.
    const inWindow = (raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE created_at >= ?").get(windowStart) as { n: number }).n;
    expect(inWindow).toBeLessThan(CF_SCAN_CANDIDATE_CAP);
    const want = raw.prepare(OLD_PHASE1_SQL.replace("WHERE cf_scan_id IS NULL", "WHERE created_at >= ? AND cf_scan_id IS NULL")).all(windowStart);
    expect(got).toEqual(want);
    expect(got).toHaveLength(CF_SCAN_SUBMIT_LIMIT);
  });

  it("cf_scanner Phase 2 seeks the partial idx_threats_cf_scan (submitted rows only)", () => {
    const p = plan(raw, CF_SCAN_PENDING_SQL, [CF_SCAN_POLL_LIMIT]);
    expect(p).toMatch(/SEARCH threats USING INDEX idx_threats_cf_scan \(cf_scan_id>\?\)/);
  });

  it("old 14-day trend reads 14 days of threats; each new part reads one range", () => {
    const { edge, firstFullDay, today } = threatTrendBounds(NOW);
    expect(plan(raw, OLD_TREND_SQL, [edge])).toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_created\w* \(created_at>\?\)/);
    const two = /SEARCH threats USING (COVERING )?INDEX idx_threats_created\w* \(created_at>\? AND created_at<\?\)/;
    const closedSql = "SELECT date(created_at) AS day, COUNT(*) AS count FROM threats WHERE created_at >= ? AND created_at < ? GROUP BY date(created_at)";
    expect(plan(raw, closedSql, [firstFullDay, today])).toMatch(two);
    expect(plan(raw, closedSql, [edge, firstFullDay])).toMatch(two);
    expect(plan(raw, "SELECT date(created_at) AS day, COUNT(*) AS count FROM threats WHERE created_at >= ? GROUP BY date(created_at)", [today]))
      .toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_created\w* \(created_at>\?\)/);
  });

  it("threatTrend14d returns exactly the original GROUP BY's rows, and caches the closed days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const log: StatementLogEntry[] = [];
      const db = d1FromSqlite(raw, { log });
      const env = { DB: db, CACHE: fakeKv() } as unknown as Env;
      const { edge } = threatTrendBounds(NOW);
      const want = raw.prepare(OLD_TREND_SQL).all(edge);

      const first = await threatTrend14d(env, db, NOW);
      expect(first).toEqual(want);
      expect(first.length).toBeGreaterThanOrEqual(14);

      // Rows read per refill: the old query scanned the whole window.
      const windowRows = (raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE created_at >= ?").get(edge) as { n: number }).n;
      const reads = log.length;
      const second = await threatTrend14d(env, db, NOW);
      expect(second).toEqual(want);
      // Second call: closed days from KV, only the edge day + today re-read.
      expect(log.length - reads).toBe(2);
      const openRows = (raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE created_at >= ? AND created_at < ?").get(edge, threatTrendBounds(NOW).firstFullDay) as { n: number }).n
        + (raw.prepare("SELECT COUNT(*) AS n FROM threats WHERE created_at >= ?").get(threatTrendBounds(NOW).today) as { n: number }).n;
      expect(openRows * 5).toBeLessThan(windowRows);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pressure aggregate: a Navigator refresh of the 1h aggregate reuses the 6h typosquat ranking", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const log: StatementLogEntry[] = [];
      const env = { DB: d1FromSqlite(raw, { log }), CACHE: fakeKv() } as unknown as Env;
      const isTypo = (e: StatementLogEntry) => e.sql === TOP_TYPOSQUAT_BRANDS_SQL;
      const first = await pressureAggregate(env, { refresh: true });
      expect(log.filter(isTypo)).toHaveLength(1);
      expect(first.top_lookalikes).toEqual(raw.prepare(TOP_TYPOSQUAT_BRANDS_SQL).all());

      // Past the outer aggregate's TTL: social/app/dark-web are re-read,
      // the typosquat GROUP BY is not.
      vi.setSystemTime(NOW + (BRAND_AGGREGATE_TTL_S + 60) * 1000);
      const before = log.length;
      const second = await pressureAggregate(env, { refresh: true });
      expect(log.length - before).toBe(3);
      expect(log.filter(isTypo)).toHaveLength(1);
      expect(second.top_lookalikes).toEqual(first.top_lookalikes);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── cloudflare_scanner auth gate ────────────────────────────────

interface FetchCall { url: string; method: string }

function stubFetch(handler: (url: string, method: string) => { status: number; body: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method });
    const { status, body } = handler(String(input), method);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  });
  return calls;
}

describe.skipIf(!hasSqlite())("cloudflare_scanner auth gate", () => {
  let raw: SqliteDb;
  beforeAll(() => {
    raw = openMigratedDb();
    seed(raw);
  }, 120_000);
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const ctxFor = (log: StatementLogEntry[], cache = fakeKv()) => ({
    env: { DB: d1FromSqlite(raw, { log }), CACHE: cache, CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok-1" } as unknown as Env,
    feedName: "cloudflare_scanner",
    feedUrl: "",
    cache,
  });

  it("probe 403 → throws CfScannerAuthError before any D1 read and caches the verdict", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = stubFetch(() => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } }));
    const log: StatementLogEntry[] = [];
    const ctx = ctxFor(log);
    await expect(cloudflare_scanner.ingest(ctx)).rejects.toThrow("CF URL Scanner: CF_API_TOKEN lacks Account › URL Scanner › Edit (HTTP 403)");
    expect(calls).toEqual([{ url: `https://api.cloudflare.com/client/v4/accounts/acct/urlscanner${CF_AUTH_PROBE_PATH}`, method: "GET" }]);
    expect(log).toEqual([]);
    expect(ctx.cache.store.get(await cfAuthDeniedKey("tok-1"))).toBe("403");
    // The token itself is never part of the key.
    expect([...ctx.cache.store.keys()].some((k) => k.includes("tok-1"))).toBe(false);

    // Next tick: no request, no D1, same failure.
    const log2: StatementLogEntry[] = [];
    const ctx2 = { ...ctxFor(log2, ctx.cache) };
    await expect(cloudflare_scanner.ingest(ctx2)).rejects.toBeInstanceOf(CfScannerAuthError);
    expect(calls).toHaveLength(1);
    expect(log2).toEqual([]);
  });

  it("prefers CF_OPS_API_TOKEN, falls back to CF_API_TOKEN, and names the secret in the auth error", async () => {
    expect(resolveScannerToken({ CF_OPS_API_TOKEN: "ops", CF_API_TOKEN: "shared" })).toEqual({ token: "ops", tokenName: "CF_OPS_API_TOKEN" });
    expect(resolveScannerToken({ CF_OPS_API_TOKEN: "  ", CF_API_TOKEN: "shared" })).toEqual({ token: "shared", tokenName: "CF_API_TOKEN" });
    expect(resolveScannerToken({})).toEqual({ token: undefined, tokenName: "CF_API_TOKEN" });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>).Authorization));
      return new Response("denied", { status: 403 });
    });
    const log: StatementLogEntry[] = [];
    const base = ctxFor(log);
    const ctx = { ...base, env: { ...base.env, CF_OPS_API_TOKEN: "ops-tok" } as Env };
    await expect(cloudflare_scanner.ingest(ctx)).rejects.toThrow(
      "CF URL Scanner: CF_OPS_API_TOKEN lacks Account › URL Scanner › Edit (HTTP 403)",
    );
    expect(seen).toEqual(["Bearer ops-tok"]);
    expect(log).toEqual([]);
    expect(base.cache.store.has(await cfAuthDeniedKey("ops-tok"))).toBe(true);
  });

  it("a rotated token is probed again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = fakeKv({ [await cfAuthDeniedKey("old-token")]: "403" });
    const calls = stubFetch(() => ({ status: 503, body: "upstream down" }));
    const log: StatementLogEntry[] = [];
    const ctx = ctxFor(log, cache);
    await expect(cloudflare_scanner.ingest(ctx)).rejects.toThrow(/auth probe failed \(HTTP 503\)/);
    expect(calls).toHaveLength(1);
    expect(log).toEqual([]);
    // A transient probe failure is not cached.
    expect(cache.store.has(await cfAuthDeniedKey("tok-1"))).toBe(false);
  });

  it("probe 404 → runs; a 403 on the first submit fails the pull and is cached", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = stubFetch((url, method) => (method === "POST" ? { status: 403, body: "denied" } : { status: 404, body: "" }));
    const log: StatementLogEntry[] = [];
    const ctx = ctxFor(log);
    await expect(cloudflare_scanner.ingest(ctx)).rejects.toBeInstanceOf(CfScannerAuthError);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(ctx.cache.store.get(await cfAuthDeniedKey("tok-1"))).toBe("403");
    // Only the bounded candidate read + the safe-domain list ran; no writes.
    expect(log.map((e) => e.sql.replace(/\s+/g, " ").trim().slice(0, 40))).toEqual([
      "SELECT id, malicious_url FROM ( SELECT i",
      "SELECT domain FROM brand_safe_domains",
    ]);
  });

  it("happy path: submits recent threats only, polls, writes one summary diagnostic", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(NOW);
    const submittedUrls: string[] = [];
    stubFetch((url, method) => {
      if (method === "POST") return { status: 200, body: { success: true, result: { uuid: `u-${submittedUrls.length}` } } };
      return { status: 404, body: "" };
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") submittedUrls.push(JSON.parse(String(init.body)).url as string);
      return realFetch(input, init);
    });
    const log: StatementLogEntry[] = [];
    const ctx = ctxFor(log);
    const run = cloudflare_scanner.ingest(ctx);
    let done = false;
    void run.finally(() => { done = true; }).catch(() => {});
    while (!done) await vi.advanceTimersByTimeAsync(1_000);
    const result = await run;

    expect(submittedUrls).toHaveLength(CF_SCAN_SUBMIT_LIMIT);
    const windowStart = sqliteUtc(NOW - 3 * DAY);
    for (const u of submittedUrls) {
      const row = raw.prepare("SELECT created_at, cf_scan_id FROM threats WHERE malicious_url = ?").get(u) as { created_at: string; cf_scan_id: string };
      expect(row.created_at >= windowStart).toBe(true);
      expect(row.cf_scan_id).toMatch(/^u-/);
    }
    const diags = log.filter((e) => /INSERT INTO agent_outputs/.test(e.sql));
    expect(diags).toHaveLength(1);
    expect(result.itemsError).toBe(0);
  });
});
