/**
 * Spamhaus DROP (drop_v4.json) + ASN-DROP (asndrop.json):
 *   - the NDJSON parsers (records, trailing metadata line, malformed lines),
 *   - spamhaus_drop ingest: JSON only (no eDROP fetch), same threat rows/ids,
 *     fails the pull on HTTP error / zero parsed records,
 *   - spamhaus_asn_drop ingest: itemsNew = 0, never writes threats, upserts
 *     with ≤ 100 binds, delisting sweep only on a complete pull,
 *   - the staff provider detail exposes the listing as evidence metadata.
 *
 * Fixture lines are copied from the live files fetched 2026-11-14.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseDropV4Json,
  parseAsnDropJson,
  spamhausCreditLine,
  dedupeBy,
} from "../src/lib/spamhaus-drop-json";
import { spamhaus_drop, DROP_V4_URL } from "../src/feeds/spamhausDrop";
import {
  spamhaus_asn_drop,
  ASN_DROP_URL,
  asnDropSweepAllowed,
  sqliteUtcStamp,
} from "../src/feeds/spamhausAsnDrop";
import { feedModules } from "../src/feeds/index";
import { threatId } from "../src/feeds/types";
import { handleGetProvider } from "../src/handlers/providers";
import type { Env } from "../src/types";

const META = (records: number) =>
  `{"type":"metadata","timestamp":1794634004,"size":107327,"records":${records},"copyright":"(c) 2026 The Spamhaus Project SLU","terms":"https://www.spamhaus.org/drop/terms/"}`;

const DROP_V4 = [
  `{"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}`,
  `{"cidr":"1.19.0.0/16","sblid":"SBL434604","rir":"apnic"}`,
  `{"cidr":"223.254.0.0/16","sblid":"SBL212803","rir":"apnic"}`,
  META(3),
].join("\n") + "\n";

const ASN_DROP = [
  `{"asn":245,"rir":"arin","domain":"planningresearchcorp.com","cc":"US","asname":"PRC-AS"}`,
  `{"asn":2601,"rir":"ripencc","domain":"pitline.net","cc":"UA","asname":"RADIOLINK-AS"}`,
  `{"asn":403005,"rir":"arin","domain":"blatant.host","cc":"SC","asname":"BLATANTHOST"}`,
  META(3),
].join("\n");

// ─── Parsers ────────────────────────────────────────────────────

describe("parseDropV4Json", () => {
  it("parses records and the trailing metadata line", () => {
    const p = parseDropV4Json(DROP_V4);
    expect(p.records).toEqual([
      { cidr: "1.10.16.0/20", sblId: "SBL256894" },
      { cidr: "1.19.0.0/16", sblId: "SBL434604" },
      { cidr: "223.254.0.0/16", sblId: "SBL212803" },
    ]);
    expect(p.metadata).toEqual({
      timestamp: 1794634004,
      records: 3,
      copyright: "(c) 2026 The Spamhaus Project SLU",
      terms: "https://www.spamhaus.org/drop/terms/",
    });
    expect(p.malformed).toBe(0);
  });

  it("skips malformed, non-object, IPv6 and field-less lines; tolerates CRLF and blanks", () => {
    const text = [
      `{"cidr":"5.6.7.0/24","sblid":"SBL1"}\r`,
      "",
      "not json",
      "[1,2]",
      "42",
      `{"cidr":"2001:678:254::/48","sblid":"SBL697648"}`,
      `{"sblid":"SBL9"}`,
      `{"cidr":"9.9.9.0/24","sblid":"nonsense"}`,
    ].join("\n");
    const p = parseDropV4Json(text);
    expect(p.records).toEqual([
      { cidr: "5.6.7.0/24", sblId: "SBL1" },
      { cidr: "9.9.9.0/24", sblId: null },
    ]);
    expect(p.malformed).toBe(5);
    expect(p.metadata).toBeNull();
  });

  it("returns zero records for the old text format / an eDROP stub", () => {
    const p = parseDropV4Json("; This list has been merged into https://www.spamhaus.org/drop/drop.txt\n; EOF\n");
    expect(p.records).toEqual([]);
  });
});

describe("parseAsnDropJson", () => {
  it("keys ASNs with the canonical asnKey form", () => {
    const p = parseAsnDropJson(ASN_DROP);
    expect(p.records[0]).toEqual({
      asn: "AS245", asnNumber: 245, asName: "PRC-AS",
      asDomain: "planningresearchcorp.com", countryCode: "US", rir: "arin",
    });
    expect(p.records.map((r) => r.asn)).toEqual(["AS245", "AS2601", "AS403005"]);
    expect(p.metadata?.records).toBe(3);
  });

  it("accepts string ASNs, rejects junk ASNs and normalises cc", () => {
    const p = parseAsnDropJson([
      `{"asn":"AS64500","cc":"de"}`,
      `{"asn":"64501","cc":"Germany"}`,
      `{"asn":"bogus"}`,
      `{"asn":0}`,
      `{"asn":99999999999}`,
      `{"asn":null}`,
      `{"rir":"arin"}`,
    ].join("\n"));
    expect(p.records.map((r) => [r.asn, r.countryCode])).toEqual([["AS64500", "DE"], ["AS64501", null]]);
    expect(p.malformed).toBe(5);
  });
});

describe("helpers", () => {
  it("dedupeBy keeps the first occurrence", () => {
    expect(dedupeBy([{ k: "a", v: 1 }, { k: "a", v: 2 }, { k: "b", v: 3 }], (x) => x.k))
      .toEqual([{ k: "a", v: 1 }, { k: "b", v: 3 }]);
  });

  it("credit line carries the list date and © text", () => {
    const p = parseAsnDropJson(ASN_DROP);
    expect(spamhausCreditLine("ASN-DROP List", p.metadata))
      .toBe("Spamhaus ASN-DROP List 2026-11-14 - (c) 2026 The Spamhaus Project SLU");
    expect(spamhausCreditLine("DROP List", null)).toBe("Spamhaus DROP List date unknown - (c) The Spamhaus Project SLU");
  });

  it("sqliteUtcStamp matches datetime('now') shape", () => {
    expect(sqliteUtcStamp(new Date("2026-11-14T05:06:07.890Z"))).toBe("2026-11-14 05:06:07");
  });

  it("sweep is allowed only for a complete, clean pull", () => {
    const meta = parseAsnDropJson(ASN_DROP).metadata;
    expect(asnDropSweepAllowed(3, 0, meta, 0)).toBe(true);
    expect(asnDropSweepAllowed(2, 0, meta, 0)).toBe(false); // truncated
    expect(asnDropSweepAllowed(3, 1, meta, 0)).toBe(false); // malformed line
    expect(asnDropSweepAllowed(3, 0, meta, 1)).toBe(false); // a batch failed
    expect(asnDropSweepAllowed(3, 0, null, 0)).toBe(false); // no metadata
  });
});

// ─── Ingest harness ─────────────────────────────────────────────

interface Stmt { sql: string; binds: unknown[] }
interface Harness {
  env: Env;
  batches: Stmt[][];
  runs: Stmt[];
  fetched: string[];
}

function makeHarness(responses: Record<string, { status: number; body: string }>, opts: { batchThrows?: boolean } = {}): Harness {
  const h: Harness = { env: {} as Env, batches: [], runs: [], fetched: [] };
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url instanceof Request ? url.url : url);
    h.fetched.push(u);
    const r = responses[u];
    if (!r) return new Response("not found", { status: 404 });
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;

  const prepare = (sql: string) => {
    const stmt: Stmt & { bind: (...a: unknown[]) => unknown } = {
      sql,
      binds: [],
      bind(...a: unknown[]) {
        stmt.binds = a;
        return {
          ...stmt,
          run: async () => { h.runs.push({ sql, binds: a }); return { meta: { changes: 0 } }; },
          first: async () => null,
        };
      },
    };
    return stmt;
  };
  const DB = {
    prepare,
    batch: async (stmts: Stmt[]) => {
      if (opts.batchThrows) throw new Error("D1 overloaded");
      h.batches.push(stmts.map((s) => ({ sql: s.sql, binds: s.binds })));
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };
  const CACHE = { get: async () => "0", put: async () => undefined };
  h.env = { DB, CACHE } as unknown as Env;
  return h;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (h: Harness, feedName: string) => ({ env: h.env, feedName, feedUrl: "" });

describe("spamhaus_drop ingest (drop_v4.json)", () => {
  it("fetches only drop_v4.json (no eDROP) and writes the same threat rows as before", async () => {
    const h = makeHarness({ [DROP_V4_URL]: { status: 200, body: DROP_V4 } });
    const r = await spamhaus_drop.ingest(ctx(h, "spamhaus_drop"));
    expect(h.fetched).toEqual([DROP_V4_URL]);
    expect(h.fetched.some((u) => u.includes("edrop"))).toBe(false);
    expect(r).toMatchObject({ itemsFetched: 3, itemsNew: 3, itemsError: 0 });
    expect(r.warning).toBeUndefined();
    const inserts = h.batches.flat().filter((s) => s.sql.includes("INSERT OR IGNORE INTO threats"));
    expect(inserts).toHaveLength(3);
    expect(inserts[0]!.binds).toEqual([
      threatId("spamhaus_drop", "cidr", "1.10.16.0/20"), "1.10.16.0/20", "1.10.16.0/20", JSON.stringify(["SBL256894"]),
    ]);
  });

  it("dedupes CIDRs and warns when the list is short of its metadata count", async () => {
    const body = [`{"cidr":"1.2.3.0/24","sblid":"SBL1"}`, `{"cidr":"1.2.3.0/24","sblid":"SBL1"}`, "garbage", META(5)].join("\n");
    const h = makeHarness({ [DROP_V4_URL]: { status: 200, body } });
    const r = await spamhaus_drop.ingest(ctx(h, "spamhaus_drop"));
    expect(r.itemsFetched).toBe(1);
    expect(r.warning).toContain("1 malformed");
    expect(r.warning).toContain("parsed 1 of 5");
  });

  it("fails the pull on HTTP error", async () => {
    const h = makeHarness({ [DROP_V4_URL]: { status: 503, body: "" } });
    await expect(spamhaus_drop.ingest(ctx(h, "spamhaus_drop"))).rejects.toThrow(/HTTP 503/);
  });

  it("fails the pull when zero records parse", async () => {
    const h = makeHarness({ [DROP_V4_URL]: { status: 200, body: "; EOF\n" + META(0) } });
    await expect(spamhaus_drop.ingest(ctx(h, "spamhaus_drop"))).rejects.toThrow(/0 records/);
    expect(h.batches).toEqual([]);
  });
});

describe("spamhaus_asn_drop ingest", () => {
  it("is registered as an ingest feed module", () => {
    expect(feedModules["spamhaus_asn_drop"]).toBe(spamhaus_asn_drop);
  });

  it("upserts the reference table, never threats, reports itemsNew = 0 and sweeps on a complete pull", async () => {
    const h = makeHarness({ [ASN_DROP_URL]: { status: 200, body: ASN_DROP } });
    const r = await spamhaus_asn_drop.ingest(ctx(h, "spamhaus_asn_drop"));
    expect(h.fetched).toEqual([ASN_DROP_URL]);
    expect(r).toEqual({ itemsFetched: 3, itemsNew: 0, itemsDuplicate: 3, itemsError: 0 });

    const all = [...h.batches.flat(), ...h.runs];
    expect(all.some((s) => /\bthreats\b/.test(s.sql))).toBe(false);
    expect(all.some((s) => /\balerts\b/.test(s.sql))).toBe(false);

    const upserts = h.batches.flat();
    expect(upserts).toHaveLength(3);
    for (const s of upserts) {
      expect(s.sql).toContain("ON CONFLICT(asn) DO UPDATE");
      expect(s.binds.length).toBeLessThanOrEqual(100);
    }
    expect(upserts[0]!.binds.slice(0, 6)).toEqual(["AS245", 245, "PRC-AS", "planningresearchcorp.com", "US", "arin"]);
    expect(upserts[0]!.binds[7]).toBe(1794634004);
    expect(upserts[0]!.binds[8]).toBe("Spamhaus ASN-DROP List 2026-11-14 - (c) 2026 The Spamhaus Project SLU");

    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.sql).toContain("SET removed_at = ?1");
    expect(h.runs[0]!.binds[0]).toBe(upserts[0]!.binds[6]); // same run stamp
  });

  it("skips the delisting sweep when the pull is truncated", async () => {
    const h = makeHarness({ [ASN_DROP_URL]: { status: 200, body: ASN_DROP.replace(META(3), META(455)) } });
    const r = await spamhaus_asn_drop.ingest(ctx(h, "spamhaus_asn_drop"));
    expect(h.runs).toEqual([]);
    expect(r.warning).toContain("delisting sweep skipped");
    expect(r.itemsNew).toBe(0);
  });

  it("fails the pull on HTTP error, zero records, or every batch failing", async () => {
    await expect(spamhaus_asn_drop.ingest(ctx(makeHarness({ [ASN_DROP_URL]: { status: 403, body: "" } }), "x")))
      .rejects.toThrow(/HTTP 403/);
    await expect(spamhaus_asn_drop.ingest(ctx(makeHarness({ [ASN_DROP_URL]: { status: 200, body: META(0) } }), "x")))
      .rejects.toThrow(/0 records/);
    const h = makeHarness({ [ASN_DROP_URL]: { status: 200, body: ASN_DROP } }, { batchThrows: true });
    await expect(spamhaus_asn_drop.ingest(ctx(h, "x"))).rejects.toThrow(/every upsert batch failed/);
    expect(h.runs).toEqual([]);
  });
});

// ─── Consumer: staff provider detail ────────────────────────────

function providerEnv(provider: { asn: string | null } | null, asnDropRow: Record<string, unknown> | null, asnDropThrows = false) {
  const asnDropBinds: unknown[][] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...a: unknown[]) {
          return {
            first: async () => {
              if (sql.includes("FROM hosting_providers")) return provider ? { id: "hp_x", name: "X Hosting", country: "US", reputation_score: null, avg_response_time: null, ...provider } : null;
              if (sql.includes("FROM spamhaus_asn_drop")) {
                asnDropBinds.push(a);
                if (asnDropThrows) throw new Error("no such table: spamhaus_asn_drop");
                return asnDropRow;
              }
              if (sql.includes("FROM threats")) return { total_threats: 0 };
              return null;
            },
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, asnDropBinds };
}

async function providerData(env: Env): Promise<Record<string, unknown>> {
  const res = await handleGetProvider(new Request("https://averrow.com/api/providers/hp_x"), env, "hp_x");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

describe("GET /api/providers/:id — spamhaus_asn_drop evidence field", () => {
  const row = {
    asn: "AS403005", as_name: "BLATANTHOST", as_domain: "blatant.host", country_code: "SC",
    first_seen: "2026-11-14 05:00:00", last_seen: "2026-11-14 05:00:00",
    list_copyright: "Spamhaus ASN-DROP List 2026-11-14 - (c) 2026 The Spamhaus Project SLU",
  };

  it("looks the provider up by canonical ASN key and returns the listing with attribution", async () => {
    const { env, asnDropBinds } = providerEnv({ asn: "403005" }, row);
    const data = await providerData(env);
    expect(asnDropBinds).toEqual([["AS403005"]]);
    expect(data["spamhaus_asn_drop"]).toEqual({
      listed: true, asn: "AS403005", as_name: "BLATANTHOST", as_domain: "blatant.host", country_code: "SC",
      first_seen: row.first_seen, last_seen: row.last_seen, attribution: row.list_copyright,
    });
  });

  it("is null when not listed, when the provider has no ASN, and when the table is unreadable", async () => {
    expect((await providerData(providerEnv({ asn: "AS13335" }, null).env))["spamhaus_asn_drop"]).toBeNull();
    const noAsn = providerEnv({ asn: null }, row);
    expect((await providerData(noAsn.env))["spamhaus_asn_drop"]).toBeNull();
    expect(noAsn.asnDropBinds).toEqual([]);
    expect((await providerData(providerEnv({ asn: "AS403005" }, row, true).env))["spamhaus_asn_drop"]).toBeNull();
  });
});
