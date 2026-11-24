import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

vi.mock("../src/lib/google-service-account", () => ({
  hasServiceAccount: vi.fn(),
  getGoogleAccessToken: vi.fn(),
}));

import {
  webRiskLookupMonthlyCap, WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT, lookupCounterKey,
  mapSearchResponse, reserveLookups, webRiskLookup,
} from "../src/lib/web-risk-lookup";
import { checkGoogleSafeBrowsing, google_safe_browsing } from "../src/feeds/googleSafeBrowsing";
import { hasServiceAccount, getGoogleAccessToken } from "../src/lib/google-service-account";
import type { Env } from "../src/types";
import type { FeedContext } from "../src/feeds/types";

const mockHasSA = vi.mocked(hasServiceAccount);
const mockToken = vi.mocked(getGoogleAccessToken);

// ─── fakes ───────────────────────────────────────────────────────────

interface FakeKv {
  data: Map<string, string>;
  puts: string[];
  failGet?: (key: string) => boolean;
  failPut?: (key: string) => boolean;
}

function fakeKv(seed: Record<string, string> = {}): FakeKv {
  return { data: new Map(Object.entries(seed)), puts: [] };
}

function kvBinding(kv: FakeKv) {
  return {
    get: async (key: string) => {
      if (kv.failGet?.(key)) throw new Error("KV get failed");
      return kv.data.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      if (kv.failPut?.(key)) throw new Error("KV put failed");
      kv.puts.push(key);
      kv.data.set(key, value);
    },
  };
}

interface ThreatRow { id: string; malicious_url: string | null; malicious_domain: string | null }

function fakeDb(rows: ThreatRow[]) {
  const updates: { sql: string; binds: unknown[] }[] = [];
  let selects = 0;
  const prepare = (sql: string) => {
    const stmt = (binds: unknown[]) => ({
      all: async () => { selects++; return { results: rows }; },
      run: async () => { updates.push({ sql, binds }); return { meta: { changes: 1 } }; },
      first: async () => ({ signals: 0 }),
    });
    return { ...stmt([]), bind: (...binds: unknown[]) => stmt(binds) };
  };
  return { db: { prepare }, updates, selects: () => selects };
}

function makeEnv(kv: FakeKv, extra: Record<string, unknown> = {}): Env {
  return { CACHE: kvBinding(kv), ...extra } as unknown as Env;
}

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
const fetchedUrls = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

function listed(...threatTypes: string[]): Response {
  return new Response(JSON.stringify({ threat: { threatTypes, expireTime: "2026-12-01T00:00:00Z" } }), { status: 200 });
}
const notListed = (): Response => new Response("{}", { status: 200 });

const counterKey = (): string => lookupCounterKey(new Date());

beforeEach(() => {
  mockHasSA.mockReset().mockReturnValue(true);
  mockToken.mockReset().mockResolvedValue({ access_token: "tok", project_id: "p" });
  fetchMock.mockReset().mockImplementation(async () => notListed());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // No test may ever reach the non-commercial v4 API or the Update API.
  for (const u of fetchedUrls()) {
    expect(u).not.toContain("safebrowsing.googleapis.com");
    expect(u).not.toContain("computeDiff");
    expect(u).not.toContain("hashes:search");
    expect(u.startsWith("https://webrisk.googleapis.com/v1/uris:search?")).toBe(true);
  }
  vi.unstubAllGlobals();
});

// ─── cap parsing / counter ───────────────────────────────────────────

describe("webRiskLookupMonthlyCap", () => {
  it("defaults to 90,000 and accepts a non-negative integer override", () => {
    expect(WEB_RISK_LOOKUP_MONTHLY_CAP_DEFAULT).toBe(90_000);
    const env = (v?: string) => ({ WEB_RISK_LOOKUP_MONTHLY_CAP: v } as unknown as Env);
    expect(webRiskLookupMonthlyCap(env())).toBe(90_000);
    expect(webRiskLookupMonthlyCap(env("40"))).toBe(40);
    expect(webRiskLookupMonthlyCap(env(" 500 "))).toBe(500);
    expect(webRiskLookupMonthlyCap(env("0"))).toBe(0);
    for (const bad of ["", "-1", "1.5", "abc", "1e5"]) expect(webRiskLookupMonthlyCap(env(bad))).toBe(90_000);
  });

  it("keys the counter by UTC month", () => {
    expect(lookupCounterKey(new Date("2026-11-30T23:59:59Z"))).toBe("web_risk_lookup:calls:2026-11");
    expect(lookupCounterKey(new Date("2026-12-01T00:00:00Z"))).toBe("web_risk_lookup:calls:2026-12");
  });

  it("reserves at most what is left and fails closed on KV errors", async () => {
    const kv = fakeKv({ [counterKey()]: "8" });
    const env = makeEnv(kv, { WEB_RISK_LOOKUP_MONTHLY_CAP: "10" });
    expect(await reserveLookups(env, 5)).toBe(2);
    expect(kv.data.get(counterKey())).toBe("10");
    expect(await reserveLookups(env, 5)).toBe(0);

    const garbage = makeEnv(fakeKv({ [counterKey()]: "lots" }));
    expect(await reserveLookups(garbage, 5)).toBeNull();

    const failingPut = fakeKv();
    failingPut.failPut = () => true;
    expect(await reserveLookups(makeEnv(failingPut), 5)).toBeNull();

    expect(await reserveLookups({} as unknown as Env, 5)).toBeNull();
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

// ─── checkGoogleSafeBrowsing (public shape) ──────────────────────────

describe("checkGoogleSafeBrowsing via Web Risk", () => {
  it("sends one GET per URL to uris:search with a bearer token and the three threat types", async () => {
    const kv = fakeKv();
    fetchMock.mockImplementation(async (u) => (String(u).includes("bad.example") ? listed("SOCIAL_ENGINEERING") : notListed()));
    const r = await checkGoogleSafeBrowsing(["https://bad.example/a?x=1", "https://ok.example/"], makeEnv(kv));
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
    expect(kv.data.get(counterKey())).toBe("2");
    expect(kv.data.has("gsb:https://bad.example/a?x=1")).toBe(true);
  });

  it("returns checked=false on an HTTP error and does not cache it", async () => {
    const kv = fakeKv();
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const r = await checkGoogleSafeBrowsing(["https://x.example/"], makeEnv(kv));
    expect(r).toEqual([{ flagged: false, threatType: null, checked: false }]);
    expect(kv.data.has("gsb:https://x.example/")).toBe(false);
  });

  it("stops spending calls after an auth / quota error", async () => {
    fetchMock.mockResolvedValue(new Response("denied", { status: 403 }));
    const urls = Array.from({ length: 30 }, (_, i) => `https://u${i}.example/`);
    const r = await checkGoogleSafeBrowsing(urls, makeEnv(fakeKv()));
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4); // ≤ one in-flight batch
    expect(r.every((x) => x.checked === false)).toBe(true);
  });

  it("de-duplicates URLs before calling", async () => {
    const kv = fakeKv();
    const r = await checkGoogleSafeBrowsing(["https://a.example/", "https://a.example/", "https://b.example/"], makeEnv(kv));
    expect(r).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kv.data.get(counterKey())).toBe("2");
  });

  it("answers cache hits without a call and without touching the quota", async () => {
    const kv = fakeKv({ "gsb:https://a.example/": JSON.stringify({ flagged: true, threatType: "MALWARE", checked: true }) });
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], makeEnv(kv));
    expect(r).toEqual([{ flagged: true, threatType: "MALWARE", checked: true }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.puts).not.toContain(counterKey());
    expect(mockToken).not.toHaveBeenCalled();
  });

  it("makes no call at the monthly cap", async () => {
    const kv = fakeKv({ [counterKey()]: "90000" });
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], makeEnv(kv));
    expect(r).toEqual([{ flagged: false, threatType: null, checked: false }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls only up to the cap and leaves the rest unchecked", async () => {
    const kv = fakeKv({ [counterKey()]: "9" });
    const env = makeEnv(kv, { WEB_RISK_LOOKUP_MONTHLY_CAP: "10" });
    const r = await checkGoogleSafeBrowsing(["https://a.example/", "https://b.example/", "https://c.example/"], env);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.map((x) => x.checked)).toEqual([true, false, false]);
    expect(kv.data.get(counterKey())).toBe("10");
  });

  it("cap 0 makes no call and mints no token", async () => {
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], makeEnv(fakeKv(), { WEB_RISK_LOOKUP_MONTHLY_CAP: "0" }));
    expect(r[0]!.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockToken).not.toHaveBeenCalled();
  });

  it("fails closed when the counter cannot be read", async () => {
    const kv = fakeKv();
    kv.failGet = (k) => k === counterKey();
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], makeEnv(kv));
    expect(r[0]!.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns checked=false without a token (no service account)", async () => {
    mockToken.mockResolvedValue(null);
    const r = await checkGoogleSafeBrowsing(["https://a.example/"], makeEnv(fakeKv()));
    expect(r[0]!.checked).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("starts no call after the deadline", async () => {
    const { verdicts, stats } = await webRiskLookup(makeEnv(fakeKv()), ["https://a.example/"], { deadline: Date.now() - 1 });
    expect(verdicts[0]!.checked).toBe(false);
    expect(stats.deadlineSkipped).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── the feed ────────────────────────────────────────────────────────

function feedCtx(env: Env): FeedContext {
  return { env, feedName: "google_safe_browsing", feedUrl: "" };
}

const ROWS: ThreatRow[] = [
  { id: "t1", malicious_url: "https://bad.example/login", malicious_domain: null },
  { id: "t2", malicious_url: null, malicious_domain: "ok.example" },
];

describe("google_safe_browsing feed", () => {
  it("marks flagged and clean rows when Web Risk answered", async () => {
    const { db, updates } = fakeDb(ROWS);
    fetchMock.mockImplementation(async (u) => (String(u).includes("bad.example") ? listed("MALWARE") : notListed()));
    const res = await google_safe_browsing.ingest(feedCtx(makeEnv(fakeKv(), { DB: db })));
    expect(res).toMatchObject({ itemsFetched: 2, itemsNew: 1, itemsDuplicate: 1, itemsError: 0 });
    const marked = updates.filter((u) => u.sql.includes("gsb_checked = 1"));
    expect(marked.map((u) => u.binds.at(-1))).toEqual(["t1", "t2"]);
    expect(marked[0]!.binds[0]).toBe("MALWARE");
  });

  it("never marks a row it could not check (HTTP error)", async () => {
    const { db, updates } = fakeDb(ROWS);
    fetchMock.mockResolvedValue(new Response("err", { status: 503 }));
    const res = await google_safe_browsing.ingest(feedCtx(makeEnv(fakeKv(), { DB: db })));
    expect(updates).toEqual([]);
    expect(res.itemsError).toBe(2);
  });

  it("at the cap: no SELECT, no call, nothing marked", async () => {
    const { db, updates, selects } = fakeDb(ROWS);
    const env = makeEnv(fakeKv({ [counterKey()]: "90000" }), { DB: db });
    const res = await google_safe_browsing.ingest(feedCtx(env));
    expect(res.itemsFetched).toBe(0);
    expect(selects()).toBe(0);
    expect(updates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counter unreadable: fails closed, nothing marked", async () => {
    const { db, updates, selects } = fakeDb(ROWS);
    const kv = fakeKv();
    kv.failGet = (k) => k === counterKey();
    await google_safe_browsing.ingest(feedCtx(makeEnv(kv, { DB: db })));
    expect(selects()).toBe(0);
    expect(updates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cap reached mid-run: only answered rows are marked", async () => {
    const { db, updates } = fakeDb(ROWS);
    const env = makeEnv(fakeKv({ [counterKey()]: "9" }), { DB: db, WEB_RISK_LOOKUP_MONTHLY_CAP: "10" });
    await google_safe_browsing.ingest(feedCtx(env));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updates.map((u) => u.binds.at(-1))).toEqual(["t1"]);
  });

  it("does nothing without a service account", async () => {
    mockHasSA.mockReturnValue(false);
    const { db, selects } = fakeDb(ROWS);
    const res = await google_safe_browsing.ingest(feedCtx(makeEnv(fakeKv(), { DB: db })));
    expect(res.itemsFetched).toBe(0);
    expect(selects()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── static guard ────────────────────────────────────────────────────

describe("no Safe Browsing v4 / Web Risk Update API in src/", () => {
  const SRC = resolve(__dirname, "..", "src");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  it("no live code references safebrowsing.googleapis.com/v4, threatLists:computeDiff or hashes:search", () => {
    const offenders = walk(SRC)
      .filter((p) => /\.(ts|js)$/.test(p))
      .map((p) => ({ rel: relative(SRC, p).split("\\").join("/"), text: readFileSync(p, "utf8") }))
      .filter((f) => !f.rel.startsWith("feeds/_archive/")) // excluded from the build (tsconfig)
      .filter((f) => /safebrowsing\.googleapis\.com\/v4|:computeDiff|hashes:search|GOOGLE_SAFE_BROWSING_KEY\b(?!\?: string)/.test(
        f.text.replace(/^\s*(\/\/|\*).*$/gm, ""),
      ))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
