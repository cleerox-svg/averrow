/**
 * Tests for the constant-time secret helpers (PR-BQ).
 *
 * We cannot directly assert that the function is constant-time
 * (microbenchmarks on JS engines are unreliable; CPU scheduling
 * noise dominates). What we CAN test:
 *   - Correctness: equal vs. unequal returns the right boolean.
 *   - The naive `===` short-circuit is gone (verified via SQL/source
 *     scan in PR-BP review; here we just test behavior).
 *   - Edge cases: empty strings, null/undefined inputs, missing
 *     "Bearer " prefix, length mismatch.
 *
 * The downstream consumer (15 callers in index.ts + the unsub
 * token check) is exercised by the existing /api/internal/* and
 * /api/abuse-mailbox/unsubscribe integration suites.
 */

import { describe, it, expect } from "vitest";
import { timingSafeEqual, timingSafeBearerEq } from "../src/lib/internal-secret";

describe("timingSafeEqual", () => {
  it("returns true for byte-identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual(
      "deadbeef1234abcd5678ef901234567890abcdef0",
      "deadbeef1234abcd5678ef901234567890abcdef0",
    )).toBe(true);
  });

  it("returns false for different lengths (short-circuit OK — lengths aren't secret)", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
    expect(timingSafeEqual("x", "")).toBe(false);
  });

  it("returns false for equal-length strings that differ at the FIRST byte", () => {
    expect(timingSafeEqual("Xbc", "abc")).toBe(false);
  });

  it("returns false for equal-length strings that differ at the LAST byte", () => {
    expect(timingSafeEqual("abX", "abc")).toBe(false);
  });

  it("returns false for equal-length strings that differ in the middle", () => {
    expect(timingSafeEqual("abXdef", "abcdef")).toBe(false);
  });

  it("handles full secret-sized strings (40-char hex tokens)", () => {
    const a = "0123456789abcdef0123456789abcdef01234567";
    const b = "0123456789abcdef0123456789abcdef01234567";
    const c = "0123456789abcdef0123456789abcdef01234568"; // last byte
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual(a, c)).toBe(false);
  });
});

describe("timingSafeBearerEq", () => {
  it("accepts a correctly-formatted Bearer header", () => {
    expect(timingSafeBearerEq("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects a Bearer header with the wrong secret", () => {
    expect(timingSafeBearerEq("Bearer wrong", "s3cret")).toBe(false);
  });

  it("rejects a header without the 'Bearer ' prefix", () => {
    expect(timingSafeBearerEq("s3cret", "s3cret")).toBe(false);
    expect(timingSafeBearerEq("Token s3cret", "s3cret")).toBe(false);
  });

  it("rejects when the secret is undefined (unset env binding)", () => {
    expect(timingSafeBearerEq("Bearer anything", undefined)).toBe(false);
  });

  it("rejects when the secret is empty string", () => {
    // Empty secret should NEVER authenticate, even against "Bearer ".
    expect(timingSafeBearerEq("Bearer ", "")).toBe(false);
    expect(timingSafeBearerEq("", "")).toBe(false);
  });

  it("rejects when the auth header is null/undefined", () => {
    expect(timingSafeBearerEq(null, "s3cret")).toBe(false);
    expect(timingSafeBearerEq(undefined, "s3cret")).toBe(false);
  });

  it("rejects an empty auth header", () => {
    expect(timingSafeBearerEq("", "s3cret")).toBe(false);
  });

  it("is case-sensitive on the 'Bearer' prefix (matches the previous code)", () => {
    // The pre-PR-BQ code compared against literal `Bearer ${secret}`.
    // Preserve that strictness — lowercase `bearer` should fail.
    expect(timingSafeBearerEq("bearer s3cret", "s3cret")).toBe(false);
  });

  it("rejects extra whitespace in the header", () => {
    expect(timingSafeBearerEq("Bearer  s3cret", "s3cret")).toBe(false);
    expect(timingSafeBearerEq(" Bearer s3cret", "s3cret")).toBe(false);
  });
});
