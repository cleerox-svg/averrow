/**
 * Tests for the abuse-mailbox brand matcher (PR-BA).
 *
 * Covers the five signal paths in priority order:
 *   1. URL-domain exact (canonical or subdomain)
 *   2. URL-domain typosquat (homoglyph / hyphenated-suffix / edit-1)
 *   3. From-domain exact / subdomain
 *   4. From-domain typosquat
 *   5. Subject keyword
 *   6. Body keyword (also confirms cutoff at MIN_KEYWORD_LEN)
 *
 * Plus negative cases: no match → null, short brand names ignored,
 * matches against own canonical_domain don't fire typosquat path.
 */

import { describe, it, expect } from "vitest";
import {
  matchAbuseMailboxBrand,
  isTyposquatOf,
  type MonitoredBrandRow,
} from "../src/lib/abuse-mailbox-brand-match";

const BRANDS: MonitoredBrandRow[] = [
  { id: "brand_mcafee",    name: "McAfee",    canonical_domain: "mcafee.com" },
  { id: "brand_paypal",    name: "PayPal",    canonical_domain: "paypal.com" },
  { id: "brand_microsoft", name: "Microsoft", canonical_domain: "microsoft.com" },
  // Short-name brand — should be ignored (keyword < 4 chars after normalize)
  { id: "brand_uk",        name: "UK",        canonical_domain: "uk.example" },
];

const EMPTY_INPUT = {
  from_domain:  null,
  subject:      null,
  body_snippet: null,
  url_domains:  [] as string[],
};

describe("matchAbuseMailboxBrand", () => {
  it("returns null when no signals fire", () => {
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, subject: "nothing to see here" },
      BRANDS,
    );
    expect(r).toBeNull();
  });

  it("returns null when the brand catalog is empty", () => {
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, from_domain: "mcafee-secure-update.example" },
      [],
    );
    expect(r).toBeNull();
  });

  it("URL-domain exact match wins (confidence 95)", () => {
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, url_domains: ["mcafee.com"] },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_mcafee");
    expect(r?.signal).toBe("url_domain_exact");
    expect(r?.confidence).toBe(95);
  });

  it("URL-domain subdomain match counts as exact (open redirect / spoofed subdomain)", () => {
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, url_domains: ["login.mcafee.com.bad.example", "evil.mcafee.com"] },
      BRANDS,
    );
    // evil.mcafee.com ends with .mcafee.com → match
    expect(r?.brand_id).toBe("brand_mcafee");
    expect(r?.signal).toBe("url_domain_exact");
  });

  it("URL-domain typosquat fires when no exact match", () => {
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, url_domains: ["mcafee-secure-update.example"] },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_mcafee");
    expect(r?.signal).toBe("url_domain_typosquat");
    expect(r?.confidence).toBe(90);
  });

  it("From-domain exact wins over subject/body when no URL signal", () => {
    const r = matchAbuseMailboxBrand(
      {
        ...EMPTY_INPUT,
        from_domain: "notify.paypal.com",
        subject:     "Your McAfee bill",
      },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_paypal");
    expect(r?.signal).toBe("from_domain_exact");
  });

  it("From-domain typosquat (real-world: mcafee-secure-update.example)", () => {
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, from_domain: "mcafee-secure-update.example" },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_mcafee");
    expect(r?.signal).toBe("from_domain_typosquat");
    expect(r?.confidence).toBe(85);
  });

  it("From-domain typosquat — ASCII homoglyph substitution (a→4)", () => {
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, from_domain: "p4ypal.example" },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_paypal");
    expect(r?.signal).toBe("from_domain_typosquat");
  });

  it("From-domain typosquat — Unicode homoglyph (Cyrillic а) caught by levenshtein-1", () => {
    // Cyrillic 'а' (U+0430) reads identically to ASCII 'a' (U+0061) —
    // a real, common typosquat technique. Our levenshtein-1 check
    // treats it as a single-char substitution from "paypal", so the
    // match fires even though the homoglyph table is ASCII-only.
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, from_domain: "pаypal.example" },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_paypal");
    expect(r?.signal).toBe("from_domain_typosquat");
  });

  it("Subject keyword (signal 4, conf 65)", () => {
    const r = matchAbuseMailboxBrand(
      {
        ...EMPTY_INPUT,
        subject: "Your McAfee subscription has expired — act now",
      },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_mcafee");
    expect(r?.signal).toBe("subject_keyword");
    expect(r?.confidence).toBe(65);
  });

  it("Body keyword (signal 5, conf 50)", () => {
    const r = matchAbuseMailboxBrand(
      {
        ...EMPTY_INPUT,
        body_snippet: "Hi — please verify your Microsoft account immediately",
      },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_microsoft");
    expect(r?.signal).toBe("body_keyword");
    expect(r?.confidence).toBe(50);
  });

  it("ignores brand names shorter than MIN_KEYWORD_LEN (4 chars)", () => {
    // "UK" (2 chars) shouldn't fire on "Your UK account" subject —
    // would create constant false positives.
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, subject: "Your UK account is suspended" },
      BRANDS,
    );
    expect(r).toBeNull();
  });

  it("URL-domain exact beats From-domain when both present", () => {
    const r = matchAbuseMailboxBrand(
      {
        ...EMPTY_INPUT,
        url_domains: ["mcafee.com"],
        from_domain: "paypal.com",
      },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_mcafee");
    expect(r?.signal).toBe("url_domain_exact");
  });

  it("does NOT typosquat-match the brand's own canonical_domain", () => {
    // The signal_3 exact-match path returns first, so this confirms
    // typosquat logic doesn't double-match the same name.
    const r = matchAbuseMailboxBrand(
      { ...EMPTY_INPUT, from_domain: "mcafee.com" },
      BRANDS,
    );
    expect(r?.brand_id).toBe("brand_mcafee");
    expect(r?.signal).toBe("from_domain_exact"); // not typosquat
  });
});

describe("isTyposquatOf", () => {
  it("hyphenated suffix variants", () => {
    expect(isTyposquatOf("mcafee-secure-update", "mcafee.com")).toBe(true);
    expect(isTyposquatOf("mcafee-renewal", "mcafee.com")).toBe(true);
    expect(isTyposquatOf("paypal-billing", "paypal.com")).toBe(true);
  });

  it("homoglyph substitutions (l→1, o→0, etc.)", () => {
    expect(isTyposquatOf("paypa1", "paypal.com")).toBe(true);
    expect(isTyposquatOf("micr0soft", "microsoft.com")).toBe(true);
  });

  it("single-edit substitution (≥6-char SLD)", () => {
    expect(isTyposquatOf("microsofy", "microsoft.com")).toBe(true);
    expect(isTyposquatOf("microsft", "microsoft.com")).toBe(true);  // deletion
  });

  it("rejects exact SLD match (caller handles this path)", () => {
    expect(isTyposquatOf("mcafee", "mcafee.com")).toBe(false);
  });

  it("rejects unrelated domains", () => {
    expect(isTyposquatOf("totally-different", "mcafee.com")).toBe(false);
    expect(isTyposquatOf("google", "microsoft.com")).toBe(false);
  });

  it("rejects too-short canonical (< MIN_KEYWORD_LEN)", () => {
    expect(isTyposquatOf("uk-renewal", "uk.example")).toBe(false);
  });
});
