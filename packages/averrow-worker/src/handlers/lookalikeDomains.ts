// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Lookalike Domain API Handlers — CRUD and trigger endpoints for
 * continuous lookalike domain monitoring.
 *
 * Ownership: super_admin sees any brand; org members see only brands
 * in their org_brands. Replaces the old user_id-via-brand_profiles
 * scoping (R2 of brand_profiles deprecation, 2026-05-07).
 */

import { json } from "../lib/cors";
import { generateAndStoreLookalikes, checkLookalikeBatch } from "../scanners/lookalike-domains";
import { logger } from "../lib/logger";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

// ─── Brand-access helpers ─────────────────────────────────────────
// Super_admin can touch any brand. Org members must have the brand
// assigned in org_brands. Brand-existence + ownership rolled into one
// query so we can return 404 vs 403 cleanly.

async function findBrandForCaller(
  env:     Env,
  brandId: string,
  ctx:     AuthContext,
): Promise<{ id: string; canonical_domain: string } | null> {
  if (ctx.role === "super_admin") {
    return env.DB.prepare(
      "SELECT id, canonical_domain FROM brands WHERE id = ?",
    ).bind(brandId).first<{ id: string; canonical_domain: string }>();
  }
  if (!ctx.orgId) return null;
  return env.DB.prepare(
    `SELECT b.id, b.canonical_domain
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE b.id = ? AND ob.org_id = ?`,
  ).bind(brandId, ctx.orgId).first<{ id: string; canonical_domain: string }>();
}

// ─── GET /api/lookalikes/:brandId — List lookalike domains for a brand ───

export async function handleListLookalikes(
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
    const registered = url.searchParams.get("registered");
    const threatLevel = url.searchParams.get("threat_level");
    const status = url.searchParams.get("status");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    let where = "WHERE brand_id = ?";
    const params: unknown[] = [brandId];

    if (registered !== null) {
      where += " AND registered = ?";
      params.push(parseInt(registered, 10));
    }
    if (threatLevel) {
      where += " AND threat_level = ?";
      params.push(threatLevel.toUpperCase());
    }
    if (status) {
      where += " AND status = ?";
      params.push(status);
    }

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains ${where}`,
    ).bind(...params).first<{ n: number }>();
    const total = countRow?.n ?? 0;

    const rows = await env.DB.prepare(
      `SELECT * FROM lookalike_domains ${where}
       ORDER BY registered DESC, threat_level DESC, created_at DESC
       LIMIT ? OFFSET ?`,
    ).bind(...params, limit, offset).all();

    return json({ success: true, data: rows.results, total }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/lookalikes/:brandId/generate — Generate permutations ───

export async function handleGenerateLookalikes(
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

    const newCount = await generateAndStoreLookalikes(env, brandId, brand.canonical_domain);

    return json({
      success: true,
      data: {
        brand_id: brandId,
        domain: brand.canonical_domain,
        new_permutations: newCount,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── PATCH /api/lookalikes/:id — Update lookalike status ───

export async function handleUpdateLookalike(
  request: Request,
  env: Env,
  id: string,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify ownership: super_admin → any lookalike; org member →
    // lookalikes whose parent brand is in their org_brands.
    let existing: { id: string; brand_id: string } | null = null;
    if (ctx.role === "super_admin") {
      existing = await env.DB.prepare(
        "SELECT id, brand_id FROM lookalike_domains WHERE id = ?",
      ).bind(id).first<{ id: string; brand_id: string }>();
    } else if (ctx.orgId) {
      existing = await env.DB.prepare(
        `SELECT ld.id, ld.brand_id
         FROM lookalike_domains ld
         JOIN org_brands ob ON ob.brand_id = ld.brand_id
         WHERE ld.id = ? AND ob.org_id = ?`,
      ).bind(id, ctx.orgId).first<{ id: string; brand_id: string }>();
    }

    if (!existing) {
      return json({ success: false, error: "Lookalike domain not found" }, 404, origin);
    }

    const body = await request.json().catch(() => null) as {
      status?: string;
      threat_level?: string;
    } | null;

    if (!body) {
      return json({ success: false, error: "Request body is required" }, 400, origin);
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status !== undefined) {
      const validStatuses = ["monitoring", "confirmed_threat", "benign", "taken_down"];
      if (!validStatuses.includes(body.status)) {
        return json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        }, 400, origin);
      }
      updates.push("status = ?");
      values.push(body.status);
    }

    if (body.threat_level !== undefined) {
      const validLevels = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
      const level = body.threat_level.toUpperCase();
      if (!validLevels.includes(level)) {
        return json({
          success: false,
          error: `Invalid threat_level. Must be one of: ${validLevels.join(", ")}`,
        }, 400, origin);
      }
      updates.push("threat_level = ?");
      values.push(level);
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No valid fields to update" }, 400, origin);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(
      `UPDATE lookalike_domains SET ${updates.join(", ")} WHERE id = ?`,
    ).bind(...values).run();

    const updated = await env.DB.prepare(
      "SELECT * FROM lookalike_domains WHERE id = ?",
    ).bind(id).first();

    return json({ success: true, data: updated }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/lookalikes/:brandId/scan — Trigger immediate scan ───

export async function handleScanLookalikes(
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

    // Reset last_checked for all this brand's domains so the batch checker picks them up
    const resetResult = await env.DB.prepare(
      `UPDATE lookalike_domains
       SET last_checked = NULL, updated_at = datetime('now')
       WHERE brand_id = ?`,
    ).bind(brandId).run();

    const resetCount = resetResult.meta.changes ?? 0;

    // Run the batch checker immediately
    await checkLookalikeBatch(env);

    logger.info("lookalike_scan_triggered", {
      brand_id: brandId,
      user_id: ctx.userId,
      org_id: ctx.orgId,
      domains_queued: resetCount,
    });

    return json({
      success: true,
      data: {
        brand_id: brandId,
        domains_queued: resetCount,
        message: "Scan triggered. Results will be available shortly.",
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
