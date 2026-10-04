// Lead-conversion placeholder owner rows (PR-F follow-up, appsec review of #1765).
//
// Lead conversion (handlers/leadConversion.ts) seats the converting
// super_admin as a TEMPORARY org owner: an org_members row with
// provisioned_by='lead_conversion'. It is the one staff org membership the
// no-tenant-staff guards tolerate — but ONLY while its user is still staff.
// Once the user is a `client`, that row is an ordinary customer membership
// (refresh embeds it as org_id/org_role), so:
//   - the guards must count it (PLACEHOLDER_EXEMPT_SQL is false for it), and
//   - a staff → client role change deactivates it (deactivatePlaceholders…).

import { PLATFORM_STAFF_ROLES } from "../middleware/auth";

export const LEAD_CONVERSION_PROVISIONED_BY = "lead_conversion";

// Compile-time role literals only (no request input), so the IN list is safe
// to inline; it is derived from the same table as isPlatformStaff.
const STAFF_ROLE_LIST_SQL = PLATFORM_STAFF_ROLES.map((r) => `'${r}'`).join(", ");

/**
 * SQL boolean, for an `org_members` row aliased `om`: true when the row is a
 * lead-conversion placeholder whose user is CURRENTLY staff (the only exempt
 * case). Use as `AND NOT (${PLACEHOLDER_EXEMPT_SQL})`. `IS` (not `=`) keeps a
 * NULL provisioned_by from turning the whole predicate NULL.
 */
export const PLACEHOLDER_EXEMPT_SQL =
  `om.provisioned_by IS '${LEAD_CONVERSION_PROVISIONED_BY}' AND EXISTS (` +
  `SELECT 1 FROM users pu WHERE pu.id = om.user_id AND pu.role IN (${STAFF_ROLE_LIST_SQL}))`;

/** Deactivate every active placeholder row held by `userId` (all orgs). For
 *  the staff → client demotion batch in handleAdminUpdateUser. Guarded on the
 *  user being non-staff AT EXECUTION TIME, so when the batch's guarded role
 *  write matched 0 rows (concurrent change → 409) a still-staff user's
 *  placeholders are left alone. */
export function deactivateUserPlaceholdersStmt(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE org_members SET status = 'removed', deprovisioned_at = datetime('now')
     WHERE user_id = ? AND provisioned_by = ? AND status = 'active'
       AND NOT EXISTS (SELECT 1 FROM users pu WHERE pu.id = ? AND pu.role IN (${STAFF_ROLE_LIST_SQL}))`,
  ).bind(userId, LEAD_CONVERSION_PROVISIONED_BY, userId);
}

/** Deactivate every active placeholder row in `orgId` except `newOwnerUserId`'s,
 *  but ONLY when `newOwnerUserId` holds an active `owner` row in that org at
 *  execution time — so the org is never left owner-less. Meant to run in the
 *  same D1 batch after the write that seats the new owner (ownership transfer,
 *  member PATCH → owner): if that write matched 0 rows, this one is a no-op. */
export function deactivateOrgPlaceholdersStmt(db: D1Database, orgId: string, newOwnerUserId: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE org_members SET status = 'removed', deprovisioned_at = datetime('now')
     WHERE org_id = ? AND provisioned_by = ? AND status = 'active' AND user_id <> ?
       AND EXISTS (SELECT 1 FROM org_members nw
                   WHERE nw.org_id = ? AND nw.user_id = ? AND nw.role = 'owner' AND nw.status = 'active')`,
  ).bind(orgId, LEAD_CONVERSION_PROVISIONED_BY, newOwnerUserId, orgId, newOwnerUserId);
}
