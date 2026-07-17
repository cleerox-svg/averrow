/**
 * Tests for the DNS-queue reconciler (PR-BI cursor architecture).
 *
 * The reconciler reads only threats added since the KV cursor,
 * dedupes by malicious_domain, INSERT-OR-IGNOREs them into
 * dns_queue, and advances the cursor to MAX(created_at) seen.
 *
 * What we verify here, deterministically:
 *   1. SELECT shape — INDEXED BY idx_threats_status_created,
 *      `created_at >= ?`, predicate filters, ORDER BY + LIMIT.
 *   2. Cursor bootstrap — missing KV cursor defaults to ~30 min ago.
 *   3. Cursor advance — MAX(created_at) is written back to KV.
 *   4. Empty SELECT path — cursor stays put, no batches.
 *   5. Dedupe — multiple rows with the same domain only batched once.
 *   6. Skip when DNS_QUEUE_DB binding is unset (returns skipped:true).
 *   7. KV write failure on cursor doesn't fail the reconcile —
 *      surfaced via lastError, results still returned.
 */

import { describe, it, expect, vi } from "vitest";
import { reconcileDnsQueue } from "../src/lib/dns-queue-reconciler";
import type { Env } from "../src/types";

interface CandidateRow {
  malicious_domain: string;
  source_feed: string | null;
  created_at: string;
}

interface MakeEnvOpts {
  cursor?: string | null;
  candidates?: CandidateRow[];
  queueSize?: number;
  noQueueBinding?: boolean;
  kvPutThrows?: boolean;
  batchThrows?: boolean;
}

interface CapturedSelect {
  sql: string;
  binds: unknown[];
}
interface CapturedKv {
  key: string;
  value: string;
}

function makeEnv(opts: MakeEnvOpts = {}): {
  env: Env;
  captured: {
    selects: CapturedSelect[];
    kvPuts: CapturedKv[];
    batchStatements: number;
    batches: number;
  };
} {
  const captured = {
    selects: [] as CapturedSelect[],
    kvPuts: [] as CapturedKv[],
    batchStatements: 0,
    batches: 0,
  };

  const dbPrepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      all: async <T,>() => {
        captured.selects.push({ sql, binds });
        return { results: (opts.candidates ?? []) as unknown as T[] };
      },
      first: async <T,>() => {
        captured.selects.push({ sql, binds });
        return null as unknown as T;
      },
    }),
  });

  const queueDb = {
    prepare(sql: string) {
      // COUNT(*) AS n
      if (/SELECT\s+COUNT/i.test(sql)) {
        return {
          first: async () => ({ n: opts.queueSize ?? 0 }),
        };
      }
      // INSERT OR IGNORE — only ever batched via db.batch()
      return {
        bind: (..._binds: unknown[]) => ({
          // placeholder — never directly run() in production path
        }),
      };
    },
    async batch(stmts: unknown[]) {
      captured.batches++;
      captured.batchStatements += stmts.length;
      if (opts.batchThrows) throw new Error("D1_NETWORK_ERROR");
      // Pretend every INSERT inserted 1 row
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };

  const env: Partial<Env> = {
    DB: {
      prepare: dbPrepare as unknown as Env["DB"]["prepare"],
    } as unknown as Env["DB"],
    CACHE: {
      async get(_key: string) {
        return opts.cursor === undefined ? null : opts.cursor;
      },
      async put(key: string, value: string) {
        if (opts.kvPutThrows) throw new Error("KV_WRITE_FAILED");
        captured.kvPuts.push({ key, value });
      },
    } as unknown as Env["CACHE"],
  };
  if (!opts.noQueueBinding) {
    (env as { DNS_QUEUE_DB?: unknown }).DNS_QUEUE_DB = queueDb;
  }
  return { env: env as Env, captured };
}

describe("reconcileDnsQueue", () => {
  it("returns skipped when DNS_QUEUE_DB is unbound", async () => {
    const { env } = makeEnv({ noQueueBinding: true });
    const result = await reconcileDnsQueue(env);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("binding_unset");
  });

  it("SELECT uses INDEXED BY idx_threats_status_created with >= cursor", async () => {
    const { env, captured } = makeEnv({
      cursor: "2026-05-19 10:00:00",
      candidates: [],
    });
    await reconcileDnsQueue(env);

    const sel = captured.selects.find((s) => s.sql.includes("FROM threats"));
    expect(sel).toBeDefined();
    const sql = sel!.sql;
    // Pinned plan
    expect(sql).toMatch(/INDEXED BY idx_threats_status_created/);
    // Predicate filters in the WHERE clause
    expect(sql).toMatch(/status\s*=\s*'active'/);
    expect(sql).toMatch(/created_at\s*>=\s*\?/);
    expect(sql).toMatch(/ip_address\s+IS\s+NULL/);
    expect(sql).toMatch(/malicious_domain\s+NOT\s+LIKE\s+'\*%'/);
    expect(sql).toMatch(/malicious_domain\s+LIKE\s+'%\.%'/);
    // Order + bounded read
    expect(sql).toMatch(/ORDER BY created_at/);
    expect(sql).toMatch(/LIMIT\s+\?/);
    // The cursor + limit are the bound params
    expect(sel!.binds[0]).toBe("2026-05-19 10:00:00");
    expect(sel!.binds[1]).toBe(500);
  });

  it("bootstraps cursor to ~30 min ago when KV cursor is missing", async () => {
    const { env, captured } = makeEnv({ cursor: null, candidates: [] });
    const before = Date.now();
    await reconcileDnsQueue(env);
    const sel = captured.selects.find((s) => s.sql.includes("FROM threats"))!;
    const cursorBound = sel.binds[0] as string;

    // SQLite datetime format: YYYY-MM-DD HH:MM:SS (no T, no Z)
    expect(cursorBound).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const cursorMs = Date.parse(cursorBound.replace(" ", "T") + "Z");
    const ageMin = (before - cursorMs) / 60_000;
    // Allow some clock jitter — should be in [29, 31] min
    expect(ageMin).toBeGreaterThanOrEqual(29);
    expect(ageMin).toBeLessThanOrEqual(31);
  });

  it("advances cursor to MAX(created_at) and writes it to KV", async () => {
    const { env, captured } = makeEnv({
      cursor: "2026-05-19 10:00:00",
      candidates: [
        { malicious_domain: "a.com", source_feed: "phishtank", created_at: "2026-05-19 10:01:00" },
        { malicious_domain: "b.com", source_feed: "phishtank", created_at: "2026-05-19 10:03:00" },
        { malicious_domain: "c.com", source_feed: "openphish",  created_at: "2026-05-19 10:02:00" },
      ],
    });
    const result = await reconcileDnsQueue(env);

    expect(result.skipped).toBe(false);
    expect(result.scanned).toBe(3);
    expect(result.cursorBefore).toBe("2026-05-19 10:00:00");
    expect(result.cursorAfter).toBe("2026-05-19 10:03:00");

    const cursorWrite = captured.kvPuts.find((p) => p.key === "reconciler:dns_queue:cursor");
    expect(cursorWrite).toBeDefined();
    expect(cursorWrite!.value).toBe("2026-05-19 10:03:00");
  });

  it("keeps cursor when no candidates are found in the tick", async () => {
    const { env, captured } = makeEnv({
      cursor: "2026-05-19 10:00:00",
      candidates: [],
    });
    const result = await reconcileDnsQueue(env);

    expect(result.scanned).toBe(0);
    expect(result.enqueued).toBe(0);
    // Cursor unchanged — no KV write should fire
    expect(captured.kvPuts.find((p) => p.key === "reconciler:dns_queue:cursor"))
      .toBeUndefined();
    expect(result.cursorAfter).toBe(result.cursorBefore);
    // No INSERT batches when there's nothing to enqueue
    expect(captured.batches).toBe(0);
  });

  it("dedupes duplicate malicious_domains within one tick", async () => {
    const { env, captured } = makeEnv({
      cursor: "2026-05-19 10:00:00",
      candidates: [
        { malicious_domain: "dup.com",   source_feed: "f1", created_at: "2026-05-19 10:01:00" },
        { malicious_domain: "dup.com",   source_feed: "f2", created_at: "2026-05-19 10:01:30" },
        { malicious_domain: "other.com", source_feed: "f1", created_at: "2026-05-19 10:02:00" },
      ],
    });
    const result = await reconcileDnsQueue(env);

    expect(result.scanned).toBe(3);
    // Only two distinct domains batched
    expect(captured.batchStatements).toBe(2);
    expect(result.enqueued).toBe(2);
  });

  it("surfaces KV cursor-write failures via lastError without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = makeEnv({
      cursor: "2026-05-19 10:00:00",
      candidates: [
        { malicious_domain: "x.com", source_feed: "f1", created_at: "2026-05-19 10:05:00" },
      ],
      kvPutThrows: true,
    });
    const result = await reconcileDnsQueue(env);

    expect(result.skipped).toBe(false);
    expect(result.enqueued).toBe(1);
    expect(result.lastError).toMatch(/KV_WRITE_FAILED/);
    errorSpy.mockRestore();
  });

  it("surfaces batch failures and counts them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = makeEnv({
      cursor: "2026-05-19 10:00:00",
      candidates: [
        { malicious_domain: "x.com", source_feed: "f1", created_at: "2026-05-19 10:05:00" },
      ],
      batchThrows: true,
    });
    const result = await reconcileDnsQueue(env);

    expect(result.skipped).toBe(false);
    expect(result.batchesAttempted).toBe(1);
    expect(result.batchesFailed).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.lastError).toMatch(/D1_NETWORK_ERROR/);
    errorSpy.mockRestore();
  });
});
