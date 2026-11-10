/**
 * daily_snapshots — dedicated `28 0,12 * * *` cron (handlers/dailySnapshots.ts).
 *
 * Runs against a real in-memory SQLite whose schema is DERIVED from
 * migrations/ (sqlite-d1-harness), so the snapshot SQL, the per-type PK
 * probe and the agent_runs / agent_events writes all execute for real.
 *
 * Pins:
 *   1. Neither type present → both generated; run row success with
 *      completed_at + records_processed; one telemetry agent_events row
 *      (snapshots_generated, target_agent NULL).
 *   2. Both complete (the 12:28 pass) → both skipped, no INSERT … SELECT runs.
 *   3. Brand half-written, provider missing (2026-10-12 / killed-run case) →
 *      provider generated; brand resumes AFTER its last entity (existing rows
 *      untouched, the rest back-filled).
 *   4. One type failing → the other still runs; run 'partial' with
 *      error_message; all types failing → run 'failed'.
 *   5. Dispatch: exact event.cron match above the hourly-mesh guard,
 *      wrangler declares the trigger, no minute gate in the code path.
 *   6. Bounded work (2026-11-07 orphaned-run fix): keyset chunks, a
 *      records_processed heartbeat per chunk, a wall-clock budget that
 *      leaves the rest to the next pass (run 'partial', completed_at SET),
 *      and a finalize that retries a transient agent_runs failure.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";
import { runDailySnapshotsCron, DAILY_SNAPSHOTS_WRITE_RETRIES } from "../src/handlers/dailySnapshots";
import { d1RetryDelayMs, D1_OVERLOAD_RETRY_BASE_MS } from "../src/lib/d1-retry";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  type SqliteDb,
  type StatementLogEntry,
} from "./sqlite-d1-harness";

const DATE = "2026-10-12";
const AT = new Date(`${DATE}T00:28:00Z`);

const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function seed(raw: SqliteDb): void {
  raw.prepare(`INSERT INTO hosting_providers (id, name) VALUES ('p1', 'Provider One')`).run();
  const ins = raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_url, malicious_domain, target_brand_id, hosting_provider_id, status, created_at)
     VALUES (?, 'feed', 'phishing', ?, ?, ?, ?, ?, ?)`,
  );
  ins.run("t1", "https://a.test/", "a.test", "b1", "p1", "active", `${DATE} 00:05:00`);
  ins.run("t2", "https://b.test/", "b.test", "b1", "p1", "remediated", "2026-10-01 10:00:00");
  ins.run("t3", "https://c.test/", "c.test", "b2", null, "active", "2026-10-02 10:00:00");
}

function snapshotRows(raw: SqliteDb, type: string): Array<Record<string, unknown>> {
  return raw
    .prepare(`SELECT entity_id, new_threats, active_threats, remediated_threats FROM daily_snapshots WHERE date = ? AND entity_type = ? ORDER BY entity_id`)
    .all(DATE, type) as Array<Record<string, unknown>>;
}

function runs(raw: SqliteDb): Array<Record<string, unknown>> {
  return raw
    .prepare(`SELECT agent_id, status, records_processed, outputs_generated, error_message, completed_at FROM agent_runs`)
    .all() as Array<Record<string, unknown>>;
}

function events(raw: SqliteDb): Array<Record<string, unknown>> {
  return raw
    .prepare(`SELECT event_type, source_agent, target_agent, payload_json FROM agent_events`)
    .all() as Array<Record<string, unknown>>;
}

const insertSelects = (log: StatementLogEntry[], type: "brand" | "provider"): number =>
  log.filter((e) => /INSERT OR REPLACE INTO daily_snapshots/.test(e.sql) && e.sql.includes(`'${type}' AS entity_type`)).length;

/** Wrap a D1 so statements matching `failOn` throw on execution. */
function failing(db: D1Database, failOn: RegExp): D1Database {
  return {
    ...db,
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      if (!failOn.test(sql)) return stmt;
      const boom = async (): Promise<never> => {
        throw new Error("D1_ERROR: simulated CPU limit");
      };
      return { bind: () => ({ run: boom, first: boom, all: boom }), run: boom, first: boom, all: boom } as unknown as D1PreparedStatement;
    },
  } as D1Database;
}

describe.skipIf(!hasSqlite())("daily_snapshots dedicated cron", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let db: D1Database;
  let env: Env;

  beforeEach(() => {
    raw = openDerivedDb(["threats", "hosting_providers", "daily_snapshots", "agent_runs", "agent_events"]);
    log = [];
    db = d1FromSqlite(raw, { log });
    env = { DB: db } as unknown as Env;
    seed(raw);
  });

  it("generates both types when none exist, and writes agent_runs start+finish + one telemetry event", async () => {
    const result = await runDailySnapshotsCron(env, AT);

    expect(result.status).toBe("success");
    expect(result.provider).toEqual({ action: "generated", rows: 1 });
    expect(result.brand).toEqual({ action: "generated", rows: 2 });
    expect(snapshotRows(raw, "provider")).toEqual([
      { entity_id: "p1", new_threats: 1, active_threats: 1, remediated_threats: 1 },
    ]);
    expect(snapshotRows(raw, "brand")).toEqual([
      { entity_id: "b1", new_threats: 1, active_threats: 1, remediated_threats: 1 },
      { entity_id: "b2", new_threats: 0, active_threats: 1, remediated_threats: 0 },
    ]);

    const r = runs(raw);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      agent_id: "daily_snapshots",
      status: "success",
      records_processed: 3,
      outputs_generated: 2,
      error_message: null,
    });
    expect(r[0]!.completed_at).not.toBeNull();
    // started 'running' before any snapshot statement executed
    const firstRunWrite = log.findIndex((e) => /INSERT INTO agent_runs/.test(e.sql));
    const firstSnapshot = log.findIndex((e) => /INSERT OR REPLACE INTO daily_snapshots/.test(e.sql));
    expect(firstRunWrite).toBeGreaterThanOrEqual(0);
    expect(firstRunWrite).toBeLessThan(firstSnapshot);

    const ev = events(raw);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "snapshots_generated", source_agent: "daily_snapshots", target_agent: null });
    expect(JSON.parse(ev[0]!.payload_json as string)).toMatchObject({ date: DATE, trigger: "cron", status: "success" });

    // The provider-counter recount is gone (lib/provider-counts.ts owns it).
    expect(log.some((e) => /UPDATE\s+hosting_providers/i.test(e.sql))).toBe(false);
  });

  it("skips every type already present — the 12:28 pass runs no INSERT … SELECT", async () => {
    await runDailySnapshotsCron(env, AT);
    log.length = 0;

    const result = await runDailySnapshotsCron(env, new Date(`${DATE}T12:28:00Z`));

    expect(result.status).toBe("success");
    expect(result.provider).toEqual({ action: "skipped", rows: 0 });
    expect(result.brand).toEqual({ action: "skipped", rows: 0 });
    expect(insertSelects(log, "provider")).toBe(0);
    expect(insertSelects(log, "brand")).toBe(0);
    // Resume probes are PK-prefix MAX reads, never a COUNT over the day.
    const probes = log.filter((e) => /SELECT MAX\(entity_id\) AS last_id FROM daily_snapshots WHERE date = \? AND entity_type = \?/.test(e.sql));
    expect(probes).toHaveLength(2);
    expect(log.some((e) => /COUNT\(\*\)[^]*FROM daily_snapshots/i.test(e.sql))).toBe(false);
    expect(runs(raw)[1]).toMatchObject({ status: "success", records_processed: 0 });
  });

  it("generates a missing type and resumes a half-written one after its last entity", async () => {
    // b1 written by an earlier (killed) pass; b2 never reached.
    raw.prepare(
      `INSERT INTO daily_snapshots (date, entity_type, entity_id, new_threats, active_threats, remediated_threats)
       VALUES (?, 'brand', 'b1', 99, 99, 99)`,
    ).run(DATE);

    const result = await runDailySnapshotsCron(env, AT);

    expect(result.provider).toEqual({ action: "generated", rows: 1 });
    expect(result.brand).toEqual({ action: "generated", rows: 1 });
    // Existing brand row untouched; b2 back-filled.
    expect(snapshotRows(raw, "brand")).toEqual([
      { entity_id: "b1", new_threats: 99, active_threats: 99, remediated_threats: 99 },
      { entity_id: "b2", new_threats: 0, active_threats: 1, remediated_threats: 0 },
    ]);
    expect(snapshotRows(raw, "provider")).toHaveLength(1);
    expect(runs(raw)[0]).toMatchObject({ status: "success", records_processed: 2, outputs_generated: 2 });
  });

  it("a fully written type is skipped on resume — only the missing one is built", async () => {
    await runDailySnapshotsCron(env, AT);
    raw.prepare(`DELETE FROM daily_snapshots WHERE entity_type = 'provider'`).run();
    log.length = 0;

    const result = await runDailySnapshotsCron(env, new Date(`${DATE}T12:28:00Z`));

    expect(result.provider).toEqual({ action: "generated", rows: 1 });
    expect(result.brand).toEqual({ action: "skipped", rows: 0 });
    expect(insertSelects(log, "brand")).toBe(0);
  });

  it("one type failing does not stop the other: run 'partial' with error_message", async () => {
    env = { DB: failing(db, /'provider' AS entity_type/) } as unknown as Env;

    const result = await runDailySnapshotsCron(env, AT);

    expect(result.status).toBe("partial");
    expect(result.provider.action).toBe("failed");
    expect(result.brand).toEqual({ action: "generated", rows: 2 });
    expect(snapshotRows(raw, "brand")).toHaveLength(2);
    expect(snapshotRows(raw, "provider")).toHaveLength(0);
    const r = runs(raw)[0]!;
    expect(r).toMatchObject({ status: "partial", records_processed: 2 });
    expect(r.completed_at).not.toBeNull();
    expect(String(r.error_message)).toMatch(/^provider: D1_ERROR: simulated CPU limit$/);
    expect(JSON.parse(events(raw)[0]!.payload_json as string)).toMatchObject({ status: "partial" });

    // The next pass (12:28) repairs exactly the missing type.
    env = { DB: db } as unknown as Env;
    log.length = 0;
    const repair = await runDailySnapshotsCron(env, new Date(`${DATE}T12:28:00Z`));
    expect(repair.provider).toEqual({ action: "generated", rows: 1 });
    expect(repair.brand).toEqual({ action: "skipped", rows: 0 });
    expect(insertSelects(log, "brand")).toBe(0);
  });

  it("every type failing marks the run 'failed' with both errors and never throws", async () => {
    env = { DB: failing(db, /INSERT OR REPLACE INTO daily_snapshots/) } as unknown as Env;

    const result = await runDailySnapshotsCron(env, AT);

    expect(result.status).toBe("failed");
    const r = runs(raw)[0]!;
    expect(r.status).toBe("failed");
    expect(r.completed_at).not.toBeNull();
    expect(String(r.error_message)).toContain("provider: D1_ERROR");
    expect(String(r.error_message)).toContain("brand: D1_ERROR");
    expect(events(raw)).toHaveLength(1);
  });

  it("writes in bounded keyset chunks and heartbeats records_processed after each", async () => {
    const progress: unknown[] = [];
    const watched = {
      ...db,
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        if (!/SET records_processed = \? WHERE id = \? AND completed_at IS NULL/.test(sql)) return stmt;
        return {
          bind: (...args: unknown[]) => {
            progress.push(args[0]);
            return stmt.bind(...args);
          },
        } as unknown as D1PreparedStatement;
      },
    } as D1Database;
    env = { DB: watched } as unknown as Env;

    const result = await runDailySnapshotsCron(env, AT, "cron", { chunkSize: 1 });

    expect(result.status).toBe("success");
    // provider: 1 entity → 1 chunk; brand: 2 entities → 2 chunks.
    expect(insertSelects(log, "provider")).toBe(1);
    expect(insertSelects(log, "brand")).toBe(2);
    // Every snapshot statement is range-bounded, never the whole table.
    for (const e of log.filter((x) => /INSERT OR REPLACE INTO daily_snapshots/.test(x.sql))) {
      expect(e.sql).toMatch(/_id > \? AND \w+_id <= \?/);
    }
    expect(progress).toEqual([1, 2, 3]);
    expect(snapshotRows(raw, "brand")).toHaveLength(2);
    expect(runs(raw)[0]).toMatchObject({ status: "success", records_processed: 3 });
  });

  it("budget exhausted mid-type: run 'partial' with completed_at set, next pass resumes and completes", async () => {
    // Clock reads: handler start (deadline = 0 + 10), provider's two chunk
    // checks, then brand's first check lands past the deadline.
    const ticks = [0, 0, 0];
    const now = (): number => ticks.shift() ?? 100;

    const first = await runDailySnapshotsCron(env, AT, "cron", { chunkSize: 1, budgetMs: 10, now });

    // provider: chunk 1 written, next check → no bound left → complete.
    // brand: first check @100 → past the deadline before any brand chunk.
    expect(first.provider).toEqual({ action: "generated", rows: 1 });
    expect(first.brand).toEqual({ action: "incomplete", rows: 0 });
    expect(first.status).toBe("partial");
    const r = runs(raw)[0]!;
    expect(r.status).toBe("partial");
    expect(r.completed_at).not.toBeNull();
    expect(String(r.error_message)).toMatch(/^brand: budget exhausted after 0 rows/);

    const second = await runDailySnapshotsCron(env, new Date(`${DATE}T12:28:00Z`));
    expect(second.provider).toEqual({ action: "skipped", rows: 0 });
    expect(second.brand).toEqual({ action: "generated", rows: 2 });
    expect(second.status).toBe("success");
    expect(snapshotRows(raw, "brand")).toHaveLength(2);
  });

  it("a chunk failing after earlier chunks committed keeps their rows and the next pass resumes", async () => {
    let brandChunks = 0;
    const flaky = {
      ...db,
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        if (!sql.includes("'brand' AS entity_type")) return stmt;
        return {
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              run: async () => {
                brandChunks += 1;
                // Persistent from chunk 2 on: a transient error is now retried
                // (DAILY_SNAPSHOTS_WRITE_RETRIES), so it must outlast them to fail the type.
                if (brandChunks >= 2) throw new Error("D1_ERROR: Network connection lost.");
                return bound.run();
              },
            };
          },
        } as unknown as D1PreparedStatement;
      },
    } as D1Database;
    env = { DB: flaky } as unknown as Env;

    const first = await runDailySnapshotsCron(env, AT, "cron", { chunkSize: 1 });
    expect(first.brand).toEqual({ action: "failed", rows: 1, error: "D1_ERROR: Network connection lost." });
    expect(first.status).toBe("partial");
    expect(runs(raw)[0]).toMatchObject({ status: "partial", records_processed: 2 });
    expect(runs(raw)[0]!.completed_at).not.toBeNull();
    expect(snapshotRows(raw, "brand").map((x) => x.entity_id)).toEqual(["b1"]);

    env = { DB: db } as unknown as Env;
    const second = await runDailySnapshotsCron(env, new Date(`${DATE}T12:28:00Z`), "cron", { chunkSize: 1 });
    expect(second.brand).toEqual({ action: "generated", rows: 1 });
    expect(snapshotRows(raw, "brand").map((x) => x.entity_id)).toEqual(["b1", "b2"]);
  });

  it("finalize retries a transient agent_runs failure so the run never stays 'running'", async () => {
    let finalizeAttempts = 0;
    const flaky = {
      ...db,
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        if (!/completed_at = datetime\('now'\)/.test(sql)) return stmt;
        return {
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return {
              run: async () => {
                finalizeAttempts += 1;
                if (finalizeAttempts === 1) throw new Error("D1_ERROR: storage operation exceeded timeout which caused object to be reset");
                return bound.run();
              },
            };
          },
        } as unknown as D1PreparedStatement;
      },
    } as D1Database;
    env = { DB: flaky } as unknown as Env;

    const result = await runDailySnapshotsCron(env, AT, "cron", { finalizeBackoffMs: [0] });

    expect(result.status).toBe("success");
    expect(finalizeAttempts).toBe(2);
    const r = runs(raw)[0]!;
    expect(r.status).toBe("success");
    expect(r.completed_at).not.toBeNull();
    expect(events(raw)).toHaveLength(1);
  });

  // ── 2026-11-10: D1 10-second overload window ──────────────────────
  // Prod 11-08..11-10: the invocation returned, but the heartbeat, all three
  // finalize attempts (250 ms / 1 s apart) and the event write were rejected
  // with "D1 DB is overloaded" inside the window the heavy chunks had spent.
  const OVERLOAD = "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window";

  /** Statements matching `re` throw OVERLOAD on their first `n` executions. */
  function overloadFirst(base: D1Database, re: RegExp, n: number, counter: { calls: number }): D1Database {
    return {
      ...base,
      prepare: (sql: string) => {
        const stmt = base.prepare(sql);
        if (!re.test(sql)) return stmt;
        return {
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            const gate = async <T>(fn: () => Promise<T>): Promise<T> => {
              counter.calls += 1;
              if (counter.calls <= n) throw new Error(OVERLOAD);
              return fn();
            };
            return {
              run: () => gate(() => bound.run()),
              first: <T>() => gate(() => bound.first<T>()),
              all: <T>() => gate(() => bound.all<T>()),
            };
          },
        } as unknown as D1PreparedStatement;
      },
    } as D1Database;
  }

  it("finalize backoff spans D1's 10 s overload window by default", async () => {
    const { DAILY_SNAPSHOTS_FINALIZE_BACKOFF_MS } = await import("../src/handlers/dailySnapshots");
    const total = DAILY_SNAPSHOTS_FINALIZE_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(10_000);
    // Every retry after the first waits a meaningful fraction of the window.
    expect(Math.min(...DAILY_SNAPSHOTS_FINALIZE_BACKOFF_MS)).toBeGreaterThanOrEqual(2_000);
  });

  it("finalize survives three overload rejections in a row (4 attempts) — run closed, never 'running'", async () => {
    const counter = { calls: 0 };
    env = { DB: overloadFirst(db, /completed_at = datetime\('now'\)/, 3, counter) } as unknown as Env;

    const result = await runDailySnapshotsCron(env, AT, "cron", { finalizeBackoffMs: [0, 0, 0], overloadBaseMs: 1 });

    expect(result.status).toBe("success");
    expect(counter.calls).toBe(4);
    const r = runs(raw)[0]!;
    expect(r.status).toBe("success");
    expect(r.completed_at).not.toBeNull();
  });

  it("a chunk rejected by the overload window is retried, not lost — the type completes", async () => {
    const counter = { calls: 0 };
    env = { DB: overloadFirst(db, /'brand' AS entity_type/, 1, counter) } as unknown as Env;

    const result = await runDailySnapshotsCron(env, AT, "cron", { overloadBaseMs: 1, interChunkPauseMs: 0 });

    expect(result.brand).toEqual({ action: "generated", rows: 2 });
    expect(result.status).toBe("success");
    expect(counter.calls).toBe(2);
    expect(snapshotRows(raw, "brand")).toHaveLength(2);
  });

  it("the telemetry event write is retried through an overload rejection and written once", async () => {
    const counter = { calls: 0 };
    env = { DB: overloadFirst(db, /INTO agent_events/, 1, counter) } as unknown as Env;

    await runDailySnapshotsCron(env, AT, "cron", { overloadBaseMs: 1 });

    expect(counter.calls).toBe(2);
    expect(events(raw)).toHaveLength(1);
  });

  it("pauses between chunks (not before the first) on the cron path", async () => {
    const pauses: number[] = [];
    const result = await runDailySnapshotsCron(env, AT, "cron", {
      chunkSize: 1,
      interChunkPauseMs: 7,
      sleep: async (ms) => { pauses.push(ms); },
    });
    expect(result.status).toBe("success");
    // provider: 1 chunk (no pause); brand: 2 chunks (one pause between).
    expect(pauses).toEqual([7]);
  });

  it("handleScheduled routes '28 0,12 * * *' to the handler (end to end) and does not enter the mesh", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    await handleScheduled(
      { cron: "28 0,12 * * *", scheduledTime: AT.getTime(), type: "scheduled" } as unknown as ScheduledEvent,
      env,
      ctx,
    );
    expect(snapshotRows(raw, "provider")).toHaveLength(1);
    expect(snapshotRows(raw, "brand")).toHaveLength(2);
    expect(runs(raw)).toHaveLength(1);
  }, 120_000);
});

describe("daily_snapshots cron wiring", () => {
  it("exact match above the hourly-mesh guard, declared in wrangler, no minute gate", () => {
    const orch = src("../src/cron/orchestrator.ts");
    const branch = orch.indexOf("if (event.cron === '28 0,12 * * *') {");
    const meshGuard = orch.indexOf("if (event.cron !== '7 * * * *') {");
    expect(branch).toBeGreaterThan(0);
    expect(meshGuard).toBeGreaterThan(branch);
    // The old tail block (and its per-tick COUNT probe) is gone.
    expect(orch).not.toMatch(/FROM daily_snapshots/);
    expect(orch).not.toMatch(/generateDailySnapshots/);

    const toml = src("../wrangler.toml");
    const crons = /^crons\s*=\s*\[(.*)\]$/m.exec(toml)?.[1] ?? "";
    expect(crons).toContain('"28 0,12 * * *"');
    // :28 must not collide with another dedicated cron's minute.
    const minutes = [...crons.matchAll(/"(\d+) [^"]*"/g)].map((m) => m[1]);
    expect(minutes.filter((m) => m === "28")).toHaveLength(1);

    for (const f of ["../src/handlers/dailySnapshots.ts", "../src/lib/snapshots.ts"]) {
      expect(src(f)).not.toMatch(/getUTCMinutes|getMinutes|getUTCHours|minute\s*===|hour\s*===/);
    }
  });
});

describe("daily_snapshots write retries", () => {
  it("chunk + event overload retries wait past D1's 10-second window (same as finalize)", () => {
    // Minimum (zero-jitter) total wait before the last attempt.
    let waited = 0;
    for (let i = 0; i < DAILY_SNAPSHOTS_WRITE_RETRIES; i++) {
      waited += d1RetryDelayMs(i, "D1 DB is overloaded. Requests queued for too long.", { overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS }, () => 0);
    }
    expect(DAILY_SNAPSHOTS_WRITE_RETRIES).toBe(3);
    expect(waited).toBeGreaterThan(10_000);
  });
});
