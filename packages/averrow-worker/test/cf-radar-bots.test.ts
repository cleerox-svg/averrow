/**
 * Tests for the Cloudflare Radar bot-traffic feed (feeds/cf_radar_bots.ts):
 * pure parsers (both Radar key spellings, NaN/missing values, series) and
 * the ingest failure contract (auth, required summary, partial endpoint
 * failure, no threats writes, itemsNew === 0, KV invalidation), plus the
 * radar_country_snapshots lane: attack origin/target parsers, the
 * computeBotDensity derivation, and their partial-failure semantics.
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
  parseAttackOrigins,
  parseAttackTargets,
  computeBotDensity,
  BOT_DENSITY_MIN_TRAFFIC_PCT,
  BOT_DENSITY_MAX_ROWS,
  TOP_LOCATIONS_STORED,
  botTrafficCacheKey,
  BOT_TRAFFIC_CACHE_DAYS,
  resolveRadarToken,
} from "../src/feeds/cf_radar_bots";
import type { Env } from "../src/types";
import type { RankedDim } from "../src/feeds/cf_radar_bots";

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

describe("parseAttackOrigins / parseAttackTargets", () => {
  it("parses origin rows (SDK shape), upper-cases, re-ranks in input order", () => {
    const out = parseAttackOrigins({
      success: true,
      result: {
        top_0: [
          { originCountryAlpha2: "us", originCountryName: "United States", rank: 1, value: "21.5" },
          { originCountryAlpha2: "CN", originCountryName: "China", rank: 2, value: "9.25" },
        ],
      },
    });
    expect(out).toEqual([
      { dim_key: "US", label: "United States", rank: 1, value_pct: 21.5 },
      { dim_key: "CN", label: "China", rank: 2, value_pct: 9.25 },
    ]);
  });
  it("parses target rows and ignores client*/origin* fields on a target payload", () => {
    const out = parseAttackTargets({
      result: {
        top_0: [
          { targetCountryAlpha2: "DE", targetCountryName: "Germany", rank: 1, value: "30" },
          { originCountryAlpha2: "FR", originCountryName: "France", rank: 2, value: "10" },
          { targetCountryAlpha2: "DE", targetCountryName: "Dupe", rank: 3, value: "5" },
          { targetCountryAlpha2: "JP", targetCountryName: "", rank: 4, value: 2 },
          { targetCountryAlpha2: "BR", targetCountryName: "Brazil", rank: 5, value: "NaN" },
        ],
      },
    });
    expect(out).toEqual([
      { dim_key: "DE", label: "Germany", rank: 1, value_pct: 30 },
      { dim_key: "JP", label: "JP", rank: 2, value_pct: 2 },
    ]);
  });
  it("returns [] for missing/malformed top_0", () => {
    expect(parseAttackOrigins({ result: {} })).toEqual([]);
    expect(parseAttackTargets({ result: { top_0: "x" } })).toEqual([]);
    expect(parseAttackOrigins(undefined)).toEqual([]);
  });
});

describe("computeBotDensity", () => {
  const dim = (code: string, pct: number, label: string | null = `${code}-name`): RankedDim =>
    ({ dim_key: code, label, rank: 0, value_pct: pct });

  it("applies traffic_c = b·B_c + (1−b)·H_c and bot_pct_c = 100·b·B_c / traffic_c", () => {
    // b = 0.3. US: B=40%, H=20% → traffic 0.26 → 26%, bot 0.12/0.26 = 46.1538%.
    // DE: B=10%, H=30% → traffic 0.03+0.21 = 0.24 → 24%, bot 12.5%.
    const out = computeBotDensity(0.3, [dim("US", 40), dim("DE", 10)], [dim("DE", 30), dim("US", 20)]);
    expect(out).toEqual([
      { code: "US", name: "US-name", bot_pct: 46.1538, traffic_pct: 26, rank: 1 },
      { code: "DE", name: "DE-name", bot_pct: 12.5, traffic_pct: 24, rank: 2 },
    ]);
  });

  it("keeps only countries present in BOTH lists", () => {
    const out = computeBotDensity(0.5, [dim("US", 10), dim("BOTONLY", 50)], [dim("US", 10), dim("HUMANONLY", 50)]);
    expect(out.map((r) => r.code)).toEqual(["US"]);
  });

  it("applies the traffic_pct noise floor (inclusive) and exports it as 0.1", () => {
    expect(BOT_DENSITY_MIN_TRAFFIC_PCT).toBe(0.1);
    // b=0.5: AT exactly 0.1% traffic (0.5·0.1 + 0.5·0.1) kept; BELOW = 0.09% dropped.
    const out = computeBotDensity(
      0.5,
      [dim("AT", 0.1), dim("BELOW", 0.09), dim("US", 1)],
      [dim("AT", 0.1), dim("BELOW", 0.09), dim("US", 1)],
    );
    expect(out.map((r) => [r.code, r.traffic_pct])).toEqual([["US", 1], ["AT", 0.1]]); // equal bot_pct → traffic desc
  });

  it("b = 0 → every bot_pct is 0 (no NaN/Infinity), countries with zero human share dropped", () => {
    const out = computeBotDensity(0, [dim("US", 40), dim("ZZ", 50)], [dim("US", 20), dim("ZZ", 0)]);
    expect(out).toEqual([{ code: "US", name: "US-name", bot_pct: 0, traffic_pct: 20, rank: 1 }]);
  });

  it("b = 1 → every bot_pct is 100, traffic = bot share; zero bot share dropped", () => {
    const out = computeBotDensity(1, [dim("US", 40), dim("ZZ", 0)], [dim("US", 20), dim("ZZ", 60)]);
    expect(out).toEqual([{ code: "US", name: "US-name", bot_pct: 100, traffic_pct: 40, rank: 1 }]);
  });

  it("all-zero shares never divide by zero", () => {
    const out = computeBotDensity(0.4, [dim("US", 0)], [dim("US", 0)]);
    expect(out).toEqual([]);
  });

  it.each([[NaN], [Infinity], [-Infinity]])("non-finite b (%j) → []", (b) => {
    expect(computeBotDensity(b, [dim("US", 40)], [dim("US", 20)])).toEqual([]);
  });

  it("clamps b outside [0, 1] and every output is finite", () => {
    const hi = computeBotDensity(1.7, [dim("US", 40)], [dim("US", 20)]);
    expect(hi[0]).toMatchObject({ bot_pct: 100, traffic_pct: 40 });
    const lo = computeBotDensity(-0.2, [dim("US", 40)], [dim("US", 20)]);
    expect(lo[0]).toMatchObject({ bot_pct: 0, traffic_pct: 20 });
    for (const r of [...hi, ...lo]) {
      expect(Number.isFinite(r.bot_pct) && Number.isFinite(r.traffic_pct)).toBe(true);
    }
  });

  it("ranks by bot_pct desc, ties by traffic_pct desc then code; name falls back to code", () => {
    // b=0.5 and B=H → bot_pct 50 for all; traffic decides, then code.
    const out = computeBotDensity(
      0.5,
      [dim("BB", 2, null), dim("AA", 2), dim("CC", 5), dim("HI", 9)],
      [dim("BB", 2), dim("AA", 2), dim("CC", 5), dim("HI", 1)],
    );
    expect(out.map((r) => [r.code, r.rank])).toEqual([["HI", 1], ["CC", 2], ["AA", 3], ["BB", 4]]);
    expect(out.find((r) => r.code === "BB")!.name).toBe("BB");
  });

  it("returns every qualifying country (not a top-20), capped at BOT_DENSITY_MAX_ROWS", () => {
    expect(BOT_DENSITY_MAX_ROWS).toBe(100);
    const many = (n: number) => Array.from({ length: n }, (_, i) => dim(`C${String(i).padStart(3, "0")}`, 1 + i / 1000));
    expect(computeBotDensity(0.3, many(60), many(60))).toHaveLength(60);
    const capped = computeBotDensity(0.3, many(130), many(130));
    expect(capped).toHaveLength(100);
    expect(capped.map((r) => r.rank)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it("ignores duplicate codes after the first occurrence in either list", () => {
    const out = computeBotDensity(0.5, [dim("US", 10), dim("US", 90)], [dim("US", 10), dim("US", 90)]);
    expect(out).toEqual([{ code: "US", name: "US-name", bot_pct: 50, traffic_pct: 10, rank: 1 }]);
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
const HUMAN_LOCATIONS = {
  success: true,
  result: { top_0: [{ clientCountryAlpha2: "US", clientCountryName: "United States", value: "20" }] },
};
const attackMeta = { dateRange: [{ startTime: "2026-10-04T00:00:00Z", endTime: "2026-10-11T00:00:00Z" }] };
const ATTACK_ORIGINS = {
  success: true,
  result: {
    meta: attackMeta,
    top_0: [
      { originCountryAlpha2: "CN", originCountryName: "China", rank: 1, value: "18.5" },
      { originCountryAlpha2: "US", originCountryName: "United States", rank: 2, value: "12" },
    ],
  },
};
const ATTACK_TARGETS = {
  success: true,
  result: {
    meta: attackMeta,
    top_0: [{ targetCountryAlpha2: "US", targetCountryName: "United States", rank: 1, value: "35" }],
  },
};

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
  authHeaders: Array<string | null>;
}

/** `routes` maps a path fragment to the response; first matching key wins. */
function makeHarness(
  routes: Record<string, () => Response>,
  opts: { token?: string | undefined; radarToken?: string; cacheDeleteThrows?: boolean } = { token: "tok" },
): Harness {
  const h: Harness = { env: {} as Env, batches: [], allSql: [], cacheDeletes: [], fetchedPaths: [], authHeaders: [] };

  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    h.fetchedPaths.push(u);
    h.authHeaders.push(new Headers(init?.headers).get("Authorization"));
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

  h.env = { CF_API_TOKEN: opts.token, CF_RADAR_API_TOKEN: opts.radarToken, DB: db, CACHE: cache } as unknown as Env;
  return h;
}

const ctxOf = (env: Env) => ({ env, feedName: "cf_radar_bots", feedUrl: "https://api.cloudflare.com/client/v4/radar" });

// Route order matters (first match wins): the human-locations key must
// precede the generic "/http/top/locations" (overrides via spread keep
// their original position).
const HUMAN_LOC = "/http/top/locations?botClass=LIKELY_HUMAN";
const allOk = (): Record<string, () => Response> => ({
  "/http/summary/BOT_CLASS": () => respond(200, SUMMARY),
  "/http/timeseries_groups/BOT_CLASS": () => respond(200, SERIES),
  [HUMAN_LOC]: () => respond(200, HUMAN_LOCATIONS),
  "/http/top/locations": () => respond(200, LOCATIONS),
  "/http/top/ases": () => respond(200, ASES),
  "/bots/summary/BOT_CATEGORY": () => respond(200, CATEGORIES),
  "/attacks/layer7/top/locations/origin": () => respond(200, ATTACK_ORIGINS),
  "/attacks/layer7/top/locations/target": () => respond(200, ATTACK_TARGETS),
});

const stmts = (h: Harness) => h.batches.flat();
const upserts = (h: Harness, metric: string) =>
  stmts(h).filter((s) => /INSERT INTO bot_traffic_snapshots/.test(s.sql) && s.args[1] === metric);
const clears = (h: Harness) => stmts(h).filter((s) => /^DELETE FROM bot_traffic_snapshots/.test(s.sql));
const countryUpserts = (h: Harness, metric: string) =>
  stmts(h).filter((s) => /INSERT INTO radar_country_snapshots/.test(s.sql) && s.args[1] === metric);
const countryClears = (h: Harness) => stmts(h).filter((s) => /^DELETE FROM radar_country_snapshots/.test(s.sql));

describe("resolveRadarToken", () => {
  it("prefers CF_RADAR_API_TOKEN, falls back to CF_API_TOKEN", () => {
    expect(resolveRadarToken({ CF_RADAR_API_TOKEN: "r", CF_API_TOKEN: "s" })).toEqual({ token: "r", tokenName: "CF_RADAR_API_TOKEN" });
    expect(resolveRadarToken({ CF_API_TOKEN: "s" })).toEqual({ token: "s", tokenName: "CF_API_TOKEN" });
    expect(resolveRadarToken({ CF_RADAR_API_TOKEN: "", CF_API_TOKEN: "s" })).toEqual({ token: "s", tokenName: "CF_API_TOKEN" });
    expect(resolveRadarToken({})).toEqual({ token: undefined, tokenName: "CF_API_TOKEN" });
    expect(resolveRadarToken({ CF_RADAR_API_TOKEN: "  \n", CF_API_TOKEN: "s" })).toEqual({ token: "s", tokenName: "CF_API_TOKEN" });
    expect(resolveRadarToken({ CF_RADAR_API_TOKEN: " r\n" })).toEqual({ token: "r", tokenName: "CF_RADAR_API_TOKEN" });
  });
});

describe("cf_radar_bots.ingest", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    vi.spyOn(console, "warn");
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("throws when no Radar token is configured and makes no request or write", async () => {
    const h = makeHarness(allOk(), { token: undefined });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).rejects.toThrow(
      /neither CF_RADAR_API_TOKEN nor CF_API_TOKEN is configured/,
    );
    expect(h.fetchedPaths).toEqual([]);
    expect(h.batches).toEqual([]);
  });

  it("prefers the dedicated CF_RADAR_API_TOKEN over CF_API_TOKEN", async () => {
    const h = makeHarness(allOk(), { token: "shared", radarToken: "radar-only" });
    await cf_radar_bots.ingest(ctxOf(h.env));
    expect(h.authHeaders).toHaveLength(8);
    expect(new Set(h.authHeaders)).toEqual(new Set(["Bearer radar-only"]));
  });

  it("uses CF_RADAR_API_TOKEN alone when CF_API_TOKEN is unset", async () => {
    const h = makeHarness(allOk(), { token: undefined, radarToken: "radar-only" });
    await cf_radar_bots.ingest(ctxOf(h.env));
    expect(new Set(h.authHeaders)).toEqual(new Set(["Bearer radar-only"]));
  });

  it("names the dedicated token in the auth error when it is the one in use", async () => {
    const h = makeHarness(
      { ...allOk(), "/http/summary/BOT_CLASS": () => respond(403, "denied") },
      { token: "shared", radarToken: "radar-only" },
    );
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).rejects.toThrow(
      /CF_RADAR_API_TOKEN lacks Radar Read permission \(HTTP 403\)/,
    );
  });

  it.each([401, 403])("HTTP %i on the summary throws the Radar Read message", async (status) => {
    const h = makeHarness({ ...allOk(), "/http/summary/BOT_CLASS": () => respond(status, "denied") });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).rejects.toThrow(/lacks Radar Read permission \(HTTP \d+\)/);
    expect(h.batches).toEqual([]);
  });

  it.each([401, 403])("HTTP %i on an OPTIONAL endpoint is a partial failure: the rest is written and the message recorded", async (status) => {
    const h = makeHarness({ ...allOk(), "/http/top/ases": () => respond(status, "denied") });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(res.itemsNew).toBe(0);
    expect(res.warning).toMatch(/^partial pull \(1 endpoint\(s\) failed\): top_ases: CF Radar: CF_API_TOKEN lacks Radar Read permission \(HTTP \d+\)$/);
    expect(upserts(h, "top_asn")).toEqual([]);
    expect(clears(h).some((s) => s.args[1] === "top_asn")).toBe(false);
    expect(upserts(h, "top_location")).toHaveLength(1);
    expect(upserts(h, "bot_share")).toHaveLength(6);
    expect(h.cacheDeletes).toHaveLength(BOT_TRAFFIC_CACHE_DAYS.length);
  });

  it("auth failures on every optional endpoint still write the summary (only #1's auth failure is fatal)", async () => {
    const denied = () => respond(403, "denied");
    const h = makeHarness({
      "/http/summary/BOT_CLASS": () => respond(200, SUMMARY),
      "/http/timeseries_groups/BOT_CLASS": denied,
      [HUMAN_LOC]: denied,
      "/http/top/locations": denied,
      "/http/top/ases": denied,
      "/bots/summary/BOT_CATEGORY": denied,
      "/attacks/layer7/top/locations/origin": denied,
      "/attacks/layer7/top/locations/target": denied,
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(7);
    expect(res.itemsFetched).toBe(2);
    expect(countryUpserts(h, "bot_density")).toEqual([]);
    expect(countryClears(h)).toEqual([]);
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

  it("happy path: writes all eight metrics, itemsNew 0, only touches the two snapshot tables", async () => {
    const h = makeHarness(allOk());
    const res = await cf_radar_bots.ingest(ctxOf(h.env));

    expect(res.itemsNew).toBe(0);
    expect(res.itemsDuplicate).toBe(0);
    expect(res.itemsError).toBe(0);
    expect(res.warning).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();

    // Authorization header + all 8 endpoints requested, with the expected params.
    expect(h.fetchedPaths).toHaveLength(8);
    const base = "https://api.cloudflare.com/client/v4/radar";
    expect(h.fetchedPaths).toEqual(expect.arrayContaining([
      `${base}/http/top/locations?botClass=LIKELY_AUTOMATED&dateRange=1d&limit=100&format=JSON`,
      `${base}/http/top/locations?botClass=LIKELY_HUMAN&dateRange=1d&limit=100&format=JSON`,
      `${base}/attacks/layer7/top/locations/origin?dateRange=7d&limit=10&format=JSON`,
      `${base}/attacks/layer7/top/locations/target?dateRange=7d&limit=10&format=JSON`,
    ]));

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
    const countryCount = stmts(h).filter((s) => /INSERT INTO radar_country_snapshots/.test(s.sql)).length;
    expect(res.itemsFetched).toBe(upsertCount + countryCount);
    expect(res.itemsFetched).toBe(4 + 2 + 1 + 1 + 2 + 1 + 2 + 1);

    // Ranked metrics are replaced per (date, metric); bot_share is never cleared.
    expect(clears(h).map((s) => s.args)).toEqual([
      ["2026-10-11", "top_location"], ["2026-10-11", "top_asn"], ["2026-10-11", "bot_category"],
    ]);
    expect(countryClears(h).map((s) => s.args)).toEqual([
      ["2026-10-11", "bot_density"], ["2026-10-11", "attack_origin"], ["2026-10-11", "attack_target"],
    ]);

    // Density: b=0.30, US B=40%, H=20% → traffic 26%, bot 46.1538%.
    expect(countryUpserts(h, "bot_density").map((s) => s.args)).toEqual([
      ["2026-10-11", "bot_density", "US", "United States", 1, 46.1538, 26],
    ]);
    // Attacks: value_pct = share of all L7 attacks; traffic_pct NULL.
    expect(countryUpserts(h, "attack_origin").map((s) => s.args)).toEqual([
      ["2026-10-11", "attack_origin", "CN", "China", 1, 18.5, null],
      ["2026-10-11", "attack_origin", "US", "United States", 2, 12, null],
    ]);
    expect(countryUpserts(h, "attack_target").map((s) => s.args)).toEqual([
      ["2026-10-11", "attack_target", "US", "United States", 1, 35, null],
    ]);
    // Each country metric's clear precedes its upserts.
    const idx = (pred: (s: Stmt) => boolean) => stmts(h).findIndex(pred);
    for (const m of ["bot_density", "attack_origin", "attack_target"]) {
      expect(idx((s) => /^DELETE FROM radar_country_snapshots/.test(s.sql) && s.args[1] === m))
        .toBeLessThan(idx((s) => /INSERT INTO radar_country_snapshots/.test(s.sql) && s.args[1] === m));
    }

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
    // Failure detail travels in FeedResult.warning (persisted by runFeed to
    // feed_pull_history.error_message), never console.
    expect(res.warning).toContain("partial pull (2 endpoint(s) failed)");
    expect(res.warning).toContain("timeseries: CF Radar /http/timeseries_groups/BOT_CLASS: HTTP 502");
    expect(res.warning).toContain("top_ases: CF Radar /http/top/ases: HTTP 500");
    expect(console.warn).not.toHaveBeenCalled();

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
    expect(res.warning).toContain("top_locations: empty result");
    expect(upserts(h, "top_location")).toEqual([]);
    expect(clears(h).some((s) => s.args[1] === "top_location")).toBe(false);
  });

  it.each([
    ["no serie_0", { success: true, result: {} }],
    ["no usable values", { success: true, result: { serie_0: { timestamps: ["2026-10-09T00:00:00Z"], bot: ["NaN"] } } }],
  ])("a 200 series with zero usable rows (%s) counts as an error, like the ranked endpoints", async (_n, body) => {
    const h = makeHarness({ ...allOk(), "/http/timeseries_groups/BOT_CLASS": () => respond(200, body) });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(res.warning).toContain("timeseries: empty result");
    expect(upserts(h, "bot_share")).toHaveLength(2);
  });

  it("a series whose only usable day is the snapshot date is NOT an error (that bucket is superseded by #1)", async () => {
    const h = makeHarness({
      ...allOk(),
      "/http/timeseries_groups/BOT_CLASS": () =>
        respond(200, { success: true, result: { serie_0: { timestamps: ["2026-10-11T00:00:00Z"], bot: ["31"] } } }),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(0);
    expect(res.warning).toBeUndefined();
  });

  it("all optional endpoints failing still writes the summary and reports 7 errors", async () => {
    const h = makeHarness({
      "/http/summary/BOT_CLASS": () => respond(200, SUMMARY),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(7);
    expect(res.itemsFetched).toBe(2);
    expect(res.itemsNew).toBe(0);
    expect(clears(h)).toEqual([]);
    expect(countryClears(h)).toEqual([]);
    // Density is skipped, not double-counted: 7 endpoint failures, no bot_density entry.
    expect(res.warning).not.toContain("bot_density");
  });

  // ─── radar_country_snapshots lane ─────────────────────────────

  it("stores only the top 10 bot locations as top_location while density uses the full limit=100 list", async () => {
    expect(TOP_LOCATIONS_STORED).toBe(10);
    const codes = Array.from({ length: 12 }, (_, i) => `C${String.fromCharCode(65 + i)}`); // CA..CL
    const botList = codes.map((c, i) => ({ clientCountryAlpha2: c, clientCountryName: c, value: String(20 - i) }));
    const humanList = codes.map((c) => ({ clientCountryAlpha2: c, clientCountryName: c, value: "5" }));
    const h = makeHarness({
      ...allOk(),
      [HUMAN_LOC]: () => respond(200, { success: true, result: { top_0: humanList } }),
      "/http/top/locations": () => respond(200, { success: true, result: { top_0: botList } }),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(0);
    const loc = upserts(h, "top_location");
    expect(loc.map((s) => s.args[2])).toEqual(codes.slice(0, 10));
    expect(loc.map((s) => s.args[4])).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    // All 12 countries qualify for density (> 0.1% traffic), and are ALL stored.
    const dens = countryUpserts(h, "bot_density");
    expect(dens).toHaveLength(12);
    expect(dens.map((s) => s.args[4])).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const botPcts = dens.map((s) => s.args[5] as number);
    expect([...botPcts].sort((a, b) => b - a)).toEqual(botPcts);
  });

  it.each([401, 403])("HTTP %i on the human locations is a partial failure: density skipped, its old rows kept", async (status) => {
    const h = makeHarness({ ...allOk(), [HUMAN_LOC]: () => respond(status, "denied") });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(res.warning).toMatch(/^partial pull \(1 endpoint\(s\) failed\): human_locations: CF Radar: CF_API_TOKEN lacks Radar Read permission \(HTTP \d+\)$/);
    expect(countryUpserts(h, "bot_density")).toEqual([]);
    expect(countryClears(h).some((s) => s.args[1] === "bot_density")).toBe(false);
    // Everything else still written.
    expect(upserts(h, "top_location")).toHaveLength(1);
    expect(countryUpserts(h, "attack_origin")).toHaveLength(2);
    expect(countryUpserts(h, "attack_target")).toHaveLength(1);
  });

  it("an empty human list counts as one error and skips density", async () => {
    const h = makeHarness({ ...allOk(), [HUMAN_LOC]: () => respond(200, { success: true, result: { top_0: [] } }) });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(res.warning).toContain("human_locations: empty result");
    expect(countryUpserts(h, "bot_density")).toEqual([]);
  });

  it("a failed bot locations list skips density without a second error", async () => {
    const h = makeHarness({ ...allOk(), "/http/top/locations": () => respond(500, "boom") });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(res.warning).toContain("top_locations: CF Radar /http/top/locations: HTTP 500");
    expect(res.warning).not.toContain("bot_density");
    expect(countryUpserts(h, "bot_density")).toEqual([]);
    expect(countryClears(h).some((s) => s.args[1] === "bot_density")).toBe(false);
  });

  it("a density with no qualifying country (no overlap / below floor) is an error and keeps old rows", async () => {
    const h = makeHarness({
      ...allOk(),
      [HUMAN_LOC]: () => respond(200, {
        success: true,
        result: { top_0: [{ clientCountryAlpha2: "ZZ", clientCountryName: "Elsewhere", value: "50" }] },
      }),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(res.warning).toContain("bot_density: empty result");
    expect(countryClears(h).some((s) => s.args[1] === "bot_density")).toBe(false);
  });

  it.each([401, 403])("HTTP %i on an attack endpoint is a partial failure; the other attack side still written", async (status) => {
    const h = makeHarness({ ...allOk(), "/attacks/layer7/top/locations/origin": () => respond(status, "denied") });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(1);
    expect(res.warning).toMatch(/attack_origins: CF Radar: CF_API_TOKEN lacks Radar Read permission/);
    expect(countryUpserts(h, "attack_origin")).toEqual([]);
    expect(countryClears(h).some((s) => s.args[1] === "attack_origin")).toBe(false);
    expect(countryUpserts(h, "attack_target")).toHaveLength(1);
  });

  it("attack failures (HTTP 500 / empty) are counted with their names", async () => {
    const h = makeHarness({
      ...allOk(),
      "/attacks/layer7/top/locations/origin": () => respond(500, "boom"),
      "/attacks/layer7/top/locations/target": () => respond(200, { success: true, result: { top_0: [] } }),
    });
    const res = await cf_radar_bots.ingest(ctxOf(h.env));
    expect(res.itemsError).toBe(2);
    expect(res.warning).toContain("attack_origins: CF Radar /attacks/layer7/top/locations/origin: HTTP 500");
    expect(res.warning).toContain("attack_targets: empty result");
    expect(countryClears(h).map((s) => s.args[1])).toEqual(["bot_density"]);
  });

  it("attack rows are dated by their own meta.dateRange endTime, falling back to the summary date", async () => {
    const h = makeHarness({
      ...allOk(),
      "/attacks/layer7/top/locations/origin": () => respond(200, {
        ...ATTACK_ORIGINS,
        result: { ...ATTACK_ORIGINS.result, meta: { dateRange: [{ endTime: "2026-10-10T23:00:00Z" }] } },
      }),
      "/attacks/layer7/top/locations/target": () => respond(200, {
        success: true,
        result: { top_0: ATTACK_TARGETS.result.top_0 },
      }),
    });
    await cf_radar_bots.ingest(ctxOf(h.env));
    expect(new Set(countryUpserts(h, "attack_origin").map((s) => s.args[0]))).toEqual(new Set(["2026-10-10"]));
    expect(countryClears(h).find((s) => s.args[1] === "attack_origin")!.args[0]).toBe("2026-10-10");
    expect(new Set(countryUpserts(h, "attack_target").map((s) => s.args[0]))).toEqual(new Set(["2026-10-11"]));
  });

  it("invalidates exactly the 7/30/90 bot_traffic cache keys after a successful write", async () => {
    const h = makeHarness(allOk());
    await cf_radar_bots.ingest(ctxOf(h.env));
    expect(h.cacheDeletes.sort()).toEqual(["bot_traffic:v3:30", "bot_traffic:v3:7", "bot_traffic:v3:90"]);
    // Invalidation happens after the batch write.
    expect(h.batches).toHaveLength(1);
  });

  it("a KV delete failure does not fail the pull", async () => {
    const h = makeHarness(allOk(), { token: "tok", cacheDeleteThrows: true });
    await expect(cf_radar_bots.ingest(ctxOf(h.env))).resolves.toMatchObject({ itemsNew: 0 });
  });
});
