/**
 * REC 5 — weaponization-velocity signature (`lib/velocity-signatures.ts`).
 *
 * Pure, table-driven coverage of `decideWeaponizationVelocity`'s band
 * boundaries and null-guards, mirroring the house style in
 * test/alert-triage.test.ts and test/cluster-infra-movement.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  decideWeaponizationVelocity,
  WEAPONIZATION_VELOCITY_CALIBRATION,
} from "../src/lib/velocity-signatures";

// ─── Band boundaries (0h / 24h / 25h / 72h / 73h) ──────────────────────────

describe("decideWeaponizationVelocity — band boundaries", () => {
  it("0h (registered and live in the same instant) is very_fast", () => {
    const d = decideWeaponizationVelocity(
      "2026-01-01T00:00:00Z",
      "2026-01-01 00:00:00",
    );
    expect(d.weaponization_hours).toBe(0);
    expect(d.weaponization_flag).toBe("very_fast");
  });

  it("exactly 24h (VERY_FAST_MAX_HOURS) is still very_fast — inclusive upper bound", () => {
    expect(WEAPONIZATION_VELOCITY_CALIBRATION.VERY_FAST_MAX_HOURS).toBe(24);
    const d = decideWeaponizationVelocity(
      "2026-01-01T00:00:00Z",
      "2026-01-02 00:00:00",
    );
    expect(d.weaponization_hours).toBe(24);
    expect(d.weaponization_flag).toBe("very_fast");
  });

  it("25h (one past the very_fast ceiling) is fast", () => {
    const d = decideWeaponizationVelocity(
      "2026-01-01T00:00:00Z",
      "2026-01-02 01:00:00",
    );
    expect(d.weaponization_hours).toBe(25);
    expect(d.weaponization_flag).toBe("fast");
  });

  it("exactly 72h (FAST_MAX_HOURS) is still fast — inclusive upper bound", () => {
    expect(WEAPONIZATION_VELOCITY_CALIBRATION.FAST_MAX_HOURS).toBe(72);
    const d = decideWeaponizationVelocity(
      "2026-01-01T00:00:00Z",
      "2026-01-04 00:00:00",
    );
    expect(d.weaponization_hours).toBe(72);
    expect(d.weaponization_flag).toBe("fast");
  });

  it("73h (one past the fast ceiling) is normal", () => {
    const d = decideWeaponizationVelocity(
      "2026-01-01T00:00:00Z",
      "2026-01-04 01:00:00",
    );
    expect(d.weaponization_hours).toBe(73);
    expect(d.weaponization_flag).toBe("normal");
  });
});

// ─── NULL domain_created_at ───────────────────────────────────────────────

describe("decideWeaponizationVelocity — missing domain_created_at", () => {
  it("NULL domain_created_at yields both fields NULL", () => {
    const d = decideWeaponizationVelocity(null, "2026-01-01 00:00:00");
    expect(d.weaponization_hours).toBeNull();
    expect(d.weaponization_flag).toBeNull();
  });

  it("blank/whitespace domain_created_at is treated as missing", () => {
    const d = decideWeaponizationVelocity("   ", "2026-01-01 00:00:00");
    expect(d.weaponization_flag).toBeNull();
  });

  it("unparseable domain_created_at NULLs out", () => {
    const d = decideWeaponizationVelocity("not-a-date", "2026-01-01 00:00:00");
    expect(d.weaponization_flag).toBeNull();
  });
});

// ─── Negative delta (created AFTER first_seen) ────────────────────────────

describe("decideWeaponizationVelocity — negative delta", () => {
  it("domain created after first_seen NULLs out (strict, zero tolerance)", () => {
    expect(WEAPONIZATION_VELOCITY_CALIBRATION.NEGATIVE_TOLERANCE_HOURS).toBe(0);
    const d = decideWeaponizationVelocity(
      "2026-01-05T00:00:00Z",
      "2026-01-01 00:00:00",
    );
    expect(d.weaponization_hours).toBeNull();
    expect(d.weaponization_flag).toBeNull();
  });

  it("a small (1h) negative delta also NULLs — zero tolerance means ANY negative", () => {
    const d = decideWeaponizationVelocity(
      "2026-01-01T01:00:00Z",
      "2026-01-01 00:00:00",
    );
    expect(d.weaponization_flag).toBeNull();
  });
});

// ─── Pre-1985 sentinel created dates (parse artifacts, not real registrations) ──

describe("decideWeaponizationVelocity — pre-1985 sentinel dates", () => {
  it("Unix epoch (1970-01-01) created date NULLs out", () => {
    const d = decideWeaponizationVelocity(
      "1970-01-01T00:00:00Z",
      "2026-01-01 00:00:00",
    );
    expect(d.weaponization_hours).toBeNull();
    expect(d.weaponization_flag).toBeNull();
  });

  it("Windows FILETIME epoch (1601-01-01) created date NULLs out", () => {
    const d = decideWeaponizationVelocity(
      "1601-01-01T00:00:00Z",
      "2026-01-01 00:00:00",
    );
    expect(d.weaponization_hours).toBeNull();
    expect(d.weaponization_flag).toBeNull();
  });

  it("the sanity floor year is exactly 1985", () => {
    expect(WEAPONIZATION_VELOCITY_CALIBRATION.DOMAIN_SANITY_FLOOR_YEAR).toBe(1985);
  });
});

// ─── KEY case: a genuinely aged domain must NOT be NULLed ─────────────────

describe("decideWeaponizationVelocity — genuinely aged domain (guard keys on absolute date, not delta magnitude)", () => {
  it("a domain registered in 1998 and first seen live in 2026 (~247,000h) classifies normal, NOT null", () => {
    const createdMs = Date.UTC(1998, 0, 1, 0, 0, 0);
    const seenMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expectedHours = Math.round((seenMs - createdMs) / 3_600_000);

    const d = decideWeaponizationVelocity(
      "1998-01-01T00:00:00Z",
      "2026-01-01 00:00:00",
    );

    expect(d.weaponization_flag).toBe("normal");
    expect(d.weaponization_hours).toBe(expectedHours);
    // Sanity: this large delta must stay well under the overflow backstop —
    // the 1985 floor is what NULLs sentinels, not delta size.
    expect(d.weaponization_hours).toBeGreaterThan(
      WEAPONIZATION_VELOCITY_CALIBRATION.FAST_MAX_HOURS,
    );
    expect(d.weaponization_hours).toBeLessThan(
      WEAPONIZATION_VELOCITY_CALIBRATION.MAX_WEAPONIZATION_HOURS,
    );
  });

  it("overflow backstop still NULLs an absurd post-1985 delta that slips the year floor", () => {
    // 1986 -> far-future first_seen pushes the delta past MAX_WEAPONIZATION_HOURS
    // even though 1986 clears the 1985 sanity floor.
    const d = decideWeaponizationVelocity(
      "1986-01-01T00:00:00Z",
      "2200-01-01 00:00:00",
    );
    expect(d.weaponization_flag).toBeNull();
    expect(d.weaponization_hours).toBeNull();
  });
});

// ─── Timestamp format parsing (ISO-8601 Z/offset, SQLite space-separated) ──

describe("decideWeaponizationVelocity — timestamp format parsing", () => {
  it("parses ISO-8601 with a trailing Z", () => {
    const d = decideWeaponizationVelocity(
      "2026-03-01T00:00:00Z",
      "2026-03-02 00:00:00",
    );
    expect(d.weaponization_hours).toBe(24);
    expect(d.weaponization_flag).toBe("very_fast");
  });

  it("parses ISO-8601 with an explicit non-zero offset", () => {
    // 2026-03-01T05:00:00+05:00 === 2026-03-01T00:00:00Z
    const d = decideWeaponizationVelocity(
      "2026-03-01T05:00:00+05:00",
      "2026-03-02 00:00:00",
    );
    expect(d.weaponization_hours).toBe(24);
    expect(d.weaponization_flag).toBe("very_fast");
  });

  it("parses a naive SQLite space-separated datetime() string as UTC (both fields)", () => {
    const d = decideWeaponizationVelocity(
      "2026-03-01 00:00:00",
      "2026-03-02 00:00:00",
    );
    expect(d.weaponization_hours).toBe(24);
    expect(d.weaponization_flag).toBe("very_fast");
  });

  it("mixed formats (SQLite created, ISO+Z first_seen) resolve to the same delta", () => {
    const d = decideWeaponizationVelocity(
      "2026-03-01 00:00:00",
      "2026-03-02T00:00:00Z",
    );
    expect(d.weaponization_hours).toBe(24);
    expect(d.weaponization_flag).toBe("very_fast");
  });
});
