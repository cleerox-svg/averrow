// Averrow — org-scope segment for KV cache keys.
//
// Every org-scoped KV / cachedValue / cachedCount key MUST derive its scope
// segment from this helper. The previous convention —
// `scope.brand_ids.slice(0, 3).join(",")` — keyed on only the first three
// brand IDs while the query bound ALL of them. `org_brands` lookups carry no
// ORDER BY and a brand may belong to several orgs (UNIQUE(org_id, brand_id)
// only), so two orgs whose first three brand IDs coincided read each other's
// cached data for the full TTL (cross-tenant leak).
//
// The segment now encodes the org_id AND a digest of the FULL, order-
// independent brand set, so:
//   - two orgs never share a key (org_id is in it), and
//   - the same org with a changed brand set gets a fresh key immediately
//     instead of serving a stale brand set until TTL expiry.
//
// The null/undefined scope (global-read roles: super_admin, auditor —
// `getOrgScope` returns null) stays the literal "global" so the Navigator
// pre-warms in cron/navigator.ts, which run unscoped, keep hitting the
// exact keys live global requests read.

import { hashToken } from "./hash";
import type { OrgScope } from "../middleware/auth";

/** Segment used for unscoped (global-read) requests. Must stay byte-identical. */
export const GLOBAL_SCOPE_SEGMENT = "global";

/** Hex chars of the SHA-256 digest kept in the segment (64 bits). */
const DIGEST_HEX_CHARS = 16;

/**
 * Cache-key segment for an org scope.
 *
 * - `null` / `undefined` → `"global"`
 * - empty `brand_ids`    → `org:<org_id>:none`
 * - otherwise            → `org:<org_id>:<first 16 hex of sha256(sorted unique brand_ids joined by ",")>`
 */
export async function scopeCacheSegment(scope: OrgScope | null | undefined): Promise<string> {
  if (!scope) return GLOBAL_SCOPE_SEGMENT;
  const ids = Array.from(new Set(scope.brand_ids.map(String))).sort();
  if (ids.length === 0) return `org:${scope.org_id}:none`;
  const digest = await hashToken(ids.join(","));
  return `org:${scope.org_id}:${digest.slice(0, DIGEST_HEX_CHARS)}`;
}
