import { describe, it, expect } from "vitest";
import { roleHasPermission, listRolePermissions, isStaffRole, type StaffPermission } from "../src/lib/role-permissions";
import { hasGlobalReadScope } from "../src/middleware/auth";
import { uiPreviewDbRole } from "../src/handlers/auth";

// AUTH_AUDIT_2026-06: `auditor` is a read-only global seat — sees all
// backend + tenant data, mutates nothing, never super_admin.

const READ_FLAGS: StaffPermission[] = ["read_customers", "view_billing", "view_audit"];
const WRITE_FLAGS: StaffPermission[] = ["edit_pricing", "edit_alerts", "manage_takedowns", "manage_invites"];

describe("auditor permissions are read-only", () => {
  it("grants exactly the three read/view flags", () => {
    for (const f of READ_FLAGS) expect(roleHasPermission("auditor", f)).toBe(true);
    expect(listRolePermissions("auditor").sort()).toEqual([...READ_FLAGS].sort());
  });

  it("grants no mutating permission", () => {
    for (const f of WRITE_FLAGS) expect(roleHasPermission("auditor", f)).toBe(false);
  });

  it("is staff (not a customer)", () => {
    expect(isStaffRole("auditor")).toBe(true);
  });
});

describe("auditor has global (cross-tenant) read scope", () => {
  it("is unscoped like super_admin", () => {
    expect(hasGlobalReadScope("auditor")).toBe(true);
    expect(hasGlobalReadScope("super_admin")).toBe(true);
  });

  it("does not grant global scope to ordinary staff or clients", () => {
    for (const r of ["admin", "analyst", "sales", "support", "billing", "client"] as const) {
      expect(hasGlobalReadScope(r)).toBe(false);
    }
  });
});

describe("auditor preview is stored under a CHECK-valid placeholder role", () => {
  it("maps the auditor JWT role to a persisted 'analyst' row", () => {
    expect(uiPreviewDbRole("auditor")).toBe("analyst");
  });

  it("leaves CHECK-valid roles untouched", () => {
    expect(uiPreviewDbRole("analyst")).toBe("analyst");
    expect(uiPreviewDbRole("admin")).toBe("admin");
    expect(uiPreviewDbRole("client")).toBe("client");
  });
});
