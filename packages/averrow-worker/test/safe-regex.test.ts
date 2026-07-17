import { describe, it, expect } from "vitest";
import {
  safeCompilePattern,
  MAX_REGEX_SOURCE_LEN,
  MAX_REGEX_QUANTIFIERS,
} from "../src/lib/safe-regex";

describe("safeCompilePattern", () => {
  it("compiles a normal catalog pattern and matches as before", () => {
    const re = safeCompilePattern("microsoft\\.com\\/devicelogin", "i");
    expect(re).not.toBeNull();
    expect(re?.test("https://microsoft.com/devicelogin")).toBe(true);
  });

  it("compiles the longest current seed pattern (well under the cap)", () => {
    // Longest regex_signatures entry in migration 0204.
    const src = "login\\.microsoftonline\\.com\\/[^\\s\"]*device(?:code|auth)";
    expect(src.length).toBeLessThan(MAX_REGEX_SOURCE_LEN);
    const re = safeCompilePattern(src, "i");
    expect(re).not.toBeNull();
    expect(
      re?.test("login.microsoftonline.com/common/oauth2/devicecode"),
    ).toBe(true);
  });

  it("compiles the DMARC tag-template pattern", () => {
    const re = safeCompilePattern("<record[^>]*>([\\s\\S]*?)</record>", "gi");
    expect(re).not.toBeNull();
  });

  it("rejects an over-long source (returns null, does not throw)", () => {
    const src = "a".repeat(MAX_REGEX_SOURCE_LEN + 1);
    expect(safeCompilePattern(src)).toBeNull();
  });

  it("accepts a source exactly at the length cap", () => {
    const src = "a".repeat(MAX_REGEX_SOURCE_LEN);
    expect(safeCompilePattern(src)).not.toBeNull();
  });

  it("rejects an over-complex source (too many quantifiers)", () => {
    const src = "a*".repeat(MAX_REGEX_QUANTIFIERS + 1);
    expect(safeCompilePattern(src)).toBeNull();
  });

  it("returns null for a syntactically invalid source", () => {
    expect(safeCompilePattern("(unclosed")).toBeNull();
  });
});
