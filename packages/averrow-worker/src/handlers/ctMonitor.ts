// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Certificate Transparency Monitor API Handlers — List, stats, update, and
 * trigger CT certificate scans for monitored brands.
 *
 * Ownership: super_admin sees any brand; org members see only brands
 * in their org_brands. Replaces the old user_id-via-brand_profiles
 * scoping (R2 of brand_profiles deprecation, 2026-05-07).
 */

import { json } from "../lib/cors";
import { pollCertificates, checkCertForBrand } from "../scanners/ct-monitor";
import { logger } from "../lib/logger";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

// ─── Brand-access helper ──────────────────────────────────────────
async function findBrandForCaller(
  env:     Env,
  brandId: string,
  ctx:     AuthContext,
): Promise<{ id: string; canonical_domain: string; brand_keywords: string | null } | null> {
  if (ctx.role === "super_admin") {
    return env.DB.prepare(
      "SELECT id, canonical_domain, brand_keywords FROM brands WHERE id = ?",
    ).bind(brandId).first<{ id: string; canonical_domain: string; brand_keywords: string | null }>();
  }
  if (!ctx.orgId) return null;
  return env.DB.prepare(
    `SELECT b.id, b.canonical_domain, b.brand_keywords
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE b.id = ? AND ob.org_id = ?`,
  ).bind(brandId, ctx.orgId).first<{ id: string; canonical_domain: string; brand_keywords: string | null }>();
}

// ─── GET /api/ct/certificates/:brandId — List certificates for a brand ───

export async function handleListCertificates(
  request: Request,
  env: Env,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brand = await findBrandForCaller(env, brandId, ctx);
    if (!brand) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    const url = new URL(request.url);
    const suspicious = url.searchParams.get("suspicious");
    const status = url.searchParams.get("status");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    let where = "WHERE brand_id = ?";
    const params: unknown[] = [brandId];

    if (suspicious !== null) {
      where += " AND suspicious = ?";
      params.push(parseInt(suspicious, 10));
    }
    if (status) {
      where += " AND status = ?";
      params.push(status);
    }

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ct_certificates ${where}`,
    ).bind(...params).first<{ n: number }>();
    const total = countRow?.n ?? 0;

    const rows = await env.DB.prepare(
      `SELECT * FROM ct_certificates ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset).all();

    return json({ success: true, data: rows.results, total }, 200, origin);
  } catch (err) {
    logger.error("ct_handler_list_error", { error: "An internal error occurred" });
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/ct/certificates/:brandId/stats — Certificate stats ───

export async function handleCertStats(
  request: Request,
  env: Env,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brand = await findBrandForCaller(env, brandId, ctx);
    if (!brand) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    const totalRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ct_certificates WHERE brand_id = ?",
    ).bind(brandId).first<{ n: number }>();

    const suspiciousRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ct_certificates WHERE brand_id = ? AND suspicious = 1",
    ).bind(brandId).first<{ n: number }>();

    const newRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ct_certificates WHERE brand_id = ? AND status = 'new'",
    ).bind(brandId).first<{ n: number }>();

    const maliciousRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ct_certificates WHERE brand_id = ? AND status = 'malicious'",
    ).bind(brandId).first<{ n: number }>();

    const benignRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ct_certificates WHERE brand_id = ? AND status = 'benign'",
    ).bind(brandId).first<{ n: number }>();

    const reviewedRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ct_certificates WHERE brand_id = ? AND status = 'reviewed'",
    ).bind(brandId).first<{ n: number }>();

    // Recent certificates (last 24h)
    const recentRow = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM ct_certificates WHERE brand_id = ? AND created_at >= datetime('now', '-24 hours')",
    ).bind(brandId).first<{ n: number }>();

    // Top issuers
    const issuers = await env.DB.prepare(
      `SELECT issuer, COUNT(*) AS count
       FROM ct_certificates WHERE brand_id = ? AND issuer IS NOT NULL
       GROUP BY issuer ORDER BY count DESC LIMIT 5`,
    ).bind(brandId).all<{ issuer: string; count: number }>();

    return json({
      success: true,
      data: {
        total: totalRow?.n ?? 0,
        suspicious: suspiciousRow?.n ?? 0,
        by_status: {
          new: newRow?.n ?? 0,
          reviewed: reviewedRow?.n ?? 0,
          benign: benignRow?.n ?? 0,
          malicious: maliciousRow?.n ?? 0,
        },
        last_24h: recentRow?.n ?? 0,
        top_issuers: issuers.results,
      },
    }, 200, origin);
  } catch (err) {
    logger.error("ct_handler_stats_error", { error: "An internal error occurred" });
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── PATCH /api/ct/certificates/:id — Update certificate status ───

export async function handleUpdateCertificate(
  request: Request,
  env: Env,
  id: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify ownership: super_admin → any cert; org member →
    // certs whose brand is in their org_brands.
    let existing: { id: string; brand_id: string } | null = null;
    if (ctx.role === "super_admin") {
      existing = await env.DB.prepare(
        "SELECT id, brand_id FROM ct_certificates WHERE id = ?",
      ).bind(id).first<{ id: string; brand_id: string }>();
    } else if (ctx.orgId) {
      existing = await env.DB.prepare(
        `SELECT ct.id, ct.brand_id
         FROM ct_certificates ct
         JOIN org_brands ob ON ob.brand_id = ct.brand_id
         WHERE ct.id = ? AND ob.org_id = ?`,
      ).bind(id, ctx.orgId).first<{ id: string; brand_id: string }>();
    }

    if (!existing) {
      return json({ success: false, error: "Certificate not found" }, 404, origin);
    }

    const body = await request.json().catch(() => null) as {
      status?: string;
      ai_assessment?: string;
    } | null;

    if (!body) {
      return json({ success: false, error: "Request body is required" }, 400, origin);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status !== undefined) {
      const validStatuses = ["new", "reviewed", "benign", "malicious"];
      if (!validStatuses.includes(body.status)) {
        return json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        }, 400, origin);
      }
      updates.push("status = ?");
      values.push(body.status);
    }

    if (body.ai_assessment !== undefined) {
      updates.push("ai_assessment = ?");
      values.push(body.ai_assessment);
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No valid fields to update" }, 400, origin);
    }

    values.push(id);

    await env.DB.prepare(
      `UPDATE ct_certificates SET ${updates.join(", ")} WHERE id = ?`,
    ).bind(...values).run();

    const updated = await env.DB.prepare(
      "SELECT * FROM ct_certificates WHERE id = ?",
    ).bind(id).first();

    return json({ success: true, data: updated }, 200, origin);
  } catch (err) {
    logger.error("ct_handler_update_error", { error: "An internal error occurred" });
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/ct/scan/:brandId — Trigger immediate CT scan ───

export async function handleTriggerCTScan(
  request: Request,
  env: Env,
  brandId: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const brand = await findBrandForCaller(env, brandId, ctx);
    if (!brand) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }
    if (!brand.canonical_domain) {
      return json({ success: false, error: "Brand has no canonical domain configured" }, 400, origin);
    }

    const keywords = brand.brand_keywords
      ? (JSON.parse(brand.brand_keywords) as string[])
      : [];

    // Run CT scan immediately for this brand. Scanner accepts an
    // optional userId for legacy traceability — not load-bearing
    // post-deprecation; pass undefined.
    const result = await checkCertForBrand(env, brand.id, brand.canonical_domain, keywords);

    logger.info("ct_scan_triggered", {
      brand_id: brandId,
      user_id: ctx.userId,
      org_id: ctx.orgId,
      total: result.total,
      suspicious: result.suspicious,
      new_certs: result.newCerts,
    });

    return json({
      success: true,
      data: {
        brand_id: brandId,
        domain: brand.canonical_domain,
        certificates_found: result.total,
        new_certificates: result.newCerts,
        suspicious: result.suspicious,
        message: "CT scan completed.",
      },
    }, 200, origin);
  } catch (err) {
    logger.error("ct_handler_scan_error", { error: "An internal error occurred" });
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
