/**
 * nrd_hagezi source: Hagezi NRD 7-day list, merge-diffed against an R2
 * snapshot of the previous run (replaced the WhoisDS free daily ZIP, whose
 * free tier turned out to be a random 70K sample per day).
 *
 * Pins: conditional-GET / same-version no-ops, bootstrap (snapshot only, no
 * D1), diff brand-matches ONLY new domains and stores in nrd_domains only the
 * new ones equal to a lookalike_domains / phantom_domains domain (the
 * matchable filter — test/nrd-hagezi-matchable.test.ts covers it in depth), the snapshot advances
 * only after every D1 write succeeded, format guards (sort order, empty, HTML,
 * truncated), the per-run cap, registered_date derivation, and the
 * combosquat brand-keyword semantics (token boundary, generic keywords only
 * with a STRONG lure word, homoglyphs, canonical exclusion, first-brand-wins,
 * per-run keyword demotion — lib/nrd-brand-match.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  nrd_hagezi,
  ingestNrdHagezi,
  BrandMatcher,
  brandKeywords,
  buildBrandKeywords,
  collectBrandMatchRows,
  isGenericKeyword,
  registeredDateFromHeader,
  registrableLabels,
  NRD_HAGEZI_URL,
  NRD_SNAPSHOT_KEY,
} from "../src/feeds/nrd_hagezi";
import { threatId } from "../src/feeds/types";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import { fakeR2Bucket, gzipText, gunzipText, type FakeR2Bucket } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const VERSION = "2026.1005.0611.45";
const MODIFIED = "05 Oct 2026 06:11 UTC";

interface ListOpts {
  version?: string | null;
  modified?: string | null;
  /** `# Number of entries:` value; defaults to the domain count. null omits it. */
  entries?: number | null;
  etag?: string;
  contentType?: string;
  /** Keep the given order instead of byte-sorting. */
  unsorted?: boolean;
}

function listBody(domains: string[], o: ListOpts = {}): string {
  const lines: string[] = ["# Title: Hagezi NRD 7 days"];
  if (o.version !== null) lines.push(`# Version: ${o.version ?? VERSION}`);
  if (o.modified !== null) lines.push(`# Last modified: ${o.modified ?? MODIFIED}`);
  if (o.entries !== null) lines.push(`# Number of entries: ${o.entries ?? domains.length}`);
  lines.push("#");
  const body = o.unsorted ? domains : [...domains].sort();
  return `${[...lines, ...body].join("\n")}\n`;
}

function listResponse(domains: string[], o: ListOpts = {}): Response {
  return new Response(listBody(domains, o), {
    status: 200,
    headers: {
      etag: o.etag ?? '"etag-today"',
      "content-type": o.contentType ?? "text/plain; charset=utf-8",
    },
  });
}

/** Records every fetch so tests can assert URL + conditional header. */
function stubFetch(respond: (init: RequestInit | undefined) => Response) {
  const calls: Array<{ url: string; ifNoneMatch: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    calls.push({ url, ifNoneMatch: h.get("If-None-Match") });
    return respond(init);
  }));
  return calls;
}

async function snapshotOf(domains: string[], meta: Record<string, string>) {
  const text = domains.length ? `${[...domains].sort().join("\n")}\n` : "";
  return { bytes: await gzipText(text), customMetadata: meta };
}

/** A D1 that fails the test on any use — proves a path never touches D1. */
const noD1 = {
  prepare() { throw new Error("D1 must not be touched on this path"); },
  batch() { throw new Error("D1 must not be touched on this path"); },
} as unknown as D1Database;

function envOf(db: D1Database, r2: FakeR2Bucket): Env {
  return { DB: db, CACHE: fakeKv(), GEOIP_STAGING: r2.bucket, NRD_ARCHIVE: fakeR2Bucket().bucket } as unknown as Env;
}

const ctxOf = (env: Env) => ({ env, feedName: "nrd_hagezi", feedUrl: "" });

afterEach(() => vi.unstubAllGlobals());

describe("nrd_hagezi — no-op runs", () => {
  it("sends the snapshot ETag as If-None-Match and a 304 is a zero no-op with no D1 or R2 write", async () => {
    const r2 = fakeR2Bucket({
      [NRD_SNAPSHOT_KEY]: await snapshotOf(["a.com"], { etag: '"etag-prev"', version: "old" }),
    });
    const calls = stubFetch(() => new Response(null, { status: 304 }));

    const r = await nrd_hagezi.ingest(ctxOf(envOf(noD1, r2)));

    expect(calls).toEqual([{ url: NRD_HAGEZI_URL, ifNoneMatch: '"etag-prev"' }]);
    expect(r).toEqual({ itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(r2.ops.put).toBe(0);
    expect(r2.ops.get).toBe(0);
  });

  it("an unchanged `# Version:` is a no-op even when the ETag differs", async () => {
    const r2 = fakeR2Bucket({
      [NRD_SNAPSHOT_KEY]: await snapshotOf(["a.com"], { etag: '"edge-1"', version: VERSION }),
    });
    stubFetch(() => listResponse(["a.com", "b.com"], { etag: '"edge-2"' }));

    const r = await nrd_hagezi.ingest(ctxOf(envOf(noD1, r2)));

    expect(r).toEqual({ itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(r2.ops.put).toBe(0);
  });

  it("sends no If-None-Match when there is no snapshot", async () => {
    const r2 = fakeR2Bucket();
    const calls = stubFetch(() => listResponse(["a.com"]));
    await nrd_hagezi.ingest(ctxOf(envOf(noD1, r2)));
    expect(calls[0]!.ifNoneMatch).toBeNull();
  });
});

describe("nrd_hagezi — bootstrap", () => {
  it("writes the snapshot (gzip, with etag/version/list_modified) and inserts nothing", async () => {
    const r2 = fakeR2Bucket();
    const domains = ["zeta.net", "alpha.com", "acmebank-login.example"];
    stubFetch(() => listResponse(domains));

    const r = await nrd_hagezi.ingest(ctxOf(envOf(noD1, r2)));

    expect(r).toEqual({ itemsFetched: 3, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    const snap = r2.store.get(NRD_SNAPSHOT_KEY)!;
    expect(snap.customMetadata).toEqual({ etag: '"etag-today"', version: VERSION, list_modified: MODIFIED });
    expect(await gunzipText(snap.bytes)).toBe(`${[...domains].sort().join("\n")}\n`);
  });

  it("throws a precise error when GEOIP_STAGING is unbound", async () => {
    stubFetch(() => listResponse(["a.com"]));
    const env = { DB: noD1, CACHE: fakeKv() } as unknown as Env;
    await expect(nrd_hagezi.ingest(ctxOf(env))).rejects.toThrow(/GEOIP_STAGING \(R2\) binding not configured/);
  });
});

let raw: SqliteDb;
let db: D1Database;

const count = (sql: string, ...p: unknown[]): number =>
  (raw.prepare(sql).all(...p)[0] as { n: number }).n;

function seedBrand(id: string, name: string, canonical: string): void {
  raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)").run(id, name, canonical);
  raw.prepare(
    "INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES (?, '__internal__', 'u1', 'active')",
  ).run(id);
}

let seedSeq = 0;
/** Make `domains` matchable: lookalike_domains rows, as the matchable filter
 *  only stores new NRDs equal to one. */
function seedLookalikes(domains: string[]): void {
  const st = raw.prepare(
    "INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type) VALUES (?, 'b_seed', ?, 'typosquat')",
  );
  raw.exec("BEGIN");
  for (const d of domains) st.run(`la-${++seedSeq}`, d);
  raw.exec("COMMIT");
}

const nrdRows = (): Array<{ domain: string; registered_date: string }> =>
  raw.prepare("SELECT domain, registered_date FROM nrd_domains ORDER BY domain").all() as Array<{
    domain: string;
    registered_date: string;
  }>;

describe.skipIf(!hasSqlite())("nrd_hagezi — diff against the snapshot", () => {
  beforeEach(() => {
    raw = openDerivedDb(["brands", "monitored_brands", "threats", "lookalike_domains", "phantom_domains"]);
    // The filtered nrd_domains insert probes these by domain (prod indexes).
    for (const t of ["lookalike_domains", "phantom_domains"]) {
      for (const ddl of liveIndexDdl(t).values()) raw.exec(ddl);
    }
    db = d1FromSqlite(raw);
  });

  it("inserts and brand-matches ONLY domains absent from the snapshot, then advances the snapshot", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const prior = ["acmebank-old.example", "keep.com", "gone-from-window.com"];
    const today = ["acmebank-old.example", "keep.com", "acmebank-new.example", "fresh.org"];
    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(prior, { etag: '"e0"', version: "v0" }) });
    // fresh.org (new) and keep.com (old) are lookalike domains; only the NEW
    // one is stored. acmebank-new.example is not matchable: brand-matched
    // into threats, never stored.
    seedLookalikes(["fresh.org", "keep.com"]);
    stubFetch(() => listResponse(today));

    const r = await nrd_hagezi.ingest(ctxOf(envOf(db, r2)));

    expect(r).toEqual({ itemsFetched: 4, itemsNew: 1, itemsDuplicate: 0, itemsError: 0 });
    // registered_date = Last modified (05 Oct) − 1 day.
    expect(nrdRows()).toEqual([
      { domain: "fresh.org", registered_date: "2026-10-04" },
    ]);
    expect(
      (raw.prepare("SELECT id, malicious_domain, target_brand_id FROM threats").all()),
    ).toEqual([
      { id: threatId("nrd_hagezi", "domain", "acmebank-new.example"), malicious_domain: "acmebank-new.example", target_brand_id: "b_acme" },
    ]);
    const snap = r2.store.get(NRD_SNAPSHOT_KEY)!;
    expect(snap.customMetadata).toEqual({ etag: '"etag-today"', version: VERSION, list_modified: MODIFIED });
    expect(await gunzipText(snap.bytes)).toBe(`${[...today].sort().join("\n")}\n`);
  });

  it("falls back to UTC yesterday for registered_date without a Last modified header", async () => {
    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([], { version: "v0" }) });
    seedLookalikes(["new.com"]);
    stubFetch(() => listResponse(["new.com"], { modified: null }));

    await nrd_hagezi.ingest(ctxOf(envOf(db, r2)));

    expect(nrdRows()).toEqual([{ domain: "new.com", registered_date: registeredDateFromHeader(null) }]);
  });

  it("a failing nrd_domains batch fails the pull and leaves the snapshot untouched (retry re-diffs)", async () => {
    const prior = await snapshotOf(["a.com"], { etag: '"e0"', version: "v0" });
    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: prior });
    seedLookalikes(["b.com", "c.com"]); // matchable → an nrd_domains batch runs
    stubFetch(() => listResponse(["a.com", "b.com", "c.com"]));
    const failing = {
      ...db,
      prepare: (sql: string) => db.prepare(sql),
      batch: async () => { throw new Error("D1_ERROR: simulated batch failure"); },
    } as unknown as D1Database;

    await expect(nrd_hagezi.ingest(ctxOf(envOf(failing, r2)))).rejects.toThrow(/simulated batch failure/);

    expect(r2.ops.put).toBe(0);
    expect(r2.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);

    // The retry against the untouched snapshot re-diffs and lands the rows.
    stubFetch(() => listResponse(["a.com", "b.com", "c.com"]));
    const r = await nrd_hagezi.ingest(ctxOf(envOf(db, r2)));
    expect(r.itemsFetched).toBe(3);
    expect(nrdRows().map((x) => x.domain)).toEqual(["b.com", "c.com"]);
    expect(r2.ops.put).toBe(1);
  });

  it("the per-run cap DEFERS: capped domains stay out of the snapshot and land on the next run", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(["acmebank-0.example"], { version: "v0" }) });
    const today = [
      "acmebank-0.example", // old
      "acmebank-1.example",
      "acmebank-2.example",
      "acmebank-3.example",
      "acmebank-4.example",
    ];
    seedLookalikes(today);
    const calls = stubFetch(() => listResponse(today));

    const first = await ingestNrdHagezi(ctxOf(envOf(db, r2)), { maxNewPerRun: 2, flushEvery: 1 });

    expect(first).toEqual({ itemsFetched: 5, itemsNew: 2, itemsDuplicate: 0, itemsError: 0 });
    expect(nrdRows().map((x) => x.domain)).toEqual(["acmebank-1.example", "acmebank-2.example"]);
    // Old + flushed only — the capped tail is NOT recorded as seen.
    let snap = r2.store.get(NRD_SNAPSHOT_KEY)!;
    expect(await gunzipText(snap.bytes)).toBe("acmebank-0.example\nacmebank-1.example\nacmebank-2.example\n");
    // Incomplete image of this version → no etag/version, so the next run
    // neither 304s nor takes the same-version shortcut.
    expect(snap.customMetadata).toEqual({ deferred: "2", list_modified: MODIFIED });

    // Next run, SAME list: re-diffs and picks up the deferred tail.
    const second = await ingestNrdHagezi(ctxOf(envOf(db, r2)), { maxNewPerRun: 2, flushEvery: 1 });

    expect(calls[1]!.ifNoneMatch).toBeNull();
    expect(second).toEqual({ itemsFetched: 5, itemsNew: 2, itemsDuplicate: 0, itemsError: 0 });
    expect(nrdRows().map((x) => x.domain)).toEqual(today.slice(1));
    expect(count("SELECT COUNT(*) AS n FROM threats")).toBe(4);
    snap = r2.store.get(NRD_SNAPSHOT_KEY)!;
    expect(await gunzipText(snap.bytes)).toBe(`${today.join("\n")}\n`);
    expect(snap.customMetadata).toEqual({ etag: '"etag-today"', version: VERSION, list_modified: MODIFIED });

    // Converged: a third run is a same-version no-op.
    const third = await ingestNrdHagezi(ctxOf(envOf(db, r2)), { maxNewPerRun: 2, flushEvery: 1 });
    expect(third).toEqual({ itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
  });

  it("duplicate lines in the snapshot don't make a domain look new", async () => {
    const r2 = fakeR2Bucket({
      [NRD_SNAPSHOT_KEY]: { bytes: await gzipText("a.com\na.com\nb.com\nb.com\n"), customMetadata: { version: "v0" } },
    });
    seedLookalikes(["a.com", "b.com", "c.com"]);
    stubFetch(() => listResponse(["a.com", "b.com", "c.com"]));

    const r = await nrd_hagezi.ingest(ctxOf(envOf(db, r2)));

    expect(r.itemsFetched).toBe(3);
    expect(nrdRows().map((x) => x.domain)).toEqual(["c.com"]);
  });

  it("streams ~200K CRLF lines split mid-line at odd byte boundaries against a large snapshot", async () => {
    const N = 200_000;
    const dom = (i: number) => `d${String(i).padStart(7, "0")}-${((i * 2654435761) >>> 0).toString(36)}.example.com`;
    const today: string[] = [];
    for (let i = 0; i < N; i++) today.push(dom(i));
    // Prior: every 5th of today's domains missing, plus domains that have
    // since aged out of the window (in the snapshot only), interleaved.
    const prior: string[] = [];
    for (let i = 0; i < N; i++) {
      if (i % 5 !== 0) prior.push(dom(i));
      if (i % 9 === 0) prior.push(`${dom(i)}-aged.net`);
    }
    prior.sort();
    const allNew = today.filter((_, i) => i % 5 === 0);
    // Half of the new domains are matchable, plus some OLD (snapshot)
    // domains that must not be stored again: only new ∩ matchable lands.
    const expectedNew = allNew.filter((_, j) => j % 2 === 0);
    seedLookalikes([...expectedNew, ...today.filter((_, i) => i % 5 === 1 && i % 3 === 0)]);

    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: { bytes: await gzipText(`${prior.join("\n")}\n`), customMetadata: { version: "v0" } } });

    // CRLF, no trailing newline, chunked at odd sizes so lines (and CR|LF
    // pairs) split across chunks.
    const text = [`# Version: ${VERSION}`, `# Last modified: ${MODIFIED}`, `# Number of entries: ${N}`, ...today].join("\r\n");
    const bytes = new TextEncoder().encode(text);
    const sizes = [1, 3, 4097, 2, 65_537, 7, 12_289];
    let off = 0;
    let k = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= bytes.length) { c.close(); return; }
        const n = sizes[k++ % sizes.length]!;
        c.enqueue(bytes.slice(off, off + n));
        off += n;
      },
    });
    stubFetch(() => new Response(body, { headers: { etag: '"big"', "content-type": "text/plain" } }));

    const r = await nrd_hagezi.ingest(ctxOf(envOf(db, r2)));

    expect(r).toEqual({ itemsFetched: N, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    const inserted = (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>)
      .map((x) => x.domain);
    expect(inserted).toEqual(expectedNew);
    // Snapshot round-trips: decompressed == today's list (LF-normalised).
    const snap = r2.store.get(NRD_SNAPSHOT_KEY)!;
    expect(await gunzipText(snap.bytes)).toBe(`${today.join("\n")}\n`);
    expect(snap.customMetadata).toEqual({ etag: '"big"', version: VERSION, list_modified: MODIFIED });
  }, 60_000);

  it("in-list repeats are in-payload duplicates even across flush chunks", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([], { version: "v0" }) });
    stubFetch(() => listResponse(["acmebank-x.example", "acmebank-x.example", "acmebank-y.example"]));

    const r = await ingestNrdHagezi(ctxOf(envOf(db, r2)), { flushEvery: 1 });

    expect(r).toEqual({ itemsFetched: 3, itemsNew: 2, itemsDuplicate: 1, itemsError: 0 });
  });
});

describe("nrd_hagezi — format guards", () => {
  it("an out-of-order list throws (format change) and leaves the snapshot untouched", async () => {
    const prior = await snapshotOf(["a.com"], { version: "v0" });
    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: prior });
    stubFetch(() => listResponse(["b.com", "a.com"], { unsorted: true }));
    const okDb = {
      prepare: () => ({ all: async () => ({ results: [] }), run: async () => ({ meta: {} }), bind() { return this; } }),
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 0 } })),
    } as unknown as D1Database;

    await expect(nrd_hagezi.ingest(ctxOf(envOf(okDb, r2)))).rejects.toThrow(/list is not sorted/);
    expect(r2.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);
  });

  it("thrown errors carry no upstream text (a domain like my-404.net must not trip the upstream-dead regex)", async () => {
    stubFetch(() => listResponse(["zz-410.net", "my-404.net"], { unsorted: true }));
    const okDb = {
      prepare: () => ({ all: async () => ({ results: [] }), run: async () => ({ meta: {} }), bind() { return this; } }),
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 0 } })),
    } as unknown as D1Database;
    const r2 = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([], { version: "v0" }) });

    const err = await nrd_hagezi.ingest(ctxOf(envOf(okDb, r2))).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/list is not sorted/);
    expect(err?.message).not.toMatch(/\b(404|410)\b/);
    expect(err?.message).not.toContain("my-404");

    stubFetch(() => new Response("<html>Gone 404</html>\n", { status: 200, headers: { "content-type": "text/plain" } }));
    const err2 = await nrd_hagezi.ingest(ctxOf(envOf(noD1, fakeR2Bucket()))).then(() => null, (e: Error) => e);
    expect(err2?.message).toMatch(/HTML\/markup, not a domain list/);
    expect(err2?.message).not.toMatch(/\b(404|410)\b|\bGone\b/i);
  });

  it("a corrupt (non-gzip) snapshot fails with a precise, recoverable error", async () => {
    const r2 = fakeR2Bucket({
      [NRD_SNAPSHOT_KEY]: { bytes: new TextEncoder().encode("this is not gzip at all\n"), customMetadata: { version: "v0" } },
    });
    stubFetch(() => listResponse(["a.com"]));
    const okDb = {
      prepare: () => ({ all: async () => ({ results: [] }), run: async () => ({ meta: {} }), bind() { return this; } }),
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 0 } })),
    } as unknown as D1Database;

    await expect(nrd_hagezi.ingest(ctxOf(envOf(okDb, r2)))).rejects.toThrow(
      /snapshot nrd\/hagezi-nrd7\.txt\.gz could not be decompressed\/read .* delete that object .* to re-bootstrap/,
    );
    expect(r2.ops.put).toBe(0);
  });

  it("the entry-count check counts RAW content lines, not just the ones that pass the domain filter", async () => {
    // "localhost" has no '.', so it's skipped as a domain — but the header
    // counts it, and so must the check.
    const r2 = fakeR2Bucket();
    stubFetch(() => new Response(
      `# Version: ${VERSION}\n# Number of entries: 3\na.com\nb.com\nlocalhost\n`,
      { status: 200, headers: { "content-type": "text/plain" } },
    ));

    const r = await nrd_hagezi.ingest(ctxOf(envOf(noD1, r2)));
    expect(r.itemsFetched).toBe(2);
    expect(r2.ops.put).toBe(1);
  });

  it("an out-of-order snapshot throws naming the key to delete", async () => {
    const r2 = fakeR2Bucket({
      [NRD_SNAPSHOT_KEY]: { bytes: await gzipText("b.com\na.com\n"), customMetadata: { version: "v0" } },
    });
    stubFetch(() => listResponse(["c.com"]));
    const okDb = {
      prepare: () => ({ all: async () => ({ results: [] }), run: async () => ({ meta: {} }), bind() { return this; } }),
      batch: async (s: unknown[]) => s.map(() => ({ meta: { changes: 0 } })),
    } as unknown as D1Database;

    await expect(nrd_hagezi.ingest(ctxOf(envOf(okDb, r2)))).rejects.toThrow(
      new RegExp(`snapshot ${NRD_SNAPSHOT_KEY}.*not sorted`),
    );
  });

  it("an empty (header-only) list throws, in wording that is NOT the sticky upstream-dead taxonomy", async () => {
    const r2 = fakeR2Bucket();
    stubFetch(() => listResponse([], { entries: 0 }));

    const err = await nrd_hagezi.ingest(ctxOf(envOf(noD1, r2))).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/list contained zero domains/);
    // Same predicates as autoPauseFeed's isPermanentError (lib/feedRunner.ts):
    // an empty daily build is transient → auto:consecutive_failures.
    expect(err?.message).not.toMatch(/\b(404|410)\b/);
    expect(err?.message).not.toMatch(/upstream archived|no longer publishes|\bGone\b/i);
    expect(err?.message).not.toMatch(/served no data on \d+ consecutive days/i);
    expect(r2.ops.put).toBe(0);
  });

  it("an HTML body throws instead of mining domains out of markup", async () => {
    const r2 = fakeR2Bucket();
    stubFetch(() => new Response("<!DOCTYPE html>\n<html><a href='x.com'>x.com</a></html>\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }));
    await expect(nrd_hagezi.ingest(ctxOf(envOf(noD1, r2)))).rejects.toThrow(/HTML\/markup, not a domain list/);
    expect(r2.ops.put).toBe(0);
  });

  it("a text/html content-type throws", async () => {
    stubFetch(() => listResponse(["a.com"], { contentType: "text/html; charset=utf-8" }));
    await expect(nrd_hagezi.ingest(ctxOf(envOf(noD1, fakeR2Bucket())))).rejects.toThrow(/content-type "text\/html/);
  });

  it("a body shorter than its `Number of entries` header (truncated download) throws before the snapshot is written", async () => {
    const r2 = fakeR2Bucket();
    stubFetch(() => listResponse(["a.com", "b.com"], { entries: 3_100_865 }));
    await expect(nrd_hagezi.ingest(ctxOf(envOf(noD1, r2)))).rejects.toThrow(/2 entries but its header declares 3100865/);
    expect(r2.ops.put).toBe(0);
  });

  it("a non-2xx surfaces the status (404 → autoPauseFeed's upstream-dead class)", async () => {
    stubFetch(() => new Response("Not Found", { status: 404 }));
    await expect(nrd_hagezi.ingest(ctxOf(envOf(noD1, fakeR2Bucket())))).rejects.toThrow(/HTTP 404/);
  });

  it("a fetch throw surfaces as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(nrd_hagezi.ingest(ctxOf(envOf(noD1, fakeR2Bucket())))).rejects.toThrow(/list fetch failed — network down/);
  });
});

describe("registeredDateFromHeader", () => {
  it("is the Last modified UTC date minus one day", () => {
    expect(registeredDateFromHeader("05 Oct 2026 06:11 UTC")).toBe("2026-10-04");
    expect(registeredDateFromHeader("1 Jan 2026 00:05 UTC")).toBe("2025-12-31");
    expect(registeredDateFromHeader("01 March 2026 06:00 UTC")).toBe("2026-02-28");
  });

  it("falls back to UTC yesterday when missing or unparseable", () => {
    const now = new Date("2026-10-05T03:00:00Z");
    expect(registeredDateFromHeader(null, now)).toBe("2026-10-04");
    expect(registeredDateFromHeader("garbage", now)).toBe("2026-10-04");
  });
});

// ─── Brand-keyword (combosquat) semantics ────────────────────────────

/** Brands as the feed builds them from D1 rows (load order = priority). */
const brandsOf = (...rows: Array<[id: string, name: string, canonical: string]>) =>
  buildBrandKeywords(rows.map(([id, name, canonical_domain]) => ({ id, name, canonical_domain })));

/** domain → winning brand id, for the domains that matched. */
const winners = (domains: string[], brands: ReturnType<typeof brandsOf>) =>
  Object.fromEntries(collectBrandMatchRows(domains, brands).rows.map((r) => [r.malicious_domain, r.target_brand_id]));

describe("brand keywords + classification", () => {
  it("derives name, hyphenated-name and (distinctive-only) canonical-label keywords", () => {
    expect(brandKeywords("PayPal", "paypal.com")).toEqual([{ keyword: "paypal", generic: false }]);
    expect(brandKeywords("Standard Chartered", "sc.com")).toEqual([
      { keyword: "standardchartered", generic: false },
      { keyword: "standard-chartered", generic: false },
    ]);
    // Distinctive canonical label added alongside the name.
    expect(brandKeywords("Zelle", "zellepay.com")).toEqual([
      { keyword: "zelle", generic: false },
      { keyword: "zellepay", generic: false },
    ]);
    // Generic canonical label (revenue.ie) is NOT added.
    expect(brandKeywords("Revenue Ireland", "revenue.ie").map((k) => k.keyword)).toEqual([
      "revenueireland",
      "revenue-ireland",
    ]);
    // A canonical with a subdomain or a path names the parent brand → no label keyword.
    expect(brandKeywords("Apple TV+", "tv.apple.com").map((k) => k.keyword)).toEqual(["appletv", "apple-tv"]);
    expect(brandKeywords("LinkedIn Learning", "linkedin.com/learning").map((k) => k.keyword)).toEqual([
      "linkedinlearning",
      "linkedin-learning",
    ]);
    // Short names are generic; apostrophes/diacritics folded; <3 chars and NEVER words dropped.
    expect(brandKeywords("AT&T", "att.com")).toEqual([{ keyword: "att", generic: true }]);
    expect(brandKeywords("Lowe's", "lowes.com")).toEqual([{ keyword: "lowes", generic: false }]);
    expect(brandKeywords("Hydro-Québec", "hydroquebec.com").map((k) => k.keyword)).toEqual([
      "hydroquebec",
      "hydro-quebec",
    ]);
    expect(brandKeywords("HP", "hp.com")).toEqual([]);
    expect(brandKeywords("Mail", "mail.ru")).toEqual([]);
    expect(brandKeywords("Www", "www.gov.uk")).toEqual([]);
  });

  it("generic = ≤4 chars or a curated dictionary word (hyphens ignored); everything else distinctive", () => {
    for (const k of ["att", "line", "dhl", "booking", "apple", "office", "first-national-bank", "intel"]) {
      expect(isGenericKeyword(k), k).toBe(true);
    }
    for (const k of ["paypal", "coinbase", "docusign", "tiktok", "standard-chartered", "zellepay"]) {
      expect(isGenericKeyword(k), k).toBe(false);
    }
  });

  it("registrableLabels drops the public suffix (incl. ccSLDs like co.uk)", () => {
    expect(registrableLabels("paypal.com")).toEqual(["paypal"]);
    expect(registrableLabels("paypal-login.co.uk")).toEqual(["paypal-login"]);
    expect(registrableLabels("006zhiboonline.com.cn")).toEqual(["006zhiboonline"]);
    expect(registrableLabels("secure.paypal-help.com")).toEqual(["secure", "paypal-help"]);
    expect(registrableLabels("paypal.uk.com")).toEqual(["paypal", "uk"]);
  });
});

describe("collectBrandMatchRows — combosquat semantics", () => {
  it("distinctive keyword: a delimited token or concatenated with lure/glue words and digits, never embedded", () => {
    const brands = brandsOf(["b_pp", "PayPal", "paypal.com"]);
    const hits = [
      "paypal.to", // TLD swap
      "paypal-secure-login.com",
      "secure.paypal-help.com",
      "paypal24.shop",
      "mypaypal.com",
      "paypalverify.net",
      "securepaypal.com",
      "paypal-xk7q.biz", // other hyphen segments are unconstrained
    ];
    const misses = [
      "unpaypalable.com", // embedded in a word
      "paypalshirts.com", // "shirts" is not lure vocabulary
      "wpaypal.com",
      "paypal.com", // the brand's own canonical domain
    ];
    const got = winners([...hits, ...misses], brands);
    expect(Object.keys(got).sort()).toEqual([...hits].sort());
  });

  it("homoglyph variants match distinctive keywords only", () => {
    const brands = brandsOf(["b_ms", "Microsoft", "microsoft.com"], ["b_att", "AT&T", "att.com"]);
    expect(winners(["micros0ft-support.net", "rnicrosoft.com", "4tt-login.com", "att-login.com"], brands)).toEqual({
      "micros0ft-support.net": "b_ms",
      "att-login.com": "b_att",
    });
  });

  it("generic keyword needs a STRONG lure word in its segment or an adjacent one", () => {
    const brands = brandsOf(["b_att", "AT&T", "att.com"], ["b_line", "Line", "line.me"]);
    const hits = [
      "att-login.com",
      "attverify.net",
      "my-att-account.com", // adjacent "account" segment
      "att2fa.io", // "2fa" is a STRONG word
      "line-login.com",
      "secure-line-update.com",
    ];
    const misses = [
      "att.com.mx", // no lure word
      "att-store.com", // WEAK glue only
      "attic-login.com", // embedded in a word
      "battle.net",
      "att-x7q-login.com", // lure word not adjacent
      "onlineline.hair", // the old matcher's #1 noise source
      "006zhiboonline.com.cn",
      "line.xyz",
      "mylinelogin.com", // "my" is WEAK, so the segment does not decompose over STRONG words
    ];
    const got = winners([...hits, ...misses], brands);
    expect(Object.keys(got).sort()).toEqual([...hits].sort());
  });

  it("first brand wins across keywords; a canonical domain falls through to the next brand", () => {
    const brands = brandsOf(
      ["b_cb", "Coinbase", "coinbase.com"],
      ["b_cb_org", "Coinbase", "coinbase.org"],
      ["b_pp", "PayPal", "paypal.com"],
    );
    expect(winners(["coinbase.com", "coinbase.org", "coinbase-login.com", "paypal-coinbase.com"], brands)).toEqual({
      "coinbase.com": "b_cb_org",
      "coinbase.org": "b_cb",
      "coinbase-login.com": "b_cb",
      "paypal-coinbase.com": "b_cb", // lower brand index, not leftmost occurrence
    });
  });

  it("demotes a flooding distinctive keyword to generic for the rest of the run (deterministic, shared by keyword text)", () => {
    const brands = brandsOf(["b1", "Acmecorp", "acmecorp.com"], ["b2", "Acmecorp", "acmecorp.net"]);
    const m = new BrandMatcher(brands, { demoteAfter: 3 });
    const { rows } = m.collect(
      ["acmecorp-1.io", "acmecorp-2.io", "acmecorp-3.io", "acmecorp-4.io", "acmecorp-login.io", "acmecorp-5.io"],
      new Set<string>(),
    );
    // After 3 rows "acmecorp" needs a lure word; b2 (same keyword) does not pick up the rest.
    expect(rows.map((r) => [r.malicious_domain, r.target_brand_id])).toEqual([
      ["acmecorp-1.io", "b1"],
      ["acmecorp-2.io", "b1"],
      ["acmecorp-3.io", "b1"],
      ["acmecorp-login.io", "b1"],
    ]);
    expect(m.demotedKeywords()).toEqual(["acmecorp"]);
    // Per-call helper starts fresh: demotion never leaks across runs.
    expect(collectBrandMatchRows(["acmecorp-4.io"], brands, new Set(), { demoteAfter: 3 }).rows).toHaveLength(1);
  });

  it("emits the same ThreatRow fields as before", () => {
    const { rows } = collectBrandMatchRows(["acmeb4nk-secure.example"], brandsOf(["b_acme", "Acme Bank", "acmebank.com"]));
    expect(rows).toEqual([{
      id: threatId("nrd_hagezi", "domain", "acmeb4nk-secure.example"),
      source_feed: "nrd_hagezi",
      threat_type: "typosquatting",
      malicious_url: null,
      malicious_domain: "acmeb4nk-secure.example",
      target_brand_id: "b_acme",
      ioc_value: "acmeb4nk-secure.example",
      severity: "medium",
      confidence_score: 60,
    }]);
  });

  it("carries the seen-set across calls when one is passed", () => {
    const brands = brandsOf(["a", "Acmecorp", "acmecorp.com"]);
    const matched = new Set<string>();
    expect(collectBrandMatchRows(["acmecorp-1.io"], brands, matched).rows).toHaveLength(1);
    const second = collectBrandMatchRows(["acmecorp-1.io"], brands, matched);
    expect(second).toEqual({ rows: [], inPayloadDuplicates: 1 });
  });
});

describe.skipIf(!hasSqlite())("migration 0282: nrd_hagezi source metadata", () => {
  it("points feed_configs at the nrd7 URL the module fetches, touching only that row's metadata", () => {
    const sqlDb = openDerivedDb(["feed_configs"]);
    sqlDb.exec(`
      INSERT INTO feed_configs (feed_name, display_name, description, source_url, schedule_cron, enabled)
      VALUES ('nrd_hagezi', 'Newly Registered Domains', 'old', 'https://old.example/nrd-14.txt', '0 */2 * * *', 1),
             ('other', 'Other', 'keep', 'https://keep.example', '0 * * * *', 1);
    `);
    const sql = readFileSync(join(__dirname, "..", "migrations", "0282_nrd_hagezi_source.sql"), "utf8");
    sqlDb.exec(sql);
    sqlDb.exec(sql); // idempotent

    const rows = sqlDb.prepare(
      "SELECT feed_name, source_url, description, schedule_cron, enabled FROM feed_configs ORDER BY feed_name",
    ).all() as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ feed_name: "nrd_hagezi", source_url: NRD_HAGEZI_URL, schedule_cron: "0 */2 * * *", enabled: 1 });
    expect(String(rows[0]!.description)).toMatch(/Hagezi NRD 7-day list.*previous run's snapshot/);
    expect(rows[1]).toMatchObject({ feed_name: "other", source_url: "https://keep.example", description: "keep" });
  });
});
