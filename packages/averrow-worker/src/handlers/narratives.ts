// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Threat Narratives API handlers.
 *
 * Endpoints:
 *   GET    /api/narratives/:brandId           — list narratives for a brand
 *   GET    /api/narratives/:brandId/:id       — get full narrative detail
 *   POST   /api/narratives/:brandId/generate  — trigger narrative generation
 *   PATCH  /api/narratives/:id                — update narrative status
 */

import { json } from "../lib/cors";
import { generateNarrativesForBrand } from "../agents/narrator";
import type { Env } from "../types";

// GET /api/narratives/:brandId — List threat narratives for a brand
export async function handleListNarratives(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const severity = url.searchParams.get("severity");
    const status = url.searchParams.get("status");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "20", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    let where = `WHERE brand_id = ?`;
    const params: unknown[] = [brandId];

    if (severity) {
      where += ` AND severity = ?`;
      params.push(severity.toUpperCase());
    }
    if (status) {
      where += ` AND status = ?`;
      params.push(status);
    }

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM threat_narratives ${where}`
    ).bind(...params).first<{ c: number }>();
    const total = countRow?.c ?? 0;

    const rows = await env.DB.prepare(
      `SELECT id, brand_id, title, summary, signal_types, severity, confidence,
              attack_stage, status, generated_by, created_at, updated_at
       FROM threat_narratives ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    // Parse JSON fields for each row
    const narratives = rows.results.map((row: any) => ({
      ...row,
      signal_types: row.signal_types ? JSON.parse(row.signal_types) : [],
    }));

    return json({ success: true, data: narratives, total }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/narratives/:brandId/:id — Get full narrative detail
export async function handleGetNarrative(
  request: Request,
  env: Env,
  id: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM threat_narratives WHERE id = ?`
    ).bind(id).first();

    if (!row) {
      return json({ success: false, error: "Narrative not found" }, 404, origin);
    }

    // Parse JSON fields
    const narrative: any = { ...row };
    if (narrative.threat_ids) narrative.threat_ids = JSON.parse(narrative.threat_ids);
    if (narrative.signal_types) narrative.signal_types = JSON.parse(narrative.signal_types);
    if (narrative.recommendations) narrative.recommendations = JSON.parse(narrative.recommendations);

    return json({ success: true, data: narrative }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/narratives/:brandId/generate — Trigger narrative generation
export async function handleGenerateNarrative(
  request: Request,
  env: Env,
  brandId: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify the brand exists
    const brand = await env.DB.prepare(
      `SELECT id, name FROM brands WHERE id = ?`
    ).bind(brandId).first<{ id: string; name: string }>();

    if (!brand) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    // Run narrative generation
    await generateNarrativesForBrand(env, brandId);

    // Return the latest narrative for this brand
    const latest = await env.DB.prepare(
      `SELECT id, title, summary, severity, attack_stage, signal_types, confidence, created_at
       FROM threat_narratives
       WHERE brand_id = ?
       ORDER BY created_at DESC LIMIT 1`
    ).bind(brandId).first();

    if (latest) {
      const result: any = { ...latest };
      if (result.signal_types) result.signal_types = JSON.parse(result.signal_types);
      return json({
        success: true,
        data: result,
        message: `Narrative generated for ${brand.name}`,
      }, 200, origin);
    }

    return json({
      success: true,
      data: null,
      message: `Insufficient signals to generate narrative for ${brand.name}. Need at least 2 different signal types.`,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// PATCH /api/narratives/:id — Update narrative status
export async function handleUpdateNarrative(
  request: Request,
  env: Env,
  id: string,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { status?: string };

    if (!body.status) {
      return json({ success: false, error: "Missing required field: status" }, 400, origin);
    }

    const validStatuses = ["active", "acknowledged", "resolved"];
    if (!validStatuses.includes(body.status)) {
      return json({
        success: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      }, 400, origin);
    }

    const result = await env.DB.prepare(
      `UPDATE threat_narratives SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(body.status, id).run();

    if ((result.meta.changes ?? 0) === 0) {
      return json({ success: false, error: "Narrative not found" }, 404, origin);
    }

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
