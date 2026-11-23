/**
 * Observer weekly-report dedupe + generateInsight output budget (2026-11-23).
 *
 *   1. OBSERVER_WEEKLY_EXISTS_SQL finds the rows the weekly run actually
 *      writes. The old check looked for type='weekly_intel', which nothing
 *      writes, so every Sunday-morning run regenerated the report.
 *   2. generateInsight asks for INSIGHT_MAX_TOKENS (the 1024 default cut the
 *      daily briefing JSON off mid-array on 2026-11-22).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/types";

const callAnthropicJSONMock = vi.fn();
vi.mock("../src/lib/anthropic", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/anthropic")>("../src/lib/anthropic");
  return { ...actual, callAnthropicJSON: (...args: unknown[]) => callAnthropicJSONMock(...args) };
});

import { OBSERVER_WEEKLY_EXISTS_SQL, OBSERVER_WEEKLY_TREND_REPORT_INSERT_SQL } from "../src/agents/observer";
import { generateInsight, INSIGHT_MAX_TOKENS } from "../src/lib/haiku";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";

function count(db: SqliteDb): number {
  return Number((db.prepare(OBSERVER_WEEKLY_EXISTS_SQL).all()[0] as { n: number }).n);
}

function insertOutput(db: SqliteDb, id: string, type: string, details: unknown, ageDays: number, agentId = "observer"): void {
  db.prepare(
    `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at)
     VALUES (?, ?, ?, 'x', 'medium', ?, datetime('now', ?))`,
  ).run(id, agentId, type, details == null ? null : JSON.stringify(details), `-${ageDays} days`);
}

describe.skipIf(!hasSqlite())("OBSERVER_WEEKLY_EXISTS_SQL", () => {
  it("matches the trend_report row the weekly run inserts (the old type='weekly_intel' check never did)", () => {
    const db = openDerivedDb(["agent_outputs"]);
    expect(count(db)).toBe(0);
    db.prepare(OBSERVER_WEEKLY_TREND_REPORT_INSERT_SQL).run("w1", "Weekly Intel: 10 threats", "high", "{}");
    expect(count(db)).toBe(1);
    // The pre-fix predicate, for the record: it does not see the row.
    const old = db.prepare(
      `SELECT COUNT(*) AS n FROM agent_outputs WHERE agent_id = 'observer' AND type = 'weekly_intel'
       AND created_at >= datetime('now', '-6 days')`,
    ).all()[0] as { n: number };
    expect(Number(old.n)).toBe(0);
  });

  it("matches the executeAgent-persisted insight row with details.type='weekly_intel'", () => {
    const db = openDerivedDb(["agent_outputs"]);
    insertOutput(db, "i1", "insight", { title: "Weekly Strategic Intelligence Report", type: "weekly_intel" }, 1);
    expect(count(db)).toBe(1);
  });

  it("ignores daily insights, other agents' rows and rows older than 6 days", () => {
    const db = openDerivedDb(["agent_outputs"]);
    insertOutput(db, "d1", "insight", { title: "daily" }, 0);
    insertOutput(db, "d2", "insight", null, 0);
    insertOutput(db, "o1", "trend_report", {}, 0, "strategist");
    insertOutput(db, "old", "trend_report", {}, 7);
    insertOutput(db, "old2", "insight", { type: "weekly_intel" }, 7);
    expect(count(db)).toBe(0);
  });
});

describe("generateInsight output budget", () => {
  beforeEach(() => callAnthropicJSONMock.mockReset());

  it("requests INSIGHT_MAX_TOKENS (> the 1024 that truncated the 2026-11-22 briefing), within a modest ceiling", async () => {
    expect(INSIGHT_MAX_TOKENS).toBeGreaterThanOrEqual(2048);
    expect(INSIGHT_MAX_TOKENS).toBeLessThanOrEqual(3000);
    callAnthropicJSONMock.mockResolvedValue({
      parsed: { items: [] },
      response: { model: "claude-haiku", usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const res = await generateInsight({} as Env, { agentId: "observer", runId: "r1" }, {
      period: "daily", threats_summary: {}, top_brands: [], top_providers: [], trend_data: {},
    });
    expect(res.success).toBe(true);
    expect(callAnthropicJSONMock).toHaveBeenCalledTimes(1);
    const opts = callAnthropicJSONMock.mock.calls[0]![1] as { maxTokens: number; agentId: string; model: string };
    expect(opts.maxTokens).toBe(INSIGHT_MAX_TOKENS);
    expect(opts.agentId).toBe("observer");
  });
});
