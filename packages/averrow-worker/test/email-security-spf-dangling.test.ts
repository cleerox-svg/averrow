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
  scanInputFromStoredRow,
  type EmailSecurityScanInput,
  type SpfResult,
  type StoredEmailScanRow,
} from "../src/email-security";
import { confidentRegistrable, spfRdapChecker, SPF_RDAP_TIMEOUT_MS, type SpfRdapCheck } from "../src/lib/spf-dangling";
import { rdapDomainRegistration } from "../src/lib/whois";
import { resetRdapBootstrapMemoryForTests } from "../src/lib/rdap-bootstrap";
import { isRubricOnlyGradeChange, isSpfUncertaintyOnlyGradeChange } from "../src/lib/email-grade-change";
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

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); resetRdapBootstrapMemoryForTests(); });

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
  it("refuses restricted multi-label suffixes and underscore labels", () => {
    expect(confidentRegistrable("_spf.council.gov.uk")).toBeNull();
    expect(confidentRegistrable("council.gov.uk")).toBeNull();
    expect(confidentRegistrable("uni.ac.uk")).toBeNull();
    expect(confidentRegistrable("force.police.uk")).toBeNull();
    expect(confidentRegistrable("trust.nhs.uk")).toBeNull();
    expect(confidentRegistrable("agency.govt.nz")).toBeNull();
    expect(confidentRegistrable("city.lg.jp")).toBeNull();
    expect(confidentRegistrable("dept.gov.au")).toBeNull();
    expect(confidentRegistrable("x.edu.au")).toBeNull();
    expect(confidentRegistrable("x.gov.ng")).toBeNull(); // unlisted heuristic suffix
    expect(confidentRegistrable("bad_label.com")).toBeNull();
    expect(confidentRegistrable("_spf.bad_label.com")).toBeNull();
  });
  it("keeps open multi-label suffixes", () => {
    for (const sfx of ["co.uk", "org.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br", "co.za", "com.mx", "co.in"]) {
      expect(confidentRegistrable(`_spf.vendor.${sfx}`)).toBe(`vendor.${sfx}`);
    }
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

  it("a capped scan with too little budget left skips RDAP and reports the include unverified", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "unregistered");
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, { rootTimeoutMs: 3_000, totalMs: 300 }, rdap);
    expect(rdap).not.toHaveBeenCalled();
    expect(codes(spf)).toContain("include_target_unverified");
    expect(hasUnregisteredInclude(spf)).toBe(false);
  });

  it("RDAP gets min(budget left after the DNS probes, SPF_RDAP_TIMEOUT_MS)", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "registered");
    // the DoH probe of the registrable domain eats ~1.5 s of a 2.5 s budget
    const zone: Zone = { "acme.com": ok("v=spf1 include:_spf.gone-vendor.com -all") };
    const slow: SpfTxtLookup = async (name, t) => {
      if (name === "gone-vendor.com") { await new Promise((r) => setTimeout(r, 1_500)); return { status: "nxdomain", records: [] }; }
      return dns(zone)(name, t);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const p = checkSpf("acme.com", slow, undefined, { rootTimeoutMs: 1_000, totalMs: 2_500 }, rdap);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(rdap).toHaveBeenCalledTimes(1);
    const t = rdap.mock.calls[0]![1];
    expect(t).toBeLessThanOrEqual(1_000);
    expect(t).toBeGreaterThanOrEqual(500);

    // no budget: the full RDAP cap
    const rdap2 = vi.fn<SpfRdapCheck>(async () => "registered");
    await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, undefined, rdap2);
    expect(rdap2.mock.calls[0]![1]).toBe(SPF_RDAP_TIMEOUT_MS);
  });

  it("probes past the deadline are skipped → no candidate, unverified never guessed as unregistered", async () => {
    const rdap = vi.fn<SpfRdapCheck>(async () => "unregistered");
    const zone: Zone = { "acme.com": ok("v=spf1 include:_spf.gone-vendor.com -all") };
    vi.useFakeTimers({ toFake: ["Date"] });
    const lookup: SpfTxtLookup = async (name, t) => {
      if (name === "acme.com") vi.setSystemTime(Date.now() + 2_000); // root answer eats the whole budget
      return dns(zone)(name, t);
    };
    const spf = await checkSpf("acme.com", lookup, undefined, { rootTimeoutMs: 1_000, totalMs: 1_500 }, rdap);
    expect(rdap).not.toHaveBeenCalled();
    expect(hasUnregisteredInclude(spf)).toBe(false);
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
    for (const p of ["src/lib/free-scan-view.ts", "src/handlers/brandScan.ts", "src/handlers/scanReport.ts"]) {
      expect(src(p)).not.toMatch(/spfRdap/);
    }
    // The lead report scans a domain a prospect supplied, so it makes no RDAP call either.
    expect(src("src/handlers/qualifiedReport.ts")).not.toMatch(/spfRdap/);
  });
  it("the public email-security check handler's scan call passes no spfRdap", () => {
    const file = src("src/handlers/emailSecurity.ts");
    const start = file.indexOf("export async function handlePublicEmailSecurity(");
    expect(start).toBeGreaterThan(-1);
    const next = file.indexOf("\nexport async function ", start + 1);
    const body = file.slice(start, next === -1 ? undefined : next);
    const calls = body.match(/runEmailSecurityScan\w*\([^;]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).not.toMatch(/spfRdap/);
    expect(body).not.toMatch(/spfRdapChecker/);
  });
});

const BOOTSTRAP = {
  services: [
    [["com"], ["https://rdap.verisign.com/com/v1/"]],
    [["plain"], ["http://rdap.example-plain.test/"]],
  ],
};
/** fetch stub: the IANA bootstrap answers BOOTSTRAP (or fails with
 *  `bootstrapDown`); every other URL goes to `rdap`. */
function stubFetch(rdap: (url: string, init?: RequestInit) => Promise<Response>, opts: { bootstrapDown?: boolean } = {}) {
  resetRdapBootstrapMemoryForTests();
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("data.iana.org")) {
      if (opts.bootstrapDown) throw new Error("bootstrap down");
      return new Response(JSON.stringify(BOOTSTRAP), { status: 200, headers: { "content-type": "application/json" } });
    }
    return rdap(String(url), init);
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const rdap404 = () => new Response(JSON.stringify({ errorCode: 404, title: "Not Found" }), {
  status: 404, headers: { "content-type": "application/rdap+json" },
});
const env = { CACHE: { get: async () => null, put: async () => undefined } } as unknown as Env;

describe("rdapDomainRegistration", () => {
  it("RDAP 404 → unregistered, 200 domain → registered", async () => {
    stubFetch(async () => rdap404());
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unregistered");
    // JSON body with errorCode 404 and a generic content-type also counts
    stubFetch(async () => new Response(JSON.stringify({ errorCode: 404 }), { status: 404, headers: { "content-type": "application/json" } }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unregistered");
    stubFetch(async () => new Response(JSON.stringify({ objectClassName: "domain" }), { status: 200 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("registered");
  });
  it("fetches with redirect: 'manual'; any 3xx → unknown", async () => {
    const f = stubFetch(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/404" } }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    const rdapCall = f.mock.calls.find(([u]) => !String(u).includes("data.iana.org"));
    expect(rdapCall?.[1]?.redirect).toBe("manual");
    stubFetch(async () => new Response(null, { status: 301 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
  });
  it("a non-RDAP 404 (HTML / proxy page / JSON without errorCode 404) → unknown", async () => {
    stubFetch(async () => new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    stubFetch(async () => new Response("{}", { status: 404 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    stubFetch(async () => new Response(JSON.stringify({ errorCode: 500 }), { status: 404 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    // oversized body is not parsed
    stubFetch(async () => new Response(JSON.stringify({ errorCode: 404, pad: "x".repeat(20_000) }), { status: 404 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
  });
  it("bootstrap unavailable (static fallback server) → unknown, no RDAP request", async () => {
    const f = stubFetch(async () => rdap404(), { bootstrapDown: true });
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    expect(f.mock.calls.every(([u]) => String(u).includes("data.iana.org"))).toBe(true);
  });
  it("TLD absent from the bootstrap (static fallback only) → unknown", async () => {
    const f = stubFetch(async () => rdap404());
    expect(await rdapDomainRegistration(env, "gone-vendor.net", 1000)).toBe("unknown"); // .net only in STATIC_FALLBACK here
    expect(f.mock.calls.every(([u]) => String(u).includes("data.iana.org"))).toBe(true);
  });
  it("an http:// bootstrap base → unknown, no RDAP request", async () => {
    const f = stubFetch(async () => rdap404());
    expect(await rdapDomainRegistration(env, "gone-vendor.plain", 1000)).toBe("unknown");
    expect(f.mock.calls.every(([u]) => String(u).includes("data.iana.org"))).toBe(true);
  });
  it("429 / 5xx / odd body / invalid name / no server → unknown", async () => {
    stubFetch(async () => new Response("", { status: 429 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    stubFetch(async () => new Response("", { status: 503 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    stubFetch(async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 }));
    expect(await rdapDomainRegistration(env, "gone-vendor.com", 1000)).toBe("unknown");
    const f = stubFetch(async () => rdap404());
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
    const f = stubFetch(async () => rdap404());
    const check = spfRdapChecker(e);
    expect(await check("gone-vendor.com", 3000)).toBe("unregistered");
    const calls = f.mock.calls.length;
    expect(await check("gone-vendor.com", 3000)).toBe("unregistered");
    expect(f.mock.calls.length).toBe(calls);
    expect(store.get("spf:rdap:v2:gone-vendor.com")).toEqual({ v: "unregistered", ttl: 86_400 });
  });
  it("caches unknown only briefly", async () => {
    const { e, store } = kvEnv();
    stubFetch(async () => new Response("", { status: 429 }));
    expect(await spfRdapChecker(e)("gone-vendor.com", 3000)).toBe("unknown");
    expect(store.get("spf:rdap:v2:gone-vendor.com")?.ttl).toBe(600);
  });
});

// ─── Rubric 4: an included `+all` scores like a root `+all` ───────────────

describe("include_pass_all scores SPF 0 (takeover is never an improvement)", () => {
  const root = "v=spf1 include:gone-vendor.com -all";
  it("scores the same as a root +all and a confirmed unregistered include", async () => {
    const hijacked = await checkSpf("acme.com", dns({ "acme.com": ok(root), "gone-vendor.com": ok("v=spf1 +all") }));
    expect(codes(hijacked)).toContain("include_pass_all");
    const rootPassAll = await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 +all") }));
    const unregistered = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), undefined, undefined, async () => "unregistered");
    expect(score(hijacked)).toBe(score(rootPassAll));
    expect(score(hijacked)).toBe(score(unregistered));
    const clean = await checkSpf("acme.com", dns({ "acme.com": ok(root), "gone-vendor.com": ok("v=spf1 -all") }));
    expect(score(clean) - score(hijacked)).toBe(30);
    const recs = generateRecommendations(scanWith(hijacked)).join("\n");
    expect(recs).toMatch(/CRITICAL: An included SPF record ends in "\+all" \(gone-vendor\.com\).*SPF scores 0/);
  });
  it("a redirect target ending in +all is a root +all (pass_all)", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 redirect=_spf.acme.com"), "_spf.acme.com": ok("v=spf1 +all") }));
    expect(spf.policy).toBe("+all");
    expect(score(spf)).toBe(score(await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 +all") }))));
  });
  it("a stored row is rescored identically", () => {
    const r = baseRow({ spf_findings: JSON.stringify([{ code: "include_pass_all", names: ["gone-vendor.com"] }]) });
    const input = scanInputFromStoredRow(r);
    expect(calculateEmailSecurityScore(input).score).toBe(calculateEmailSecurityScore(scanInputFromStoredRow(baseRow({ spf_policy: "+all" }))).score);
    expect(calculateEmailSecurityScore(input).score).toBe(calculateEmailSecurityScore(scanInputFromStoredRow(baseRow())).score - 30);
  });
});

// ─── Grade change: an unverified include holds only its own verdict ───────

function baseRow(over: Partial<StoredEmailScanRow> = {}): StoredEmailScanRow {
  return {
    dmarc_exists: 1, dmarc_policy: "reject", dmarc_pct: 100, dmarc_rua: "mailto:a@b.example",
    dmarc_sp: null, dmarc_np: null, dmarc_t: null,
    spf_exists: 1, spf_policy: "-all", spf_too_many_lookups: 0, spf_raw: "v=spf1 include:gone-vendor.com -all",
    spf_lookup_count: 1, spf_void_lookups: 1, spf_walk_status: "complete",
    spf_findings: JSON.stringify([{ code: "include_target_missing", names: ["gone-vendor.com"] }]),
    dkim_exists: 1, dkim_selectors_found: '["google"]', mx_exists: 1, mx_providers: "[]",
    ...over,
  };
}
const withFindings = (extra: object[], over: Partial<StoredEmailScanRow> = {}) => baseRow({
  spf_findings: JSON.stringify([{ code: "include_target_missing", names: ["gone-vendor.com"] }, ...extra]),
  ...over,
});
const UNREG = { code: "include_target_unregistered", names: ["gone-vendor.com"] };
const UNVER = { code: "include_target_unverified", names: ["gone-vendor.com"] };
const rowGrade = (r: StoredEmailScanRow) => calculateEmailSecurityScore(scanInputFromStoredRow(r)).grade;

describe("isSpfUncertaintyOnlyGradeChange — dangling include", () => {
  it("unregistered → unverified (lookup failed) is suppressed, and the reverse", () => {
    const prev = withFindings([UNREG]);
    const curr = withFindings([UNVER]);
    expect(rowGrade(prev)).not.toBe(rowGrade(curr));
    expect(isSpfUncertaintyOnlyGradeChange(prev, curr)).toBe(true);
    expect(isSpfUncertaintyOnlyGradeChange(curr, prev)).toBe(true);
  });
  it("a new real downgrade in the same tree (lookup limit newly exceeded) still alerts", () => {
    const prev = withFindings([]);
    const curr = withFindings([UNVER, { code: "lookup_limit_exceeded", count: 12 }], {
      spf_too_many_lookups: 1, spf_lookup_count: 12,
    });
    expect(rowGrade(prev)).not.toBe(rowGrade(curr));
    expect(isSpfUncertaintyOnlyGradeChange(prev, curr)).toBe(false);
  });
  it("an include newly ending in +all next to an unverified include still alerts", () => {
    const prev = withFindings([UNVER]);
    const curr = withFindings([UNVER, { code: "include_pass_all", names: ["other.example"] }]);
    expect(rowGrade(prev)).not.toBe(rowGrade(curr));
    expect(isSpfUncertaintyOnlyGradeChange(prev, curr)).toBe(false);
  });
  it("a non-SPF change next to an unverified include still alerts", () => {
    const prev = withFindings([UNREG]);
    const curr = withFindings([UNVER], { dmarc_policy: "none" });
    expect(isSpfUncertaintyOnlyGradeChange(prev, curr)).toBe(false);
  });
  it("certain on both sides (unregistered → registered) is never suppressed", () => {
    expect(isSpfUncertaintyOnlyGradeChange(withFindings([UNREG]), withFindings([]))).toBe(false);
  });
});

// ─── Scans without RDAP carry the previous verdict (lead report) ──────────

describe("checkSpf without an RDAP checker carries the previous dangling verdict", () => {
  const root = "v=spf1 include:gone-vendor.com -all";
  const prevSpf = (finding: object): SpfResult =>
    scanInputFromStoredRow(withFindings([finding])).spf;

  it("carries include_target_unregistered while the target is still NXDOMAIN", async () => {
    const previous = vi.fn(async () => prevSpf(UNREG));
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), previous);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(spf.findings).toContainEqual(UNREG);
    expect(hasUnregisteredInclude(spf)).toBe(true);
  });
  it("carries include_target_unverified as-is", async () => {
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), async () => prevSpf(UNVER));
    expect(spf.findings).toContainEqual(UNVER);
  });
  it("does not carry once the target resolves, or when the include is gone", async () => {
    const resolved = await checkSpf("acme.com", dns({ "acme.com": ok(root), "gone-vendor.com": ok("v=spf1 -all") }), async () => prevSpf(UNREG));
    expect(hasUnregisteredInclude(resolved)).toBe(false);
    const other = await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 include:other-gone.com -all") }), async () => prevSpf(UNREG));
    expect(hasUnregisteredInclude(other)).toBe(false);
  });
  it("no NXDOMAIN target → the loader is not read", async () => {
    const previous = vi.fn(async () => prevSpf(UNREG));
    await checkSpf("acme.com", dns({ "acme.com": ok("v=spf1 -all") }), previous);
    expect(previous).not.toHaveBeenCalled();
  });
  it("with an RDAP checker the live verdict wins (no carry)", async () => {
    const previous = vi.fn(async () => prevSpf(UNREG));
    const spf = await checkSpf("acme.com", dns({ "acme.com": ok(root) }), previous, undefined, async () => "registered");
    expect(previous).not.toHaveBeenCalled();
    expect(hasUnregisteredInclude(spf)).toBe(false);
  });
});
