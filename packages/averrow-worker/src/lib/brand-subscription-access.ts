/**
 * Who may WATCH a brand via `notification_subscriptions` (N5).
 *
 * A brand subscription is a recipient grant: tenant-audience notifications
 * keyed by that brand fan out to every non-ignored subscriber
 * (`lib/notifications.ts` createNotification), and Observer's weekly
 * `intel_sector_trend` counts a user's subscribed brands. So subscribing
 * must be gated on the same boundary as reading the brand:
 *
 *   - Averrow staff (every role except `client` — `isStaffRole`) may watch
 *     any brand. The ops SPA's notification-preferences UI is a real staff
 *     use case and staff already see every brand.
 *   - A `client` may watch a brand only when they are an ACTIVE member of
 *     an org that owns it (`org_members` × `org_brands`). Any org the user
 *     belongs to counts — this is checked fresh against D1, not against the
 *     JWT-embedded scope, which can lag a brand claim by up to a token TTL.
 *
 * The predicate below is the single SQL definition, shared by the write
 * gate (handlers/notifications.ts), the recipient fan-out
 * (lib/notifications.ts) and Observer's sector-trend fan-out, so the three
 * cannot drift. It is a fixed SQL fragment (no caller input is interpolated)
 * that expects the aliases `u` (users) and `ns` (notification_subscriptions)
 * to be in scope.
 */

import type { UserRole } from '../types';
import { isStaffRole } from './role-permissions';

/**
 * TRUE when subscriber `u` may receive content for subscribed brand
 * `ns.brand_id`: staff always; `client` only via an active membership in an
 * org that owns the brand. Requires aliases `u` and `ns`.
 */
export const SUBSCRIBER_MAY_WATCH_BRAND_SQL = `(
              u.role != 'client'
              OR EXISTS (SELECT 1
                           FROM org_members om
                           JOIN org_brands ob ON ob.org_id = om.org_id
                          WHERE om.user_id = u.id
                            AND om.status = 'active'
                            AND ob.brand_id = ns.brand_id)
            )`;

/**
 * Write-time gate for `PUT /api/notifications/subscriptions/:brandId`.
 * Staff: always true (no D1 read). Client: one indexed lookup.
 */
export async function userMayWatchBrand(
  db: D1Database,
  userId: string,
  role: UserRole,
  brandId: string,
): Promise<boolean> {
  if (isStaffRole(role)) return true;
  const row = await db.prepare(
    `SELECT 1 AS ok
       FROM org_members om
       JOIN org_brands ob ON ob.org_id = om.org_id
      WHERE om.user_id = ?
        AND om.status = 'active'
        AND ob.brand_id = ?
      LIMIT 1`,
  ).bind(userId, brandId).first<{ ok: number }>();
  return row !== null;
}
