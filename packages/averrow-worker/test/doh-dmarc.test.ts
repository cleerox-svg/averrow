/**
 * Tests for the DoH TXT helpers (PR-BB).
 *
 * Covers the two pure helpers: stripDohQuotes and parseDmarcPolicy.
 * The network-side dohTxtLookup is exercised at the integration
 * level by the FC reminder path; the parsing logic owns the bug
 * surface here.
 */

import { describe, it, expect } from "vitest";
import { stripDohQuotes, parseDmarcPolicy } from "../src/lib/doh";

describe("stripDohQuotes", () => {
  it("strips a single-segment TXT record's outer quotes", () => {
    expect(stripDohQuotes('"v=DMARC1; p=none; rua=mailto:a@b.example"'))
      .toBe('v=DMARC1; p=none; rua=mailto:a@b.example');
  });

  it("concatenates multi-segment split TXT records", () => {
    // DNS TXT records can be split into 255-char chunks; DoH returns
    // them as `"chunk1" "chunk2"`.
    expect(stripDohQuotes('"v=DMARC1; p=quarantine; " "rua=mailto:x@y.example"'))
      .toBe('v=DMARC1; p=quarantine; rua=mailto:x@y.example');
  });

  it("falls back to raw string when no quote framing is present", () => {
    expect(stripDohQuotes('bare-value')).toBe('bare-value');
  });

  it("handles empty quoted segments", () => {
    expect(stripDohQuotes('""')).toBe('');
  });
});

describe("parseDmarcPolicy", () => {
  it("returns 'none' for p=none", () => {
    expect(parseDmarcPolicy("v=DMARC1; p=none; rua=mailto:r@e.example")).toBe("none");
  });

  it("returns 'quarantine' for p=quarantine (the target state)", () => {
    expect(parseDmarcPolicy("v=DMARC1; p=quarantine; pct=100"))
      .toBe("quarantine");
  });

  it("returns 'reject' for p=reject (the eventual target after quarantine settles)", () => {
    expect(parseDmarcPolicy("v=DMARC1; p=reject")).toBe("reject");
  });

  it("is case- and whitespace-tolerant", () => {
    expect(parseDmarcPolicy("V=DMARC1 ; P = Quarantine ; pct=100")).toBe("quarantine");
  });

  it("returns null when the record is not DMARC at all", () => {
    expect(parseDmarcPolicy("v=spf1 include:_spf.google.com ~all")).toBeNull();
  });

  it("returns null when DMARC is malformed (missing p=)", () => {
    expect(parseDmarcPolicy("v=DMARC1; rua=mailto:r@e.example")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseDmarcPolicy("")).toBeNull();
  });
});
