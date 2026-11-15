/**
 * Dangling SPF include confirmation (rubric 4): registrable-domain
 * extraction, NXDOMAIN-only trigger, one RDAP verdict per scan, RDAP
 * failures are `unknown` (never `unregistered`, never a score change),
 * unregistered → SPF scores 0, KV cache, and no RDAP on public paths.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMAIL_SCORE_RUBRIC_VERSION,
  calculateEmailSecurityScore,
  checkSpf,
  generateRecommendations,
  hasUnregisteredInclude,
  parseStoredSpfFindings,
  type EmailSecurityScanInput,
  type SpfResult,
} from "../src/email-security";
import { confidentRegistrable, spfRdapChecker, type SpfRdapCheck } from "../src/lib/spf-dangling";
import { rdapDomainRegistration } from "../src/lib/whois";
import { isRubricOnlyGradeChange } from "../src/lib/email-grade-change";
import type { SpfTxtLookup } from "../src/lib/spf-walk";
import type { Env } from "../src/types";

type Zone = Record<string, { status: "ok" | "nxdomain" | "error"; records: string[] }>;
function dns(zone: Zone): SpfTxtLookup {
  return async (name) => zone[name] ?? { status: "nxdomain", records: [] };
}
const ok = (...records: string[]) => ({ status: "ok" as const, records });

function scanWith(spf: SpfResult): EmailSecurityScanInput {
  return {
    dmarc: { exists: true, policy: "reject", pct: 100, rua: "mailto:a@b.example", ruf: null, raw: "v=DMARC1; p=reject" },
    spf,
    dkim: { exists: true, selectorsFound: ["google"], raw: null },
    mx: { exists: true, providers: [] },
  };
}
const score = (spf: SpfResult) => calculateEmailSecurityScore(scanWith(spf)).score;
const codes = (spf: SpfResult) => (spf.findings ?? []).map((f) => f.code);

afterEach(() => { vi.unstubAllGlobals(); });

describe("rubric 4", () => {
  it("is 4, and a 3 → 4 grade change is a rubric artefact (suppressed)", () => {
    expect(EMAIL_SCORE_RUBRIC_VERSION).toBe(4);
    expect(isRubricOnlyGradeChange(3)).toBe(true);
    expect(isRubricOnlyGradeChange(4)).toBe(false);
  });
});

describe("confidentRegistrable", () => {
  it("accepts 2-label names and explicitly listed multi-label suffixes", () => {
    expect(confidentRegistrable("oldvendor.com")).toBe("oldvendor.com");
    expect(confidentRegistrable("_spf.oldvendor.com")).toBe("oldvendor.com");
    expect(confidentRegistrable("mail.oldvendor.co.uk.")).toBe("oldvendor.co.uk");
  });
  it("refuses public suffixes, tenant hosts and heuristic ccTLD guesses", () => {
    expect(confidentRegistrable("co.uk")).toBeNull();
    expect(confidentRegistrable("com")).toBeNull();
    expect(confidentRegistrable("acme.myshopify.com")).toBeNull();
    expect(confidentRegistrable("acme.tokyo.jp")).toBeNull();
  });
});

describe("checkSpf dangling include confirmation", () => {
  const root = "v=spf1 include:gone-vendor.com -all";

  it("unregistered → finding, SPF scores 0, recommendation is CRITICAL", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "unregistered");
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, undefined, rdap);
    expect(rdap).toHaveBeenCalledTimes(1);
    expect(rdap.mock.calls[0]![0]).toBe("gone-vendor.com");
    expect(codes(spf)).toContain("include_target_unregistered");
    expect(codes(spf)).toContain("include_target_missing");
    expect(hasUnregisteredInclude(spf)).toBe(true);
    const clean = await checkSpf("acme.com", dns({ "acme.com": ok(root) }));
    expect(score(clean) - score(spf)).toBe(30); // 10 + 15 + 5
    const recs = generateRecommendations(scanWith(spf));
    expect(recs.some((r) => r.startsWith("CRITICAL: An SPF include points at gone-vendor.com, which is not registered."))).toBe(true);
  });

  it("subdomain target: the registrable domain is probed and must be NXDOMAIN", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "unregistered");
    const zone: Zone = { "acme.com": ok("v=spf1 include:_spf.gone-vendor.com -all") };
    const spf = await checkSpf("acme.com", dns(zone), undefined, undefined, rdap);
    expect(rdap).toHaveBeenCalledWith("gone-vendor.com", expect.any(Number));
    expect(hasUnregisteredInclude(spf)).toBe(true);

    // registrable domain exists (has TXT) → only the subdomain is missing → no RDAP
    const rdap2 = vi.fn<SpfRdapCheck>(async () => "unregistered");
    const spf2 = await checkSpf("acme.com", dns({ ...zone, "gone-vendor.com": ok("hello") }), undefined, undefined, rdap2);
    expect(rdap2).not.toHaveBeenCalled();
    expect(hasUnregisteredInclude(spf2)).toBe(false);
  });

  it("an existing target with no SPF record is NOT a candidate (not NXDOMAIN)", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "unregistered");
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root), "gone-vendor.com": ok("not spf") }), undefined, undefined, rdap);
    expect(rdap).not.toHaveBeenCalled();
    expect(codes(spf)).toContain("include_target_missing");
    expect(codes(spf)).not.toContain("include_target_unregistered");
  });

  it("makes at most ONE RDAP lookup per scan", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "registered");
    await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 include:a-gone.com include:b-gone.com include:c-gone.com -all") }),
      undefined, undefined, rdap);
    expect(rdap).toHaveBeenCalledTimes(1);
  });

  it("registered → no finding, score unchanged", async () => {
    const rdap: SpfRdapCheck = async () => "registered";
    const a = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, undefined, rdap);
    const b = await checkSpf("acme.com", dns({ "acme.com": ok(root) }));
    expect(codes(a)).toEqual(codes(b));
    expect(score(a)).toBe(score(b));
  });

  it("unknown → informational finding only; score and recommendations unchanged", async () => {
    const rdap: SpfRdapCheck = async () => "unknown";
    const a = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, undefined, rdap);
    const b = await checkSpf("acme.com", dns({ "acme.com": ok(root) }));
    expect(codes(a)).toContain("include_target_unverified");
    expect(hasUnregisteredInclude(a)).toBe(false);
    expect(score(a)).toBe(score(b));
    expect(generateRecommendations(scanWith(a))).toEqual(generateRecommendations(scanWith(b)));
  });

  it("a throwing checker never fails the scan", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, undefined, async () => { throw new Error("x"); });
    expect(spf.exists).toBe(true);
    expect(hasUnregisteredInclude(spf)).toBe(false);
  });

  it("no checker (public paths) → no RDAP and no finding", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root) }));
    expect(codes(spf)).not.toContain("include_target_unregistered");
    expect(codes(spf)).not.toContain("include_target_unverified");
  });

  it("a capped scan with too little budget left skips RDAP", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "unregistered");
    await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, { rootTimeoutMs: 3_000, totalMs: 1_000 }, rdap);
    expect(rdap).not.toHaveBeenCalled();
  });

  it("stored findings round-trip with validated names only", () => {
    const f = parseStoredSpfFindings(JSON.stringify([
      { code: "include_target_unregistered", names: ["gone-vendor.com", "<script>"] },
      { code: "include_target_unverified", names: ["x.com"] },
    ]));
    expect(f).toEqual([
      { code: "include_target_unregistered", names: ["gone-vendor.com"] },
      { code: "include_target_unverified", names: ["x.com"] },
    ]);
  });
});

describe("public paths make no RDAP call", () => {
  const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
  it("only brand-scan callers with a Worker env pass spfRdap", () => {
    for (const p of ["src/lib/free-scan-view.ts", "src/handlers/brandScan.ts", "src/handlers/publicEmailSecurity.ts"]) {
      try { expect(src(p)).not.toMatch(/spfRdap/); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
    }
    // The lead report scans a domain a prospect supplied, so it makes no RDAP call either.
    expect(src("src/handlers/qualifiedReport.ts")).not.toMatch(/spfRdap/);
  });
});

function stubFetch(rdap: (url: string, init?: RequestInit) => Promise<Response>) {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("data.iana.org")) throw new Error("bootstrap down"); // static fallback table
    return rdap(String(url), init);
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const env = { CACHE: { get: async () => null, put: async () => undefined } } as unknown as Env;

describe("rdapDomainRegistration", () => {
  it("404 → unregistered, 200 domain → registered", async () => {
    stubFetch(async () => new Response("{}", { status: 404 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unregistered");
    stubFetch(async () => new Response(JSON.stringify({ objectClassName: "domain" }), { status: 200 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("registered");
  });
  it("429 / 5xx / odd body / invalid name / no server → unknown", async () => {
    stubFetch(async () => new Response("", { status: 429 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    stubFetch(async () => new Response("", { status: 503 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    stubFetch(async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    const f = stubFetch(async () => new Response("{}", { status: 404 }));
    expect(await rdapDomainRegistration(env, "bad name!.com", 1000)).toBe("unknown");
    expect(await rdapDomainRegistration(env, "gone-vendor.zzzzunknowntld", 1000)).toBe("unknown");
    expect(f.mock.calls.every(([u]) => String(u).includes("data.iana.org"))).toBe(true);
  });
  it("timeout → unknown, never unregistered", async () => {
    stubFetch((_u, init) => new Promise((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
    }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 60)).toBe("unknown");
  });
});

describe("spfRdapChecker KV cache", () => {
  function kvEnv() {
    const store = new Map<string, { v: string; ttl?: number }>();
    const e = {
      CACHE: {
        get: async (k: string) => store.get(k)?.v ?? null,
        put: async (k: string, v: string, o?: { expirationTtl?: number }) => { store.set(k, { v, ttl: o?.expirationTtl }); },
      },
    } as unknown as Env;
    return { e, store };
  }
  it("caches a verdict per registrable domain for 24 h and reuses it", async () => {
    const { e, store } = kvEnv();
    const f = stubFetch(async () => new Response("{}", { status: 404 }));
    const check = spfRdapChecker(e);
    expect(await check("gone-vendor.com", 3000)).toBe("unregistered");
    const calls = f.mock.calls.length;
    expect(await check("gone-vendor.com", 3000)).toBe("unregistered");
    expect(f.mock.calls.length).toBe(calls);
    expect(store.get("spf:rdap:v1:gone-vendor.com")).toEqual({ v: "unregistered", ttl: 86_400 });
  });
  it("caches unknown only briefly", async () => {
    const { e, store } = kvEnv();
    stubFetch(async () => new Response("", { status: 429 }));
    expect(await spfRdapChecker(e)("gone-vendor.com", 3000)).toBe("unknown");
    expect(store.get("spf:rdap:v1:gone-vendor.com")?.ttl).toBe(600);
  });
});
