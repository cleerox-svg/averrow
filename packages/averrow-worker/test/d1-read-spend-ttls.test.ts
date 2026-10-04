// Pins for the D1 read-spend TTL changes (fixes 9, 12, 13).
//
//  9. count.threats.dns_drainable — one shared key + TTL constant used by
//     Flight Control and diagnostics; TTL 5400s (> FC's hourly cadence);
//     the drift alerts re-verify with a fresh count before firing.
// 12. FC backlog.total_no_geo — monitoring TTL (4h); total_unlinked stays
//     on the live TTL because it drives analyst instance scaling.
// 13. system-health 14-day threat trend — cachedValue TTL 3600s.
//
// 12 and 13 sit inside large handlers whose full execution needs most of
// the schema, so the TTL argument at the call site is pinned on source
// text; the constants themselves are pinned by value.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DNS_DRAINABLE_CACHE_KEY,
  DNS_DRAINABLE_TTL_S,
  countDnsCandidatesInThreats as libCount,
  resolveDnsDrift,
} from "../src/lib/dns-drainable";
import { countDnsCandidatesInThreats as diagCount } from "../src/handlers/diagnostics";
import { THREAT_TREND_14D_TTL_S } from "../src/handlers/admin/health";
import { cachedCount } from "../src/lib/cached-count";
import { fakeKv } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const SRC = resolve(__dirname, "..", "src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

describe("fix 9 — shared dns_drainable cache contract", () => {
  it("key is unchanged and TTL is within 5400–7200s (exceeds the hourly FC tick)", () => {
    expect(DNS_DRAINABLE_CACHE_KEY).toBe("count.threats.dns_drainable");
    expect(DNS_DRAINABLE_TTL_S).toBeGreaterThanOrEqual(5400);
    expect(DNS_DRAINABLE_TTL_S).toBeLessThanOrEqual(7200);
  });

  it("FC and diagnostics both use the shared constants (no literal key/TTL)", () => {
    for (const f of ["agents/flightControl.ts", "handlers/diagnostics.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/['"]count\.threats\.dns_drainable['"]/);
      expect(src, f).toMatch(/cachedCount\(\s*env,\s*DNS_DRAINABLE_CACHE_KEY,\s*DNS_DRAINABLE_TTL_S,/);
    }
    expect(read("agents/flightControl.ts")).not.toMatch(/COUNT\(DISTINCT malicious_domain\)/);
  });

  it("diagnostics re-exports the single implementation", () => {
    expect(diagCount).toBe(libCount);
  });

  it("drift within threshold uses the cached value without a recount", async () => {
    const recount = vi.fn(async () => 0);
    const r = await resolveDnsDrift({ queueSize: 10_000, cachedDrainable: 10_400, threshold: 500, recount });
    expect(recount).not.toHaveBeenCalled();
    expect(r).toEqual({ drainable: 10_400, drift: 400, verified: false });
  });

  it("a stale cached value suggesting drift is re-verified fresh — no false alert", async () => {
    const recount = vi.fn(async () => 10_050);
    const r = await resolveDnsDrift({ queueSize: 10_000, cachedDrainable: 12_000, threshold: 500, recount });
    expect(recount).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ drainable: 10_050, drift: 50, verified: true });
  });

  it("real drift survives verification (alert still fires)", async () => {
    const r = await resolveDnsDrift({
      queueSize: 10_000, cachedDrainable: 12_000, threshold: 500, recount: async () => 11_900,
    });
    expect(r.drift).toBe(1_900);
    expect(r.drift).toBeGreaterThan(500);
  });

  it("FC routes its drift through resolveDnsDrift with a fresh recount + re-seed", () => {
    const src = read("agents/flightControl.ts");
    expect(src).toMatch(/resolveDnsDrift\(\{[\s\S]{0,200}recount: \(\) => countDnsCandidatesInThreats\(db\),\s*env,/);
  });

  it("a verified recount re-seeds the shared key; the next cachedCount read is a hit", async () => {
    const kv = fakeKv({
      [`cc:${DNS_DRAINABLE_CACHE_KEY}`]: JSON.stringify({ v: 12_000, t: Date.now() - 3_000_000 }),
    });
    const env = { CACHE: kv } as unknown as Env;
    const r = await resolveDnsDrift({
      queueSize: 10_000, cachedDrainable: 12_000, threshold: 500, recount: async () => 10_050, env,
    });
    expect(r.verified).toBe(true);
    const compute = vi.fn(async () => -1);
    expect(await cachedCount(env, DNS_DRAINABLE_CACHE_KEY, DNS_DRAINABLE_TTL_S, compute)).toBe(10_050);
    expect(compute).not.toHaveBeenCalled();
  });

  it("no recount → no re-seed (cached entry untouched)", async () => {
    const seeded = JSON.stringify({ v: 10_400, t: 1 });
    const kv = fakeKv({ [`cc:${DNS_DRAINABLE_CACHE_KEY}`]: seeded });
    await resolveDnsDrift({
      queueSize: 10_000, cachedDrainable: 10_400, threshold: 500, recount: async () => 0,
      env: { CACHE: kv } as unknown as Env,
    });
    expect(kv.store.get(`cc:${DNS_DRAINABLE_CACHE_KEY}`)).toBe(seeded);
  });
});

describe("fix 12 — FC no_geo backlog on the monitoring TTL", () => {
  const src = read("agents/flightControl.ts");
  it("constants", () => {
    expect(src).toMatch(/const BACKLOG_TTL_LIVE_S = 3900;/);
    expect(src).toMatch(/const BACKLOG_TTL_MONITORING_S = 14400;/);
  });
  it("total_no_geo uses BACKLOG_TTL_MONITORING_S; total_unlinked stays live", () => {
    expect(src).toMatch(/cacheCount\('backlog\.total_no_geo', BACKLOG_TTL_MONITORING_S,/);
    expect(src).toMatch(/cacheCount\('backlog\.total_unlinked', BACKLOG_TTL_LIVE_S,/);
  });
  it("no instance-count scaling reads totalNoGeo (only the >5000 geo_backlog gate)", () => {
    const uses = [...src.matchAll(/backlogs\.totalNoGeo/g)].length;
    expect(uses).toBe(3); // gate + log message + log payload
    expect(src).toMatch(/if \(backlogs\.totalNoGeo > 5000 && cartBacklog === 0\)/);
  });
});

describe("fix 13 — health 14-day trend TTL", () => {
  it("is 3600s and is what the cachedValue call uses", () => {
    expect(THREAT_TREND_14D_TTL_S).toBe(3600);
    expect(read("handlers/admin/health.ts"))
      .toMatch(/cachedValue<[^>]*>>\(env, "threats\.trend_14d", THREAT_TREND_14D_TTL_S,/);
  });
});
