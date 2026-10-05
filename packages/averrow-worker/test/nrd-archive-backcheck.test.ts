/**
 * lib/nrd-archive-backcheck.ts — recover the NRD match of a domain that
 * became matchable AFTER its NRD listing was ingested (the feed stores only
 * lookalike/phantom-equal NRDs, so a permutation seeded later has no
 * nrd_domains row; every new NRD is in the NRD_ARCHIVE R2 archive).
 *
 * Pins (fake R2 + real SQLite with the migration-derived schema + indexes):
 *   - END TO END: ingest a list while the domain is NOT yet a lookalike (no
 *     nrd_domains row, archived), seed the brand with the REAL cron seeder,
 *     back-check its `new_domains` → the row is stored with the ARCHIVE's
 *     date, and the REAL lookalike-nrd matcher — whose cursor had already
 *     passed the day's other rows — claims it with that date;
 *   - phantom source: a back-checked phantom NRD is found by the real phantom
 *     matcher's incremental nrd run;
 *   - oldest listing wins and the scan stops once every domain is found;
 *     objects outside the NRD_BACKCHECK_DAYS window are not read;
 *   - bounds: no domains → no R2 traffic; NRD_ARCHIVE unbound → skipped;
 *     soft cap → timed_out; a failing GET / list / malformed object is
 *     counted or caught — the call NEVER throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { createAlertSpy } = vi.hoisted(() => ({ createAlertSpy: vi.fn() }));
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));

import { ingestNrdHagezi, nrdArchiveKey, registeredDateFromHeader, NRD_SNAPSHOT_KEY } from "../src/feeds/nrd_hagezi";
import { runNrdArchiveBackcheck, NRD_BACKCHECK_DAYS } from "../src/lib/nrd-archive-backcheck";
import { runLookalikeNrdMatch, LOOKALIKE_NRD_CURSOR_KEY, parseNrdCursor } from "../src/lib/lookalike-nrd-matcher";
import { runPhantomMatch } from "../src/lib/phantom-matcher";
import { generatePermutations } from "../src/lib/dnstwist";
import { seedLookalikesForOrgBrands } from "../src/scanners/lookalike-domains";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import { fakeR2Bucket, gzipText, type FakeR2Bucket } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const VERSION = "2026.1005.0611.45";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NOW = Date.now();
const today = new Date(NOW);
const MODIFIED = `${String(today.getUTCDate()).padStart(2, "0")} ${MONTHS[today.getUTCMonth()]} ${today.getUTCFullYear()} 06:11 UTC`;
const REG_DATE = registeredDateFromHeader(MODIFIED);

/** UTC date `offset` days before now. */
const daysAgo = (offset: number): string => {
  const d = new Date(NOW);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};

function listResponse(domains: string[]): Response {
  const head = [`# Version: ${VERSION}`, `# Last modified: ${MODIFIED}`, `# Number of entries: ${domains.length}`, "#"];
  return new Response(`${[...head, ...[...domains].sort()].join("\n")}\n`, {
    status: 200,
    headers: { etag: '"etag-today"', "content-type": "text/plain; charset=utf-8" },
  });
}

let raw: SqliteDb;
let db: D1Database;

function openDb(): SqliteDb {
  const r = openDerivedDb(["brands", "monitored_brands", "threats", "lookalike_domains", "phantom_domains", "nrd_domains"]);
  for (const t of ["lookalike_domains", "phantom_domains", "nrd_domains"]) {
    for (const ddl of liveIndexDdl(t).values()) r.exec(ddl);
  }
  return r;
}

function envOf(archive: FakeR2Bucket | null, staging: FakeR2Bucket = fakeR2Bucket()): Env {
  const env: Record<string, unknown> = { DB: db, CACHE: fakeKv(), GEOIP_STAGING: staging.bucket };
  if (archive) env.NRD_ARCHIVE = archive.bucket;
  return env as unknown as Env;
}

async function putArchive(archive: FakeR2Bucket, date: string, first: string, domains: string[]): Promise<string> {
  const key = nrdArchiveKey(date, VERSION, first);
  archive.store.set(key, {
    bytes: await gzipText(`${[...domains].sort().join("\n")}\n`),
    customMetadata: { count: String(domains.length), registered_date: date },
  });
  return key;
}

let seq = 0;
function seedLookalike(domain: string, brandId = "b_seed"): void {
  raw.prepare(
    "INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type) VALUES (?, ?, ?, 'typosquat')",
  ).run(`la-${++seq}`, brandId, domain);
}

const nrdRow = (domain: string) =>
  raw.prepare("SELECT domain, registered_date FROM nrd_domains WHERE domain = ?").get(domain) as
    | { domain: string; registered_date: string }
    | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  createAlertSpy.mockReset();
});

describe.skipIf(!hasSqlite())("NRD archive back-check — end to end", () => {
  beforeEach(() => {
    raw = openDb();
    db = d1FromSqlite(raw);
  });

  it("a permutation seeded AFTER its NRD was ingested is recovered from the archive and claimed with the archive date", async () => {
    const permutation = generatePermutations("paypal.com").find((p) => p.type === "typosquat")!.domain;
    // An unrelated lookalike that IS matchable at ingest, so the matcher's
    // cursor moves past the day's rows before the brand is seeded.
    seedLookalike("other-squat.net", "b_other");
    const archive = fakeR2Bucket();
    const staging = fakeR2Bucket({
      [NRD_SNAPSHOT_KEY]: { bytes: await gzipText(""), customMetadata: { version: "v0" } },
    });
    const env = envOf(archive, staging);
    vi.stubGlobal("fetch", vi.fn(async () => listResponse([permutation, "other-squat.net", "noise.org"])));

    // 1. Ingest: the permutation is not a lookalike yet → archived, not stored.
    await ingestNrdHagezi({ env, feedName: "nrd_hagezi", feedUrl: "" });
    expect(nrdRow(permutation)).toBeUndefined();
    expect(nrdRow("other-squat.net")).toBeDefined();
    const first = await runLookalikeNrdMatch(env);
    expect(first.claimed).toBe(1);
    const cursorBefore = parseNrdCursor(await env.CACHE.get(LOOKALIKE_NRD_CURSOR_KEY));
    expect(cursorBefore).not.toBeNull();

    // 2. The cron seeder seeds PayPal later; its new_domains feed the back-check.
    raw.prepare(
      "INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b_pp', 'PayPal', 'paypal.com', 'monitored')",
    ).run();
    const seed = await seedLookalikesForOrgBrands(env);
    expect(seed.new_domains).toContain(permutation);
    expect(seed.new_domains.length).toBe(seed.candidates_created);

    const bc = await runNrdArchiveBackcheck(env, seed.new_domains, "lookalike");

    expect(bc).toMatchObject({ hits: 1, stored: 1, timed_out: false, object_errors: 0, skipped: null, error: null });
    expect(nrdRow(permutation)).toEqual({ domain: permutation, registered_date: REG_DATE });

    // 3. The REAL matcher, resuming from its advanced cursor, claims it.
    const second = await runLookalikeNrdMatch(env);
    expect(second.claimed).toBe(1);
    expect(
      raw.prepare(
        "SELECT registration_evidence AS ev, first_seen FROM lookalike_domains WHERE domain = ? AND brand_id = 'b_pp'",
      ).get(permutation),
    ).toEqual({ ev: "nrd", first_seen: `${REG_DATE} 00:00:00` });
  });

  it("phantom source: a back-checked phantom NRD is found by the phantom matcher's incremental nrd run", async () => {
    raw.prepare(
      "INSERT INTO phantom_domains (id, brand_id, domain, source_model) VALUES ('ph1', 'b1', 'brand-ai-help.com', 'm')",
    ).run();
    const archive = fakeR2Bucket();
    await putArchive(archive, daysAgo(3), "a.com", ["a.com", "brand-ai-help.com"]);
    const env = envOf(archive);
    // A cursor from an earlier incremental run: the back-check row must land above it.
    await env.CACHE.put("phantom_matcher:nrd:cursor", "2000-01-01 00:00:00");

    const bc = await runNrdArchiveBackcheck(env, ["brand-ai-help.com"], "phantom");
    expect(bc).toMatchObject({ hits: 1, stored: 1 });
    expect(nrdRow("brand-ai-help.com")?.registered_date).toBe(daysAgo(3));

    createAlertSpy.mockResolvedValue(null);
    const pm = await runPhantomMatch(env, db, { source: "nrd" });
    expect(pm.by_source.nrd.matched).toBe(1);
  });
});

describe.skipIf(!hasSqlite())("NRD archive back-check — scan order and bounds", () => {
  beforeEach(() => {
    raw = openDb();
    db = d1FromSqlite(raw);
    seedLookalike("x.com");
    seedLookalike("y.com");
  });

  it("the OLDEST listing wins, and the scan stops once every domain is found", async () => {
    const archive = fakeR2Bucket();
    await putArchive(archive, daysAgo(2), "a.com", ["a.com", "x.com"]);
    await putArchive(archive, daysAgo(5), "b.com", ["b.com", "x.com"]);

    const r = await runNrdArchiveBackcheck(envOf(archive), ["x.com"], "lookalike");

    expect(nrdRow("x.com")?.registered_date).toBe(daysAgo(5));
    expect(r).toMatchObject({ hits: 1, stored: 1, objects_scanned: 1 });
    expect(archive.ops.get).toBe(1); // the newer object was never read
  });

  it("only the last NRD_BACKCHECK_DAYS dates are read; today and older objects are ignored", async () => {
    const archive = fakeR2Bucket();
    await putArchive(archive, daysAgo(NRD_BACKCHECK_DAYS + 1), "a.com", ["x.com"]);
    await putArchive(archive, daysAgo(0), "a.com", ["x.com"]);
    await putArchive(archive, daysAgo(NRD_BACKCHECK_DAYS), "c.com", ["y.com"]);

    const r = await runNrdArchiveBackcheck(envOf(archive), ["x.com", "y.com"], "lookalike");

    expect(r).toMatchObject({ hits: 1, stored: 1, objects_scanned: 1 });
    expect(nrdRow("x.com")).toBeUndefined();
    expect(nrdRow("y.com")?.registered_date).toBe(daysAgo(NRD_BACKCHECK_DAYS));
    expect(archive.ops.list).toBe(NRD_BACKCHECK_DAYS);
  });

  it("a domain already in nrd_domains is a hit with stored = 0 (INSERT OR IGNORE)", async () => {
    raw.prepare("INSERT INTO nrd_domains (domain, registered_date) VALUES ('x.com', '2026-01-01')").run();
    const archive = fakeR2Bucket();
    await putArchive(archive, daysAgo(1), "a.com", ["x.com"]);
    const r = await runNrdArchiveBackcheck(envOf(archive), ["x.com"], "lookalike");
    expect(r).toMatchObject({ hits: 1, stored: 0 });
    expect(nrdRow("x.com")?.registered_date).toBe("2026-01-01");
  });

  it("no domains → skipped with zero R2 traffic", async () => {
    const archive = fakeR2Bucket();
    const r = await runNrdArchiveBackcheck(envOf(archive), [], "lookalike");
    expect(r.skipped).toBe("no_domains");
    expect(archive.ops).toEqual({ head: 0, get: 0, put: 0, delete: 0, list: 0 });
  });

  it("NRD_ARCHIVE unbound → skipped, never throws", async () => {
    const r = await runNrdArchiveBackcheck(envOf(null), ["x.com"], "lookalike");
    expect(r.skipped).toBe("archive_unbound");
    expect(nrdRow("x.com")).toBeUndefined();
  });

  it("the soft cap stops the scan (timed_out) without throwing", async () => {
    const archive = fakeR2Bucket();
    await putArchive(archive, daysAgo(1), "a.com", ["x.com"]);
    const r = await runNrdArchiveBackcheck(envOf(archive), ["x.com"], "lookalike", { softCapMs: 0 });
    expect(r.timed_out).toBe(true);
    expect(archive.ops.get).toBe(0);
    expect(nrdRow("x.com")).toBeUndefined();
  });

  it("a failing GET or a corrupt object is counted and the scan continues to the next object", async () => {
    const archive = fakeR2Bucket();
    const badKey = await putArchive(archive, daysAgo(4), "a.com", ["x.com"]);
    archive.store.set(badKey, { bytes: new TextEncoder().encode("not gzip\n"), customMetadata: {} });
    const failKey = await putArchive(archive, daysAgo(3), "b.com", ["x.com"]);
    await putArchive(archive, daysAgo(2), "c.com", ["x.com", "y.com"]);
    const inner = archive.bucket;
    const bucket = {
      list: inner.list.bind(inner),
      get: async (k: string) => {
        if (k === failKey) throw new Error("R2 get failed: simulated");
        return inner.get(k);
      },
    } as unknown as R2Bucket;
    const env = { ...envOf(archive), NRD_ARCHIVE: bucket } as unknown as Env;

    const r = await runNrdArchiveBackcheck(env, ["x.com", "y.com"], "lookalike");

    expect(r.object_errors).toBe(2);
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ hits: 2, stored: 2 });
    expect(nrdRow("x.com")?.registered_date).toBe(daysAgo(2));
  });

  it("a failing list is caught into `error`, never thrown", async () => {
    const bucket = { list: async () => { throw new Error("R2 list failed: simulated"); } } as unknown as R2Bucket;
    const env = { ...envOf(fakeR2Bucket()), NRD_ARCHIVE: bucket } as unknown as Env;
    const r = await runNrdArchiveBackcheck(env, ["x.com"], "lookalike");
    expect(r.error).toMatch(/simulated/);
  });
});
