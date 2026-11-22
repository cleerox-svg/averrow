/**
 * Feed pull finalizes vs D1's overload window (2026-11-22).
 *
 * D1 rejects every statement for the rest of a rolling 10 s window once its
 * budget is spent ("D1 DB is overloaded"). runFeed's failure finalize had no
 * retry and the success finalize retried at 50/100/200 ms (inside the
 * window), so a pull that ended during an overload stayed 'partial' and was
 * later reaped as "worker terminated" — the wrong diagnosis, with the breaker
 * penalty ~15 min late. Now every finalize (success, failure, and the
 * per-feed timeout upsert in runFeedWithTimeout) plus the breaker penalty go
 * through withD1Retry with the overload backoff (3 s / 6 s / 12 s), capped at
 * FEED_FINALIZE_RETRY_BUDGET_MS.
 *
 * Real SQLite (migration-derived feed_pull_history / feed_status /
 * feed_configs) behind a wrapper that injects D1 errors per statement, so
 * the guarded SQL itself — incl. the re-send arm — is what is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import {
  runFeed,
  dispatchDedicatedIngestFeed,
  FEED_FINALIZE_RETRY_BUDGET_MS,
  feedRunTimeoutMs,
  type FeedConfigRow,
} from "../src/lib/feedRunner";
import type { FeedModule, FeedResult } from "../src/feeds/types";
import type { Env } from "../src/types";

vi.mock("../src/lib/notifications", () => ({ createNotification: vi.fn().mockResolvedValue(1) }));

const OVERLOADED = "D1 DB is overloaded. Too many resources consumed within a 10 second window.";
const CONN_LOST = "Network connection lost.";

type Fault = "overload" | "ambiguous";

/**
 * Wrap a D1 so statements whose SQL matches `match` fail according to
 * `faults` (consumed in order, one per execution of a matching statement):
 * 'overload' = rejected, never ran; 'ambiguous' = ran, then reported an error.
 */
function faulty(inner: D1Database, match: RegExp, faults: Fault[]): { db: D1Database; attempts: () => number } {
  let attempts = 0;
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const guard = async <T>(op: () => Promise<T>): Promise<T> => {
      if (!match.test(sql.replace(/\s+/g, " "))) return op();
      attempts++;
      const f = faults.shift();
      if (f === "overload") throw new Error(OVERLOADED);
      const out = await op();
      if (f === "ambiguous") throw new Error(CONN_LOST);
      return out;
    };
    return {
      bind: (...args: unknown[]) => wrap(stmt.bind(...args), sql),
      run: () => guard(() => stmt.run()),
      first: (col?: string) => guard(() => (col ? stmt.first(col) : stmt.first())),
      all: () => guard(() => stmt.all()),
      raw: () => stmt.raw(),
    } as unknown as D1PreparedStatement;
  };
  const db = { ...inner, prepare: (sql: string) => wrap(inner.prepare(sql), sql) } as unknown as D1Database;
  return { db, attempts: () => attempts };
}

const CONFIG: FeedConfigRow = {
  feed_name: "test_feed",
  display_name: "Test feed",
  source_url: null,
  schedule_cron: "0 * * * *",
  rate_limit: 60,
  batch_size: 100,
  retry_count: 3,
  enabled: 1,
  consecutive_failure_threshold: null,
};

const OK: FeedResult = { itemsFetched: 3, itemsNew: 2, itemsDuplicate: 1, itemsError: 0 };
const failing: FeedModule = { ingest: async () => { throw new Error("upstream 500"); } };
const succeeding: FeedModule = { ingest: async () => ({ ...OK }) };
const hanging: FeedModule = { ingest: () => new Promise<FeedResult>(() => {}) };

function openDb(): SqliteDb {
  const raw = openDerivedDb(["feed_pull_history", "feed_status", "feed_configs"]);
  raw.prepare("INSERT INTO feed_status (feed_name, health_status, consecutive_failures) VALUES (?, 'degraded', 0)").run(CONFIG.feed_name);
  raw.prepare(`INSERT INTO feed_configs (feed_name, display_name, schedule_cron, enabled) VALUES (?, ?, ?, 1)`)
    .run(CONFIG.feed_name, CONFIG.display_name, CONFIG.schedule_cron);
  return raw;
}

const envOf = (db: D1Database): Env => ({ DB: db, CACHE: fakeKv() }) as unknown as Env;
const pulls = (raw: SqliteDb) =>
  raw.prepare("SELECT status, error_message, completed_at FROM feed_pull_history").all() as Array<{ status: string; error_message: string | null; completed_at: string | null }>;
const status = (raw: SqliteDb) =>
  raw.prepare("SELECT consecutive_failures, next_retry_at, last_error FROM feed_status WHERE feed_name = ?").all(CONFIG.feed_name)[0] as { consecutive_failures: number; next_retry_at: string | null; last_error: string | null };

/** Drive fake timers until `p` settles; returns elapsed fake ms. */
async function settle<T>(p: Promise<T>): Promise<{ elapsed: number; result: PromiseSettledResult<T> }> {
  const start = Date.now();
  let result: PromiseSettledResult<T> | null = null;
  p.then((value) => { result = { status: "fulfilled", value }; }, (reason: unknown) => { result = { status: "rejected", reason }; });
  while (result === null) await vi.advanceTimersByTimeAsync(250);
  return { elapsed: Date.now() - start, result };
}

describe.skipIf(!hasSqlite())("runFeed finalizes survive D1 overload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("failure finalize: rides out two overload rejections (past the 10 s window) and penalizes once", async () => {
    const raw = openDb();
    const { db, attempts } = faulty(d1FromSqlite(raw), /^UPDATE feed_pull_history SET status = 'failed'/, ["overload", "overload"]);
    const { elapsed, result } = await settle(runFeed(envOf(db), CONFIG, failing));
    expect(result.status).toBe("rejected");
    expect(String((result as PromiseRejectedResult).reason)).toContain("Feed test_feed failed: upstream 500");
    expect(attempts()).toBe(3);
    // 3 s + 6 s backoff (+ ≤ 0.75 s jitter each): past one 10 s window.
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(pulls(raw)).toEqual([{ status: "failed", error_message: "upstream 500", completed_at: expect.any(String) }]);
    expect(status(raw).consecutive_failures).toBe(1);
    expect(status(raw).next_retry_at).not.toBeNull();
  });

  it("failure finalize: a re-send after an applied-but-errored attempt still penalizes exactly once", async () => {
    const raw = openDb();
    const { db, attempts } = faulty(d1FromSqlite(raw), /^UPDATE feed_pull_history SET status = 'failed'/, ["ambiguous"]);
    const { result } = await settle(runFeed(envOf(db), CONFIG, failing));
    expect(result.status).toBe("rejected");
    expect(attempts()).toBe(2);
    expect(pulls(raw)[0]!.status).toBe("failed");
    expect(status(raw).consecutive_failures).toBe(1);
  });

  it("failure finalize: does not claim a row the timeout path / reaper already finalized", async () => {
    const raw = openDb();
    const env = envOf(d1FromSqlite(raw));
    // A module that lets the test finalize the row (as the reaper would)
    // before it throws.
    const reaped: FeedModule = {
      ingest: async () => {
        raw.prepare("UPDATE feed_pull_history SET status = 'failed', error_message = 'worker terminated', completed_at = 'x'").run();
        throw new Error("upstream 500");
      },
    };
    const { result } = await settle(runFeed(env, CONFIG, reaped));
    expect(result.status).toBe("rejected");
    expect(pulls(raw)[0]!.error_message).toBe("worker terminated");
    expect(status(raw).consecutive_failures).toBe(0);
  });

  it("breaker penalty: the feed_status UPDATE rides out an overload too", async () => {
    const raw = openDb();
    const { db, attempts } = faulty(d1FromSqlite(raw), /^UPDATE feed_status SET last_failure/, ["overload"]);
    await settle(runFeed(envOf(db), CONFIG, failing));
    expect(attempts()).toBe(2);
    expect(status(raw).consecutive_failures).toBe(1);
  });

  it("success finalize: backs off past the overload window instead of 50/100/200 ms", async () => {
    const raw = openDb();
    const { db, attempts } = faulty(d1FromSqlite(raw), /^UPDATE feed_pull_history SET status = 'success'/, ["overload", "overload", "overload"]);
    const { elapsed, result } = await settle(runFeed(envOf(db), CONFIG, succeeding));
    expect(result.status).toBe("fulfilled");
    expect(attempts()).toBe(4);
    expect(elapsed).toBeGreaterThanOrEqual(21_000); // 3 + 6 + 12 s
    expect(pulls(raw)[0]!.status).toBe("success");
  });

  it("gives up once FEED_FINALIZE_RETRY_BUDGET_MS is spent (the loop always returns)", async () => {
    const raw = openDb();
    const forever: Fault[] = Array.from({ length: 50 }, () => "overload");
    const { db } = faulty(d1FromSqlite(raw), /^UPDATE feed_pull_history SET status = 'failed'/, forever);
    const { elapsed, result } = await settle(runFeed(envOf(db), CONFIG, failing));
    expect(result.status).toBe("rejected");
    expect(String((result as PromiseRejectedResult).reason)).toContain("overloaded");
    expect(elapsed).toBeLessThanOrEqual(FEED_FINALIZE_RETRY_BUDGET_MS);
    // Left partial for the reaper, as before.
    expect(pulls(raw)[0]!.status).toBe("partial");
  });

  it("manual trigger (overloadBackoff: false) keeps the short in-request backoff", async () => {
    const raw = openDb();
    const forever: Fault[] = Array.from({ length: 50 }, () => "overload");
    const { db, attempts } = faulty(d1FromSqlite(raw), /^UPDATE feed_pull_history SET status = 'failed'/, forever);
    const { elapsed } = await settle(runFeed(envOf(db), CONFIG, failing, { overloadBackoff: false }));
    expect(attempts()).toBe(4);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("timeout finalize: the upsert rides out an overload, and the slot is held ≤ the retry budget past the timeout", async () => {
    const raw = openDb();
    const { db, attempts } = faulty(d1FromSqlite(raw), /^INSERT INTO feed_pull_history \(id, feed_name, started_at, completed_at/, ["overload", "ambiguous"]);
    const { elapsed } = await settle(dispatchDedicatedIngestFeed(envOf(db), CONFIG.feed_name, hanging));
    const timeout = feedRunTimeoutMs(CONFIG.feed_name);
    expect(attempts()).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(timeout);
    expect(elapsed).toBeLessThanOrEqual(timeout + FEED_FINALIZE_RETRY_BUDGET_MS);
    const [row] = pulls(raw);
    expect(row!.status).toBe("failed");
    expect(row!.error_message).toMatch(/^timed out after \d+s — pull abandoned$/);
    // The ambiguous attempt applied; the re-send matched it, so the penalty ran once.
    expect(status(raw).consecutive_failures).toBe(1);
  });
});
