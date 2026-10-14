/**
 * NEXUS agent ↔ workflow parity.
 *
 * agents/nexus.ts (manual fallback) and workflows/nexusRun.ts (the live
 * 4-hourly path) upsert the SAME infrastructure_clusters rows and stamp the
 * SAME threats. They drifted for months when each carried its own copy of
 * the lane SQL (random-UUID ASN ids in the workflow only; the per-IP lane
 * missing from the workflow). The lanes now live once in
 * lib/nexus-threat-lanes.ts. This test pins that structurally (both files
 * call the shared lanes, in precedence order, and carry no threats-lane SQL
 * of their own) AND behaviourally (both paths, run over identical seeded
 * databases, leave byte-identical cluster rows and threat stamps).
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { seedScenario } from "./nexus-fixtures";
import { runNexus } from "../src/agents/nexus";
import { NexusWorkflow } from "../src/workflows/nexusRun";
import type { Env } from "../src/types";

const src = (p: string) => readFileSync(resolve(__dirname, "..", "src", p), "utf8");

const LANE_ORDER = [
  "runCertSerialLane(",
  "runCertSanLane(",
  "runPerIpLane(",
  "runSubnetLane(",
  "runRegistrarLane(",
  "runAsnLane(",
  "retireNonOperationalLaneClusters(",
  "groupClusterComponents(",
  "detectClusterInfraMovement(",
];

describe("NEXUS lane parity — structural", () => {
  for (const file of ["agents/nexus.ts", "workflows/nexusRun.ts"]) {
    it(`${file} calls every shared lane in precedence order`, () => {
      const text = src(file);
      let last = -1;
      for (const call of LANE_ORDER) {
        const at = text.indexOf(call, last + 1);
        expect(at, `${file}: ${call} missing or out of order`).toBeGreaterThan(last);
        last = at;
      }
    });

    it(`${file} carries no threats-lane SQL of its own`, () => {
      const text = src(file);
      expect(text).not.toMatch(/UPDATE threats SET cluster_id/);
      expect(text).not.toMatch(/FROM threats/);
    });
  }
});

type Snapshot = { clusters: unknown[]; stamps: unknown[]; pivots: number };

function snapshot(raw: SqliteDb): Snapshot {
  return {
    clusters: raw.prepare(
      `SELECT id, cluster_name, asns, countries, country_counts, attack_types, brand_ids,
              hosting_provider_ids, threat_count, confidence_score, status, agent_notes, component_id
         FROM infrastructure_clusters ORDER BY id`,
    ).all(),
    stamps: raw.prepare("SELECT id, cluster_id FROM threats ORDER BY id").all(),
    pivots: (raw.prepare("SELECT COUNT(*) AS n FROM agent_events WHERE event_type = 'pivot_detected'").all()[0] as { n: number }).n,
  };
}

function seededDb(): { raw: SqliteDb; db: D1Database } {
  const raw = openMigratedDb();
  seedScenario(raw);
  // Pre-existing stale rows both paths must retire identically.
  const ins = raw.prepare(
    `INSERT INTO infrastructure_clusters (id, cluster_name, asns, attack_types, brand_ids, status, threat_count)
     VALUES (?, ?, ?, ?, '[]', 'active', 1)`,
  );
  ins.run("cluster_asn_as13335_phishing", "CA AS13335 phishing cluster", '["AS13335"]', '["phishing"]');
  ins.run("cluster_asn_as13335_cloudflare_inc_phishing", "x", '["AS13335 Cloudflare, Inc."]', '["phishing"]');
  return { raw, db: d1FromSqlite(raw) };
}

describe.skipIf(!hasSqlite())("NEXUS lane parity — behavioural", () => {
  it("agent and workflow leave identical clusters, stamps and pivots", async () => {
    const a = seededDb();
    const env = (db: D1Database) => ({ DB: db, CACHE: fakeKv() }) as unknown as Env;
    await runNexus(a.db, env(a.db));

    const w = seededDb();
    const wf = new NexusWorkflow({} as never, env(w.db));
    const step = {
      do: async (_name: string, optsOrFn: unknown, maybeFn?: () => Promise<unknown>) =>
        (typeof optsOrFn === "function" ? (optsOrFn as () => Promise<unknown>)() : maybeFn!()),
    };
    await wf.run({ payload: {}, timestamp: new Date(), instanceId: "test" } as never, step as never);

    const sa = snapshot(a.raw);
    const sw = snapshot(w.raw);
    expect(sa.clusters.length).toBeGreaterThan(0);
    expect(sw.clusters).toEqual(sa.clusters);
    expect(sw.stamps).toEqual(sa.stamps);
    expect(sw.pivots).toBe(sa.pivots);
  });
});
