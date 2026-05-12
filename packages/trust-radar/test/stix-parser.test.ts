/**
 * STIX 2.1 pattern parser tests.
 *
 * Pins the single-comparison pattern semantics that lib/stix-parser.ts
 * relies on. If a public TAXII feed serves a shape we mis-parse, the
 * fix lands here first and the regex follows.
 */

import { describe, it, expect } from "vitest";
import {
  parseStixPattern,
  parseIndicator,
  iterParsedIndicators,
  type StixIndicator,
  type StixBundle,
} from "../src/lib/stix-parser";

describe("parseStixPattern", () => {
  it("parses an IPv4 indicator", () => {
    expect(parseStixPattern("[ipv4-addr:value = '1.2.3.4']")).toEqual({
      objectType: "ipv4-addr",
      property: "value",
      value: "1.2.3.4",
    });
  });

  it("parses an IPv6 indicator", () => {
    expect(parseStixPattern("[ipv6-addr:value = '2001:db8::1']")).toEqual({
      objectType: "ipv6-addr",
      property: "value",
      value: "2001:db8::1",
    });
  });

  it("parses a domain indicator", () => {
    expect(parseStixPattern("[domain-name:value = 'evil.example']")).toEqual({
      objectType: "domain-name",
      property: "value",
      value: "evil.example",
    });
  });

  it("parses a URL indicator with path + query", () => {
    expect(
      parseStixPattern("[url:value = 'https://evil.example/path?q=1']"),
    ).toEqual({
      objectType: "url",
      property: "value",
      value: "https://evil.example/path?q=1",
    });
  });

  it("parses a file hash (MD5)", () => {
    expect(
      parseStixPattern("[file:hashes.MD5 = 'd41d8cd98f00b204e9800998ecf8427e']"),
    ).toEqual({
      objectType: "file",
      property: "hashes.md5",
      value: "d41d8cd98f00b204e9800998ecf8427e",
    });
  });

  it("parses a file hash (SHA-256 with quoted dashes)", () => {
    expect(
      parseStixPattern("[file:hashes.'SHA-256' = 'a'.repeat(64)]"),
    ).toBeNull();
    // Real example — STIX uses the quoted form for hyphenated hash names.
    const result = parseStixPattern(
      "[file:hashes.'SHA-256' = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']",
    );
    expect(result).toEqual({
      objectType: "file",
      property: "hashes.sha-256",
      value: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("parses an email-addr indicator", () => {
    expect(parseStixPattern("[email-addr:value = 'phish@evil.example']")).toEqual({
      objectType: "email-addr",
      property: "value",
      value: "phish@evil.example",
    });
  });

  it("tolerates extra whitespace", () => {
    expect(
      parseStixPattern("  [ ipv4-addr : value  =  '1.2.3.4' ]  "),
    ).toEqual({ objectType: "ipv4-addr", property: "value", value: "1.2.3.4" });
  });

  it("returns null for Boolean composition (AND)", () => {
    expect(
      parseStixPattern(
        "[ipv4-addr:value = '1.2.3.4'] AND [domain-name:value = 'evil.example']",
      ),
    ).toBeNull();
  });

  it("returns null for Boolean composition (OR)", () => {
    expect(
      parseStixPattern(
        "[ipv4-addr:value = '1.1.1.1'] OR [ipv4-addr:value = '2.2.2.2']",
      ),
    ).toBeNull();
  });

  it("returns null for FOLLOWEDBY qualifier", () => {
    expect(
      parseStixPattern(
        "[file:name = 'a.bin'] FOLLOWEDBY [file:name = 'b.bin']",
      ),
    ).toBeNull();
  });

  it("returns null for unsupported syntax (regex MATCHES)", () => {
    expect(
      parseStixPattern("[url:value MATCHES 'evil-.+\\.example']"),
    ).toBeNull();
  });

  it("returns null for empty / malformed input", () => {
    expect(parseStixPattern("")).toBeNull();
    expect(parseStixPattern("not-a-pattern")).toBeNull();
    expect(parseStixPattern("[only-object-type]")).toBeNull();
  });
});

describe("parseIndicator", () => {
  function makeInd(overrides: Partial<StixIndicator>): StixIndicator {
    return {
      type: "indicator",
      id: "indicator--abc",
      pattern: "[ipv4-addr:value = '1.2.3.4']",
      pattern_type: "stix",
      ...overrides,
    };
  }

  it("maps ipv4-addr → ip_address + malicious_ip with default confidence", () => {
    const r = parseIndicator(makeInd({}));
    // Default confidence is 60 (deriveSeverity returns "low" at the
    // 60-84 band for malicious_ip / scanning / malicious_ssl; "info"
    // is reserved for sub-60 confidence indicators).
    expect(r).toEqual({
      iocField: "ip_address",
      iocValue: "1.2.3.4",
      threatType: "malicious_ip",
      confidence: 60,
      severity: "low",
    });
  });

  it("returns severity=info when confidence is below the low threshold", () => {
    const r = parseIndicator(makeInd({ confidence: 30 }));
    expect(r?.severity).toBe("info");
  });

  it("maps a phishing-labeled domain to phishing/malicious_domain", () => {
    const r = parseIndicator(
      makeInd({
        pattern: "[domain-name:value = 'PaYPaL-LOgin.example']",
        labels: ["phishing"],
        confidence: 92,
      }),
    );
    expect(r?.iocField).toBe("malicious_domain");
    // Domain values lower-case for stable dedup.
    expect(r?.iocValue).toBe("paypal-login.example");
    expect(r?.threatType).toBe("phishing");
    expect(r?.severity).toBe("high");
  });

  it("escalates a C2-typed indicator to high/critical based on confidence", () => {
    const low = parseIndicator(
      makeInd({ indicator_types: ["malicious-activity"], labels: ["c2"], confidence: 70 }),
    );
    expect(low?.threatType).toBe("c2");
    expect(low?.severity).toBe("high");

    const hi = parseIndicator(
      makeInd({ indicator_types: ["malicious-activity"], labels: ["c2"], confidence: 95 }),
    );
    expect(hi?.severity).toBe("critical");
  });

  it("packs an email IOC under ioc_value with the `email:` prefix", () => {
    const r = parseIndicator(
      makeInd({ pattern: "[email-addr:value = 'PHISH@evil.example']" }),
    );
    expect(r?.iocField).toBe("ioc_value");
    expect(r?.iocValue).toBe("email:phish@evil.example");
  });

  it("packs a file hash with the `hash:<alg>:` prefix", () => {
    const r = parseIndicator(
      makeInd({
        pattern:
          "[file:hashes.'SHA-256' = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']",
        labels: ["malware"],
      }),
    );
    expect(r?.iocField).toBe("ioc_value");
    expect(r?.iocValue).toBe(
      "hash:sha-256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(r?.threatType).toBe("malware_distribution");
  });

  it("skips non-hash file properties to avoid noise", () => {
    expect(
      parseIndicator(
        makeInd({ pattern: "[file:name = 'invoice.pdf']" }),
      ),
    ).toBeNull();
  });

  it("skips non-stix pattern dialects", () => {
    expect(
      parseIndicator(
        makeInd({
          pattern: "rule SomeYara { strings: $a = \"x\" condition: $a }",
          pattern_type: "yara",
        }),
      ),
    ).toBeNull();
  });
});

describe("iterParsedIndicators", () => {
  it("yields only indicator objects, skips relationships / malware / etc.", () => {
    const bundle: StixBundle = {
      type: "bundle",
      objects: [
        { type: "malware", id: "malware--1", name: "Emotet" },
        {
          type: "indicator",
          id: "indicator--1",
          pattern: "[ipv4-addr:value = '1.1.1.1']",
          pattern_type: "stix",
          labels: ["c2"],
          confidence: 80,
        },
        { type: "relationship", id: "relationship--1" },
        {
          type: "indicator",
          id: "indicator--2",
          pattern: "[ipv4-addr:value = '1.1.1.1'] OR [ipv4-addr:value = '2.2.2.2']",
          pattern_type: "stix",
        },
        {
          type: "indicator",
          id: "indicator--3",
          pattern: "[domain-name:value = 'evil.test']",
          pattern_type: "stix",
          labels: ["phishing"],
        },
      ],
    };

    const yielded = Array.from(iterParsedIndicators(bundle));
    expect(yielded.length).toBe(2);
    expect(yielded[0]?.parsed.iocValue).toBe("1.1.1.1");
    expect(yielded[0]?.parsed.threatType).toBe("c2");
    expect(yielded[1]?.parsed.iocValue).toBe("evil.test");
    expect(yielded[1]?.parsed.threatType).toBe("phishing");
  });

  it("handles a bundle with no objects", () => {
    expect(Array.from(iterParsedIndicators({ type: "bundle" }))).toEqual([]);
    expect(
      Array.from(iterParsedIndicators({ type: "bundle", objects: [] })),
    ).toEqual([]);
  });
});
