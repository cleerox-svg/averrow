/**
 * Tests for the orphan agent_runs sweeper.
 *
 * Mirrors test/feed-pull-reaper.test.ts — same architectural pattern,
 * different table. See lib/agent-runs-reaper.ts for the rationale.
 *
 * Verifies:
 *   1. The SQL UPDATE targets exactly the orphan rows: status='partial'
 *      AND completed_at IS NULL AND started_at older than the grace.
 *   2. duration_ms is back-stamped from started_at so downstream
 *      metrics don't keep treating the row as "still running".
 *   3. The function returns the row count via meta.changes.
 *   4. A D1 throw is swallowed (returns 0, never throws).
 */

import { describe, it, expect, vi } from "vitest";
import { reapOrphanAgentRuns, REAP_AGE_MINUTES } from "../src/lib/agent-runs-reaper";
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

describe("reapOrphanAgentRuns", () => {
  it("targets only orphan partial rows older than the grace window", async () => {
    const { env, captured } = makeEnv({ changes: 4 });
    const reaped = await reapOrphanAgentRuns(env);

    expect(reaped).toBe(4);
    expect(captured).toHaveLength(1);
    const sql = captured[0]!.sql;

    // All three guardrails must be in the WHERE clause — missing any
    // would either over-reap (live rows) or under-reap (rows that
    // legitimately completed). Same shape as feed-pull-reaper.
    expect(sql).toMatch(/UPDATE\s+agent_runs/);
    expect(sql).toMatch(/status\s*=\s*'partial'/);
    expect(sql).toMatch(/completed_at\s+IS\s+NULL/);
    // Both sides through datetime() — see comment in lib for the
    // ISO-vs-sqlite-format string-comparison footgun.
    expect(sql).toMatch(/datetime\(started_at\)\s*<=\s*datetime\('now',\s*'-90 minutes'\)/);

    // Mutation: row gets a final 'failed' state with a forensic
    // error_message (only when error_message was previously null —
    // never overwrites a real exception message).
    expect(sql).toMatch(/SET\s+status\s*=\s*'failed'/);
    expect(sql).toMatch(/completed_at\s*=\s*datetime\('now'\)/);
    expect(sql).toMatch(/COALESCE\(\s*error_message/);

    // duration_ms is back-stamped so the diagnostic's
    // avg_duration_ms doesn't accumulate dead rows as if they ran
    // forever.
    expect(sql).toMatch(/duration_ms\s*=\s*COALESCE\(/);
    expect(sql).toMatch(/julianday\('now'\)\s*-\s*julianday\(started_at\)/);
  });

  it("returns 0 when D1 throws (never crashes the navigator tick)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = makeEnv({ throws: true });
    const reaped = await reapOrphanAgentRuns(env);
    expect(reaped).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("exposes the grace constant for callers and platform docs", () => {
    // 90 min — see lib/agent-runs-reaper.ts for why this is higher
    // than feed-pull-reaper's 15 min (agents legitimately run
    // longer than feed pulls; sentinel declares 75 min).
    expect(REAP_AGE_MINUTES).toBe(90);
  });
});
