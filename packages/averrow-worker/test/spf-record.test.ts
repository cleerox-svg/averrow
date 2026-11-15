/**
 * RFC 7208 SPF record parser (src/lib/spf-record.ts).
 */

import { describe, it, expect } from "vitest";
import { parseSpfRecord, selectSpfRecords, isSpfRecord, hasSpfMacro } from "../src/lib/spf-record";

describe("isSpfRecord / selectSpfRecords", () => {
  it("accepts v=spf1 followed by a space or the end, case-insensitively", () => {
    expect(isSpfRecord("v=spf1 -all")).toBe(true);
    expect(isSpfRecord("V=SPF1 -all")).toBe(true);
    expect(isSpfRecord("v=spf1")).toBe(true);
    expect(isSpfRecord("v=spf10 -all")).toBe(false);
    expect(isSpfRecord("google-site-verification=abc")).toBe(false);
  });

  it("picks every SPF record out of a TXT RRset (more than one is a permerror)", () => {
    expect(selectSpfRecords(["MS=ms123", "v=spf1 -all", "v=spf1 include:a.com ~all"])).toEqual([
      "v=spf1 -all",
      "v=spf1 include:a.com ~all",
    ]);
  });
});

describe("parseSpfRecord", () => {
  it("returns null for a non-SPF record", () => {
    expect(parseSpfRecord("v=DMARC1; p=reject")).toBeNull();
    expect(parseSpfRecord(null)).toBeNull();
  });

  it("parses every mechanism with its qualifier", () => {
    const r = parseSpfRecord(
      "v=spf1 ip4:192.0.2.0/24 ip6:2001:db8::/32 a mx:mail.acme.com/24 ptr exists:%{i}.x.acme.com include:_spf.google.com ?include:b.com -all",
    )!;
    expect(r.syntaxErrors).toEqual([]);
    expect(r.mechanisms.map((m) => `${m.qualifier}${m.name}`)).toEqual([
      "+ip4", "+ip6", "+a", "+mx", "+ptr", "+exists", "+include", "?include", "-all",
    ]);
    expect(r.mechanisms[0]!.value).toBe("192.0.2.0");
    expect(r.mechanisms[3]!.value).toBe("mail.acme.com");
    expect(r.allQualifier).toBe("-");
    expect(r.includeTargets).toEqual(["_spf.google.com", "b.com"]);
    // a, mx, ptr, exists, include, include = 6 DNS-querying terms
    expect(r.lookupTerms).toBe(6);
    expect(r.usesPtr).toBe(true);
  });

  it("reads a bare `all` as +all and the four qualifiers", () => {
    expect(parseSpfRecord("v=spf1 all")!.allQualifier).toBe("+");
    expect(parseSpfRecord("v=spf1 +all")!.allQualifier).toBe("+");
    expect(parseSpfRecord("v=spf1 ~all")!.allQualifier).toBe("~");
    expect(parseSpfRecord("v=spf1 ?all")!.allQualifier).toBe("?");
    expect(parseSpfRecord("v=spf1 include:a.com")!.allQualifier).toBeNull();
  });

  it("does not match `all` inside a domain (the old regex read include:spf-all.example as -all)", () => {
    const r = parseSpfRecord("v=spf1 include:spf-all.com")!;
    expect(r.allQualifier).toBeNull();
  });

  it("counts redirect only when there is no `all` (RFC 7208 §6.1)", () => {
    const withAll = parseSpfRecord("v=spf1 redirect=_spf.acme.com -all")!;
    expect(withAll.redirect).toBe("_spf.acme.com");
    expect(withAll.redirectApplies).toBe(false);
    expect(withAll.lookupTerms).toBe(0);
    const noAll = parseSpfRecord("v=spf1 redirect=_spf.acme.com")!;
    expect(noAll.redirectApplies).toBe(true);
    expect(noAll.lookupTerms).toBe(1);
  });

  it("ignores terms after the first `all` (never evaluated, §5.1)", () => {
    const r = parseSpfRecord("v=spf1 include:a.com -all include:b.com ptr")!;
    expect(r.includeTargets).toEqual(["a.com"]);
    expect(r.lookupTerms).toBe(1);
    expect(r.usesPtr).toBe(false);
  });

  it("flags syntax errors without echoing record text", () => {
    const cases: Array<[string, RegExp]> = [
      ["v=spf1 foo:bar.com -all", /unknown mechanism/],
      ["v=spf1 include -all", /include requires a domain/],
      ["v=spf1 exists: -all", /exists requires a domain/],
      ["v=spf1 all:x.com", /all takes no argument/],
      ["v=spf1 ip4:999.1.1.1 -all", /invalid ip4 address/],
      ["v=spf1 ip4:192.0.2.1/33 -all", /invalid ip4 cidr length/],
      ["v=spf1 ip6:zz::1 -all", /invalid ip6 address/],
      ["v=spf1 a/40 -all", /invalid a cidr length/],
      ["v=spf1 redirect=a.com redirect=b.com", /duplicate redirect modifier/],
      ["v=spf1 include:%x.com -all", /include requires a domain/],
    ];
    for (const [rec, re] of cases) {
      const r = parseSpfRecord(rec)!;
      expect(r.syntaxErrors.join("; "), rec).toMatch(re);
      for (const e of r.syntaxErrors) expect(e).not.toMatch(/bar\.com|x\.com|999/);
    }
  });

  it("accepts dual-cidr a/mx and ignores unknown modifiers", () => {
    const r = parseSpfRecord("v=spf1 a/24//64 mx:acme.com//48 foo=bar exp=explain.acme.com -all")!;
    expect(r.syntaxErrors).toEqual([]);
    expect(r.exp).toBe("explain.acme.com");
    expect(r.lookupTerms).toBe(2);
  });

  it("detects macros", () => {
    expect(hasSpfMacro("%{i}._spf.acme.com")).toBe(true);
    expect(hasSpfMacro("_spf.acme.com")).toBe(false);
  });
});
