/**
 * DNSBL lookup errors are never "clean" (report: Free threat feeds and
 * signal techniques, 2026-11-13; live DoH test 2026-11-14).
 *
 *   - Spamhaus answers public resolvers with 127.255.255.254; the old DBL
 *     decoder read it as "not listed" and stamped dbl_checked = 1.
 *   - SURBL answered SERVFAIL ("No Reachable Authority") through the same
 *     resolver; the old SURBL decoder read it as "not listed" and stamped
 *     surbl_checked = 1.
 *
 * Pins: error codes / RCODEs → DnsblLookupError (not clean), each run
 * self-tests on the list's permanent test point and fails the pull when
 * it does not come back listed, refused lookups mid-run fail the pull,
 * and no failed lookup stamps a row checked or is cached.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DnsblLookupError,
  dohLookupA,
  dnsblQueryName,
  dnsblRunShouldFail,
  pickDnsblBatch,
} from "../src/lib/dnsbl-doh";
import { dnsblListedFlag, dnsblListedRowValue, withDnsblVerdicts } from "../src/lib/dnsbl-verdict";
import { decodeSURBLAnswer, surbl, SURBL_TEST_POINT } from "../src/feeds/surbl";
import { decodeDBLAnswer, spamhaus_dbl, DBL_TEST_POINT } from "../src/feeds/spamhausDbl";
import { loadManuallyDisabledFeeds } from "../src/agents/flightControl";
import { d1FromSqlite, fakeKv, hasSqlite, openMigratedDb, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

type DohJson = { Status: number; Answer?: Array<{ type?: number; data: string }>; Comment?: string[] };

/** Stub fetch: answer each DoH query by the queried name. */
function stubDoh(answer: (name: string) => DohJson | Response): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const name = url.searchParams.get("name") ?? "";
    const a = answer(name);
    return a instanceof Response ? a : new Response(JSON.stringify(a), { status: 200 });
  }));
}

const listed = (ip: string): DohJson => ({ Status: 0, Answer: [{ type: 1, data: ip }] });
const NXDOMAIN: DohJson = { Status: 3 };
const SERVFAIL: DohJson = { Status: 2, Comment: ["EDE(22): No Reachable Authority at delegation multi.surbl.org."] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dohLookupA", () => {
  it("never returns clean on an error RCODE: SERVFAIL transient, REFUSED run-level, FORMERR per-row", async () => {
    stubDoh(() => SERVFAIL);
    await expect(dohLookupA("x.multi.surbl.org")).rejects.toMatchObject({ name: "DnsblLookupError", kind: "transient" });
    stubDoh(() => ({ Status: 5 }));
    await expect(dohLookupA("x.multi.surbl.org")).rejects.toMatchObject({ kind: "refused" });
    stubDoh(() => ({ Status: 1 }));
    await expect(dohLookupA("x.multi.surbl.org")).rejects.toMatchObject({ kind: "row" });
  });

  it("throws a transient error on HTTP failure or a non-JSON body", async () => {
    stubDoh(() => new Response("bad", { status: 502 }));
    await expect(dohLookupA("x.dbl.spamhaus.org")).rejects.toMatchObject({ kind: "transient" });
    stubDoh(() => new Response("<html>", { status: 200 }));
    await expect(dohLookupA("x.dbl.spamhaus.org")).rejects.toMatchObject({ kind: "transient" });
  });

  it("returns NXDOMAIN and A records, ignoring CNAME hops", async () => {
    stubDoh(() => NXDOMAIN);
    expect(await dohLookupA("x")).toEqual({ status: 3, addresses: [] });
    stubDoh(() => ({ Status: 0, Answer: [{ type: 5, data: "alias.example." }, { type: 1, data: "127.0.0.8" }] }));
    expect(await dohLookupA("x")).toEqual({ status: 0, addresses: ["127.0.0.8"] });
  });

  it("dnsblRunShouldFail only when every attempted lookup errored", () => {
    expect(dnsblRunShouldFail(0, 0)).toBe(false);
    expect(dnsblRunShouldFail(5, 4)).toBe(false);
    expect(dnsblRunShouldFail(5, 5)).toBe(true);
  });
});

describe("decodeDBLAnswer", () => {
  it.each(["127.255.255.252", "127.255.255.254", "127.255.255.255"])(
    "%s is a Spamhaus error code → refused (run-level), not clean",
    (ip) => {
      expect(() => decodeDBLAnswer("a.com", { status: 0, addresses: [ip] }))
        .toThrow(expect.objectContaining({ kind: "refused" }));
    },
  );

  it("127.0.1.255 (IP queries prohibited) is a per-row error, not run-level", () => {
    expect(() => decodeDBLAnswer("a.com", { status: 0, addresses: ["127.0.1.255"] }))
      .toThrow(expect.objectContaining({ kind: "row" }));
  });

  it("127.0.1.x is a listing; NXDOMAIN is clean", () => {
    expect(decodeDBLAnswer("a.com", { status: 0, addresses: ["127.0.1.4"] }))
      .toEqual({ listed: true, listingType: "phishing", raw: "127.0.1.4" });
    expect(decodeDBLAnswer("a.com", { status: 3, addresses: [] }))
      .toEqual({ listed: false, listingType: null, raw: null });
  });

  it("an unexpected (non-127) answer is an error, not clean", () => {
    expect(() => decodeDBLAnswer("a.com", { status: 0, addresses: ["93.184.216.34"] })).toThrow(DnsblLookupError);
  });
});

describe("dnsblQueryName", () => {
  it.each([
    ["Example.COM.", "example.com"],
    ["xn--pple-43d.com", "xn--pple-43d.com"],
    ["a_b.example.org", "a_b.example.org"],
  ])("accepts %s", (input, out) => {
    expect(dnsblQueryName(input, "multi.surbl.org")).toBe(out);
  });

  it.each([
    "192.0.2.1", "[2001:db8::1]", "2001:db8::1", "localhost", "-bad.com", "bad-.com",
    "sp ace.com", "a..b.com", "example.123", `${"a".repeat(64)}.com`,
    `${Array.from({ length: 8 }, () => "a".repeat(30)).join(".")}.com`, "",
  ])("rejects %s", (input) => {
    expect(dnsblQueryName(input, "multi.surbl.org")).toBeNull();
  });

  it("counts the zone toward the 253-char limit", () => {
    const d = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(55)}.com`; // 242 chars
    expect(dnsblQueryName(d, "x.io")).toBe(d);
    expect(dnsblQueryName(d, "multi.surbl.org")).toBeNull();
  });
});

describe("pickDnsblBatch", () => {
  it("moves recently failed names behind fresh work but still retries them", async () => {
    const kv = fakeKv({ "p:a.com": "1", "p:b.com": "1" });
    const rows = ["a.com", "b.com", "c.com", "d.com"];
    expect(await pickDnsblBatch(rows, (r) => r, kv, "p:", 2)).toEqual(["c.com", "d.com"]);
    expect(await pickDnsblBatch(rows, (r) => r, kv, "p:", 3)).toEqual(["c.com", "d.com", "a.com"]);
  });
});

describe("dnsbl verdict presentation", () => {
  it("listed → true / 1; not listed or unknown → null, never false / 0", () => {
    expect(dnsblListedFlag(1)).toBe(true);
    expect(dnsblListedFlag(0)).toBeNull();
    expect(dnsblListedFlag(null)).toBeNull();
    expect(dnsblListedRowValue(1)).toBe(1);
    expect(dnsblListedRowValue(0)).toBeNull();
  });

  it("withDnsblVerdicts rewrites only the listed keys that are present", () => {
    expect(withDnsblVerdicts({ id: "t", surbl_checked: 1, surbl_listed: 0, vt_malicious: 0 }))
      .toEqual({ id: "t", surbl_checked: 1, surbl_listed: null, vt_malicious: 0 });
    expect(withDnsblVerdicts({ surbl_listed: 1, dbl_listed: 0 })).toEqual({ surbl_listed: 1, dbl_listed: null });
    expect(withDnsblVerdicts({ id: "x" })).toEqual({ id: "x" });
  });
});

describe("decodeSURBLAnswer", () => {
  it("127.0.0.1 (SURBL 'access blocked') → refused, not listed or clean", () => {
    expect(() => decodeSURBLAnswer("a.com", { status: 0, addresses: ["127.0.0.1"] }))
      .toThrow(/access blocked/);
  });

  it("127.0.0.X decodes the bitmask; NXDOMAIN is clean", () => {
    expect(decodeSURBLAnswer("a.com", { status: 0, addresses: ["127.0.0.24"] }))
      .toEqual({ listed: true, types: ["PH", "MW"], raw: 24 });
    expect(decodeSURBLAnswer("a.com", { status: 3, addresses: [] }))
      .toEqual({ listed: false, types: [], raw: null });
  });
});

// ─── Ingest runs against a migrated schema ─────────────────────────────

function seedThreat(raw: SqliteDb, id: string, domain: string): void {
  raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, severity, status, created_at, first_seen)
     VALUES (?, 'test', 'phishing', ?, 'high', 'active', datetime('now'), datetime('now'))`,
  ).run(id, domain);
}

function checkedFlags(raw: SqliteDb, col: "surbl_checked" | "dbl_checked"): number[] {
  return (raw.prepare(`SELECT ${col} AS c FROM threats ORDER BY id`).all() as Array<{ c: number }>).map((r) => r.c);
}

describe.skipIf(!hasSqlite())("SURBL ingest", () => {
  function setup() {
    const raw = openMigratedDb();
    seedThreat(raw, "t1", "one.example");
    seedThreat(raw, "t2", "two.example");
    const kv = fakeKv();
    const env = { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env;
    return { raw, kv, env, ctx: { env, feedName: "surbl", feedUrl: "" } };
  }

  it("aborts the run when the permanent test point is not listed (SERVFAIL resolver), stamping nothing", async () => {
    const { raw, kv, ctx } = setup();
    stubDoh(() => SERVFAIL);
    await expect(surbl.ingest(ctx)).rejects.toThrow(/SURBL self-test failed/);
    expect(checkedFlags(raw, "surbl_checked")).toEqual([0, 0]);
    expect(kv.store.size).toBe(0);
  });

  it("aborts when the test point resolves NXDOMAIN (blind but answering)", async () => {
    const { ctx } = setup();
    stubDoh(() => NXDOMAIN);
    await expect(surbl.ingest(ctx)).rejects.toThrow(/test point is not listed/);
  });

  it("fails the pull on a refused lookup mid-run (127.0.0.1) and leaves rows unchecked", async () => {
    const { raw, kv, ctx } = setup();
    stubDoh((name) => (name.startsWith(SURBL_TEST_POINT) ? listed("127.0.0.254") : listed("127.0.0.1")));
    await expect(surbl.ingest(ctx)).rejects.toThrow(/SURBL lookups refused/);
    expect(checkedFlags(raw, "surbl_checked")).toEqual([0, 0]);
    expect([...kv.store.keys()].filter((k) => !k.includes(":retry:"))).toEqual([]);
  });

  it("SERVFAIL / FORMERR for one name is a per-row error: the run continues and the name is backed off", async () => {
    const { raw, kv, ctx } = setup();
    stubDoh((name) => {
      if (name.startsWith(SURBL_TEST_POINT)) return listed("127.0.0.254");
      if (name.startsWith("one.example")) return SERVFAIL;
      return NXDOMAIN;
    });
    const r = await surbl.ingest(ctx);
    expect(r).toMatchObject({ itemsFetched: 2, itemsError: 1, itemsDuplicate: 1 });
    expect(checkedFlags(raw, "surbl_checked")).toEqual([0, 1]);
    expect(kv.store.has("surbl:v2:retry:one.example")).toBe(true);
    expect(kv.store.has("surbl:v2:one.example")).toBe(false);
  });

  it("an invalid name (IP literal) is stamped not-applicable without a lookup and never aborts the run", async () => {
    const { raw, ctx } = setup();
    seedThreat(raw, "t3", "192.0.2.10");
    const queried: string[] = [];
    stubDoh((name) => {
      queried.push(name);
      return name.startsWith(SURBL_TEST_POINT) ? listed("127.0.0.254") : NXDOMAIN;
    });
    await surbl.ingest(ctx);
    expect(queried.some((q) => q.startsWith("192.0.2.10"))).toBe(false);
    expect(checkedFlags(raw, "surbl_checked")).toEqual([1, 1, 1]);
  });

  it("fails the pull when every lookup errors transiently, without stamping", async () => {
    const { raw, ctx } = setup();
    stubDoh((name) => (name.startsWith(SURBL_TEST_POINT) ? listed("127.0.0.254") : new Response("x", { status: 503 })));
    await expect(surbl.ingest(ctx)).rejects.toThrow(/all 2 lookups failed/);
    expect(checkedFlags(raw, "surbl_checked")).toEqual([0, 0]);
  });

  it("a healthy run stamps clean on NXDOMAIN and listed on a listing, caching under v2 keys", async () => {
    const { raw, kv, ctx } = setup();
    stubDoh((name) => {
      if (name.startsWith(SURBL_TEST_POINT)) return listed("127.0.0.254");
      if (name.startsWith("one.example")) return listed("127.0.0.8");
      return NXDOMAIN;
    });
    const r = await surbl.ingest(ctx);
    expect(r).toMatchObject({ itemsFetched: 2, itemsNew: 1, itemsDuplicate: 1, itemsError: 0 });
    const rows = raw.prepare(`SELECT id, surbl_checked, surbl_listed FROM threats ORDER BY id`).all();
    expect(rows).toEqual([
      { id: "t1", surbl_checked: 1, surbl_listed: 1 },
      { id: "t2", surbl_checked: 1, surbl_listed: 0 },
    ]);
    expect([...kv.store.keys()].sort()).toEqual(["surbl:v2:one.example", "surbl:v2:two.example"]);
  });
});

describe.skipIf(!hasSqlite())("Spamhaus DBL ingest", () => {
  function setup() {
    const raw = openMigratedDb();
    seedThreat(raw, "t1", "one.example");
    const kv = fakeKv();
    const env = { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env;
    return { raw, kv, ctx: { env, feedName: "spamhaus_dbl", feedUrl: "" } };
  }

  it("aborts when dbltest.com comes back as the public-resolver error code", async () => {
    const { raw, kv, ctx } = setup();
    stubDoh(() => listed("127.255.255.254"));
    await expect(spamhaus_dbl.ingest(ctx)).rejects.toThrow(/Spamhaus DBL self-test failed/);
    expect(checkedFlags(raw, "dbl_checked")).toEqual([0]);
    expect(kv.store.size).toBe(0);
  });

  it("127.0.1.255 for one name is per-row, not run-level", async () => {
    const { raw, kv, ctx } = setup();
    stubDoh((name) => (name.startsWith(DBL_TEST_POINT) ? listed("127.0.1.2") : listed("127.0.1.255")));
    // The only row errored → the all-failed rule fails the pull, but with
    // the per-row message, not "refused".
    await expect(spamhaus_dbl.ingest(ctx)).rejects.toThrow(/all 1 lookups failed/);
    expect(checkedFlags(raw, "dbl_checked")).toEqual([0]);
    expect(kv.store.has("dbl:v2:retry:one.example")).toBe(true);
  });

  it("fails the pull on an error code mid-run without stamping the row", async () => {
    const { raw, ctx } = setup();
    stubDoh((name) => (name.startsWith(DBL_TEST_POINT) ? listed("127.0.1.2") : listed("127.255.255.255")));
    await expect(spamhaus_dbl.ingest(ctx)).rejects.toThrow(/Spamhaus DBL lookups refused/);
    expect(checkedFlags(raw, "dbl_checked")).toEqual([0]);
  });
});

describe.skipIf(!hasSqlite())("migration 0326 + Flight Control retired-feed gate", () => {
  it("disables spamhaus_dbl, dshield and surbl with a manual: reason, which FC reads as retired", async () => {
    const raw = openMigratedDb();
    const rows = raw.prepare(
      `SELECT feed_name, enabled, paused_reason FROM feed_configs
        WHERE feed_name IN ('spamhaus_dbl', 'dshield', 'surbl') ORDER BY feed_name`,
    ).all() as Array<{ feed_name: string; enabled: number; paused_reason: string | null }>;
    const byName = new Map(rows.map((r) => [r.feed_name, r]));
    expect(byName.get("spamhaus_dbl")?.enabled).toBe(0);
    expect(byName.get("spamhaus_dbl")?.paused_reason).toMatch(/^manual:licence_noncommercial/);
    expect(byName.get("dshield")?.enabled).toBe(0);
    expect(byName.get("dshield")?.paused_reason).toMatch(/SANS/);
    // SURBL is blind via public resolvers: retired rather than left to
    // fail every pull into auto-pause / incident / auto-recover loops.
    expect(byName.get("surbl")?.enabled).toBe(0);
    expect(byName.get("surbl")?.paused_reason).toMatch(/^manual:blind_resolver/);

    const status = raw.prepare(
      `SELECT feed_name, health_status, consecutive_failures, next_retry_at FROM feed_status
        WHERE feed_name IN ('spamhaus_dbl', 'dshield', 'surbl')`,
    ).all() as Array<{ health_status: string; consecutive_failures: number; next_retry_at: string | null }>;
    for (const r of status) expect(r).toMatchObject({ health_status: "disabled", consecutive_failures: 0, next_retry_at: null });

    const retired = await loadManuallyDisabledFeeds(d1FromSqlite(raw));
    expect(retired.has("spamhaus_dbl")).toBe(true);
    expect(retired.has("dshield")).toBe(true);
    expect(retired.has("surbl")).toBe(true);
  });

  it("an admin-UI pause (bare 'manual', no colon) is NOT exempt", async () => {
    const raw = openMigratedDb();
    raw.prepare(`UPDATE feed_configs SET enabled = 0, paused_reason = 'manual' WHERE feed_name = 'virustotal'`).run();
    const retired = await loadManuallyDisabledFeeds(d1FromSqlite(raw));
    expect(retired.has("virustotal")).toBe(false);
  });

  it("ignores auto-paused feeds (their backlog is still a signal)", async () => {
    const raw = openMigratedDb();
    raw.prepare(`UPDATE feed_configs SET enabled = 0, paused_reason = 'auto:consecutive_failures' WHERE feed_name = 'surbl'`).run();
    const retired = await loadManuallyDisabledFeeds(d1FromSqlite(raw));
    expect(retired.has("surbl")).toBe(false);
  });

  it("fails soft to an empty set on a read error", async () => {
    const db = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    expect((await loadManuallyDisabledFeeds(db)).size).toBe(0);
  });
});
