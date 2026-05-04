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
  changes?: number;
  throws?: boolean;
}): { env: Env; captured: CapturedRun[] } {
  const captured: CapturedRun[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          run: async () => {
            captured.push({ sql });
            if (opts.throws) throw new Error("network connection lost");
            return { success: true, meta: { changes: opts.changes ?? 0 } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, captured };
}

describe("reapOrphanFeedPullHistory", () => {
  it("targets only orphan partial rows older than the grace window", async () => {
    const { env, captured } = makeEnv({ changes: 7 });
    const reaped = await reapOrphanFeedPullHistory(env);

    expect(reaped).toBe(7);
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;

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

  it("exposes the grace constant for callers and platform docs", () => {
    expect(REAP_AGE_MINUTES).toBe(15);
  });
});
