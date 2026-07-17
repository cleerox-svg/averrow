import { describe, it, expect } from "vitest";
import { generateBrandKeywords } from "../src/lib/brand-utils";

describe("generateBrandKeywords", () => {
  it("generates keywords from simple brand name and domain", () => {
    const keywords = generateBrandKeywords("example.com", "Example");
    expect(keywords).toContain("example"); // domain base and brand name lowercase
  });

  it("includes domain base (part before first dot)", () => {
    const keywords = generateBrandKeywords("acme.com", "Acme Corp");
    expect(keywords).toContain("acme");
  });

  it("includes lowercased brand name", () => {
    const keywords = generateBrandKeywords("acme.com", "Acme Corp");
    expect(keywords).toContain("acme corp");
  });

  it("includes no-space variant of brand name", () => {
    const keywords = generateBrandKeywords("acme.com", "Acme Corp");
    expect(keywords).toContain("acmecorp");
  });

  it("includes hyphenated variant of brand name", () => {
    const keywords = generateBrandKeywords("acme.com", "Acme Corp");
    expect(keywords).toContain("acme-corp");
  });

  it("de-duplicates when domain base matches brand name", () => {
    const keywords = generateBrandKeywords("example.com", "Example");
    // "example" is both domain base and brand name lowercase — should appear once
    const exampleCount = keywords.filter((k) => k === "example").length;
    expect(exampleCount).toBe(1);
  });

  it("de-duplicates no-space variant when it matches domain base", () => {
    // Brand "Example" → no-space "example" → same as domain base "example"
    const keywords = generateBrandKeywords("example.com", "Example");
    // Should not have duplicates
    const unique = new Set(keywords);
    expect(unique.size).toBe(keywords.length);
  });

  it("handles brand with multiple spaces", () => {
    const keywords = generateBrandKeywords("my-brand.com", "My Brand Name");
    expect(keywords).toContain("my brand name");
    expect(keywords).toContain("mybrandname");
    expect(keywords).toContain("my-brand-name");
    expect(keywords).toContain("my-brand"); // domain base
  });

  it("handles long domain name", () => {
    const keywords = generateBrandKeywords("verylongdomainname.com", "Company");
    expect(keywords).toContain("verylongdomainname");
    expect(keywords).toContain("company");
  });

  it("handles empty brand name", () => {
    const keywords = generateBrandKeywords("example.com", "");
    // domain base "example" + brand name "" + no-space "" + hyphenated ""
    expect(keywords).toContain("example");
    expect(keywords.length).toBeGreaterThanOrEqual(1);
  });

  it("handles empty domain", () => {
    // "".split('.')[0] = "" → keywords.add("")
    const keywords = generateBrandKeywords("", "Brand");
    expect(keywords).toContain("brand");
  });

  it("handles both empty inputs", () => {
    const keywords = generateBrandKeywords("", "");
    // Will contain "" from domain base and brand name
    expect(Array.isArray(keywords)).toBe(true);
  });

  it("handles special characters in brand name", () => {
    const keywords = generateBrandKeywords("brand-co.com", "Brand & Co");
    expect(keywords).toContain("brand & co");
    expect(keywords).toContain("brand&co"); // no-space variant removes only whitespace
    expect(keywords).toContain("brand-&-co"); // hyphenated variant
    expect(keywords).toContain("brand-co"); // domain base
  });

  it("handles domain with multiple dots", () => {
    const keywords = generateBrandKeywords("sub.example.co.uk", "Example");
    // domain base is "sub" (first part before .)
    expect(keywords).toContain("sub");
    expect(keywords).toContain("example");
  });

  it("returns an array (not a Set)", () => {
    const keywords = generateBrandKeywords("test.com", "Test");
    expect(Array.isArray(keywords)).toBe(true);
  });

  it("all keywords are lowercase", () => {
    const keywords = generateBrandKeywords("Test.com", "TEST BRAND");
    for (const kw of keywords) {
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("handles single character brand name", () => {
    const keywords = generateBrandKeywords("x.com", "X");
    expect(keywords).toContain("x");
  });
});
