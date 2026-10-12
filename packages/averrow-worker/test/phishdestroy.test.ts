/**
 * Tests for the phishdestroy ingest path.
 *
 * The 2026-05-04 rewrite replaced 5,000 sequential KV-GET → DB INSERT →
 * KV-PUT triples (15K subrequests/run, terminating the worker before
 * the pull-history row could be flipped from 'partial' to 'success')
 * with bulk db.batch(INSERT OR IGNORE) chunks — the canonical platform
 * pattern (CLAUDE.md §8).
 *
 * These tests verify the structural guarantees of the rewrite:
 *   1. Payload-level dedupe (no duplicate domain reaches D1).
 *   2. Shape filters reject obvious junk (wildcards, no-dot, whitespace).
 *   3. Chunk size is 50 — keeps any single batch failure localized.
 *   4. itemsNew is summed from `meta.changes` (correctly attributes
 *      INSERT OR IGNORE collisions to itemsDuplicate).
 */

import { describe, it, expect, vi } from "vitest";
import { phishdestroy } from "../src/feeds/phishdestroy";
import type { Env } from "../src/types";

interface CapturedBatch {
  size: number;
  /** Number of statements whose meta.changes contributes to itemsNew. */
  newCount: number;
  /** Number of statements that simulate INSERT OR IGNORE collisions. */
  duplicateCount: number;
}

function makeEnv(payload: unknown[], opts?: {
  newRatio?: number;            // fraction of binds that simulate "new" (changes=1)
  failChunkAt?: number;         // chunk index that throws
}): {
  env: Env;
  batches: CapturedBatch[];
} {
  const batches: CapturedBatch[] = [];
  const newRatio = opts?.newRatio ?? 1;
  let chunkIndex = 0;

  // Mock fetch to return the payload.
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  })) as unknown as typeof fetch;

  const env = {
    DB: {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return { __isStmt: true };
          },
        };
      },
      async batch(stmts: unknown[]) {
        const idx = chunkIndex++;
        if (opts?.failChunkAt === idx) {
          throw new Error(`simulated D1 failure on chunk ${idx}`);
        }
        const newCount = Math.floor(stmts.length * newRatio);
        const duplicateCount = stmts.length - newCount;
        batches.push({ size: stmts.length, newCount, duplicateCount });
        const results = stmts.map((_, i) => ({
          success: true,
          meta: { changes: i < newCount ? 1 : 0 },
        }));
        return results;
      },
    },
  } as unknown as Env;
  return { env, batches };
}

describe("phishdestroy", () => {
  it("dedupes within the payload before issuing any D1 work", async () => {
    const payload = ["foo.com", "FOO.COM", "  foo.com  ", "bar.org"];
    const { env, batches } = makeEnv(payload);

    const result = await phishdestroy.ingest({
      env,
      feedName: "phishdestroy",
      feedUrl: "https://example.invalid/list.json",
    });

    // foo.com appears 3 times in payload (raw / upper / whitespace) —
    // payload de-dupe collapses to 2 unique domains: foo.com + bar.org.
    expect(result.itemsFetched).toBe(2);
    expect(batches[0]!.size).toBe(2);
  });

  it("rejects malformed entries without round-tripping D1", async () => {
    const payload = [
      "ok.com",          // valid
      "*.wild.com",      // wildcard prefix
      "no-tld",          // no dot
      "with space.com",  // whitespace
      "https://x.com",   // protocol prefix
      "abc",             // too short
      42,                // wrong type
      "another.org",     // valid
    ];
    const { env, batches } = makeEnv(payload);

    const result = await phishdestroy.ingest({
      env,
      feedName: "phishdestroy",
      feedUrl: "https://example.invalid/list.json",
    });

    expect(result.itemsFetched).toBe(2);
    expect(batches[0]!.size).toBe(2);
  });

  it("flushes via db.batch() in chunks of 50", async () => {
    const payload = Array.from({ length: 125 }, (_, i) => `host${i}.example`);
    const { env, batches } = makeEnv(payload);

    await phishdestroy.ingest({
      env,
      feedName: "phishdestroy",
      feedUrl: "https://example.invalid/list.json",
    });

    expect(batches).toHaveLength(3);
    expect(batches[0]!.size).toBe(50);
    expect(batches[1]!.size).toBe(50);
    expect(batches[2]!.size).toBe(25);
  });

  it("attributes meta.changes correctly to new vs duplicate", async () => {
    const payload = Array.from({ length: 100 }, (_, i) => `h${i}.example`);
    // 60% of inserts simulate "new" (changes=1), 40% simulate INSERT OR IGNORE collisions.
    const { env } = makeEnv(payload, { newRatio: 0.6 });

    const result = await phishdestroy.ingest({
      env,
      feedName: "phishdestroy",
      feedUrl: "https://example.invalid/list.json",
    });

    // Per chunk of 50, newRatio=0.6 → 30 new + 20 duplicates × 2 chunks = 60/40.
    expect(result.itemsNew).toBe(60);
    expect(result.itemsDuplicate).toBe(40);
    expect(result.itemsError).toBe(0);
    expect(result.itemsFetched).toBe(100);
  });

  it("treats a failed batch chunk as itemsError without aborting the run", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = Array.from({ length: 100 }, (_, i) => `h${i}.example`);
    const { env } = makeEnv(payload, { failChunkAt: 1 });

    const result = await phishdestroy.ingest({
      env,
      feedName: "phishdestroy",
      feedUrl: "https://example.invalid/list.json",
    });

    expect(result.itemsError).toBe(50);  // the failed chunk
    expect(result.itemsNew + result.itemsDuplicate + result.itemsError).toBe(100);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ─── Upstream format, URL fallback, rotation cursor (2026-10-12) ─────
//
// Fixture: verbatim entries from the live destroylist list.json
// (fetched 2026-10-12 — HTTP 200, JSON array of 218,421 strings,
// sorted alphabetically). The okta entries are real IdP lures.
import {
  PHISHDESTROY_LIST_URL,
  PHISHDESTROY_CURSOR_KEY,
  normalizeDestroylistEntry,
} from "../src/feeds/phishdestroy";
import { tagThreat } from "../src/lib/idp-tagging";

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

interface Harness {
  env: Env;
  binds: unknown[][];
  fetchedUrls: string[];
  kv: Map<string, string>;
}

function makeHarness(routes: Record<string, { status: number; body?: unknown }>, kvInit?: Record<string, string>): Harness {
  const binds: unknown[][] = [];
  const fetchedUrls: string[] = [];
  const kv = new Map<string, string>(Object.entries(kvInit ?? {}));
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    const r = routes[url] ?? { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
  const env = {
    CACHE: {
      async get(k: string) { return kv.get(k) ?? null; },
      async put(k: string, v: string) { kv.set(k, v); },
    },
    DB: {
      prepare(_sql: string) {
        return { bind(...args: unknown[]) { binds.push(args); return { args }; } };
      },
      async batch(stmts: unknown[]) {
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    },
  } as unknown as Env;
  return { env, binds, fetchedUrls, kv };
}

describe("phishdestroy — upstream contract", () => {
  it("accepts every entry of the real-format sample", () => {
    for (const d of REAL_SAMPLE) expect(normalizeDestroylistEntry(d)).toBe(d);
  });

  it("ingests the real sample and binds IdP tags from tagThreat", async () => {
    const h = makeHarness({ [PHISHDESTROY_LIST_URL]: { status: 200, body: REAL_SAMPLE } });
    const r = await phishdestroy.ingest({ env: h.env, feedName: "phishdestroy", feedUrl: PHISHDESTROY_LIST_URL });
    expect(r.itemsFetched).toBe(REAL_SAMPLE.length);
    expect(h.fetchedUrls).toEqual([PHISHDESTROY_LIST_URL]);
    // bind order: id, type, url, domain, ioc, severity, confidence, technique, impersonated_idp
    // enqueueAutoCaptures also binds (for new IdP-family rows); keep the threat INSERTs.
    const threatBinds = h.binds.filter((a) => a.length === 9 && String(a[0]).includes("phishdestroy"));
    expect(threatBinds).toHaveLength(REAL_SAMPLE.length);
    expect(threatBinds.some((a) => a[7] !== null)).toBe(true); // okta lures tag
    for (const args of threatBinds) {
      const domain = args[3] as string;
      const tag = tagThreat({ malicious_domain: domain, malicious_url: `https://${domain}` });
      expect(args[2]).toBe(`https://${domain}`);
      expect(args[7]).toBe(tag.technique);
      expect(args[8]).toBe(tag.impersonated_idp);
    }
  });

  it("falls back to the canonical URL when the configured source_url 404s", async () => {
    const stale = "https://raw.githubusercontent.com/phishdestroy/destroylist/main/old/list.json";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = makeHarness({ [PHISHDESTROY_LIST_URL]: { status: 200, body: REAL_SAMPLE } });
    const r = await phishdestroy.ingest({ env: h.env, feedName: "phishdestroy", feedUrl: stale });
    expect(h.fetchedUrls).toEqual([stale, PHISHDESTROY_LIST_URL]);
    expect(r.itemsFetched).toBe(REAL_SAMPLE.length);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("fails with an actionable error naming every URL when all 404", async () => {
    const stale = "https://example.invalid/list.json";
    const h = makeHarness({});
    await expect(
      phishdestroy.ingest({ env: h.env, feedName: "phishdestroy", feedUrl: stale }),
    ).rejects.toThrow(/PhishDestroy HTTP 404 .*example\.invalid.*destroylist\/main\/list\.json.*disable the feed/);
  });

  it("does not fall back on non-404 errors", async () => {
    const h = makeHarness({ [PHISHDESTROY_LIST_URL]: { status: 503 } });
    await expect(
      phishdestroy.ingest({ env: h.env, feedName: "phishdestroy", feedUrl: PHISHDESTROY_LIST_URL }),
    ).rejects.toThrow("PhishDestroy HTTP 503");
    expect(h.fetchedUrls).toHaveLength(1);
  });

  it("rotates through an alphabetically-sorted list across runs instead of re-reading the head", async () => {
    // 12,000 sorted domains; 5,000 per run.
    const list = Array.from({ length: 12_000 }, (_, i) => `d${String(i).padStart(5, "0")}.example`);
    const h = makeHarness({ [PHISHDESTROY_LIST_URL]: { status: 200, body: list } });
    const run = () => phishdestroy.ingest({ env: h.env, feedName: "phishdestroy", feedUrl: PHISHDESTROY_LIST_URL });

    await run();
    expect(h.binds[0]![3]).toBe("d00000.example");
    expect(h.kv.get(PHISHDESTROY_CURSOR_KEY)).toBe("5000");

    h.binds.length = 0;
    await run();
    expect(h.binds[0]![3]).toBe("d05000.example");
    expect(h.kv.get(PHISHDESTROY_CURSOR_KEY)).toBe("10000");

    // Third run wraps: 2,000 tail entries + 3,000 from the head.
    h.binds.length = 0;
    const r3 = await run();
    expect(r3.itemsFetched).toBe(5000);
    expect(h.binds[0]![3]).toBe("d10000.example");
    expect(h.binds[2000]![3]).toBe("d00000.example");
    expect(h.kv.get(PHISHDESTROY_CURSOR_KEY)).toBe("3000");
  });
});
