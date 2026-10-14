// infrastructure_clusters: the repo's migrations vs prod's real table.
//
// Prod's table was created outside the migrations (0136 header). These tests
// pin that a FRESH full migration run lands on exactly prod's column set (so
// handlers selecting last_updated / nexus_brief work on fresh DBs and in
// tests without hand-added columns), and run the cluster readers that once
// selected a column prod lacks (created_at) against prod's literal DDL.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";
import { PROD_CLUSTERS_DDL, PROD_CLUSTERS_COLUMNS } from "./prod-cluster-ddl";
import { handleTrendNexusActive } from "../src/handlers/trends";
import { handleListClusters, handleProviderClusters } from "../src/handlers/providers";
import { handleAttributionBacklog } from "../src/handlers/admin/attribution";
import type { Env } from "../src/types";

const MIGRATIONS = resolve(__dirname, "..", "migrations");

const columns = (raw: SqliteDb): string[] =>
  (raw.prepare("PRAGMA table_info(infrastructure_clusters)").all() as Array<{ name: string }>).map((c) => c.name);

/**
 * Prod-shaped DB: prod's literal DDL, the indexes every pre-0302 migration
 * put on the table, then 0303–0306 applied the way the deploy does.
 */
function openProdDdlDb(): SqliteDb {
  const raw = openMigratedDb();
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("DROP TABLE infrastructure_clusters");
  raw.exec("DROP TABLE IF EXISTS cluster_repoint_log");
  raw.exec(PROD_CLUSTERS_DDL);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files.filter((f) => f < "0302")) {
    for (const stmt of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) {
      if (/^CREATE\s+(UNIQUE\s+)?INDEX\b[\s\S]*\bON\s+infrastructure_clusters\b/i.test(stmt)) raw.exec(stmt);
    }
  }
  for (const prefix of ["0303", "0304", "0305", "0306"]) {
    const file = files.find((f) => f.startsWith(`${prefix}_`))!;
    for (const stmt of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) raw.exec(stmt);
  }
  raw.exec("PRAGMA foreign_keys = ON"); // D1 enforces FKs
  return raw;
}

function envFor(raw: SqliteDb): { env: Env; log: StatementLogEntry[] } {
  const log: StatementLogEntry[] = [];
  return { env: { DB: d1FromSqlite(raw, { log }), CACHE: fakeKv() } as unknown as Env, log };
}

describe.skipIf(!hasSqlite())("infrastructure_clusters schema: fresh migrations == prod", () => {
  it("a fresh full migration run succeeds and yields exactly prod's columns, in prod's order", () => {
    let raw: SqliteDb | undefined;
    expect(() => { raw = openMigratedDb(); }).not.toThrow();
    expect(columns(raw!)).toEqual([...PROD_CLUSTERS_COLUMNS]);
  });

  it("prod's DDL + 0303 has the same column set (the fixture is consistent)", () => {
    expect(columns(openProdDdlDb())).toEqual([...PROD_CLUSTERS_COLUMNS]);
  });

  it("0136's base CREATE carries none of the columns a later migration ADDs (each ADD COLUMN still succeeds)", () => {
    const added = new Set<string>();
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
      for (const stmt of splitStatements(readFileSync(join(MIGRATIONS, file), "utf8"))) {
        const m = /^ALTER\s+TABLE\s+infrastructure_clusters\s+ADD\s+COLUMN\s+(\w+)/i.exec(stmt);
        if (m) added.add(m[1]!);
      }
    }
    expect([...added].sort()).toEqual([
      "actor_id", "attribution_attempted_at", "component_id", "country_counts",
      "infra_fingerprint", "infra_fingerprint_at", "last_movement_pivot_at", "retired_reason",
      "attribution_dismissed_at",
    ].sort());
    const create = splitStatements(readFileSync(join(MIGRATIONS, "0136_cluster_actor_attribution.sql"), "utf8"))
      .find((s) => /^CREATE TABLE IF NOT EXISTS infrastructure_clusters/i.test(s))!;
    const body = create.replace(/--[^\n]*/g, "");
    for (const col of added) expect(new RegExp(`\\b${col}\\b`).test(body), col).toBe(false);
  });
});

describe.skipIf(!hasSqlite())("cluster readers against prod's literal DDL", () => {
  function seeded(): SqliteDb {
    const raw = openProdDdlDb();
    const ins = raw.prepare(
      `INSERT INTO infrastructure_clusters (id, cluster_name, asns, threat_count, status, agent_notes, first_detected, retired_reason)
       VALUES (?, ?, '["AS4837"]', ?, ?, ?, ?, ?)`,
    );
    ins.run("cluster_asn_as4837_phishing", "AS4837 · phishing", 40, "active", "ACCELERATING: x", "2026-10-01 00:00:00", null);
    ins.run("cluster_ip_203.0.113.7", "IP 203.0.113.7", 30, "active", null, "2026-10-02 00:00:00", null);
    ins.run("cluster_asn_as4837_malware_distribution", "AS4837 · malware", 20, "disrupted", null, "2026-10-03 00:00:00", null);
    ins.run("11111111-0000-4000-8000-000000000001", "legacy", 9000, "active", null, "2026-09-01 00:00:00", "superseded");
    raw.prepare("INSERT INTO hosting_providers (id, name, asn) VALUES ('hp_cu', 'China Unicom', 'AS4837')").run();
    return raw;
  }

  it("GET /api/trends/nexus-active returns 200 with created_at = first_detected (field name unchanged)", async () => {
    const { env, log } = envFor(seeded());
    const res = await handleTrendNexusActive(new Request("https://averrow.com/api/trends/nexus-active"), env);
    expect(res.status, JSON.stringify(log.filter((e) => e.error))).toBe(200);
    const body = await res.json() as { data: Array<{ id: string; label: string; severity: string; created_at: string; threat_count: number }> };
    expect(body.data).toEqual([
      { id: "cluster_asn_as4837_phishing", label: "AS4837 · phishing", threat_count: 40, severity: "high", created_at: "2026-10-01 00:00:00" },
      { id: "cluster_ip_203.0.113.7", label: "IP 203.0.113.7", threat_count: 30, severity: "medium", created_at: "2026-10-02 00:00:00" },
    ]);
  });

  it("the old created_at SELECT fails on prod's DDL (the 500, reproduced)", () => {
    const raw = seeded();
    expect(() => raw.prepare("SELECT created_at FROM infrastructure_clusters").all()).toThrow(/no such column: created_at/);
  });

  it("clusters list and per-provider clusters run on prod's DDL and include disrupted operations", async () => {
    const { env, log } = envFor(seeded());
    const list = await handleListClusters(new Request("https://averrow.com/api/providers/clusters"), env);
    expect(list.status, JSON.stringify(log.filter((e) => e.error))).toBe(200);
    const lb = await list.json() as { data: Array<{ id: string }> };
    expect(lb.data.map((r) => r.id)).toEqual([
      "cluster_asn_as4837_phishing", "cluster_ip_203.0.113.7", "cluster_asn_as4837_malware_distribution",
    ]);
    const prov = await handleProviderClusters(new Request("https://averrow.com/api/providers/hp_cu/clusters"), env, "hp_cu");
    expect(prov.status).toBe(200);
    const pb = await prov.json() as { data: Array<{ id: string }> };
    expect(pb.data.map((r) => r.id)).toEqual(lb.data.map((r) => r.id));
  });

  it("attribution backlog runs on prod's DDL (nexus_brief + the pinned partial index)", async () => {
    const { env, log } = envFor(seeded());
    const res = await handleAttributionBacklog(new Request("https://averrow.com/api/admin/agents/attribution-backlog?limit=10"), env);
    expect(res.status, JSON.stringify(log.filter((e) => e.error))).toBe(200);
  });
});
