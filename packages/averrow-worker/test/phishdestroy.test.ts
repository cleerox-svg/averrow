/**
 * Tests for the phishdestroy feed (steady-state diff ingestion, 2026-10-12).
 *
 * The upstream list (destroylist list.json) is a JSON array of ~218K
 * domain strings sorted alphabetically, with no timestamps. The feed:
 *   - baselines on first run (records a snapshot, inserts nothing),
 *   - ingests only domains absent from the previous snapshot,
 *   - skips domains already in threats (any feed),
 *   - caps inserts per run, carrying leftovers via the diff,
 *   - writes the snapshot after inserts,
 *   - falls back to the canonical URL on a configured-URL 404 and records
 *     the warning on the in-flight feed_pull_history row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  phishdestroy,
  PHISHDESTROY_LIST_URL,
  PHISHDESTROY_SNAPSHOT_KEY,
  MAX_INSERTS_PER_RUN,
  normalizeDestroylistEntry,
  domainHash64,
  phishdestroyThreatId,
} from "../src/feeds/phishdestroy";
import { threatId } from "../src/feeds/types";
import { tagThreat } from "../src/lib/idp-tagging";
import type { Env } from "../src/types";

/**
 * Verbatim entries from the live destroylist list.json (fetched
 * 2026-10-12: HTTP 200, JSON array of 218,421 strings, sorted
 * alphabetically). The okta entries are real IdP lures.
 */
const REAL_SAMPLE = [
  "0-105.com",
  "0-autht-lo-xfin-ity-w0965.vercel.app",
  "0-collab.land",
  "0-cz.com",
  "0.0.16.standardweb3.com",
  "0.1trx.im",
  "baserow.server-okta.cloud",
  "corps-okta.com",
  "desk-okta.com",
  "email-okta.com",
];

interface Stmt { sql: string; args: unknown[] }

interface Harness {
  env: Env;
  /** Bind args of every threat INSERT that reached db.batch. */
  inserts: unknown[][];
  /** Number of existence-lookup statements issued. */
  lookups: number;
  /** Bound args of feed_pull_history UPDATEs. */
  pullNotes: unknown[][];
  fetchedUrls: string[];
  kv: Map<string, ArrayBuffer>;
  /** Domains the mocked threats table already holds. */
  existing: Set<string>;
  setList(list: unknown[]): void;
  run(feedUrl?: string): ReturnType<typeof phishdestroy.ingest>;
}

function makeHarness(opts?: {
  routes?: Record<string, { status: number }>;
  failInsertChunkAt?: number;
  failSnapshotPut?: boolean;
}): Harness {
  let list: unknown[] = [];
  const inserts: unknown[][] = [];
  const pullNotes: unknown[][] = [];
  const fetchedUrls: string[] = [];
  const kv = new Map<string, ArrayBuffer>();
  const existing = new Set<string>();
  let insertChunk = 0;
  const h: Harness = {
    env: undefined as unknown as Env,
    inserts, lookups: 0, pullNotes, fetchedUrls, kv, existing,
    setList(l) { list = l; },
    run(feedUrl = PHISHDESTROY_LIST_URL) {
      return phishdestroy.ingest({ env: h.env, feedName: "phishdestroy", feedUrl });
    },
  };

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    const status = opts?.routes?.[url]?.status ?? (url === PHISHDESTROY_LIST_URL ? 200 : 404);
    return { ok: status >= 200 && status < 300, status, json: async () => list };
  }) as unknown as typeof fetch;

  h.env = {
    CACHE: {
      async get(k: string) { return kv.get(k) ?? null; },
      async put(k: string, v: ArrayBuffer) {
        if (opts?.failSnapshotPut && k === PHISHDESTROY_SNAPSHOT_KEY && kv.has(k)) throw new Error("kv down");
        kv.set(k, v);
      },
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            const stmt: Stmt & { run(): Promise<unknown>; all(): Promise<unknown> } = {
              sql, args,
              async run() {
                if (sql.includes("feed_pull_history")) pullNotes.push(args);
                return { meta: { changes: 1 } };
              },
              async all() {
                h.lookups++;
                return { results: (args as string[]).filter((d) => existing.has(d)).map((d) => ({ malicious_domain: d })) };
              },
            };
            return stmt;
          },
        };
      },
      async batch(stmts: Stmt[]) {
        const isInsert = stmts[0]?.sql.includes("INSERT OR IGNORE INTO threats") ?? false;
        if (isInsert) {
          const idx = insertChunk++;
          if (opts?.failInsertChunkAt === idx) throw new Error(`simulated D1 failure on chunk ${idx}`);
          for (const s of stmts) { inserts.push(s.args); existing.add(s.args[3] as string); }
        }
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    },
  } as unknown as Env;
  return h;
}

const domainsOf = (rows: unknown[][]) => rows.map((a) => a[3] as string);

describe("phishdestroy: parsing", () => {
  it("accepts every entry of the real-format sample", () => {
    for (const d of REAL_SAMPLE) expect(normalizeDestroylistEntry(d)).toBe(d);
  });

  it("rejects malformed entries", () => {
    for (const bad of ["*.wild.com", "no-tld", "with space.com", "https://x.com", "abc", 42, null]) {
      expect(normalizeDestroylistEntry(bad)).toBeNull();
    }
    expect(normalizeDestroylistEntry("  FOO.com ")).toBe("foo.com");
  });

  it("rejects a non-array payload", async () => {
    const h = makeHarness();
    h.setList({ not: "an array" } as unknown as unknown[]);
    await expect(h.run()).rejects.toThrow("expected JSON array");
  });
});

describe("phishdestroy: diff ingestion", () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it("first run records a baseline snapshot and inserts nothing", async () => {
    h.setList(REAL_SAMPLE);
    const r = await h.run();
    expect(r).toEqual({ itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(h.inserts).toHaveLength(0);
    expect(h.lookups).toBe(0);
    expect(h.kv.get(PHISHDESTROY_SNAPSHOT_KEY)!.byteLength).toBe(REAL_SAMPLE.length * 8);
  });

  it("ingests only domains added since the previous snapshot, with IdP tags", async () => {
    h.setList(REAL_SAMPLE.slice(0, 6));
    await h.run(); // baseline
    h.setList(REAL_SAMPLE); // upstream adds the 4 okta lures
    const r = await h.run();
    expect(r.itemsNew).toBe(4);
    expect(domainsOf(h.inserts).sort()).toEqual(REAL_SAMPLE.slice(6).sort());
    // bind order: id, type, url, domain, ioc, severity, confidence, technique, impersonated_idp
    for (const args of h.inserts) {
      const domain = args[3] as string;
      const tag = tagThreat({ malicious_domain: domain, malicious_url: `https://${domain}` });
      expect(args[0]).toBe(await phishdestroyThreatId(domain));
      expect(args[2]).toBe(`https://${domain}`);
      expect(args[7]).toBe(tag.technique);
      expect(args[8]).toBe(tag.impersonated_idp);
    }
    expect(h.inserts.some((a) => a[7] !== null)).toBe(true);

    // Unchanged list → nothing to do.
    h.inserts.length = 0;
    const r3 = await h.run();
    expect(r3.itemsFetched).toBe(0);
    expect(h.inserts).toHaveLength(0);
  });

  it("skips candidates already in threats (e.g. legacy-id rows), so no duplicates", async () => {
    h.setList(["old.example"]);
    await h.run();
    h.existing.add("legacy.example"); // ingested earlier under the 32-bit threatId scheme
    h.setList(["old.example", "legacy.example", "fresh.example"]);
    const r = await h.run();
    expect(domainsOf(h.inserts)).toEqual(["fresh.example"]);
    expect(r).toEqual({ itemsFetched: 2, itemsNew: 1, itemsDuplicate: 1, itemsError: 0 });
  });

  it("caps inserts per run and carries the remainder via the diff", async () => {
    h.setList(["seed.example"]);
    await h.run();
    const added = Array.from({ length: 2_500 }, (_, i) => `n${String(i).padStart(4, "0")}.example`);
    h.setList(["seed.example", ...added]);

    const r1 = await h.run();
    expect(r1.itemsNew).toBe(MAX_INSERTS_PER_RUN);
    const r2 = await h.run();
    expect(r2.itemsNew).toBe(MAX_INSERTS_PER_RUN);
    const r3 = await h.run();
    expect(r3.itemsNew).toBe(500);
    const r4 = await h.run();
    expect(r4.itemsNew).toBe(0);
    expect(new Set(domainsOf(h.inserts)).size).toBe(2_500);
    expect(h.inserts).toHaveLength(2_500);
  });

  it("uses ≤99 binds per existence lookup", async () => {
    h.setList(["seed.example"]);
    await h.run();
    h.setList(["seed.example", ...Array.from({ length: 250 }, (_, i) => `x${i}.example`)]);
    await h.run();
    expect(h.lookups).toBe(3); // 99 + 99 + 52
  });

  it("leaves a failed insert chunk out of the snapshot so it retries next run", async () => {
    const f = makeHarness({ failInsertChunkAt: 1 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    f.setList(["seed.example"]);
    await f.run();
    const added = Array.from({ length: 100 }, (_, i) => `r${i}.example`);
    f.setList(["seed.example", ...added]);
    const r1 = await f.run();
    expect(r1).toEqual({ itemsFetched: 100, itemsNew: 50, itemsDuplicate: 0, itemsError: 50 });
    const r2 = await f.run();
    expect(r2.itemsNew).toBe(50);
    expect(new Set(domainsOf(f.inserts)).size).toBe(100);
    err.mockRestore();
  });

  it("a failed post-insert snapshot write does not fail the pull, and the retry inserts no duplicates", async () => {
    const f = makeHarness({ failSnapshotPut: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.setList(["seed.example"]);
    await f.run(); // baseline write succeeds (key absent)
    f.setList(["seed.example", "a1.example", "a2.example"]);
    const r1 = await f.run();
    expect(r1.itemsNew).toBe(2);
    expect(String(f.pullNotes[0]?.[0])).toMatch(/snapshot write failed/);
    const r2 = await f.run(); // re-diffs against the old snapshot
    expect(r2).toEqual({ itemsFetched: 2, itemsNew: 0, itemsDuplicate: 2, itemsError: 0 });
    expect(f.inserts).toHaveLength(2);
    warn.mockRestore();
  });
});

describe("phishdestroy: source URL", () => {
  it("falls back to the canonical URL on a configured 404 and notes it on the pull row", async () => {
    const stale = "https://raw.githubusercontent.com/phishdestroy/destroylist/main/old/list.json";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeHarness();
    h.setList(REAL_SAMPLE);
    await h.run(stale);
    expect(h.fetchedUrls).toEqual([stale, PHISHDESTROY_LIST_URL]);
    expect(h.pullNotes).toHaveLength(1);
    expect(String(h.pullNotes[0]![0])).toMatch(/source_url .*old\/list\.json returned HTTP 404/);
    expect(h.pullNotes[0]![1]).toBe("phishdestroy");
    warn.mockRestore();
  });

  it("writes no note when the configured URL works", async () => {
    const h = makeHarness();
    h.setList(REAL_SAMPLE);
    await h.run();
    expect(h.pullNotes).toHaveLength(0);
  });

  it("fails with an actionable error naming every URL when all 404", async () => {
    const h = makeHarness({ routes: { [PHISHDESTROY_LIST_URL]: { status: 404 } } });
    await expect(h.run("https://example.invalid/list.json")).rejects.toThrow(
      /PhishDestroy HTTP 404 .*example\.invalid.*destroylist\/main\/list\.json.*disable the feed/,
    );
  });

  it("does not fall back on non-404 errors", async () => {
    const h = makeHarness({ routes: { [PHISHDESTROY_LIST_URL]: { status: 503 } } });
    await expect(h.run()).rejects.toThrow("PhishDestroy HTTP 503");
    expect(h.fetchedUrls).toHaveLength(1);
  });
});

describe("phishdestroy: ids and hashes", () => {
  it("threat ids carry a 64-bit SHA-256 prefix, disjoint from legacy 32-bit ids", async () => {
    const id = await phishdestroyThreatId("corps-okta.com");
    expect(id).toMatch(/^thr-phishdestroy-[0-9a-f]{16}$/);
    expect(id).not.toBe(threatId("phishdestroy", "domain", "corps-okta.com"));
    expect(await phishdestroyThreatId("corps-okta.com")).toBe(id); // deterministic
  });

  it("domainHash64 is deterministic and distinct across the sample", () => {
    const hs = REAL_SAMPLE.map(domainHash64);
    expect(new Set(hs).size).toBe(REAL_SAMPLE.length);
    expect(domainHash64("corps-okta.com")).toBe(hs[7]);
    for (const x of hs) expect(x >= 0n && x < 1n << 64n).toBe(true);
  });
});
