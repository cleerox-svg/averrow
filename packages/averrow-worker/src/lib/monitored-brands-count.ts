/**
 * Platform-wide pagination total for the dark-web and app-store overviews
 * (handlers/darkWebMonitor.ts, handlers/appStoreMonitor.ts): the number of
 * rows their global list query `FROM brands b INNER JOIN monitored_brands mb
 * ON mb.brand_id = b.id` returns.
 *
 * Both handlers ran `SELECT COUNT(*) FROM brands b INNER JOIN
 * monitored_brands mb …` on every outer-cache miss; prod's planner drove it
 * from `brands` (~133K rows/call, 100+ calls/day, 2026-11-08). This form
 * names only `monitored_brands` in FROM, so the plan is a scan of its
 * covering PK (~1K rows) with a PK probe into `brands` per row, whatever
 * the planner's statistics say. Same number: an inner join on `brands.id`
 * (the PK) yields exactly one row per monitored_brands row whose brand
 * exists — duplicates across tenant_id included, as the list shows them.
 *
 * Shared KV counter (`count.` namespace, CLAUDE.md §8) so the two pages
 * refill it once per TTL between them. 10 minutes: the list itself is
 * live, and a brand added to monitoring should show in the total soon.
 * Org-scoped requests keep their own bounded raw count.
 */

import { cachedCount } from "./cached-count";
import type { Env } from "../types";

export const MONITORED_BRANDS_JOINED_KEY = "count.monitored_brands.joined";
export const MONITORED_BRANDS_JOINED_TTL_S = 600;
export const MONITORED_BRANDS_JOINED_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM monitored_brands mb WHERE EXISTS (SELECT 1 FROM brands b WHERE b.id = mb.brand_id)";

export function countMonitoredBrandRows(
  env: Env,
  db: { prepare(sql: string): D1PreparedStatement },
): Promise<number> {
  return cachedCount(env, MONITORED_BRANDS_JOINED_KEY, MONITORED_BRANDS_JOINED_TTL_S, async () => {
    const r = await db.prepare(MONITORED_BRANDS_JOINED_COUNT_SQL).first<{ n: number }>();
    return r?.n ?? 0;
  });
}
