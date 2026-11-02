import { describe, it, expect, beforeEach } from "vitest";
import {
  hasSqlite, openDerivedDb, d1FromSqlite, fakeKv,
  type SqliteDb, type StatementLogEntry,
} from "./sqlite-d1-harness";
import {
  loadBrandEnrichment, BRAND_ENRICHMENT_TTL_S, brandEnrichmentCacheKey,
  type BrandEnrichment,
} from "../src/lib/analyst-brand-enrichment";
import type { Env } from "../src/types";

/**
 * Behaviour of the real per-brand enrichment aggregates analyst Phase 3.5
 * consumes (src/lib/analyst-brand-enrichment.ts). Seeded-SQLite parity with
 * the old catalog-wide queries, bind/plan/TTL contracts and the "analyst.ts
 * no longer scans the catalog" check live in
 * d1-read-spend-analyst-email.test.ts; this file pins the per-signal gates
 * and boundaries, the empty/absent results, and the cache semantics.
 *
 * The merge in analyst.ts is inline (not exported): it only consumes the Map
 * returned here (absent brand => no insight), so the Map contract is tested.
 */

type Env2 = Env & { CACHE: ReturnType<typeof fakeKv> };

function makeEnv(raw: SqliteDb, log: StatementLogEntry[] = []): Env2 {
  return { DB: d1FromSqlite(raw, { log }), CACHE: fakeKv() } as unknown as Env2;
}

interface T {
  brand?: string | null; status?: string;
  surbl?: number; vt?: number | null; gsb?: number; dbl?: number;
  gnChecked?: number; gnNoise?: number | null; gnClass?: string | null;
  slChecked?: number; slScore?: number | null;
}

let seq = 0;
function insert(raw: SqliteDb, brand: string, t: T = {}): void {
  seq++;
  raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, target_brand_id, status, severity,
       surbl_listed, vt_malicious, gsb_flagged, dbl_listed, greynoise_checked, greynoise_noise,
       greynoise_classification, seclookup_checked, seclookup_risk_score, created_at, first_seen, last_seen)
     VALUES (?, 'openphish', 'phishing', ?, ?, ?, 'high', ?, ?, ?, ?, ?, ?, ?, ?, ?,
       '2026-10-30 00:00:00', '2026-10-30 00:00:00', '2026-10-30 00:00:00')`,
  ).run(
    `e${seq}`, `evil${seq}.example`, brand, t.status ?? "active",
    t.surbl ?? 0, t.vt === undefined ? 0 : t.vt, t.gsb ?? 0, t.dbl ?? 0,
    t.gnChecked ?? 0, t.gnNoise ?? null, t.gnClass ?? null, t.slChecked ?? 0, t.slScore ?? null,
  );
}

const ZERO: Omit<BrandEnrichment, "target_brand_id"> = {
  surbl_confirmed: 0, vt_flagged: 0, vt_avg_malicious: null, gsb_confirmed: 0,
  dbl_confirmed: 0, noise_scanners: 0, potentially_targeted: 0, seclookup_high_risk: 0,
};

describe.skipIf(!hasSqlite())("analyst brand enrichment — signal gates", () => {
  let raw: SqliteDb;
  let env: Env2;

  beforeEach(() => {
    seq = 0;
    raw = openDerivedDb(["threats"]);
    env = makeEnv(raw);
  });

  it("a brand whose active threats carry no signal still yields an all-zero row (null VT average)", async () => {
    insert(raw, "b1");
    insert(raw, "b1");
    const got = (await loadBrandEnrichment(env, ["b1"])).get("b1");
    expect(got).toEqual({ target_brand_id: "b1", ...ZERO });
  });

  it("SecLookup high-risk boundary: 79 no, 80 yes; unchecked or NULL score never counts", async () => {
    insert(raw, "b1", { slChecked: 1, slScore: 79 });
    insert(raw, "b1", { slChecked: 1, slScore: 80 });
    insert(raw, "b1", { slChecked: 1, slScore: 100 });
    insert(raw, "b1", { slChecked: 0, slScore: 99 });   // not consulted
    insert(raw, "b1", { slChecked: 1, slScore: null }); // consulted, no score
    expect((await loadBrandEnrichment(env, ["b1"])).get("b1")!.seclookup_high_risk).toBe(2);
  });

  it("VirusTotal: flagged means > 0 engines; the average ignores zero and NULL rows and rounds to 1 dp", async () => {
    insert(raw, "b1", { vt: 0 });
    insert(raw, "b1", { vt: null });
    insert(raw, "b1", { vt: 1 });
    insert(raw, "b1", { vt: 2 });
    insert(raw, "b1", { vt: 2 }); // (1+2+2)/3 = 1.666… -> 1.7
    const got = (await loadBrandEnrichment(env, ["b1"])).get("b1")!;
    expect(got.vt_flagged).toBe(3);
    expect(got.vt_avg_malicious).toBe(1.7);
  });

  it("GreyNoise: noise_scanners needs checked + noise + benign; potentially_targeted needs checked + noise = 0", async () => {
    insert(raw, "b1", { gnChecked: 1, gnNoise: 1, gnClass: "benign" });     // noise scanner
    insert(raw, "b1", { gnChecked: 1, gnNoise: 1, gnClass: "malicious" });  // noisy but not benign: neither
    insert(raw, "b1", { gnChecked: 1, gnNoise: 1, gnClass: null });         // neither
    insert(raw, "b1", { gnChecked: 1, gnNoise: 0 });                        // potentially targeted
    insert(raw, "b1", { gnChecked: 1, gnNoise: null });                     // unknown noise: neither
    insert(raw, "b1", { gnChecked: 0, gnNoise: 0 });                        // not consulted: neither
    insert(raw, "b1", { gnChecked: 0, gnNoise: 1, gnClass: "benign" });     // not consulted: neither
    const got = (await loadBrandEnrichment(env, ["b1"])).get("b1")!;
    expect(got.noise_scanners).toBe(1);
    expect(got.potentially_targeted).toBe(1);
  });

  it("SURBL, GSB and DBL count only rows flagged exactly 1", async () => {
    insert(raw, "b1", { surbl: 1, gsb: 1, dbl: 1 });
    insert(raw, "b1", { surbl: 1 });
    insert(raw, "b1", { surbl: 0, gsb: 0, dbl: 0 });
    const got = (await loadBrandEnrichment(env, ["b1"])).get("b1")!;
    expect(got).toMatchObject({ surbl_confirmed: 2, gsb_confirmed: 1, dbl_confirmed: 1 });
  });

  it("only active threats of the requested brand are counted", async () => {
    insert(raw, "b1", { surbl: 1 });
    insert(raw, "b1", { surbl: 1, status: "down" });
    insert(raw, "b1", { surbl: 1, status: "remediated" });
    insert(raw, "b2", { surbl: 1 });
    const got = await loadBrandEnrichment(env, ["b1"]);
    expect(got.get("b1")!.surbl_confirmed).toBe(1);
    expect(got.has("b2")).toBe(false);
  });

  it("brands with only inactive threats, or no threats at all, are absent from the map", async () => {
    insert(raw, "dead", { status: "down", vt: 9 });
    const got = await loadBrandEnrichment(env, ["dead", "never-seen"]);
    expect(got.size).toBe(0);
  });

  it("returns one entry per distinct brand, keyed by brand id, for duplicate input ids", async () => {
    insert(raw, "b1", { gsb: 1 });
    insert(raw, "b2", { dbl: 1 });
    const got = await loadBrandEnrichment(env, ["b1", "b2", "b1"]);
    expect([...got.keys()].sort()).toEqual(["b1", "b2"]);
    expect(got.get("b1")!.target_brand_id).toBe("b1");
    expect(got.get("b2")!.dbl_confirmed).toBe(1);
  });
});

describe.skipIf(!hasSqlite())("analyst brand enrichment — cache behaviour", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let env: Env2;

  beforeEach(() => {
    seq = 0;
    raw = openDerivedDb(["threats"]);
    log = [];
    env = makeEnv(raw, log);
  });

  const stamp = (env: Env2, brand: string, value: unknown, ageMs: number) =>
    env.CACHE.put(`cv:${brandEnrichmentCacheKey(brand)}`, JSON.stringify({ v: value, t: Date.now() - ageMs }));

  it("a fresh cached row is served as-is with no D1 read, even if the table has since changed", async () => {
    insert(raw, "b1", { surbl: 1 });
    await loadBrandEnrichment(env, ["b1"]);
    insert(raw, "b1", { surbl: 1 });
    insert(raw, "b1", { surbl: 1 });
    log.length = 0;

    const got = await loadBrandEnrichment(env, ["b1"]);
    expect(got.get("b1")!.surbl_confirmed).toBe(1);
    expect(log).toHaveLength(0);
  });

  it("an entry older than the TTL is recomputed", async () => {
    insert(raw, "b1", { surbl: 1 });
    await stamp(env, "b1", { target_brand_id: "b1", ...ZERO, surbl_confirmed: 99 }, (BRAND_ENRICHMENT_TTL_S + 1) * 1000);
    const got = await loadBrandEnrichment(env, ["b1"]);
    expect(got.get("b1")!.surbl_confirmed).toBe(1);
    expect(log).toHaveLength(1);
  });

  it("an entry just inside the TTL is still a hit", async () => {
    await stamp(env, "b1", { target_brand_id: "b1", ...ZERO, gsb_confirmed: 4 }, (BRAND_ENRICHMENT_TTL_S - 60) * 1000);
    const got = await loadBrandEnrichment(env, ["b1"]);
    expect(got.get("b1")!.gsb_confirmed).toBe(4);
    expect(log).toHaveLength(0);
  });

  it("a brand with no active threats caches its empty result (no repeat D1 read) and stays absent", async () => {
    expect((await loadBrandEnrichment(env, ["ghost"])).size).toBe(0);
    expect((await loadBrandEnrichment(env, ["ghost"])).size).toBe(0);
    expect(log).toHaveLength(1);
  });

  it("each brand is cached under its own key", async () => {
    insert(raw, "b1", { surbl: 1 });
    insert(raw, "b2", { dbl: 1 });
    await loadBrandEnrichment(env, ["b1", "b2"]);
    expect(brandEnrichmentCacheKey("b1")).not.toBe(brandEnrichmentCacheKey("b2"));
    expect(env.CACHE.store.has(`cv:${brandEnrichmentCacheKey("b1")}`)).toBe(true);
    expect(env.CACHE.store.has(`cv:${brandEnrichmentCacheKey("b2")}`)).toBe(true);
  });

  it("a KV outage falls through to D1 instead of failing the run", async () => {
    insert(raw, "b1", { gsb: 1 });
    const broken = {
      DB: d1FromSqlite(raw, { log }),
      CACHE: { get: async () => { throw new Error("kv down"); }, put: async () => { throw new Error("kv down"); } },
    } as unknown as Env;
    const got = await loadBrandEnrichment(broken, ["b1"]);
    expect(got.get("b1")!.gsb_confirmed).toBe(1);
  });
});
