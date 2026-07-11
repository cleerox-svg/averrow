// Averrow — Unified Tier-1 Staff Search
//
// GET /api/search?q=<term>&limit=<default 8>
//
// One prefix-anchored lookup across the four staff-facing entity
// tables (brands, threat_actors, hosting_providers, campaigns),
// returning a compact, uniform row shape for a type-ahead palette.
//
// Cost discipline (CLAUDE.md sec.8):
//   - Prefix-first only: every match is `name LIKE 'q%'` (or
//     canonical_domain for brands), bound as `q + '%'`. The bound
//     term has its LIKE metacharacters (`%`, `_`, `\`) escaped and
//     each clause carries `ESCAPE '\'`, so a user term containing a
//     literal `%` stays anchored instead of collapsing into a
//     leading-wildcard full scan.
//   - The additive NOCASE indexes from migration 0236 back each
//     lookup with an index range scan instead of a full-table scan.
//     NOCASE is required: a case-insensitive LIKE cannot use a plain
//     BINARY-collated index. The brands branch (name OR
//     canonical_domain) runs as a multi-index OR over both NOCASE
//     indexes.
//   - q is trimmed and length-clamped (<= 64 chars) before the cache
//     key is built, so an oversized term can't overflow the KV key
//     limit and silently bypass the cache.
//   - The threats table (691K rows) is never touched here. Brand
//     threat totals come from the pre-computed brands.threat_count
//     column, not a JOIN or aggregate over threats.
//   - Reads go through a read-replica session (getReadSession).
//   - The whole grouped result is memoized in KV for ~90s per query.
//
// This supersedes the super_admin-only /api/admin/brands/search for
// type-ahead/palette use; that endpoint remains live as the legacy
// org-assignment picker and now also reads brands.threat_count directly
// (no threats JOIN).

import { json } from "../lib/cors";
import { getDbContext, getReadSession } from "../lib/db";
import { cachedValue } from "../lib/cached-value";
import { clampQuery, buildPrefix } from "../lib/search-prefix";
import type { Env } from "../types";

/** One unified search hit across any entity type. */
interface SearchResult {
  type: "brand" | "threat_actor" | "provider" | "campaign" | "app_store";
  id: string;
  label: string;
  sublabel: string | null;
}

interface SearchGroups {
  brands: SearchResult[];
  threat_actors: SearchResult[];
  providers: SearchResult[];
  campaigns: SearchResult[];
  // Tier-2 "no-page" entity: app-store impersonation listings. Prefix on
  // app_name (NOT NULL genuine title); `id` is the OWNING brand_id, reserved
  // for a future brand-apps deep-link (there's no per-listing view today and
  // BrandDetail has no 'apps' tab yet, so the palette routes to the /apps
  // overview). dark_web and trademark are deliberately NOT here — neither has
  // a clean prefix-searchable title column (see 0237 migration notes).
  app_store: SearchResult[];
}

const EMPTY_GROUPS: SearchGroups = {
  brands: [],
  threat_actors: [],
  providers: [],
  campaigns: [],
  app_store: [],
};

// GET /api/search — staff-scoped unified type-ahead search.
export async function handleUnifiedSearch(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const rawQ = url.searchParams.get("q") ?? "";
    // Clamp to 64 chars after trim, before the prefix and cache key are
    // built: keeps the KV key under its 512-byte limit so an oversized
    // term can't overflow it and silently bypass the cache.
    const q = clampQuery(rawQ);

    // Short-circuit: no DB round-trip for 0- or 1-char queries.
    if (q.length < 2) {
      return json({ success: true, data: EMPTY_GROUPS }, 200, origin);
    }

    // `limit` is accepted for forward-compat but hard-capped at 5 —
    // each group is a small type-ahead slice (frozen contract).
    const limitParam = parseInt(url.searchParams.get("limit") ?? "8", 10);
    const perGroup = Math.min(5, Math.max(1, Number.isFinite(limitParam) ? limitParam : 8));

    // Prefix binding — anchored, never a leading wildcard. Escape the
    // user term's LIKE metacharacters (`\`, `%`, `_`) so a literal `%`
    // or `_` matches itself instead of acting as a wildcard; each LIKE
    // clause carries `ESCAPE '\'` to honor the escape char. Escaping a
    // metachar-free term is a no-op, so the anchored `q + '%'` shape is
    // preserved for ordinary queries.
    const prefix = buildPrefix(q);
    // Normalized cache key: trim + lowercase, plus the effective
    // per-group cap so a smaller `limit` can't poison the default slice.
    const normalizedQ = q.toLowerCase();
    const cacheKey = `search:staff:${normalizedQ}:${perGroup}`;

    const ctx = getDbContext(request);
    const session = getReadSession(env, ctx);

    const groups = await cachedValue<SearchGroups>(env, cacheKey, 90, async () => {
      const [brandRows, actorRows, providerRows, campaignRows, appStoreRows] = await Promise.all([
        // Brands — prefix on name OR canonical_domain. threat_count is the
        // pre-computed column; no threats read, no JOIN.
        session.prepare(
          `SELECT id, name, canonical_domain, threat_count
             FROM brands
            WHERE name LIKE ? ESCAPE '\\' OR canonical_domain LIKE ? ESCAPE '\\'
            ORDER BY threat_count DESC
            LIMIT ?`,
        ).bind(prefix, prefix, perGroup).all<{
          id: string; name: string; canonical_domain: string | null; threat_count: number | null;
        }>().catch(() => ({ results: [] as Array<{ id: string; name: string; canonical_domain: string | null; threat_count: number | null }> })),

        // Threat actors — prefix on name; country_code is the cheap,
        // indexed sublabel.
        session.prepare(
          `SELECT id, name, country_code
             FROM threat_actors
            WHERE name LIKE ? ESCAPE '\\'
            ORDER BY name
            LIMIT ?`,
        ).bind(prefix, perGroup).all<{
          id: string; name: string; country_code: string | null;
        }>().catch(() => ({ results: [] as Array<{ id: string; name: string; country_code: string | null }> })),

        // Providers — prefix on name; ASN sublabel.
        session.prepare(
          `SELECT id, COALESCE(name, id) AS name, asn
             FROM hosting_providers
            WHERE name LIKE ? ESCAPE '\\'
            ORDER BY total_threat_count DESC
            LIMIT ?`,
        ).bind(prefix, perGroup).all<{
          id: string; name: string; asn: string | number | null;
        }>().catch(() => ({ results: [] as Array<{ id: string; name: string; asn: string | number | null }> })),

        // Campaigns — prefix on name; status sublabel.
        session.prepare(
          `SELECT id, name, status
             FROM campaigns
            WHERE name LIKE ? ESCAPE '\\'
            ORDER BY last_seen DESC
            LIMIT ?`,
        ).bind(prefix, perGroup).all<{
          id: string; name: string; status: string | null;
        }>().catch(() => ({ results: [] as Array<{ id: string; name: string; status: string | null }> })),

        // App-store listings — prefix on app_name (NOT NULL genuine title),
        // backed by the NOCASE index from migration 0237. developer_name is
        // the disambiguating sublabel (falls back to the store). Ordered by
        // impersonation_score so the most-suspicious listing surfaces first.
        // No status filter — a staff user searching an app name wants it
        // whether it's official or an impersonation. Never touches threats.
        session.prepare(
          `SELECT brand_id, app_name, developer_name, store
             FROM app_store_listings
            WHERE app_name LIKE ? ESCAPE '\\'
            ORDER BY impersonation_score DESC
            LIMIT ?`,
        ).bind(prefix, perGroup).all<{
          brand_id: string; app_name: string; developer_name: string | null; store: string | null;
        }>().catch(() => ({ results: [] as Array<{ brand_id: string; app_name: string; developer_name: string | null; store: string | null }> })),
      ]);

      return {
        brands: brandRows.results.map((r) => ({
          type: "brand" as const,
          id: r.id,
          label: r.name,
          sublabel: r.canonical_domain ?? (r.threat_count != null ? `${r.threat_count} threats` : null),
        })),
        threat_actors: actorRows.results.map((r) => ({
          type: "threat_actor" as const,
          id: r.id,
          label: r.name,
          sublabel: r.country_code ?? null,
        })),
        providers: providerRows.results.map((r) => ({
          type: "provider" as const,
          id: r.id,
          label: r.name,
          sublabel: r.asn != null ? `AS${r.asn}` : null,
        })),
        campaigns: campaignRows.results.map((r) => ({
          type: "campaign" as const,
          id: r.id,
          label: r.name,
          sublabel: r.status ?? null,
        })),
        // id is the OWNING brand_id (not the listing PK): reserved for a
        // future brand-apps deep-link. No per-listing view + no 'apps' tab on
        // BrandDetail today, so the palette routes app hits to /apps. label
        // stays the app name.
        app_store: appStoreRows.results.map((r) => ({
          type: "app_store" as const,
          id: r.brand_id,
          label: r.app_name,
          sublabel: r.developer_name ?? r.store ?? null,
        })),
      };
    });

    return json({ success: true, data: groups }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
