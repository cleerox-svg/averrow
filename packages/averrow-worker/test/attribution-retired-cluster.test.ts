// POST /api/admin/clusters/:id/attribution and .../attribution/dismiss must refuse
// a retired cluster (retired_reason set — lib/cluster-status.ts): it is not an
// operation, so attributing it would fan an actor out to threats through a
// row no list shows. Live clusters keep working.

import { describe, it, expect, beforeEach } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import { handleAttributeCluster, handleDismissClusterAttribution } from "../src/handlers/admin/attribution";
import type { Env } from "../src/types";

describe.skipIf(!hasSqlite())("attribute / dismiss by cluster id — retired clusters are refused", () => {
  let raw: SqliteDb;
  let env: Env;
  const audited: unknown[][] = [];

  const cluster = (id: string) =>
    raw.prepare("SELECT actor_id, attribution_dismissed_at, retired_reason FROM infrastructure_clusters WHERE id = ?").all(id)[0] as
      { actor_id: string | null; attribution_dismissed_at: string | null; retired_reason: string | null };

  const attribute = (id: string) => handleAttributeCluster(
    new Request(`https://averrow.com/api/admin/clusters/${id}/attribution`, {
      method: "POST", body: JSON.stringify({ actor_id: "ta_1" }), headers: { "Content-Type": "application/json" },
    }), env, id, "usr_admin");
  const dismiss = (id: string) => handleDismissClusterAttribution(
    new Request(`https://averrow.com/api/admin/clusters/${id}/attribution/dismiss`, { method: "POST" }), env, id, "usr_admin");

  beforeEach(() => {
    raw = openMigratedDb();
    audited.length = 0;
    const auditDb = {
      prepare: () => ({ bind: (...args: unknown[]) => ({ run: async () => { audited.push(args); return { meta: { changes: 1 } }; } }) }),
    };
    env = { DB: d1FromSqlite(raw), AUDIT_DB: auditDb, CACHE: fakeKv() } as unknown as Env;
    raw.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta_1', 'Actor One')").run();
    const ins = raw.prepare(
      "INSERT INTO infrastructure_clusters (id, cluster_name, asns, threat_count, status, retired_reason) VALUES (?, ?, '[\"AS4837\"]', 10, 'active', ?)",
    );
    ins.run("cluster_asn_as4837_phishing", "live", null);
    ins.run("11111111-0000-4000-8000-000000000001", "legacy", "superseded");
    ins.run("cluster_ip_13.248.169.48", "hub", "shared_infra");
  });

  for (const id of ["11111111-0000-4000-8000-000000000001", "cluster_ip_13.248.169.48"]) {
    it(`attribute refuses retired ${id} with 409 and writes nothing`, async () => {
      const res = await attribute(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ success: false, error: "Cluster is retired (not an operation)" });
      expect(cluster(id).actor_id).toBeNull();
      expect(audited).toEqual([]);
    });

    it(`dismiss refuses retired ${id} with 409 and writes nothing`, async () => {
      const res = await dismiss(id);
      expect(res.status).toBe(409);
      expect(cluster(id).attribution_dismissed_at).toBeNull();
      expect(audited).toEqual([]);
    });
  }

  it("a live cluster is still attributed / dismissed", async () => {
    const res = await attribute("cluster_asn_as4837_phishing");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(cluster("cluster_asn_as4837_phishing").actor_id).toBe("ta_1");

    raw.prepare("UPDATE infrastructure_clusters SET actor_id = NULL WHERE id = 'cluster_asn_as4837_phishing'").run();
    const d = await dismiss("cluster_asn_as4837_phishing");
    expect(d.status).toBe(200);
    expect(cluster("cluster_asn_as4837_phishing").attribution_dismissed_at).not.toBeNull();
  });

  it("unknown ids stay 404; an already-attributed live cluster is still 404 on dismiss", async () => {
    expect((await attribute("cluster_nope")).status).toBe(404);
    expect((await dismiss("cluster_nope")).status).toBe(404);
    raw.prepare("UPDATE infrastructure_clusters SET actor_id = 'ta_1' WHERE id = 'cluster_asn_as4837_phishing'").run();
    expect((await dismiss("cluster_asn_as4837_phishing")).status).toBe(404);
  });
});
