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
 * Fix: the quiet-hours set is chosen atomically. v2's set is used only when
 * v2 start AND end are both set; otherwise v1's set is used whole.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@averrow/shared", () => ({
  NOTIFICATION_EVENT_DEDUP: {},
  NOTIFICATION_EVENTS: [],
  USER_TOGGLEABLE_EVENTS: [],
}));

import { resolveQuietHours, type QuietHoursPrefSource } from "../src/lib/notifications";
import { isInQuietHours } from "../src/lib/push";

// v1 window 22:00–07:00 America/Toronto + the auto-seeded v2 row.
const seededV2WithV1Window: QuietHoursPrefSource = {
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/Toronto",
  critical_breakthrough: 1,
  v2_quiet_hours_start: null,
  v2_quiet_hours_end: null,
  v2_quiet_hours_timezone: "UTC",
  v2_critical_bypasses_quiet: 0,
};

// 2026-10-05T09:00Z = 05:00 EDT — inside the Toronto window, outside 22–07 UTC.
const INSIDE_TORONTO_ONLY = new Date("2026-10-05T09:00:00Z");
// 2026-10-05T23:00Z = 19:00 EDT — inside 22–07 UTC, outside the Toronto window.
const INSIDE_UTC_ONLY = new Date("2026-10-05T23:00:00Z");

describe("resolveQuietHours — never mixes v1 and v2 fields", () => {
  it("uses the v1 set (incl. its timezone) when the v2 row has no window", () => {
    const quiet = resolveQuietHours(seededV2WithV1Window);
    expect(quiet).toEqual({
      start: "22:00",
      end: "07:00",
      tz: "America/Toronto",
      criticalBreakthrough: true,
    });
  });

  it("suppresses push inside the user's Toronto window even though v2 tz is UTC", () => {
    const quiet = resolveQuietHours(seededV2WithV1Window);
    expect(quiet).not.toBeNull();
    expect(isInQuietHours(quiet!, INSIDE_TORONTO_ONLY)).toBe(true);
  });

  it("does not suppress at a time inside the UTC window but outside the Toronto one", () => {
    const quiet = resolveQuietHours(seededV2WithV1Window);
    expect(quiet).not.toBeNull();
    expect(isInQuietHours(quiet!, INSIDE_UTC_ONLY)).toBe(false);
  });

  it("uses the v2 set whole when v2 start and end are both set", () => {
    const quiet = resolveQuietHours({
      ...seededV2WithV1Window,
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

  it("falls back to the v1 set when v2 has only one bound", () => {
    const quiet = resolveQuietHours({
      ...seededV2WithV1Window,
      v2_quiet_hours_start: "23:00",
      v2_quiet_hours_end: null,
    });
    expect(quiet).toEqual({
      start: "22:00",
      end: "07:00",
      tz: "America/Toronto",
      criticalBreakthrough: true,
    });
  });

  it("returns null when neither table has a complete window", () => {
    expect(resolveQuietHours({
      ...seededV2WithV1Window,
      quiet_hours_end: null,
    })).toBeNull();
    expect(resolveQuietHours({})).toBeNull();
  });
});
