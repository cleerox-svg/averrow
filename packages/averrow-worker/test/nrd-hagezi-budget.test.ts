/**
 * nrd_hagezi per-run processing budget, rotation and stalled-stream guards
 * (2026-11-10).
 *
 * Five consecutive diff pulls on 2026-11-09 never settled and were reaped by
 * Navigator (`feed-pull-reaper`), taking the breaker to 5/5. The diff was
 * all-or-nothing: a run that could not finish committed nothing, so every
 * retry redid the whole day. Now:
 *
 *   - new-domain processing stops PREDICTIVELY at NRD_PROCESS_BUDGET_MS
 *     (after a flush, if another flush as slow would end past it); the rest
 *     is DEFERRED like the per-run cap — left out of the snapshot, which is
 *     still written — so each run commits its progress;
 *   - the budget is only checked at a flush boundary, so every run processes
 *     at least one flush (no livelock when the run is already over budget);
 *   - a stopped run records `resume_after`; the next one continues after it
 *     and wraps at the end of the list, so deferral rotates through the
 *     alphabet instead of starving late domains until they leave the 7-day
 *     window (the archive is their only copy);
 *   - a backlog that does not shrink or outlives a list version is flagged;
 *   - the post-stop tail (scan + R2 puts) fits the feed's per-pull timeout;
 *   - flushes stay within D1's 100-bind / 20-statements-per-batch shape;
 *   - threat-insert errors still hold the snapshot under the budget, and
 *     brand matches land exactly once across resumed runs;
 *   - a stalled list body OR snapshot read fails fast with a precise error
 *     instead of hanging until the invocation dies.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  backlogState,
  ingestNrdHagezi,
  NRD_FLUSH_EVERY,
  NRD_PROCESS_BUDGET_MS,
  NRD_SNAPSHOT_KEY,
  NRD_STATEMENTS_PER_BATCH,
  NRD_TAIL_ALLOWANCE_MS,
} from "../src/feeds/nrd_hagezi";
import { feedRunTimeoutMs } from "../src/lib/feedRunner";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import { fakeR2Bucket, gzipText, gunzipText, type FakeR2Bucket } from "./fake-r2-bucket";
import type { Env } from "../src/types";

const VERSION = "2026.1110.0611.45";
const MODIFIED = "10 Nov 2026 06:11 UTC";
const REG_DATE = "2026-11-09";

function listText(domains: string[], version = VERSION): string {
  const head = ["# Title: Hagezi NRD 7 days", `# Version: ${version}`, `# Last modified: ${MODIFIED}`, `# Number of entries: ${domains.length}`, "#"];
  return `${[...head, ...[...domains].sort()].join("\n")}\n`;
}

function stubList(domains: string[], version = VERSION): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(listText(domains, version), {
    status: 200,
    headers: { etag: `"etag-${version}"`, "content-type": "text/plain; charset=utf-8" },
  })));
}

async function snapshotOf(domains: string[], meta: Record<string, string> = { version: "v0" }) {
  const text = domains.length ? `${[...domains].sort().join("\n")}\n` : "";
  return { bytes: await gzipText(text), customMetadata: meta };
}

interface D1Stats {
  batchCalls: number;
  maxStatementsPerBatch: number;
  maxBinds: number;
  /** Fake-clock time at which each batch (flush or threat insert) ended. */
  batchEnds: number[];
}

interface SlowD1Opts {
  /** Throw this many threat-insert batches (then succeed). */
  failThreatBatches?: number;
}

/**
 * D1 wrapper: every db.batch() advances the fake clock by `batchMs`
 * (simulating a slow D1) and records the batch shape. With no brands seeded
 * the threat-insert path never runs, so one batch = one flush.
 */
function slowD1(db: D1Database, clock: { t: number }, batchMs: number, stats: D1Stats, o: SlowD1Opts = {}): D1Database {
  let failsLeft = o.failThreatBatches ?? 0;
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
        all: () => stmt.all(),
        first: () => stmt.first(),
      } as D1PreparedStatement;
    },
    batch: async <T>(stmts: D1PreparedStatement[]) => {
      stats.batchCalls++;
      stats.maxStatementsPerBatch = Math.max(stats.maxStatementsPerBatch, stmts.length);
      clock.t += batchMs;
      stats.batchEnds.push(clock.t);
      const sql = (stmts[0] as unknown as { __sql?: string }).__sql ?? "";
      if (sql.includes("INTO threats") && failsLeft > 0) {
        failsLeft--;
        throw new Error("D1_ERROR: simulated threat batch failure");
      }
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

function seedBrand(id: string, name: string, canonical: string): void {
  raw.prepare("INSERT INTO brands (id, name, canonical_domain) VALUES (?, ?, ?)").run(id, name, canonical);
  raw.prepare(
    "INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status) VALUES (?, '__internal__', 'u1', 'active')",
  ).run(id);
}

/** nrd_domains is created lazily by storeNrdReference — empty before the first flush. */
const nrdDomains = (): string[] => {
  const exists = raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'nrd_domains'").all();
  if (exists.length === 0) return [];
  return (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>)
    .map((x) => x.domain);
};

const count = (sql: string, ...p: unknown[]): number =>
  (raw.prepare(sql).all(...p)[0] as { n: number }).n;

const sortedLines = (domains: string[]) => `${[...domains].sort().join("\n")}\n`;

const pad = (i: number) => String(i).padStart(2, "0");

/** Every domain across every archive object, sorted, with duplicates kept. */
async function archivedDomains(archive: FakeR2Bucket): Promise<string[]> {
  const texts = await Promise.all([...archive.store.values()].map((e) => gunzipText(e.bytes)));
  return texts.join("").split("\n").filter(Boolean).sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("budget vs the feed's per-pull timeout", () => {
  it("runAllFeeds gives nrd_hagezi at least the processing budget plus the tail allowance", () => {
    expect(feedRunTimeoutMs("nrd_hagezi")).toBeGreaterThanOrEqual(NRD_PROCESS_BUDGET_MS + NRD_TAIL_ALLOWANCE_MS);
  });
});

describe("backlogState", () => {
  it("counts consecutive deferring runs and keeps the backlog's start date", () => {
    expect(backlogState({}, 5, "v1", "2026-11-09")).toMatchObject({ runs: 1, since: "2026-11-09", stuck: false });
    const prev = { deferred: "10", deferred_runs: "2", deferred_since: "2026-11-07", deferred_version: "v1" };
    expect(backlogState(prev, 4, "v1", "2026-11-09")).toMatchObject({ runs: 3, since: "2026-11-07", stuck: false });
  });

  it("is stuck when the backlog does not shrink, or outlives a list version", () => {
    const prev = { deferred: "10", deferred_runs: "1", deferred_since: "2026-11-08", deferred_version: "v1" };
    expect(backlogState(prev, 10, "v1", "2026-11-08")).toMatchObject({ stuck: true, acrossVersion: false, previousDeferred: 10 });
    expect(backlogState(prev, 3, "v2", "2026-11-09")).toMatchObject({ stuck: true, acrossVersion: true, since: "2026-11-08" });
  });

  it("a complete run (nothing deferred) clears the backlog; a pre-rotation snapshot is not a version change", () => {
    expect(backlogState({ deferred: "10", deferred_version: "v1" }, 0, "v2", "2026-11-09")).toMatchObject({ runs: 0, stuck: false });
    expect(backlogState({ deferred: "10" }, 3, "v2", "2026-11-09")).toMatchObject({ acrossVersion: false, stuck: false });
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
    stats = { batchCalls: 0, maxStatementsPerBatch: 0, maxBinds: 0, batchEnds: [] };
  });

  it("a slow run stops predictively, commits its progress, and the next runs resume after it", async () => {
    const fresh = Array.from({ length: 10 }, (_, i) => `n-${pad(i)}.com`);
    const today = ["old.com", ...fresh];
    seedLookalikes(fresh);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf(["old.com"]) });
    const archive = fakeR2Bucket();
    const run = async () => {
      const clock = { t: 0 };
      stats.batchEnds = [];
      stubList(today);
      const r = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, clock, 10_000, stats), staging, archive)), {
        flushEvery: 2, processBudgetMs: 25_000, now: () => clock.t,
      });
      // Predictive: no flush ends past the budget.
      expect(Math.max(0, ...stats.batchEnds)).toBeLessThanOrEqual(25_000);
      return r;
    };

    // Flush 1 ends at 10s (10+10 < 25: go on), flush 2 at 20s (20+10 ≥ 25:
    // stop) → 4 processed.
    const first = await run();
    expect(first).toEqual({
      itemsFetched: 11, itemsNew: 0, itemsDuplicate: 0, itemsError: 0,
      warning: "resumable: processed 4 of 10 new domains (time budget); 6 deferred to the next run",
    });
    expect(nrdDomains()).toEqual(fresh.slice(0, 4));
    let snap = staging.store.get(NRD_SNAPSHOT_KEY)!;
    expect(await gunzipText(snap.bytes)).toBe(sortedLines(["old.com", ...fresh.slice(0, 4)]));
    expect(snap.customMetadata).toEqual({
      deferred: "6",
      deferred_runs: "1",
      deferred_since: REG_DATE,
      deferred_version: VERSION,
      resume_after: "n-03.com",
      list_modified: MODIFIED,
    });

    // Run 2 resumes after n-03 and processes 4 more; the backlog shrank, so
    // no stuck flag.
    const second = await run();
    expect(second.warning).toBe("resumable: processed 4 of 6 new domains (time budget); 2 deferred to the next run");
    expect(nrdDomains()).toEqual(fresh.slice(0, 8));
    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata).toMatchObject({ deferred_runs: "2", resume_after: "n-07.com" });

    // Run 3: the last two, then the end of the list → complete.
    const third = await run();
    expect(third).toEqual({ itemsFetched: 11, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(nrdDomains()).toEqual(fresh);
    snap = staging.store.get(NRD_SNAPSHOT_KEY)!;
    expect(await gunzipText(snap.bytes)).toBe(sortedLines(today));
    expect(snap.customMetadata).toEqual({ etag: `"etag-${VERSION}"`, version: VERSION, list_modified: MODIFIED });

    // One archive object per run, together exactly the new domains.
    expect([...archive.store.keys()].sort()).toEqual(
      ["n-00.com", "n-04.com", "n-08.com"].map((f) => `daily/${REG_DATE}/${VERSION}-${f}.txt.gz`),
    );
    expect(await archivedDomains(archive)).toEqual(fresh);

    // Converged: same-version no-op, no D1.
    const before = stats.batchCalls;
    stubList(today);
    expect(await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 10_000, stats), staging, archive)))).toEqual(
      { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 },
    );
    expect(stats.batchCalls).toBe(before);
  });

  it("rotation: budget-stopped runs reach the end of the alphabet even while early domains keep arriving", async () => {
    // Late-alphabet domains deferred from the start; every run a new list
    // version adds two domains that sort BEFORE everything processed so far.
    // Restarting at the top each run would process only those and starve z-*
    // until they left the 7-day window.
    const late = ["z-0.com", "z-1.com", "z-2.com", "z-3.com"];
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([]) });
    const archive = fakeR2Bucket();
    const listed: string[] = [...late];
    const warnings: Array<string | undefined> = [];

    for (let r = 0; r < 6; r++) {
      listed.push(`a-${9 - r}-0.com`, `a-${9 - r}-1.com`);
      stubList(listed, `r${r}`); // never the seed snapshot's "v0"
      const res = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats), staging, archive)), {
        flushEvery: 2, processBudgetMs: 0,
      });
      warnings.push(res.warning);
    }

    const archived = await archivedDomains(archive);
    // Every late domain got processed (and archived exactly once).
    for (const z of late) expect(archived.filter((d) => d === z)).toEqual([z]);
    // Run 2 skipped the new early pair (before the cursor) and took z-0/z-1:
    // the backlog did not shrink across a version change → flagged.
    expect(warnings[1]).toMatch(/BACKLOG STUCK: deferred domains carried across a list version/);
    // Run 3 took z-2/z-3, the last domains after the cursor: it reached the
    // end of the list and the next run wraps to the top.
    expect(warnings[2]).toMatch(/end of list, next run wraps to the top/);
    // Nothing was archived twice.
    expect(new Set(archived).size).toBe(archived.length);
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

    expect(processedPerRun).toEqual([2, 2, 1]);
    expect(nrdDomains()).toEqual(fresh);
    expect(await gunzipText(staging.store.get(NRD_SNAPSHOT_KEY)!.bytes)).toBe(sortedLines(fresh));
    expect(archive.store.size).toBe(3);
    expect(await archivedDomains(archive)).toEqual(fresh);
  });

  it("the post-stop scan tail fits the per-pull timeout and no flush ends past the budget", async () => {
    // The clock also advances while the LIST is read (0.5s per line), so
    // the time after the stop — scanning the rest of the list, the archive
    // and snapshot puts — is part of what is measured.
    const fresh = Array.from({ length: 40 }, (_, i) => `t-${pad(i)}.com`);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([]) });
    const archive = fakeR2Bucket();
    const clock = { t: 0 };
    const lines = listText(fresh).split("\n").map((l) => `${l}\n`);
    vi.stubGlobal("fetch", vi.fn(async () => {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i >= lines.length) { c.close(); return; }
          clock.t += 500;
          c.enqueue(new TextEncoder().encode(lines[i++]!));
        },
      });
      return new Response(body, { status: 200, headers: { etag: '"e"', "content-type": "text/plain" } });
    }));

    // 4 domains per flush: 2s of reading + 10s of D1 → flushes end at ~14,
    // 26, 38s (header lines add ~2.5s); 38 + 10 ≥ 45 → stop. A check that
    // only compared `now >= deadline` would run a 4th flush ending at ~50s.
    const r = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, clock, 10_000, stats), staging, archive)), {
      flushEvery: 4, now: () => clock.t,
    });
    const end = clock.t;

    expect(stats.batchEnds.length).toBe(3);
    expect(Math.max(...stats.batchEnds)).toBeLessThanOrEqual(NRD_PROCESS_BUDGET_MS);
    expect(r.warning).toBe("resumable: processed 12 of 40 new domains (time budget); 28 deferred to the next run");
    // The tail (the remaining 28 lines + puts) ran past the budget but
    // stays inside the allowance and the per-pull timeout.
    expect(end).toBeGreaterThan(NRD_PROCESS_BUDGET_MS);
    expect(end - NRD_PROCESS_BUDGET_MS).toBeLessThanOrEqual(NRD_TAIL_ALLOWANCE_MS);
    expect(end).toBeLessThanOrEqual(feedRunTimeoutMs("nrd_hagezi"));
    // And the snapshot still holds exactly the processed domains.
    expect(await gunzipText(staging.store.get(NRD_SNAPSHOT_KEY)!.bytes)).toBe(sortedLines(fresh.slice(0, 12)));
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
    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata).toMatchObject({
      deferred: String(N - NRD_FLUSH_EVERY),
      resume_after: fresh[NRD_FLUSH_EVERY - 1],
    });
  }, 60_000);

  it("budget stop + threat-insert errors: the snapshot is held, the next run reprocesses, the archive union stays exact", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const fresh = Array.from({ length: 6 }, (_, i) => `acmebank-${pad(i)}.example`);
    const prior = await snapshotOf([]);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: prior });
    const archive = fakeR2Bucket();
    const opts = { flushEvery: 2, processBudgetMs: 0 };

    // Run 1: the first flush's threat batch fails → itemsError, snapshot held.
    stubList(fresh);
    const first = await ingestNrdHagezi(
      ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats, { failThreatBatches: 1 }), staging, archive)), opts,
    );
    expect(first.itemsError).toBe(2);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)).toBe(prior);
    const k0 = `daily/${REG_DATE}/${VERSION}-acmebank-00.example.txt.gz`;
    expect([...archive.store.keys()]).toEqual([k0]);
    expect(count("SELECT COUNT(*) AS n FROM threats")).toBe(0);

    // Retry: same cursor (none) → reprocesses the same flush, rewrites the
    // same archive key, lands the threats; later runs finish the list.
    for (let r = 0; r < 5; r++) {
      stubList(fresh);
      await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats), staging, archive)), opts);
      if (staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata.version === VERSION) break;
    }

    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata.version).toBe(VERSION);
    expect(archive.store.size).toBe(3);
    expect(await archivedDomains(archive)).toEqual(fresh); // each exactly once
    expect(count("SELECT COUNT(*) AS n FROM threats")).toBe(6);
    expect(count("SELECT threat_count AS n FROM brands WHERE id = 'b_acme'")).toBe(6);
  });

  it("brand matches split across budget-stopped runs land exactly once", async () => {
    seedBrand("b_acme", "Acme Bank", "acmebank.com");
    const fresh = Array.from({ length: 4 }, (_, i) => `acmebank-${pad(i)}.example`);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([]) });
    const archive = fakeR2Bucket();
    const opts = { flushEvery: 2, processBudgetMs: 0 };

    stubList(fresh);
    const first = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats), staging, archive)), opts);
    stubList(fresh);
    const second = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats), staging, archive)), opts);

    expect(first).toMatchObject({ itemsNew: 2, itemsDuplicate: 0, itemsError: 0 });
    expect(first.warning).toMatch(/processed 2 of 4/);
    expect(second).toEqual({ itemsFetched: 4, itemsNew: 2, itemsDuplicate: 0, itemsError: 0 });
    expect(
      (raw.prepare("SELECT malicious_domain AS d FROM threats ORDER BY d").all() as Array<{ d: string }>).map((x) => x.d),
    ).toEqual(fresh);
    expect(count("SELECT threat_count AS n FROM brands WHERE id = 'b_acme'")).toBe(4);
  });

  it("a run that finishes inside the budget behaves exactly as before (no warning, complete snapshot)", async () => {
    const fresh = ["p.com", "q.com", "r.com"];
    seedLookalikes(fresh);
    const staging = fakeR2Bucket({ [NRD_SNAPSHOT_KEY]: await snapshotOf([]) });
    const archive = fakeR2Bucket();
    stubList(fresh);

    const r = await ingestNrdHagezi(ctxOf(envOf(slowD1(base, { t: 0 }, 1, stats), staging, archive)), { flushEvery: 1 });

    expect(r).toEqual({ itemsFetched: 3, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(nrdDomains()).toEqual(fresh);
    expect(staging.store.get(NRD_SNAPSHOT_KEY)!.customMetadata).toEqual({
      etag: `"etag-${VERSION}"`, version: VERSION, list_modified: MODIFIED,
    });
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
