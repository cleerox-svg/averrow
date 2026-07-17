/**
 * Tests for handlers/platform-status.ts — handlePlatformStatus.
 *
 * Locks the Jul 2026 "/v2/" root-route outage fix: when computePlatformStatus
 * throws (D1/KV failure mid-compute), the handler used to fall through to
 * the platform's generic {success:false, error:"..."} envelope, which is
 * shape-incompatible with PlatformStatus. The frontend blind-cast that
 * envelope, so `data.overall` was `undefined` and a PALETTE[status] lookup
 * crashed the whole page.
 *
 * The fix (buildOutageFallback) makes the catch path return an HTTP 200
 * PlatformStatus-shaped body with overall:'outage' instead — same contract
 * as the happy path, just reporting the worst state. This test forces
 * computePlatformStatus to throw by making env.DB.prepare throw
 * synchronously (models a D1 outage, same technique as
 * admin-dashboard-snapshot.test.ts's rejectingStmt/makeThrowingEnv) and
 * asserts the response is 200 + PlatformStatus-shaped + overall:'outage',
 * never the {success,error} envelope.
 */

import { describe, it, expect } from "vitest";
import { handlePlatformStatus } from "../src/handlers/platform-status";
import type { Env } from "../src/types";

class MockKV {
  store = new Map<string, string>();
  putCalls = 0;
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string, _opts?: unknown): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** env whose every D1 access throws synchronously — models the D1 outage
 *  that made computePlatformStatus throw mid-compute. */
function makeThrowingEnv(kv: MockKV): Env {
  return {
    DB: {
      prepare(): never {
        throw new Error("D1 unavailable");
      },
    },
    CACHE: kv,
  } as unknown as Env;
}

function req(): Request {
  return new Request("https://averrow.com/api/v1/public/platform-status", {
    headers: { Origin: "https://averrow.com" },
  });
}

interface PlatformStatusBody {
  generated_at: string;
  overall: string;
  overall_note: string;
  categories: Array<{
    category: string;
    current: string;
    uptime_30d_pct: number;
    daily: unknown[];
    realtime: string;
    realtime_note: string;
  }>;
  window_days: number;
  cached: boolean;
}

describe("handlePlatformStatus — compute-failure fallback returns a PlatformStatus body, never {success,error}", () => {
  it("responds HTTP 200 (not 500) when computePlatformStatus throws", async () => {
    const kv = new MockKV();
    const env = makeThrowingEnv(kv);

    const res = await handlePlatformStatus(req(), env);
    expect(res.status).toBe(200);
  });

  it("the fallback body satisfies the PlatformStatus contract with overall:'outage'", async () => {
    const kv = new MockKV();
    const env = makeThrowingEnv(kv);

    const res = await handlePlatformStatus(req(), env);
    const body = (await res.json()) as PlatformStatusBody;

    // The bug: this used to be {success:false, error:"..."} — no `overall`
    // field at all, which is what crashed the frontend's blind-cast.
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("error");

    expect(body.overall).toBe("outage");
    expect(typeof body.overall_note).toBe("string");
    expect(typeof body.generated_at).toBe("string");
    expect(typeof body.window_days).toBe("number");
    expect(Array.isArray(body.categories)).toBe(true);
    expect(body.categories.length).toBeGreaterThan(0);
    // Every category the fallback reports must itself be a valid
    // CategoryRollup — a consumer keying off category.current must never
    // see undefined either.
    for (const cat of body.categories) {
      expect(cat.current).toBe("outage");
      expect(cat.realtime).toBe("outage");
      expect(typeof cat.category).toBe("string");
      expect(typeof cat.uptime_30d_pct).toBe("number");
      expect(Array.isArray(cat.daily)).toBe(true);
    }
  });

  it("does not cache the outage fallback under the success KV key with cached:true semantics — cached:false on this response", async () => {
    const kv = new MockKV();
    const env = makeThrowingEnv(kv);

    const res = await handlePlatformStatus(req(), env);
    const body = (await res.json()) as PlatformStatusBody;
    expect(body.cached).toBe(false);
  });

  it("a cold cache + healthy compute still returns the normal 200 PlatformStatus (sanity check the fallback path is only hit on failure)", async () => {
    const kv = new MockKV();
    const okStmt = {
      bind() { return this; },
      first: () => Promise.resolve({ success_pulls: 50, records: 500 }),
      all: () => Promise.resolve({ results: [] }),
    };
    const env = {
      DB: { prepare: () => okStmt },
      CACHE: kv,
    } as unknown as Env;

    const res = await handlePlatformStatus(req(), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlatformStatusBody;
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("error");
    expect(["operational", "degraded", "outage"]).toContain(body.overall);
  });
});
