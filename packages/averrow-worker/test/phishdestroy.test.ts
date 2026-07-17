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
