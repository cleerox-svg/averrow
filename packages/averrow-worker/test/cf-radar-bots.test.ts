/**
 * Tests for the Cloudflare Radar bot-traffic feed (feeds/cf_radar_bots.ts):
 * pure parsers (both Radar key spellings, NaN/missing values, series) and
 * the ingest failure contract (auth, required summary, partial endpoint
 * failure, no threats writes, itemsNew === 0, KV invalidation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cf_radar_bots,
  parsePct,
  classifyBotClassKey,
  parseSnapshotDate,
  parseBotClassSummary,
  parseBotClassSeries,
  parseTopLocations,
  parseTopAses,
  parseCategorySummary,
  botTrafficCacheKey,
  BOT_TRAFFIC_CACHE_DAYS,
} from "../src/feeds/cf_radar_bots";
import type { Env } from "../src/types";

// ─── Parsers ────────────────────────────────────────────────────

describe("parsePct", () => {
  it.each([
    ["31.2", 31.2],
    [31.2, 31.2],
    ["0", 0],
    [0, 0],
  ])("parses %j -> %j", (input, expected) => {
    expect(parsePct(input)).toBe(expected);
  });

  it.each([["abc"], [""], [NaN], [Infinity], [null], [undefined], [{}], [[]], [true]])(
    "returns null for %j",
    (input) => {
      expect(parsePct(input)).toBeNull();
    },
  );
});

describe("classifyBotClassKey", () => {
  it.each([
    ["bot", "bot"], ["BOT", "bot"], ["LIKELY_AUTOMATED", "bot"], [" Bots ", "bot"],
    ["human", "human"], ["LIKELY_HUMAN", "human"], ["humans", "human"],
    ["other", null], ["", null], ["timestamps", null],
  ])("%j -> %j", (k, expected) => {
    expect(classifyBotClassKey(k)).toBe(expected);
  });
});

describe("parseSnapshotDate", () => {
  const wrap = (dateRange: unknown) => ({ success: true, result: { meta: { dateRange } } });

  it("reads the date part of dateRange[0].endTime", () => {
    expect(parseSnapshotDate(wrap([{ startTime: "2026-10-10T00:00:00Z", endTime: "2026-10-11T00:00:00Z" }])))
      .toBe("2026-10-11");
  });
  it("accepts a bare result without the envelope", () => {
    expect(parseSnapshotDate({ meta: { dateRange: [{ endTime: "2026-10-11T00:00:00Z" }] } })).toBe("2026-10-11");
  });
  it.each([
    ["undefined payload", undefined],
    ["null", null],
    ["no meta", { result: {} }],
    ["empty ranges", wrap([])],
    ["non-array ranges", wrap("x")],
    ["missing endTime", wrap([{ startTime: "2026-10-10T00:00:00Z" }])],
    ["malformed endTime", wrap([{ endTime: "yesterday" }])],
  ])("returns null for %s", (_n, payload) => {
    expect(parseSnapshotDate(payload)).toBeNull();
  });
});

describe("parseBotClassSummary", () => {
  it("parses the bot/human spelling", () => {
    expect(parseBotClassSummary({ result: { summary_0: { bot: "31.2", human: "68.8" } } }))
      .toEqual({ bot_pct: 31.2, human_pct: 68.8 });
  });
  it("parses the LIKELY_AUTOMATED/LIKELY_HUMAN spelling", () => {
    expect(parseBotClassSummary({ result: { summary_0: { LIKELY_AUTOMATED: "29.5", LIKELY_HUMAN: "70.5" } } }))
      .toEqual({ bot_pct: 29.5, human_pct: 70.5 });
  });
  it("derives the missing side as the complement", () => {
    expect(parseBotClassSummary({ result: { summary_0: { bot: "40" } } })).toEqual({ bot_pct: 40, human_pct: 60 });
    expect(parseBotClassSummary({ result: { summary_0: { LIKELY_HUMAN: "75.5" } } }))
      .toEqual({ bot_pct: 24.5, human_pct: 75.5 });
  });
  it("ignores NaN values and unknown keys, using the remaining side", () => {
    expect(parseBotClassSummary({ result: { summary_0: { bot: "NaN", human: "80", other: "5" } } }))
      .toEqual({ bot_pct: 20, human_pct: 80 });
  });
  it("accepts numeric values", () => {
    expect(parseBotClassSummary({ result: { summary_0: { bot: 12, human: 88 } } }))
      .toEqual({ bot_pct: 12, human_pct: 88 });
  });
  it("clamps the complement at 0 when a side exceeds 100", () => {
    expect(parseBotClassSummary({ result: { summary_0: { human: "101" } } })).toEqual({ bot_pct: 0, human_pct: 101 });
  });
  it.each([
    ["undefined", undefined],
    ["no summary_0", { result: {} }],
    ["summary_0 not an object", { result: { summary_0: [] } }],
    ["empty summary_0", { result: { summary_0: {} } }],
    ["all NaN", { result: { summary_0: { bot: "x", human: "y" } } }],
    ["only unknown keys", { result: { summary_0: { other: "5" } } }],
  ])("returns null for %s", (_n, payload) => {
    expect(parseBotClassSummary(payload)).toBeNull();
  });
});

describe("parseBotClassSeries", () => {
  it("parses a series with the bot/human spelling, ascending by date", () => {
    const out = parseBotClassSeries({
      result: {
        serie_0: {
          timestamps: ["2026-10-02T00:00:00Z", "2026-10-01T00:00:00Z"],
          bot: ["30", "28"],
          human: ["70", "72"],
        },
      },
    });
    expect(out).toEqual([
      { date: "2026-10-01", bot_pct: 28, human_pct: 72 },
      { date: "2026-10-02", bot_pct: 30, human_pct: 70 },
    ]);
  });
  it("parses LIKELY_* spelling", () => {
    const out = parseBotClassSeries({
      serie_0: { timestamps: ["2026-10-01T00:00:00Z"], LIKELY_AUTOMATED: ["33.3"], LIKELY_HUMAN: ["66.7"] },
    });
    expect(out).toEqual([{ date: "2026-10-01", bot_pct: 33.3, human_pct: 66.7 }]);
  });
  it("skips points with NaN on both sides and uses the complement when one side is NaN", () => {
    const out = parseBotClassSeries({
      result: {
        serie_0: {
          timestamps: ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"],
          bot: ["x", "x", "25"],
          human: ["y", "60", "75"],
        },
      },
    });
    expect(out).toEqual([
      { date: "2026-10-02", bot_pct: 40, human_pct: 60 },
      { date: "2026-10-03", bot_pct: 25, human_pct: 75 },
    ]);
  });
  it("handles arrays shorter than timestamps (missing values skipped)", () => {
    const out = parseBotClassSeries({
      result: { serie_0: { timestamps: ["2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"], bot: ["30"] } },
    });
    expect(out).toEqual([{ date: "2026-10-01", bot_pct: 30, human_pct: 70 }]);
  });
  it("last occurrence of a repeated date wins", () => {
    const out = parseBotClassSeries({
      result: { serie_0: { timestamps: ["2026-10-01T00:00:00Z", "2026-10-01T12:00:00Z"], bot: ["10", "20"], human: ["90", "80"] } },
    });
    expect(out).toEqual([{ date: "2026-10-01", bot_pct: 20, human_pct: 80 }]);
  });
  it("skips non-string / malformed timestamps", () => {
    const out = parseBotClassSeries({
      result: { serie_0: { timestamps: [123, "garbage", "2026-10-01T00:00:00Z"], bot: ["1", "2", "3"], human: ["99", "98", "97"] } },
    });
    expect(out).toEqual([{ date: "2026-10-01", bot_pct: 3, human_pct: 97 }]);
  });
  it.each([
    ["undefined", undefined],
    ["no serie_0", { result: {} }],
    ["no timestamps", { result: { serie_0: { bot: ["1"] } } }],
    ["timestamps not an array", { result: { serie_0: { timestamps: "x", bot: ["1"] } } }],
    ["no recognised class arrays", { result: { serie_0: { timestamps: ["2026-10-01T00:00:00Z"], foo: ["1"] } } }],
  ])("returns [] for %s", (_n, payload) => {
    expect(parseBotClassSeries(payload)).toEqual([]);
  });
});

describe("parseTopLocations", () => {
  it("parses, upper-cases codes, ranks in input order", () => {
    const out = parseTopLocations({
      result: {
        top_0: [
          { clientCountryAlpha2: "us", clientCountryName: "United States", value: "40.5" },
          { clientCountryAlpha2: "DE", clientCountryName: "Germany", value: "10" },
        ],
      },
    });
    expect(out).toEqual([
      { dim_key: "US", label: "United States", rank: 1, value_pct: 40.5 },
      { dim_key: "DE", label: "Germany", rank: 2, value_pct: 10 },
    ]);
  });
  it("falls back to the code for a missing name, drops dupes/NaN/missing code, and re-ranks contiguously", () => {
    const out = parseTopLocations({
      result: {
        top_0: [
          { clientCountryAlpha2: "US", value: "5" },
          { clientCountryAlpha2: "US", clientCountryName: "Dupe", value: "4" },
          { clientCountryAlpha2: "FR", clientCountryName: "France", value: "NaN" },
          { clientCountryName: "Nowhere", value: "3" },
          "junk",
          { clientCountryAlpha2: "JP", clientCountryName: "  ", value: 2 },
        ],
      },
    });
    expect(out).toEqual([
      { dim_key: "US", label: "US", rank: 1, value_pct: 5 },
      { dim_key: "JP", label: "JP", rank: 2, value_pct: 2 },
    ]);
  });
  it("returns [] for missing top_0", () => {
    expect(parseTopLocations({ result: {} })).toEqual([]);
    expect(parseTopLocations(null)).toEqual([]);
  });
});

describe("parseTopAses", () => {
  it("parses numeric and string ASNs, dim_key is ASN text", () => {
    const out = parseTopAses({
      result: {
        top_0: [
          { clientASN: 16509, clientASName: "AMAZON-02", value: "12.3" },
          { clientASN: "8075", clientASName: "MICROSOFT", value: "8" },
        ],
      },
    });
    expect(out).toEqual([
      { dim_key: "16509", label: "AMAZON-02", rank: 1, value_pct: 12.3 },
      { dim_key: "8075", label: "MICROSOFT", rank: 2, value_pct: 8 },
    ]);
  });
  it("defaults the name to AS<n>; drops dupes, bad ASNs, negative ASNs and NaN values", () => {
    const out = parseTopAses({
      result: {
        top_0: [
          { clientASN: 13335, value: "9" },
          { clientASN: 13335, clientASName: "Dupe", value: "8" },
          { clientASN: "abc", value: "7" },
          { clientASN: -1, value: "6" },
          { clientASN: 1.5, value: "6" },
          { clientASN: 15169, clientASName: "GOOGLE", value: "oops" },
          { clientASN: 0, clientASName: "ZERO", value: "1" },
        ],
      },
    });
    expect(out).toEqual([
      { dim_key: "13335", label: "AS13335", rank: 1, value_pct: 9 },
      { dim_key: "0", label: "ZERO", rank: 2, value_pct: 1 },
    ]);
  });
  it("returns [] when top_0 is absent", () => {
    expect(parseTopAses({ result: { top_0: "x" } })).toEqual([]);
  });
});

describe("parseCategorySummary", () => {
  it("sorts by value desc, ranks 1..N, normalises 'other' to OTHER, null labels", () => {
    const out = parseCategorySummary({
      result: { summary_0: { SEARCH_ENGINE_CRAWLER: "30.2", other: "10", AI_CRAWLER: "40.1" } },
    });
    expect(out).toEqual([
      { dim_key: "AI_CRAWLER", label: null, rank: 1, value_pct: 40.1 },
      { dim_key: "SEARCH_ENGINE_CRAWLER", label: null, rank: 2, value_pct: 30.2 },
      { dim_key: "OTHER", label: null, rank: 3, value_pct: 10 },
    ]);
  });
  it("breaks ties alphabetically and drops NaN values", () => {
    const out = parseCategorySummary({ result: { summary_0: { B: "5", A: "5", C: "NaN" } } });
    expect(out.map((r) => r.dim_key)).toEqual(["A", "B"]);
  });
  it("returns [] for missing/empty summary", () => {
    expect(parseCategorySummary({ result: {} })).toEqual([]);
    expect(parseCategorySummary({ result: { summary_0: {} } })).toEqual([]);
  });
});

// ─── Ingest ─────────────────────────────────────────────────────

const SUMMARY = {
  success: true,
  result: {
    summary_0: { LIKELY_AUTOMATED: "30", LIKELY_HUMAN: "70" },
    meta: { dateRange: [{ startTime: "2026-10-10T00:00:00Z", endTime: "2026-10-11T00:00:00Z" }] },
  },
};
const SERIES = {
  success: true,
  result: {
    serie_0: {
      timestamps: ["2026-10-09T00:00:00Z", "2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z"],
      bot: ["27", "28", "99"],
      human: ["73", "72", "1"],
    },
  },
};
const LOCATIONS = {
  success: true,
  result: { top_0: [{ clientCountryAlpha2: "US", clientCountryName: "United States", value: "40" }] },
};
const ASES = {
  success: true,
  result: { top_0: [{ clientASN: 16509, clientASName: "AMAZON-02", value: "12" }] },
};
const CATEGORIES = { success: true, result: { summary_0: { AI_CRAWLER: "60", other: "40" } } };

type Responder = (status: number, body: unknown) => Response;
const respond: Responder = (status, body) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

interface Stmt { sql: string; args: unknown[] }

interface Harness {
  env: Env;
  batches: Stmt[][];
  allSql: string[];
  cacheDeletes: string[];
  fetchedPaths: string[];
}

/** `routes` maps a path fragment to the response; first matching key wins. */
function makeHarness(
  routes: Record<string, () => Response>,
  opts: { token?: string | undefined; cacheDeleteThrows?: boolean } = { token: "tok" },
): Harness {
  const h: Harness = { env: {} as Env, batches: [], allSql: [], cacheDeletes: [], fetchedPaths: [] };

  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    h.fetchedPaths.push(u);
    for (const [frag, make] of Object.entries(routes)) {
      if (u.includes(frag)) return make();
    }
    return respond(500, "no route");
  }) as unknown as typeof fetch;

  const db = {
    prepare(sql: string) {
      h.allSql.push(sql);
      return {
        bind(...args: unknown[]) {
          return { sql, args } satisfies Stmt;
        },
      };
    },
    async batch(stmts: Stmt[]) {
      h.batches.push(stmts);
      return [];
    },
  };

  const cache = {
    async delete(key: string) {
      h.cacheDeletes.push(key);
      if (opts.cacheDeleteThrows) throw new Error("kv down");
    },
  };

  h.env = { CF_API_TOKEN: opts.token, DB: db, CACHE: cache } as unknown as Env;
  return h;
}

const ctxOf = (env: Env) => ({ env, feedName: "cf_radar_bots", feedUrl: "https://api.cloudflare.com/client/v4/radar" });

const allOk = (): Record<string, () => Response> => ({
  "/http/summary/BOT_CLASS": () => respond(200, SUMMARY),
  "/http/timeseries_groups/BOT_CLASS": () => respond(200, SERIES),
  "/http/top/locations": () => respond(200, LOCATIONS),
  "/http/top/ases": () => respond(200, ASES),
  "/bots/summary/BOT_CATEGORY": () => respond(200, CATEGORIES),
});

const stmts = (h: Harness) => h.batches.flat();
const upserts = (h: Harness, metric: string) =>
  stmts(h).filter((s) => /INSERT INTO bot_traffic_snapshots/.test(s.sql) && s.args[1] === metric);
const clears = (h: Harness) => stmts(h).filter((s) => /^DELETE FROM bot_traffic_snapshots/.test(s.sql));

describe("cf_radar_bots.ingest", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("throws when CF_API_TOKEN is missing and makes no request or write", async () => {
    const h = makeHarness(allOk(), { token: undefined });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).rejects.toThrow(/CF_API_TOKEN is not configured/);
    expect(h.fetchedPaths).toEqual([]);
    expect(h.batches).toEqual([]);
  });

  it.each([401, 403])("HTTP %i on the summary throws the Radar Read message", async (status) => {
    const h = makeHarness({ ...allOk(), "/http/summary/BOT_CLASS": () => respond(status, "denied") });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).rejects.toThrow(/lacks Radar Read permission \(HTTP \d+\)/);
    expect(h.batches).toEqual([]);
  });

  it("an auth failure on an OPTIONAL endpoint still fails the whole pull with no writes", async () => {
    const h = makeHarness({ ...allOk(), "/http/top/ases": () => respond(403, "denied") });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).rejects.toThrow(/lacks Radar Read/);
    expect(h.batches).toEqual([]);
    expect(h.cacheDeletes).toEqual([]);
  });

  it.each([
    ["HTTP 500", () => respond(500, "boom")],
    ["invalid JSON", () => respond(200, "<html>")],
    ["success:false", () => respond(200, { success: false, errors: [{ code: 1, message: "bad" }] })],
    ["unparsable summary", () => respond(200, { success: true, result: { summary_0: {} } })],
  ])("summary failure (%s) throws and writes nothing", async (_n, bad) => {
    const h = makeHarness({ ...allOk(), "/http/summary/BOT_CLASS": bad });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).rejects.toThrow(/CF Radar bot-class summary/);
    expect(h.batches).toEqual([]);
    expect(h.cacheDeletes).toEqual([]);
  });

  it("happy path: writes all five metrics, itemsNew 0, only touches bot_traffic_snapshots", async () => {
    const h = makeHarness(allOk());
    const res = await cf_radar_bots.ingest(ctxOf(h.env));

    expect(res.itemsNew).toBe(0);
    expect(res.itemsDuplicate).toBe(0);
    expect(res.itemsError).toBe(0);

    // Authorization header + all 5 endpoints requested.
    expect(h.fetchedPaths).toHaveLength(5);

    // Snapshot date comes from meta.dateRange (2026-10-11), not "today".
    const botShare = upserts(h, "bot_share");
    const summaryRows = botShare.filter((s) => s.args[0] === "2026-10-11");
    expect(summaryRows.map((s) => [s.args[2], s.args[5]])).toEqual([["bot", 30], ["human", 70]]);

    // Series backfill wrote the other days, and the series' (99/1) bucket
    // for the snapshot date was dropped in favour of the authoritative summary.
    const backfill = botShare.filter((s) => s.args[0] !== "2026-10-11");
    expect(backfill.map((s) => [s.args[0], s.args[2], s.args[5]])).toEqual([
      ["2026-10-09", "bot", 27], ["2026-10-09", "human", 73],
      ["2026-10-10", "bot", 28], ["2026-10-10", "human", 72],
    ]);
    expect(botShare.some((s) => s.args[5] === 99)).toBe(false);

    expect(upserts(h, "top_location").map((s) => s.args)).toEqual([
      ["2026-10-11", "top_location", "US", "United States", 1, 40],
    ]);
    expect(upserts(h, "top_asn").map((s) => s.args)).toEqual([
      ["2026-10-11", "top_asn", "16509", "AMAZON-02", 1, 12],
    ]);
    expect(upserts(h, "bot_category").map((s) => s.args.slice(2, 6))).toEqual([
      ["AI_CRAWLER", null, 1, 60], ["OTHER", null, 2, 40],
    ]);

    // Series first, authoritative summary after it (so it wins the upsert).
    const idxSeriesLast = stmts(h).findIndex((s) => s.args[0] === "2026-10-10" && s.args[2] === "human");
    const idxSummary = stmts(h).findIndex((s) => s.args[0] === "2026-10-11" && s.args[2] === "bot");
    expect(idxSeriesLast).toBeLessThan(idxSummary);

    // itemsFetched == rows written == upsert count.
    const upsertCount = stmts(h).filter((s) => /INSERT INTO bot_traffic_snapshots/.test(s.sql)).length;
    expect(res.itemsFetched).toBe(upsertCount);
    expect(res.itemsFetched).toBe(4 + 2 + 1 + 1 + 2);

    // Ranked metrics are replaced per (date, metric); bot_share is never cleared.
    expect(clears(h).map((s) => s.args)).toEqual([
      ["2026-10-11", "top_location"], ["2026-10-11", "top_asn"], ["2026-10-11", "bot_category"],
    ]);

    // Never touches threats.
    expect(h.allSql.some((q) => /\bthreats\b/i.test(q))).toBe(false);
  });

  it("uses today's UTC date when the summary has no meta.dateRange", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T23:59:00Z"));
    try {
      const h = makeHarness({
        ...allOk(),
        "/http/summary/BOT_CLASS": () => respond(200, { success: true, result: { summary_0: { bot: "30", human: "70" } } }),
      });
      await cf_radar_bots.ingest(ctxOf(h.env));
      const dates = new Set(upserts(h, "top_location").map((s) => s.args[0]));
      expect([...dates]).toEqual(["2026-10-12"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("partial failure: failed endpoints are counted, the rest still written, and their metric is NOT cleared", async () => {
    const h = makeHarness({
      ...allOk(),
      "/http/top/ases": () => respond(500, "upstream down"),
      "/http/timeseries_groups/BOT_CLASS": () => respond(502, "bad gateway"),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));

    expect(res.itemsError).toBe(2);
    expect(res.itemsNew).toBe(0);

    // No clear and no upsert for the failed metric -> old rows survive.
    expect(upserts(h, "top_asn")).toEqual([]);
    expect(clears(h).some((s) => s.args[1] === "top_asn")).toBe(false);

    // The healthy ones were written.
    expect(upserts(h, "top_location")).toHaveLength(1);
    expect(upserts(h, "bot_category")).toHaveLength(2);
    expect(clears(h).map((s) => s.args[1])).toEqual(["top_location", "bot_category"]);

    // Only the summary's two bot_share rows (no backfill).
    expect(upserts(h, "bot_share")).toHaveLength(2);

    // Cache still invalidated since a write happened.
    expect(h.cacheDeletes.sort()).toEqual(BOT_TRAFFIC_CACHE_DAYS.map(botTrafficCacheKey).sort());
  });

  it("an empty ranked result counts as an error and does not clear that metric's old rows", async () => {
    const h = makeHarness({
      ...allOk(),
      "/http/top/locations": () => respond(200, { success: true, result: { top_0: [] } }),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(upserts(h, "top_location")).toEqual([]);
    expect(clears(h).some((s) => s.args[1] === "top_location")).toBe(false);
  });

  it("all optional endpoints failing still writes the summary and reports 4 errors", async () => {
    const h = makeHarness({
      "/http/summary/BOT_CLASS": () => respond(200, SUMMARY),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(4);
    expect(res.itemsFetched).toBe(2);
    expect(res.itemsNew).toBe(0);
    expect(clears(h)).toEqual([]);
  });

  it("invalidates exactly the 7/30/90 bot_traffic cache keys after a successful write", async () => {
    const h = makeHarness(allOk());
    await cf_radar_bots.ingest(ctxOf(h.env));
    expect(h.cacheDeletes.sort()).toEqual(["bot_traffic:v1:30", "bot_traffic:v1:7", "bot_traffic:v1:90"]);
    // Invalidation happens after the batch write.
    expect(h.batches).toHaveLength(1);
  });

  it("a KV delete failure does not fail the pull", async () => {
    const h = makeHarness(allOk(), { token: "tok", cacheDeleteThrows: true });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).resolves.toMatchObject({ itemsNew: 0 });
  });
});
