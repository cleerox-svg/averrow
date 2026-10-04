// Pin: CertStreamMonitor caches its brand keyword/domain sets in KV
// (D1 read-spend PR, fix 10).
//
// loadBrandKeywords ran three brand-catalog scans (~114K rows, OR across a
// monitored_brands join) on every DO wakeup / ensureConnected. It now reads
// `cv:certstream.brand_sets` (1h) first. Pins: a warm cache means zero D1
// statements on a fresh DO instance; a KV failure falls back to D1; a D1
// failure is never cached and leaves the previous sets in place; the
// predicates are unchanged; the operator /reload-brands bypasses the cache.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";
import {
  CertStreamMonitor,
  CERTSTREAM_BRAND_SETS_CACHE_KEY,
  CERTSTREAM_BRAND_SETS_TTL_S,
  loadCertStreamBrandSets,
} from "../src/durableObjects/CertStreamMonitor";
import type { Env } from "../src/types";

function seed(): SqliteDb {
  const raw = openDerivedDb(["brands", "monitored_brands"]);
  const b = raw.prepare(
    `INSERT INTO brands (id, name, canonical_domain, monitoring_status, brand_keywords, aliases)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  b.run("b1", "Acme Bank", "AcmeBank.com", "active", JSON.stringify(["acmepay", "abc"]), JSON.stringify(["Acme Financial"]));
  b.run("b2", "Globex", "globex.com", "inactive", JSON.stringify(["globexkw"]), null); // via monitored_brands only
  b.run("b3", "Initech", "initech.com", "inactive", null, null); // not monitored at all
  b.run("b4", "Umbrella", "umbrella.com", "active", "not json", JSON.stringify(["Umbrella Corp", 7]));
  raw.prepare(
    `INSERT INTO monitored_brands (brand_id, added_by, status) VALUES ('b2', 'u1', 'active')`,
  ).run();
  return raw;
}

const fakeCtx = { storage: { getAlarm: async () => null, setAlarm: async () => {} } } as unknown as DurableObjectState;

function makeEnv(raw: SqliteDb, log: StatementLogEntry[], kv = fakeKv()) {
  return { env: { DB: d1FromSqlite(raw, { log }), CACHE: kv } as unknown as Env, kv };
}

async function load(mon: CertStreamMonitor): Promise<void> {
  await (mon as unknown as { loadBrandKeywords(o?: { bypassCache?: boolean }): Promise<void> }).loadBrandKeywords();
}

async function counts(mon: CertStreamMonitor): Promise<{ brandKeywords: number; brandDomains: number }> {
  const res = await mon.fetch(new Request("https://do/stats"));
  return (await res.json()) as { brandKeywords: number; brandDomains: number };
}

const EXPECTED = {
  keywords: ["acme bank", "globex", "umbrella", "acmepay", "acme financial", "umbrella corp"],
  domains: ["acmebank.com", "globex.com", "umbrella.com"],
};

describe.skipIf(!hasSqlite())("CertStream brand sets KV cache", () => {
  it("TTL is 1h", () => {
    expect(CERTSTREAM_BRAND_SETS_TTL_S).toBe(3600);
  });

  it("loader output is unchanged (same predicates, filters, dedupe)", async () => {
    const sets = await loadCertStreamBrandSets(d1FromSqlite(seed()));
    expect(sets.keywords).toEqual(EXPECTED.keywords);
    expect(sets.domains).toEqual(EXPECTED.domains);
    const src = readFileSync(resolve(__dirname, "..", "src", "durableObjects", "CertStreamMonitor.ts"), "utf8");
    expect(src).toContain("WHERE b.monitoring_status = 'active' OR mb.status = 'active'");
    expect(src).toContain("WHERE brand_keywords IS NOT NULL AND monitoring_status = 'active'");
    expect(src).toContain("WHERE aliases IS NOT NULL AND monitoring_status = 'active'");
  });

  it("a fresh DO instance with a warm KV entry issues zero D1 statements", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env, kv } = makeEnv(raw, log);

    const first = new CertStreamMonitor(fakeCtx, env);
    await load(first);
    expect(log.length).toBe(3);
    expect(kv.store.has(`cv:${CERTSTREAM_BRAND_SETS_CACHE_KEY}`)).toBe(true);

    const second = new CertStreamMonitor(fakeCtx, env); // DO wakeup
    await load(second);
    expect(log.length).toBe(3);
    expect(await counts(second)).toMatchObject({
      brandKeywords: EXPECTED.keywords.length,
      brandDomains: EXPECTED.domains.length,
    });
  });

  it("a KV read failure falls back to D1", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const kv = fakeKv();
    kv.get = (async () => { throw new Error("KV down"); }) as typeof kv.get;
    kv.put = (async () => { throw new Error("KV down"); }) as typeof kv.put;
    const { env } = makeEnv(raw, log, kv);
    const mon = new CertStreamMonitor(fakeCtx, env);
    await load(mon);
    expect(log.length).toBe(3);
    expect(await counts(mon)).toMatchObject({
      brandKeywords: EXPECTED.keywords.length,
      brandDomains: EXPECTED.domains.length,
    });
  });

  it("a D1 failure is not cached and keeps the previously loaded sets", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env, kv } = makeEnv(raw, log);
    const mon = new CertStreamMonitor(fakeCtx, env);
    await load(mon);
    kv.store.clear();
    raw.exec("DROP TABLE monitored_brands"); // next compute throws
    await load(mon);
    expect(kv.store.has(`cv:${CERTSTREAM_BRAND_SETS_CACHE_KEY}`)).toBe(false);
    expect(await counts(mon)).toMatchObject({
      brandKeywords: EXPECTED.keywords.length,
      brandDomains: EXPECTED.domains.length,
    });
  });

  it("/reload-brands reads D1 even when the cache is warm, and re-seeds KV", async () => {
    const raw = seed();
    const log: StatementLogEntry[] = [];
    const { env, kv } = makeEnv(raw, log);
    const mon = new CertStreamMonitor(fakeCtx, env);
    await load(mon);
    raw.prepare(
      `INSERT INTO brands (id, name, canonical_domain, monitoring_status) VALUES ('b5', 'Hooli', 'hooli.com', 'active')`,
    ).run();
    const res = await mon.fetch(new Request("https://do/reload-brands"));
    expect(log.length).toBe(6);
    expect(await res.json()).toEqual({
      brandsLoaded: EXPECTED.keywords.length + 1,
      domainsLoaded: EXPECTED.domains.length + 1,
    });

    // The reload re-seeded KV: a restarted DO gets the fresh sets with no D1.
    const entry = JSON.parse(kv.store.get(`cv:${CERTSTREAM_BRAND_SETS_CACHE_KEY}`)!) as {
      v: { keywords: string[]; domains: string[] };
    };
    expect(entry.v.keywords).toContain("hooli");
    expect(entry.v.domains).toContain("hooli.com");
    const restarted = new CertStreamMonitor(fakeCtx, env);
    await load(restarted);
    expect(log.length).toBe(6);
    expect(await counts(restarted)).toMatchObject({
      brandKeywords: EXPECTED.keywords.length + 1,
      brandDomains: EXPECTED.domains.length + 1,
    });
  });
});
