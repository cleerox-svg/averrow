/**
 * Flight Control's AI spend-burst alert names the top-cost agent from
 * budget_ledger (budget family, telemetry ∪ core). Until 2026-11-23 it read
 * agent_runs.cost_usd — a column agent_runs never had — so the statement
 * threw and the catch swallowed the whole alert.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FC_SPEND_BURST_TOP_AGENT_SQL } from "../src/agents/flightControl";
import { unionGrouped, type ReadPart } from "../src/lib/telemetry-read";
import { d1FromSqlite, hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";

const src = readFileSync(fileURLToPath(new URL("../src/agents/flightControl.ts", import.meta.url)), "utf8");

function ledger(rows: Array<[string, string, number, number]>): SqliteDb {
  const db = openDerivedDb(["budget_ledger"]);
  const ins = db.prepare(
    `INSERT INTO budget_ledger (id, agent_id, model, input_tokens, output_tokens, cost_usd, created_at)
     VALUES (?, ?, 'claude-haiku', 1, 1, ?, datetime('now', ?))`,
  );
  for (const [id, agent, cost, hoursAgo] of rows) ins.run(id, agent, cost, `-${hoursAgo} hours`);
  return db;
}

describe("FC spend-burst top-agent query", () => {
  it("reads budget_ledger, never agent_runs.cost_usd", () => {
    expect(FC_SPEND_BURST_TOP_AGENT_SQL).toMatch(/FROM budget_ledger/);
    expect(FC_SPEND_BURST_TOP_AGENT_SQL).toContain("/*split*/");
    expect(src).not.toMatch(/SUM\(cost_usd\)[\s\S]{0,40}FROM agent_runs/);
    expect(src).toMatch(/historyParts\(env, 'budget_ledger', \{ core: db \}\)/);
  });

  it.skipIf(!hasSqlite())("agent_runs has no cost_usd column (migration-derived schema)", () => {
    const db = openDerivedDb(["agent_runs"]);
    const cols = (db.prepare(`PRAGMA table_info(agent_runs)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("cost_usd");
  });

  it.skipIf(!hasSqlite())("sums the last 24h per agent across telemetry ∪ core and picks the top one", async () => {
    const telemetry = ledger([["t1", "observer", 0.5, 1], ["t2", "narrator", 0.4, 2], ["t-old", "narrator", 9, 30]]);
    const core = ledger([["c1", "narrator", 0.3, 3], ["c-zero", "campaign_hunter", 0, 1]]);
    const parts: ReadPart[] = [
      { source: "telemetry", db: d1FromSqlite(telemetry), split: "", splitBinds: [] },
      { source: "core", db: d1FromSqlite(core), split: "", splitBinds: [] },
    ];
    const rows = await unionGrouped<{ agent_id: string; cost: number }>(
      parts,
      () => ({ sql: FC_SPEND_BURST_TOP_AGENT_SQL, binds: [] }),
      { groupBy: ["agent_id"], sum: ["cost"], sort: (a, b) => b.cost - a.cost, limit: 1 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_id).toBe("narrator");
    expect(rows[0]!.cost).toBeCloseTo(0.7, 6);
  });
});
