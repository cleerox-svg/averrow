/**
 * Bounded SPF include-tree walk (src/lib/spf-walk.ts): RFC 7208 lookup /
 * void-lookup counting, loops, and the hard amplification caps (queries,
 * wall time, depth, visits, name validation). A failed or timed-out lookup
 * makes the walk `unknown` — never pass, never fail.
 */

import { describe, it, expect } from "vitest";
import { parseSpfRecord, SPF_MAX_RECORD_LENGTH } from "../src/lib/spf-record";
import {
  walkSpfTree,
  spfWalkName,
  SPF_WALK_MAX_QUERIES,
  SPF_WALK_BUDGET_MS,
  SPF_WALK_MAX_DEPTH,
  type SpfTxtLookup,
} from "../src/lib/spf-walk";

type Answer = { status: "ok" | "nxdomain" | "error"; records: string[] } | "hang" | "throw";

function fakeDns(zone: Record<string, Answer>) {
  const queried: string[] = [];
  const lookup: SpfTxtLookup = async (name) => {
    queried.push(name);
    const a = zone[name] ?? { status: "nxdomain", records: [] };
    if (a === "hang") return new Promise(() => {});
    if (a === "throw") throw new Error("boom");
    return a;
  };
  return { lookup, queried };
}

const ok = (...records: string[]): Answer => ({ status: "ok", records });
const root = (rec: string) => parseSpfRecord(rec)!;

describe("spfWalkName (what may be queried)", () => {
  it("accepts public names, including underscore labels", () => {
    expect(spfWalkName("_spf.google.com")).toBe("_spf.google.com");
    expect(spfWalkName("SPF.Protection.Outlook.com.")).toBe("spf.protection.outlook.com");
  });
  it("refuses macros, IP literals, malformed / over-long and internal names", () => {
    for (const bad of [
      "%{i}._spf.acme.com", "192.0.2.1", "[2001:db8::1]", "nodots", "bad..name.com",
      "-x.com", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`, "spf.corp", "mail.internal",
      "host.local", "localhost", "x.test", "x.example", "1.2.3.4.in-addr.arpa", "x.onion", "x.123",
    ]) {
      expect(spfWalkName(bad), bad).toBeNull();
    }
  });
});

describe("walkSpfTree — counting", () => {
  it("counts lookups across the tree (complete)", async () => {
    const { lookup } = fakeDns({
      "_spf.google.com": ok("v=spf1 include:_netblocks.google.com include:_netblocks2.google.com ~all"),
      "_netblocks.google.com": ok("v=spf1 ip4:192.0.2.0/24 ~all"),
      "_netblocks2.google.com": ok("v=spf1 ip6:2001:db8::/32 ~all"),
    });
    const w = await walkSpfTree("acme.com", root("v=spf1 mx include:_spf.google.com -all"), lookup);
    expect(w.status).toBe("complete");
    // mx + include (root) + 2 includes (google) = 4
    expect(w.lookupCount).toBe(4);
    expect(w.voidLookups).toBe(0);
    expect(w.queries).toBe(3);
    expect(w.effectiveAllQualifier).toBe("-");
  });

  it("10-lookup boundary: exactly 10 is fine, 11 is over", async () => {
    const zone: Record<string, Answer> = {};
    for (let i = 0; i < 9; i++) zone[`i${i}.acme.com`] = ok("v=spf1 ip4:192.0.2.1 -all");
    const { lookup } = fakeDns(zone);
    const nine = Array.from({ length: 9 }, (_, i) => `include:i${i}.acme.com`).join(" ");
    const ten = await walkSpfTree("acme.com", root(`v=spf1 a ${nine} -all`), lookup);
    expect(ten.lookupCount).toBe(10);
    const eleven = await walkSpfTree("acme.com", root(`v=spf1 a mx ${nine} -all`), lookup);
    expect(eleven.lookupCount).toBe(11);
    expect(eleven.status).toBe("complete");
  });

  it("counts a duplicate include per occurrence but queries it once", async () => {
    const { lookup, queried } = fakeDns({
      "a.acme.com": ok("v=spf1 a mx -all"),
    });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:a.acme.com include:a.acme.com -all"), lookup);
    expect(w.lookupCount).toBe(2 + 2 * 2);
    expect(queried).toEqual(["a.acme.com"]);
  });

  it("counts void lookups (NXDOMAIN and empty answers) and missing SPF records", async () => {
    const { lookup } = fakeDns({
      "gone1.com": { status: "nxdomain", records: [] },
      "gone2.com": ok(),
      "gone3.com": { status: "nxdomain", records: [] },
      "nospf.com": ok("google-site-verification=x"),
    });
    const w = await walkSpfTree(
      "acme.com",
      root("v=spf1 include:gone1.com include:gone2.com include:gone3.com include:nospf.com -all"),
      lookup,
    );
    expect(w.status).toBe("complete");
    expect(w.voidLookups).toBe(3);
    expect(w.missingRecordAt).toEqual(["gone1.com", "gone2.com", "gone3.com", "nospf.com"]);
  });

  it("detects loops without re-querying", async () => {
    const { lookup, queried } = fakeDns({
      "a.acme.com": ok("v=spf1 include:b.acme.com -all"),
      "b.acme.com": ok("v=spf1 include:a.acme.com -all"),
    });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:a.acme.com -all"), lookup);
    expect(w.loopAt).toEqual(["a.acme.com"]);
    expect(w.status).toBe("complete");
    expect(queried).toEqual(["a.acme.com", "b.acme.com"]);
  });

  it("detects a loop back to the root", async () => {
    const { lookup } = fakeDns({ "a.acme.com": ok("v=spf1 include:acme.com -all") });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:a.acme.com -all"), lookup);
    expect(w.loopAt).toEqual(["acme.com"]);
  });

  it("follows a redirect for the effective `all` and flags ptr / syntax / multiple records", async () => {
    const { lookup } = fakeDns({
      "_spf.acme.com": ok("v=spf1 ptr include:multi.com include:bad.com ~all"),
      "multi.com": ok("v=spf1 -all", "v=spf1 ~all"),
      "bad.com": ok("v=spf1 foo -all"),
    });
    const w = await walkSpfTree("acme.com", root("v=spf1 redirect=_spf.acme.com"), lookup);
    expect(w.effectiveAllQualifier).toBe("~");
    expect(w.ptrAt).toEqual(["_spf.acme.com"]);
    expect(w.multipleRecordsAt).toEqual(["multi.com"]);
    expect(w.syntaxErrorAt).toEqual(["bad.com"]);
    // redirect + ptr + include + include = 4
    expect(w.lookupCount).toBe(4);
  });
});

describe("walkSpfTree — hard caps and honesty", () => {
  it("lookup error → unknown (not void, not pass)", async () => {
    const { lookup } = fakeDns({ "a.com": { status: "error", records: [] } });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:a.com -all"), lookup);
    expect(w.status).toBe("unknown");
    expect(w.incompleteReasons).toEqual(["lookup_error"]);
    expect(w.voidLookups).toBe(0);
    expect(w.missingRecordAt).toEqual([]);
  });

  it("a throwing lookup → unknown", async () => {
    const { lookup } = fakeDns({ "a.com": "throw" });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:a.com -all"), lookup);
    expect(w.status).toBe("unknown");
  });

  it("timeout → unknown within the wall-clock budget", async () => {
    const { lookup } = fakeDns({ "a.com": "hang" });
    const t0 = Date.now();
    const w = await walkSpfTree("acme.com", root("v=spf1 include:a.com include:b.com -all"), lookup, { budgetMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(w.status).toBe("unknown");
    expect(w.incompleteReasons).toContain("time_budget");
  });

  it("stops querying at the deadline (fake clock)", async () => {
    let t = 0;
    const lookup: SpfTxtLookup = async () => { t += 1_500; return { status: "ok", records: ["v=spf1 -all"] }; };
    const includes = Array.from({ length: 6 }, (_, i) => `include:i${i}.acme.com`).join(" ");
    const w = await walkSpfTree("acme.com", root(`v=spf1 ${includes} -all`), lookup, { now: () => t });
    expect(w.queries).toBe(Math.ceil(SPF_WALK_BUDGET_MS / 1_500));
    expect(w.status).toBe("unknown");
    expect(w.incompleteReasons).toContain("time_budget");
  });

  it("a fan-out tree stops as soon as >10 lookups are proven (no further queries)", async () => {
    let n = 0;
    const queried: string[] = [];
    const lookup: SpfTxtLookup = async (name) => {
      queried.push(name);
      const kids = Array.from({ length: 5 }, () => `include:n${n++}.attacker.com`).join(" ");
      return { status: "ok", records: [`v=spf1 ${kids} -all`] };
    };
    const kids = Array.from({ length: 5 }, (_, i) => `include:r${i}.attacker.com`).join(" ");
    const w = await walkSpfTree("acme.com", root(`v=spf1 ${kids} -all`), lookup);
    // root 5 + r0's 5 = 10, r0's first child adds 5 → 15 > 10 → stop.
    expect(queried).toEqual(["r0.attacker.com", "n0.attacker.com"]);
    expect(w.stoppedAtLimit).toBe(true);
    expect(w.status).toBe("complete");
    expect(w.lookupCount).toBe(15);
    expect(w.queries).toBeLessThan(SPF_WALK_MAX_QUERIES);
  });

  it("the query cap still bounds a walk (defence in depth)", async () => {
    const { lookup, queried } = fakeDns({
      "a.acme.com": ok("v=spf1 -all"), "b.acme.com": ok("v=spf1 -all"), "c.acme.com": ok("v=spf1 -all"),
    });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:a.acme.com include:b.acme.com include:c.acme.com -all"), lookup, { maxQueries: 2 });
    expect(queried).toEqual(["a.acme.com", "b.acme.com"]);
    expect(w.status).toBe("unknown");
    expect(w.incompleteReasons).toEqual(["query_cap"]);
  });

  it("a 5,000-include record (~140 KB): cut at 64 KiB, limit proven, zero queries, fast", async () => {
    const huge = `v=spf1 ${Array.from({ length: 5_000 }, (_, i) => `include:h${i}.attacker.com`).join(" ")} -all`;
    const t0 = Date.now();
    const parsed = root(huge);
    expect(parsed.truncated).toBe(true);
    expect(parsed.includeTargets.length).toBeGreaterThan(2_000);
    const { lookup, queried } = fakeDns({});
    const w = await walkSpfTree("acme.com", parsed, lookup);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(queried).toEqual([]);
    expect(w.stoppedAtLimit).toBe(true);
    expect(w.lookupCount).toBe(parsed.includeTargets.length);
    expect(w.status).toBe("unknown");
    expect(w.incompleteReasons).toEqual(["record_too_long"]);
  });

  it("2,000 includes under 64 KiB: every term scanned (trailing -all kept), limit proven, zero queries", async () => {
    const big = `v=spf1 ${Array.from({ length: 2_000 }, (_, i) => `include:h${i}.attacker.com`).join(" ")} -all`;
    expect(big.length).toBeLessThan(SPF_MAX_RECORD_LENGTH);
    const parsed = root(big);
    expect(parsed.truncated).toBe(false);
    expect(parsed.allQualifier).toBe("-");
    const { lookup, queried } = fakeDns({});
    const w = await walkSpfTree("acme.com", parsed, lookup);
    expect(queried).toEqual([]);
    expect(w).toMatchObject({ stoppedAtLimit: true, lookupCount: 2_000, status: "complete", effectiveAllQualifier: "-" });
  });

  it("a record over 64 KiB is cut at the bound and the walk is unknown", async () => {
    const huge = `v=spf1 ${Array.from({ length: 5_000 }, (_, i) => `ip4:192.0.${i % 250}.${i % 250}`).join(" ")} -all`;
    expect(huge.length).toBeGreaterThan(SPF_MAX_RECORD_LENGTH);
    const parsed = root(huge);
    expect(parsed.truncated).toBe(true);
    expect(parsed.syntaxErrors).toEqual([]);
    const w = await walkSpfTree("acme.com", parsed, fakeDns({}).lookup);
    expect(w.status).toBe("unknown");
    expect(w.incompleteReasons).toEqual(["record_too_long"]);
  });

  it("an included record with +all is reported (not the root policy)", async () => {
    const { lookup } = fakeDns({
      "lax.acme.com": ok("v=spf1 +all"),
      "_spf.acme.com": ok("v=spf1 all"),
    });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:lax.acme.com redirect=_spf.acme.com"), lookup);
    expect(w.includePassAllAt).toEqual(["lax.acme.com"]);
    // The redirect target is the root's effective policy, not an include.
    expect(w.effectiveAllQualifier).toBe("+");
  });

  it("caps nesting depth", async () => {
    const lookup: SpfTxtLookup = async (name) => {
      const d = Number(/^d(\d+)\./.exec(name)![1]);
      return { status: "ok", records: [`v=spf1 include:d${d + 1}.acme.com -all`] };
    };
    const w = await walkSpfTree("acme.com", root("v=spf1 include:d1.acme.com -all"), lookup);
    expect(w.queries).toBe(SPF_WALK_MAX_DEPTH);
    expect(w.incompleteReasons).toEqual(["depth_cap"]);
  });

  it("a diamond of duplicate includes stops at the proven limit (CPU bound)", async () => {
    const { lookup, queried } = fakeDns({
      "x1.acme.com": ok("v=spf1 include:x2.acme.com include:x2.acme.com include:x2.acme.com -all"),
      "x2.acme.com": ok("v=spf1 include:x3.acme.com include:x3.acme.com include:x3.acme.com -all"),
      "x3.acme.com": ok("v=spf1 include:x4.acme.com include:x4.acme.com include:x4.acme.com -all"),
      "x4.acme.com": ok("v=spf1 include:x5.acme.com include:x5.acme.com include:x5.acme.com -all"),
    });
    const w = await walkSpfTree("acme.com", root("v=spf1 include:x1.acme.com -all"), lookup);
    // 1 + 3 (x1) + 3 (x2) + 3 (x3 #1) = 10, x4 #1 → 13: stop.
    expect(queried).toEqual(["x1.acme.com", "x2.acme.com", "x3.acme.com", "x4.acme.com"]);
    expect(w.stoppedAtLimit).toBe(true);
  });

  it("no per-target work after the visit cap", async () => {
    const { lookup, queried } = fakeDns({
      "a.acme.com": ok("v=spf1 -all"), "b.acme.com": ok("v=spf1 -all"), "c.acme.com": ok("v=spf1 -all"),
    });
    const w = await walkSpfTree(
      "acme.com", root("v=spf1 include:a.acme.com include:b.acme.com include:c.acme.com -all"), lookup, { maxVisits: 2 },
    );
    // Visit 1 = root, visit 2 = a; b is fetched but its visit trips the cap; c is never touched.
    expect(queried).toEqual(["a.acme.com", "b.acme.com"]);
    expect(w.incompleteReasons).toEqual(["visit_cap"]);
  });

  it("never queries invalid, macro or internal names", async () => {
    const { lookup, queried } = fakeDns({});
    const w = await walkSpfTree(
      "acme.com",
      root("v=spf1 include:%{i}.acme.com include:192.0.2.1 include:mail.internal include:x.local -all"),
      lookup,
    );
    expect(queried).toEqual([]);
    expect(w.status).toBe("unknown");
    expect(w.incompleteReasons.sort()).toEqual(["invalid_name", "macro"]);
    // They still count as lookups a receiver would spend.
    expect(w.lookupCount).toBe(4);
  });
});
