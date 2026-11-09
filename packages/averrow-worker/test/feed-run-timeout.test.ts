/**
 * Per-feed wall-clock timeout in runAllFeeds (2026-11-09 incident:
 * nrd_hagezi / cloudflare_scanner pulls that never settled held a pool
 * slot — and the whole hourly ingest — until the invocation died).
 *
 * Covers:
 *   1. A hanging feed is abandoned at its timeout, its slot is freed and
 *      the feeds queued behind it still run.
 *   2. The abandoned row ends `failed` with the timeout error and the
 *      breaker is advanced (consecutive_failures + next_retry_at).
 *   3. A late completion does not overwrite the row or reset the breaker.
 *   4. A late rejection does not overwrite the row, does not penalize a
 *      second time, and is not an unhandled rejection.
 *   5. Per-feed overrides, longest-first dispatch, the pool deadline
 *      (clipped feed: no penalty) and deferral once the budget is spent.
 *   6. #1934 review follow-ups: penalizing a feed with no feed_status row,
 *      penalizing a clipped timeout that follows a timeout, the clip
 *      tolerance (incl. a real advancing clock), and the social loop's
 *      per-pull cap + deadline.
 *
 * Drives runAllFeeds through a stateful mock D1 that models
 * feed_pull_history rows (incl. the guarded UPDATEs + the timeout upsert)
 * and reports meta.changes like real D1. Fake timers throughout, except
 * the clip-tolerance test that needs a real advancing clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runAllFeeds,
  runAllEnrichmentFeeds,
  runAllSocialFeeds,
  plannedFeedTimeout,
  hangEvidenceMinMs,
  FEED_TIMEOUT_CLIP_TOLERANCE_MS,
  FEED_POOL_MIN_START_MS,
  SOCIAL_LOOP_BUDGET_MS,
  enrichmentDeadlineForTick,
  ENRICHMENT_LOOP_BUDGET_MS,
  ENRICHMENT_TICK_DEADLINE_MS,
  feedRunTimeoutMs,
  FEED_RUN_TIMEOUT_MS,
  FEED_RUN_TIMEOUT_OVERRIDES_MS,
  FEED_POOL_BUDGET_MS,
} from "../src/lib/feedRunner";
import type { FeedModule, FeedResult } from "../src/feeds/types";
import type { Env } from "../src/types";

const createNotificationMock = vi.fn().mockResolvedValue(1);
vi.mock("../src/lib/notifications", () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
}));

// ─── Stateful mock D1 ────────────────────────────────────────────

interface PullRow {
  id: string;
  feed_name: string;
  status: "partial" | "success" | "failed";
  completed_at: string | null;
  error_message: string | null;
  duration_ms: number | null;
}

interface StatusRow {
  feed_name: string;
  health_status: string;
  consecutive_failures: number;
  next_retry_at: string | null;
  last_error: string | null;
  last_successful_pull: string | null;
}

interface State {
  configs: string[];
  pulls: Map<string, PullRow>;
  status: Map<string, StatusRow>;
  /** feed_name of each runFeed INSERT, in order. */
  inserts: string[];
}

function makeState(feeds: string[]): State {
  const status = new Map<string, StatusRow>();
  for (const f of feeds) {
    status.set(f, {
      feed_name: f,
      health_status: "degraded", // not 'healthy' → no transition notification
      consecutive_failures: 0,
      next_retry_at: null,
      last_error: null,
      last_successful_pull: null, // never succeeded → always due
    });
  }
  return { configs: feeds, pulls: new Map(), status, inserts: [] };
}

function exec(state: State, sql: string, args: unknown[]): { changes: number } {
  const s = sql.replace(/\s+/g, " ").trim();

  if (s.startsWith("INSERT INTO feed_pull_history (id, feed_name, started_at, status) VALUES")) {
    const id = String(args[0]);
    if (state.pulls.has(id)) throw new Error("UNIQUE constraint failed: feed_pull_history.id");
    state.inserts.push(String(args[1]));
    state.pulls.set(id, { id, feed_name: String(args[1]), status: "partial", completed_at: null, error_message: null, duration_ms: null });
    return { changes: 1 };
  }
  if (s.startsWith("INSERT INTO feed_pull_history (id, feed_name, started_at, completed_at, duration_ms, status, error_message)")) {
    // Timeout upsert: insert or update only while partial + not completed.
    const [id, feed, , duration, err] = args as [string, string, string, number, string];
    const row = state.pulls.get(id);
    if (!row) {
      state.pulls.set(id, { id, feed_name: feed, status: "failed", completed_at: "now", error_message: err, duration_ms: duration });
      return { changes: 1 };
    }
    if (row.status === "partial" && row.completed_at === null) {
      Object.assign(row, { status: "failed", completed_at: "now", error_message: err, duration_ms: duration });
      return { changes: 1 };
    }
    return { changes: 0 };
  }
  if (s.startsWith("UPDATE feed_pull_history SET status = 'success'")) {
    expect(s).toContain("AND status <> 'failed'");
    const row = state.pulls.get(String(args[4]));
    if (!row || row.status === "failed") return { changes: 0 };
    Object.assign(row, { status: "success", completed_at: "now", duration_ms: args[3] as number });
    return { changes: 1 };
  }
  if (s.startsWith("UPDATE feed_pull_history SET status = 'failed'")) {
    expect(s).toContain("AND status = 'partial'");
    const row = state.pulls.get(String(args[2]));
    if (!row || row.status !== "partial") return { changes: 0 };
    Object.assign(row, { status: "failed", completed_at: "now", error_message: String(args[0]), duration_ms: args[1] as number });
    return { changes: 1 };
  }
  if (s.startsWith("INSERT OR IGNORE INTO feed_status")) {
    const feed = String(args[0]);
    if (state.status.has(feed)) return { changes: 0 };
    state.status.set(feed, {
      feed_name: feed, health_status: "healthy", consecutive_failures: 0,
      next_retry_at: null, last_error: null, last_successful_pull: null,
    });
    return { changes: 1 };
  }
  if (s.startsWith("UPDATE feed_status SET last_failure")) {
    const row = state.status.get(String(args[3]));
    if (!row) return { changes: 0 };
    Object.assign(row, {
      health_status: "degraded",
      last_error: String(args[0]),
      consecutive_failures: args[1] as number,
      next_retry_at: String(args[2]),
    });
    return { changes: 1 };
  }
  if (s.startsWith("UPDATE feed_status SET last_successful_pull")) {
    const row = state.status.get(String(args[2]));
    if (!row) return { changes: 0 };
    Object.assign(row, { health_status: "healthy", last_error: null, consecutive_failures: 0, next_retry_at: null, last_successful_pull: "now" });
    return { changes: 1 };
  }
  return { changes: 0 };
}

function query(state: State, sql: string, args: unknown[]): unknown[] {
  const s = sql.replace(/\s+/g, " ").trim();
  if (s.startsWith("SELECT * FROM feed_configs WHERE enabled = 1")) {
    return state.configs.map((feed_name) => ({
      feed_name,
      display_name: feed_name,
      source_url: null,
      schedule_cron: "0 * * * *",
      rate_limit: 60,
      batch_size: 100,
      retry_count: 3,
      enabled: 1,
      consecutive_failure_threshold: null,
    }));
  }
  if (s.startsWith("SELECT * FROM feed_configs WHERE feed_type = 'enrichment'")) {
    return query(state, "SELECT * FROM feed_configs WHERE enabled = 1", args);
  }
  if (s.startsWith("SELECT * FROM feed_configs WHERE feed_type = 'social'")) {
    return query(state, "SELECT * FROM feed_configs WHERE enabled = 1", args);
  }
  if (s.startsWith("SELECT status, error_message FROM feed_pull_history WHERE feed_name = ? AND id <> ?")) {
    // Map insertion order = start order; newest other row of this feed.
    const rows = [...state.pulls.values()].filter((r) => r.feed_name === args[0] && r.id !== args[1]);
    const prev = rows.at(-1);
    return prev ? [{ status: prev.status, error_message: prev.error_message }] : [];
  }
  if (s.startsWith("SELECT * FROM feed_status")) return [...state.status.values()];
  if (s.startsWith("SELECT health_status, consecutive_failures FROM feed_status")) {
    const row = state.status.get(String(args[0]));
    return row ? [{ health_status: row.health_status, consecutive_failures: row.consecutive_failures }] : [];
  }
  if (s.startsWith("SELECT value FROM system_config")) return [{ value: "5" }];
  return [];
}

function makeEnv(state: State): Env {
  const prepare = (sql: string) => {
    const make = (args: unknown[]) => ({
      run: async () => ({ success: true, meta: exec(state, sql, args) }),
      first: async () => query(state, sql, args)[0] ?? null,
      all: async () => ({ results: query(state, sql, args) }),
    });
    return { ...make([]), bind: (...args: unknown[]) => make(args) };
  };
  return { DB: { prepare }, CACHE: { get: async () => null, put: async () => undefined } } as unknown as Env;
}

// ─── Feed modules ────────────────────────────────────────────────

const OK: FeedResult = { itemsFetched: 3, itemsNew: 2, itemsDuplicate: 1, itemsError: 0 };

const fastModule = (): FeedModule => ({ ingest: async () => ({ ...OK }) });
const hangingModule = (): FeedModule => ({ ingest: () => new Promise<FeedResult>(() => {}) });

/** A module whose ingest settles only when the test says so. */
function controllable(): { mod: FeedModule; resolve: (r: FeedResult) => void; reject: (e: Error) => void } {
  let resolve!: (r: FeedResult) => void;
  let reject!: (e: Error) => void;
  const p = new Promise<FeedResult>((res, rej) => { resolve = res; reject = rej; });
  return { mod: { ingest: () => p }, resolve, reject };
}

/** Seed a finished earlier pull of `feed` (e.g. last tick's). */
function seedPreviousPull(state: State, feed: string, status: PullRow["status"], error: string | null): void {
  const id = `prev-${feed}-${state.pulls.size}`;
  state.pulls.set(id, { id, feed_name: feed, status, completed_at: "earlier", error_message: error, duration_ms: 1 });
}

/** The pulls of `feed` started by the code under test (not seeded). */
function newPullsOf(state: State, feed: string): PullRow[] {
  return [...state.pulls.values()].filter((r) => r.feed_name === feed && !r.id.startsWith("prev-"));
}

function pullOf(state: State, feed: string): PullRow {
  const rows = [...state.pulls.values()].filter((r) => r.feed_name === feed);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

// ─── Tests ───────────────────────────────────────────────────────

describe("runAllFeeds per-feed timeout", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T21:07:50Z"));
    createNotificationMock.mockClear();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  });

  it("resolves the per-feed timeout from the default + overrides", () => {
    expect(FEED_RUN_TIMEOUT_MS).toBe(120_000);
    expect(feedRunTimeoutMs("nrd_hagezi")).toBe(120_000);
    expect(feedRunTimeoutMs("cloudflare_scanner")).toBe(120_000);
    expect(feedRunTimeoutMs("urlhaus")).toBe(120_000);
    expect(feedRunTimeoutMs("taxii_otx")).toBe(600_000);
    // No override may exceed the pool budget, or that feed could never
    // get its full window.
    for (const ms of Object.values(FEED_RUN_TIMEOUT_OVERRIDES_MS)) {
      expect(ms).toBeLessThanOrEqual(FEED_POOL_BUDGET_MS);
    }
  });

  it("abandons hung pulls at the timeout, frees their slots, and finalizes + penalizes them", async () => {
    // Four hangs fill the whole pool (FEED_CONCURRENCY = 4); the fast
    // feeds behind them can only run once the timeouts free the slots.
    const hung = ["nrd_hagezi", "cloudflare_scanner", "urlhaus", "hang_d"];
    const fast = ["openphish", "threatfox"];
    const state = makeState([...hung, ...fast]);
    const modules: Record<string, FeedModule> = {};
    for (const f of hung) modules[f] = hangingModule();
    for (const f of fast) modules[f] = fastModule();

    let done = false;
    const run = runAllFeeds(makeEnv(state), modules).finally(() => { done = true; });

    await vi.advanceTimersByTimeAsync(FEED_RUN_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    expect(state.inserts).toEqual(hung); // fast feeds still queued
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;

    expect(result).toMatchObject({ feedsRun: 6, feedsFailed: 4, feedsTimedOut: 4, feedsDeferred: 0, totalNew: 4 });
    for (const f of fast) {
      expect(pullOf(state, f).status).toBe("success");
      expect(state.status.get(f)!.consecutive_failures).toBe(0);
    }
    for (const f of hung) {
      const row = pullOf(state, f);
      expect(row.status).toBe("failed");
      expect(row.completed_at).not.toBeNull();
      expect(row.error_message).toBe("timed out after 120s — pull abandoned");
      expect(row.duration_ms).toBe(120_000);
      const st = state.status.get(f)!;
      expect(st.consecutive_failures).toBe(1);
      expect(st.next_retry_at).not.toBeNull();
      expect(st.last_error).toBe("timed out after 120s — pull abandoned");
    }
    expect(unhandled).toEqual([]);
  });

  it("does not let a late completion overwrite the timed-out row or reset the breaker", async () => {
    const late = controllable();
    const state = makeState(["nrd_hagezi"]);
    const run = runAllFeeds(makeEnv(state), { nrd_hagezi: late.mod });
    await vi.advanceTimersByTimeAsync(FEED_RUN_TIMEOUT_MS);
    const result = await run;
    expect(result.feedsTimedOut).toBe(1);
    const retryAt = state.status.get("nrd_hagezi")!.next_retry_at;
    expect(retryAt).not.toBeNull();

    late.resolve({ ...OK });
    await vi.advanceTimersByTimeAsync(1_000);

    const row = pullOf(state, "nrd_hagezi");
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("timed out after 120s — pull abandoned");
    const st = state.status.get("nrd_hagezi")!;
    expect(st.consecutive_failures).toBe(1);
    expect(st.next_retry_at).toBe(retryAt);
    expect(st.last_successful_pull).toBeNull();
    expect(unhandled).toEqual([]);
  });

  it("does not let a late rejection overwrite the row, double-penalize, or go unhandled", async () => {
    const late = controllable();
    const state = makeState(["cloudflare_scanner"]);
    const run = runAllFeeds(makeEnv(state), { cloudflare_scanner: late.mod });
    await vi.advanceTimersByTimeAsync(FEED_RUN_TIMEOUT_MS);
    await run;

    late.reject(new Error("D1_ERROR: late boom"));
    await vi.advanceTimersByTimeAsync(1_000);

    const row = pullOf(state, "cloudflare_scanner");
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("timed out after 120s — pull abandoned");
    expect(state.status.get("cloudflare_scanner")!.consecutive_failures).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it("leaves a pull that settles before the timeout untouched (ordinary failure path)", async () => {
    const state = makeState(["urlhaus"]);
    const mod: FeedModule = { ingest: async () => { throw new Error("HTTP 502"); } };
    const result = await runAllFeeds(makeEnv(state), { urlhaus: mod });
    expect(result).toMatchObject({ feedsFailed: 1, feedsTimedOut: 0 });
    const row = pullOf(state, "urlhaus");
    expect(row.error_message).toBe("HTTP 502");
    expect(state.status.get("urlhaus")!.consecutive_failures).toBe(1);
    // The cleared timer must not fire later and touch the row again.
    await vi.advanceTimersByTimeAsync(FEED_POOL_BUDGET_MS);
    expect(pullOf(state, "urlhaus").error_message).toBe("HTTP 502");
    expect(state.status.get("urlhaus")!.consecutive_failures).toBe(1);
  });

  it("starts longest-budget feeds first, clips at the pool deadline without penalty, then defers", async () => {
    // Every feed hangs. Slots: taxii_otx 0-600s, sslbl 0-480s,
    // typosquat_scanner 0-270s, c2_intel_feeds 0-240s. Default (120s)
    // feeds queue behind: a 240-360, b 270-390, c 360-480, d 390-510,
    // e 480-600, f 480-600, g 510 with only 90s of pool left → clipped,
    // h finds no slot before 600s → deferred.
    const defaults = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const long = ["c2_intel_feeds", "typosquat_scanner", "sslbl", "taxii_otx"];
    // Config order deliberately puts the long feeds last.
    const state = makeState([...defaults, ...long]);
    const modules: Record<string, FeedModule> = {};
    for (const f of [...defaults, ...long]) modules[f] = hangingModule();

    const run = runAllFeeds(makeEnv(state), modules);
    await vi.advanceTimersByTimeAsync(FEED_POOL_BUDGET_MS);
    const result = await run;

    expect(state.inserts.slice(0, 4)).toEqual(["taxii_otx", "sslbl", "typosquat_scanner", "c2_intel_feeds"]);
    expect(result).toMatchObject({ feedsRun: 11, feedsTimedOut: 11, feedsFailed: 11, feedsDeferred: 1 });
    expect(result.feedsSkipped).toBe(1);

    expect(pullOf(state, "taxii_otx").error_message).toBe("timed out after 600s — pull abandoned");
    expect(pullOf(state, "e").error_message).toBe("timed out after 120s — pull abandoned");
    expect(state.status.get("e")!.consecutive_failures).toBe(1);

    const clipped = pullOf(state, "g");
    expect(clipped.status).toBe("failed");
    expect(clipped.error_message).toBe("timed out after 90s at the feed-pool deadline (600s budget) — pull abandoned");
    expect(state.status.get("g")!.consecutive_failures).toBe(0);
    expect(state.status.get("g")!.next_retry_at).toBeNull();

    // Deferred: never started, no row, no penalty — still due next tick.
    expect([...state.pulls.values()].some((r) => r.feed_name === "h")).toBe(false);
    expect(state.status.get("h")!.consecutive_failures).toBe(0);
    expect(unhandled).toEqual([]);
  });
});

describe("runAllEnrichmentFeeds per-feed timeout + loop budget", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T21:08:31Z"));
    createNotificationMock.mockClear();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  });

  it("sizes the enrichment overrides from the 14-day data", () => {
    expect(feedRunTimeoutMs("surbl")).toBe(300_000);
    expect(feedRunTimeoutMs("virustotal")).toBe(270_000);
    expect(feedRunTimeoutMs("google_safe_browsing")).toBe(150_000);
    expect(feedRunTimeoutMs("spamhaus_dbl")).toBe(FEED_RUN_TIMEOUT_MS);
    expect(feedRunTimeoutMs("abuseipdb")).toBe(FEED_RUN_TIMEOUT_MS);
    // An enrichment feed's full timeout must fit the loop budget, or it
    // could never get its whole window.
    for (const f of ["surbl", "virustotal", "google_safe_browsing", "spamhaus_dbl", "abuseipdb", "circl_pdns"]) {
      expect(feedRunTimeoutMs(f)).toBeLessThanOrEqual(ENRICHMENT_LOOP_BUDGET_MS);
    }
  });

  it("abandons a hung enrichment pull, penalizes it, and runs the next feed", async () => {
    const state = makeState(["surbl", "spamhaus_dbl"]);
    let done = false;
    const run = runAllEnrichmentFeeds(makeEnv(state), {
      surbl: hangingModule(),
      spamhaus_dbl: fastModule(),
    }).finally(() => { done = true; });

    await vi.advanceTimersByTimeAsync(300_000 - 1);
    expect(done).toBe(false);
    expect(state.inserts).toEqual(["surbl"]); // spamhaus_dbl waits behind it
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;

    expect(result).toMatchObject({ feedsRun: 2, feedsFailed: 1, feedsTimedOut: 1, feedsDeferred: 0, totalEnriched: 2 });
    const row = pullOf(state, "surbl");
    expect(row.status).toBe("failed");
    expect(row.error_message).toBe("timed out after 300s — pull abandoned");
    expect(state.status.get("surbl")!.consecutive_failures).toBe(1);
    expect(state.status.get("surbl")!.next_retry_at).not.toBeNull();
    expect(pullOf(state, "spamhaus_dbl").status).toBe("success");
    expect(unhandled).toEqual([]);
  });

  it("returns within its own loop budget: clips the feed that overruns it, defers the rest", async () => {
    // surbl hangs 0-300s; virustotal starts with 60s of the 360s budget
    // left → clipped to 60s (no penalty); spamhaus_dbl is deferred.
    expect(ENRICHMENT_LOOP_BUDGET_MS).toBe(360_000);
    const state = makeState(["surbl", "virustotal", "spamhaus_dbl"]);
    const spamhaus = vi.fn(fastModule().ingest);
    let done = false;
    const run = runAllEnrichmentFeeds(makeEnv(state), {
      surbl: hangingModule(),
      virustotal: hangingModule(),
      spamhaus_dbl: { ingest: spamhaus },
    }).finally(() => { done = true; });

    await vi.advanceTimersByTimeAsync(ENRICHMENT_LOOP_BUDGET_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await run;

    expect(result).toMatchObject({ feedsRun: 2, feedsTimedOut: 2, feedsDeferred: 1, feedsSkipped: 1 });
    expect(pullOf(state, "surbl").error_message).toBe("timed out after 300s — pull abandoned");
    const clipped = pullOf(state, "virustotal");
    expect(clipped.status).toBe("failed");
    expect(clipped.error_message).toBe("timed out after 60s at the enrichment deadline (360s budget) — pull abandoned");
    expect(state.status.get("virustotal")!.consecutive_failures).toBe(0);
    expect(spamhaus).not.toHaveBeenCalled();
    expect([...state.pulls.values()].some((r) => r.feed_name === "spamhaus_dbl")).toBe(false);
    expect(unhandled).toEqual([]);
  });

  it("honours an earlier external (tick) deadline", async () => {
    const state = makeState(["surbl", "spamhaus_dbl"]);
    const run = runAllEnrichmentFeeds(
      makeEnv(state),
      { surbl: hangingModule(), spamhaus_dbl: fastModule() },
      { deadline: Date.now() + 100_000 },
    );
    await vi.advanceTimersByTimeAsync(100_000);
    const result = await run;
    expect(result).toMatchObject({ feedsRun: 1, feedsTimedOut: 1, feedsDeferred: 1 });
    expect(pullOf(state, "surbl").error_message).toBe("timed out after 100s at the enrichment deadline (100s budget) — pull abandoned");
    expect(state.status.get("surbl")!.consecutive_failures).toBe(0);
  });

  it("defers everything when the tick deadline has already passed", async () => {
    const state = makeState(["surbl"]);
    const surbl = vi.fn(hangingModule().ingest);
    const result = await runAllEnrichmentFeeds(makeEnv(state), { surbl: { ingest: surbl } }, { deadline: Date.now() - 1 });
    expect(result).toMatchObject({ feedsRun: 0, feedsDeferred: 1 });
    expect(surbl).not.toHaveBeenCalled();
  });

  it("never runs the dedicated-cron enrichment feeds", async () => {
    const state = makeState(["greynoise", "seclookup", "pulsedive", "abuseipdb"]);
    const dedicated = vi.fn(fastModule().ingest);
    const result = await runAllEnrichmentFeeds(makeEnv(state), {
      greynoise: { ingest: dedicated },
      seclookup: { ingest: dedicated },
      pulsedive: { ingest: dedicated },
      abuseipdb: fastModule(),
    });
    expect(dedicated).not.toHaveBeenCalled();
    expect(result).toMatchObject({ feedsRun: 1, feedsSkipped: 3 });
    expect(state.inserts).toEqual(["abuseipdb"]);
  });
});

describe("enrichmentDeadlineForTick", () => {
  const T = Date.parse("2026-11-09T21:07:00Z");
  it("anchors to scheduledTime for a live tick", () => {
    expect(enrichmentDeadlineForTick(T, T + 9 * 60_000)).toBe(T + ENRICHMENT_TICK_DEADLINE_MS);
    // Already past the deadline → in the past → loop defers everything.
    expect(enrichmentDeadlineForTick(T, T + 13 * 60_000)).toBeLessThan(T + 13 * 60_000);
  });
  it("anchors to now for a scheduledTime no live invocation could have", () => {
    const now = T + 60 * 60_000;
    expect(enrichmentDeadlineForTick(T, now)).toBe(now + ENRICHMENT_TICK_DEADLINE_MS);
    expect(enrichmentDeadlineForTick(T + 60_000, T)).toBe(T + ENRICHMENT_TICK_DEADLINE_MS);
  });
});

// ─── #1934 review follow-ups ─────────────────────────────────────

describe("feed timeout follow-ups (fake timers)", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T21:07:50Z"));
    createNotificationMock.mockClear();
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    vi.useRealTimers();
  });

  describe("penalizing a feed with no feed_status row", () => {
    it("creates the row and backs off a feed that times out before it ever succeeded", async () => {
      const state = makeState(["nrd_hagezi"]);
      state.status.delete("nrd_hagezi");
      const run = runAllFeeds(makeEnv(state), { nrd_hagezi: hangingModule() });
      await vi.advanceTimersByTimeAsync(FEED_RUN_TIMEOUT_MS);
      expect(await run).toMatchObject({ feedsTimedOut: 1 });

      const st = state.status.get("nrd_hagezi");
      expect(st).toBeDefined();
      expect(st!.consecutive_failures).toBe(1);
      expect(st!.next_retry_at).not.toBeNull();
      expect(st!.health_status).toBe("degraded");
      expect(st!.last_error).toBe("timed out after 120s — pull abandoned");
      // Born 'healthy', so the first failure is a healthy → degraded
      // transition and notifies.
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(createNotificationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        type: "feed_health", title: "Feed degraded: nrd_hagezi",
      }));
      expect(unhandled).toEqual([]);
    });

    it("creates the row and backs off a feed that throws before it ever succeeded", async () => {
      const state = makeState(["urlhaus"]);
      state.status.delete("urlhaus");
      const mod: FeedModule = { ingest: async () => { throw new Error("HTTP 502"); } };
      expect(await runAllFeeds(makeEnv(state), { urlhaus: mod })).toMatchObject({ feedsFailed: 1, feedsTimedOut: 0 });

      const st = state.status.get("urlhaus")!;
      expect(st.consecutive_failures).toBe(1);
      expect(st.next_retry_at).not.toBeNull();
      expect(st.last_error).toBe("HTTP 502");
      expect(createNotificationMock).toHaveBeenCalledTimes(1);
      expect(createNotificationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        type: "feed_health", title: "Feed degraded: urlhaus",
      }));
    });

    it("does not notify again for a feed whose existing row is already degraded", async () => {
      const state = makeState(["urlhaus"]); // rows seeded 'degraded'
      const mod: FeedModule = { ingest: async () => { throw new Error("HTTP 502"); } };
      await runAllFeeds(makeEnv(state), { urlhaus: mod });
      expect(createNotificationMock).not.toHaveBeenCalled();
    });
  });

  describe("clipped timeouts", () => {
    const clippedMsg = (sec: number) =>
      `timed out after ${sec}s at the enrichment deadline (${sec}s budget) — pull abandoned`;

    /** One enrichment tick in which surbl (own 300s) hangs and is clipped to `ms`. */
    async function clippedSurblTick(state: State, ms: number): Promise<void> {
      const run = runAllEnrichmentFeeds(makeEnv(state), { surbl: hangingModule() }, { deadline: Date.now() + ms });
      await vi.advanceTimersByTimeAsync(ms);
      expect(await run).toMatchObject({ feedsTimedOut: 1 });
    }

    it("hang evidence starts at min(own timeout, 120s)", () => {
      expect(hangEvidenceMinMs("surbl")).toBe(FEED_RUN_TIMEOUT_MS);      // own 300s
      expect(hangEvidenceMinMs("taxii_otx")).toBe(FEED_RUN_TIMEOUT_MS);  // own 600s
      expect(hangEvidenceMinMs("urlhaus")).toBe(FEED_RUN_TIMEOUT_MS);    // default 120s
    });

    it("never penalizes a short squeeze, however often it repeats (surbl at 60s, 3 ticks)", async () => {
      // Slow-ingest ticks: taxii_otx eats ~9 min, the 12-min tick deadline
      // leaves surbl ~60s of its normal ≤300s. Slow-ticked, not hung.
      const state = makeState(["surbl"]);
      for (let tick = 0; tick < 3; tick++) {
        await clippedSurblTick(state, 60_000);
        vi.setSystemTime(Date.now() + 60 * 60_000);
      }
      expect(newPullsOf(state, "surbl").map((r) => r.error_message)).toEqual([clippedMsg(60), clippedMsg(60), clippedMsg(60)]);
      const st = state.status.get("surbl")!;
      expect(st.consecutive_failures).toBe(0);
      expect(st.next_retry_at).toBeNull();
      expect(unhandled).toEqual([]);
    });

    it("does not penalize a meaningful clip that follows a short squeeze", async () => {
      const state = makeState(["surbl"]);
      seedPreviousPull(state, "surbl", "failed", clippedMsg(60));
      await clippedSurblTick(state, 150_000);
      expect(state.status.get("surbl")!.consecutive_failures).toBe(0);
    });

    it("is not penalized when the previous pull did not time out", async () => {
      const state = makeState(["surbl"]);
      seedPreviousPull(state, "surbl", "success", null);
      await clippedSurblTick(state, 150_000);
      expect(newPullsOf(state, "surbl")[0]!.error_message).toBe(clippedMsg(150));
      expect(state.status.get("surbl")!.consecutive_failures).toBe(0);
      expect(state.status.get("surbl")!.next_retry_at).toBeNull();
    });

    it("is not penalized when the previous pull failed for another reason", async () => {
      const state = makeState(["surbl"]);
      seedPreviousPull(state, "surbl", "failed", "HTTP 502");
      await clippedSurblTick(state, 150_000);
      expect(state.status.get("surbl")!.consecutive_failures).toBe(0);
    });

    it("penalizes a repeated 120s+ clipped allowance from the 2nd tick, so an always-clipped hang backs off", async () => {
      const state = makeState(["surbl"]);
      // Tick 1: first meaningful clipped timeout — no penalty yet.
      await clippedSurblTick(state, 150_000);
      expect(state.status.get("surbl")!.consecutive_failures).toBe(0);
      // Tick 2: again, after a meaningful timeout — penalized.
      await clippedSurblTick(state, 150_000);
      let st = state.status.get("surbl")!;
      expect(st.consecutive_failures).toBe(1);
      expect(st.next_retry_at).not.toBeNull();
      expect(st.last_error).toBe(`${clippedMsg(150)}; previous pull also timed out`);
      // Tick 3, once the backoff window has passed: keeps climbing toward
      // auto-pause. Exactly 120s (the threshold) still qualifies.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await clippedSurblTick(state, FEED_RUN_TIMEOUT_MS);
      st = state.status.get("surbl")!;
      expect(st.consecutive_failures).toBe(2);
      // Every pull row keeps its own (unsuffixed) timeout error.
      expect(newPullsOf(state, "surbl").map((r) => r.error_message)).toEqual([clippedMsg(150), clippedMsg(150), clippedMsg(120)]);
      expect(unhandled).toEqual([]);
    });

    it("penalizes a meaningful clip after an unclipped timeout", async () => {
      const state = makeState(["surbl"]);
      seedPreviousPull(state, "surbl", "failed", "timed out after 300s — pull abandoned");
      await clippedSurblTick(state, 150_000);
      expect(state.status.get("surbl")!.consecutive_failures).toBe(1);
    });

    it("does not penalize a pool feed squeezed below its allowance, even after a full timeout", async () => {
      // Same pool layout as the longest-first test: g (own 120s) is clipped
      // to 90s at the feed-pool deadline and h is deferred. g's previous
      // pull hung for its full 120s, but 90s is a squeeze, not evidence.
      const defaults = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const long = ["c2_intel_feeds", "typosquat_scanner", "sslbl", "taxii_otx"];
      const state = makeState([...defaults, ...long]);
      seedPreviousPull(state, "g", "failed", "timed out after 120s — pull abandoned");
      const modules: Record<string, FeedModule> = {};
      for (const f of [...defaults, ...long]) modules[f] = hangingModule();

      const run = runAllFeeds(makeEnv(state), modules);
      await vi.advanceTimersByTimeAsync(FEED_POOL_BUDGET_MS);
      expect(await run).toMatchObject({ feedsTimedOut: 11, feedsDeferred: 1 });

      const g = newPullsOf(state, "g");
      expect(g).toHaveLength(1);
      expect(g[0]!.error_message).toBe("timed out after 90s at the feed-pool deadline (600s budget) — pull abandoned");
      expect(state.status.get("g")!.consecutive_failures).toBe(0);
      expect(state.status.get("h")!.consecutive_failures).toBe(0);
    });
  });

  describe("clip tolerance", () => {
    it("treats a shortfall of at most FEED_TIMEOUT_CLIP_TOLERANCE_MS as a full (unclipped) allowance", () => {
      const deadline = Date.now() + FEED_POOL_BUDGET_MS;
      const own = feedRunTimeoutMs("taxii_otx");
      expect(own).toBe(FEED_POOL_BUDGET_MS);
      // Exactly the budget left → own timeout.
      expect(plannedFeedTimeout("taxii_otx", deadline, deadline - own)).toEqual({ timeoutMs: own, clipped: false });
      // Short by exactly the tolerance → still unclipped, capped at the time left.
      const atTolerance = deadline - own + FEED_TIMEOUT_CLIP_TOLERANCE_MS;
      expect(plannedFeedTimeout("taxii_otx", deadline, atTolerance))
        .toEqual({ timeoutMs: own - FEED_TIMEOUT_CLIP_TOLERANCE_MS, clipped: false });
      // One ms beyond the tolerance → clipped.
      expect(plannedFeedTimeout("taxii_otx", deadline, atTolerance + 1))
        .toEqual({ timeoutMs: own - FEED_TIMEOUT_CLIP_TOLERANCE_MS - 1, clipped: true });
      // The tolerance is far smaller than the minimum start window.
      expect(FEED_TIMEOUT_CLIP_TOLERANCE_MS).toBeLessThan(FEED_POOL_MIN_START_MS);
    });

    /** A module that succeeds after `ms` of (fake) wall time. */
    const slowModule = (ms: number): FeedModule => ({
      ingest: () => new Promise<FeedResult>((r) => setTimeout(() => r({ ...OK }), ms)),
    });

    it("penalizes a timeout whose allowance fell short of its own only by the tolerance", async () => {
      // abuseipdb takes 5s, so spamhaus_dbl (own 120s) starts with 118s of
      // the 123s deadline left: within the tolerance → a full allowance.
      const state = makeState(["abuseipdb", "spamhaus_dbl"]);
      const run = runAllEnrichmentFeeds(
        makeEnv(state),
        { abuseipdb: slowModule(5_000), spamhaus_dbl: hangingModule() },
        { deadline: Date.now() + 123_000 },
      );
      await vi.advanceTimersByTimeAsync(123_000);
      expect(await run).toMatchObject({ feedsRun: 2, feedsTimedOut: 1 });
      expect(pullOf(state, "spamhaus_dbl").error_message).toBe("timed out after 118s — pull abandoned");
      expect(state.status.get("spamhaus_dbl")!.consecutive_failures).toBe(1);
    });

    it("still treats a shortfall beyond the tolerance as a clip (no penalty)", async () => {
      // Same, but abuseipdb takes 10s → 113s left, 7s short of 120s.
      const state = makeState(["abuseipdb", "spamhaus_dbl"]);
      const run = runAllEnrichmentFeeds(
        makeEnv(state),
        { abuseipdb: slowModule(10_000), spamhaus_dbl: hangingModule() },
        { deadline: Date.now() + 123_000 },
      );
      await vi.advanceTimersByTimeAsync(123_000);
      expect(await run).toMatchObject({ feedsRun: 2, feedsTimedOut: 1 });
      expect(pullOf(state, "spamhaus_dbl").error_message).toBe("timed out after 113s at the enrichment deadline (123s budget) — pull abandoned");
      expect(state.status.get("spamhaus_dbl")!.consecutive_failures).toBe(0);
    });
  });

  describe("runAllSocialFeeds per-pull cap + deadline", () => {
    it("abandons a hung social pull at the 120s default, penalizes it, and runs the next feed", async () => {
      const state = makeState(["github", "mastodon"]);
      let done = false;
      const run = runAllSocialFeeds(makeEnv(state), {
        github: hangingModule(),
        mastodon: fastModule(),
      }).finally(() => { done = true; });

      await vi.advanceTimersByTimeAsync(FEED_RUN_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      expect(state.inserts).toEqual(["github"]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await run;

      expect(result).toMatchObject({ feedsRun: 2, feedsFailed: 1, feedsTimedOut: 1, feedsDeferred: 0, totalNew: 2 });
      expect(pullOf(state, "github").error_message).toBe("timed out after 120s — pull abandoned");
      expect(state.status.get("github")!.consecutive_failures).toBe(1);
      expect(state.status.get("github")!.next_retry_at).not.toBeNull();
      expect(pullOf(state, "mastodon").status).toBe("success");
      expect(unhandled).toEqual([]);
    });

    it("returns within its own loop budget: clips the overrunning feed, defers the rest", async () => {
      // github hangs 0-120s; mastodon starts with 60s of the 180s budget
      // left → clipped to 60s (no penalty); telegram is deferred.
      expect(SOCIAL_LOOP_BUDGET_MS).toBe(180_000);
      const state = makeState(["github", "mastodon", "telegram"]);
      const telegram = vi.fn(fastModule().ingest);
      const run = runAllSocialFeeds(makeEnv(state), {
        github: hangingModule(),
        mastodon: hangingModule(),
        telegram: { ingest: telegram },
      });
      await vi.advanceTimersByTimeAsync(SOCIAL_LOOP_BUDGET_MS);
      const result = await run;

      expect(result).toMatchObject({ feedsRun: 2, feedsTimedOut: 2, feedsDeferred: 1, feedsSkipped: 1 });
      expect(pullOf(state, "mastodon").error_message).toBe("timed out after 60s at the social deadline (180s budget) — pull abandoned");
      expect(state.status.get("mastodon")!.consecutive_failures).toBe(0);
      expect(state.status.get("github")!.consecutive_failures).toBe(1);
      expect(telegram).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    it("honours an earlier external (tick) deadline", async () => {
      const state = makeState(["github", "telegram"]);
      const run = runAllSocialFeeds(
        makeEnv(state),
        { github: hangingModule(), telegram: fastModule() },
        { deadline: Date.now() + 45_000 },
      );
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await run).toMatchObject({ feedsRun: 1, feedsTimedOut: 1, feedsDeferred: 1 });
      expect(pullOf(state, "github").error_message).toBe("timed out after 45s at the social deadline (45s budget) — pull abandoned");
      expect(state.status.get("github")!.consecutive_failures).toBe(0);
    });

    it("defers everything when the tick deadline has already passed", async () => {
      const state = makeState(["github"]);
      const github = vi.fn(hangingModule().ingest);
      const result = await runAllSocialFeeds(makeEnv(state), { github: { ingest: github } }, { deadline: Date.now() - 1 });
      expect(result).toMatchObject({ feedsRun: 0, feedsDeferred: 1, feedsSkipped: 1 });
      expect(github).not.toHaveBeenCalled();
    });
  });
});

describe("clip tolerance with a real advancing clock", () => {
  it("does not clip taxii_otx when real time passes between the pool deadline and its start", async () => {
    // Mirrors runAllFeeds: the pool deadline is fixed, then the first
    // (longest) feed is planned once the clock has actually moved on.
    const deadline = Date.now() + FEED_POOL_BUDGET_MS;
    await new Promise((r) => setTimeout(r, 25));
    const plannedAt = Date.now();
    expect(plannedAt).toBeGreaterThan(deadline - FEED_POOL_BUDGET_MS);

    const plan = plannedFeedTimeout("taxii_otx", deadline);
    expect(plan).not.toBeNull();
    expect(plan!.clipped).toBe(false);
    expect(plan!.timeoutMs).toBeLessThan(FEED_POOL_BUDGET_MS);
    expect(plan!.timeoutMs).toBeGreaterThanOrEqual(FEED_POOL_BUDGET_MS - FEED_TIMEOUT_CLIP_TOLERANCE_MS);
    // The pool still never runs past its deadline.
    expect(plannedAt + plan!.timeoutMs).toBeLessThanOrEqual(deadline);
  });
});
