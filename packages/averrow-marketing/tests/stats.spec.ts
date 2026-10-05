import { test, expect } from "@playwright/test";
import { buildStats, roundLabel, compactLabel } from "../scripts/fetch-stats.mjs";

/*
 * Pure-function tests for the build-time stats pipeline. No browser or
 * network involved: they pin the payload shape of /api/v1/public/stats and
 * the "round down, never overstate" formatting.
 */

const payload = {
  total_threats: 1_175_112,
  threats_detected: "1.1M+",
  providers_mapped: 12147,
  threat_campaigns: 6097,
  countries: 215,
  active_feeds: 46,
};

test("roundLabel floors to two significant digits", () => {
  expect(roundLabel(6097)).toBe("6,000+");
  expect(roundLabel(12147)).toBe("12,000+");
  expect(roundLabel(999)).toBe("999");
  expect(roundLabel(-1)).toBeNull();
});

test("compactLabel", () => {
  expect(compactLabel(1_175_112)).toBe("1.1M+");
  expect(compactLabel(2_000_000)).toBe("2M+");
  expect(compactLabel(210_400)).toBe("210K+");
});

test("buildStats maps the real payload", () => {
  const s = buildStats(payload, "2026-10-05T00:00:00.000Z", "src");
  expect(s).toMatchObject({
    threats_detected: "1.1M+",
    campaigns: "6,000+",
    providers_mapped: "12,000+",
    countries: "215",
    active_feeds: 46,
    source: "src",
  });
  expect(s.proof).toBeUndefined(); // proof block is optional
  expect("agents_deployed" in s).toBe(false);
});

test("buildStats never prints a threat label above the raw total", () => {
  const s = buildStats({ ...payload, threats_detected: "1.3M+" }, "t", "src");
  expect(s.threats_detected).toBe("1.1M+");
});

test("buildStats carries the optional proof block", () => {
  const s = buildStats(
    { ...payload, proof: { lookalikes_found_30d: 20450, operations_tracked: 312, monitored_brands: 1867 } },
    "t",
    "src",
  );
  expect(s.proof).toEqual({
    lookalikes_found_30d: "20,000+",
    operations_tracked: "312",
    monitored_brands: "1,800+",
  });
});

test("buildStats rejects a payload with the wrong shape", () => {
  expect(() => buildStats({ agents_deployed: "44", threats_detected: "1.3M+" }, "t", "src")).toThrow();
});
