import { describe, it, expect } from "vitest";
import { buildDaySeries } from "../src/lib/platform-status";

describe("buildDaySeries", () => {
  // Regression test for the partial-day false-positive: the historical
  // roll-up must end with YESTERDAY, never today. Including today's row
  // makes navigator look like it's at ~55% of its 288-runs/day target
  // until late evening UTC, flipping the "processing" category to
  // "outage" every morning while the platform is actually fine.
  it("ends with yesterday, not today, for the default 30-day window", () => {
    const now = new Date("2026-05-04T13:11:45Z");
    const series = buildDaySeries(30, now);
    expect(series).toHaveLength(30);
    expect(series[series.length - 1]).toBe("2026-05-03"); // yesterday
    expect(series[0]).toBe("2026-04-04"); // 30 days back, oldest
    expect(series).not.toContain("2026-05-04"); // today excluded
  });

  it("works for a 7-day window", () => {
    const now = new Date("2026-05-04T00:00:30Z"); // just past UTC midnight
    const series = buildDaySeries(7, now);
    expect(series).toEqual([
      "2026-04-27",
      "2026-04-28",
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ]);
  });

  it("crosses month and year boundaries", () => {
    const now = new Date("2027-01-02T05:00:00Z");
    const series = buildDaySeries(3, now);
    expect(series).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
  });
});
