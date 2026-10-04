import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  shouldRunProviderStats,
  PROVIDER_STATS_THROTTLE_MS,
  PROVIDER_STATS_BACKLOG_THROTTLE_MS,
  PROVIDER_STATS_LAST_RUN_KEY,
  PROVIDER_STATS_STAMP_TTL_S,
} from "../src/agents/cartographer";

// Fix #5 — Cartographer Phase 5 KV self-throttle. Phase 5 runs on every
// cartographer instance (the `9 * * * *` maintenance cron plus 1-3
// Flight-Control backlog-drain instances/hour). shouldRunProviderStats is
// the pure gate that keeps exactly one provider_threat_stats rebuild per
// hour without hard-skipping backlog instances.

describe("shouldRunProviderStats", () => {
  const NOW = 1_800_000_000_000;

  it("runs when there is no prior stamp (cold start / expired KV)", () => {
    expect(shouldRunProviderStats(null, NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(true);
  });

  it("runs when the stamp is unparseable garbage", () => {
    expect(shouldRunProviderStats("not-a-number", NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(true);
    expect(shouldRunProviderStats("", NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(true);
  });

  it("skips when the last run is inside the throttle window", () => {
    const lastRun = String(NOW - (PROVIDER_STATS_THROTTLE_MS - 60_000)); // 1 min short of the window
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(false);
  });

  it("skips a second, immediately-following backlog instance", () => {
    const lastRun = String(NOW);
    expect(shouldRunProviderStats(lastRun, NOW + 5_000, PROVIDER_STATS_THROTTLE_MS)).toBe(false);
  });

  it("runs again once the throttle window has fully elapsed", () => {
    const lastRun = String(NOW - (PROVIDER_STATS_THROTTLE_MS + 1)); // just past the window
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(true);
  });

  it("treats exactly-at-window as not-yet-elapsed (strict >)", () => {
    const lastRun = String(NOW - PROVIDER_STATS_THROTTLE_MS);
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(false);
  });

  it("uses a <hourly window so one hourly cron always re-fires", () => {
    // 50 min window < 60 min cron cadence: a stamp from the previous
    // hour's cron is always stale by the time the next hour fires.
    expect(PROVIDER_STATS_THROTTLE_MS).toBeLessThan(60 * 60_000);
    const oneHourAgo = String(NOW - 60 * 60_000);
    expect(shouldRunProviderStats(oneHourAgo, NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(true);
  });

  it("namespaces the KV key under the platform cc: cache convention", () => {
    expect(PROVIDER_STATS_LAST_RUN_KEY.startsWith("cc:")).toBe(true);
  });
});

// PR-BV — the single 50-min window did not actually produce one run per
// hour: a read-then-write KV stamp is not a lock, so the overlapping
// instances all read it stale before any of them wrote, and the
// 'all'-period rollup ran 99×/24h (41.5M rows read). The window is now
// asymmetric: the maintenance instance owns the normal cadence, backlog
// instances only take over after a genuine multi-hour maintenance gap.
describe("asymmetric backlog throttle window", () => {
  const NOW = 1_800_000_000_000;

  it("gives backlog instances a strictly wider window than maintenance", () => {
    expect(PROVIDER_STATS_BACKLOG_THROTTLE_MS).toBeGreaterThan(PROVIDER_STATS_THROTTLE_MS);
  });

  it("lets a backlog instance skip a rollup the maintenance run just did", () => {
    // The exact herd case: maintenance ran this hour, an FC backlog
    // instance arrives minutes later. Under the old shared 50-min window
    // it still ran whenever it beat the stamp; now it defers.
    const lastRun = String(NOW - 10 * 60_000);
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(false);
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_BACKLOG_THROTTLE_MS)).toBe(false);
  });

  it("still defers a backlog instance when maintenance missed a single hour", () => {
    const lastRun = String(NOW - 70 * 60_000); // maintenance stale by one hour
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_BACKLOG_THROTTLE_MS)).toBe(false);
    // ...while the maintenance instance itself would happily re-run.
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_THROTTLE_MS)).toBe(true);
  });

  it("fails over to a backlog instance once maintenance has missed two hours", () => {
    const lastRun = String(NOW - 160 * 60_000);
    expect(shouldRunProviderStats(lastRun, NOW, PROVIDER_STATS_BACKLOG_THROTTLE_MS)).toBe(true);
  });

  it("keeps the backlog window under the staleness a stats consumer would notice", () => {
    // provider_threat_stats backs operator-facing provider rollups; the
    // failover must still land well inside a working day.
    expect(PROVIDER_STATS_BACKLOG_THROTTLE_MS).toBeLessThan(6 * 60 * 60_000);
  });
});

// D1 read spend 2026-10 (~25M reads/24h): the stamp was written with
// expirationTtl 3600, shorter than the 150-min backlog window, so after an
// hour KV dropped it, every backlog instance read `null` ("never ran") and
// re-ran the rollup — the throttle only held for the first 60 minutes.
describe("last-run stamp outlives every throttle window", () => {
  it("TTL covers the widest window", () => {
    expect(PROVIDER_STATS_STAMP_TTL_S * 1000).toBeGreaterThanOrEqual(PROVIDER_STATS_BACKLOG_THROTTLE_MS);
    expect(PROVIDER_STATS_STAMP_TTL_S * 1000).toBeGreaterThanOrEqual(PROVIDER_STATS_THROTTLE_MS);
    expect(PROVIDER_STATS_STAMP_TTL_S).toBe(10800);
  });

  it("a stamp at the edge of its TTL still defers a backlog instance", () => {
    // Just before KV would expire it, the stamp is older than the backlog
    // window — i.e. the window decides, never the expiry.
    const NOW = 1_800_000_000_000;
    const justInsideWindow = String(NOW - (PROVIDER_STATS_BACKLOG_THROTTLE_MS - 60_000));
    expect(shouldRunProviderStats(justInsideWindow, NOW, PROVIDER_STATS_BACKLOG_THROTTLE_MS)).toBe(false);
  });

  it("the stamp write uses the derived TTL, not a literal", () => {
    const src = readFileSync(resolve(__dirname, "../src/agents/cartographer.ts"), "utf8");
    const put = src.match(/CACHE\.put\(PROVIDER_STATS_LAST_RUN_KEY[\s\S]*?\}\)/);
    expect(put?.[0]).toMatch(/expirationTtl: PROVIDER_STATS_STAMP_TTL_S/);
  });
});
