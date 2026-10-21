// OTX actor inheritance policy, end-to-end on the migrated SQLite schema.
//
// Threat-intel review (prod, read-only, 2026-10-21): all 34 then-winning
// single-actor clusters were indefensible. The worst,
// cluster_asn_as4837_malware_distribution (33,119 members on 19,596 IPs),
// had ONE OTX-attributed member and would have labelled every member with
// that actor. The per-IP / subnet winners sat on multi-tenant hosting or
// parking (Hostinger AS47583, Squarespace AS53831, Amazon AS16509, …) while
// the cluster's own `asns` column read `[]`, because members with a NULL
// asn formed the cluster. These tests pin the policy that replaces the old
// "one agreeing actor" rule.

import { describe, it, expect, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";
import { inheritOtxActorsToClusters } from "../src/lib/cluster-attribution-inherit";

interface Seed {
  id: string;
  /** OTX-attributed members (all naming `actor`). */
  otx: number;
  /** Un-attributed members. */
  plain: number;
  asn?: string | null;
  /** asn for only the un-attributed members (overrides `asn` for them). */
  plainAsn?: string | null;
  asnsColumn?: string;
  agentNotes?: string | null;
}

function seedCluster(raw: SqliteDb, s: Seed, actor = "ta_1"): void {
  raw.prepare(
    "INSERT INTO infrastructure_clusters (id, cluster_name, threat_count, status, asns, agent_notes) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run(s.id, s.id, s.otx + s.plain, s.asnsColumn ?? "[]", s.agentNotes ?? null);
  const threat = raw.prepare("INSERT INTO threats (id, source_feed, threat_type, cluster_id, asn) VALUES (?, 'test', 'phishing', ?, ?)");
  const attr = raw.prepare("INSERT INTO threat_attributions (id, threat_id, actor_id, source) VALUES (?, ?, ?, 'otx')");
  for (let i = 0; i < s.otx; i++) {
    const tid = `${s.id}#otx${i}`;
    threat.run(tid, s.id, s.asn ?? null);
    attr.run(`otx_${tid}`, tid, actor);
  }
  for (let i = 0; i < s.plain; i++) {
    threat.run(`${s.id}#m${i}`, s.id, s.plainAsn !== undefined ? s.plainAsn : (s.asn ?? null));
  }
}

const inheritedRows = (raw: SqliteDb, clusterId: string): number =>
  (raw.prepare(
    "SELECT COUNT(*) AS n FROM threat_attributions ta JOIN threats t ON t.id = ta.threat_id WHERE t.cluster_id = ? AND ta.id LIKE 'tat_otxinherit_%'",
  ).all(clusterId)[0] as { n: number }).n;

const clusterActor = (raw: SqliteDb, clusterId: string): string | null =>
  (raw.prepare("SELECT actor_id FROM infrastructure_clusters WHERE id = ?").all(clusterId)[0] as { actor_id: string | null }).actor_id;

describe.skipIf(!hasSqlite())("attributor — OTX inheritance policy (2026-10-21 review)", () => {
  let raw: SqliteDb;
  let db: D1Database;

  beforeEach(() => {
    raw = openMigratedDb();
    db = d1FromSqlite(raw);
    raw.prepare("INSERT INTO threat_actors (id, name) VALUES ('ta_1', 'PurpleDelta')").run();
  });

  it("ASN-lane cluster with one OTX member among many: no rows written, no actor stamp", async () => {
    const id = "cluster_asn_as4837_malware_distribution";
    seedCluster(raw, { id, otx: 1, plain: 400, asn: "AS4837", asnsColumn: '["AS4837"]' });

    const r = await inheritOtxActorsToClusters(db);

    expect(r.clusters_scanned).toBe(1);
    expect(r.clusters_skipped_lane).toBe(1);
    expect(r.members_attributed).toBe(0);
    expect(r.clusters_actor_set).toBe(0);
    expect(inheritedRows(raw, id)).toBe(0);
    expect(clusterActor(raw, id)).toBeNull();
  });

  it("ASN-lane cluster is rejected on lane alone, even with a quorate, well-covered OTX set", async () => {
    const id = "cluster_asn_as64500_phishing";
    seedCluster(raw, { id, otx: 10, plain: 20, asn: "AS64500" });
    const r = await inheritOtxActorsToClusters(db);
    expect(r.clusters_skipped_lane).toBe(1);
    expect(inheritedRows(raw, id)).toBe(0);
    expect(clusterActor(raw, id)).toBeNull();
  });

  it("per-IP cluster on a multi-tenant ASN is skipped although cluster.asns is '[]'", async () => {
    // Members that formed the cluster carry a NULL asn (hence asns '[]'),
    // but the OTX-attributed ones are on Hostinger in the geo-lookup form.
    const id = "cluster_ip_145.223.0.10";
    seedCluster(raw, {
      id, otx: 3, plain: 12, asn: "AS47583 Hostinger International Limited", plainAsn: null, asnsColumn: "[]",
    });

    const r = await inheritOtxActorsToClusters(db);

    expect(r.clusters_skipped_multitenant).toBe(1);
    expect(r.members_attributed).toBe(0);
    expect(inheritedRows(raw, id)).toBe(0);
    expect(clusterActor(raw, id)).toBeNull();
  });

  it("a qualifying per-IP cluster is stamped and its members written", async () => {
    // 3 agreeing OTX members of 20 (15%), on a non-multi-tenant ASN; some
    // members carry no asn at all (not evidence of shared hosting).
    const id = "cluster_ip_198.51.100.23";
    seedCluster(raw, { id, otx: 3, plain: 17, asn: "AS64500", plainAsn: null });

    const r = await inheritOtxActorsToClusters(db);

    expect(r.clusters_inherited).toBe(1);
    expect(r.clusters_actor_set).toBe(1);
    expect(r.members_attributed).toBe(17);
    expect(inheritedRows(raw, id)).toBe(17);
    expect(clusterActor(raw, id)).toBe("ta_1");
    const rows = raw.prepare(
      "SELECT DISTINCT ta.actor_id, ta.source, ta.confidence FROM threat_attributions ta WHERE ta.id LIKE 'tat_otxinherit_%'",
    ).all();
    expect(rows).toEqual([{ actor_id: "ta_1", source: "nexus", confidence: "low" }]);

    const again = await inheritOtxActorsToClusters(db);
    expect(again.members_attributed).toBe(0);
    expect(again.clusters_actor_set).toBe(0);
  });

  it("counts each policy rule's skips and only the qualifying cluster inherits", async () => {
    seedCluster(raw, { id: "cluster_subnet_203_0_113", otx: 5, plain: 10, asn: "AS64500" });          // lane
    seedCluster(raw, { id: "cluster_registrar_namecheap", otx: 5, plain: 10, asn: "AS64500" });       // lane
    seedCluster(raw, { id: "cluster_ip_203.0.113.1", otx: 1, plain: 3, asn: "AS64500" });             // quorum
    seedCluster(raw, { id: "cluster_ip_203.0.113.2", otx: 2, plain: 30, asn: "AS64500" });            // coverage (2/32)
    seedCluster(raw, { id: "cluster_ip_203.0.113.3", otx: 30, plain: 230, asn: "AS64500" });          // size (260)
    seedCluster(raw, { id: "cluster_ip_203.0.113.4", otx: 3, plain: 5, asn: "AS64500", plainAsn: "53831" }); // multitenant (Squarespace)
    seedCluster(raw, {
      id: "cluster_cert_serial_0a1b", otx: 2, plain: 8, asn: "AS64500",
      agentNotes: JSON.stringify({ cluster_type: "ssl_cert_serial", ssl_cert_serial: "0a1b" }),
    });                                                                                                // qualifies

    const r = await inheritOtxActorsToClusters(db);

    expect(r).toMatchObject({
      clusters_scanned: 7,
      clusters_skipped_lane: 2,
      clusters_skipped_quorum: 1,
      clusters_skipped_coverage: 1,
      clusters_skipped_size: 1,
      clusters_skipped_multitenant: 1,
      clusters_ambiguous: 0,
      clusters_inherited: 1,
      clusters_actor_set: 1,
      members_attributed: 8,
      stopped_reason: null,
    });
    expect(clusterActor(raw, "cluster_cert_serial_0a1b")).toBe("ta_1");
    const stamped = raw.prepare("SELECT COUNT(*) AS n FROM infrastructure_clusters WHERE actor_id IS NOT NULL").all()[0] as { n: number };
    expect(stamped.n).toBe(1);
  });
});
