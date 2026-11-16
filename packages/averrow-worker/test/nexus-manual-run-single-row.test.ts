// A manual / API NEXUS run (executeAgent on agents/nexus.ts) writes exactly
// ONE agent_runs row — executeAgent's — finalized with completed_at,
// duration_ms and records_processed. Before 2026-11-16 the module INSERTed a
// second, already-'success' row of its own (ISO started_at,
// records_processed = clustersWritten), double-counting every manual run in
// /api/agents, diagnostics agent_mesh, the status page and the run tape.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv } from "./sqlite-d1-harness";
import { seedScenario } from "./nexus-fixtures";
import { executeAgent } from "../src/lib/agentRunner";
import { nexusAgent } from "../src/agents/nexus";
import type { Env } from "../src/types";

afterEach(() => vi.restoreAllMocks());

describe("agents/nexus.ts writes no agent_runs of its own", () => {
  it("has no agent_runs SQL and does not declare an agent_runs write", () => {
    const text = readFileSync(resolve(__dirname, "..", "src", "agents", "nexus.ts"), "utf8");
    expect(text).not.toMatch(/INSERT INTO agent_runs/);
    expect(nexusAgent.writes.some((w) => w.name === "agent_runs")).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("manual NEXUS run via executeAgent", () => {
  it("writes exactly one agent_runs row with its completion fields, plus nexus_complete", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const raw = openMigratedDb();
    seedScenario(raw);
    raw.exec(`INSERT OR IGNORE INTO agent_approvals (agent_id, state, requested_at) VALUES ('nexus', 'approved', datetime('now'))`);
    raw.exec(`UPDATE agent_approvals SET state = 'approved' WHERE agent_id = 'nexus'`);
    const env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;

    const out = await executeAgent(env, nexusAgent, {}, "user_1", "manual");
    expect(out.runId).not.toBe("");
    expect(out.status).toBe("success");

    const rows = raw.prepare(
      "SELECT id, status, started_at, completed_at, duration_ms, records_processed, error_message FROM agent_runs WHERE agent_id = 'nexus'",
    ).all() as Array<{ id: string; status: string; started_at: string; completed_at: string | null; duration_ms: number | null; records_processed: number; error_message: string | null }>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(out.runId);
    expect(row.status).toBe("success");
    expect(row.completed_at).not.toBeNull();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.error_message).toBeNull();
    // executeAgent records itemsProcessed (= clusters written + providers updated).
    expect(row.records_processed).toBe(out.result!.itemsProcessed);
    expect(row.records_processed).toBeGreaterThan(0);

    const events = raw.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE event_type = 'nexus_complete' AND source_agent = 'nexus'").all() as Array<{ n: number }>;
    expect(events[0]!.n).toBe(1);
  });
});
