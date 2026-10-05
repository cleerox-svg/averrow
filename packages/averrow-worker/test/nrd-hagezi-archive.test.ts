/**
 * nrd_hagezi daily archive (tiered nrd_domains retention, 2026-10-05).
 *
 * D1 keeps ~30 days of nrd_domains (lib/nrd-retention.ts); the cold tier is
 * the NRD_ARCHIVE R2 bucket, where the feed writes every NEW domain it
 * FLUSHED per run — stored in nrd_domains or not (only lookalike/phantom-
 * equal domains are stored) — gzip'd, at
 * `daily/<registered_date>/<version|unversioned>-<first domain>.txt.gz`.
 *
 * Pins: the archive holds exactly the new processed domains (never deferred
 * / capped ones, never old ones) — a superset of what nrd_domains stored —
 * its key + customMetadata (incl. stored_in_d1), no object on bootstrap or
 * zero-new runs, a failed archive put throws BEFORE the diff snapshot
 * advances, threat-insert errors still archive while holding the snapshot,
 * and an unbound NRD_ARCHIVE throws before any fetch or D1 write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  ingestNrdHagezi,
  nrdArchiveKey,
  NRD_ARCHIVE_PREFIX,
  NRD_SNAPSHOT_KEY,
} from "../src/feeds/nrd_hagezi";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import { fakeR2Bucket, gzipText, gunzipText, type FakeR2Bucket } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const VERSION = "2026.1005.0611.45";
const MODIFIED = "05 Oct 2026 06:11 UTC";
const REG_DATE = "2026-10-04"; // Last modified − 1 day

function listResponse(domains: string[], o: { version?: string | null } = {}): Response {
  const lines = ["# Title: Hagezi NRD 7 days"];
  if (o.version !== null) lines.push(`# Version: ${o.version ?? VERSION}`);
  lines.push(`# Last modified: ${MODIFIED}`, `# Number of entries: ${domains.length}`, "#");
  return new Response(`${[...lines, ...[...domains].sort()].join("\n")}\n`, {
    status: 200,
    headers: { etag: '"etag-today"', "content-type": "text/plain; charset=utf-8" },
  });
}

function stubList(domains: string[], o: { version?: string | null } = {}): void {
  vi.stubGlobal("fetch", vi.fn(async () => listResponse(domains, o)));
}

async function snapshotOf(domains: string[], meta: Record<string, string> = { version: "v0" }) {
  const text = domains.length ? `${[...domains].sort().join("\n")}\n` : "";
  return { bytes: await gzipText(text), customMetadata: meta };
}

const noD1 = {
  prepare() { throw new Error("D1 must not be touched on this path"); },
  batch() { throw new Error("D1 must not be touched on this path"); },
} as unknown as D1Database;

function envOf(db: D1Database, staging: FakeR2Bucket, archive: FakeR2Bucket | R2Bucket | null): Env {
  const env: Record<string, unknown> = { DB: db, CACHE: fakeKv(), GEOIP_STAGING: staging.bucket };
  if (archive) env.NRD_ARCHIVE = "bucket" in archive ? archive.bucket : archive;
  return env as unknown as Env;
}

const ctxOf = (env: Env) => ({ env, feedName: "nrd_hagezi", feedUrl: "" });

const archiveKeys = (a: FakeR2Bucket) => [...a.store.keys()].sort();

let seedSeq = 0;
/** Make `domains` matchable (only those land in nrd_domains). */
function seedLookalikes(domains: string[]): void {
  for (const d of domains) {
    raw.prepare(
      "INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type) VALUES (?, 'b_seed', ?, 'typosquat')",
    ).run(`la-${++seedSeq}`, d);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("nrdArchiveKey", () => {
  it("is daily/<registered_date>/<version>-<first domain>.txt.gz", () => {
    expect(NRD_ARCHIVE_PREFIX).toBe("daily/");
    expect(nrdArchiveKey("2026-10-04", VERSION, "a-first.com")).toBe(
      `daily/2026-10-04/${VERSION}-a-first.com.txt.gz`,
    );
  });

  it("uses 'unversioned' without a version and never lets a part add a path segment", () => {
    expect(nrdArchiveKey("2026-10-04", null, "x.org")).toBe("daily/2026-10-04/unversioned-x.org.txt.gz");
    expect(nrdArchiveKey("2026-10-04", "v 1/2", "we/ird.com")).toBe("daily/2026-10-04/v_1_2-we_ird.com.txt.gz");
  });
});

let raw: SqliteDb;
let db: D1Database;

describe.skipIf(!hasSqlite())("nrd_hagezi — daily R2 archive", () => {
  beforeEach(() => {
    raw = openDerivedDb(["brands", "monitored_brands", "threats", "lookalike_domains", "phantom_domains"]);
    // The filtered nrd_domains insert probes these by domain (prod indexes).
    for (const t of ["lookalike_domains", "phantom_domains"]) {
      for (const ddl of liveIndexDdl(t).values()) raw.exec(ddl);
    }
    db = d1FromSqlite(raw);
  });

  it("archives ALL new domains (stored in D1 or not) with key + metadata, before the snapshot advances", async () => {
    const prior = ["keep.com", "old.net"];
    const today = ["keep.com", "old.net", "new-b.org", "new-a.com", "new-c.io"];
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(prior) });
    const archive = fakeR2Bucket();
    seedLookalikes(["new-a.com", "new-c.io", "keep.com"]); // new-b.org is not matchable
    stubList(today);

    // flushEvery: 2 → the archive spans several flushes.
    const r = await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)), { flushEvery: 2 });

    expect(r.itemsFetched).toBe(5);
    const key = `daily/${REG_DATE}/${VERSION}-new-a.com.txt.gz`;
    expect(archiveKeys(archive)).toEqual([key]);
    const obj = archive.store.get(key)!;
    expect(await gunzipText(obj.bytes)).toBe("new-a.com\nnew-b.org\nnew-c.io\n");
    expect(obj.customMetadata).toEqual({
      count: "3",
      stored_in_d1: "2",
      version: VERSION,
      list_modified: MODIFIED,
      registered_date: REG_DATE,
    });
    // nrd_domains holds only the new ∩ matchable subset; the archive is the
    // only copy of new-b.org.
    const rows = (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>)
      .map((x) => x.domain);
    expect(rows).toEqual(["new-a.com", "new-c.io"]);
    // Snapshot advanced as before.
    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata.version).toBe(VERSION);
  });

  it("deferred (capped) domains are NOT archived; the catch-up run archives them under a distinct key", async () => {
    const today = ["d-0.com", "d-1.com", "d-2.com", "d-3.com", "d-4.com"];
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(["d-0.com"]) });
    const archive = fakeR2Bucket();
    stubList(today);

    await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)), { maxNewPerRun: 2, flushEvery: 1 });

    const k1 = `daily/${REG_DATE}/${VERSION}-d-1.com.txt.gz`;
    expect(archiveKeys(archive)).toEqual([k1]);
    expect(await gunzipText(archive.store.get(k1)!.bytes)).toBe("d-1.com\nd-2.com\n");
    expect(archive.store.get(k1)!.customMetadata.count).toBe("2");

    // Same list again: picks up the deferred tail into a SECOND object.
    stubList(today);
    await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)), { maxNewPerRun: 2, flushEvery: 1 });

    const k2 = `daily/${REG_DATE}/${VERSION}-d-3.com.txt.gz`;
    expect(archiveKeys(archive)).toEqual([k1, k2]);
    expect(await gunzipText(archive.store.get(k1)!.bytes)).toBe("d-1.com\nd-2.com\n");
    expect(await gunzipText(archive.store.get(k2)!.bytes)).toBe("d-3.com\nd-4.com\n");
  });

  it("bootstrap (no snapshot) archives nothing", async () => {
    const staging = fakeR2Bucket();
    const archive = fakeR2Bucket();
    stubList(["a.com", "b.com"]);

    await ingestNrdHagezi(ctxOf(envOf(noD1, staging, archive)));

    expect(staging.store.has(NRD_SNAPSHOT_KEY)).toBe(true);
    expect(archive.ops.put).toBe(0);
  });

  it("a run with zero new domains writes no archive object", async () => {
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(["a.com", "b.com", "gone.com"]) });
    const archive = fakeR2Bucket();
    stubList(["a.com", "b.com"]);

    const r = await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)));

    expect(r.itemsFetched).toBe(2);
    expect(archive.ops.put).toBe(0);
    expect(staging.ops.put).toBe(1); // snapshot still advances
  });

  it("an archive put failure throws and leaves the snapshot untouched; the retry rewrites the same key", async () => {
    const prior = await snapshotOf(["a.com"]);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: prior });
    const failing = {
      put: async () => { throw new Error("R2 put failed: simulated"); },
    } as unknown as R2Bucket;
    stubList(["a.com", "b.com", "c.com"]);

    await expect(ingestNrdHagezi(ctxOf(envOf(db, staging, failing)))).rejects.toThrow(/simulated/);

    expect(staging.ops.put).toBe(0);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);

    // Retry: re-diffs (INSERT OR IGNORE), archives the same set, then advances.
    const archive = fakeR2Bucket();
    stubList(["a.com", "b.com", "c.com"]);
    await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)));
    const key = `daily/${REG_DATE}/${VERSION}-b.com.txt.gz`;
    expect(archiveKeys(archive)).toEqual([key]);
    expect(await gunzipText(archive.store.get(key)!.bytes)).toBe("b.com\nc.com\n");
    expect(staging.ops.put).toBe(1);
  });

  it("threat-insert errors still ARCHIVE (nrd_domains rows landed) but hold the snapshot; the retry rewrites the same key", async () => {
    raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES ('b1', 'Acme Bank', 'acmebank.com')").run();
    seedLookalikes(["acmebank-x.example"]);
    raw.prepare(
      "INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES ('b1', '__internal__', 'u1', 'active')",
    ).run();
    raw.exec("DROP TABLE threats"); // bulkInsertThreats reports itemsError, never throws
    const prior = await snapshotOf(["a.com"]);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: prior });
    const archive = fakeR2Bucket();
    stubList(["a.com", "acmebank-x.example"]);

    const r = await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)));

    expect(r.itemsError).toBeGreaterThan(0);
    const key = `daily/${REG_DATE}/${VERSION}-acmebank-x.example.txt.gz`;
    expect(archiveKeys(archive)).toEqual([key]);
    expect(await gunzipText(archive.store.get(key)!.bytes)).toBe("acmebank-x.example\n");
    expect((raw.prepare("SELECT domain FROM nrd_domains").all() as Array<{ domain: string }>).map((x) => x.domain))
      .toEqual(["acmebank-x.example"]);
    // Snapshot NOT advanced → the next run re-diffs.
    expect(staging.ops.put).toBe(0);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);

    // Retry (threats table still broken): same set → same key overwritten.
    stubList(["a.com", "acmebank-x.example"]);
    await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)));
    expect(archiveKeys(archive)).toEqual([key]);
    expect(archive.ops.put).toBe(2);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);
  });

  it("unbound NRD_ARCHIVE throws a precise error before any fetch, D1 write or snapshot write", async () => {
    const prior = await snapshotOf(["a.com"]);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: prior });
    const fetchSpy = vi.fn(async () => listResponse(["a.com", "b.com"]));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(ingestNrdHagezi(ctxOf(envOf(noD1, staging, null)))).rejects.toThrow(
      /NRD_ARCHIVE \(R2\) binding not configured/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(staging.ops.put).toBe(0);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);
  });

  it("an unversioned list archives under 'unversioned'", async () => {
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(["a.com"]) });
    const archive = fakeR2Bucket();
    stubList(["a.com", "b.com"], { version: null });

    await ingestNrdHagezi(ctxOf(envOf(db, staging, archive)));

    const key = `daily/${REG_DATE}/unversioned-b.com.txt.gz`;
    expect(archiveKeys(archive)).toEqual([key]);
    expect(archive.store.get(key)!.customMetadata.version).toBe("unversioned");
  });
});
