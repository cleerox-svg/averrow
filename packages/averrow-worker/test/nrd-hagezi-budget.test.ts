/**
 * nrd_hagezi per-run processing budget + stalled-stream guards (2026-11-10).
 *
 * Five consecutive diff pulls on 2026-11-09 never settled and were reaped by
 * Navigator (`feed-pull-reaper`), taking the breaker to 5/5. The diff was
 * all-or-nothing: a run that could not finish committed nothing, so every
 * retry redid the whole day. Now:
 *
 *   - once NRD_PROCESS_BUDGET_MS is spent (checked after each flush) the
 *     remaining new domains are DEFERRED like the per-run cap — left out of
 *     the snapshot, which is still written — so each run commits its progress
 *     and the next run resumes from it;
 *   - the budget is only checked at a flush boundary, so every run processes
 *     at least one flush (no livelock when the run is already over budget);
 *   - flushes stay within D1's 100-bind / 20-statements-per-batch shape;
 *   - a stalled list body OR snapshot read fails fast with a precise error
 *     instead of hanging until the invocation dies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  ingestNrdHagezi,
  NRD_DOMAINS_PER_STATEMENT,
  NRD_FLUSH_EVERY,
  NRD_PROCESS_BUDGET_MS,
  NRD_SNAPSHOT_KEY,
  NRD_STATEMENTS_PER_BATCH,
} from "../src/feeds/nrd_hagezi";
import { FEED_RUN_TIMEOUT_MS } from "../src/lib/feedRunner";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import { fakeR2Bucket, gzipText, gunzipText, type FakeR2Bucket } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const VERSION = "2026.1110.0611.45";
const MODIFIED = "10 Nov 2026 06:11 UTC";

function listText(domains: string[]): string {
  const head = ["# Title: Hagezi NRD 7 days", `# Version: ${VERSION}`, `# Last modified: ${MODIFIED}`, `# Number of entries: ${domains.length}`, "#"];
  return `${[...head, ...[...domains].sort()].join("\n")}\n`;
}

function stubList(domains: string[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(listText(domains), {
    status: 200,
    headers: { etag: '"etag-today"', "content-type": "text/plain; charset=utf-8" },
  })));
}

async function snapshotOf(domains: string[], meta: Record<string, string> = { version: "v0" }) {
  const text = domains.length ? `${[...domains].sort().join("\n")}\n` : "";
  return { bytes: await gzipText(text), customMetadata: meta };
}

interface D1Stats { batchCalls: number; maxStatementsPerBatch: number; maxBinds: number }

/**
 * D1 wrapper: every db.batch() (= one flush here: no brands are seeded, so
 * the threat-insert path never runs) advances the fake clock by `batchMs`,
 * simulating a slow D1, and records the batch shape.
 */
function slowD1(db: D1Database, clock: { t: number }, batchMs: number, stats: D1Stats): D1Database {
  return {
    ...db,
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        ...stmt,
        bind: (...args: unknown[]) => {
          stats.maxBinds = Math.max(stats.maxBinds, args.length);
          if (args.length > 100) throw new Error(`too many SQL variables (${args.length})`);
          return stmt.bind(...args);
        },
        run: () => stmt.run(),
      } as D1PreparedStatement;
    },
    batch: async <T>(stmts: D1PreparedStatement[]) => {
      stats.batchCalls++;
      stats.maxStatementsPerBatch = Math.max(stats.maxStatementsPerBatch, stmts.length);
      clock.t += batchMs;
      return db.batch<T>(stmts);
    },
  } as D1Database;
}

function envOf(db: D1Database, staging: FakeR2Bucket, archive: FakeR2Bucket): Env {
  return { DB: db, CACHE: fakeKv(), GEOIP_STAGING: staging.bucket, NRD_ARCHIVE: archive.bucket } as unknown as Env;
}

const ctxOf = (env: Env) => ({ env, feedName: "nrd_hagezi", feedUrl: "" });

let raw: SqliteDb;
let base: D1Database;

function seedLookalikes(domains: string[]): void {
  const st = raw.prepare(
    "INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type) VALUES (?, 'b_seed', ?, 'typosquat')",
  );
  raw.exec("BEGIN");
  for (const d of domains) st.run(`la-${d}`, d);
  raw.exec("COMMIT");
}

/** nrd_domains is created lazily by storeNrdReference — empty before the first flush. */
const nrdDomains = (): string[] => {
  const exists = raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'nrd_domains'").all();
  if (exists.length === 0) return [];
  return (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>)
    .map((x) => x.domain);
};

const sortedLines = (domains: string[]) => `${[...domains].sort().join("\n")}\n`;

const pad = (i: number) => String(i).padStart(2, "0");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NRD_PROCESS_BUDGET_MS", () => {
  it("leaves room for the snapshot scan + R2 puts inside runAllFeeds' per-pull cap", () => {
    // Diff pulls took 15–66s end to end (14-day max); the budget only bounds
    // new-domain processing, the scan/puts follow it.
    expect(NRD_PROCESS_BUDGET_MS).toBeLessThanOrEqual(FEED_RUN_TIMEOUT_MS / 2);
    expect(NRD_FLUSH_EVERY).toBe(NRD_DOMAINS_PER_STATEMENT * NRD_STATEMENTS_PER_BATCH);
  });
});

describe.skipIf(!hasSqlite())("nrd_hagezi — per-run processing budget", () => {
  let stats: D1Stats;

  beforeEach(() => {
    raw = openDerivedDb(["brands", "monitored_brands", "threats", "lookalike_domains", "phantom_domains"]);
    for (const t of ["lookalike_domains", "phantom_domains"]) {
      for (const ddl of liveIndexDdl(t).values()) raw.exec(ddl);
    }
    base = d1FromSqlite(raw);
    stats = { batchCalls: 0, maxStatementsPerBatch: 0, maxBinds: 0 };
  });

  it("a slow run stops at the budget, commits its progress, and the next run resumes the rest", async () => {
    const fresh = Array.from({ length: 10 }, (_, i) => `n-${pad(i)}.com`);
    const today = ["old.com", ...fresh];
    seedLookalikes(fresh);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(["old.com"]) });
    const archive = fakeR2Bucket();

    // Each flush (one batch) costs 10s; budget 25s → flushes end at 10s,
    // 20s, 30s → the third crosses it: 3 flushes × 2 = 6 processed.
    const clock1 = { t: 0 };
    stubList(today);
    const first = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, clock1, 10_000, stats), staging, archive)), {
      flushEvery: 2, processBudgetMs: 25_000, now: () => clock1.t,
    });

    expect(first).toEqual({
      itemsFetched: 11, itemsNew: 0, itemsDuplicate: 0, itemsError: 0,
      warning: "resumable: processed 6 of 10 new domains (time budget); 4 deferred to the next run",
    });
    expect(stats.batchCalls).toBe(3);
    expect(nrdDomains()).toEqual(fresh.slice(0, 6));
    // Progress is committed: snapshot = old + processed, and marked
    // incomplete (no etag/version) so the next run re-diffs.
    let snap = staging.store.get(NRD_SNAPSHOT_KEY)!;
    expect(await gunzipText(snap.bytes)).toBe(sortedLines(["old.com", ...fresh.slice(0, 6)]));
    expect(snap.customMetadata).toEqual({ deferred: "4", list_modified: MODIFIED });
    // The archive holds exactly the processed domains.
    const k1 = `daily/2026-11-09/${VERSION}-n-00.com.txt.gz`;
    expect([...archive.store.keys()]).toEqual([k1]);
    expect(await gunzipText(archive.store.get(k1)!.bytes)).toBe(`${fresh.slice(0, 6).join("\n")}\n`);

    // Next run, same list: only the deferred 4 are new; 2 flushes (20s)
    // stay under the budget, so it completes and stamps the version.
    const clock2 = { t: 0 };
    stubList(today);
    const second = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, clock2, 10_000, stats), staging, archive)), {
      flushEvery: 2, processBudgetMs: 25_000, now: () => clock2.t,
    });

    expect(second).toEqual({ itemsFetched: 11, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(nrdDomains()).toEqual(fresh);
    snap = staging.store.get(NRD_SNAPSHOT_KEY)!;
    expect(await gunzipText(snap.bytes)).toBe(sortedLines(today));
    expect(snap.customMetadata).toEqual({ etag: '"etag-today"', version: VERSION, list_modified: MODIFIED });
    const k2 = `daily/2026-11-09/${VERSION}-n-06.com.txt.gz`;
    expect([...archive.store.keys()].sort()).toEqual([k1, k2]);
    expect(await gunzipText(archive.store.get(k2)!.bytes)).toBe(`${fresh.slice(6).join("\n")}\n`);

    // Converged: a third run is the same-version no-op (no D1 at all).
    const before = stats.batchCalls;
    stubList(today);
    const third = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 10_000, stats), staging, archive)), {
      flushEvery: 2, processBudgetMs: 25_000,
    });
    expect(third).toEqual({ itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(stats.batchCalls).toBe(before);
  });

  it("an already-spent budget still processes one flush per run, so runs always converge", async () => {
    const fresh = ["a.com", "b.com", "c.com", "d.com", "e.com"];
    seedLookalikes(fresh);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([]) });
    const archive = fakeR2Bucket();

    const processedPerRun: number[] = [];
    for (let run = 0; run < 5; run++) {
      const before = nrdDomains().length;
      stubList(fresh);
      await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats), staging, archive)), {
        flushEvery: 2, processBudgetMs: 0,
      });
      processedPerRun.push(nrdDomains().length - before);
      if (staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata.version === VERSION) break;
    }

    // 2 + 2 + 1, each landing exactly once, then the snapshot is complete.
    expect(processedPerRun).toEqual([2, 2, 1]);
    expect(nrdDomains()).toEqual(fresh);
    expect(await gunzipText(staging.store.get(NRD_SNAPSHOT_KEY)!.bytes)).toBe(`${fresh.join("\n")}\n`);
    expect(archive.store.size).toBe(3);
    const archivedAll = (await Promise.all([...archive.store.values()].map((e) => gunzipText(e.bytes))))
      .join("").split("\n").filter(Boolean).sort();
    expect(archivedAll).toEqual(fresh);
  });

  it("a budget-stopped run at prod flush size keeps every statement ≤ 2 binds and every batch ≤ 20 statements", async () => {
    const N = NRD_FLUSH_EVERY * 2 + 5_000; // 45K new domains → would be 3 flushes
    const fresh = Array.from({ length: N }, (_, i) => `x${String(i).padStart(6, "0")}.example`);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([]) });
    const archive = fakeR2Bucket();
    const clock = { t: 0 };
    stubList(fresh);

    // First flush alone blows the default budget → exactly one batch.
    const r = await ingestNrdHagezi(
      ctxOf(envOf(slowD1(base, clock, NRD_PROCESS_BUDGET_MS + 1, stats), staging, archive)),
      { now: () => clock.t },
    );

    expect(stats.batchCalls).toBe(1);
    expect(stats.maxStatementsPerBatch).toBe(NRD_STATEMENTS_PER_BATCH);
    expect(stats.maxBinds).toBeLessThanOrEqual(2);
    expect(r.itemsFetched).toBe(N);
    expect(r.warning).toBe(
      `resumable: processed ${NRD_FLUSH_EVERY} of ${N} new domains (time budget); ${N - NRD_FLUSH_EVERY} deferred to the next run`,
    );
    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata).toEqual({
      deferred: String(N - NRD_FLUSH_EVERY),
      list_modified: MODIFIED,
    });
  }, 60_000);

  it("a run that finishes inside the budget behaves exactly as before (no warning, complete snapshot)", async () => {
    const fresh = ["p.com", "q.com", "r.com"];
    seedLookalikes(fresh);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([]) });
    const archive = fakeR2Bucket();
    stubList(fresh);

    const r = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats), staging, archive)), { flushEvery: 1 });

    expect(r).toEqual({ itemsFetched: 3, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(nrdDomains()).toEqual(fresh);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata.version).toBe(VERSION);
  });
});

describe("nrd_hagezi — stalled streams fail fast instead of hanging", () => {
  /** A stream that yields `first` (if any) and then never another chunk. */
  function stallingStream(first?: Uint8Array): ReadableStream<Uint8Array> {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent && first) { sent = true; c.enqueue(first); return; }
        return new Promise<void>(() => { /* never */ });
      },
    });
  }

  const noD1 = {
    prepare() { throw new Error("D1 must not be touched on this path"); },
    batch() { throw new Error("D1 must not be touched on this path"); },
  } as unknown as D1Database;

  it("a stalled snapshot read rejects with the recoverable snapshot error; nothing is written", async () => {
    const puts: string[] = [];
    const staging = {
      async head() { return { key: NRD_SNAPSHOT_KEY, size: 1, customMetadata: { version: "v0" } }; },
      async get() { return { key: NRD_SNAPSHOT_KEY, size: 1, customMetadata: { version: "v0" }, body: stallingStream() }; },
      async put(key: string) { puts.push(key); },
    } as unknown as R2Bucket;
    const archive = fakeR2Bucket();
    stubList(["a.com", "b.com"]);
    // Only the brand-keyword load may run (it precedes the first diff read).
    const brandsOnlyD1 = {
      prepare: () => ({ all: async () => ({ results: [] }) }),
      batch() { throw new Error("no D1 write may happen on this path"); },
    } as unknown as D1Database;
    const env = { DB: brandsOnlyD1, CACHE: fakeKv(), GEOIP_STAGING: staging, NRD_ARCHIVE: archive.bucket } as unknown as Env;

    await expect(ingestNrdHagezi(ctxOf(env), { idleTimeoutMs: 30 })).rejects.toThrow(
      /snapshot nrd\/hagezi-nrd7\.txt\.gz could not be decompressed\/read \(NRD Hagezi: snapshot read stalled — no data for 0\.03s\)/,
    );
    expect(puts).toEqual([]);
    expect(archive.ops.put).toBe(0);
  });

  it("a stalled list body rejects with a precise error; the snapshot is untouched", async () => {
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(["a.com"]) });
    const header = new TextEncoder().encode(`# Version: ${VERSION}\n# Last modified: ${MODIFIED}\n`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stallingStream(header), {
      status: 200,
      headers: { etag: '"e"', "content-type": "text/plain" },
    })));
    const env = { DB: noD1, CACHE: fakeKv(), GEOIP_STAGING: staging.bucket, NRD_ARCHIVE: fakeR2Bucket().bucket } as unknown as Env;

    await expect(ingestNrdHagezi(ctxOf(env), { idleTimeoutMs: 30 })).rejects.toThrow(
      /NRD Hagezi: list body stalled — no data for 0\.03s/,
    );
    expect(staging.ops.put).toBe(0);
  });
});
