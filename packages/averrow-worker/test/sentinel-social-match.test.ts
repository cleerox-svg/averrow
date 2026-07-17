/**
 * Parity test for the in-memory social-profile matcher.
 *
 * The matcher replaces a per-threat double-LIKE SQL query that was
 * the #13 D1 read offender (12.4M rows / 24h, 738 calls). This test
 * pins the matching semantics to the equivalent of:
 *
 *   sp.profile_url LIKE '%' || domain || '%'
 *   OR sp.handle    LIKE '%' || domain.split('.')[0] || '%'
 *
 * If you change either side, also update lib/agents/sentinel.ts and
 * make sure the diagnostic top-queries report doesn't regress.
 */

import { describe, it, expect } from "vitest";
import { findSocialMatchesForDomain, type SocialProfileRow } from "../src/agents/sentinel";

const profile = (overrides: Partial<SocialProfileRow>): SocialProfileRow => ({
  handle: "",
  platform: "twitter",
  classification: "suspicious",
  profile_url: null,
  brand_name: "Acme",
  ...overrides,
});

describe("findSocialMatchesForDomain", () => {
  it("matches when the full domain appears in profile_url", () => {
    const profiles = [
      profile({ profile_url: "https://twitter.com/scam-paypa1.com" }),
      profile({ profile_url: "https://example.com/unrelated" }),
    ];
    const matches = findSocialMatchesForDomain(profiles, "paypa1.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.profile_url).toBe("https://twitter.com/scam-paypa1.com");
  });

  it("matches when the domain's first label appears in handle", () => {
    const profiles = [
      profile({ handle: "fake_paypa1_official" }),
      profile({ handle: "stripe_support" }),
    ];
    const matches = findSocialMatchesForDomain(profiles, "paypa1.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.handle).toBe("fake_paypa1_official");
  });

  it("does not double-count a profile that matches both URL and handle", () => {
    const profiles = [
      profile({
        profile_url: "https://x.com/paypa1_imposter",
        handle: "paypa1_imposter",
      }),
    ];
    const matches = findSocialMatchesForDomain(profiles, "paypa1.com");
    expect(matches).toHaveLength(1);
  });

  it("respects the LIMIT cap (default 3) — same as the old SQL", () => {
    const profiles = Array.from({ length: 10 }, (_, i) =>
      profile({ handle: `paypa1_${i}` }),
    );
    const matches = findSocialMatchesForDomain(profiles, "paypa1.com");
    expect(matches).toHaveLength(3);
  });

  it("returns empty when no profile contains the domain or first-label", () => {
    const profiles = [
      profile({ handle: "stripe_support", profile_url: "https://x.com/stripe" }),
      profile({ handle: "shopify_help", profile_url: "https://x.com/shopify" }),
    ];
    const matches = findSocialMatchesForDomain(profiles, "paypa1.com");
    expect(matches).toHaveLength(0);
  });

  it("skips profiles with empty handle and null profile_url cleanly", () => {
    // Defensive: SQL's LIKE '%' || handle || '%' would match anything
    // when handle is empty. Our matcher requires a non-empty
    // domainKeyword AND a non-empty handle to match — same effective
    // result as the SQL for non-trivial domains.
    const profiles = [
      profile({ handle: "", profile_url: null }),
      profile({ handle: "paypa1", profile_url: null }),
    ];
    const matches = findSocialMatchesForDomain(profiles, "paypa1.com");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.handle).toBe("paypa1");
  });
});
