import { describe, it, expect } from "vitest";
import {
  buildFingerprint,
  buildFingerprintWithOverCap,
  serializeFingerprint,
  parseFingerprint,
  normalizeElements,
  diffNewElements,
  decideInfraMovement,
  DEFAULT_MIN_NEW_IPS,
  DEFAULT_MIN_NEW_SERIALS,
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_COOLDOWN_HOURS,
  type InfraFingerprint,
  type MovementDecisionInput,
} from "../src/lib/cluster-infra-movement";

// Pure-core tests for the NEXUS infrastructure-movement pivot trigger (D5b).
// Mirrors test/cluster-components.test.ts / test/alert-triage.test.ts house
// style — deterministic fixtures, one behavior per test, no I/O.

const NOW = Date.parse("2026-07-20T12:00:00.000Z");

function fp(a: string[], i: string[], s: string[]): InfraFingerprint {
  return { a, i, s };
}

function baseInput(over: Partial<MovementDecisionInput> = {}): MovementDecisionInput {
  return {
    prior: fp([], [], []),
    current: fp([], [], []),
    confidenceScore: 80,
    lastMovementPivotAt: null,
    nowMs: NOW,
    ...over,
  };
}

// ─── normalizeElements ────────────────────────────────────────────────────

describe("normalizeElements", () => {
  it("dedupes, trims, drops empties, and sorts", () => {
    expect(normalizeElements(["b", "a", "a", " ", "", "  c  "], 10)).toEqual(["a", "b", "c"]);
  });

  it("caps at the requested size (lexicographically-lowest kept — deterministic)", () => {
    expect(normalizeElements(["9", "1", "5", "3", "7"], 3)).toEqual(["1", "3", "5"]);
  });

  it("ignores non-string entries", () => {
    expect(normalizeElements(["a", null, undefined, "b"], 10)).toEqual(["a", "b"]);
  });
});

// ─── fingerprint serialize / parse round-trip ─────────────────────────────

describe("fingerprint serialize/parse", () => {
  it("round-trips a built fingerprint", () => {
    const built = buildFingerprint(["AS1", "AS2"], ["1.1.1.1"], ["serialX"]);
    const parsed = parseFingerprint(serializeFingerprint(built));
    expect(parsed).toEqual(built);
  });

  it("parse returns null for null/blank/malformed input (no prior snapshot)", () => {
    expect(parseFingerprint(null)).toBeNull();
    expect(parseFingerprint("")).toBeNull();
    expect(parseFingerprint("{not json")).toBeNull();
    expect(parseFingerprint("[1,2,3]")).toEqual({ a: [], i: [], s: [] }); // object-less array → empty sets
  });

  it("parse coerces missing/wrong-typed dimensions to empty arrays", () => {
    expect(parseFingerprint(JSON.stringify({ a: ["AS1"], i: "nope", s: [1, "s2"] }))).toEqual({
      a: ["AS1"],
      i: [],
      s: ["s2"],
    });
  });
});

// ─── diffNewElements: NEW-element detection (additions only) ──────────────

describe("diffNewElements", () => {
  it("returns only elements present in current but absent from prior", () => {
    const prior = fp(["AS1"], ["1.1.1.1"], ["s1"]);
    const current = fp(["AS1", "AS2"], ["1.1.1.1", "2.2.2.2", "3.3.3.3"], ["s1", "s2"]);
    const d = diffNewElements(prior, current);
    expect(d.newAsns).toEqual(["AS2"]);
    expect(d.newIps).toEqual(["2.2.2.2", "3.3.3.3"]);
    expect(d.newSerials).toEqual(["s2"]);
  });

  it("ignores removals — losing infra is not movement", () => {
    const prior = fp(["AS1", "AS2"], ["1.1.1.1", "2.2.2.2"], ["s1"]);
    const current = fp(["AS1"], ["1.1.1.1"], ["s1"]);
    const d = diffNewElements(prior, current);
    expect(d.newAsns).toEqual([]);
    expect(d.newIps).toEqual([]);
    expect(d.newSerials).toEqual([]);
  });

  it("no change yields no new elements (idempotent baseline)", () => {
    const same = fp(["AS1"], ["1.1.1.1"], ["s1"]);
    const d = diffNewElements(same, same);
    expect(d.newAsns.length + d.newIps.length + d.newSerials.length).toBe(0);
  });
});

// ─── decideInfraMovement: the four fail-safe guards ───────────────────────

describe("decideInfraMovement — guard (a): prior snapshot required", () => {
  it("a first observation (prior=null) never emits, even with huge growth", () => {
    const d = decideInfraMovement(
      baseInput({ prior: null, current: fp(["A", "B", "C"], ["1", "2", "3", "4"], ["s1", "s2"]) }),
    );
    expect(d.emit).toBe(false);
    expect(d.reason).toBe("no_prior_snapshot");
  });
});

describe("decideInfraMovement — significance gate", () => {
  it("emits when >= MIN_NEW_IPS new IPs appear", () => {
    const current = fp([], Array.from({ length: DEFAULT_MIN_NEW_IPS }, (_, k) => `10.0.0.${k}`), []);
    const d = decideInfraMovement(baseInput({ prior: fp([], [], []), current }));
    expect(d.emit).toBe(true);
    expect(d.reason).toBe("movement");
  });

  it("does NOT emit for fewer than MIN_NEW_IPS new IPs and no other growth", () => {
    const current = fp([], Array.from({ length: DEFAULT_MIN_NEW_IPS - 1 }, (_, k) => `10.0.0.${k}`), []);
    const d = decideInfraMovement(baseInput({ prior: fp([], [], []), current }));
    expect(d.emit).toBe(false);
    expect(d.reason).toBe("insufficient_growth");
  });

  it("a single new ASN is sufficient (register-then-move to new hosting)", () => {
    const d = decideInfraMovement(
      baseInput({ prior: fp(["AS1"], [], []), current: fp(["AS1", "AS2"], [], []) }),
    );
    expect(d.emit).toBe(true);
  });

  it("emits when >= MIN_NEW_SERIALS new cert-serials appear", () => {
    const current = fp([], [], Array.from({ length: DEFAULT_MIN_NEW_SERIALS }, (_, k) => `serial${k}`));
    const d = decideInfraMovement(baseInput({ prior: fp([], [], []), current }));
    expect(d.emit).toBe(true);
  });
});

describe("decideInfraMovement — confidence floor", () => {
  it("suppresses at or below the confidence floor (mirrors dormancy > 40)", () => {
    const current = fp(["AS1", "AS2"], [], []);
    const d = decideInfraMovement(
      baseInput({ prior: fp(["AS1"], [], []), current, confidenceScore: DEFAULT_CONFIDENCE_FLOOR }),
    );
    expect(d.emit).toBe(false);
    expect(d.reason).toBe("below_confidence_floor");
  });

  it("emits just above the confidence floor", () => {
    const current = fp(["AS1", "AS2"], [], []);
    const d = decideInfraMovement(
      baseInput({ prior: fp(["AS1"], [], []), current, confidenceScore: DEFAULT_CONFIDENCE_FLOOR + 1 }),
    );
    expect(d.emit).toBe(true);
  });
});

describe("decideInfraMovement — per-cluster cooldown", () => {
  const current = fp(["AS1", "AS2"], [], []);
  const prior = fp(["AS1"], [], []);

  it("suppresses a re-emit within the cooldown window", () => {
    const lastMovementPivotAt = new Date(NOW - (DEFAULT_COOLDOWN_HOURS - 1) * 3_600_000).toISOString();
    const d = decideInfraMovement(baseInput({ prior, current, lastMovementPivotAt }));
    expect(d.emit).toBe(false);
    expect(d.reason).toBe("in_cooldown");
  });

  it("allows a re-emit once the cooldown window has elapsed", () => {
    const lastMovementPivotAt = new Date(NOW - (DEFAULT_COOLDOWN_HOURS + 1) * 3_600_000).toISOString();
    const d = decideInfraMovement(baseInput({ prior, current, lastMovementPivotAt }));
    expect(d.emit).toBe(true);
  });

  it("treats a malformed cooldown timestamp as not-in-cooldown (fail open on the stamp only)", () => {
    const d = decideInfraMovement(baseInput({ prior, current, lastMovementPivotAt: "garbage" }));
    expect(d.emit).toBe(true);
  });
});

// ─── F1: over-cap phantom-movement guard ──────────────────────────────────

describe("buildFingerprintWithOverCap", () => {
  it("flags overCap when a dimension's distinct count exceeds the cap", () => {
    const many = Array.from({ length: 300 }, (_, k) => `10.0.${Math.floor(k / 256)}.${k % 256}`);
    const { fp, overCap } = buildFingerprintWithOverCap([], many, [], 256);
    expect(overCap).toBe(true);
    expect(fp.i.length).toBe(256); // stored set is the truncated window
  });

  it("does not flag overCap at or below the cap", () => {
    const { overCap } = buildFingerprintWithOverCap(["AS1"], ["1.1.1.1", "2.2.2.2"], ["s1"], 256);
    expect(overCap).toBe(false);
  });
});

describe("decideInfraMovement — F1 over-cap skip (phantom-movement guard)", () => {
  it("emits NO movement from a truncated window even when new elements appear (the pre-fix false positive)", () => {
    // Simulate the window-slide: a >256-IP cluster whose lowest-256 window
    // shifts run-over-run so the diff *looks like* fresh IPs. With overCap
    // set, the decision must refuse to diff and skip.
    const prior = fp([], Array.from({ length: 256 }, (_, k) => `a-${k}`), []);
    const current = fp(
      [],
      // 256 elements, several of which are "new" relative to prior purely
      // because lower-sorting ids slid into the window — not real growth.
      Array.from({ length: 256 }, (_, k) => `A-${k}`),
      [],
    );
    const withGuard = decideInfraMovement(baseInput({ prior, current, overCap: true }));
    expect(withGuard.emit).toBe(false);
    expect(withGuard.reason).toBe("over_cap");

    // Control: WITHOUT the guard the same truncated diff would have emitted
    // — proving the guard is what prevents the phantom pivot.
    const withoutGuard = decideInfraMovement(baseInput({ prior, current, overCap: false }));
    expect(withoutGuard.emit).toBe(true);
  });

  it("over-cap skip takes precedence over a genuine-looking growth diff", () => {
    const prior = fp(["AS1"], [], []);
    const current = fp(["AS1", "AS2", "AS3"], [], []);
    const d = decideInfraMovement(baseInput({ prior, current, overCap: true }));
    expect(d.emit).toBe(false);
    expect(d.reason).toBe("over_cap");
  });
});

describe("decideInfraMovement — significance score for ranking", () => {
  it("counts total new distinct elements across all dimensions", () => {
    const d = decideInfraMovement(
      baseInput({
        prior: fp(["AS1"], ["1.1.1.1"], []),
        current: fp(["AS1", "AS2"], ["1.1.1.1", "2.2.2.2", "3.3.3.3"], ["s1"]),
      }),
    );
    // 1 new ASN + 2 new IPs + 1 new serial = 4
    expect(d.significance).toBe(4);
  });
});
