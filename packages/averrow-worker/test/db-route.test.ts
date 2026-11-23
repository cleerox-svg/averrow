/**
 * lib/db-route.ts — the telemetry cluster's core / telemetry switch (B1b).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  FAMILY_COLD_DEFAULT_ROUTE,
  FAMILY_ROUTE_KV_KEYS,
  TELEMETRY_FAMILIES,
  TELEMETRY_ROUTE_CACHE_MS,
  coldDefaultRoute,
  familyRouteState,
  familyStore,
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

/** Defaults to production: the only environment whose cold default is telemetry. */
function envWith(kv: CountingKV, bound = true, environment: string | null = "production"): Env {
  return { DB, CACHE: kv, ...(environment ? { ENVIRONMENT: environment } : {}), ...(bound ? { TELEMETRY_DB } : {}) } as unknown as Env;
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
    expect(await telemetryRouteState(envWith(kv), 0)).toEqual({ route: "core", requested: null, bound: true, source: "unset" });
  });

  it("serves the prod cold default (telemetry) on an invalid flag with no prior route", async () => {
    const kv = new CountingKV();
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "yes please");
    expect(await telemetryStore(envWith(kv), 0)).toBe(TELEMETRY_DB);
  });

  it("an invalid flag on a cold isolate still serves core when TELEMETRY_DB is unbound", async () => {
    const kv = new CountingKV();
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "yes please");
    expect(await telemetryStore(envWith(kv, false), 0)).toBe(DB);
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
    expect(await telemetryRouteState(env, 0)).toEqual({ route: "core", requested: "telemetry", bound: false, source: "kv" });
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

  it("a KV failure with no prior read (cold isolate) serves the cold default, telemetry", async () => {
    const kv = new CountingKV();
    kv.fail = true;
    expect(await telemetryStore(envWith(kv), 0)).toBe(TELEMETRY_DB);
    expect(await telemetryRouteState(envWith(kv), 0)).toEqual({ route: "telemetry", requested: "telemetry", bound: true, source: "cold_default" });
  });

  it("a KV failure on a cold isolate serves core when TELEMETRY_DB is unbound (dev)", async () => {
    const kv = new CountingKV();
    kv.fail = true;
    expect(await telemetryStore(envWith(kv, false), 0)).toBe(DB);
  });

  it("an explicit 'core' wins over the cold default and survives a later KV failure (rollback)", async () => {
    const kv = new CountingKV();
    const env = envWith(kv);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "core");
    expect(await telemetryStore(env, 0)).toBe(DB);
    kv.fail = true;
    expect(await telemetryStore(env, TELEMETRY_ROUTE_CACHE_MS)).toBe(DB);
  });

  it("an explicit 'core' followed by an invalid value keeps core", async () => {
    const kv = new CountingKV();
    const env = envWith(kv);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "core");
    expect(await telemetryStore(env, 0)).toBe(DB);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "cor");
    expect(await telemetryStore(env, TELEMETRY_ROUTE_CACHE_MS)).toBe(DB);
  });
});

describe("cold-isolate default per family (post cut-over, 2026-11-23)", () => {
  it("every family's prod cold default is telemetry", () => {
    for (const f of TELEMETRY_FAMILIES) expect(FAMILY_COLD_DEFAULT_ROUTE.prod[f]).toBe("telemetry");
  });

  for (const family of TELEMETRY_FAMILIES) {
    it(`${family}: KV failure on a cold isolate → telemetry; unset flag → core; explicit core → core`, async () => {
      const failing = new CountingKV();
      failing.fail = true;
      expect(await familyStore(envWith(failing), family, 0)).toBe(TELEMETRY_DB);

      resetTelemetryRouteCache();
      const unset = new CountingKV();
      expect(await familyStore(envWith(unset), family, 0)).toBe(DB);

      resetTelemetryRouteCache();
      const core = new CountingKV();
      core.store.set(FAMILY_ROUTE_KV_KEYS[family], "core");
      expect(await familyStore(envWith(core), family, 0)).toBe(DB);
    });
  }
});

describe("cold default is production-only (staging binds TELEMETRY_DB but was never cut over)", () => {
  it("the per-env table: prod → telemetry, staging / dev → core, unknown ENVIRONMENT → core", () => {
    for (const f of TELEMETRY_FAMILIES) {
      expect(FAMILY_COLD_DEFAULT_ROUTE.prod[f]).toBe("telemetry");
      expect(FAMILY_COLD_DEFAULT_ROUTE.staging[f]).toBe("core");
      expect(FAMILY_COLD_DEFAULT_ROUTE.dev[f]).toBe("core");
      expect(coldDefaultRoute({ ENVIRONMENT: undefined } as unknown as Env, f)).toBe("core");
      expect(coldDefaultRoute({ ENVIRONMENT: "prod" } as unknown as Env, f)).toBe("core");
    }
  });

  for (const environment of ["staging", "development", null]) {
    for (const family of TELEMETRY_FAMILIES) {
      it(`${environment ?? "no ENVIRONMENT"} / ${family}: KV failure on a cold isolate → core, no used marker`, async () => {
        const kv = new CountingKV();
        kv.fail = true;
        const env = envWith(kv, true, environment);
        expect(await familyStore(env, family, 0)).toBe(DB);
        expect(await familyRouteState(env, family, 0)).toEqual({ route: "core", requested: "core", bound: true, source: "cold_default" });
      });

      it(`${environment ?? "no ENVIRONMENT"} / ${family}: invalid flag on a cold isolate → core, never writes the used marker`, async () => {
        const kv = new CountingKV();
        kv.store.set(FAMILY_ROUTE_KV_KEYS[family], "telemtry");
        const env = envWith(kv, true, environment);
        expect(await familyStore(env, family, 0)).toBe(DB);
        expect([...kv.store.keys()].some((k) => k.startsWith("db_route:telemetry_used"))).toBe(false);
      });
    }
  }

  it("staging still follows an explicit 'telemetry' flag (only the fallback is per-env)", async () => {
    const kv = new CountingKV();
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetry");
    expect(await telemetryStore(envWith(kv, true, "staging"), 0)).toBe(TELEMETRY_DB);
  });
});

describe("route source", () => {
  it("kv → cached on a later KV failure; unset stays unset (null) on a later invalid value", async () => {
    const kv = new CountingKV();
    const env = envWith(kv);
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "telemetry");
    expect((await telemetryRouteState(env, 0)).source).toBe("kv");
    kv.fail = true;
    expect(await telemetryRouteState(env, TELEMETRY_ROUTE_CACHE_MS)).toMatchObject({ route: "telemetry", source: "cached" });

    resetTelemetryRouteCache();
    const kv2 = new CountingKV();
    const env2 = envWith(kv2);
    expect((await telemetryRouteState(env2, 0)).source).toBe("unset");
    kv2.store.set(TELEMETRY_ROUTE_KV_KEY, "bogus");
    // The last known value (unset) is kept — not the cold default.
    expect(await telemetryRouteState(env2, TELEMETRY_ROUTE_CACHE_MS)).toMatchObject({ route: "core", requested: null, source: "cached" });
  });

  it("a cold default stays labelled cold_default while KV keeps failing, and yields to the real flag", async () => {
    const kv = new CountingKV();
    const env = envWith(kv);
    kv.fail = true;
    expect((await telemetryRouteState(env, 0)).source).toBe("cold_default");
    expect((await telemetryRouteState(env, TELEMETRY_ROUTE_CACHE_MS)).source).toBe("cold_default");
    kv.fail = false;
    kv.store.set(TELEMETRY_ROUTE_KV_KEY, "core");
    expect(await telemetryRouteState(env, 2 * TELEMETRY_ROUTE_CACHE_MS)).toMatchObject({ route: "core", requested: "core", source: "kv" });
  });
});
