import { describe, it, expect } from "vitest";
import {
  computeComponents,
  classifyClusterKind,
  extractBridgeKey,
  isBridgeKind,
  DEFAULT_HUB_FANOUT_THRESHOLD,
  DEFAULT_MAX_COMPONENT_SIZE,
  type ComponentClusterInput,
  type BridgeGroup,
  type ClusterKind,
} from "../src/lib/cluster-components";

// Pure-core tests for the NEXUS connected-components grouping layer.
// Mirrors test/cluster-attribution-inherit.test.ts / test/alert-triage.test.ts
// house style — deterministic fixtures, one behavior per test.

// ─── Fixture helpers ──────────────────────────────────────────────────

function cluster(id: string, kind: ClusterKind, brandFanout = 5): ComponentClusterInput {
  return { id, kind, brandFanout };
}

// ─── classifyClusterKind ──────────────────────────────────────────────

describe("classifyClusterKind", () => {
  it("maps id prefixes to kinds", () => {
    expect(classifyClusterKind("cluster_ip_1.2.3.4", null)).toBe("per_ip");
    expect(classifyClusterKind("cluster_subnet_1_2_3_", null)).toBe("subnet");
    expect(classifyClusterKind("cluster_registrar_foo", null)).toBe("registrar");
    expect(classifyClusterKind("cluster_asn_as13335_malware", null)).toBe("asn");
    expect(classifyClusterKind("cluster_dev_appstore_acme", null)).toBe("app_store");
    expect(classifyClusterKind("cluster_actor_telegram_x", null)).toBe("dark_web");
    // Workflow ASN lane mints random UUIDs → 'other' (receive-only).
    expect(classifyClusterKind("8f3a1c2e-1234-5678-9abc-def012345678", null)).toBe("other");
  });

  it("disambiguates cert-serial vs cert-SAN by agent_notes cluster_type", () => {
    expect(
      classifyClusterKind("cluster_cert_abc", JSON.stringify({ cluster_type: "ssl_cert_serial" })),
    ).toBe("cert_serial");
    expect(
      classifyClusterKind("cluster_cert_def", JSON.stringify({ cluster_type: "ssl_san_hash" })),
    ).toBe("cert_san");
    // cert-prefixed but unknown notes → defaults to serial (still a bridge kind).
    expect(classifyClusterKind("cluster_cert_ghi", null)).toBe("cert_serial");
  });
});

describe("isBridgeKind", () => {
  it("only cert-serial, cert-SAN, per-IP are bridge kinds", () => {
    expect(isBridgeKind("cert_serial")).toBe(true);
    expect(isBridgeKind("cert_san")).toBe(true);
    expect(isBridgeKind("per_ip")).toBe(true);
    expect(isBridgeKind("subnet")).toBe(false);
    expect(isBridgeKind("registrar")).toBe(false);
    expect(isBridgeKind("asn")).toBe(false);
    expect(isBridgeKind("other")).toBe(false);
  });
});

// ─── extractBridgeKey ─────────────────────────────────────────────────

describe("extractBridgeKey", () => {
  it("parses the IP from a per-IP cluster id", () => {
    expect(extractBridgeKey("per_ip", "cluster_ip_76.223.54.146", null)).toBe("76.223.54.146");
  });
  it("reads the serial / SAN hash from cert cluster agent_notes JSON", () => {
    expect(
      extractBridgeKey("cert_serial", "cluster_cert_x", JSON.stringify({ ssl_cert_serial: "0A1B2C" })),
    ).toBe("0A1B2C");
    expect(
      extractBridgeKey("cert_san", "cluster_cert_y", JSON.stringify({ ssl_san_hash: "deadbeef" })),
    ).toBe("deadbeef");
  });
  it("returns null when the key is missing / notes is a plain string", () => {
    expect(extractBridgeKey("cert_serial", "cluster_cert_z", "Per-IP fan-out: ...")).toBeNull();
    expect(extractBridgeKey("cert_serial", "cluster_cert_z", null)).toBeNull();
  });
});

// ─── computeComponents: empty / single ────────────────────────────────

describe("computeComponents — empty and single-cluster", () => {
  it("no clusters → no components", () => {
    const r = computeComponents([], []);
    expect(r.componentByCluster.size).toBe(0);
    expect(r.stats.componentsFormed).toBe(0);
  });

  it("single cluster with no bridges → no component_id", () => {
    const r = computeComponents([cluster("cluster_cert_a", "cert_serial")], []);
    expect(r.componentByCluster.size).toBe(0);
  });

  it("a specific cluster whose bridge links only to itself stays a singleton", () => {
    // The DISTINCT cluster_id seek for a lone cert serial returns just its
    // own id — no cross-union, no component.
    const clusters = [cluster("cluster_cert_a", "cert_serial")];
    const bridges: BridgeGroup[] = [{ bridgeId: "cluster_cert_a", linkedClusterIds: ["cluster_cert_a"] }];
    const r = computeComponents(clusters, bridges);
    expect(r.componentByCluster.size).toBe(0);
  });
});

// ─── computeComponents: transitive merge ──────────────────────────────

describe("computeComponents — transitive merge", () => {
  it("A~B by cert and B~C by IP collapse into one component", () => {
    // A = cert cluster, B = per-IP cluster, C = per-IP cluster.
    // Cert bridge A links {A, B}; IP bridge B links {B, C}. Transitively
    // A ~ B ~ C is one component.
    const clusters = [
      cluster("cluster_cert_A", "cert_serial"),
      cluster("cluster_ip_B", "per_ip"),
      cluster("cluster_ip_C", "per_ip"),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_cert_A", linkedClusterIds: ["cluster_cert_A", "cluster_ip_B"] },
      { bridgeId: "cluster_ip_B", linkedClusterIds: ["cluster_ip_B", "cluster_ip_C"] },
    ];
    const r = computeComponents(clusters, bridges);
    const ids = [...new Set(r.componentByCluster.values())];
    expect(ids).toHaveLength(1);
    // Representative = lexicographically-min BRIDGE cluster id.
    // min("cluster_cert_A","cluster_ip_B","cluster_ip_C") = cluster_cert_A.
    expect(r.componentByCluster.get("cluster_cert_A")).toBe("component_cluster_cert_A");
    expect(r.componentByCluster.get("cluster_ip_B")).toBe("component_cluster_cert_A");
    expect(r.componentByCluster.get("cluster_ip_C")).toBe("component_cluster_cert_A");
    expect(r.stats.componentsFormed).toBe(1);
    expect(r.stats.clustersGrouped).toBe(3);
  });

  it("a mop-up cluster is pulled in by a specific edge and RECEIVES the id", () => {
    // ASN cluster is receive-only: it can't bridge, but the per-IP bridge
    // pulls it into the component (it shares a member with the IP).
    const clusters = [
      cluster("cluster_ip_A", "per_ip"),
      cluster("cluster_asn_as1_malware", "asn"),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_ip_A", linkedClusterIds: ["cluster_ip_A", "cluster_asn_as1_malware"] },
    ];
    const r = computeComponents(clusters, bridges);
    expect(r.componentByCluster.get("cluster_asn_as1_malware")).toBe("component_cluster_ip_A");
    // Representative is the BRIDGE (per_ip) cluster, never the ASN member,
    // even though "cluster_asn_..." < "cluster_ip_..." lexicographically.
    expect(r.componentByCluster.get("cluster_ip_A")).toBe("component_cluster_ip_A");
  });
});

// ─── computeComponents: ASN/subnet/registrar are NOT bridges ──────────

describe("computeComponents — mop-up kinds never bridge", () => {
  it.each([
    ["asn", "cluster_asn_as1_x"],
    ["subnet", "cluster_subnet_1_2_3_"],
    ["registrar", "cluster_registrar_foo"],
    ["other", "random-uuid-cluster"],
  ] as Array<[ClusterKind, string]>)(
    "%s cluster passed as a bridge is dropped (no merge)",
    (kind, bridgeId) => {
      const clusters = [
        cluster(bridgeId, kind, 5),
        cluster("cluster_ip_victim", "per_ip", 5),
      ];
      // Even if the I/O layer erroneously offered a mop-up cluster as a
      // bridge, the pure fn refuses to union through it.
      const bridges: BridgeGroup[] = [
        { bridgeId, linkedClusterIds: [bridgeId, "cluster_ip_victim"] },
      ];
      const r = computeComponents(clusters, bridges);
      expect(r.componentByCluster.size).toBe(0);
      expect(r.stats.bridgesSkippedIneligible).toBe(1);
    },
  );
});

// ─── computeComponents: shared mop-up must NOT glue two operators ─────

describe("computeComponents — a shared receive-only cluster is never the glue", () => {
  it("two distinct bridge operators sharing one mop-up (/24) end in DIFFERENT components", () => {
    // The core invariant. cert_X's operator = {cert_X, ip_X}; cert_Y's
    // operator = {cert_Y, ip_Y}. BOTH cert_X and cert_Y happen to have a
    // member threat that also lands in subnet_S (a shared /24). subnet_S
    // must NOT transitively merge the two operators.
    const clusters = [
      cluster("cluster_cert_X", "cert_serial", 4),
      cluster("cluster_cert_Y", "cert_serial", 4),
      cluster("cluster_ip_X", "per_ip", 4),
      cluster("cluster_ip_Y", "per_ip", 4),
      cluster("cluster_subnet_S", "subnet", 40),
    ];
    const bridges: BridgeGroup[] = [
      // cert_X's serial appears in ip_X's cluster and in subnet_S.
      { bridgeId: "cluster_cert_X", linkedClusterIds: ["cluster_ip_X", "cluster_subnet_S"] },
      // cert_Y's serial appears in ip_Y's cluster and in subnet_S.
      { bridgeId: "cluster_cert_Y", linkedClusterIds: ["cluster_ip_Y", "cluster_subnet_S"] },
    ];
    const r = computeComponents(clusters, bridges);

    const compX = r.componentByCluster.get("cluster_cert_X");
    const compY = r.componentByCluster.get("cluster_cert_Y");
    // Both operators still form their OWN component…
    expect(compX).toBe("component_cluster_cert_X");
    expect(compY).toBe("component_cluster_cert_Y");
    // …and ip_X / ip_Y stay with their own operator.
    expect(r.componentByCluster.get("cluster_ip_X")).toBe(compX);
    expect(r.componentByCluster.get("cluster_ip_Y")).toBe(compY);
    // …but they are DIFFERENT components — never merged through subnet_S.
    expect(compX).not.toBe(compY);
    // The shared /24 is left NULL — it must never be the glue.
    expect(r.componentByCluster.has("cluster_subnet_S")).toBe(false);
    expect(r.stats.leavesSkippedMultiComponent).toBe(1);
  });

  it("two bridge clusters sharing ONLY a mop-up (no bridge partner) do not merge", () => {
    // Neither cert has a bridge partner; they only co-touch subnet_S.
    // Result: no merge, subnet_S NULL, neither forms a component.
    const clusters = [
      cluster("cluster_cert_X", "cert_serial", 4),
      cluster("cluster_cert_Y", "cert_serial", 4),
      cluster("cluster_subnet_S", "subnet", 40),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_cert_X", linkedClusterIds: ["cluster_subnet_S"] },
      { bridgeId: "cluster_cert_Y", linkedClusterIds: ["cluster_subnet_S"] },
    ];
    const r = computeComponents(clusters, bridges);
    expect(r.componentByCluster.size).toBe(0);
    expect(r.stats.leavesSkippedMultiComponent).toBe(1);
  });

  it("a mop-up shared within ONE operator's component still attaches (single root)", () => {
    // Two bridge clusters of the SAME operator (they share a bridge key,
    // so they union) both reference subnet_S → one root → subnet_S attaches.
    const clusters = [
      cluster("cluster_cert_A", "cert_serial", 4),
      cluster("cluster_ip_A", "per_ip", 4),
      cluster("cluster_subnet_S", "subnet", 40),
    ];
    const bridges: BridgeGroup[] = [
      // cert_A and ip_A are the same operator (mutual key membership).
      { bridgeId: "cluster_cert_A", linkedClusterIds: ["cluster_ip_A", "cluster_subnet_S"] },
      { bridgeId: "cluster_ip_A", linkedClusterIds: ["cluster_cert_A", "cluster_subnet_S"] },
    ];
    const r = computeComponents(clusters, bridges);
    const comp = r.componentByCluster.get("cluster_cert_A");
    expect(comp).toBe("component_cluster_cert_A");
    expect(r.componentByCluster.get("cluster_ip_A")).toBe(comp);
    // subnet_S is referenced by both, but both resolve to ONE component.
    expect(r.componentByCluster.get("cluster_subnet_S")).toBe(comp);
    expect(r.stats.leavesSkippedMultiComponent).toBe(0);
  });
});

// ─── computeComponents: hub-exclusion ─────────────────────────────────

describe("computeComponents — hub-exclusion", () => {
  it("a high-fan-out specific key does NOT bridge separate operators", () => {
    // per-IP hub hosting 900 brands must not glue two cert operators.
    const clusters = [
      cluster("cluster_cert_opA", "cert_serial", 4),
      cluster("cluster_cert_opB", "cert_serial", 4),
      cluster("cluster_ip_hub", "per_ip", 900),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_ip_hub", linkedClusterIds: ["cluster_cert_opA", "cluster_cert_opB", "cluster_ip_hub"] },
    ];
    const r = computeComponents(clusters, bridges);
    expect(r.componentByCluster.size).toBe(0);
    expect(r.stats.bridgesSkippedHub).toBe(1);
  });

  it("a bridge exactly AT the threshold still bridges; one over it does not", () => {
    const atThreshold = [
      cluster("cluster_ip_a", "per_ip", DEFAULT_HUB_FANOUT_THRESHOLD),
      cluster("cluster_cert_b", "cert_serial", 3),
    ];
    const rAt = computeComponents(atThreshold, [
      { bridgeId: "cluster_ip_a", linkedClusterIds: ["cluster_cert_b"] },
    ]);
    expect(rAt.componentByCluster.size).toBe(2);

    const overThreshold = [
      cluster("cluster_ip_a", "per_ip", DEFAULT_HUB_FANOUT_THRESHOLD + 1),
      cluster("cluster_cert_b", "cert_serial", 3),
    ];
    const rOver = computeComponents(overThreshold, [
      { bridgeId: "cluster_ip_a", linkedClusterIds: ["cluster_cert_b"] },
    ]);
    expect(rOver.componentByCluster.size).toBe(0);
    expect(rOver.stats.bridgesSkippedHub).toBe(1);
  });

  it("a hub can still RECEIVE a component_id via a different non-hub bridge", () => {
    // cert bridge (fan-out 4) links a small operator to a hub IP. The hub
    // can't bridge, but it's a legitimate member here.
    const clusters = [
      cluster("cluster_cert_op", "cert_serial", 4),
      cluster("cluster_ip_hub", "per_ip", 900),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_cert_op", linkedClusterIds: ["cluster_cert_op", "cluster_ip_hub"] },
    ];
    const r = computeComponents(clusters, bridges);
    expect(r.componentByCluster.get("cluster_ip_hub")).toBe("component_cluster_cert_op");
    expect(r.componentByCluster.get("cluster_cert_op")).toBe("component_cluster_cert_op");
    expect(r.stats.bridgesSkippedHub).toBe(0);
  });
});

// ─── computeComponents: size-cap fail-safe ────────────────────────────

describe("computeComponents — size-cap fail-safe", () => {
  it("an over-cap component is NOT merged (fail safe toward under-merge)", () => {
    const maxSize = 4;
    // One cert bridge links 5 clusters (bridge + 4 members) = size 5 > cap.
    const members = ["cluster_ip_m1", "cluster_ip_m2", "cluster_ip_m3", "cluster_ip_m4"];
    const clusters = [
      cluster("cluster_cert_bridge", "cert_serial", 3),
      ...members.map((m) => cluster(m, "per_ip", 3)),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_cert_bridge", linkedClusterIds: members },
    ];
    const r = computeComponents(clusters, bridges, { maxComponentSize: maxSize });
    expect(r.componentByCluster.size).toBe(0);
    expect(r.stats.componentsSkippedOverCap).toBe(1);
    expect(r.stats.componentsFormed).toBe(0);
  });

  it("a component exactly AT the cap is merged", () => {
    const maxSize = 3;
    const members = ["cluster_ip_m1", "cluster_ip_m2"];
    const clusters = [
      cluster("cluster_cert_bridge", "cert_serial", 3),
      ...members.map((m) => cluster(m, "per_ip", 3)),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_cert_bridge", linkedClusterIds: members },
    ];
    const r = computeComponents(clusters, bridges, { maxComponentSize: maxSize });
    expect(r.componentByCluster.size).toBe(3);
    expect(r.stats.componentsFormed).toBe(1);
  });

  it("default max component size is 25", () => {
    expect(DEFAULT_MAX_COMPONENT_SIZE).toBe(25);
  });
});

// ─── computeComponents: determinism / stability under drift ───────────

describe("computeComponents — deterministic & stable component_id", () => {
  it("is order-independent: shuffling clusters and bridges yields the same labels", () => {
    const clustersA = [
      cluster("cluster_cert_A", "cert_serial"),
      cluster("cluster_ip_B", "per_ip"),
      cluster("cluster_ip_C", "per_ip"),
    ];
    const bridgesA: BridgeGroup[] = [
      { bridgeId: "cluster_cert_A", linkedClusterIds: ["cluster_ip_B"] },
      { bridgeId: "cluster_ip_B", linkedClusterIds: ["cluster_ip_C"] },
    ];
    const clustersB = [...clustersA].reverse();
    const bridgesB = [...bridgesA].reverse();

    const rA = computeComponents(clustersA, bridgesA);
    const rB = computeComponents(clustersB, bridgesB);
    expect([...rA.componentByCluster.entries()].sort()).toEqual(
      [...rB.componentByCluster.entries()].sort(),
    );
  });

  it("label is stable when a NON-representative member drifts away", () => {
    // Component {cert_A, ip_B, ip_C}. Representative = cluster_cert_A.
    const before = computeComponents(
      [
        cluster("cluster_cert_A", "cert_serial"),
        cluster("cluster_ip_B", "per_ip"),
        cluster("cluster_ip_C", "per_ip"),
      ],
      [
        { bridgeId: "cluster_cert_A", linkedClusterIds: ["cluster_ip_B", "cluster_ip_C"] },
      ],
    );
    expect(before.componentByCluster.get("cluster_ip_B")).toBe("component_cluster_cert_A");

    // C drifts off; A still the representative → B keeps the SAME label.
    const after = computeComponents(
      [cluster("cluster_cert_A", "cert_serial"), cluster("cluster_ip_B", "per_ip")],
      [{ bridgeId: "cluster_cert_A", linkedClusterIds: ["cluster_ip_B"] }],
    );
    expect(after.componentByCluster.get("cluster_ip_B")).toBe("component_cluster_cert_A");
  });

  it("representative derives from BRIDGE clusters only, never a random-UUID ASN member", () => {
    // A workflow ASN cluster carries a random-UUID id that sorts BEFORE
    // 'cluster_...'. It must never become the representative (that would
    // split component_id by dispatch source / churn every run).
    const clusters = [
      cluster("0af-random-asn-uuid", "other", 3), // workflow ASN row
      cluster("cluster_ip_bridge", "per_ip", 3),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_ip_bridge", linkedClusterIds: ["0af-random-asn-uuid"] },
    ];
    const r = computeComponents(clusters, bridges);
    // Representative is the deterministic bridge id, NOT the smaller UUID.
    expect(r.componentByCluster.get("cluster_ip_bridge")).toBe("component_cluster_ip_bridge");
    expect(r.componentByCluster.get("0af-random-asn-uuid")).toBe("component_cluster_ip_bridge");
  });

  it("idempotent: rerunning over identical inputs yields identical output", () => {
    const clusters = [
      cluster("cluster_cert_A", "cert_serial"),
      cluster("cluster_ip_B", "per_ip"),
    ];
    const bridges: BridgeGroup[] = [
      { bridgeId: "cluster_cert_A", linkedClusterIds: ["cluster_ip_B"] },
    ];
    const r1 = computeComponents(clusters, bridges);
    const r2 = computeComponents(clusters, bridges);
    expect([...r1.componentByCluster.entries()]).toEqual([...r2.componentByCluster.entries()]);
    expect(r1.stats).toEqual(r2.stats);
  });

  it("default hub threshold is 150", () => {
    expect(DEFAULT_HUB_FANOUT_THRESHOLD).toBe(150);
  });
});
