/**
 * Unit tests for lib/provider-trends.updateProviderTrends().
 *
 * The function drives the dominant per-row UPDATE pattern on
 * hosting_providers (~20K writes/day pre-2026-05-20). The diff
 * filter is the whole point — we need to assert that providers
 * whose trend_7d/trend_30d already match are SKIPPED, and only
 * the actual changes go through to env.DB.batch().
 */

import { describe, it, expect, vi } from "vitest";
import { updateProviderTrends } from "../src/lib/provider-trends";

interface AggRow {
  hosting_provider_id: string;
  count_7d: number;
  count_30d: number;
}
interface CurRow {
  id: string;
  trend_7d: number | null;
  trend_30d: number | null;
}

function makeDb(opts: {
  agg: AggRow[];
  current: CurRow[];
}) {
  const batchCalls: Array<{ sql: string; binds: unknown[] }> = [];
  let aggCount = 0;
  let readCount = 0;

  const aggSqlRe = /threat_cube_provider/;
  const currentSqlRe = /SELECT id, trend_7d, trend_30d FROM hosting_providers WHERE id IN/;

  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      all: async () => {
        if (aggSqlRe.test(sql)) {
          aggCount++;
          return { results: opts.agg };
        }
        if (currentSqlRe.test(sql)) {
          readCount++;
          const wanted = new Set(binds as string[]);
          return { results: opts.current.filter((r) => wanted.has(r.id)) };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
      run: async () => ({ success: true }),
    }),
    // The aggregate has no parameters.
    all: async () => {
      if (aggSqlRe.test(sql)) {
        aggCount++;
        return { results: opts.agg };
      }
      throw new Error(`unexpected SQL (no-bind path): ${sql}`);
    },
  });

  const batch = async (stmts: unknown[]) => {
    // Record each statement's SQL+binds from the underlying prepare/bind
    // chain we faked. The helper only constructs statements through the
    // same prepare path, so we shim a separate prepare here that captures.
    return Array(stmts.length).fill({ success: true });
  };

  return {
    db: { prepare, batch } as unknown as D1Database,
    counters: () => ({ aggCount, readCount, batchCalls }),
  };
}

// Cleaner test approach — record UPDATEs via a prepare wrapper that
// builds capturing statement objects. The version above tracks reads.
function makeRecordingDb(opts: { agg: AggRow[]; current: CurRow[] }) {
  const updateBinds: Array<unknown[]> = [];
  const batches: number[] = [];

  const aggSqlRe = /threat_cube_provider/;
  const currentSqlRe = /SELECT id, trend_7d, trend_30d FROM hosting_providers WHERE id IN/;
  const updateSqlRe = /UPDATE hosting_providers SET\s+trend_7d = \?,\s+trend_30d = \?\s+WHERE id = \?/;

  const prepare = (sql: string) => {
    const isAgg = aggSqlRe.test(sql);
    const isCurrent = currentSqlRe.test(sql);
    const isUpdate = updateSqlRe.test(sql);

    const stmt = {
      _sql: sql,
      _binds: [] as unknown[],
      bind(...binds: unknown[]) {
        stmt._binds = binds;
        return stmt;
      },
      async all() {
        if (isAgg) return { results: opts.agg };
        if (isCurrent) {
          const wanted = new Set(stmt._binds as string[]);
          return { results: opts.current.filter((r) => wanted.has(r.id)) };
        }
        throw new Error(`unexpected all() SQL: ${sql}`);
      },
      async run() {
        if (isUpdate) {
          updateBinds.push(stmt._binds);
        }
        return { success: true };
      },
    };
    return stmt;
  };

  const batch = async (stmts: Array<{ _sql: string; _binds: unknown[] }>) => {
    batches.push(stmts.length);
    for (const s of stmts) {
      if (updateSqlRe.test(s._sql)) {
        updateBinds.push(s._binds);
      }
    }
    return Array(stmts.length).fill({ success: true });
  };

  return {
    db: { prepare, batch } as unknown as D1Database,
    updateBinds,
    batches,
  };
}

describe("updateProviderTrends — diff filter", () => {
  it("skips providers whose trend_7d AND trend_30d both match current", async () => {
    const { db, updateBinds } = makeRecordingDb({
      agg: [
        { hosting_provider_id: "p1", count_7d: 10, count_30d: 50 },
        { hosting_provider_id: "p2", count_7d: 5, count_30d: 22 },
      ],
      current: [
        { id: "p1", trend_7d: 10, trend_30d: 50 }, // matches → skip
        { id: "p2", trend_7d: 5, trend_30d: 22 }, // matches → skip
      ],
    });

    const result = await updateProviderTrends(db);
    expect(result.providers_evaluated).toBe(2);
    expect(result.providers_updated).toBe(0);
    expect(updateBinds).toHaveLength(0);
  });

  it("writes only the providers whose trend values actually changed", async () => {
    const { db, updateBinds } = makeRecordingDb({
      agg: [
        { hosting_provider_id: "p1", count_7d: 10, count_30d: 50 }, // unchanged
        { hosting_provider_id: "p2", count_7d: 7, count_30d: 22 }, // 7d changed
        { hosting_provider_id: "p3", count_7d: 5, count_30d: 99 }, // 30d changed
        { hosting_provider_id: "p4", count_7d: 1, count_30d: 2 }, // both changed
      ],
      current: [
        { id: "p1", trend_7d: 10, trend_30d: 50 },
        { id: "p2", trend_7d: 5, trend_30d: 22 },
        { id: "p3", trend_7d: 5, trend_30d: 50 },
        { id: "p4", trend_7d: 99, trend_30d: 99 },
      ],
    });

    const result = await updateProviderTrends(db);
    expect(result.providers_evaluated).toBe(4);
    expect(result.providers_updated).toBe(3);

    const ids = updateBinds.map((b) => b[2]);
    expect(ids).toContain("p2");
    expect(ids).toContain("p3");
    expect(ids).toContain("p4");
    expect(ids).not.toContain("p1");
  });

  it("treats null/missing current as 'must write' (new provider)", async () => {
    const { db, updateBinds } = makeRecordingDb({
      agg: [
        { hosting_provider_id: "p_new", count_7d: 3, count_30d: 7 },
        { hosting_provider_id: "p_existing", count_7d: 0, count_30d: 0 },
      ],
      // p_existing has both NULL → coerced to 0 → matches count_*=0 → skip
      // p_new has no row at all → must write
      current: [
        { id: "p_existing", trend_7d: null, trend_30d: null },
      ],
    });

    const result = await updateProviderTrends(db);
    expect(result.providers_updated).toBe(1);
    expect(updateBinds[0][2]).toBe("p_new");
  });

  it("empty cube → 0 writes, no read fan-out", async () => {
    const { db, updateBinds, batches } = makeRecordingDb({
      agg: [],
      current: [],
    });
    const result = await updateProviderTrends(db);
    expect(result.providers_evaluated).toBe(0);
    expect(result.providers_updated).toBe(0);
    expect(updateBinds).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });
});
