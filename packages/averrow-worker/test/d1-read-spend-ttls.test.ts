// Pins for the D1 read-spend TTL changes (fixes 9, 12, 13).
//
//  9. count.threats.dns_drainable — one shared key + TTL constant; Flight
//     Control recounts it once per day (lib/dns-drainable.ts, behaviour
//     pinned in test/dns-drainable-cadence.test.ts), diagnostics reads it.
// 12. FC backlog.total_no_geo — monitoring TTL (4h); total_unlinked stays
//     on the live TTL because it drives analyst instance scaling.
// 13. system-health 14-day threat trend — cachedValue TTL 3600s.
//
// 12 and 13 sit inside large handlers whose full execution needs most of
// the schema, so the TTL argument at the call site is pinned on source
// text; the constants themselves are pinned by value.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DNS_DRAINABLE_CACHE_KEY,
  DNS_DRAINABLE_TTL_S,
  countDnsCandidatesInThreats as libCount,
} from "../src/lib/dns-drainable";
import { countDnsCandidatesInThreats as diagCount } from "../src/handlers/diagnostics";
import { THREAT_TREND_14D_TTL_S } from "../src/handlers/admin/health";

const SRC = resolve(__dirname, "..", "src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

describe("fix 9 — shared dns_drainable cache contract (daily cadence)", () => {
  it("key is unchanged and TTL exceeds the once-per-day recount cadence", () => {
    expect(DNS_DRAINABLE_CACHE_KEY).toBe("count.threats.dns_drainable");
    expect(DNS_DRAINABLE_TTL_S).toBeGreaterThan(86_400);
    expect(DNS_DRAINABLE_TTL_S).toBeLessThanOrEqual(30 * 3600);
  });

  it("FC never computes the count — it only peeks; diagnostics uses the shared constants", () => {
    const fc = read("agents/flightControl.ts");
    expect(fc).not.toMatch(/['"]count\.threats\.dns_drainable['"]/);
    expect(fc).not.toMatch(/DNS_DRAINABLE_CACHE_KEY/);
    expect(fc).not.toMatch(/resolveDnsDrift/);
    expect(fc).not.toMatch(/countDnsCandidatesInThreats/);
    expect(fc).not.toMatch(/COUNT\(DISTINCT malicious_domain\)/);
    expect(fc).toMatch(/readDnsDrainableForTick\(\{ env, queueSize \}\)/);
    const diag = read("handlers/diagnostics.ts");
    expect(diag).not.toMatch(/['"]count\.threats\.dns_drainable['"]/);
    expect(diag).toMatch(/cachedCount\(\s*env,\s*DNS_DRAINABLE_CACHE_KEY,\s*DNS_DRAINABLE_TTL_S,/);
  });

  it("Navigator is the scheduled writer: hour-gated waitUntil tail, budget-aware", () => {
    const nav = read("cron/navigator.ts");
    expect([...nav.matchAll(/countDnsCandidatesInThreats\(env\.DB\)/g)].length).toBe(1);
    expect(nav).toMatch(
      /if \(isDnsDrainableRecountHour\(scheduledTime\.getTime\(\)\)\) \{\s*_ctx\.waitUntil\(\s*runDnsDrainableRecount\(\{[\s\S]{0,160}overBudget: skipNonEssential,\s*recount: \(\) => countDnsCandidatesInThreats\(env\.DB\),/,
    );
  });

  it("diagnostics re-exports the single implementation", () => {
    expect(diagCount).toBe(libCount);
  });

  it("FC's dns drift block has no minute gate", () => {
    const fc = read("agents/flightControl.ts");
    expect(fc).not.toMatch(/getUTCMinutes\(\)/);
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
