import { describe, it, expect } from "vitest";
import {
  roleHasPermission, listRolePermissions, isStaffRole,
} from "../src/lib/role-permissions";

describe("isStaffRole", () => {
  it("treats every non-client role as staff", () => {
    expect(isStaffRole("super_admin")).toBe(true);
    expect(isStaffRole("admin")).toBe(true);
    expect(isStaffRole("analyst")).toBe(true);
    expect(isStaffRole("sales")).toBe(true);
    expect(isStaffRole("support")).toBe(true);
    expect(isStaffRole("billing")).toBe(true);
    expect(isStaffRole("client")).toBe(false);
  });
});

describe("roleHasPermission", () => {
  it("super_admin and admin grant every permission", () => {
    const allPerms = [
      "read_customers", "edit_pricing", "edit_alerts", "manage_takedowns",
      "manage_invites", "view_billing", "view_audit",
    ] as const;
    for (const p of allPerms) {
      expect(roleHasPermission("super_admin", p)).toBe(true);
      expect(roleHasPermission("admin", p)).toBe(true);
    }
  });

  it("analyst handles alerts + takedowns but cannot edit pricing or billing", () => {
    expect(roleHasPermission("analyst", "edit_alerts")).toBe(true);
    expect(roleHasPermission("analyst", "manage_takedowns")).toBe(true);
    expect(roleHasPermission("analyst", "read_customers")).toBe(true);
    expect(roleHasPermission("analyst", "view_audit")).toBe(true);
    expect(roleHasPermission("analyst", "edit_pricing")).toBe(false);
    expect(roleHasPermission("analyst", "view_billing")).toBe(false);
    expect(roleHasPermission("analyst", "manage_invites")).toBe(false);
  });

  it("sales edits pricing + manages invites but cannot touch alerts", () => {
    expect(roleHasPermission("sales", "edit_pricing")).toBe(true);
    expect(roleHasPermission("sales", "manage_invites")).toBe(true);
    expect(roleHasPermission("sales", "view_billing")).toBe(true);
    expect(roleHasPermission("sales", "read_customers")).toBe(true);
    expect(roleHasPermission("sales", "edit_alerts")).toBe(false);
    expect(roleHasPermission("sales", "manage_takedowns")).toBe(false);
  });

  it("support reads + edits alerts but does NOT touch pricing or invites", () => {
    expect(roleHasPermission("support", "read_customers")).toBe(true);
    expect(roleHasPermission("support", "edit_alerts")).toBe(true);
    expect(roleHasPermission("support", "edit_pricing")).toBe(false);
    expect(roleHasPermission("support", "view_billing")).toBe(false);
    expect(roleHasPermission("support", "manage_invites")).toBe(false);
    expect(roleHasPermission("support", "manage_takedowns")).toBe(false);
  });

  it("billing is Stripe + pricing only — no customer ops", () => {
    expect(roleHasPermission("billing", "edit_pricing")).toBe(true);
    expect(roleHasPermission("billing", "view_billing")).toBe(true);
    expect(roleHasPermission("billing", "read_customers")).toBe(false);
    expect(roleHasPermission("billing", "edit_alerts")).toBe(false);
    expect(roleHasPermission("billing", "manage_takedowns")).toBe(false);
    expect(roleHasPermission("billing", "manage_invites")).toBe(false);
  });

  it("client has zero staff permissions", () => {
    expect(roleHasPermission("client", "read_customers")).toBe(false);
    expect(roleHasPermission("client", "edit_pricing")).toBe(false);
    expect(roleHasPermission("client", "edit_alerts")).toBe(false);
    expect(roleHasPermission("client", "view_audit")).toBe(false);
  });
});

describe("listRolePermissions", () => {
  it("returns the full grant set for super_admin", () => {
    const perms = listRolePermissions("super_admin");
    expect(perms.length).toBe(7);
    expect(perms).toContain("edit_pricing");
    expect(perms).toContain("manage_invites");
  });

  it("returns empty array for client", () => {
    expect(listRolePermissions("client")).toEqual([]);
  });

  it("billing returns just pricing + view_billing", () => {
    const perms = listRolePermissions("billing");
    expect(perms.sort()).toEqual(["edit_pricing", "view_billing"]);
  });
});
