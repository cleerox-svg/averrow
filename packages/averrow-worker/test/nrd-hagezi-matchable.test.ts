/**
 * nrd_hagezi matchable filter (D1 write cut, owner decision 2026-10-05).
 *
 * nrd_domains stores only the NEW NRDs equal to a lookalike_domains.domain
 * or a phantom_domains.domain — the filter is IN the insert (NRD_INSERT_SQL:
 * `… FROM json_each(?) j WHERE EXISTS (… l.domain = j.value) OR EXISTS (…
 * p.domain = j.value)`), the matchers' own join predicate. Everything new is
 * still archived to R2 and still brand-matched into threats.
 *
 * Pins:
 *   - both EXISTS probes are covering-index SEARCHes (no scan), 2 binds/stmt;
 *   - storeNrdReference returns the rows actually inserted (meta.changes),
 *     which feeds the archive's stored_in_d1;
 *   - a failing filtered insert fails the pull with the archive AND the
 *     snapshot untouched;
 *   - END TO END on real SQLite: lookalike rows written by the REAL seeder
 *     (lowercase ASCII and xn-- forms) and a phantom land, near-misses
 *     (www., trailing dot) and non-matchable domains do not, the archive
 *     holds every new domain, brand-keyword threats still fire for unstored
 *     domains, and the REAL lookalike-nrd and phantom matchers claim the rows;
 *   - EQUIVALENCE: the lookalike matcher's claims after the filtered ingest
 *     equal its claims after storing every NRD (the old behaviour).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { createAlertSpy } = vi.hoisted(() => ({ createAlertSpy: vi.fn() }));
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));

import {
  ingestNrdHagezi,
  storeNrdReference,
  NRD_INSERT_SQL,
  NRD_SNAPSHOT_KEY,
  nrdArchiveKey,
  registeredDateFromHeader,
} from "../src/feeds/nrd_hagezi";
import { threatId } from "../src/feeds/types";
import { generatePermutations } from "../src/lib/dnstwist";
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
const REG_DATE = registeredDateFromHeader(MODIFIED);

function listResponse(domains: string[]): Response {
  const head = [`# Version: ${VERSION}`, `# Last modified: ${MODIFIED}`, `# Number of entries: ${domains.length}`, "#"];
  return new Response(`${[...head, ...[...domains].sort()].join("\n")}\n`, {
    status: 200,
    headers: { etag: '"etag-today"', "content-type": "text/plain; charset=utf-8" },
  });
}

async function priorSnapshot(domains: string[] = []) {
  const text = domains.length ? `${[...domains].sort().join("\n")}\n` : "";
  return { bytes: await gzipText(text), customMetadata: { version: "v0" } };
}

function openDb(): SqliteDb {
  const r = openDerivedDb(["brands", "monitored_brands", "threats", "lookalike_domains", "phantom_domains", "nrd_domains"]);
  for (const t of ["lookalike_domains", "phantom_domains", "nrd_domains"]) {
    for (const ddl of liveIndexDdl(t).values()) r.exec(ddl);
  }
  return r;
}

function envOf(d1: D1Database, staging: FakeR2Bucket, archive: FakeR2Bucket, cache = fakeKv()): Env {
  return { DB: d1, CACHE: cache, GEOIP_STAGING: staging.bucket, NRD_ARCHIVE: archive.bucket } as unknown as Env;
}
const ctxOf = (env: Env) => ({ env, feedName: "nrd_hagezi", feedUrl: "" });

let raw: SqliteDb;
let db: D1Database;
let seq = 0;

function seedLookalike(r: SqliteDb, domain: string, brandId = "b_seed", id = `la-${++seq}`): void {
  r.prepare(
    "INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type) VALUES (?, ?, ?, 'typosquat')",
  ).run(id, brandId, domain);
}
function seedPhantom(r: SqliteDb, domain: string, brandId = "b_seed"): string {
  const id = `ph-${++seq}`;
  r.prepare(
    "INSERT INTO phantom_domains (id, brand_id, domain, source_model) VALUES (?, ?, ?, 'test-model')",
  ).run(id, brandId, domain);
  return id;
}
const nrdDomains = (r: SqliteDb): string[] =>
  (r.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>).map((x) => x.domain);

afterEach(() => {
  vi.unstubAllGlobals();
  createAlertSpy.mockReset();
});

describe.skipIf(!hasSqlite())("NRD_INSERT_SQL — the filtered insert", () => {
  beforeEach(() => {
    raw = openDb();
    db = d1FromSqlite(raw);
  });

  it("both EXISTS probes are covering-index SEARCHes on idx_lookalike_domain / idx_phantom_domain — no table scan", () => {
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${NRD_INSERT_SQL}`).all("2026-10-04", "[]") as Array<{ detail: string }>)
      .map((r) => r.detail);
    const joined = plan.join(" | ");
    expect(joined).toMatch(/SEARCH l USING COVERING INDEX idx_lookalike_domain \(domain=\?\)/);
    expect(joined).toMatch(/SEARCH p USING COVERING INDEX idx_phantom_domain \(domain=\?\)/);
    expect(joined).not.toMatch(/SCAN (l|p|lookalike_domains|phantom_domains)\b/);
    // Exactly two bind parameters regardless of row count.
    expect((NRD_INSERT_SQL.match(/\?/g) ?? []).length).toBe(2);
  });

  it("stores only lookalike/phantom-equal domains and returns the rows actually inserted", async () => {
    seedLookalike(raw, "a.com");
    seedLookalike(raw, "a.com", "b_other"); // same permutation, second brand → still one NRD row
    seedLookalike(raw, "Mixed.COM"); // never equal to a lowercased NRD — not stored
    seedPhantom(raw, "p.ai");

    const n1 = await storeNrdReference(db, ["a.com", "b.com", "mixed.com", "p.ai", "a.com"], "2026-10-03");
    expect(n1).toBe(2);
    expect(nrdDomains(raw)).toEqual(["a.com", "p.ai"]);

    // Re-run: INSERT OR IGNORE → 0 inserted, first registered_date kept.
    expect(await storeNrdReference(db, ["a.com", "p.ai"], "2026-10-04")).toBe(0);
    expect(raw.prepare("SELECT registered_date AS d FROM nrd_domains WHERE domain = 'a.com'").get()).toEqual({ d: "2026-10-03" });
    expect(await storeNrdReference(db, [], "2026-10-04")).toBe(0);
  });

  it("a failing filtered insert fails the pull; the archive is not written and the snapshot is untouched", async () => {
    seedLookalike(raw, "b.com");
    const prior = await priorSnapshot(["a.com"]);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: prior });
    const archive = fakeR2Bucket();
    const failing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async () => { throw new Error("D1_ERROR: simulated nrd insert failure"); },
    } as unknown as D1Database;
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(["a.com", "b.com", "c.com"])));

    await expect(ingestNrdHagezi(ctxOf(envOf(failing, staging, archive)))).rejects.toThrow(/simulated nrd insert failure/);

    expect(archive.ops.put).toBe(0);
    expect(archive.store.size).toBe(0);
    expect(staging.ops.put).toBe(0);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);
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
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot([]) });
    const archive = fakeR2Bucket();
    const env = envOf(db, staging, archive);

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
    const phantomId = seedPhantom(raw, phantom, "b_pp");

    const keywordOnly = "paypal-refund-desk.example"; // brand keyword, not a lookalike/phantom
    const nearMisses = [`www.${typo}`, `${typo}.`]; // the matchers' join would not match these either
    const today = [typo, idn, phantom, keywordOnly, "unrelated-noise.net", ...nearMisses];
    for (const d of [keywordOnly, ...nearMisses]) expect(stored.some((r) => r.domain === d)).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(today)));

    const r = await ingestNrdHagezi(ctxOf(env), { flushEvery: 2 });

    expect(nrdDomains(raw)).toEqual([idn, phantom, typo].sort());
    const sorted = [...today].sort();
    const key = nrdArchiveKey(REG_DATE, VERSION, sorted[0]!);
    expect([...archive.store.keys()]).toEqual([key]);
    expect(await gunzipText(archive.store.get(key)!.bytes)).toBe(`${sorted.join("\n")}\n`);
    expect(archive.store.get(key)!.customMetadata).toMatchObject({ count: String(today.length), stored_in_d1: "3" });
    expect(r.itemsError).toBe(0);
    const threatIds = (raw.prepare("SELECT id FROM threats").all() as Array<{ id: string }>).map((x) => x.id);
    expect(threatIds).toContain(threatId("nrd_hagezi", "domain", keywordOnly));

    const m = await runLookalikeNrdMatch(env);
    expect(m.claim_errors).toBe(0);
    expect(m.claimed).toBeGreaterThanOrEqual(2);
    for (const d of [typo, idn]) {
      const row = raw.prepare(
        "SELECT registration_evidence AS ev, first_seen FROM lookalike_domains WHERE domain = ? AND brand_id = 'b_pp'",
      ).get(d) as { ev: string | null; first_seen: string | null };
      expect(row.ev, d).toBe("nrd");
      expect(row.first_seen, d).toBe(`${REG_DATE} 00:00:00`);
      expect((raw.prepare("SELECT brand_matched AS b FROM nrd_domains WHERE domain = ?").get(d) as { b: number }).b).toBe(1);
    }

    createAlertSpy.mockResolvedValue(null);
    const pm = await runPhantomMatch(env, db, { source: "nrd" });
    expect(pm.by_source.nrd.matched).toBe(1);
    expect(raw.prepare("SELECT status, matched_source FROM phantom_domains WHERE id = ?").get(phantomId)).toEqual({
      status: "registered",
      matched_source: "nrd",
    });
  });
});

describe.skipIf(!hasSqlite())("equivalence with storing every NRD", () => {
  it("the lookalike matcher claims exactly what it would have claimed had every NRD been stored", async () => {
    // Realistic lookalike rows (two brands, overlapping permutations, an IDN
    // row, a never-matchable mixed-case row) with FIXED ids so the two
    // databases are comparable.
    const lookalikes: Array<[string, string, string]> = [];
    let k = 0;
    for (const [brand, domain] of [["b1", "paypal.com"], ["b2", "paypai.com"]] as const) {
      for (const p of generatePermutations(domain)) lookalikes.push([`fix-${k++}`, brand, p.domain]);
    }
    lookalikes.push([`fix-${k++}`, "b1", "Mixed.COM"]);
    const allLookalikeDomains = [...new Set(lookalikes.map((l) => l[2]))];
    // The day's list: every other lookalike domain, near-misses, noise.
    const listed = [
      ...allLookalikeDomains.filter((_, i) => i % 2 === 0).map((d) => d.toLowerCase()),
      "www.paypa1.com", "paypa1.com.", "unrelated-1.net", "unrelated-2.org", "mixed.com",
    ];

    const build = (): SqliteDb => {
      const r = openDb();
      for (const [id, brand, domain] of lookalikes) seedLookalike(r, domain, brand, id);
      return r;
    };
    const claims = (r: SqliteDb) =>
      r.prepare(
        "SELECT id, first_seen, registration_evidence AS ev FROM lookalike_domains WHERE registration_evidence = 'nrd' ORDER BY id",
      ).all();

    // A: the filtered feed.
    const rawA = build();
    const envA = envOf(d1FromSqlite(rawA), fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await priorSnapshot([]) }), fakeR2Bucket());
    vi.stubGlobal("fetch", vi.fn(async () => listResponse(listed)));
    await ingestNrdHagezi(ctxOf(envA), { flushEvery: 7 });
    await runLookalikeNrdMatch(envA);

    // B: the old behaviour — every new NRD stored, same registered_date.
    const rawB = build();
    const ins = rawB.prepare("INSERT OR IGNORE INTO nrd_domains (domain, registered_date) VALUES (?, ?)");
    for (const d of [...listed].sort()) ins.run(d, REG_DATE);
    const envB = envOf(d1FromSqlite(rawB), fakeR2Bucket(), fakeR2Bucket());
    await runLookalikeNrdMatch(envB);

    const a = claims(rawA);
    expect(a.length).toBeGreaterThan(10);
    expect(a).toEqual(claims(rawB));
    // And A stored only the matchable subset.
    expect(nrdDomains(rawA).length).toBeLessThan(nrdDomains(rawB).length);
    expect(nrdDomains(rawA)).not.toContain("mixed.com");
  });
});
