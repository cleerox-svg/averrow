// Averrow — Trademark Infringement tenant module surface
//
// Mirrors handlers/tenantAppStoreModule.ts for trademark_assets +
// trademark_findings. Two endpoints:
//
//   GET /api/orgs/:orgId/modules/trademark
//     Per-brand summary: registered assets count + findings rollup
//     across contexts (website, social, app_store, marketplace).
//
//   GET /api/orgs/:orgId/modules/trademark/brands/:brandId
//     Per-brand drill-down: assets the brand has registered + the
//     findings against them, ordered severity → classification →
//     recency.
//
// Scanner wiring (image-hash crawler + vision-LLM fallback) is a
// follow-up sprint; this surface ships read-side now.
//
// Phase B sprint 7.

import { json, corsHeaders } from "../lib/cors";
import type { Env } from "../types";
import { verifyOrgAccess, ORG_ROLE_HIERARCHY } from "../middleware/auth";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

// Asset management (upload/delete) requires an org analyst+ role. Kept as a
// distinct predicate from canPerformHITL — same threshold today, but a
// separate authorization intent (asset mutation vs HITL triage). Sources the
// canonical shared ORG_ROLE_HIERARCHY (follow-up #36) rather than a local copy.
function canManageAssets(ctx: AuthContext): boolean {
  if (ctx.role === "super_admin") return true;
  return (ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0) >= 2;
}

const MAX_ASSET_BYTES = 2 * 1024 * 1024; // 2 MB
const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
const ALLOWED_ASSET_TYPES = new Set(["logo", "wordmark", "combined"]);

function r2KeyFor(orgIdNum: number, brandId: string, assetId: string): string {
  return `org/${orgIdNum}/brand/${brandId}/${assetId}`;
}

function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  // Accept raw base64 or a data: URL.
  const comma = input.indexOf(",");
  const b64 = input.startsWith("data:") && comma >= 0 ? input.slice(comma + 1) : input;
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface UploadAssetBody {
  asset_type?:           string;
  asset_name?:           string;
  content_type?:         string;
  data_base64?:          string;
  registration_country?: string;
  registration_number?:  string;
  registration_date?:    string;
}

// ─── POST /api/orgs/:orgId/modules/trademark/brands/:brandId/assets ──
//
// Upload a logo/wordmark image. Stores raw bytes in R2 + computes SHA-256
// now; pHash is computed in Phase 2 from the stored bytes (the matching
// pipeline). asset_url points at the auth-gated image-serve endpoint.

export async function handleUploadTrademarkAsset(
  request: Request,
  env:     Env,
  orgId:   string,
  brandId: string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) return json({ success: false, error: "Invalid organization id" }, 400, origin);

  try {
    if (ctx.role !== "super_admin") await requireModule(env, orgIdNum, "trademark");
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({ success: false, error: "Trademark Infringement isn't enabled for your organization.", code: "MODULE_NOT_ENTITLED" }, 403, origin);
    }
    throw err;
  }

  if (!canManageAssets(ctx)) {
    return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);
  }
  if (!env.TRADEMARK_ASSETS) {
    return json({ success: false, error: "Asset storage is not configured" }, 503, origin);
  }

  // Brand must belong to the org.
  const owned = await env.DB.prepare(
    "SELECT 1 FROM org_brands WHERE org_id = ? AND brand_id = ?",
  ).bind(orgIdNum, brandId).first();
  if (!owned) return json({ success: false, error: "Brand not assigned to your organization" }, 404, origin);

  let body: UploadAssetBody;
  try {
    body = await request.json() as UploadAssetBody;
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400, origin);
  }

  const assetType = (body.asset_type ?? "").toLowerCase();
  if (!ALLOWED_ASSET_TYPES.has(assetType)) {
    return json({ success: false, error: "asset_type must be one of: logo, wordmark, combined" }, 400, origin);
  }
  const contentType = (body.content_type ?? "").toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return json({ success: false, error: "Unsupported image type (png, jpeg, webp, gif, svg only)" }, 400, origin);
  }
  if (!body.data_base64) {
    return json({ success: false, error: "data_base64 is required" }, 400, origin);
  }

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64(body.data_base64);
  } catch {
    return json({ success: false, error: "data_base64 is not valid base64" }, 400, origin);
  }
  if (bytes.byteLength === 0) return json({ success: false, error: "Empty image" }, 400, origin);
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    return json({ success: false, error: "Image exceeds 2 MB limit" }, 413, origin);
  }

  const assetId = `tm-asset-up-${crypto.randomUUID()}`;
  const sha256 = await sha256Hex(bytes);
  const key = r2KeyFor(orgIdNum, brandId, assetId);
  const assetUrl = `/api/orgs/${orgIdNum}/modules/trademark/assets/${assetId}/image`;

  await env.TRADEMARK_ASSETS.put(key, bytes, { httpMetadata: { contentType } });

  await env.DB.prepare(
    `INSERT INTO trademark_assets
       (id, brand_id, asset_type, asset_name, asset_url, asset_hash, phash,
        registration_country, registration_number, registration_date, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'active', ?)`,
  ).bind(
    assetId, brandId, assetType, body.asset_name ?? null, assetUrl, sha256,
    body.registration_country ?? null, body.registration_number ?? null, body.registration_date ?? null,
    ctx.userId,
  ).run();

  return json({ success: true, data: { id: assetId, asset_url: assetUrl, asset_hash: sha256, asset_type: assetType } }, 201, origin);
}

// ─── GET /api/orgs/:orgId/modules/trademark/assets/:assetId/image ──
// Auth-gated image stream. Verifies the asset's brand belongs to the org.

export async function handleServeTrademarkAssetImage(
  request: Request,
  env:     Env,
  orgId:   string,
  assetId: string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) return json({ success: false, error: "Invalid organization id" }, 400, origin);
  if (!env.TRADEMARK_ASSETS) return json({ success: false, error: "Asset storage is not configured" }, 503, origin);

  const row = await env.DB.prepare(
    `SELECT a.brand_id FROM trademark_assets a
     JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
     WHERE a.id = ?`,
  ).bind(orgIdNum, assetId).first<{ brand_id: string }>();
  if (!row) return json({ success: false, error: "Asset not found" }, 404, origin);

  const obj = await env.TRADEMARK_ASSETS.get(r2KeyFor(orgIdNum, row.brand_id, assetId));
  if (!obj) return json({ success: false, error: "Asset image not found" }, 404, origin);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=300");
  // Audit L4: never echo arbitrary Origins — use the central allow-list
  // (falls back to https://averrow.com for non-allowed origins).
  for (const [k, v] of Object.entries(corsHeaders(origin, env))) headers.set(k, v);
  return new Response(obj.body, { status: 200, headers });
}

// ─── DELETE /api/orgs/:orgId/modules/trademark/assets/:assetId ──

export async function handleDeleteTrademarkAsset(
  request: Request,
  env:     Env,
  orgId:   string,
  assetId: string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);
  if (!canManageAssets(ctx)) {
    return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);
  }

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) return json({ success: false, error: "Invalid organization id" }, 400, origin);

  const row = await env.DB.prepare(
    `SELECT a.brand_id FROM trademark_assets a
     JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
     WHERE a.id = ?`,
  ).bind(orgIdNum, assetId).first<{ brand_id: string }>();
  if (!row) return json({ success: false, error: "Asset not found" }, 404, origin);

  if (env.TRADEMARK_ASSETS) {
    await env.TRADEMARK_ASSETS.delete(r2KeyFor(orgIdNum, row.brand_id, assetId)).catch(() => {});
  }
  await env.DB.prepare(
    "UPDATE trademark_assets SET status = 'retired', updated_at = datetime('now') WHERE id = ?",
  ).bind(assetId).run();

  return json({ success: true, message: "Asset removed" }, 200, origin);
}

interface TrademarkBrandSummary {
  brand_id:                 string;
  brand_name:               string;
  canonical_domain:         string;
  assets_active:            number;
  findings_total:           number;
  findings_confirmed:       number;
  findings_likely:          number;
  findings_unknown:         number;
  findings_false_positive:  number;
  findings_high_critical:   number;
  contexts_covered:         number;
}

// ─── GET /api/orgs/:orgId/modules/trademark ─────────────────────

export async function handleGetTrademarkModuleSummary(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "trademark");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Trademark Infringement isn't enabled for your organization. Contact support@averrow.com.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  const result = await env.DB.prepare(
    `SELECT
       b.id AS brand_id,
       b.name AS brand_name,
       b.canonical_domain,
       (SELECT COUNT(*) FROM trademark_assets ta WHERE ta.brand_id = b.id AND ta.status = 'active') AS assets_active,
       (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active') AS findings_total,
       (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND tf.classification = 'confirmed') AS findings_confirmed,
       (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND tf.classification = 'likely')    AS findings_likely,
       (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND tf.classification = 'unknown')   AS findings_unknown,
       (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.classification = 'false_positive') AS findings_false_positive,
       (SELECT COUNT(*) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active' AND LOWER(tf.severity) IN ('high','critical')) AS findings_high_critical,
       (SELECT COUNT(DISTINCT tf.found_context) FROM trademark_findings tf WHERE tf.brand_id = b.id AND tf.status = 'active') AS contexts_covered
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE ob.org_id = ?
     ORDER BY ob.is_primary DESC, b.name`,
  ).bind(orgIdNum).all<TrademarkBrandSummary>();

  const brands = result.results ?? [];

  const totals = brands.reduce((acc, b) => ({
    assets_active:           acc.assets_active           + b.assets_active,
    findings_total:          acc.findings_total          + b.findings_total,
    findings_confirmed:      acc.findings_confirmed      + b.findings_confirmed,
    findings_likely:         acc.findings_likely         + b.findings_likely,
    findings_unknown:        acc.findings_unknown        + b.findings_unknown,
    findings_false_positive: acc.findings_false_positive + b.findings_false_positive,
    findings_high_critical:  acc.findings_high_critical  + b.findings_high_critical,
  }), {
    assets_active: 0, findings_total: 0, findings_confirmed: 0,
    findings_likely: 0, findings_unknown: 0, findings_false_positive: 0,
    findings_high_critical: 0,
  });

  return json({
    success: true,
    data: { org_id: orgIdNum, brands, totals },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/trademark/brands/:brandId ─────

export interface TrademarkAssetRow {
  id:                   string;
  brand_id:             string;
  asset_type:           string;
  asset_name:           string | null;
  asset_url:            string | null;
  asset_hash:           string | null;
  phash:                string | null;
  registration_country: string | null;
  registration_number:  string | null;
  registration_date:    string | null;
  status:               string;
  created_at:           string;
}

export interface TrademarkFindingRow {
  id:                       string;
  brand_id:                 string;
  asset_id:                 string | null;
  found_url:                string;
  found_context:            string | null;
  found_image_url:          string | null;
  found_at:                 string;
  found_phash:              string | null;
  match_distance:           number | null;
  match_confidence:         number | null;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  ai_action:                string | null;
  severity:                 string;
  status:                   string;
  first_seen:               string;
  last_seen:                string | null;
}

export async function handleGetBrandTrademarkFindings(
  request: Request,
  env:     Env,
  orgId:   string,
  brandId: string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "trademark");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Trademark Infringement isn't enabled for your organization.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // Brand-ownership check via org_brands. super_admin bypasses.
  let brandOk: { id: string } | null = null;
  if (ctx.role === "super_admin") {
    brandOk = await env.DB.prepare(
      "SELECT id FROM brands WHERE id = ?",
    ).bind(brandId).first<{ id: string }>();
  } else {
    brandOk = await env.DB.prepare(
      `SELECT b.id FROM brands b
       JOIN org_brands ob ON ob.brand_id = b.id
       WHERE b.id = ? AND ob.org_id = ?`,
    ).bind(brandId, orgIdNum).first<{ id: string }>();
  }
  if (!brandOk) {
    return json({ success: false, error: "Brand not found" }, 404, origin);
  }

  const FINDINGS_LIMIT = 100;

  const [assets, findings] = await Promise.all([
    env.DB.prepare(
      `SELECT id, brand_id, asset_type, asset_name, asset_url, asset_hash, phash,
              registration_country, registration_number, registration_date,
              status, created_at
       FROM trademark_assets
       WHERE brand_id = ? AND status = 'active'
       ORDER BY created_at DESC`,
    ).bind(brandId).all<TrademarkAssetRow>(),

    env.DB.prepare(
      `SELECT id, brand_id, asset_id, found_url, found_context, found_image_url,
              found_at, found_phash, match_distance, match_confidence,
              classification, classified_by, classification_confidence,
              classification_reason, ai_assessment, ai_action,
              severity, status, first_seen, last_seen
       FROM trademark_findings
       WHERE brand_id = ? AND status != 'resolved'
       ORDER BY
         CASE LOWER(severity) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         CASE classification
           WHEN 'confirmed'      THEN 1
           WHEN 'likely'         THEN 2
           WHEN 'unknown'        THEN 3
           WHEN 'false_positive' THEN 4
           ELSE 5
         END,
         COALESCE(last_seen, first_seen) DESC
       LIMIT ?`,
    ).bind(brandId, FINDINGS_LIMIT).all<TrademarkFindingRow>(),
  ]);

  return json({
    success: true,
    data: {
      brand_id:  brandId,
      assets:    assets.results,
      findings:  findings.results,
      page_size: FINDINGS_LIMIT,
    },
  }, 200, origin);
}
