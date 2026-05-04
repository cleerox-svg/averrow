/**
 * Tests for dns-backfill — focused on the 2026-05-04 pre-stamp claim
 * refactor.
 *
 * Why pre-stamp: 90%+ of navigator ticks were producing
 * `records_processed = 0` because the soft-cap fired during DoH
 * resolution and the stamping step never ran. With the cooldown gate
 * stuck at the previous tick's value, the SAME 200 domains kept
 * re-selecting forever — no progress on the 34K-domain pile.
 *
 * The fix: stamp `attempted_resolve_at = now` BEFORE running
 * resolution. Cooldown advances atomically; resolution outcome
 * (resolved / dead / transient) only affects the attempts counter
 * and ip_address. Even if the soft-cap kills us mid-resolution,
 * we won't re-select the same batch on the next tick.
 *
 * These tests verify:
 *   1. The pre-stamp UPDATE fires before any resolveDomain call.
 *   2. A pre-stamp DB failure short-circuits the run cleanly
 *      (rather than running unclaimed resolution).
 *   3. Step 3a graduates dead domains via attempts=8 only
 *      (no double-stamp of attempted_resolve_at).
 *   4. Step 3b's transient-bump UPDATE includes the cap=8 guard
 *      so domains can't go past attempts=8.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runDomainGeoBackfillBatch } from "../src/lib/dns-backfill";
import * as resolverModule from "../src/lib/domain-resolver";
import type { Env } from "../src/types";

interface CapturedRun {
  sql: string;
  bindArgs: unknown[];
  order: number;
  ts: number;
}

let runOrder = 0;
function makeEnv(opts: {
  selectDomains?: string[];
  preStampThrows?: boolean;
}) {
  runOrder = 0;
  const calls: CapturedRun[] = [];
  const selectDomains = opts.selectDomains ?? ["a.test", "b.test", "c.test"];

  const prepare = (sql: string) => ({
    bind: (...bindArgs: unknown[]) => ({
      run: async () => {
        if (opts.preStampThrows && /UPDATE threats[\s\S]*SET attempted_resolve_at = datetime\('now'\)\s*WHERE malicious_domain IN/.test(sql) && !/enrichment_attempts/.test(sql)) {
          throw new Error("simulated pre-stamp D1 failure");
        }
        calls.push({ sql, bindArgs, order: runOrder++, ts: Date.now() });
        return { success: true, meta: { changes: bindArgs.length } };
      },
      all: async () => ({
        results: selectDomains.map((d) => ({ malicious_domain: d })),
      }),
    }),
    // Some places call .all() without bind (not used by dns-backfill, but safe).
    all: async () => ({ results: [] }),
  });

  const env = {
    DB: {
      prepare,
      async batch(stmts: unknown[]) {
        calls.push({ sql: "BATCH", bindArgs: [stmts.length], order: runOrder++, ts: Date.now() });
        return stmts.map(() => ({ success: true, meta: { changes: 1 } }));
      },
    },
  } as unknown as Env;

  return { env, calls };
}

describe("dns-backfill pre-stamp claim", () => {
  beforeEach(() => {
    // Default: every domain returns 'transient' so we exercise the
    // transient-bump path. Individual tests override this.
    vi.spyOn(resolverModule, "resolveDomain").mockResolvedValue({ kind: "transient" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("issues the pre-stamp UPDATE before any resolveDomain call", async () => {
    const calledAtRunOrder: number[] = [];
    vi.spyOn(resolverModule, "resolveDomain").mockImplementation(async () => {
      calledAtRunOrder.push(runOrder); // captures whatever runOrder is when DoH fires
      return { kind: "transient" };
    });

    const { env, calls } = makeEnv({ selectDomains: ["a.test", "b.test"] });
    await runDomainGeoBackfillBatch(env, { batchSize: 2, timeoutMs: 30_000 });

    // Find the pre-stamp UPDATE — distinguished by setting only
    // attempted_resolve_at (no enrichment_attempts).
    const preStampIdx = calls.findIndex((c) =>
      /UPDATE threats[\s\S]*SET attempted_resolve_at = datetime\('now'\)\s*WHERE malicious_domain IN/.test(c.sql) &&
      !/enrichment_attempts/.test(c.sql),
    );
    expect(preStampIdx).toBeGreaterThanOrEqual(0);

    // Every resolveDomain call must have happened AFTER the pre-stamp.
    expect(calledAtRunOrder.length).toBeGreaterThan(0);
    for (const order of calledAtRunOrder) {
      expect(order).toBeGreaterThan(calls[preStampIdx]!.order);
    }
  });

  it("short-circuits cleanly when the pre-stamp fails (no resolution attempted)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolveSpy = vi.spyOn(resolverModule, "resolveDomain");
    const { env } = makeEnv({ selectDomains: ["a.test"], preStampThrows: true });

    const result = await runDomainGeoBackfillBatch(env, { batchSize: 1, timeoutMs: 30_000 });

    expect(result.processed).toBe(0);
    expect(result.resolved).toBe(0);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pre-stamp claim failed"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("graduates confirmed-dead domains via attempts=8 without double-stamping", async () => {
    vi.spyOn(resolverModule, "resolveDomain").mockResolvedValue({ kind: "nxdomain" });
    const { env, calls } = makeEnv({ selectDomains: ["dead.test"] });
    await runDomainGeoBackfillBatch(env, { batchSize: 1, timeoutMs: 30_000 });

    // Step 3a updates: must set enrichment_attempts=8, must NOT touch attempted_resolve_at again.
    const grad = calls.find((c) =>
      /UPDATE threats[\s\S]*SET enrichment_attempts = 8/.test(c.sql),
    );
    expect(grad).toBeDefined();
    expect(grad!.sql).not.toMatch(/attempted_resolve_at/);
  });

  it("chunks the pre-stamp UPDATE to stay under D1's max-SQL-variables limit", async () => {
    // Live D1 probe (2026-05-04) rejects 200 placeholders with
    // `too many SQL variables`. With the default batchSize=200 the
    // unchunked pre-stamp threw on every navigator tick, returning
    // empty without resolving anything. Chunk size 50 mirrors the
    // existing Step 3a/3b chunks.
    const domains = Array.from({ length: 200 }, (_, i) => `d${i}.test`);
    vi.spyOn(resolverModule, "resolveDomain").mockResolvedValue({ kind: "transient" });

    const { env, calls } = makeEnv({ selectDomains: domains });
    await runDomainGeoBackfillBatch(env, { batchSize: 200, timeoutMs: 30_000 });

    // Find every pre-stamp UPDATE (the one that sets only attempted_resolve_at,
    // no enrichment_attempts).
    const preStamps = calls.filter((c) =>
      /UPDATE threats[\s\S]*SET attempted_resolve_at = datetime\('now'\)\s*WHERE malicious_domain IN/.test(c.sql) &&
      !/enrichment_attempts/.test(c.sql),
    );

    // 200 / 50 = 4 chunks. No chunk binds more than 50 variables.
    expect(preStamps.length).toBe(4);
    for (const c of preStamps) {
      expect(c.bindArgs.length).toBeLessThanOrEqual(50);
      expect(c.bindArgs.length).toBeGreaterThan(0);
    }
  });

  it("guards the transient-bump against exceeding the cap", async () => {
    vi.spyOn(resolverModule, "resolveDomain").mockResolvedValue({ kind: "transient" });
    const { env, calls } = makeEnv({ selectDomains: ["t.test"] });
    await runDomainGeoBackfillBatch(env, { batchSize: 1, timeoutMs: 30_000 });

    const bump = calls.find((c) =>
      /UPDATE threats[\s\S]*SET enrichment_attempts = COALESCE\(enrichment_attempts, 0\) \+ 1/.test(c.sql),
    );
    expect(bump).toBeDefined();
    // Cap guard prevents 8 → 9 drift on retry storms.
    expect(bump!.sql).toMatch(/COALESCE\(enrichment_attempts, 0\) < 8/);
    // No re-stamp of attempted_resolve_at — Step 0 owns that.
    expect(bump!.sql).not.toMatch(/SET[\s\S]*attempted_resolve_at/);
  });
});
