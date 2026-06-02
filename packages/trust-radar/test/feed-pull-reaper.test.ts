/**
 * Tests for the orphan-pull-history sweeper.
 *
 * The sweeper is the only architectural fix for "row stuck partial
 * because the worker died mid-run" — no JS finally can survive worker
 * termination. These tests verify:
 *
 *   1. The SQL UPDATE targets exactly the orphan rows we expect:
 *      status='partial' AND completed_at IS NULL AND started_at older
 *      than the configured grace.
 *   2. The function returns the row count via `meta.changes`.
 *   3. A D1 throw is swallowed (returns 0 — never throws).
 */

import { describe, it, expect, vi } from "vitest";
import { reapOrphanFeedPullHistory, REAP_AGE_MINUTES } from "../src/lib/feed-pull-reaper";
import type { Env } from "../src/types";

interface CapturedRun {
  sql: string;
}

function makeEnv(opts: {
  /** Rows the reap UPDATE ... RETURNING feed_name reports as reaped. */
  reaped?: Array<{ feed_name: string }>;
  throws?: boolean;
}): { env: Env; captured: CapturedRun[] } {
  const captured: CapturedRun[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          // bind() is chainable so applyReapPenalty's parameterized
          // reads/writes don't blow up if it gets invoked.
          bind: () => stmt,
          // The reap UPDATE now uses RETURNING + .all(); capture its SQL
          // here. applyReapPenalty's feed_configs lookup (also .first())
          // returns null below so it no-ops without touching the DB further.
          all: async () => {
            captured.push({ sql });
            if (opts.throws) throw new Error("network connection lost");
            return { results: opts.reaped ?? [] };
          },
          // applyReapPenalty's config lookup → null → early return, so the
          // breaker path is exercised but doesn't require a full mock.
          first: async () => {
            if (opts.throws) throw new Error("network connection lost");
            return null;
          },
          run: async () => {
            captured.push({ sql });
            if (opts.throws) throw new Error("network connection lost");
            return { success: true, meta: { changes: 0 } };
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, captured };
}

describe("reapOrphanFeedPullHistory", () => {
  it("targets only orphan partial rows older than the grace window", async () => {
    // 7 reaped rows across 2 feeds → reaped count 7, breaker penalized
    // once per distinct feed (applyReapPenalty no-ops on the null config).
    const { env, captured } = makeEnv({
      reaped: [
        { feed_name: "seclookup" }, { feed_name: "seclookup" }, { feed_name: "seclookup" },
        { feed_name: "greynoise" }, { feed_name: "greynoise" },
        { feed_name: "greynoise" }, { feed_name: "greynoise" },
      ],
    });
    const reaped = await reapOrphanFeedPullHistory(env);

    expect(reaped).toBe(7);
    // The reap UPDATE is the only statement that records into `captured`
    // (applyReapPenalty's config lookup uses .first(), which doesn't).
    const sql = captured[0]!.sql;
    // RETURNING feed_name is what lets the breaker penalty target exactly
    // the rows this UPDATE reaped (no TOCTOU pre-scan).
    expect(sql).toMatch(/RETURNING\s+feed_name/);

    // All three guardrails must be in the WHERE clause — missing any
    // of them would either over-reap (live rows) or under-reap (rows
    // that legitimately completed before timing out).
    expect(sql).toMatch(/UPDATE\s+feed_pull_history/);
    expect(sql).toMatch(/status\s*=\s*'partial'/);
    expect(sql).toMatch(/completed_at\s+IS\s+NULL/);
    // BOTH sides of the comparison must run through datetime() — feedRunner
    // inserts started_at as ISO ("…T…Z") and SQLite's datetime('now', …)
    // returns "YYYY-MM-DD HH:MM:SS". Without canonicalization, lexical
    // string comparison falsely says ISO > sqlite-format and the reaper
    // never matches anything (verified live 2026-05-04: 13 reapable rows
    // sat unreaped for hours because of this).
    expect(sql).toMatch(/datetime\(started_at\)\s*<=\s*datetime\('now',\s*'-15 minutes'\)/);

    // Mutation: the row gets a final 'failed' state with a forensic
    // error_message that downstream consumers (status-page, feed-health
    // dashboards) will surface.
    expect(sql).toMatch(/SET\s+status\s*=\s*'failed'/);
    expect(sql).toMatch(/completed_at\s*=\s*datetime\('now'\)/);
    expect(sql).toMatch(/COALESCE\(\s*error_message/);
  });

  it("returns 0 when D1 throws (never crashes the navigator tick)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = makeEnv({ throws: true });
    const reaped = await reapOrphanFeedPullHistory(env);
    expect(reaped).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does not penalize the breaker when nothing is reaped", async () => {
    // Empty RETURNING → no feed gets a breaker penalty. Guards against the
    // earlier pre-scan design that could penalize a feed which finalized in
    // the window between the scan and the UPDATE.
    const { env, captured } = makeEnv({ reaped: [] });
    const reaped = await reapOrphanFeedPullHistory(env);
    expect(reaped).toBe(0);
    // Only the reap UPDATE ran; no applyReapPenalty writes (.run) followed.
    expect(captured.every((c) => /UPDATE\s+feed_pull_history/.test(c.sql))).toBe(true);
  });

  it("exposes the grace constant for callers and platform docs", () => {
    expect(REAP_AGE_MINUTES).toBe(15);
  });
});
