import { describe, it, expect } from "vitest";
import {
  generatePermutations,
  generateIdpLurePermutations,
  encodeIdnHost,
  CONFUSABLES,
  IDN_GLOBAL_QUOTA,
  IDN_PER_CHAR_CAP,
  type DomainPermutation,
} from "../src/lib/dnstwist";

// S2.4 / C5-D7 — IDN / punycode homoglyph GENERATION.
// Pure-core tests (house style: deterministic fixtures, one behavior each).

const idnOf = (perms: DomainPermutation[]) =>
  perms.filter((p) => p.type === "idn_homoglyph");

// ─── encodeIdnHost (ToASCII via V8 URL) ───────────────────────────────

describe("encodeIdnHost", () => {
  it("returns the xn-- ToASCII form for a genuine confusable", () => {
    // Cyrillic а (U+0430) in place of Latin a.
    expect(encodeIdnHost("аpple", "com")).toBe("xn--pple-43d.com");
  });

  it("returns null for IDNA-disallowed codepoints instead of throwing", () => {
    // A literal space is disallowed in a host label → URL parse throws;
    // the helper must swallow it and return null.
    expect(() => encodeIdnHost("a b", "com")).not.toThrow();
    expect(encodeIdnHost("a b", "com")).toBeNull();
    // Zero-width joiner is IDNA-disallowed too.
    expect(encodeIdnHost("a‍b", "com")).toBeNull();
  });

  it("folds a no-op confusable back to the ASCII original (ToASCII == original)", () => {
    // Full-width Latin a (U+FF41) UTS-46-maps to plain 'a' → no real variant.
    expect(encodeIdnHost("ａpple", "com")).toBe("apple.com");
  });
});

// ─── generatePermutations: idn_homoglyph output shape ─────────────────

describe("generatePermutations — idn_homoglyph variants", () => {
  it("emits xn--prefixed variants that differ from the ASCII original", () => {
    const idn = idnOf(generatePermutations("apple.com"));
    expect(idn.length).toBeGreaterThan(0);
    for (const p of idn) {
      expect(p.domain.startsWith("xn--")).toBe(true);
      expect(p.domain).not.toBe("apple.com");
    }
  });

  it("carries a human-readable unicode `display` form alongside the punycode domain", () => {
    const idn = idnOf(generatePermutations("apple.com"));
    const cyrillicA = idn.find((p) => p.domain === "xn--pple-43d.com");
    expect(cyrillicA).toBeDefined();
    expect(cyrillicA!.display).toBe("аpple.com"); // аpple.com
  });

  it("never emits a no-op variant — every idn domain is a real xn-- label", () => {
    // If the ToASCII/NFC no-op guards ever regressed, a folded variant would
    // leak in as a bare ASCII domain (no xn-- prefix).
    for (const d of ["apple.com", "google.com", "paypal.com", "microsoft.com"]) {
      for (const p of idnOf(generatePermutations(d))) {
        expect(p.domain.startsWith("xn--")).toBe(true);
      }
    }
  });
});

// ─── Bounding: single substitution, first occurrence, caps, quota ─────

describe("generatePermutations — IDN bounding", () => {
  it("respects the global IDN quota per domain", () => {
    // Long, confusable-dense name would blow up unbounded.
    const idn = idnOf(generatePermutations("cocacolacompany.com"));
    expect(idn.length).toBeLessThanOrEqual(IDN_GLOBAL_QUOTA);
  });

  it("applies at most IDN_PER_CHAR_CAP confusables per base char (single substitution)", () => {
    // 'o' has two confusables (Cyrillic о, Greek ο); only the FIRST 'o' is
    // ever substituted, and no more than the per-char cap of variants.
    const idn = idnOf(generatePermutations("ooo.com"));
    // Every variant must differ from the original at exactly one position.
    for (const p of idn) {
      expect(p.display).toBeDefined();
      const label = p.display!.split(".")[0]!;
      expect(label.length).toBe(3);
      // Only index 0 (first occurrence) may be non-ASCII.
      expect(/^[^\x00-\x7f]oo$/.test(label)).toBe(true);
    }
    expect(idn.length).toBeLessThanOrEqual(IDN_PER_CHAR_CAP);
    expect(idn.length).toBe(2); // Cyrillic о + Greek ο on the first o
  });

  it("substitutes only the first occurrence of a repeated base char", () => {
    const idn = idnOf(generatePermutations("papa.com"));
    // 'p' → Cyrillic р must land on index 0, not index 2.
    const pVariant = idn.find((p) => p.display!.startsWith("р")); // р
    expect(pVariant).toBeDefined();
    expect(pVariant!.display).toBe("рapa.com");
  });
});

// ─── Dedup + reserved quota within the 30-cap ─────────────────────────

describe("generatePermutations — dedup + cap reservation", () => {
  it("has no duplicate domains and no xn--/ASCII collision", () => {
    const perms = generatePermutations("apple.com");
    const domains = perms.map((p) => p.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("reserves IDN slots inside the 30-cap so typosquat does not starve them", () => {
    const perms = generatePermutations("microsoftonline.com");
    // 30-cap + up to 7 IdP lures appended outside it (IDP_LURE_* in dnstwist).
    expect(perms.length).toBeLessThanOrEqual(37);
    const lures = new Set(generateIdpLurePermutations("microsoftonline.com").map((p) => p.domain));
    expect(perms.filter((p) => !lures.has(p.domain)).length).toBeLessThanOrEqual(30);
    // A long, typosquat-heavy name would fill 30 slots with typosquats under
    // a naive sort+slice; the reservation guarantees idn variants survive.
    expect(idnOf(perms).length).toBeGreaterThan(0);
  });

  it("orders idn_homoglyph between homoglyph and tld_swap", () => {
    const perms = generatePermutations("apple.com");
    const firstIdn = perms.findIndex((p) => p.type === "idn_homoglyph");
    const firstTld = perms.findIndex((p) => p.type === "tld_swap");
    if (firstIdn >= 0 && firstTld >= 0) {
      expect(firstIdn).toBeLessThan(firstTld);
    }
  });
});

// ─── ASCII output regression guard ────────────────────────────────────

describe("generatePermutations — ASCII output unchanged", () => {
  it("does not alter existing ASCII permutation generation", () => {
    // The ASCII homoglyph step stays ASCII-gated: no ASCII permutation is
    // ever an xn-- label, and non-idn variants never carry a `display`.
    const perms = generatePermutations("apple.com");
    for (const p of perms.filter((x) => x.type !== "idn_homoglyph")) {
      expect(p.domain.startsWith("xn--")).toBe(false);
      expect(p.display).toBeUndefined();
    }
  });

  it("keeps CONFUSABLES a curated, ASCII-keyed map", () => {
    for (const [base, confs] of Object.entries(CONFUSABLES)) {
      expect(/^[a-z]$/.test(base)).toBe(true);
      expect(confs.length).toBeGreaterThanOrEqual(1);
      expect(confs.length).toBeLessThanOrEqual(IDN_PER_CHAR_CAP);
      for (const c of confs) expect(/[^\x00-\x7f]/.test(c)).toBe(true);
    }
  });
});
