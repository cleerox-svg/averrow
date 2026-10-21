import { describe, it, expect } from "vitest";
import {
  decideInheritedActor,
  singleOtxActor,
  INHERIT_MAX_CLUSTER_MEMBERS,
  INHERIT_MIN_OTX_COVERAGE,
  INHERIT_MIN_OTX_MEMBERS,
  type InheritPolicyInput,
  type MemberOtxAttribution,
} from "../src/lib/cluster-attribution-inherit";

// Pure-decider table-driven tests, mirroring test/alert-triage.test.ts's
// house style: default fixtures + one mutation per test case.

describe("singleOtxActor — 0 distinct actors", () => {
  it("returns null for an empty member list", () => {
    expect(singleOtxActor([])).toBeNull();
  });
});

describe("singleOtxActor — exactly 1 distinct actor", () => {
  it("inherits the sole actor from a single member", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "APT-Fake" },
    ];
    const d = singleOtxActor(members);
    expect(d).not.toBeNull();
    expect(d).toEqual({
      actor_id: "actor_1",
      actor_name: "APT-Fake",
      confidence: "low",
      source: "nexus",
    });
  });

  it("dedupes the same actor_id repeated across multiple members and still inherits", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "APT-Fake" },
      { actor_id: "actor_1", actor_name: "APT-Fake" },
      { actor_id: "actor_1", actor_name: "APT-Fake" },
    ];
    const d = singleOtxActor(members);
    expect(d).toEqual({
      actor_id: "actor_1",
      actor_name: "APT-Fake",
      confidence: "low",
      source: "nexus",
    });
  });

  it("inherits with a null actor_name without crashing", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: null },
    ];
    const d = singleOtxActor(members);
    expect(d).toEqual({
      actor_id: "actor_1",
      actor_name: null,
      confidence: "low",
      source: "nexus",
    });
  });

  it("backfills a null-then-named name for the same actor_id (keeps first non-null name seen)", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: null },
      { actor_id: "actor_1", actor_name: "APT-Fake" },
    ];
    const d = singleOtxActor(members);
    expect(d?.actor_name).toBe("APT-Fake");
  });

  it("keeps the first non-null name and does not overwrite it with a later different one for the same actor_id", () => {
    // Same actor_id can't legitimately carry two different names in
    // practice, but the decider is defensive: once a non-null name is
    // recorded for an actor_id, later rows only fill in when the
    // existing value is still null.
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "APT-Fake" },
      { actor_id: "actor_1", actor_name: "APT-Renamed" },
    ];
    const d = singleOtxActor(members);
    expect(d?.actor_name).toBe("APT-Fake");
  });
});

describe("singleOtxActor — >=2 distinct actors (ambiguous, conservative)", () => {
  it("returns null when two distinct actor_ids disagree", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "APT-Fake" },
      { actor_id: "actor_2", actor_name: "APT-Other" },
    ];
    expect(singleOtxActor(members)).toBeNull();
  });

  it("returns null for three or more distinct actor_ids", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "A" },
      { actor_id: "actor_2", actor_name: "B" },
      { actor_id: "actor_3", actor_name: "C" },
    ];
    expect(singleOtxActor(members)).toBeNull();
  });

  it("stays ambiguous even when one of the two competing actors has a null name", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: null },
      { actor_id: "actor_2", actor_name: "APT-Other" },
    ];
    expect(singleOtxActor(members)).toBeNull();
  });
});

describe("singleOtxActor — malformed/edge input", () => {
  it("ignores rows with an empty-string actor_id (falsy guard) and can fall back to null distinct count", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "", actor_name: "Should be ignored" },
    ];
    expect(singleOtxActor(members)).toBeNull();
  });

  it("ignores an empty-string actor_id row and still inherits the one real distinct actor", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "", actor_name: "Should be ignored" },
      { actor_id: "actor_1", actor_name: "APT-Fake" },
    ];
    const d = singleOtxActor(members);
    expect(d?.actor_id).toBe("actor_1");
  });
});

// ─── The inheritance policy (2026-10-21 threat-intel review) ──────────

describe("inheritance policy thresholds", () => {
  it("pins the reviewed values", () => {
    expect(INHERIT_MIN_OTX_MEMBERS).toBe(2);
    expect(INHERIT_MIN_OTX_COVERAGE).toBe(0.1);
    expect(INHERIT_MAX_CLUSTER_MEMBERS).toBe(250);
  });
});

describe("decideInheritedActor — policy", () => {
  // Qualifying baseline: per-IP cluster, 3 agreeing OTX members out of 20,
  // no member on a multi-tenant ASN. Each test mutates one input.
  const base = (over: Partial<InheritPolicyInput> = {}): InheritPolicyInput => ({
    clusterId: "cluster_ip_203.0.113.7",
    agentNotes: "Shared IP 203.0.113.7 hosting 20 threats",
    memberAttributions: [{ actor_id: "actor_1", actor_name: "APT-Fake" }],
    otxMemberCount: 3,
    memberStats: { memberCount: 20, multiTenantMembers: 0 },
    ...over,
  });
  const reason = (input: InheritPolicyInput) => {
    const v = decideInheritedActor(input);
    return v.status === "skip" ? v.reason : v.status;
  };

  it("accepts a cluster that passes every rule", () => {
    expect(decideInheritedActor(base())).toEqual({
      status: "inherit",
      decision: { actor_id: "actor_1", actor_name: "APT-Fake", confidence: "low", source: "nexus" },
    });
  });

  it("accepts both cert lanes (serial and SAN)", () => {
    expect(reason(base({ clusterId: "cluster_cert_abc", agentNotes: '{"cluster_type":"ssl_cert_serial","ssl_cert_serial":"01"}' }))).toBe("inherit");
    expect(reason(base({ clusterId: "cluster_cert_def", agentNotes: '{"cluster_type":"ssl_san_hash","ssl_san_hash":"h"}' }))).toBe("inherit");
  });

  describe("rule 1 — specific-evidence lane only", () => {
    it.each([
      ["cluster_asn_as4837_malware_distribution"],
      ["cluster_subnet_203_0_113"],
      ["cluster_registrar_namecheap"],
      ["cluster_dev_com.example"],
      ["cluster_actor_darkweb_1"],
      ["66666666-0000-4000-8000-000000000006"],
    ])("rejects %s", (clusterId) => {
      expect(reason(base({ clusterId }))).toBe("lane");
    });

    it("rejects before measuring members (no stats needed)", () => {
      expect(reason(base({ clusterId: "cluster_asn_as4837_phishing", memberStats: undefined }))).toBe("lane");
    });
  });

  describe("rule 2 — no member on a multi-tenant ASN", () => {
    it("rejects when even one member sits on a multi-tenant network", () => {
      expect(reason(base({ memberStats: { memberCount: 20, multiTenantMembers: 1 } }))).toBe("multitenant");
    });
  });

  describe("rule 3 — quorum of agreeing OTX members", () => {
    it("rejects a single OTX-attributed member", () => {
      expect(reason(base({ otxMemberCount: 1 }))).toBe("quorum");
    });
    it("rejects no OTX actor at all", () => {
      expect(reason(base({ memberAttributions: [], otxMemberCount: 0 }))).toBe("quorum");
    });
    it("rejects members naming two actors as ambiguous", () => {
      expect(reason(base({
        memberAttributions: [
          { actor_id: "actor_1", actor_name: "A" },
          { actor_id: "actor_2", actor_name: "B" },
        ],
        otxMemberCount: 10,
      }))).toBe("ambiguous");
    });
  });

  describe("rule 4 — coverage", () => {
    it("rejects OTX members under 10% of the cluster", () => {
      expect(reason(base({ otxMemberCount: 2, memberStats: { memberCount: 21, multiTenantMembers: 0 } }))).toBe("coverage");
    });
    it("accepts exactly 10% (3 of 30 — no float drift)", () => {
      expect(reason(base({ otxMemberCount: 3, memberStats: { memberCount: 30, multiTenantMembers: 0 } }))).toBe("inherit");
    });
  });

  describe("rule 5 — size backstop", () => {
    it("rejects more than INHERIT_MAX_CLUSTER_MEMBERS members even at full coverage", () => {
      const n = INHERIT_MAX_CLUSTER_MEMBERS + 1;
      expect(reason(base({ otxMemberCount: n, memberStats: { memberCount: n, multiTenantMembers: 0 } }))).toBe("size");
    });
    it("accepts exactly INHERIT_MAX_CLUSTER_MEMBERS members", () => {
      const n = INHERIT_MAX_CLUSTER_MEMBERS;
      expect(reason(base({ otxMemberCount: 25, memberStats: { memberCount: n, multiTenantMembers: 0 } }))).toBe("inherit");
    });
  });

  it("asks for member stats only once rules 1 and 3 pass", () => {
    expect(decideInheritedActor(base({ memberStats: undefined }))).toEqual({ status: "needs_member_stats" });
    expect(decideInheritedActor(base({ memberStats: null }))).toEqual({ status: "needs_member_stats" });
  });
});
