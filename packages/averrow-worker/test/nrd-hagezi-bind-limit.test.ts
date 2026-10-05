// nrd_hagezi stores every NEW domain of the daily diff (~443K/day) in
// nrd_domains. The old insert bound 500 rows × 2 = 1000 params per statement
// and every prod pull died with "too many SQL variables at offset 418". The
// SQLite harness allows ~32K binds, so the D1 here is wrapped to throw like
// production D1 does above 100.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  nrd_hagezi,
  storeNrdReference,
  NRD_DOMAINS_PER_STATEMENT,
  NRD_STATEMENTS_PER_BATCH,
  NRD_SNAPSHOT_KEY,
} from "../src/feeds/nrd_hagezi";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { fakeR2Bucket, gzipText } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const D1_MAX_BINDS = 100;

interface BindStats { maxBinds: number; statements: number; batchCalls: number }

/** Wrap a D1 so any statement bound with >100 params throws (prod D1 behaviour). */
function bindLimited(db: D1Database, stats: BindStats): D1Database {
  return {
    ...db,
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          stats.maxBinds = Math.max(stats.maxBinds, args.length);
          stats.statements++;
          if (args.length > D1_MAX_BINDS) throw new Error(`too many SQL variables (${args.length})`);
          return stmt.bind(...args);
        },
      } as D1PreparedStatement;
    },
    batch: async <T>(stmts: D1PreparedStatement[]) => {
      stats.batchCalls++;
      return db.batch<T>(stmts);
    },
  } as D1Database;
}

const domainList = (n: number, prefix = "nrd"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}.example`);

let raw: SqliteDb;
let stats: BindStats;
let db: D1Database;

const count = (sql: string, ...p: unknown[]): number =>
  (raw.prepare(sql).all(...p)[0] as { n: number }).n;

/** Env with an EMPTY prior R2 snapshot, so the diff treats every listed domain as new. */
async function envWithEmptyPrior(): Promise<Env> {
  const { bucket } = fakeR2Bucket({
    [NRD_SNAPSHOT_KEY]: { bytes: await gzipText(""), customMetadata: { version: "prior" } },
  });
  return { DB: db, CACHE: fakeKv(), GEOIP_STAGING: bucket } as unknown as Env;
}

describe.skipIf(!hasSqlite())("nrd_hagezi — D1 100-bind limit", () => {
  beforeEach(() => {
    raw = openDerivedDb(["brands", "monitored_brands", "threats"]);
    stats = { maxBinds: 0, statements: 0, batchCalls: 0 };
    db = bindLimited(d1FromSqlite(raw), stats);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores 1000 domains with no statement over 100 binds", async () => {
    await storeNrdReference(db, domainList(1000), "2026-10-03");

    expect(stats.maxBinds).toBeLessThanOrEqual(D1_MAX_BINDS);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains")).toBe(1000);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains WHERE registered_date = '2026-10-03'")).toBe(1000);
  });

  it("a 180K-domain flush stays ≤100 binds and needs only a handful of batch calls", async () => {
    const n = 180_000;
    await storeNrdReference(db, domainList(n), "2026-10-03");

    const expectedStatements = Math.ceil(n / NRD_DOMAINS_PER_STATEMENT);
    expect(stats.maxBinds).toBeLessThanOrEqual(D1_MAX_BINDS);
    expect(stats.batchCalls).toBe(Math.ceil(expectedStatements / NRD_STATEMENTS_PER_BATCH));
    expect(stats.batchCalls).toBeLessThanOrEqual(10);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains")).toBe(n);
  });

  it("preserves INSERT OR IGNORE semantics: in-list duplicates + re-runs keep the first registered_date", async () => {
    const first = [...domainList(1000), "dup.example", "dup.example"];
    await storeNrdReference(db, first, "2026-10-02");
    // Overlapping re-run on a later date: existing rows keep 2026-10-02,
    // only the 500 genuinely new domains land with 2026-10-03.
    await storeNrdReference(db, [...domainList(1000), ...domainList(500, "fresh")], "2026-10-03");

    expect(stats.maxBinds).toBeLessThanOrEqual(D1_MAX_BINDS);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains")).toBe(1501);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains WHERE domain = 'dup.example'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains WHERE registered_date = '2026-10-02'")).toBe(1001);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains WHERE registered_date = '2026-10-03'")).toBe(500);
  });

  it("full ingest: 1000-domain list diffed against an empty snapshot lands, brand matching still fires", async () => {
    raw.exec(`
      INSERT INTO brands (id, name, canonical_domain) VALUES ('b_acme', 'Acme Bank', 'acmebank.com');
      INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES ('b_acme', '__internal__', 'u1', 'active');
      INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES ('b_acme', 'tenant-2', 'u1', 'active');
    `);
    const domains = [
      ...domainList(997),
      "acmebank-login.example", // direct keyword hit
      "acmeb4nk-secure.example", // homoglyph a→4 hit
      "acmebank.com", // the brand's own canonical domain — never a threat
    ];
    const body = `# header\n${[...domains].sort().join("\n")}\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    const env = await envWithEmptyPrior();
    const result = await nrd_hagezi.ingest({ env, feedName: "nrd_hagezi", feedUrl: "" });

    expect(stats.maxBinds).toBeLessThanOrEqual(D1_MAX_BINDS);
    expect(result.itemsFetched).toBe(1000);
    expect(result.itemsNew).toBe(2);
    expect(result.itemsError).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM nrd_domains")).toBe(1000);
    expect(count("SELECT COUNT(*) AS n FROM threats WHERE source_feed = 'nrd_hagezi' AND target_brand_id = 'b_acme'")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM threats WHERE malicious_domain = 'acmebank.com'")).toBe(0);
  });

  it("brand keywords under 3 chars never match", async () => {
    raw.exec(`
      INSERT INTO brands (id, name, canonical_domain) VALUES ('b_hp', 'HP', 'hp.com');
      INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES ('b_hp', '__internal__', 'u1', 'active');
    `);
    const domains = ["hp-support.example", "shopping.example", "hplogin.example"];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${[...domains].sort().join("\n")}\n`, { status: 200 })));

    const env = await envWithEmptyPrior();
    const result = await nrd_hagezi.ingest({ env, feedName: "nrd_hagezi", feedUrl: "" });

    expect(result.itemsFetched).toBe(3);
    expect(result.itemsNew).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM threats WHERE source_feed = 'nrd_hagezi'")).toBe(0);
  });
});
