import { describe, it, expect } from "vitest";
import {
  decideInheritedActor,
  type MemberOtxAttribution,
} from "../src/lib/cluster-attribution-inherit";

// Pure-decider table-driven tests, mirroring test/alert-triage.test.ts's
// house style: default fixtures + one mutation per test case.

describe("decideInheritedActor — 0 distinct actors", () => {
  it("returns null for an empty member list", () => {
    expect(decideInheritedActor([])).toBeNull();
  });
});

describe("decideInheritedActor — exactly 1 distinct actor", () => {
  it("inherits the sole actor from a single member", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "APT-Fake" },
    ];
    const d = decideInheritedActor(members);
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
    const d = decideInheritedActor(members);
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
    const d = decideInheritedActor(members);
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
    const d = decideInheritedActor(members);
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
    const d = decideInheritedActor(members);
    expect(d?.actor_name).toBe("APT-Fake");
  });
});

describe("decideInheritedActor — >=2 distinct actors (ambiguous, conservative)", () => {
  it("returns null when two distinct actor_ids disagree", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "APT-Fake" },
      { actor_id: "actor_2", actor_name: "APT-Other" },
    ];
    expect(decideInheritedActor(members)).toBeNull();
  });

  it("returns null for three or more distinct actor_ids", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: "A" },
      { actor_id: "actor_2", actor_name: "B" },
      { actor_id: "actor_3", actor_name: "C" },
    ];
    expect(decideInheritedActor(members)).toBeNull();
  });

  it("stays ambiguous even when one of the two competing actors has a null name", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "actor_1", actor_name: null },
      { actor_id: "actor_2", actor_name: "APT-Other" },
    ];
    expect(decideInheritedActor(members)).toBeNull();
  });
});

describe("decideInheritedActor — malformed/edge input", () => {
  it("ignores rows with an empty-string actor_id (falsy guard) and can fall back to null distinct count", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "", actor_name: "Should be ignored" },
    ];
    expect(decideInheritedActor(members)).toBeNull();
  });

  it("ignores an empty-string actor_id row and still inherits the one real distinct actor", () => {
    const members: MemberOtxAttribution[] = [
      { actor_id: "", actor_name: "Should be ignored" },
      { actor_id: "actor_1", actor_name: "APT-Fake" },
    ];
    const d = decideInheritedActor(members);
    expect(d?.actor_id).toBe("actor_1");
  });
});
