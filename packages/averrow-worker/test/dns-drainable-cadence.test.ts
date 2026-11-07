// The threats-side DNS candidate count (lib/dns-drainable.ts) is a full
// threats scan (1.5–2.7M rows). It used to run inside Flight Control on
// ~every other hourly tick (plus a second "verification" recount on
// suspected drift), and FC runs first in the `7 * * * *` orchestrator
// invocation — on D1-overloaded ticks that got the invocation killed
// before feed ingestion (2026-11-07).
//
// Pins:
//   - Navigator recount: hour-only gate; one scan per day; KV claim stops
//     overlapping ticks; an entry < 1h old skips; over-budget skips; never
//     throws; seeds the shared key diagnostics reads.
//   - Flight Control: KV peek only; freshness from the entry's write time.
//   - drift alerts act only on a fresh (< 90 min) count.
//   - stall classification stays hourly via the reconciler's own evidence.
//   - the stalled template renders both kinds and a null count.

import { describe, it, expect, vi } from "vitest";
import {
  DNS_DRAINABLE_CACHE_KEY,
  DNS_DRAINABLE_CLAIM_KEY,
  DNS_DRAINABLE_FRESH_S,
  DNS_DRAINABLE_RECOUNT_HOUR_UTC,
  DNS_DRAINABLE_TTL_S,
  classifyDnsQueueStall,
  isDnsDrainableRecountHour,
  readDnsDrainableForTick,
  runDnsDrainableRecount,
  shouldEmitDnsQueueDrift,
  type DnsDrainableTick,
} from "../src/lib/dns-drainable";
import { RECONCILER_READ_LIMIT } from "../src/lib/dns-queue-reconciler";
import { cachedCount } from "../src/lib/cached-count";
import { renderPlatformDnsQueueStalled } from "../src/lib/platform-templates";
import { fakeKv } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const KV_KEY = `cc:${DNS_DRAINABLE_CACHE_KEY}`;
const atHour = (h: number, minute = 0): number => Date.UTC(2026, 10, 7, h, minute, 0);
const RECOUNT_AT = atHour(DNS_DRAINABLE_RECOUNT_HOUR_UTC);
const OFF_HOUR = atHour((DNS_DRAINABLE_RECOUNT_HOUR_UTC + 5) % 24);

function envWith(seed: Record<string, string> = {}) {
  const kv = fakeKv(seed);
  return { kv, env: { CACHE: kv } as unknown as Env };
}
/** Entry written `ageS` seconds before real now (peek checks against Date.now()). */
const entry = (v: number, ageS: number) => JSON.stringify({ v, t: Date.now() - ageS * 1000 });

describe("isDnsDrainableRecountHour — hour-only gate", () => {
  it("true for every minute of the recount hour, false for every other hour", () => {
    for (const m of [0, 5, 7, 55, 59]) expect(isDnsDrainableRecountHour(atHour(DNS_DRAINABLE_RECOUNT_HOUR_UTC, m))).toBe(true);
    for (let h = 0; h < 24; h++) {
      if (h === DNS_DRAINABLE_RECOUNT_HOUR_UTC) continue;
      expect(isDnsDrainableRecountHour(atHour(h))).toBe(false);
    }
  });
});

describe("runDnsDrainableRecount (Navigator)", () => {
  it("off the recount hour: never scans, even with a cold key", async () => {
    const { env, kv } = envWith();
    const recount = vi.fn(async () => 1);
    expect(await runDnsDrainableRecount({ env, nowMs: OFF_HOUR, recount })).toEqual({ ran: false, reason: "not_recount_hour" });
    expect(recount).not.toHaveBeenCalled();
    expect(kv.store.size).toBe(0);
  });

  it("recount hour, day-old entry: scans once, seeds the shared key, takes the claim", async () => {
    const { env, kv } = envWith({ [KV_KEY]: entry(12_000, 23 * 3600) });
    const recount = vi.fn(async () => 10_050);
    const r = await runDnsDrainableRecount({ env, nowMs: RECOUNT_AT, recount });
    expect(r).toMatchObject({ ran: true, drainable: 10_050 });
    expect(recount).toHaveBeenCalledTimes(1);
    expect(kv.store.has(DNS_DRAINABLE_CLAIM_KEY)).toBe(true);
    // diagnostics' read of the shared key is now a hit — no second scan.
    const compute = vi.fn(async () => -1);
    expect(await cachedCount(env, DNS_DRAINABLE_CACHE_KEY, DNS_DRAINABLE_TTL_S, compute)).toBe(10_050);
    expect(compute).not.toHaveBeenCalled();
  });

  it("an entry < 1h old skips (later ticks in the hour, or diagnostics computed it)", async () => {
    const { env } = envWith({ [KV_KEY]: entry(10_000, 30 * 60) });
    const recount = vi.fn(async () => 1);
    expect(await runDnsDrainableRecount({ env, nowMs: RECOUNT_AT, recount })).toEqual({ ran: false, reason: "fresh" });
    expect(recount).not.toHaveBeenCalled();
  });

  it("a held claim (scan in flight on an overlapping tick) skips", async () => {
    const { env } = envWith({ [DNS_DRAINABLE_CLAIM_KEY]: "2026-11-07T03:00:00.000Z" });
    const recount = vi.fn(async () => 1);
    expect(await runDnsDrainableRecount({ env, nowMs: atHour(DNS_DRAINABLE_RECOUNT_HOUR_UTC, 5), recount }))
      .toEqual({ ran: false, reason: "claimed" });
    expect(recount).not.toHaveBeenCalled();
  });

  it("overlapping ticks: the second sees the first's claim while its scan is still running", async () => {
    const { env } = envWith();
    let release: (n: number) => void = () => undefined;
    const slow = vi.fn(() => new Promise<number>((res) => { release = res; }));
    const first = runDnsDrainableRecount({ env, nowMs: RECOUNT_AT, recount: slow });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const second = await runDnsDrainableRecount({ env, nowMs: atHour(DNS_DRAINABLE_RECOUNT_HOUR_UTC, 5), recount: slow });
    expect(second).toEqual({ ran: false, reason: "claimed" });
    release(9_000);
    expect(await first).toMatchObject({ ran: true, drainable: 9_000 });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it("over the D1 budget soft-cap: skips without touching KV", async () => {
    const { env, kv } = envWith();
    const recount = vi.fn(async () => 1);
    expect(await runDnsDrainableRecount({ env, nowMs: RECOUNT_AT, recount, overBudget: true }))
      .toEqual({ ran: false, reason: "over_budget" });
    expect(recount).not.toHaveBeenCalled();
    expect(kv.store.size).toBe(0);
  });

  it("a scan failure never throws, seeds nothing, and keeps the claim (no retry storm)", async () => {
    const { env, kv } = envWith();
    const r = await runDnsDrainableRecount({
      env, nowMs: RECOUNT_AT, recount: async () => { throw new Error("DB is overloaded"); },
    });
    expect(r).toEqual({ ran: false, reason: "error", error: "DB is overloaded" });
    expect(kv.store.has(KV_KEY)).toBe(false);
    expect(kv.store.has(DNS_DRAINABLE_CLAIM_KEY)).toBe(true);
  });

  it("across every 5-min Navigator tick of a day, the scan runs once", async () => {
    const { env } = envWith();
    const recount = vi.fn(async () => 10_000);
    for (let h = 0; h < 24; h++) {
      for (let m = 0; m < 60; m += 5) await runDnsDrainableRecount({ env, nowMs: atHour(h, m), recount });
    }
    expect(recount).toHaveBeenCalledTimes(1);
  });
});

describe("readDnsDrainableForTick (Flight Control — peek only)", () => {
  it("cold key: nulls, not fresh", async () => {
    const { env } = envWith();
    expect(await readDnsDrainableForTick({ env, queueSize: 10_000 }))
      .toEqual({ drainable: null, drift: null, computedAt: null, fresh: false });
  });

  it("entry computed 10 min ago: fresh, with drift and computedAt", async () => {
    const { env } = envWith({ [KV_KEY]: entry(10_050, 600) });
    const t = await readDnsDrainableForTick({ env, queueSize: 10_000 });
    expect(t).toMatchObject({ drainable: 10_050, drift: 50, fresh: true });
    expect(typeof t.computedAt).toBe("string");
  });

  it("entry older than the freshness window: value returned, not fresh", async () => {
    const { env } = envWith({ [KV_KEY]: entry(12_000, DNS_DRAINABLE_FRESH_S + 60) });
    expect(await readDnsDrainableForTick({ env, queueSize: 10_000 }))
      .toMatchObject({ drainable: 12_000, drift: 2_000, fresh: false });
  });

  it("entry past the TTL: treated as absent", async () => {
    const { env } = envWith({ [KV_KEY]: entry(12_000, DNS_DRAINABLE_TTL_S + 60) });
    expect((await readDnsDrainableForTick({ env, queueSize: 10_000 })).drainable).toBeNull();
  });

  it("FC's 03:07 and 04:07 ticks both see a fresh count after a 03:00 recount; 05:07 does not", () => {
    const recountAt = atHour(DNS_DRAINABLE_RECOUNT_HOUR_UTC, 0);
    const ageMin = (h: number) => (atHour(h, 7) - recountAt) / 60_000;
    expect(ageMin(DNS_DRAINABLE_RECOUNT_HOUR_UTC) * 60).toBeLessThanOrEqual(DNS_DRAINABLE_FRESH_S);
    expect(ageMin(DNS_DRAINABLE_RECOUNT_HOUR_UTC + 1) * 60).toBeLessThanOrEqual(DNS_DRAINABLE_FRESH_S);
    expect(ageMin(DNS_DRAINABLE_RECOUNT_HOUR_UTC + 2) * 60).toBeGreaterThan(DNS_DRAINABLE_FRESH_S);
  });
});

const tick = (drainable: number | null, fresh: boolean, queue = 10_000): DnsDrainableTick => ({
  drainable,
  drift: drainable === null ? null : Math.abs(queue - drainable),
  computedAt: drainable === null ? null : "2026-11-07T03:00:00.000Z",
  fresh,
});

describe("shouldEmitDnsQueueDrift — fresh counts only", () => {
  it("fires on fresh drift over threshold", () => {
    expect(shouldEmitDnsQueueDrift(tick(11_900, true), 500)).toBe(true);
  });
  it("does not fire on fresh drift within threshold", () => {
    expect(shouldEmitDnsQueueDrift(tick(10_400, true), 500)).toBe(false);
  });
  it("never fires on a stale cached value (no false alert from staleness)", () => {
    expect(shouldEmitDnsQueueDrift(tick(20_000, false), 500)).toBe(false);
  });
  it("never fires without a count", () => {
    expect(shouldEmitDnsQueueDrift(tick(null, false), 500)).toBe(false);
  });
});

describe("classifyDnsQueueStall — hourly, no threats scan", () => {
  const base = { queueSize: 10_000, driftThreshold: 500, stallThresholdMin: 30 };
  const full = RECONCILER_READ_LIMIT;

  it("cursor_stuck fires regardless of lag or count", () => {
    expect(classifyDnsQueueStall({ ...base, tick: tick(null, false), reconciler: { cursor_stuck: true } })).toBe("cursor_stuck");
  });
  it("skipped reconciler never fires", () => {
    expect(classifyDnsQueueStall({ ...base, tick: tick(11_000, true), reconciler: { skipped: true, cursor_stuck: true } })).toBeNull();
  });
  it("lag + full page that enqueued new work → falling_behind, without any count", () => {
    expect(classifyDnsQueueStall({
      ...base, tick: tick(null, false), reconciler: { cursor_lag_minutes: 45, scanned: full, enqueued: 37 },
    })).toBe("falling_behind");
  });
  it("lag + full page of reposts of already-queued domains (enqueued 0) does not fire", () => {
    expect(classifyDnsQueueStall({
      ...base, tick: tick(null, false), reconciler: { cursor_lag_minutes: 45, scanned: full, enqueued: 0 },
    })).toBeNull();
  });
  it("lag with a partial page (quiet / just caught up) does not fire, even with a stale high count", () => {
    expect(classifyDnsQueueStall({
      ...base, tick: tick(50_000, false), reconciler: { cursor_lag_minutes: 240, scanned: 12, enqueued: 12 },
    })).toBeNull();
  });
  it("lag + fresh count over the queue → falling_behind", () => {
    expect(classifyDnsQueueStall({
      ...base, tick: tick(11_000, true), reconciler: { cursor_lag_minutes: 45, scanned: 0, enqueued: 0 },
    })).toBe("falling_behind");
  });
  it("full page within the lag threshold does not fire", () => {
    expect(classifyDnsQueueStall({
      ...base, tick: tick(11_000, true), reconciler: { cursor_lag_minutes: 10, scanned: full, enqueued: 50 },
    })).toBeNull();
  });
});

describe("renderPlatformDnsQueueStalled", () => {
  const vars = { minutes_idle: 45, threshold_minutes: 30, queue_size: 10_000 };
  it("falling_behind with a null count: says behind, not idle; renders n/a", () => {
    const r = renderPlatformDnsQueueStalled({ ...vars, kind: "falling_behind", drainable_in_threats: null });
    expect(r.title).toContain("falling behind");
    expect(r.title).not.toMatch(/idle/);
    expect(r.message).not.toMatch(/hasn't enqueued or dequeued/);
    expect(r.message).toContain("drainable_in_threats=n/a (counted daily)");
    expect(r.message).not.toContain("null");
  });
  it("cursor_stuck: names the stuck cursor", () => {
    const r = renderPlatformDnsQueueStalled({ ...vars, kind: "cursor_stuck", drainable_in_threats: 9_000 });
    expect(r.title).toContain("cursor stuck");
    expect(r.message).toContain("drainable_in_threats=9000");
  });
  it("group_key / severity unchanged", () => {
    const r = renderPlatformDnsQueueStalled({ ...vars, drainable_in_threats: null });
    expect(r.group_key).toMatch(/^platform_dns_queue_stalled:/);
    expect(r.severity).toBe("high");
  });
});
