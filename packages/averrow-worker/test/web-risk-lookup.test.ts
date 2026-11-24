// Web Risk Lookup (uris.search) client, quotas and the google_safe_browsing
// feed. The quota counter is the real D1 UPSERT (api_quota_counters,
// migration 0338) run on node:sqlite with the schema derived from migrations/.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

vi.mock("../src/lib/google-service-account", () => ({
  hasServiceAccount: vi.fn(),
  getGoogleAccessToken: vi.fn(),
  invalidateGoogleAccessToken: vi.fn(),
}));
// The contact scan's RDAP age check — not under test here.
vi.mock("../src/lib/whois", () => ({ rdapLookup: async () => null }));

import {
  webRiskLookupMonthlyCap, webRiskLookupContactDailyCap,
  WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT, WEB_RISK_LOOKUP_CONTACT_DAILY_CAP_DEFAULT,
  MONTH_BUCKET, CONTACT_DAY_BUCKET, monthPeriod, dayPeriod,
  mapSearchResponse, reserveLookups, webRiskLookup, webRiskLookupsRemaining,
} from "../src/lib/web-risk-lookup";
import { checkGoogleSafeBrowsing, google_safe_browsing } from "../src/feeds/googleSafeBrowsing";
import { notifyContactSubmission, contactNotifyKey } from "../src/lib/contact-notify";
import { hasServiceAccount, getGoogleAccessToken, invalidateGoogleAccessToken } from "../src/lib/google-service-account";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";
import type { FeedContext } from "../src/feeds/types";

const mockHasSA = vi.mocked(hasServiceAccount);
const mockToken = vi.mocked(getGoogleAccessToken);
const mockInvalidate = vi.mocked(invalidateGoogleAccessToken);

// ─── fakes ───────────────────────────────────────────────────────────

interface FakeKv { data: Map<string, string>; puts: string[] }

function fakeKv(seed: Record<string, string> = {}): FakeKv {
  return { data: new Map(Object.entries(seed)), puts: [] };
}

function kvBinding(kv: FakeKv) {
  return {
    get: async (key: string) => kv.data.get(key) ?? null,
    put: async (key: string, value: string) => { kv.puts.push(key); kv.data.set(key, value); },
    delete: async (key: string) => { kv.data.delete(key); },
  };
}

interface ThreatRow { id: string; malicious_url: string | null; malicious_domain: string | null }

/**
 * env.DB: statements on api_quota_counters (and the contact tables) run on
 * real SQLite; the feed's threats statements hit an in-memory fake that
 * records UPDATEs. `failQuota` makes every quota statement throw.
 */
function makeDb(raw: SqliteDb, rows: ThreatRow[] = [], opts: { failQuota?: boolean } = {}) {
  const real = d1FromSqlite(raw);
  const updates: { sql: string; binds: unknown[] }[] = [];
  let selects = 0;
  const fakeStmt = (sql: string, binds: unknown[]) => ({
    all: async () => { selects++; return { results: rows }; },
    run: async () => { updates.push({ sql, binds }); return { meta: { changes: 1 } }; },
    first: async () => ({ signals: 0 }),
  });
  const prepare = (sql: string) => {
    if (sql.includes("api_quota_counters")) {
      if (opts.failQuota) {
        const boom = async () => { throw new Error("D1 overloaded"); };
        const s = { bind: () => s, run: boom, first: boom, all: boom };
        return s;
      }
      return real.prepare(sql);
    }
    if (/contact_rate|lookalike_domains|FROM threats\s+WHERE\s+(\+?status)/.test(sql)) return real.prepare(sql);
    return { ...fakeStmt(sql, []), bind: (...binds: unknown[]) => fakeStmt(sql, binds) };
  };
  return { db: { prepare } as unknown as D1Database, updates, selects: () => selects };
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const fetchedUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));
const webRiskCalls = (): string[] => fetchedUrls().filter((u) => u.includes("googleapis.com"));

function listed(...threatTypes: string[]): Response {
  return new Response(JSON.stringify({ threat: { threatTypes, expireTime: "2026-12-01T00:00:00Z" } }), { status: 200 });
}
const notListed = (): Response => new Response("{}", { status: 200 });

let raw: SqliteDb;
let kv: FakeKv;

const used = (bucket = MONTH_BUCKET, period = monthPeriod(new Date())): number | null => {
  const r = raw.prepare("SELECT n FROM api_quota_counters WHERE bucket = ? AND period = ?").all(bucket, period) as Array<{ n: number }>;
  return r[0]?.n ?? null;
};
const setUsed = (n: number, bucket = MONTH_BUCKET, period = monthPeriod(new Date())): void => {
  raw.prepare(`INSERT INTO api_quota_counters (bucket, period, n) VALUES (?, ?, ?)
    ON CONFLICT(bucket, period) DO UPDATE SET n = excluded.n`).run(bucket, period, n);
};

function env(extra: Record<string, unknown> = {}, rows: ThreatRow[] = [], opts: { failQuota?: boolean } = {}) {
  const d = makeDb(raw, rows, opts);
  return { env: { CACHE: kvBinding(kv), DB: d.db, ...extra } as unknown as Env, ...d };
}

beforeEach(() => {
  mockHasSA.mockReset().mockReturnValue(true);
  mockToken.mockReset().mockResolvedValue({ access_token: "tok", project_id: "p" });
  mockInvalidate.mockReset().mockResolvedValue(undefined);
  fetchMock.mockReset().mockImplementation(async () => notListed());
  vi.stubGlobal("fetch", fetchMock);
  kv = fakeKv();
  if (hasSqlite()) raw = openDerivedDb(["api_quota_counters", "contact_rate", "threats", "lookalike_domains"]);
});

afterEach(() => {
  // No test may ever reach the non-commercial v4 API or the Update API.
  for (const u of fetchedUrls()) {
    expect(u).not.toContain("safebrowsing.googleapis.com");
    expect(u).not.toContain("computeDiff");
    expect(u).not.toContain("hashes:search");
    if (u.includes("googleapis.com")) expect(u.startsWith("https://webrisk.googleapis.com/v1/uris:search?")).toBe(true);
  }
  vi.unstubAllGlobals();
});

// ─── cap parsing ─────────────────────────────────────────────────────

describe("cap overrides", () => {
  const e = (v: Record<string, string>) => v as unknown as Env;
  it("monthly: default 90,000, integer override, clamped to the 100,000 free tier", () => {
    expect(WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT).toBe(90_000);
    expect(webRiskLookupMonthlyCap(e({}))).toBe(90_000);
    expect(webRiskLookupMonthlyCap(e({ WEB_RISK_LOOKUP_MONTHLY_CAP: "40" }))).toBe(40);
    expect(webRiskLookupMonthlyCap(e({ WEB_RISK_LOOKUP_MONTHLY_CAP: " 500 " }))).toBe(500);
    expect(webRiskLookupMonthlyCap(e({ WEB_RISK_LOOKUP_MONTHLY_CAP: "0" }))).toBe(0);
    expect(webRiskLookupMonthlyCap(e({ WEB_RISK_LOOKUP_MONTHLY_CAP: "250000" }))).toBe(100_000);
    for (const bad of ["-1", "1.5", "abc", "1e5"]) {
      expect(webRiskLookupMonthlyCap(e({ WEB_RISK_LOOKUP_MONTHLY_CAP: bad }))).toBe(90_000);
    }
  });

  it("contact daily: default 200, clamped to 1,000", () => {
    expect(WEB_RISK_LOOKUP_CONTACT_DAILY_CAP_DEFAULT).toBe(200);
    expect(webRiskLookupContactDailyCap(e({}))).toBe(200);
    expect(webRiskLookupContactDailyCap(e({ WEB_RISK_LOOKUP_CONTACT_DAILY_CAP: "5" }))).toBe(5);
    expect(webRiskLookupContactDailyCap(e({ WEB_RISK_LOOKUP_CONTACT_DAILY_CAP: "50000" }))).toBe(1_000);
    expect(webRiskLookupContactDailyCap(e({ WEB_RISK_LOOKUP_CONTACT_DAILY_CAP: "x" }))).toBe(200);
  });

  it("periods are UTC month / day", () => {
    expect(monthPeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(dayPeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12-01");
  });
});

// ─── atomic counter ──────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("reserveLookups (D1 api_quota_counters)", () => {
  it("grants min(want, cap − n) and never more than the cap", async () => {
    const { env: en } = env({ WEB_RISK_LOOKUP_MONTHLY_CAP: "10" });
    expect(await reserveLookups(en, 7)).toBe(7);
    expect(await reserveLookups(en, 7)).toBe(3);
    expect(await reserveLookups(en, 7)).toBe(0);
    expect(used()).toBe(10);
  });

  it("concurrent reservations together never exceed the cap", async () => {
    const { env: en } = env({ WEB_RISK_LOOKUP_MONTHLY_CAP: "100" });
    const grants = await Promise.all(Array.from({ length: 50 }, () => reserveLookups(en, 3)));
    expect(grants.reduce((a, g) => a + (g ?? 0), 0)).toBe(100);
    expect(used()).toBe(100);
  });

  it("a cap lowered below n grants 0 and leaves n alone", async () => {
    setUsed(50);
    const { env: en } = env({ WEB_RISK_LOOKUP_MONTHLY_CAP: "20" });
    expect(await reserveLookups(en, 5)).toBe(0);
    expect(used()).toBe(50);
  });

  it("contact reserves the daily bucket first, then the month", async () => {
    const { env: en } = env({ WEB_RISK_LOOKUP_CONTACT_DAILY_CAP: "4" });
    expect(await reserveLookups(en, 3, "contact")).toBe(3);
    expect(await reserveLookups(en, 3, "contact")).toBe(1);
    expect(await reserveLookups(en, 3, "contact")).toBe(0);
    expect(used(CONTACT_DAY_BUCKET, dayPeriod(new Date()))).toBe(4);
    expect(used()).toBe(4);
  });

  it("fails closed (null) on a D1 error", async () => {
    const { env: en } = env({}, [], { failQuota: true });
    expect(await reserveLookups(en, 5)).toBeNull();
    expect(await webRiskLookupsRemaining(en)).toBeNull();
  });
});

// ─── response mapping ────────────────────────────────────────────────

describe("mapSearchResponse", () => {
  it("maps {} to clean and a listed threat to its most severe type", () => {
    expect(mapSearchResponse({})).toEqual({ flagged: false, threatType: null, checked: true });
    expect(mapSearchResponse({ threat: { threatTypes: [] } })).toEqual({ flagged: false, threatType: null, checked: true });
    expect(mapSearchResponse({ threat: { threatTypes: ["SOCIAL_ENGINEERING"] } }))
      .toEqual({ flagged: true, threatType: "SOCIAL_ENGINEERING", checked: true });
    expect(mapSearchResponse({ threat: { threatTypes: ["UNWANTED_SOFTWARE", "MALWARE"] } }).threatType).toBe("MALWARE");
  });
});

// ─── checkGoogleSafeBrowsing / webRiskLookup ─────────────────────────

describe.skipIf(!hasSqlite())("checkGoogleSafeBrowsing via Web Risk", () => {
  it("sends one GET per URL to uris:search with a bearer token and the three threat types", async () => {
    fetchMock.mockImplementation(async (u) => (String(u).includes("bad.example") ? listed("SOCIAL_ENGINEERING") : notListed()));
    const r = await checkGoogleSafeBrowsing(["https://bad.example/a?x=1", "https://ok.example/"], env().env);
    expect(r).toEqual([
      { flagged: true, threatType: "SOCIAL_ENGINEERING", checked: true },
      { flagged: false, threatType: null, checked: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.searchParams.get("uri")).toBe("https://bad.example/a?x=1");
    expect(parsed.searchParams.getAll("threatTypes")).toEqual(["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(used()).toBe(2);
    expect(kv.data.has("gsb:https://bad.example/a?x=1")).toBe(true);
  });

  it("returns checked=false on an HTTP error and does not cache it", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const r = await checkGoogleSafeBrowsing(["https://x.example/"], env().env);
    expect(r).toEqual([{ flagged: false, threatType: null, checked: false }]);
    expect(kv.data.has("gsb:https://x.example/")).toBe(false);
  });

  it("a 401/403 stops the run and drops the cached Google token", async () => {
    fetchMock.mockResolvedValue(new Response("denied", { status: 403 }));
    const urls = Array.from({ length: 30 }, (_, i) => `https://u${i}.example/`);
    const { verdicts, stats } = await webRiskLookup(env().env, urls);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4); // ≤ one in-flight wave
    expect(verdicts.every((x) => x.checked === false)).toBe(true);
    expect(stats.authFailed).toBe(true);
    expect(stats.deadlineSkipped).toBe(0);
    expect(mockInvalidate).toHaveBeenCalledWith(expect.anything(), "https://www.googleapis.com/auth/cloud-platform");
  });

  it("marks a 400/404 URI rejected, unless every call of a large run was rejected", async () => {
    fetchMock.mockImplementation(async (u) => (String(u).includes("weird") ? new Response("bad", { status: 400 }) : notListed()));
    const one = await webRiskLookup(env().env, ["https://weird.example/", "https://ok.example/"]);
    expect(one.verdicts[0]).toMatchObject({ checked: false, rejected: true });
    expect(one.verdicts[1]!.checked).toBe(true);

    fetchMock.mockResolvedValue(new Response("bad", { status: 400 }));
    const all = await webRiskLookup(env().env, Array.from({ length: 6 }, (_, i) => `https://w${i}.example/`));
    expect(all.stats.systemicReject).toBe(true);
    expect(all.verdicts.some((v) => v.rejected)).toBe(false);
  });

  it("de-duplicates URLs and reserves only what it calls", async () => {
    const r = await checkGoogleSafeBrowsing(["https://a.example/", "https://a.example/", "https://b.example/"], env().env);
    expect(r).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(used()).toBe(2);
  });

  it("answers cache hits without a call, a token, or a reservation", async () => {
    kv = fakeKv({ "gsb:https://a.example/": JSON.stringify({ flagged: true, threatType: "MALWARE", checked: true }) });
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], env().env);
    expect(r).toEqual([{ flagged: true, threatType: "MALWARE", checked: true }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockToken).not.toHaveBeenCalled();
    expect(used()).toBeNull();
  });

  it("useCache:false neither reads nor writes the gsb: cache", async () => {
    kv = fakeKv({ "gsb:https://a.example/": JSON.stringify({ flagged: false, threatType: null, checked: true }) });
    fetchMock.mockResolvedValue(listed("MALWARE"));
    const r = await checkGoogleSafeBrowsing(["https://a.example/", "https://planted.example/"], env().env, { useCache: false, purpose: "contact" });
    expect(r[0]!.flagged).toBe(true);
    expect(kv.puts.filter((k) => k.startsWith("gsb:"))).toEqual([]);
    expect(kv.data.has("gsb:https://planted.example/")).toBe(false);
  });

  it("makes no call at the monthly cap", async () => {
    setUsed(90_000);
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], env().env);
    expect(r).toEqual([{ flagged: false, threatType: null, checked: false }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls only up to the cap and leaves the rest unchecked", async () => {
    setUsed(9);
    const r = await checkGoogleSafeBrowsing(["https://a.example/", "https://b.example/", "https://c.example/"],
      env({ WEB_RISK_LOOKUP_MONTHLY_CAP: "10" }).env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.map((x) => x.checked)).toEqual([true, false, false]);
    expect(used()).toBe(10);
  });

  it("cap 0 makes no call and mints no token", async () => {
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], env({ WEB_RISK_LOOKUP_MONTHLY_CAP: "0" }).env);
    expect(r[0]!.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockToken).not.toHaveBeenCalled();
  });

  it("fails closed when the counter cannot be reached", async () => {
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], env({}, [], { failQuota: true }).env);
    expect(r[0]!.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns checked=false without a token and reserves nothing", async () => {
    mockToken.mockResolvedValue(null);
    const { verdicts, stats } = await webRiskLookup(env().env, ["https://a.example/"]);
    expect(verdicts[0]!.checked).toBe(false);
    expect(stats.noToken).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(used()).toBeNull();
  });

  it("starts no call after the deadline and counts only those as deadline skips", async () => {
    const { verdicts, stats } = await webRiskLookup(env().env, ["https://a.example/", "https://b.example/"], { deadline: Date.now() - 1 });
    expect(verdicts.every((v) => !v.checked)).toBe(true);
    expect(stats.deadlineSkipped).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();

    setUsed(90_000 - 1);
    const capped = await webRiskLookup(env().env, ["https://c.example/", "https://d.example/"]);
    expect(capped.stats.capped).toBe(true);
    expect(capped.stats.deadlineSkipped).toBe(0);
  });
});

// ─── contact path: daily bucket survives notify refunds ──────────────

describe.skipIf(!hasSqlite())("contact-form lookups", () => {
  it("failed sends refund the notify slot but lookups stay bounded by the daily bucket", async () => {
    fetchMock.mockImplementation(async (u) =>
      String(u).includes("googleapis.com") ? notListed() : new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
    const { env: en } = env({
      RESEND_API_KEY: "re_test",
      GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
      WEB_RISK_LOOKUP_CONTACT_DAILY_CAP: "5",
    });
    for (let i = 0; i < 6; i++) {
      const status = await notifyContactSubmission(en, {
        id: `s${i}`, name: "V", email: "v@visitor.example", company: null, companySize: null, interest: null, domain: null,
        message: `see https://a${i}-visit.com/x https://b${i}-visit.com/y https://c${i}-visit.com/z`,
      });
      expect(status).toBe("failed");
    }
    const counter = raw.prepare("SELECT n FROM contact_rate WHERE key = ?").all(contactNotifyKey()) as Array<{ n: number }>;
    expect(counter[0]?.n ?? 0).toBe(0); // every slot refunded
    expect(webRiskCalls()).toHaveLength(5); // 18 links wanted, daily bucket allows 5
    expect(used(CONTACT_DAY_BUCKET, dayPeriod(new Date()))).toBe(5);
    expect(kv.puts.filter((k) => k.startsWith("gsb:"))).toEqual([]);
  });
});

// ─── the feed ────────────────────────────────────────────────────────

function feedCtx(en: Env): FeedContext {
  return { env: en, feedName: "google_safe_browsing", feedUrl: "" };
}

const ROWS: ThreatRow[] = [
  { id: "t1", malicious_url: "https://bad.example/login", malicious_domain: null },
  { id: "t2", malicious_url: null, malicious_domain: "ok.example" },
];

describe.skipIf(!hasSqlite())("google_safe_browsing feed", () => {
  it("marks flagged and clean rows when Web Risk answered, reserving the run in one statement", async () => {
    const { env: en, updates } = env({}, ROWS);
    fetchMock.mockImplementation(async (u) => (String(u).includes("bad.example") ? listed("MALWARE") : notListed()));
    const res = await google_safe_browsing.ingest(feedCtx(en));
    expect(res).toMatchObject({ itemsFetched: 2, itemsNew: 1, itemsDuplicate: 1, itemsError: 0 });
    const marked = updates.filter((u) => u.sql.includes("gsb_checked = 1"));
    expect(marked.map((u) => u.binds.at(-1))).toEqual(["t1", "t2"]);
    expect(marked[0]!.binds[0]).toBe("MALWARE");
    expect(used()).toBe(2);
  });

  it("stamps a rejected (400) URL gsb_checked = 2 and leaves transient errors at 0", async () => {
    const { env: en, updates } = env({}, ROWS);
    fetchMock.mockImplementation(async (u) =>
      String(u).includes("bad.example") ? new Response("bad", { status: 400 }) : new Response("err", { status: 503 }));
    await google_safe_browsing.ingest(feedCtx(en));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toContain("gsb_checked = 2");
    expect(updates[0]!.sql).toContain("AND gsb_checked = 0");
    expect(updates[0]!.binds).toEqual(["t1"]);
  });

  it("never marks a row it could not check (HTTP 5xx), without throwing", async () => {
    const { env: en, updates } = env({}, ROWS);
    fetchMock.mockResolvedValue(new Response("err", { status: 503 }));
    const res = await google_safe_browsing.ingest(feedCtx(en));
    expect(updates).toEqual([]);
    expect(res.itemsError).toBe(2);
  });

  it("throws on a 401/403 so the breaker fires", async () => {
    const { env: en, updates } = env({}, ROWS);
    fetchMock.mockResolvedValue(new Response("denied", { status: 401 }));
    await expect(google_safe_browsing.ingest(feedCtx(en))).rejects.toThrow(/401\/403/);
    expect(updates).toEqual([]);
  });

  it("throws when no token can be minted", async () => {
    mockToken.mockResolvedValue(null);
    const { env: en } = env({}, ROWS);
    await expect(google_safe_browsing.ingest(feedCtx(en))).rejects.toThrow(/access token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("at the cap: no SELECT, no call, nothing marked, no throw", async () => {
    setUsed(90_000);
    const { env: en, updates, selects } = env({}, ROWS);
    const res = await google_safe_browsing.ingest(feedCtx(en));
    expect(res.itemsFetched).toBe(0);
    expect(selects()).toBe(0);
    expect(updates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counter unreachable: fails closed, nothing marked, no throw", async () => {
    const { env: en, updates, selects } = env({}, ROWS, { failQuota: true });
    const res = await google_safe_browsing.ingest(feedCtx(en));
    expect(res.itemsFetched).toBe(0);
    expect(selects()).toBe(0);
    expect(updates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cap reached mid-run: only answered rows are marked, no throw", async () => {
    setUsed(9);
    const { env: en, updates } = env({ WEB_RISK_LOOKUP_MONTHLY_CAP: "10" }, ROWS);
    await google_safe_browsing.ingest(feedCtx(en));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updates.map((u) => u.binds.at(-1))).toEqual(["t1"]);
  });

  it("does nothing without a service account", async () => {
    mockHasSA.mockReturnValue(false);
    const { env: en, selects } = env({}, ROWS);
    const res = await google_safe_browsing.ingest(feedCtx(en));
    expect(res.itemsFetched).toBe(0);
    expect(selects()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── static guards ───────────────────────────────────────────────────

const SRC = resolve(__dirname, "..", "src");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const srcFiles = walk(SRC)
  .filter((p) => /\.(ts|js)$/.test(p))
  .map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }))
  .filter((f) => !f.rel.startsWith("feeds/_archive/")); // excluded from the build (tsconfig)

describe("static guards", () => {
  it("no live code references safebrowsing.googleapis.com/v4, threatLists:computeDiff or hashes:search", () => {
    const offenders = srcFiles
      .filter((f) => /safebrowsing\.googleapis\.com\/v4|:computeDiff|hashes:search|GOOGLE_SAFE_BROWSING_KEY\b(?!\?: string)/.test(
        f.text.replace(/^\s*(\/\/|\*).*$/gm, ""),
      ))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("gsb_checked is never exposed or summed raw (2 = attempted, unanswerable, NOT clean)", () => {
    // identityDetections reads it as `row.gsb_checked === 1` — safe.
    const offenders = srcFiles
      .filter((f) => f.rel !== "handlers/identityDetections.ts")
      .filter((f) => /\bt\.gsb_checked\s*,|SUM\(\s*gsb_checked\s*\)/.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
