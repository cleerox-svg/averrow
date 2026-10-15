// GET /api/providers/:id/clusters — the cluster ↔ provider ASN match is
// exact. It used to be `asns LIKE '%AS4837%'`, which also returned clusters
// on AS48370 / AS148370 etc. (prefix/substring bug). The handler now keeps
// the LIKE only as a prefilter and compares each `asns` element through
// asnKeySql (lib/shared-infra-asns.ts), the SQL twin of asnKey.

import { describe, it, expect, beforeAll } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleProviderClusters } from "../src/handlers/providers";
import type { Env } from "../src/types";

describe.skipIf(!hasSqlite())("provider clusters: exact ASN match", () => {
  let db: SqliteDb;

  beforeAll(() => {
    db = openMigratedDb();
    const s = db.prepare(`INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, retired_reason, asns)
      VALUES (?, ?, ?, ?, ?, ?)`);
    s.run("cluster_asn_exact", "exact", 50, "active", null, '["AS4837"]');
    s.run("cluster_asn_bare", "bare digits", 40, "dormant", null, '["4837"]');
    s.run("cluster_asn_number", "json number", 30, "disrupted", null, "[4837]");
    s.run("cluster_asn_orgform", "org form", 20, "active", null, '["AS4837 China Unicom"]');
    s.run("cluster_asn_second", "second element", 10, "active", null, '["AS9009","as4837"]');
    s.run("cluster_asn_longer", "AS48370", 900, "active", null, '["AS48370"]');
    s.run("cluster_asn_suffix", "AS14837", 800, "active", null, '["AS14837"]');
    s.run("cluster_asn_concat", "joined", 700, "active", null, '["AS4837x"]');
    s.run("cluster_asn_badjson", "malformed", 600, "active", null, 'AS4837 not json');
    s.run("cluster_asn_retired", "retired", 500, "active", "shared_infra", '["AS4837"]');
    const hp = db.prepare("INSERT INTO hosting_providers (id, name, asn) VALUES (?, ?, ?)");
    hp.run("hp_cu", "China Unicom", "AS4837");
    hp.run("hp_digits", "Digits only", "4837");
    hp.run("hp_none", "No ASN", null);
  }, 60_000);

  const call = async (id: string) => {
    const env = { DB: d1FromSqlite(db), CACHE: fakeKv() } as unknown as Env;
    const res = await handleProviderClusters(new Request(`https://averrow.com/api/providers/${id}/clusters`), env, id);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
  };

  const EXPECTED = ["cluster_asn_exact", "cluster_asn_bare", "cluster_asn_number", "cluster_asn_orgform", "cluster_asn_second"];

  it("returns every live cluster carrying the ASN in any accepted form, by threat_count, and nothing that merely contains it", async () => {
    expect(await call("hp_cu")).toEqual(EXPECTED);
  });

  it("a provider whose asn is stored as bare digits matches the same set", async () => {
    expect(await call("hp_digits")).toEqual(EXPECTED);
  });

  it("no ASN / unknown provider → empty", async () => {
    expect(await call("hp_none")).toEqual([]);
    expect(await call("hp_missing")).toEqual([]);
  });
});
