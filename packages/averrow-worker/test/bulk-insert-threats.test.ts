/**
 * Tests for bulkInsertThreats — the shared chunked-batch insert helper
 * that replaces the per-row isDuplicate/insert/markSeen loop (the
 * worker-reap pattern). Covers chunking, new-vs-duplicate accounting via
 * meta.changes, and failing-chunk isolation.
 */

import { describe, it, expect, vi } from "vitest";
import { bulkInsertThreats, THREAT_INSERT_CHUNK } from "../src/lib/feedRunner";
import type { ThreatRow } from "../src/feeds/types";
import type { D1Database } from "@cloudflare/workers-types";

function makeRows(n: number): ThreatRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    source_feed: "test",
    threat_type: "phishing" as const,
    malicious_url: null,
    malicious_domain: `d${i}.com`,
    ioc_value: `d${i}.com`,
    severity: "medium" as const,
    confidence_score: 70,
  }));
}

/** db mock: records batch sizes; `newRatio` sets how many per chunk report changes=1; `failAt` throws on that chunk index. */
function makeDb(opts?: { newRatio?: number; failAt?: number }): { db: D1Database; batchSizes: number[] } {
  const batchSizes: number[] = [];
  const newRatio = opts?.newRatio ?? 1;
  let idx = 0;
  const db = {
    prepare() {
      return { bind() { return { __stmt: true }; } };
    },
    async batch(stmts: unknown[]) {
      const i = idx++;
      if (opts?.failAt === i) throw new Error(`simulated batch failure @ ${i}`);
      batchSizes.push(stmts.length);
      const newCount = Math.floor(stmts.length * newRatio);
      return stmts.map((_, k) => ({ meta: { changes: k < newCount ? 1 : 0 } }));
    },
  } as unknown as D1Database;
  return { db, batchSizes };
}

describe("bulkInsertThreats", () => {
  it("returns zeros and issues no batch for an empty input", async () => {
    const { db, batchSizes } = makeDb();
    const r = await bulkInsertThreats(db, []);
    expect(r).toEqual({ itemsNew: 0, itemsDuplicate: 0, itemsError: 0 });
    expect(batchSizes).toEqual([]);
  });

  it("chunks at THREAT_INSERT_CHUNK (50) by default", async () => {
    const { db, batchSizes } = makeDb();
    await bulkInsertThreats(db, makeRows(125));
    expect(THREAT_INSERT_CHUNK).toBe(50);
    expect(batchSizes).toEqual([50, 50, 25]);
  });

  it("counts meta.changes=1 as new and 0 as duplicate", async () => {
    const { db } = makeDb({ newRatio: 0.6 }); // 30 new + 20 dup per chunk of 50
    const r = await bulkInsertThreats(db, makeRows(100));
    expect(r.itemsNew).toBe(60);
    expect(r.itemsDuplicate).toBe(40);
    expect(r.itemsError).toBe(0);
  });

  it("isolates a failing chunk as errors without aborting the run", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb({ failAt: 1 }); // second chunk throws
    const r = await bulkInsertThreats(db, makeRows(100)); // 2 chunks of 50
    expect(r.itemsError).toBe(50);
    expect(r.itemsNew).toBe(50);
    expect(r.itemsNew + r.itemsDuplicate + r.itemsError).toBe(100);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("keeps accounting exact when duplicates AND a failing chunk coexist", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb({ newRatio: 0.6, failAt: 1 }); // chunk0: 30 new/20 dup; chunk1 throws (50 err)
    const r = await bulkInsertThreats(db, makeRows(100)); // 2 chunks of 50
    expect(r.itemsNew).toBe(30);
    expect(r.itemsError).toBe(50);
    expect(r.itemsDuplicate).toBe(20); // residual = 100 - 30 - 50
    expect(r.itemsNew + r.itemsDuplicate + r.itemsError).toBe(100);
    errSpy.mockRestore();
  });

  it("honors a custom chunk size", async () => {
    const { db, batchSizes } = makeDb();
    await bulkInsertThreats(db, makeRows(10), 4);
    expect(batchSizes).toEqual([4, 4, 2]);
  });
});
