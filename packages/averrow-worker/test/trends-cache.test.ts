/**
 * Trends page-load endpoints (handlers/trends.ts) are KV-cached with
 * stale-while-revalidate. Regression: during a D1 overload window the
 * uncached endpoints 500'd and four Trends panels rendered "No data".
 * A cached entry — even one past its fresh window — must keep serving
 * while D1 is failing.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleTrendIntelligence,
  handleTrendThreatVolume,
  handleTrendBrandMomentum,
  handleTrendProviderMomentum,
  handleTrendNexusActive,
  TREND_CACHE_FRESH_S,
  TREND_CACHE_TTL_S,
} from "../src/handlers/trends";
import type { Env } from "../src/types";

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

function okDb(rows: unknown[], binds: unknown[][] = []) {
  const stmt = {
    bind: (...args: unknown[]) => { binds.push(args); return stmt; },
    all: async () => ({ results: rows }),
  };
  return { prepare: () => stmt };
}

function failingDb() {
  const stmt = {
    bind: () => stmt,
    all: () => Promise.reject(new Error("D1_ERROR: D1 DB is overloaded")),
  };
  return { prepare: () => stmt };
}

const envWith = (db: unknown, kv: MockKV) => ({ DB: db, CACHE: kv } as unknown as Env);
const waitUntil = { waitUntil: (_p: Promise<unknown>) => {} };

const ENDPOINTS = [
  { name: "intelligence", handler: handleTrendIntelligence, url: "https://x/api/trends/intelligence?limit=6" },
  { name: "threat-volume", handler: handleTrendThreatVolume, url: "https://x/api/trends/threat-volume?window=30d" },
  { name: "brand-momentum", handler: handleTrendBrandMomentum, url: "https://x/api/trends/brand-momentum" },
  { name: "provider-momentum", handler: handleTrendProviderMomentum, url: "https://x/api/trends/provider-momentum" },
  { name: "nexus-active", handler: handleTrendNexusActive, url: "https://x/api/trends/nexus-active" },
];

afterEach(() => { vi.restoreAllMocks(); });

describe("trends endpoints — KV cache", () => {
  it.each(ENDPOINTS)("$name serves a stale cached entry while D1 is failing", async ({ handler, url }) => {
    const kv = new MockKV();
    const rows = [{ id: "row-1" }];
    const first = await handler(new Request(url), envWith(okDb(rows), kv), waitUntil);
    expect(first.status).toBe(200);

    // Past the fresh window but inside the servable TTL.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + (TREND_CACHE_FRESH_S + 60) * 1000);
    expect(TREND_CACHE_FRESH_S + 60).toBeLessThan(TREND_CACHE_TTL_S);

    const second = await handler(new Request(url), envWith(failingDb(), kv), waitUntil);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ success: true, data: rows });
  });

  it.each(ENDPOINTS)("$name still 500s on a cold cache when D1 fails (so the UI shows an error, not empty)", async ({ handler, url }) => {
    const res = await handler(new Request(url), envWith(failingDb(), new MockKV()), waitUntil);
    expect(res.status).toBe(500);
  });

  it("keys intelligence by limit and threat-volume by window", async () => {
    const kv = new MockKV();
    await handleTrendIntelligence(new Request("https://x/api/trends/intelligence?limit=1"), envWith(okDb([{ id: "a" }]), kv), waitUntil);
    const six = await handleTrendIntelligence(new Request("https://x/api/trends/intelligence?limit=6"), envWith(okDb([{ id: "b" }]), kv), waitUntil);
    expect(await six.json()).toEqual({ success: true, data: [{ id: "b" }] });

    await handleTrendThreatVolume(new Request("https://x/api/trends/threat-volume?window=7d"), envWith(okDb([{ day: "7" }]), kv), waitUntil);
    const thirty = await handleTrendThreatVolume(new Request("https://x/api/trends/threat-volume?window=30d"), envWith(okDb([{ day: "30" }]), kv), waitUntil);
    expect(await thirty.json()).toEqual({ success: true, data: [{ day: "30" }] });
  });

  it("clamps bad params instead of binding NaN", async () => {
    const binds: unknown[][] = [];
    await handleTrendIntelligence(new Request("https://x/api/trends/intelligence?limit=abc"), envWith(okDb([], binds), new MockKV()), waitUntil);
    await handleTrendThreatVolume(new Request("https://x/api/trends/threat-volume?window=9999d"), envWith(okDb([], binds), new MockKV()), waitUntil);
    expect(binds).toEqual([[6], [90]]);
  });
});
