/**
 * Ransomware leak-site ingest — RansomLook source (CC BY 4.0).
 * Fixtures mirror the live /api/recent shape captured 2026-11-14.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseRansomLookPosts,
  hostnameOf,
  matchVictimsToBrands,
  groupKey,
  runDarkWebRansomwareIngest,
  RANSOMLOOK_RECENT_URL,
  RANSOMLOOK_ATTRIBUTION,
} from "../src/lib/dark-web-ransomware-ingest";
import type { Env } from "../src/types";

const LIVE_SHAPE = [
  {
    post_title: "sportsmansguide.com",
    discovered: "2026-11-13 18:25:57.040381",
    description: "Retail",
    link: "/post/?id=01f57612-b1e2-4f41-bc61-fd09b40aebe9",
    magnet: null,
    screen: null,
    private: false,
    misp_uuid: "8044f60c-f9c9-55a4-8939-2889763f6a14",
    group_name: "inc ransom",
  },
  {
    post_title: "Kadick",
    discovered: "2026-11-11 21:03:23.592293",
    description: "Nigerian fintech",
    link: "https://kadickintegrated.com/",
    magnet: null,
    screen: "screenshots/deadlock/kadick.png",
    private: false,
    misp_uuid: "34812c1b-4049-598f-95da-ce8629e3f454",
    group_name: "deadlock",
  },
  {
    post_title: "marquiscompanies.com",
    discovered: "2026-11-11 19:21:24",
    description: null,
    link: "http://hhevzhgcokx6xlzh4o4exuo2kryy6ectpb7trm5ut2g3u4trskptv7ad.onion/",
    magnet: null,
    screen: null,
    private: false,
    misp_uuid: "039227e6-1041-5f3e-8db0-b6f8949170f5",
    group_name: "curious worm",
  },
  {
    post_title: "Oral Roberts University",
    discovered: "2026-11-14 04:27:05.789581",
    description: "Education",
    link: "/site/blog?uuid=8717c6b6",
    magnet: null,
    screen: null,
    private: false,
    misp_uuid: "71e73d51-c669-5aa2-a1b5-eea3676d52a9",
    group_name: "qilin",
  },
];

describe("hostnameOf", () => {
  it("extracts dotted hostnames from bare domains and URLs", () => {
    expect(hostnameOf("sportsmansguide.com")).toBe("sportsmansguide.com");
    expect(hostnameOf("https://www.jnattorney.com/")).toBe("jnattorney.com");
    expect(hostnameOf("WWW.Example.CO.UK/path")).toBe("example.co.uk");
  });

  it("rejects company names and dotless words", () => {
    expect(hostnameOf("Toyota")).toBeNull();
    expect(hostnameOf("A&O Shearman")).toBeNull();
    expect(hostnameOf("Four Points Financial Solutions Inc.")).toBeNull();
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf(null)).toBeNull();
  });
});

describe("parseRansomLookPosts", () => {
  it("parses the live shape and derives victim domains from title or clearnet link", () => {
    const r = parseRansomLookPosts(LIVE_SHAPE);
    expect(r.error).toBeNull();
    expect(r.invalid).toBe(0);
    expect(r.total).toBe(4);
    expect(r.victims.map((v) => v.victim_domain)).toEqual([
      "sportsmansguide.com",
      "kadickintegrated.com", // clearnet link
      "marquiscompanies.com", // title wins; onion link ignored
      null,
    ]);
    expect(r.victims[0]!.post_url).toBe(
      "https://www.ransomlook.io/group/inc%20ransom#8044f60c-f9c9-55a4-8939-2889763f6a14",
    );
    expect(r.victims[0]!.posted_at).toBe("2026-11-13 18:25:57.040381");
    expect(r.victims.every((v) => v.source_name === "ransomlook")).toBe(true);
  });

  it("never takes a domain from an onion or file-sharing link", () => {
    const r = parseRansomLookPosts([
      { post_title: "Acme", group_name: "x", link: "https://mega.nz/file/abc" },
      { post_title: "Beta", group_name: "x", link: "https://t.me/leaks" },
      { post_title: "Gamma", group_name: "x", link: "http://abc.onion/" },
    ]);
    expect(r.victims.map((v) => v.victim_domain)).toEqual([null, null, null]);
  });

  it("tolerates unknown and missing optional fields; falls back to title for the post key", () => {
    const r = parseRansomLookPosts([{ post_title: "acme.example", group_name: "akira", extra: { a: 1 } }]);
    expect(r.invalid).toBe(0);
    expect(r.victims[0]!.description).toBeNull();
    expect(r.victims[0]!.posted_at).toBeNull();
    expect(r.victims[0]!.post_url).toBe("https://www.ransomlook.io/group/akira#acme.example");
  });

  it("counts malformed items as invalid and skips private posts", () => {
    const r = parseRansomLookPosts([
      null,
      "string",
      [1, 2],
      { post_title: "", group_name: "x" },
      { post_title: "acme.example" },
      { post_title: 42, group_name: "x" },
      { post_title: "hidden.example", group_name: "x", private: true },
    ]);
    expect(r.victims).toHaveLength(0);
    expect(r.invalid).toBe(6);
    expect(r.total).toBe(7);
  });

  it("reports a non-array body as an error", () => {
    expect(parseRansomLookPosts({ error: "rate limited" }).error).toMatch(/not a JSON array/);
    expect(parseRansomLookPosts(null).error).not.toBeNull();
  });
});

describe("matchVictimsToBrands", () => {
  it("matches domain-exact only and dedups per brand + post", () => {
    const { victims } = parseRansomLookPosts([...LIVE_SHAPE, LIVE_SHAPE[0]]);
    const matched = matchVictimsToBrands(victims, [
      { id: "b1", name: "Sportsman's Guide", canonical_domain: "www.sportsmansguide.com" },
      { id: "b2", name: "Oral Roberts University", canonical_domain: "oru.edu" },
    ]);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.brand_id).toBe("b1");
  });
});

describe("groupKey", () => {
  it("matches the SQL normalisation (lower, strip space/hyphen/underscore)", () => {
    expect(groupKey("Inc Ransom")).toBe("incransom");
    expect(groupKey("lock-bit_3")).toBe("lockbit3");
  });
});

// ─── runDarkWebRansomwareIngest ─────────────────────────────────────

interface Call { sql: string; binds: unknown[] }

function mockEnv(opts: { brands?: Array<{ id: string; name: string; canonical_domain: string | null }>; insertChanges?: number } = {}) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        binds: [] as unknown[],
        bind(...b: unknown[]) { stmt.binds = b; return stmt; },
        async all() {
          calls.push({ sql, binds: stmt.binds });
          if (/FROM brands b/.test(sql)) return { results: opts.brands ?? [] };
          return { results: [] };
        },
        async run() {
          calls.push({ sql, binds: stmt.binds });
          return { meta: { changes: opts.insertChanges ?? 1 } };
        },
        async first() { calls.push({ sql, binds: stmt.binds }); return null; },
      };
      return stmt;
    },
  };
  return { env: { DB: db } as unknown as Env, calls };
}

function stubFetch(impl: (url: string) => Promise<Response>) {
  const fn = vi.fn((input: RequestInfo | URL) => impl(String(input)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("runDarkWebRansomwareIngest", () => {
  it("fetches only RansomLook", async () => {
    const fetchFn = stubFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    const { env } = mockEnv();
    await runDarkWebRansomwareIngest(env);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe(RANSOMLOOK_RECENT_URL);
  });

  it("reports an HTTP failure as upstream_error without touching D1", async () => {
    stubFetch(async () => new Response("<html>down</html>", { status: 503 }));
    const { env, calls } = mockEnv();
    const r = await runDarkWebRansomwareIngest(env);
    expect(r.upstream_error).toMatch(/HTTP 503/);
    expect(r.skipped).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports a network error / timeout as upstream_error", async () => {
    stubFetch(async () => { throw new Error("The operation was aborted due to timeout"); });
    const r = await runDarkWebRansomwareIngest(mockEnv().env);
    expect(r.upstream_error).toMatch(/timeout/);
  });

  it("treats a non-JSON 200 body as a failed pull", async () => {
    stubFetch(async () => new Response("<html>maintenance</html>", { status: 200 }));
    const r = await runDarkWebRansomwareIngest(mockEnv().env);
    expect(r.upstream_error).toMatch(/non-JSON/);
  });

  it("treats a non-empty body that parses to zero posts as a failed pull", async () => {
    stubFetch(async () => new Response(JSON.stringify([{ title: "renamed field", group: "x" }]), { status: 200 }));
    const r = await runDarkWebRansomwareIngest(mockEnv().env);
    expect(r.upstream_error).toMatch(/0 of 1 items parsed/);
    expect(r.ransomlook_invalid).toBe(1);
  });

  it("an empty array is a quiet run, not a failure", async () => {
    stubFetch(async () => new Response("[]", { status: 200 }));
    const r = await runDarkWebRansomwareIngest(mockEnv().env);
    expect(r.upstream_error).toBeNull();
    expect(r.victims_total).toBe(0);
  });

  it("inserts a matched victim with RansomLook attribution and the legacy-overlap guard", async () => {
    stubFetch(async () => new Response(JSON.stringify(LIVE_SHAPE), { status: 200 }));
    const { env, calls } = mockEnv({
      brands: [{ id: "b1", name: "Sportsman's Guide", canonical_domain: "sportsmansguide.com" }],
      insertChanges: 0, // already present → no alert path
    });
    const r = await runDarkWebRansomwareIngest(env);
    expect(r.upstream_error).toBeNull();
    expect(r.brand_matches).toBe(1);
    expect(r.inserted).toBe(0);
    const insert = calls.find((c) => /INSERT OR IGNORE INTO dark_web_mentions/.test(c.sql))!;
    expect(insert.sql).toMatch(/WHERE NOT EXISTS/);
    expect(insert.sql).toMatch(/source_author IN \('ransomwatch', 'ransomware_live'\)/);
    expect(insert.binds[2]).toBe(
      "https://www.ransomlook.io/group/inc%20ransom#8044f60c-f9c9-55a4-8939-2889763f6a14",
    );
    expect(insert.binds[3]).toBe("inc ransom");
    expect(insert.binds[4]).toBe("ransomlook");
    expect(String(insert.binds[9])).toMatch(/RansomLook.*CC BY 4\.0/);
    expect(insert.binds[11]).toBe("incransom");
    expect(insert.binds[12]).toBe("-30 days");
    expect(RANSOMLOOK_ATTRIBUTION).toMatch(/creativecommons\.org\/licenses\/by\/4\.0/);
  });
});
