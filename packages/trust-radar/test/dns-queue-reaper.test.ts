/**
 * Tests for the DNS-queue reaper (PR-BI).
 *
 * The reaper sweeps stale rows from dns_queue — rows whose underlying
 * threat flipped to inactive after the reconciler enqueued them. It
 * runs once per day (gated on hour===0 inside Navigator).
 *
 * What we verify here:
 *   1. Returns skipped when DNS_QUEUE_DB is unbound.
 *   2. Empty queue → no work, no errors.
 *   3. Predicate parity — the threats existence-check uses EXACTLY the
 *      same candidate predicate the reconciler does. Otherwise the
 *      reaper would delete domains that the next reconciler tick is
 *      about to re-enqueue (oscillation).
 *   4. Stale = queue MINUS still-candidate. Only stale rows get DELETEd.
 *   5. On a threats-existence-check failure, the affected chunk is
 *      treated as ALL-candidate (no over-deletion under partial failure).
 *   6. KV stamps (reaper_last_run, reaper_last_delta) are written.
 */

import { describe, it, expect, vi } from "vitest";
import { reapDnsQueue } from "../src/lib/dns-queue-reaper";
import type { Env } from "../src/types";

interface MakeEnvOpts {
  queueDomains?: string[]; // under-cap rows (enrichment_attempts 0)
  exhaustedDomains?: string[]; // capped rows (enrichment_attempts 8)
  threatsAlive?: string[]; // subset of queueDomains still candidates
  noQueueBinding?: boolean;
  existenceThrows?: boolean;
  deleteChanges?: number;
}

interface Captured {
  selects: { sql: string; binds: unknown[] }[];
  marks: { sql: string; binds: unknown[] }[];
  deletes: { sql: string; binds: unknown[] }[];
  kvPuts: { key: string; value: string }[];
}

function makeEnv(opts: MakeEnvOpts = {}): { env: Env; captured: Captured } {
  const captured: Captured = { selects: [], marks: [], deletes: [], kvPuts: [] };

  const queueDb = {
    prepare(sql: string) {
      if (/SELECT[\s\S]*FROM\s+dns_queue/i.test(sql)) {
        return {
          all: async () => ({
            results: [
              ...(opts.queueDomains ?? []).map((d) => ({ malicious_domain: d, enrichment_attempts: 0 })),
              ...(opts.exhaustedDomains ?? []).map((d) => ({ malicious_domain: d, enrichment_attempts: 8 })),
            ],
          }),
        };
      }
      if (/DELETE\s+FROM\s+dns_queue/i.test(sql)) {
        return {
          bind: (...binds: unknown[]) => ({
            run: async () => {
              captured.deletes.push({ sql, binds });
              return { success: true, meta: { changes: opts.deleteChanges ?? binds.length } };
            },
          }),
        };
      }
      throw new Error(`unexpected queue SQL: ${sql}`);
    },
  };

  const env: Partial<Env> = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (...binds: unknown[]) => ({
            all: async () => {
              captured.selects.push({ sql, binds });
              if (opts.existenceThrows) {
                throw new Error("D1_TIMEOUT");
              }
              const alive = new Set(opts.threatsAlive ?? []);
              const here = (binds as string[]).filter((d) => alive.has(d));
              return { results: here.map((d) => ({ malicious_domain: d })) };
            },
            run: async () => {
              // The exhausted-mark UPDATE on threats.
              captured.marks.push({ sql, binds });
              return { success: true, meta: { changes: binds.length } };
            },
          }),
        };
      },
    } as unknown as Env["DB"],
    CACHE: {
      async get(_key: string) {
        return null;
      },
      async put(key: string, value: string) {
        captured.kvPuts.push({ key, value });
      },
    } as unknown as Env["CACHE"],
  };
  if (!opts.noQueueBinding) {
    (env as { DNS_QUEUE_DB?: unknown }).DNS_QUEUE_DB = queueDb;
  }
  return { env: env as Env, captured };
}

describe("reapDnsQueue", () => {
  it("returns skipped when DNS_QUEUE_DB is unbound", async () => {
    const { env } = makeEnv({ noQueueBinding: true });
    const result = await reapDnsQueue(env);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("binding_unset");
  });

  it("no-ops cleanly on an empty queue", async () => {
    const { env, captured } = makeEnv({ queueDomains: [] });
    const result = await reapDnsQueue(env);
    expect(result.skipped).toBe(false);
    expect(result.scanned).toBe(0);
    expect(result.staleRemoved).toBe(0);
    expect(captured.deletes).toHaveLength(0);
  });

  it("threats existence-check predicate matches the reconciler", async () => {
    const { env, captured } = makeEnv({
      queueDomains: ["a.com"],
      threatsAlive: ["a.com"],
    });
    await reapDnsQueue(env);

    expect(captured.selects).toHaveLength(1);
    const sql = captured.selects[0]!.sql;
    // Same predicate the reconciler uses — without this, oscillation:
    // reaper deletes a domain → reconciler re-enqueues it → repeat.
    expect(sql).toMatch(/FROM\s+threats/);
    expect(sql).toMatch(/INDEXED BY idx_threats_unresolved_domain/);
    expect(sql).toMatch(/status\s*=\s*'active'/);
    expect(sql).toMatch(/ip_address\s+IS\s+NULL/);
    expect(sql).toMatch(/malicious_domain\s+NOT\s+LIKE\s+'\*%'/);
    expect(sql).toMatch(/malicious_domain\s+LIKE\s+'%\.%'/);
  });

  it("DELETEs only stale rows; preserves still-candidate rows", async () => {
    const { env, captured } = makeEnv({
      queueDomains: ["alive1.com", "stale1.com", "alive2.com", "stale2.com"],
      threatsAlive: ["alive1.com", "alive2.com"],
    });
    const result = await reapDnsQueue(env);

    expect(result.scanned).toBe(4);
    expect(result.candidatesInThreats).toBe(2);
    expect(result.staleRemoved).toBe(2);
    expect(result.delta).toBe(-2);

    expect(captured.deletes).toHaveLength(1);
    const deletedDomains = captured.deletes[0]!.binds as string[];
    expect(new Set(deletedDomains)).toEqual(new Set(["stale1.com", "stale2.com"]));
  });

  it("falls back to 'all-candidate' on a failed existence-check chunk", async () => {
    // If the threats SELECT throws, we conservatively treat every
    // domain in that chunk as still-candidate. Prevents accidental
    // mass-deletion when the existence query is broken.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, captured } = makeEnv({
      queueDomains: ["a.com", "b.com", "c.com"],
      threatsAlive: [],
      existenceThrows: true,
    });
    const result = await reapDnsQueue(env);

    expect(result.batchesFailed).toBeGreaterThan(0);
    expect(result.staleRemoved).toBe(0);
    expect(captured.deletes).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("marks exhausted (attempts>=8) threats and deletes their queue rows", async () => {
    // The pre-0209 backlog: rows capped at 8 attempts that never resolved.
    // The reaper stamps dns_exhausted_at on their threats (so they leave
    // the candidate set) and removes the queue rows — without touching the
    // under-cap rows' existence check.
    const { env, captured } = makeEnv({
      queueDomains: ["alive.com"],
      threatsAlive: ["alive.com"],
      exhaustedDomains: ["dead1.com", "dead2.com"],
    });
    const result = await reapDnsQueue(env);

    expect(result.scanned).toBe(3);
    expect(result.exhaustedMarked).toBe(2);
    // alive.com is still a candidate → not deleted; the two exhausted
    // rows are deleted.
    const deleted = new Set(captured.deletes.flatMap((d) => d.binds as string[]));
    expect(deleted).toEqual(new Set(["dead1.com", "dead2.com"]));
    // The mark UPDATE targeted the exhausted domains and stamps dns_exhausted_at.
    expect(captured.marks).toHaveLength(1);
    expect(captured.marks[0]!.sql).toMatch(/dns_exhausted_at\s*=\s*datetime\('now'\)/);
    expect(new Set(captured.marks[0]!.binds as string[])).toEqual(
      new Set(["dead1.com", "dead2.com"]),
    );
  });

  it("writes KV stamps after a successful run", async () => {
    const { env, captured } = makeEnv({
      queueDomains: ["a.com", "b.com"],
      threatsAlive: ["a.com"],
    });
    await reapDnsQueue(env);

    const lastRun = captured.kvPuts.find((p) => p.key === "reconciler:dns_queue:reaper_last_run");
    const lastDelta = captured.kvPuts.find((p) => p.key === "reconciler:dns_queue:reaper_last_delta");
    expect(lastRun).toBeDefined();
    expect(lastDelta).toBeDefined();
    // last_run is an ISO-8601 timestamp
    expect(lastRun!.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(lastDelta!.value).toBe("1");
  });
});
