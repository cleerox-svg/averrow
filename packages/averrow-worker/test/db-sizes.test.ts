/**
 * lib/db-sizes.ts — measured registry DB sizes (CF D1 REST list first,
 * PRAGMA fallback, null when unmeasurable; never a literal).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { measureDatabaseSizes, getDatabaseSizes, DB_SIZES_CACHE_KEY } from "../src/lib/db-sizes";
import { DB_REGISTRY, D1_DB_CAP_BYTES } from "../src/lib/db-registry";
import type { Env } from "../src/types";

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function pragmaDb(pageSize: number, pageCount: number, tables: number, log: string[] = []) {
  return {
    prepare(sql: string) {
      log.push(sql);
      return {
        async first<T>(): Promise<T> {
          if (sql === "PRAGMA page_size") return { page_size: pageSize } as unknown as T;
          if (sql === "PRAGMA page_count") return { page_count: pageCount } as unknown as T;
          if (sql.includes("sqlite_master")) return { n: tables } as unknown as T;
          throw new Error(`unexpected ${sql}`);
        },
      };
    },
    batch: async () => [],
  };
}

const idOf = (id: string) => DB_REGISTRY.find((s) => s.id === id)?.databaseId.prod ?? "";

function baseEnv(extra: Record<string, unknown> = {}): Env {
  return {
    ENVIRONMENT: "production",
    DB: pragmaDb(4096, 1000, 250),
    AUDIT_DB: pragmaDb(4096, 50, 3),
    CACHE: new MockKV(),
    ...extra,
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("measureDatabaseSizes", () => {
  it("uses the CF D1 list when the token can read it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: [
        { uuid: idOf("core"), name: "trust-radar-v2", file_size: 5_422_669_824, num_tables: 260 },
        { uuid: idOf("audit"), name: "trust-radar-v2-audit", file_size: 2_000_000, num_tables: 2 },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { databases: rows, cf_api_status: status } = await measureDatabaseSizes(baseEnv({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const core = rows.find((r) => r.store === "core");
    expect(core).toEqual({
      store: "core", name: "trust-radar-v2", sizeBytes: 5_422_669_824, tables: 260, source: "cf_api", capBytes: D1_DB_CAP_BYTES,
    });
    // geo / dnsq not bound here and absent from the list → null, not a literal.
    expect(rows.find((r) => r.store === "dnsq")).toMatchObject({ sizeBytes: null, tables: null, source: null });
    expect(rows.map((r) => r.store)).toEqual(DB_REGISTRY.map((s) => s.id));
    expect(status).toBe("ok");
    expect(String((fetchMock.mock.calls[0] as unknown[] | undefined)?.[0])).toContain("per_page=1000");
  });

  it("prefers CF_OPS_API_TOKEN and falls back to CF_API_TOKEN on a 403", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization") ?? "";
      seen.push(auth);
      if (auth === "Bearer ops") return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify({
        success: true,
        result: [{ uuid: idOf("core"), file_size: 123, num_tables: 9 }],
      }), { status: 200 });
    }));
    const { databases: rows, cf_api_status: status } = await measureDatabaseSizes(baseEnv({ CF_OPS_API_TOKEN: "ops", CF_API_TOKEN: "general", CF_ACCOUNT_ID: "acc" }));
    expect(seen).toEqual(["Bearer ops", "Bearer general"]);
    expect(status).toBe("ok");
    expect(rows.find((r) => r.store === "core")).toMatchObject({ sizeBytes: 123, tables: 9, source: "cf_api" });
    // Audit not in the list → per-DB PRAGMA fallback, recorded as such.
    expect(rows.find((r) => r.store === "audit")?.source).toBe("pragma");
  });

  it("uses only CF_OPS_API_TOKEN when it succeeds", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await measureDatabaseSizes(baseEnv({ CF_OPS_API_TOKEN: "ops", CF_API_TOKEN: "general", CF_ACCOUNT_ID: "acc" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to PRAGMA page_count × page_size on a 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("forbidden", { status: 403 })));
    const { databases: rows, cf_api_status: status } = await measureDatabaseSizes(baseEnv({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" }));
    expect(rows.find((r) => r.store === "core")).toMatchObject({ sizeBytes: 4096 * 1000, tables: 250, source: "pragma" });
    expect(rows.find((r) => r.store === "audit")).toMatchObject({ sizeBytes: 4096 * 50, tables: 3, source: "pragma" });
    expect(status).toBe("http_403");
  });

  it("falls back to PRAGMA without CF credentials and on a network error", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("boom"); });
    vi.stubGlobal("fetch", fetchMock);
    const { databases: noCreds, cf_api_status: noCredsStatus } = await measureDatabaseSizes(baseEnv());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(noCreds.find((r) => r.store === "core")?.source).toBe("pragma");
    expect(noCredsStatus).toBe("no_credentials");
    const { databases: netErr, cf_api_status: netErrStatus } = await measureDatabaseSizes(baseEnv({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" }));
    expect(netErr.find((r) => r.store === "core")?.source).toBe("pragma");
    expect(netErrStatus).toBe("network");
  });

  it("reports timeout and api_error statuses (text only, no body)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    expect((await measureDatabaseSizes(baseEnv({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" }))).cf_api_status).toBe("timeout");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "secret detail" }] }), { status: 200 })));
    const block = await measureDatabaseSizes(baseEnv({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "acc" }));
    expect(block.cf_api_status).toBe("api_error");
    expect(JSON.stringify(block)).not.toContain("secret detail");
    expect(JSON.stringify(block)).not.toContain("Bearer");
  });

  it("returns null (never throws) when the PRAGMAs are refused", async () => {
    const refusing = { prepare() { return { async first(): Promise<never> { throw new Error("SQLITE_AUTH"); } }; } };
    const { databases: rows, cf_api_status: status } = await measureDatabaseSizes(baseEnv({ DB: refusing }));
    expect(rows.find((r) => r.store === "core")).toMatchObject({ sizeBytes: null, tables: null, source: null });
  });
});

describe("getDatabaseSizes — KV cache", () => {
  it("caches the block and serves a warm read without D1", async () => {
    const kv = new MockKV();
    const log: string[] = [];
    const env1 = baseEnv({ CACHE: kv, DB: pragmaDb(4096, 1000, 250, log) });
    await getDatabaseSizes(env1);
    expect(kv.store.has(`cv:${DB_SIZES_CACHE_KEY}`)).toBe(true);
    const n = log.length;
    await getDatabaseSizes(env1);
    expect(log.length).toBe(n);
  });
});
