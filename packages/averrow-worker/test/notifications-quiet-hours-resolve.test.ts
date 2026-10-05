/**
 * Quiet-hours resolution across notification_preferences (v1) and
 * notification_preferences_v2.
 *
 * Bug: delivery resolved quiet hours field-by-field (v2 ?? v1). GET
 * /api/notifications/preferences/v2 auto-seeds a v2 row with
 * quiet_hours_timezone='UTC' and NULL start/end, while the ops prefs UI
 * writes the window to v1. The mixed result — start/end from v1, timezone
 * from v2 — evaluated the user's window in UTC.
 *
 * Fix: the quiet-hours set is chosen atomically from ONE table.
 *
 * H1 (account redesign review): v2 wins whenever a v2 row EXISTS, even with
 * an empty window. Turning quiet hours off in the new UI writes a NULL v2
 * window; the old "v2 only when complete, else v1" rule resurrected the
 * legacy v1 window (migration 0281 copied v1 -> v2 without clearing v1) and
 * kept suppressing the user. v1 is consulted only when there is no v2 row.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@averrow/shared", () => ({
  NOTIFICATION_EVENT_DEDUP: {},
  NOTIFICATION_EVENTS: [],
  USER_TOGGLEABLE_EVENTS: [],
}));

import { resolveQuietHours, type QuietHoursPrefSource } from "../src/lib/notifications";
import { isInQuietHours } from "../src/lib/push";

// v1 window 22:00–07:00 America/Toronto + an existing v2 row with no window
// (auto-seeded, or the user turned quiet hours off in the new UI).
const v2RowNoWindowWithV1Window: QuietHoursPrefSource = {
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/Toronto",
  critical_breakthrough: 0,          // v1 column default (migration 0106)
  v2_push_severity_floor: "high",    // NOT NULL on a real v2 row
  v2_quiet_hours_start: null,
  v2_quiet_hours_end: null,
  v2_quiet_hours_timezone: "UTC",
  v2_critical_bypasses_quiet: 1,     // auto-seed default (PREF_V2_DEFAULTS)
};

// Same v1 window, no v2 row at all (every v2 column NULL from the LEFT JOIN).
const noV2WithV1Window: QuietHoursPrefSource = {
  ...v2RowNoWindowWithV1Window,
  v2_push_severity_floor: null,
  v2_quiet_hours_timezone: null,
  v2_critical_bypasses_quiet: null,
};

// 2026-10-05T09:00Z = 05:00 EDT — inside the Toronto window, outside 22–07 UTC.
const INSIDE_TORONTO_ONLY = new Date("2026-10-05T09:00:00Z");
// 2026-10-05T23:00Z = 19:00 EDT — inside 22–07 UTC, outside the Toronto window.
const INSIDE_UTC_ONLY = new Date("2026-10-05T23:00:00Z");

describe("resolveQuietHours — v2 row present wins, even with no window (H1)", () => {
  it("a v2 row with a cleared window + a v1 window → NOT in quiet hours", () => {
    const quiet = resolveQuietHours(v2RowNoWindowWithV1Window);
    expect(quiet).toBeNull();
  });

  it("detects the v2 row from any NOT NULL v2 column, not only the push floor", () => {
    expect(resolveQuietHours({ ...v2RowNoWindowWithV1Window, v2_push_severity_floor: null })).toBeNull();
    expect(resolveQuietHours({ ...noV2WithV1Window, v2_push_severity_floor: "off" })).toBeNull();
  });

  it("a v2 row with only one bound is no window (v1 is not consulted)", () => {
    expect(resolveQuietHours({ ...v2RowNoWindowWithV1Window, v2_quiet_hours_start: "23:00" })).toBeNull();
  });

  it("uses the v2 set whole when v2 start and end are both set", () => {
    const quiet = resolveQuietHours({
      ...v2RowNoWindowWithV1Window,
      v2_quiet_hours_start: "23:00",
      v2_quiet_hours_end: "06:00",
      v2_quiet_hours_timezone: "Europe/Paris",
      v2_critical_bypasses_quiet: 0,
    });
    expect(quiet).toEqual({
      start: "23:00",
      end: "06:00",
      tz: "Europe/Paris",
      criticalBreakthrough: false,
    });
  });
});

describe("resolveQuietHours — no v2 row: the v1 set applies whole", () => {
  it("uses the v1 set (incl. its timezone)", () => {
    expect(resolveQuietHours(noV2WithV1Window)).toEqual({
      start: "22:00",
      end: "07:00",
      tz: "America/Toronto",
      criticalBreakthrough: false,
    });
  });

  it("suppresses inside the user's Toronto window, not inside the UTC one", () => {
    const quiet = resolveQuietHours(noV2WithV1Window);
    expect(quiet).not.toBeNull();
    expect(isInQuietHours(quiet!, INSIDE_TORONTO_ONLY)).toBe(true);
    expect(isInQuietHours(quiet!, INSIDE_UTC_ONLY)).toBe(false);
  });

  it("uses the v1 critical flag when there is no v2 row (b0ce7f8 precedence)", () => {
    expect(resolveQuietHours({ ...noV2WithV1Window, critical_breakthrough: 1 })?.criticalBreakthrough).toBe(true);
    expect(resolveQuietHours({ ...noV2WithV1Window, critical_breakthrough: 0 })?.criticalBreakthrough).toBe(false);
  });

  it("returns null when the v1 window is incomplete, or nothing is set", () => {
    expect(resolveQuietHours({ ...noV2WithV1Window, quiet_hours_end: null })).toBeNull();
    expect(resolveQuietHours({})).toBeNull();
  });
});
