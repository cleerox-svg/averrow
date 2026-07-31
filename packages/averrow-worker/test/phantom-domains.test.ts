/**
 * W2.4 — coverage for the phantom-squat watchlist's pure validation/dedup
 * pipeline (`lib/phantom-domains.ts`, W2.2), per
 * `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` §3.3/§6 rec #3 and the
 * W2.0 design spec §3 ("Validation + dedup (before any row is written)").
 *
 * Both `normalizePhantomDomain` and `filterPhantomCandidates` are pure and
 * side-effect-free (no D1, no AI, no network) — the sweet spot this house
 * style calls for (see `test/alert-triage.test.ts`). Table-driven cases
 * cover every gate in spec §3.1-§3.4 plus the boundaries.
 */

import { describe, it, expect } from "vitest";
import {
  normalizePhantomDomain,
  filterPhantomCandidates,
  type RawPhantomCandidate,
} from "../src/lib/phantom-domains";

// ═══════════════════════════════════════════════════════════════════════
// normalizePhantomDomain — spec §3.1 syntactic validation + normalization
// ═══════════════════════════════════════════════════════════════════════

describe("normalizePhantomDomain — valid domains normalize", () => {
  it("lowercases a mixed-case domain", () => {
    expect(normalizePhantomDomain("BrAnD.CoM")).toBe("brand.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePhantomDomain("  brand.com  ")).toBe("brand.com");
  });

  it("accepts a hyphenated registrable label (brand-support.com)", () => {
    expect(normalizePhantomDomain("brand-support.com")).toBe("brand-support.com");
  });

  it("accepts a multi-label subdomain-style candidate (mybrand.shop)", () => {
    expect(normalizePhantomDomain("mybrand.shop")).toBe("mybrand.shop");
  });

  it("accepts a label at exactly the 63-char cap", () => {
    const label63 = "a".repeat(63);
    expect(normalizePhantomDomain(`${label63}.com`)).toBe(`${label63}.com`);
  });
});

describe("normalizePhantomDomain — rejects non-string / empty input", () => {
  it("rejects a non-string value", () => {
    expect(normalizePhantomDomain(123)).toBeNull();
  });

  it("rejects null", () => {
    expect(normalizePhantomDomain(null)).toBeNull();
  });

  it("rejects undefined", () => {
    expect(normalizePhantomDomain(undefined)).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(normalizePhantomDomain("")).toBeNull();
  });

  it("rejects a whitespace-only string", () => {
    expect(normalizePhantomDomain("   ")).toBeNull();
  });
});

describe("normalizePhantomDomain — rejects @ / whitespace / slash per spec §3.1", () => {
  it("rejects a userinfo (@) shape", () => {
    expect(normalizePhantomDomain("user@brand.com")).toBeNull();
  });

  it("rejects internal whitespace", () => {
    expect(normalizePhantomDomain("bra nd.com")).toBeNull();
  });

  it("rejects an inline path (slash)", () => {
    expect(normalizePhantomDomain("brand.com/x")).toBeNull();
  });

  it("rejects a trailing bare slash", () => {
    expect(normalizePhantomDomain("brand.com/")).toBeNull();
  });

  it("rejects a full scheme+path URL (contains //)", () => {
    // The @/whitespace/slash guard runs BEFORE any scheme stripping, so a
    // full URL is rejected outright rather than normalized — the model is
    // expected to emit bare registrable domains only (spec §1.4).
    expect(normalizePhantomDomain("https://brand.com/foo")).toBeNull();
  });
});

describe("normalizePhantomDomain — single-label / no-dot hosts", () => {
  it("rejects a single-label host (localhost)", () => {
    expect(normalizePhantomDomain("localhost")).toBeNull();
  });

  it("rejects a bare word with no TLD", () => {
    expect(normalizePhantomDomain("brandsupport")).toBeNull();
  });
});

describe("normalizePhantomDomain — per-label length boundary (1-63)", () => {
  it("rejects a label one char over the cap (64)", () => {
    const label64 = "a".repeat(64);
    expect(normalizePhantomDomain(`${label64}.com`)).toBeNull();
  });
});

describe("normalizePhantomDomain — leading/trailing hyphen per label", () => {
  it("rejects a label starting with a hyphen", () => {
    expect(normalizePhantomDomain("-brand.com")).toBeNull();
  });

  it("rejects a label ending with a hyphen", () => {
    expect(normalizePhantomDomain("brand-.com")).toBeNull();
  });
});

describe("normalizePhantomDomain — TLD rules (≥2 alpha chars)", () => {
  it("rejects a numeric TLD", () => {
    expect(normalizePhantomDomain("brand.123")).toBeNull();
  });

  it("rejects a 1-char TLD", () => {
    expect(normalizePhantomDomain("brand.c")).toBeNull();
  });

  it("accepts a 2-char alpha TLD", () => {
    expect(normalizePhantomDomain("brand.io")).toBe("brand.io");
  });
});

describe("normalizePhantomDomain — IPv4 literal rejection", () => {
  it("rejects a bare IPv4 literal (numeric last label)", () => {
    expect(normalizePhantomDomain("192.168.1.1")).toBeNull();
  });
});

describe("normalizePhantomDomain — malformed dot placement", () => {
  it("rejects a trailing dot", () => {
    expect(normalizePhantomDomain("brand.com.")).toBeNull();
  });

  it("rejects a double-dot (empty label)", () => {
    expect(normalizePhantomDomain("brand..com")).toBeNull();
  });
});

describe("normalizePhantomDomain — disallowed characters", () => {
  it("rejects an underscore in a label", () => {
    expect(normalizePhantomDomain("brand_support.com")).toBeNull();
  });

  it("rejects a raw unicode/IDN label (not punycode-normalized here)", () => {
    expect(normalizePhantomDomain("bránd.com")).toBeNull();
  });
});

describe("normalizePhantomDomain — total-length (≤253) boundary", () => {
  it("rejects the common over-limit shape (truncation corrupts the TLD to 1 char)", () => {
    // 251 'a' + '.' + 'co' = 254 raw chars. The underlying sanitizeDomain
    // truncates (not rejects) at 253, which here chops the TLD down to a
    // single char ('c') — correctly failing the ≥2-alpha-char TLD gate.
    const raw = `${"a".repeat(251)}.co`;
    expect(raw.length).toBe(254);
    expect(normalizePhantomDomain(raw)).toBeNull();
  });

  it("KNOWN QUIRK: a grossly over-limit domain CAN still validate if truncation happens to land on an all-alpha boundary", () => {
    // sanitizeDomain (lib/sanitize.ts) enforces the length bound by
    // *silently truncating* to 253 chars rather than rejecting overlong
    // input outright. Spec §3.1 calls for rejecting anything over 253
    // chars; in practice a raw candidate can be well over that (308 chars
    // here — 5 labels of 60 'a's + '.com') and still normalize, because the
    // truncation lops off the trailing '.com' entirely and leaves a
    // same-looking last label of bare 'a's, which happens to satisfy the
    // `^[a-z]{2,}$` TLD check. This is a pre-existing latent gap inherited
    // from the shared `sanitizeDomain` truncate-not-reject behavior, not
    // something introduced by this module — locking in the OBSERVED
    // behavior here as a regression fence and flagging it for
    // backend-engineer follow-up (real over-limit rejection would need an
    // explicit `raw.length > 253` guard ahead of the sanitizeDomain call).
    const label60 = "a".repeat(60);
    const raw = `${[label60, label60, label60, label60, label60].join(".")}.com`;
    expect(raw.length).toBe(308);
    const result = normalizePhantomDomain(raw);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(253);
    expect(result).not.toMatch(/\.com$/); // the intended TLD was truncated away
  });
});

// ═══════════════════════════════════════════════════════════════════════
// filterPhantomCandidates — spec §3.2-§3.4 pipeline over a batch
// ═══════════════════════════════════════════════════════════════════════

describe("filterPhantomCandidates — full pipeline", () => {
  const existingLookalikes = new Set(["already-lookalike.com"]);
  const existingPhantoms = new Set(["already-phantom.com"]);

  it("drops the candidate matching the canonical domain (case-insensitive)", () => {
    const out = filterPhantomCandidates(
      [{ domain: "Brand.COM" }, { domain: "brandpay.io" }],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io"]);
  });

  it("drops syntactically-invalid candidates", () => {
    const out = filterPhantomCandidates(
      [{ domain: "not a domain!!" }, { domain: "localhost" }, { domain: "brandpay.io" }],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io"]);
  });

  it("dedups within the batch (case-insensitive, keeps first occurrence's metadata)", () => {
    const out = filterPhantomCandidates(
      [
        { domain: "Brand-Support.COM", kind: "hyphenation", confidence: 0.8 },
        { domain: "brand-support.com", kind: "dup-should-be-dropped", confidence: 0.1 },
      ],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ domain: "brand-support.com", kind: "hyphenation", confidence: 0.8 });
  });

  it("drops candidates already present in lookalike_domains", () => {
    const out = filterPhantomCandidates(
      [{ domain: "already-lookalike.com" }, { domain: "brandpay.io" }],
      "brand.com",
      existingLookalikes,
      existingPhantoms,
    );
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io"]);
  });

  it("drops candidates already present in phantom_domains for any brand", () => {
    const out = filterPhantomCandidates(
      [{ domain: "already-phantom.com" }, { domain: "brandpay.io" }],
      "brand.com",
      existingLookalikes,
      existingPhantoms,
    );
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io"]);
  });

  it("survives the full gauntlet in one pass: canonical, invalid, lookalike-dup, phantom-dup, in-array-dup all dropped, only genuinely new candidates remain", () => {
    const raw: RawPhantomCandidate[] = [
      { domain: "brand.com" }, // canonical -> drop
      { domain: "not a domain!!" }, // invalid -> drop
      { domain: "already-lookalike.com" }, // lookalike dup -> drop
      { domain: "already-phantom.com" }, // phantom dup -> drop
      { domain: "brandpay.io", kind: "subdomain_fold", confidence: 0.6 },
      { domain: "BRANDPAY.IO" }, // in-array dup of the above (case-insensitive) -> drop
      { domain: "brandcloud.io" },
    ];
    const out = filterPhantomCandidates(raw, "brand.com", existingLookalikes, existingPhantoms);
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io", "brandcloud.io"]);
  });

  it("skips non-object / null array entries gracefully", () => {
    const out = filterPhantomCandidates(
      [null, undefined, "just a string", 42, { domain: "brandpay.io" }] as unknown as RawPhantomCandidate[],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io"]);
  });

  it("skips a candidate whose domain field is not a string", () => {
    const out = filterPhantomCandidates(
      [{ domain: 123 } as unknown as RawPhantomCandidate, { domain: "brandpay.io" }],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io"]);
  });

  it("falls back to a lowercase/trim of canonicalDomain when it isn't itself syntactically normalizable", () => {
    // A malformed canonical_domain (e.g. legacy dirty data) must not crash
    // the pipeline — it degrades to a plain lowercase/trim comparison.
    const out = filterPhantomCandidates(
      [{ domain: "not a domain!!" }, { domain: "brandpay.io" }],
      "Not A Domain!!",
      new Set(),
      new Set(),
    );
    // "not a domain!!" itself is syntactically invalid so it's dropped at
    // §3.1 regardless; brandpay.io survives.
    expect(out.map((c) => c.domain)).toEqual(["brandpay.io"]);
  });

  it("truncates confidence into [0,1]", () => {
    const out = filterPhantomCandidates(
      [
        { domain: "brandpay.io", confidence: 5 },
        { domain: "brandcloud.io", confidence: -1 },
        { domain: "brandhq.io", confidence: 0.42 },
      ],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out.find((c) => c.domain === "brandpay.io")?.confidence).toBe(1);
    expect(out.find((c) => c.domain === "brandcloud.io")?.confidence).toBe(0);
    expect(out.find((c) => c.domain === "brandhq.io")?.confidence).toBe(0.42);
  });

  it("drops a non-finite confidence (NaN/Infinity) rather than passing it through", () => {
    const out = filterPhantomCandidates(
      [{ domain: "brandpay.io", confidence: NaN }, { domain: "brandcloud.io", confidence: Infinity }],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out.find((c) => c.domain === "brandpay.io")?.confidence).toBeUndefined();
    expect(out.find((c) => c.domain === "brandcloud.io")?.confidence).toBeUndefined();
  });

  it("truncates an over-long kind string to 40 chars", () => {
    const longKind = "x".repeat(100);
    const out = filterPhantomCandidates(
      [{ domain: "brandpay.io", kind: longKind }],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out[0].kind).toBe(longKind.slice(0, 40));
    expect(out[0].kind).toHaveLength(40);
  });

  it("treats an empty-string kind as absent (undefined, not '')", () => {
    const out = filterPhantomCandidates(
      [{ domain: "brandpay.io", kind: "" }],
      "brand.com",
      new Set(),
      new Set(),
    );
    expect(out[0].kind).toBeUndefined();
  });
});

describe("filterPhantomCandidates — cap boundary (spec §2, default 50)", () => {
  it("truncates to the default cap of 50 when the batch has more survivors", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ domain: `d${i}.com` }));
    const out = filterPhantomCandidates(many, "brand.com", new Set(), new Set());
    expect(out).toHaveLength(50);
  });

  it("keeps the FIRST 50 survivors in array order, not the last 50", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ domain: `d${i}.com` }));
    const out = filterPhantomCandidates(many, "brand.com", new Set(), new Set());
    expect(out[0].domain).toBe("d0.com");
    expect(out[49].domain).toBe("d49.com");
    expect(out.some((c) => c.domain === "d50.com")).toBe(false);
  });

  it("respects a custom cap argument", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ domain: `d${i}.com` }));
    const out = filterPhantomCandidates(many, "brand.com", new Set(), new Set(), 3);
    expect(out).toHaveLength(3);
  });

  it("passes through unchanged when the batch is below the cap", () => {
    const few = Array.from({ length: 5 }, (_, i) => ({ domain: `d${i}.com` }));
    const out = filterPhantomCandidates(few, "brand.com", new Set(), new Set());
    expect(out).toHaveLength(5);
  });

  it("returns an empty array for an empty batch", () => {
    expect(filterPhantomCandidates([], "brand.com", new Set(), new Set())).toEqual([]);
  });
});
