// Strict hostname validator for anonymous domain input (stored-XSS fix
// on /assess + /api/brand-scan/public, 2026-10-05).

import { describe, it, expect } from "vitest";
import { normalizePublicHostname } from "../src/lib/public-hostname";

describe("normalizePublicHostname", () => {
  it.each([
    ["example.com", "example.com"],
    ["Example.COM", "example.com"],
    ["  example.com  ", "example.com"],
    ["https://example.com/some/path?q=1#frag", "example.com"],
    ["http://sub.example.co.uk/", "sub.example.co.uk"],
    ["example.com:8443", "example.com"],
    ["example.com.", "example.com"],
    ["example.com?x=<script>", "example.com"],
    ["a-b.example.org", "a-b.example.org"],
    ["123.example.com", "123.example.com"],
    ["xn--mnchen-3ya.de", "xn--mnchen-3ya.de"],
    ["münchen.de", "xn--mnchen-3ya.de"],
    ["example.xn--p1ai", "example.xn--p1ai"],
    ["www.example.com", "www.example.com"],
  ])("accepts %j → %j", (input, expected) => {
    expect(normalizePublicHostname(input)).toBe(expected);
  });

  it("strips www. only when asked", () => {
    expect(normalizePublicHostname("https://www.example.com/", { stripWww: true })).toBe("example.com");
  });

  it.each([
    "<img src=x onerror=alert(1)>.com",
    "<script>.com",
    "exa<mple.com",
    "exa>mple.com",
    'ex"ample.com',
    "ex'ample.com",
    "exa mple.com",
    "example.com evil",
    "exa`mple.com",
    "user@example.com",
    "example",
    "localhost",
    "",
    "   ",
    ".com",
    "example..com",
    "-example.com",
    "example-.com",
    "exa_mple.com",
    "1.2.3.4",
    "example.c0m",
    "example.c",
    "[::1]",
    "example.com:abc",
    "javascript:alert(1).com",
    "münchen<x>.de",
  ])("rejects %j", (input) => {
    expect(normalizePublicHostname(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizePublicHostname(undefined)).toBeNull();
    expect(normalizePublicHostname(null)).toBeNull();
    expect(normalizePublicHostname(42)).toBeNull();
    expect(normalizePublicHostname({ toString: () => "example.com" })).toBeNull();
  });

  it("enforces the 63-char label and 253-char total limits", () => {
    const label63 = "a".repeat(63);
    expect(normalizePublicHostname(`${label63}.com`)).toBe(`${label63}.com`);
    expect(normalizePublicHostname(`${"a".repeat(64)}.com`)).toBeNull();

    // 4 × 63 + 3 dots = 255 > 253
    const tooLong = [label63, label63, label63, "com".padStart(63, "a")].join(".");
    expect(tooLong.length).toBeGreaterThan(253);
    expect(normalizePublicHostname(tooLong)).toBeNull();

    // 3 × 63 + 59 + 3 dots = 251 ≤ 253, with a letter TLD
    const okLong = [label63, label63, label63, "c".repeat(59)].join(".");
    expect(okLong.length).toBeLessThanOrEqual(253);
    expect(normalizePublicHostname(okLong)).toBe(okLong);

    expect(normalizePublicHostname(`example.com/${"x".repeat(5000)}`)).toBeNull();
  });
});
