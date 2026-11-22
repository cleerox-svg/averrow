/**
 * lib/db-route.ts — the telemetry cluster's core / telemetry switch (B1b).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  TELEMETRY_ROUTE_CACHE_MS,
  TELEMETRY_ROUTE_KV_KEY,
  parseTelemetryRoute,
  resetTelemetryRouteCache,
  telemetryRouteState,
  telemetryStore,
} from "../src/lib/db-route";
import type { Env } from "../src/types";

class CountingKV {
  store = new Map<string, string>();
  gets = 0;
  fail = false;
  async get(key: string): Promise<string | null> {
    // Route-flag reads only: resolving 'telemetry' also reads the durable
    // db_route:telemetry_used marker (B1c rollback safety), once per isolate.
    if (key === TELEMETRY_ROUTE_KV_KEY) this.gets++;
    if (this.fail) throw new Error("kv down");
    return this.store.get(key) ?? null;
  }
}

const DB = { prepare: () => ({}), batch: async () => [], name: "core" };
const TELEMETRY_DB = { prepare: () => ({}), batch: async () => [], name: "telemetry" };

function envWith(kv: CountingKV, bound = true): Env {
  return { DB, CACHE: kv, ...(bound ? { TELEMETRY_DB } : {}) } as unknown as Env;
}

beforeEach(() => resetTelemetryRouteCache());

describe("parseTelemetryRoute", () => {
  it("accepts 'core' and 'telemetry', tolerating case and surrounding whitespace", () => {
    expect(parseTelemetryRoute("core")).toBe("core");
    expect(parseTelemetryRoute("telemetry")).toBe("telemetry");
    expect(parseTelemetryRoute("TELEMETRY")).toBe("telemetry");
    expect(parseTelemetryRoute(" telemetry\n")).toBe("telemetry");
    for (const v of [null, undefined, "", "1", 1, "tele"]) expect(parseTelemetryRoute(v)).toBeNull();
  });
});

describe("telemetryStore", () => {
  it("defaults to core when the flag is unset", async () => {
    const kv = new CountingKV();
    expect(await telemetryStore(envWith(kv), 0)).toBe(DB);
    expect(await telemetryRouteState(envWith(kv), 0)).toEqual({ route: "core", requested: null, bound: true });
  });

  it("defaults to core on an invalid flag with no prior route", async () => {
    const kv = new CountingKV();
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "yes please");
    expect(await telemetryStore(envWith(kv), 0)).toBe(DB);
  });

  it("keeps the last known route when the flag becomes invalid (typo after cut-over)", async () => {
    const kv = new CountingKV();
    const env = envWith(kv);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetry");
    expect(await telemetryStore(env, 0)).toBe(TELEMETRY_DB);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetr");
    expect(await telemetryStore(env, 61_000)).toBe(TELEMETRY_DB);
  });

  it("serves TELEMETRY_DB when the flag is 'telemetry' and it is bound", async () => {
    const kv = new CountingKV();
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetry");
    expect(await telemetryStore(envWith(kv), 0)).toBe(TELEMETRY_DB);
  });

  it("stays on core when the flag is 'telemetry' but TELEMETRY_DB is unbound (dev)", async () => {
    const kv = new CountingKV();
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetry");
    const env = envWith(kv, false);
    expect(await telemetryStore(env, 0)).toBe(DB);
    expect(await telemetryRouteState(env, 0)).toEqual({ route: "core", requested: "telemetry", bound: false });
  });

  it("caches the flag in-isolate for 60 s, then re-reads it", async () => {
    const kv = new CountingKV();
    const env = envWith(kv);
    expect(await telemetryStore(env, 1_000)).toBe(DB);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetry");
    expect(await telemetryStore(env, 1_000 + TELEMETRY_ROUTE_CACHE_MS - 1)).toBe(DB);
    expect(kv.gets).toBe(1);
    expect(await telemetryStore(env, 1_000 + TELEMETRY_ROUTE_CACHE_MS)).toBe(TELEMETRY_DB);
    expect(kv.gets).toBe(2);
  });

  it("a KV failure keeps the last known route instead of flipping back to core", async () => {
    const kv = new CountingKV();
    const env = envWith(kv);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetry");
    expect(await telemetryStore(env, 0)).toBe(TELEMETRY_DB);
    kv.fail = true;
    expect(await telemetryStore(env, TELEMETRY_ROUTE_CACHE_MS)).toBe(TELEMETRY_DB);
  });

  it("a KV failure with no prior read serves core", async () => {
    const kv = new CountingKV();
    kv.fail = true;
    expect(await telemetryStore(envWith(kv), 0)).toBe(DB);
  });
});
