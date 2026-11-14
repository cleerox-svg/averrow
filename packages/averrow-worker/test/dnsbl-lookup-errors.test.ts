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
import { DnsblLookupError, dohLookupA, dnsblRunShouldFail } from "../src/lib/dnsbl-doh";
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
  it("throws a refused error on SERVFAIL / REFUSED, never returns clean", async () => {
    stubDoh(() => SERVFAIL);
    await expect(dohLookupA("x.multi.surbl.org")).rejects.toMatchObject({ name: "DnsblLookupError", kind: "refused" });
    stubDoh(() => ({ Status: 5 }));
    await expect(dohLookupA("x.multi.surbl.org")).rejects.toMatchObject({ kind: "refused" });
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
  it.each(["127.255.255.252", "127.255.255.254", "127.255.255.255", "127.0.1.255"])(
    "%s is a Spamhaus error code → refused, not clean",
    (ip) => {
      expect(() => decodeDBLAnswer("a.com", { status: 0, addresses: [ip] })).toThrow(DnsblLookupError);
    },
  );

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

  it("fails the pull on a refused lookup mid-run and leaves that row unchecked", async () => {
    const { raw, kv, ctx } = setup();
    stubDoh((name) => (name.startsWith(SURBL_TEST_POINT) ? listed("127.0.0.254") : SERVFAIL));
    await expect(surbl.ingest(ctx)).rejects.toThrow(/SURBL lookups refused/);
    expect(checkedFlags(raw, "surbl_checked")).toEqual([0, 0]);
    expect([...kv.store.keys()]).toEqual([]);
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

  it("fails the pull on an error code mid-run without stamping the row", async () => {
    const { raw, ctx } = setup();
    stubDoh((name) => (name.startsWith(DBL_TEST_POINT) ? listed("127.0.1.2") : listed("127.255.255.255")));
    await expect(spamhaus_dbl.ingest(ctx)).rejects.toThrow(/Spamhaus DBL lookups refused/);
    expect(checkedFlags(raw, "dbl_checked")).toEqual([0]);
  });
});

describe.skipIf(!hasSqlite())("migration 0326 + Flight Control retired-feed gate", () => {
  it("disables spamhaus_dbl and dshield with a manual: reason, which FC reads as retired", async () => {
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
    // SURBL is deliberately NOT disabled: honest failure + the breaker handle it.
    expect(String(byName.get("surbl")?.paused_reason ?? "")).not.toMatch(/^manual:licence/);

    const retired = await loadManuallyDisabledFeeds(d1FromSqlite(raw));
    expect(retired.has("spamhaus_dbl")).toBe(true);
    expect(retired.has("dshield")).toBe(true);
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
