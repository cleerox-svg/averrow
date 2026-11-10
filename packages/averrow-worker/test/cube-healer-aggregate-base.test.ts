/**
 * cube_healer — D1 spike follow-ups (2026-11-10).
 *
 *  1. The weekly statistics refresh no longer runs a table-scoped
 *     `ANALYZE threats` (one ~89M-row statement in prod: ~1.55M rows x ~59
 *     indexes). Only `ANALYZE brands` remains.
 *  2. Every run refreshes the Threats aggregate base
 *     (lib/threat-aggregates.ts) through a read-replica session and writes it
 *     to KV, so the HTTP path never runs that scan on a page view.
 */

import { describe, it, expect } from "vitest";
import { cubeHealerAgent, CUBE_HEALER_ANALYZE_SQL } from "../src/agents/cube-healer";
import type { AgentContext } from "../src/lib/agentRunner";
import type { Env } from "../src/types";
import { fakeKv } from "./sqlite-d1-harness";
import { THREAT_AGGREGATE_BASE_KEY, THREAT_AGGREGATE_BASE_SQL } from "../src/lib/threat-aggregates";

function stubDb(log: { sql: string; via: "primary" | "session" }[]) {
  const mk = (via: "primary" | "session") => ({
    prepare: (sql: string) => {
      log.push({ sql, via });
      const stmt = {
        bind: () => stmt,
        run: async () => ({ meta: { changes: 0 } }),
        all: async () => ({
          results: sql === THREAT_AGGREGATE_BASE_SQL
            ? [{ status: "active", severity: "high", threat_type: "phishing", country_code: "US", n: 4, confirmed: 1, correlated_by_campaign: 2 }]
            : [],
        }),
        first: async () => null,
      };
      return stmt;
    },
    batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 0 } })),
  });
  const primary = mk("primary");
  return { ...primary, withSession: () => mk("session") } as unknown as D1Database;
}

describe("cube_healer — weekly ANALYZE + aggregate base refresh", () => {
  it("the weekly ANALYZE is brands-only: no table-scoped ANALYZE threats", async () => {
    expect(CUBE_HEALER_ANALYZE_SQL).toBe("ANALYZE brands");
    const log: { sql: string; via: "primary" | "session" }[] = [];
    const kv = fakeKv(); // no last_analyze_at stamp → the weekly ANALYZE is due
    const env = { DB: stubDb(log), CACHE: kv } as unknown as Env;
    await cubeHealerAgent.execute({ env, input: { scheduledTime: "2026-05-21T06:12:00Z" } } as unknown as AgentContext);
    const analyzes = log.map((e) => e.sql.trim()).filter((q) => /^ANALYZE\b/i.test(q));
    expect(analyzes).toEqual(["ANALYZE brands"]);
    expect(kv.store.has("cube_healer:last_analyze_at")).toBe(true);
  });

  it("refreshes the Threats aggregate base through a read session and writes it to KV", async () => {
    const log: { sql: string; via: "primary" | "session" }[] = [];
    const kv = fakeKv({ "cube_healer:last_analyze_at": String(Date.now()) });
    const env = { DB: stubDb(log), CACHE: kv } as unknown as Env;
    const res = await cubeHealerAgent.execute({ env, input: { scheduledTime: "2026-05-21T06:12:00Z" } } as unknown as AgentContext);
    const baseReads = log.filter((e) => e.sql === THREAT_AGGREGATE_BASE_SQL);
    expect(baseReads.map((e) => e.via)).toEqual(["session"]);
    const raw = kv.store.get(`cv:${THREAT_AGGREGATE_BASE_KEY}`);
    expect(raw).toBeDefined();
    const entry = JSON.parse(raw!) as { v: { total: number; confirmed: number; top_countries: unknown[] } };
    expect(entry.v.total).toBe(4);
    expect(entry.v.confirmed).toBe(1);
    expect(entry.v.top_countries).toEqual([{ country: "US", count: 4 }]);
    expect((res.agentOutputs ?? []).some((o) => (o.details as { stage?: string } | undefined)?.stage === "threat_aggregate_base")).toBe(false);
  });
});
