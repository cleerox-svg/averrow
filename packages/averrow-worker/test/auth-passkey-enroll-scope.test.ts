import { describe, it, expect } from "vitest";
import { enrollScopeFor, isPrivilegedRole, PASSKEY_ENROLL_SCOPE } from "../src/handlers/auth";
import { signJWT, verifyJWT } from "../src/lib/jwt";
import type { UserRole } from "../src/types";

// H-3 (AUTH_AUDIT_2026-06): privileged users only get a full session when
// they authenticate with a passkey; any other method is restricted to
// passkey enrollment.

describe("isPrivilegedRole", () => {
  it("treats admin + super_admin as privileged", () => {
    expect(isPrivilegedRole("admin")).toBe(true);
    expect(isPrivilegedRole("super_admin")).toBe(true);
  });

  it("treats every other role as non-privileged", () => {
    for (const r of ["analyst", "sales", "support", "billing", "client"] as UserRole[]) {
      expect(isPrivilegedRole(r)).toBe(false);
    }
  });
});

describe("enrollScopeFor", () => {
  it("restricts privileged non-passkey logins to enrollment", () => {
    expect(enrollScopeFor("admin", "google_oauth")).toBe(PASSKEY_ENROLL_SCOPE);
    expect(enrollScopeFor("admin", "magic_link")).toBe(PASSKEY_ENROLL_SCOPE);
    expect(enrollScopeFor("super_admin", "google_oauth")).toBe(PASSKEY_ENROLL_SCOPE);
    // null auth_method (legacy session) is treated as non-passkey → restricted.
    expect(enrollScopeFor("super_admin", null)).toBe(PASSKEY_ENROLL_SCOPE);
  });

  it("grants a full session to privileged users who used a passkey", () => {
    expect(enrollScopeFor("admin", "passkey")).toBeUndefined();
    expect(enrollScopeFor("super_admin", "passkey")).toBeUndefined();
  });

  it("never restricts non-privileged roles, regardless of method", () => {
    for (const r of ["analyst", "sales", "support", "billing", "client"] as UserRole[]) {
      expect(enrollScopeFor(r, "google_oauth")).toBeUndefined();
      expect(enrollScopeFor(r, "magic_link")).toBeUndefined();
      expect(enrollScopeFor(r, null)).toBeUndefined();
    }
  });
});

describe("enroll scope survives JWT round-trip", () => {
  const SECRET = "test-secret-for-enroll-scope";

  it("preserves the passkey_enroll scope through sign + verify", async () => {
    const token = await signJWT(
      { sub: "u1", email: "a@b.co", role: "super_admin", scope: PASSKEY_ENROLL_SCOPE },
      SECRET,
      60,
    );
    const payload = await verifyJWT(token, SECRET);
    expect(payload?.scope).toBe(PASSKEY_ENROLL_SCOPE);
  });

  it("omits scope on a normal full session token", async () => {
    const token = await signJWT(
      { sub: "u2", email: "c@d.co", role: "analyst" },
      SECRET,
      60,
    );
    const payload = await verifyJWT(token, SECRET);
    expect(payload?.scope).toBeUndefined();
  });
});
