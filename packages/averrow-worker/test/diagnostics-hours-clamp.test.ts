/**
 * clampHoursBack — `?hours=` window clamp for the platform-diagnostics
 * endpoints (/api/admin/platform-diagnostics, /api/internal/platform-diagnostics).
 *
 * Background: the cap was raised from 48h to 168h (7d) so 24/48/168h
 * trending works from the UI, and the parse was hardened against
 * NaN/negative/zero query values (previously `Math.min(parseInt(...), 48)`
 * had no floor, so `hours=0` or `hours=-5` would produce a 0/negative-hour
 * window and `hours=abc` would propagate NaN into every windowed query).
 *
 * clampHoursBack is a pure extraction of that one-line parse from
 * handlePlatformDiagnostics (src/handlers/diagnostics.ts) — the handler
 * itself does dozens of D1 queries and isn't worth mocking just to hit this
 * parse, so the clamp math is tested directly here.
 */

import { describe, it, expect } from "vitest";
import { clampHoursBack } from "../src/handlers/diagnostics";

describe("clampHoursBack", () => {
  it("defaults to 6 when the param is missing (null)", () => {
    expect(clampHoursBack(null)).toBe(6);
  });

  it("passes through an in-range value (24)", () => {
    expect(clampHoursBack("24")).toBe(24);
  });

  it("passes through an in-range value (48)", () => {
    expect(clampHoursBack("48")).toBe(48);
  });

  it("passes through the new cap (168)", () => {
    expect(clampHoursBack("168")).toBe(168);
  });

  it("clamps a value over the cap (500) down to 168", () => {
    expect(clampHoursBack("500")).toBe(168);
  });

  it("clamps a value just over the cap (169) down to 168", () => {
    expect(clampHoursBack("169")).toBe(168);
  });

  it("floors zero up to 1", () => {
    expect(clampHoursBack("0")).toBe(1);
  });

  it("floors a negative value up to 1", () => {
    expect(clampHoursBack("-5")).toBe(1);
  });

  it("falls back to 6 on garbage input (NaN)", () => {
    expect(clampHoursBack("abc")).toBe(6);
  });

  it("falls back to 6 on an empty string", () => {
    expect(clampHoursBack("")).toBe(6);
  });

  it("accepts the exact boundary value 1", () => {
    expect(clampHoursBack("1")).toBe(1);
  });
});
