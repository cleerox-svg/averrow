/**
 * Tests for handlers/search.ts — handleUnifiedSearch (GET /api/search).
 *
 * This repo has no live-D1 test harness, so D1 is faked the same way
 * other handler tests in this suite do it (see dns-backfill.test.ts,
 * provider-trends.test.ts): a hand-rolled object satisfying the
 * `.prepare(sql).bind(...).all()` shape, routed through a fake
 * `env.DB.withSession()` since search.ts reads via getReadSession().
 * KV (env.CACHE) is faked the same way cached-value.test.ts does it.
 *
 * Focus, per the platform's own stated risk list for this endpoint:
 *   - the `q.trim().length < 2` short-circuit never touches the DB
 *   - prefix binding is always anchored (`q%`, never a leading `%`)
 *     and bind arity matches placeholder count per statement
 *   - the per-group limit clamp (Math.min(5, Math.max(1, ...)))
 *   - row -> SearchResult mapping, including null-vs-falsy-zero
 *     sublabel handling (asn=0, threat_count=0)
 *   - cache-key normalization (trim + lowercase, perGroup-scoped)
 *   - one table's query failing doesn't take down the others
 *   - unexpected top-level failure still returns the 500 envelope
 */

import { describe, it, expect } from "vitest";
import { handleUnifiedSearch } from "../src/handlers/search";
import type { Env } from "../src/types";

// ─── Fakes ─────────────────────────────────────────────────────────

interface Captured {
  sql: string;
  binds: unknown[];
}

interface TableRows {
  brands?: Array<Record<string, unknown>>;
  threat_actors?: Array<Record<string, unknown>>;
  hosting_providers?: Array<Record<string, unknown>>;
  campaigns?: Array<Record<string, unknown>>;
  app_store_listings?: Array<Record<string, unknown>>;
}

function tableFor(sql: string): keyof TableRows {
  if (/FROM brands/.test(sql)) return "brands";
  if (/FROM threat_actors/.test(sql)) return "threat_actors";
  if (/FROM hosting_providers/.test(sql)) return "hosting_providers";
  if (/FROM campaigns/.test(sql)) return "campaigns";
  if (/FROM app_store_listings/.test(sql)) return "app_store_listings";
  throw new Error(`unexpected SQL (no known table): ${sql}`);
}

function makeSession(rows: TableRows, throwFor: Set<keyof TableRows> = new Set(), calls: Captured[] = []) {
  return {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return {
            async all() {
              calls.push({ sql, binds });
              const table = tableFor(sql);
              if (throwFor.has(table)) throw new Error(`simulated D1 failure: ${table}`);
              return { results: rows[table] ?? [] };
            },
          };
        },
      };
    },
  };
}

function makeEnv(opts: {
  rows?: TableRows;
  throwFor?: Set<keyof TableRows>;
  withSessionThrows?: boolean;
  calls?: Captured[];
  kv?: Map<string, string>;
} = {}): Env {
  const calls = opts.calls ?? [];
  const kv = opts.kv ?? new Map<string, string>();
  const session = makeSession(opts.rows ?? {}, opts.throwFor, calls);
  return {
    DB: {
      withSession: () => {
        if (opts.withSessionThrows) throw new Error("simulated platform failure");
        return session;
      },
    },
    CACHE: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => {
        kv.set(k, v);
      },
    },
  } as unknown as Env;
}

function req(qs: string): Request {
  return new Request(`https://averrow.com/api/search${qs}`);
}

async function bodyOf(res: Response) {
  return res.json() as Promise<{ success: boolean; data?: unknown; error?: string }>;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handleUnifiedSearch — short-circuit on q.length < 2", () => {
  const EMPTY = { brands: [], threat_actors: [], providers: [], campaigns: [], app_store: [] };

  it("never touches the DB for a missing q param", async () => {
    // withSession throws if called at all — proves the short-circuit
    // returns before any DB access is attempted.
    const env = makeEnv({ withSessionThrows: true });
    const res = await handleUnifiedSearch(req(""), env);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ success: true, data: EMPTY });
  });

  it("never touches the DB for a single-character q", async () => {
    const env = makeEnv({ withSessionThrows: true });
    const res = await handleUnifiedSearch(req("?q=a"), env);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ success: true, data: EMPTY });
  });

  it("trims before measuring length — whitespace-only q short-circuits too", async () => {
    const env = makeEnv({ withSessionThrows: true });
    const res = await handleUnifiedSearch(req("?q=%20%20"), env); // "  "
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ success: true, data: EMPTY });
  });

  it("a 2-character q is enough to clear the gate and reach the DB", async () => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    expect(res.status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("handleUnifiedSearch — prefix binding and bind arity", () => {
  it("binds an anchored prefix (q + '%'), never a leading wildcard, on every statement", async () => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    await handleUnifiedSearch(req("?q=ac"), env);

    expect(calls.length).toBe(5); // brands, threat_actors, hosting_providers, campaigns, app_store_listings
    for (const { binds } of calls) {
      const prefixBinds = binds.filter((b) => typeof b === "string");
      expect(prefixBinds.length).toBeGreaterThan(0);
      for (const b of prefixBinds) {
        expect(b).toBe("ac%");
        expect(String(b).startsWith("%")).toBe(false);
      }
    }
  });

  it("each statement's bind count matches its own placeholder ('?') count", async () => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    await handleUnifiedSearch(req("?q=ac"), env);

    expect(calls.length).toBe(5);
    for (const { sql, binds } of calls) {
      const placeholderCount = (sql.match(/\?/g) ?? []).length;
      expect(binds.length, `bind arity mismatch for: ${sql}`).toBe(placeholderCount);
    }
  });

  it("the brands statement binds the prefix twice (name OR canonical_domain) plus the limit", async () => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    await handleUnifiedSearch(req("?q=ac"), env);
    const brandsCall = calls.find((c) => /FROM brands/.test(c.sql))!;
    expect(brandsCall.binds).toEqual(["ac%", "ac%", 5]);
  });

  it("the app_store statement binds a single anchored prefix (app_name only) plus the limit", async () => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    await handleUnifiedSearch(req("?q=ac"), env);
    const appStoreCall = calls.find((c) => /FROM app_store_listings/.test(c.sql))!;
    expect(appStoreCall.binds).toEqual(["ac%", 5]);
  });
});

describe("handleUnifiedSearch — per-group limit clamp", () => {
  const cases: Array<{ label: string; qs: string; expected: number }> = [
    { label: "no limit param defaults to 8, clamped to the 5-row cap", qs: "?q=ac", expected: 5 },
    { label: "limit=3 passes through unclamped", qs: "?q=ac&limit=3", expected: 3 },
    { label: "limit=100 clamps down to the frozen 5-row cap", qs: "?q=ac&limit=100", expected: 5 },
    { label: "limit=0 clamps up to the floor of 1", qs: "?q=ac&limit=0", expected: 1 },
    { label: "limit=-7 clamps up to the floor of 1", qs: "?q=ac&limit=-7", expected: 1 },
    { label: "limit=abc is NaN, falls back to the default 8, clamped to 5", qs: "?q=ac&limit=abc", expected: 5 },
  ];

  it.each(cases)("$label", async ({ qs, expected }) => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    await handleUnifiedSearch(req(qs), env);
    const campaignsCall = calls.find((c) => /FROM campaigns/.test(c.sql))!;
    expect(campaignsCall.binds.at(-1)).toBe(expected);
  });

  it("a smaller explicit limit produces a distinct, smaller-scoped cache key (can't poison the default slice)", async () => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    await handleUnifiedSearch(req("?q=ac&limit=2"), env);
    await handleUnifiedSearch(req("?q=ac"), env); // default -> perGroup 5, different key
    // Each distinct cache key computes fresh: 5 statements x 2 requests.
    expect(calls.length).toBe(10);
  });
});

describe("handleUnifiedSearch — row -> SearchResult mapping", () => {
  it("brand sublabel prefers canonical_domain over the threat_count fallback", async () => {
    const env = makeEnv({
      rows: { brands: [{ id: "b1", name: "Acme", canonical_domain: "acme.com", threat_count: 12 }] },
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    const body = (await bodyOf(res)) as { data: { brands: Array<Record<string, unknown>> } };
    expect(body.data.brands).toEqual([{ type: "brand", id: "b1", label: "Acme", sublabel: "acme.com" }]);
  });

  it("brand sublabel falls back to '<n> threats' when canonical_domain is null, including n=0", async () => {
    const env = makeEnv({
      rows: { brands: [{ id: "b1", name: "Acme", canonical_domain: null, threat_count: 0 }] },
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    const body = (await bodyOf(res)) as { data: { brands: Array<Record<string, unknown>> } };
    // threat_count=0 is falsy but not null — must still render "0 threats",
    // not fall through to null (a `r.threat_count ? ... : null` bug would
    // silently drop this sublabel for zero-threat brands).
    expect(body.data.brands[0].sublabel).toBe("0 threats");
  });

  it("brand sublabel is null when both canonical_domain and threat_count are null", async () => {
    const env = makeEnv({
      rows: { brands: [{ id: "b1", name: "Acme", canonical_domain: null, threat_count: null }] },
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    const body = (await bodyOf(res)) as { data: { brands: Array<Record<string, unknown>> } };
    expect(body.data.brands[0].sublabel).toBeNull();
  });

  it("provider sublabel renders AS0 for asn=0, not null (falsy-but-not-null guard)", async () => {
    const env = makeEnv({
      rows: { hosting_providers: [{ id: "p1", name: "CloudCo", asn: 0 }] },
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    const body = (await bodyOf(res)) as { data: { providers: Array<Record<string, unknown>> } };
    expect(body.data.providers).toEqual([{ type: "provider", id: "p1", label: "CloudCo", sublabel: "AS0" }]);
  });

  it("provider sublabel is null when asn is null", async () => {
    const env = makeEnv({
      rows: { hosting_providers: [{ id: "p1", name: "CloudCo", asn: null }] },
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    const body = (await bodyOf(res)) as { data: { providers: Array<Record<string, unknown>> } };
    expect(body.data.providers[0].sublabel).toBeNull();
  });

  it("threat_actor and campaign map country_code / status straight through as sublabel", async () => {
    const env = makeEnv({
      rows: {
        threat_actors: [{ id: "t1", name: "APT-Acme", country_code: "CN" }],
        campaigns: [{ id: "c1", name: "Op Acme", status: "active" }],
      },
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    const body = (await bodyOf(res)) as {
      data: { threat_actors: Array<Record<string, unknown>>; campaigns: Array<Record<string, unknown>> };
    };
    expect(body.data.threat_actors).toEqual([{ type: "threat_actor", id: "t1", label: "APT-Acme", sublabel: "CN" }]);
    expect(body.data.campaigns).toEqual([{ type: "campaign", id: "c1", label: "Op Acme", sublabel: "active" }]);
  });

  it("app_store id is the OWNING BRAND id (not the listing PK) — pins the /brands/:id?tab=apps deep-link contract", async () => {
    const env = makeEnv({
      rows: {
        // Note: no listing-id column is even selected by the handler — the
        // fake row only carries the columns the SQL actually projects
        // (brand_id, app_name, developer_name, store). If a future refactor
        // swapped `id` back to a listing PK, this assertion would catch it
        // because there is no listing id anywhere in this row to fall back to.
        app_store_listings: [
          { brand_id: "b42", app_name: "Acme Wallet", developer_name: "Acme Inc.", store: "ios" },
        ],
      },
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    const body = (await bodyOf(res)) as { data: { app_store: Array<Record<string, unknown>> } };
    expect(body.data.app_store).toEqual([
      { type: "app_store", id: "b42", label: "Acme Wallet", sublabel: "Acme Inc." },
    ]);
  });

  it("app_store sublabel falls back to store when developer_name is null, then to null when both are null", async () => {
    const envStoreFallback = makeEnv({
      rows: {
        app_store_listings: [
          { brand_id: "b42", app_name: "Acme Wallet", developer_name: null, store: "android" },
        ],
      },
    });
    const res1 = await handleUnifiedSearch(req("?q=ac"), envStoreFallback);
    const body1 = (await bodyOf(res1)) as { data: { app_store: Array<Record<string, unknown>> } };
    expect(body1.data.app_store[0].sublabel).toBe("android");

    const envNullBoth = makeEnv({
      rows: {
        app_store_listings: [
          { brand_id: "b42", app_name: "Acme Wallet", developer_name: null, store: null },
        ],
      },
    });
    const res2 = await handleUnifiedSearch(req("?q=ac"), envNullBoth);
    const body2 = (await bodyOf(res2)) as { data: { app_store: Array<Record<string, unknown>> } };
    expect(body2.data.app_store[0].sublabel).toBeNull();
  });
});

describe("handleUnifiedSearch — cache-key normalization", () => {
  it("is case-insensitive: a different-case repeat of the same term hits the cache and skips the DB", async () => {
    const calls: Captured[] = [];
    const kv = new Map<string, string>();
    const env = makeEnv({
      calls,
      kv,
      rows: { brands: [{ id: "b1", name: "AC Corp", canonical_domain: null, threat_count: 1 }] },
    });

    await handleUnifiedSearch(req("?q=AC"), env);
    expect(calls.length).toBe(5);

    calls.length = 0;
    const res2 = await handleUnifiedSearch(req("?q=ac"), env); // same term, different case
    expect(calls.length).toBe(0); // served entirely from cache — no DB round-trip
    const body2 = (await bodyOf(res2)) as { data: { brands: Array<Record<string, unknown>> } };
    expect(body2.data.brands).toEqual([{ type: "brand", id: "b1", label: "AC Corp", sublabel: "1 threats" }]);
  });

  it("different query terms never collide on the same cache key", async () => {
    const calls: Captured[] = [];
    const env = makeEnv({ calls });
    await handleUnifiedSearch(req("?q=ac"), env);
    await handleUnifiedSearch(req("?q=xy"), env);
    expect(calls.length).toBe(10); // both terms hit the DB independently
  });
});

describe("handleUnifiedSearch — partial failure and graceful degradation", () => {
  it("one table's query failing returns that group empty without failing the whole request", async () => {
    const env = makeEnv({
      rows: {
        brands: [{ id: "b1", name: "Acme", canonical_domain: "acme.com", threat_count: 3 }],
        threat_actors: [{ id: "t1", name: "APT-Acme", country_code: "CN" }],
      },
      throwFor: new Set(["hosting_providers"]),
    });
    const res = await handleUnifiedSearch(req("?q=ac"), env);
    expect(res.status).toBe(200);
    const body = (await bodyOf(res)) as {
      success: boolean;
      data: {
        brands: unknown[];
        threat_actors: unknown[];
        providers: unknown[];
        campaigns: unknown[];
      };
    };
    expect(body.success).toBe(true);
    expect(body.data.brands.length).toBe(1);
    expect(body.data.threat_actors.length).toBe(1);
    expect(body.data.providers).toEqual([]); // failed group degrades to empty, not an error
  });
});

describe("handleUnifiedSearch — unexpected top-level failure", () => {
  it("returns the standard 500 error envelope when the DB session can't be constructed", async () => {
    const env = makeEnv({ withSessionThrows: true });
    const res = await handleUnifiedSearch(req("?q=ac"), env); // clears the length>=2 gate
    expect(res.status).toBe(500);
    expect(await bodyOf(res)).toEqual({ success: false, error: "An internal error occurred" });
  });
});
