/**
 * nrd_hagezi matchable filter (D1 write cut, owner decision 2026-10-05).
 *
 * nrd_domains now stores only the NEW NRDs that are byte-equal to a
 * lookalike_domains.domain or a phantom_domains.domain — the only rows the
 * two readers' joins (`l.domain = n.domain`, `t.domain = p.domain`, BINARY
 * TEXT) can ever return. Everything new is still archived to R2 and still
 * brand-matched into threats.
 *
 * Pins:
 *   - the set-load queries are covering-index range scans (no temp b-tree);
 *   - the keyset loader pages correctly and falls back (set: null) over its cap;
 *   - the sets are NOT loaded on 304 / same-version / bootstrap / zero-new
 *     runs, and loaded exactly once per run across several flushes;
 *   - over the cap the run stores every new domain (pre-filter behaviour);
 *   - END TO END on real SQLite: lookalike rows written by the REAL seeder
 *     (generateAndStoreLookalikes — lowercase ASCII and xn-- punycode forms)
 *     and a phantom row land in nrd_domains, near-misses (www., trailing
 *     dot) and non-matchable domains do not, the archive holds every new
 *     domain, brand-keyword threats still fire for unstored domains, and the
 *     REAL lookalike-nrd-matcher and phantom matcher then claim the stored rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { createAlertSpy } = vi.hoisted(() => ({ createAlertSpy: vi.fn() }));
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));

import {
  ingestNrdHagezi,
  loadMatchableDomains,
  NRD_MATCHABLE_SOURCES_SQL,
  NRD_SNAPSHOT_KEY,
  nrdArchiveKey,
} from "../src/feeds/nrd_hagezi";
import { threatId } from "../src/feeds/types";
import { runLookalikeNrdMatch } from "../src/lib/lookalike-nrd-matcher";
import { runPhantomMatch } from "../src/lib/phantom-matcher";
import { generateAndStoreLookalikes } from "../src/scanners/lookalike-domains";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import { fakeR2Bucket, gzipText, gunzipText, type FakeR2Bucket } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const VERSION = "2026.1005.0611.45";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A `Last modified` of TODAY, so registered_date (−1 day) is inside the
 *  lookalike matcher's 30-day claim window. */
const now = new Date();
const MODIFIED = `${String(now.getUTCDate()).padStart(2, "0")} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} 06:11 UTC`;

function listResponse(domains: string[], o: { version?: string } = {}): Response {
  const head = [`# Version: ${o.version ?? VERSION}`, `# Last modified: ${MODIFIED}`, `# Number of entries: ${domains.length}`, "#"];
  return new Response(`${[...head, ...[...domains].sort()].join("\n")}\n`, {
    status: 200,
    headers: { etag: '"etag-today"', "content-type": "text/plain; charset=utf-8" },
  });
}

async function priorSnapshot(domains: string[] = [], meta: Record<string, string> = { version: "v0" }) {
  const text = domains.length ? `${[...domains].sort().join("\n")}\n` : "";
  return { bytes: await gzipText(text), customMetadata: meta };
}

let raw: SqliteDb;
let db: D1Database;

function openDb(): SqliteDb {
  const tables = ["brands", "monitored_brands", "threats", "lookalike_domains", "phantom_domains", "nrd_domains"];
  const r = openDerivedDb(tables);
  for (const t of ["lookalike_domains", "phantom_domains", "nrd_domains"]) {
    for (const ddl of liveIndexDdl(t).values()) r.exec(ddl);
  }
  return r;
}

function envOf(d1: D1Database, staging: FakeR2Bucket, archive: FakeR2Bucket, cache = fakeKv()): Env {
  return { DB: d1, CACHE: cache, GEOIP_STAGING: staging.bucket, NRD_ARCHIVE: archive.bucket } as unknown as Env;
}
const ctxOf = (env: Env) => ({ env, feedName: "nrd_hagezi", feedUrl: "" });

let seq = 0;
function seedLookalike(domain: string, brandId = "b_seed"): void {
  raw.prepare(
    "INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type) VALUES (?, ?, ?, 'typosquat')",
  ).run(`la-${++seq}`, brandId, domain);
}
function seedPhantom(domain: string, brandId = "b_seed"): string {
  const id = `ph-${++seq}`;
  raw.prepare(
    "INSERT INTO phantom_domains (id, brand_id, domain, source_model) VALUES (?, ?, ?, 'test-model')",
  ).run(id, brandId, domain);
  return id;
}

const nrdDomains = (): string[] =>
  (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>).map((r) => r.domain);

/** Counts reads of each matchable source table through this D1. */
function countingLoads(inner: D1Database): { d1: D1Database; loads: { lookalike: number; phantom: number } } {
  const loads = { lookalike: 0, phantom: 0 };
  const d1 = {
    ...inner,
    prepare: (sql: string) => {
      if (sql === NRD_MATCHABLE_SOURCES_SQL.lookalike_domains) loads.lookalike++;
      if (sql === NRD_MATCHABLE_SOURCES_SQL.phantom_domains) loads.phantom++;
      return inner.prepare(sql);
    },
    batch: inner.batch,
  } as D1Database;
  return { d1, loads };
}

afterEach(() => {
  vi.unstubAllGlobals();
  createAlertSpy.mockReset();
});

describe.skipIf(!hasSqlite())("matchable-set load", () => {
  beforeEach(() => {
    raw = openDb();
    db = d1FromSqlite(raw);
  });

  it("both page queries are covering-index range scans with no temp b-tree", () => {
    const plan = (sql: string) =>
      (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("", 10) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    const lp = plan(NRD_MATCHABLE_SOURCES_SQL.lookalike_domains);
    expect(lp).toMatch(/SEARCH lookalike_domains USING COVERING INDEX idx_lookalike_domain \(domain>\?\)/);
    expect(lp).not.toMatch(/TEMP B-TREE/);
    const pp = plan(NRD_MATCHABLE_SOURCES_SQL.phantom_domains);
    expect(pp).toMatch(/SEARCH phantom_domains USING COVERING INDEX idx_phantom_domain \(domain>\?\)/);
    expect(pp).not.toMatch(/TEMP B-TREE/);
  });

  it("keyset-pages both tables into one distinct set of the RAW stored strings", async () => {
    for (const d of ["a.com", "b.com", "c.com", "d.com", "e.com"]) seedLookalike(d);
    seedLookalike("c.com", "b_other"); // same permutation, second brand
    seedLookalike("Mixed.COM"); // stored verbatim — never normalised
    seedPhantom("p1.ai");
    seedPhantom("p2.ai");
    seedPhantom("c.com");

    const m = await loadMatchableDomains(db, { pageRows: 2 });

    expect([...m.set!].sort()).toEqual(["Mixed.COM", "a.com", "b.com", "c.com", "d.com", "e.com", "p1.ai", "p2.ai"]);
    expect(m.loaded).toBe(8);
    // lookalike: 6 distinct → pages of 2,2,2,0 = 4; phantom: 3 → 2,1 = 2.
    expect(m.pages).toBe(6);
  });

  it("over the cap returns set: null (store-everything fallback)", async () => {
    for (const d of ["a.com", "b.com", "c.com"]) seedLookalike(d);
    const m = await loadMatchableDomains(db, { max: 2, pageRows: 1 });
    expect(m.set).toBeNull();
    expect(m.loaded).toBe(3);
  });
});

describe.skipIf(!hasSqlite())("nrd_hagezi — sets loaded lazily, once", () => {
  beforeEach(() => {
    raw = openDb();
    db = d1FromSqlite(raw);
    seedLookalike("new-1.com");
  });

  it("not loaded on 304, same-version, bootstrap, or a diff with zero new domains", async () => {
    const { d1, loads } = countingLoads(db);

    // 304
    let staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot(["a.com"], { etag: '"e"', version: "v0" }) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    await ingestNrdHagezi(ctxOf(envOf(d1, staging, fakeR2Bucket())));

    // same version
    staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot(["a.com"], { version: VERSION }) });
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(["a.com", "new-1.com"])));
    await ingestNrdHagezi(ctxOf(envOf(d1, staging, fakeR2Bucket())));

    // bootstrap (no snapshot)
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(["a.com", "new-1.com"])));
    await ingestNrdHagezi(ctxOf(envOf(d1, fakeR2Bucket(), fakeR2Bucket())));

    // new version, nothing new vs the snapshot
    staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot(["a.com", "new-1.com"]) });
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(["a.com", "new-1.com"])));
    await ingestNrdHagezi(ctxOf(envOf(d1, staging, fakeR2Bucket())));

    expect(loads).toEqual({ lookalike: 0, phantom: 0 });
    expect(nrdDomains()).toEqual([]);
  });

  it("loaded exactly once per run even across several flushes", async () => {
    const { d1, loads } = countingLoads(db);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot(["a.com"]) });
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(["a.com", "new-1.com", "new-2.com", "new-3.com"])));

    await ingestNrdHagezi(ctxOf(envOf(d1, staging, fakeR2Bucket())), { flushEvery: 1 });

    expect(loads).toEqual({ lookalike: 1, phantom: 1 });
    expect(nrdDomains()).toEqual(["new-1.com"]);
  });

  it("over the cap, every new domain is stored (pre-filter behaviour) and the run still succeeds", async () => {
    seedLookalike("other-1.com");
    seedLookalike("other-2.com");
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot(["a.com"]) });
    const archive = fakeR2Bucket();
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(["a.com", "new-1.com", "x.net", "y.org"])));

    const r = await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)), { matchableSetMax: 2 });

    expect(r.itemsError).toBe(0);
    expect(nrdDomains()).toEqual(["new-1.com", "x.net", "y.org"]);
    const key = [...archive.store.keys()][0]!;
    expect(archive.store.get(key)!.customMetadata).toMatchObject({ count: "3", stored_in_d1: "3" });
    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata.version).toBe(VERSION);
  });
});

describe.skipIf(!hasSqlite())("nrd_hagezi → nrd_domains → real matchers, end to end", () => {
  beforeEach(() => {
    raw = openDb();
    db = d1FromSqlite(raw);
    raw.prepare(
      "INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b_pp', 'PayPal', 'paypal.com', 'monitored')",
    ).run();
    raw.prepare(
      "INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES ('b_pp', '__internal__', 'u1', 'active')",
    ).run();
  });

  it("stores exactly the lookalike/phantom-equal NRDs, archives all, still brand-matches, and both matchers claim them", async () => {
    const cache = fakeKv();
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot([]) });
    const archive = fakeR2Bucket();
    const env = envOf(db, staging, archive, cache);

    // Lookalike rows in the exact form the scanner stores them: the REAL
    // seeder (lowercase ASCII; IDN permutations as xn-- ToASCII).
    expect(await generateAndStoreLookalikes(env, "b_pp", "paypal.com")).toBeGreaterThan(0);
    const stored = raw.prepare(
      "SELECT domain, permutation_type AS t FROM lookalike_domains WHERE brand_id = 'b_pp' ORDER BY domain",
    ).all() as Array<{ domain: string; t: string }>;
    const typo = stored.find((r) => r.t === "typosquat")!.domain;
    const idn = stored.find((r) => r.t === "idn_homoglyph")!.domain;
    expect(idn.startsWith("xn--")).toBe(true);
    const phantom = "paypal-assist-ai.com";
    const phantomId = seedPhantom(phantom, "b_pp");

    const keywordOnly = "paypal-refund-desk.example"; // brand keyword, not a lookalike/phantom
    const nearMisses = [`www.${typo}`, `${typo}.`]; // a join would not match these either
    const noise = "unrelated-noise.net";
    const today = [typo, idn, phantom, keywordOnly, noise, ...nearMisses];
    for (const d of [keywordOnly, noise, ...nearMisses]) {
      expect(stored.some((r) => r.domain === d)).toBe(false);
    }
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(today)));

    const r = await ingestNrdHagezi(ctxOf(env), { flushEvery: 2 });

    // nrd_domains: exactly the matchable subset.
    expect(nrdDomains()).toEqual([idn, phantom, typo].sort());
    // Archive: every new domain, stored or not.
    const sorted = [...today].sort();
    const key = nrdArchiveKey(
      (raw.prepare("SELECT registered_date AS d FROM nrd_domains LIMIT 1").all()[0] as { d: string }).d,
      VERSION,
      sorted[0]!,
    );
    expect([...archive.store.keys()]).toEqual([key]);
    expect(await gunzipText(archive.store.get(key)!.bytes)).toBe(`${sorted.join("\n")}\n`);
    expect(archive.store.get(key)!.customMetadata).toMatchObject({ count: String(today.length), stored_in_d1: "3" });
    // Brand-keyword threats still fire for domains that were NOT stored.
    expect(r.itemsError).toBe(0);
    expect(r.itemsNew).toBeGreaterThanOrEqual(1);
    const threatIds = (raw.prepare("SELECT id FROM threats").all() as Array<{ id: string }>).map((x) => x.id);
    expect(threatIds).toContain(threatId("nrd_hagezi", "domain", keywordOnly));

    // The REAL lookalike-nrd-matcher claims the stored lookalike NRDs.
    const m = await runLookalikeNrdMatch(env);
    expect(m.claim_errors).toBe(0);
    expect(m.claimed).toBeGreaterThanOrEqual(2);
    for (const d of [typo, idn]) {
      const row = raw.prepare(
        "SELECT registration_evidence AS ev, first_seen FROM lookalike_domains WHERE domain = ? AND brand_id = 'b_pp'",
      ).get(d) as { ev: string | null; first_seen: string | null };
      expect(row.ev, d).toBe("nrd");
      expect(row.first_seen, d).not.toBeNull();
      expect((raw.prepare("SELECT brand_matched AS b FROM nrd_domains WHERE domain = ?").get(d) as { b: number }).b).toBe(1);
    }

    // The REAL phantom matcher (nrd source) claims the stored phantom NRD.
    createAlertSpy.mockResolvedValue(null);
    const pm = await runPhantomMatch(env, db, { source: "nrd" });
    expect(pm.by_source.nrd.matched).toBe(1);
    expect(raw.prepare("SELECT status, matched_source FROM phantom_domains WHERE id = ?").get(phantomId)).toEqual({
      status: "registered",
      matched_source: "nrd",
    });
  });
});
