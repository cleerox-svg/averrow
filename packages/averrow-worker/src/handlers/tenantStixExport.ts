/**
 * Customer STIX 2.1 export — GET /api/orgs/:orgId/export/stix
 *
 * Disclosure register G3 / L3: STIX export was staff-only
 * (`/api/export/stix/:brandId`, `requireStaff`). This is the tenant
 * counterpart, reusing the same serializer (`lib/stix.ts`), scoped to the
 * calling org's own brands (`org_brands`).
 *
 * Isolation:
 *   - Route layer: `requireOrgMember` (routes/tenant.ts).
 *   - Handler layer: `verifyOrgAccess` (inner net), then every query joins
 *     `org_brands` on `ob.org_id = :orgId`, so a `brand_id` belonging to
 *     another org is a 404 and no other org's threats can be selected.
 *   - Read-only. Any org member (viewer+) may export; global-read roles
 *     (super_admin / auditor) pass `verifyOrgAccess` like every tenant read.
 *
 * Disclosure (T3) stripping — the bundle carries only what a customer's SIEM
 * needs to block or hunt:
 *   - Selected columns are an explicit allowlist: no `source_feed`, no
 *     enrichment / vendor verdicts (VT, GSB, GreyNoise, SecLookup, …), no
 *     cluster / campaign ids, no triage fields, no `staff_*` columns.
 *   - `confidence_score` (internal scoring) is NOT passed to the builder;
 *     STIX `confidence` is derived from the severity band only.
 *
 * Bounds: `limit` defaults to 1000, max 5000 indicators per call. The
 * handler reads limit+1 rows, so `X-Averrow-Truncated: true` means more
 * rows exist, and `X-Averrow-Next-Before` carries an opaque keyset cursor
 * (base64url of the last row's created_at + id) to pass back as `?before=`
 * for the next page. Rate
 * limit: 20 exports per hour per (org, user) — `rateLimitCustom`.
 * Plan entitlement: none — no export/API module exists in the entitlement
 * matrix (lib/entitlements.ts) and the same threat rows are already
 * readable by every org member via GET /api/orgs/:orgId/threats.
 */

import { corsHeaders, json } from "../lib/cors";
import { audit } from "../lib/audit";
import { buildSTIXBundle, safeFilename } from "../lib/stix";
import type { BrandInput, STIXBundle, STIXObject, ThreatInput } from "../lib/stix";
import { verifyOrgAccess } from "../middleware/auth";
import type { AuthContext } from "../middleware/auth";
import { rateLimitCustom } from "../middleware/rateLimit";
import type { RateLimitConfig } from "../middleware/rateLimit";
import type { Env } from "../types";

export const TENANT_STIX_DEFAULT_LIMIT = 1000;
export const TENANT_STIX_MAX_LIMIT = 5000;
export const TENANT_STIX_RATE_LIMIT: RateLimitConfig = {
  key: "tenant_stix_export",
  maxRequests: 20,
  windowSeconds: 3600,
};

const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
// threats.status CHECK (0001): active | down | remediated.
const STATUSES = new Set(["active", "down", "remediated"]);
const SINCE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/;

interface BrandRow {
  id: string;
  name: string | null;
  canonical_domain: string | null;
  sector: string | null;
  first_seen: string | null;
}

interface ThreatRow {
  id: string;
  target_brand_id: string;
  threat_type: string;
  severity: string | null;
  status: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
}

/** Strip a DB row down to the serializer input — confidence_score is
 *  deliberately absent (internal scoring), severity normalised to the
 *  builder's uppercase band keys. */
export function toTenantStixThreat(row: ThreatRow): ThreatInput {
  return {
    id: row.id,
    threat_type: row.threat_type,
    severity: row.severity ? row.severity.toUpperCase() : null,
    status: row.status,
    malicious_domain: row.malicious_domain,
    malicious_url: row.malicious_url,
    confidence_score: null,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    created_at: row.created_at,
  };
}

export { safeFilename } from "../lib/stix";

/**
 * Opaque keyset cursor: base64url(JSON [created_at, id]). Encoding the raw
 * stored values (rather than validating a timestamp format) means a cursor
 * the server issued always parses back, whatever format a feed wrote
 * `created_at` in (`datetime('now')`, ISO with `T`/fraction/`Z`/offset…).
 * Both values only ever reach SQL as bound parameters.
 */
export function encodeBeforeCursor(createdAt: string, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([createdAt, id]));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of encodeBeforeCursor. Null when malformed or oversized. */
export function parseBeforeCursor(raw: string): { createdAt: string; id: string } | null {
  if (raw.length === 0 || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed as unknown[];
    if (typeof createdAt !== "string" || typeof id !== "string") return null;
    if (createdAt.length === 0 || createdAt.length > 64 || id.length === 0 || id.length > 200) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function badRequest(error: string, origin: string | null): Response {
  return json({ success: false, error }, 400, origin);
}

export async function handleTenantStixExport(
  request: Request,
  env: Env,
  orgId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  const limited = await rateLimitCustom(request, env, TENANT_STIX_RATE_LIMIT, `${orgId}:${ctx.userId}`);
  if (limited) return limited;

  const url = new URL(request.url);
  const brandId = url.searchParams.get("brand_id");
  const since = url.searchParams.get("since");
  const severity = url.searchParams.get("severity")?.toLowerCase() ?? null;
  const status = url.searchParams.get("status")?.toLowerCase() ?? null;
  const rawLimit = parseInt(url.searchParams.get("limit") ?? String(TENANT_STIX_DEFAULT_LIMIT), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(TENANT_STIX_MAX_LIMIT, rawLimit))
    : TENANT_STIX_DEFAULT_LIMIT;

  if (since !== null && !SINCE_RE.test(since)) return badRequest("since must be an ISO-8601 date", origin);
  if (severity !== null && !SEVERITIES.has(severity)) return badRequest("Invalid severity", origin);
  if (status !== null && status !== "all" && !STATUSES.has(status)) return badRequest("Invalid status", origin);
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw === null ? null : parseBeforeCursor(beforeRaw);
  if (beforeRaw !== null && before === null) return badRequest("Invalid before cursor", origin);

  try {
    // 1. The org's brands (optionally one of them). Same org_brands join the
    //    threat query uses, so a foreign brand_id resolves to nothing.
    const brandSql = `SELECT b.id, b.name, b.canonical_domain, b.sector, b.first_seen
                        FROM org_brands ob
                        JOIN brands b ON b.id = ob.brand_id
                       WHERE ob.org_id = ?${brandId ? " AND ob.brand_id = ?" : ""}`;
    const brandBinds: unknown[] = brandId ? [orgId, brandId] : [orgId];
    const brandRows = await env.DB.prepare(brandSql).bind(...brandBinds).all<BrandRow>();
    const brands = brandRows.results ?? [];
    if (brandId && brands.length === 0) {
      return json({ success: false, error: "Brand not assigned to your organization" }, 404, origin);
    }

    // 2. Threats for those brands only. Explicit column allowlist — see header.
    const conditions: string[] = [];
    const binds: unknown[] = [orgId];
    if (brandId) { conditions.push("t.target_brand_id = ?"); binds.push(brandId); }
    if (since) { conditions.push("t.created_at >= ?"); binds.push(since.replace("T", " ").replace(/Z$/, "")); }
    if (severity) { conditions.push("t.severity = ?"); binds.push(severity); }
    if (status && status !== "all") { conditions.push("t.status = ?"); binds.push(status); }
    if (before) {
      conditions.push("(t.created_at < ? OR (t.created_at = ? AND t.id < ?))");
      binds.push(before.createdAt, before.createdAt, before.id);
    }
    // limit + 1: the extra row only proves there is more (accurate
    // truncation flag + next cursor); it is never exported.
    binds.push(limit + 1);

    const fetched: ThreatRow[] = brands.length === 0
      ? []
      : (await env.DB.prepare(
          `SELECT t.id, t.target_brand_id, t.threat_type, t.severity, t.status,
                  t.malicious_domain, t.malicious_url, t.first_seen, t.last_seen, t.created_at
             FROM threats t
             JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
            ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ?`,
        ).bind(...binds).all<ThreatRow>()).results ?? [];
    const truncated = fetched.length > limit;
    const threatRows = truncated ? fetched.slice(0, limit) : fetched;
    const lastRow = threatRows[threatRows.length - 1];
    const nextBefore = truncated && lastRow ? encodeBeforeCursor(lastRow.created_at, lastRow.id) : null;

    // 3. One identity + its indicators/relationships per brand, merged into
    //    a single bundle via the shared serializer.
    const byBrand = new Map<string, ThreatInput[]>();
    for (const row of threatRows) {
      const list = byBrand.get(row.target_brand_id) ?? [];
      list.push(toTenantStixThreat(row));
      byBrand.set(row.target_brand_id, list);
    }
    const objects: STIXObject[] = [];
    for (const brand of brands) {
      const threats = byBrand.get(String(brand.id)) ?? [];
      if (threats.length === 0 && !brandId) continue;
      const brandInput: BrandInput = {
        id: String(brand.id),
        name: brand.name ?? undefined,
        canonical_domain: brand.canonical_domain ?? undefined,
        first_seen: brand.first_seen ?? undefined,
        sector: brand.sector,
      };
      objects.push(...(await buildSTIXBundle(threats, brandInput)).objects);
    }
    const bundle: STIXBundle = { type: "bundle", id: `bundle--${crypto.randomUUID()}`, objects };

    try {
      await audit(env, {
        action: "tenant_stix_export",
        userId: ctx.userId,
        resourceType: "organization",
        resourceId: orgId,
        details: { org_id: orgId, brand_id: brandId, indicators: threatRows.length, limit },
        outcome: "success",
        request,
      });
    } catch { /* audit is best-effort */ }

    const filename = safeFilename(`averrow-stix-org-${orgId}-${Date.now()}`) + ".json";
    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/stix+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Averrow-Truncated": truncated ? "true" : "false",
        ...(nextBefore ? { "X-Averrow-Next-Before": nextBefore } : {}),
        ...corsHeaders(origin, env),
        // Let the tenant SPA (cross-origin in dev) read the pagination headers.
        "Access-Control-Expose-Headers": "X-Averrow-Truncated, X-Averrow-Next-Before, Content-Disposition",
      },
    });
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
