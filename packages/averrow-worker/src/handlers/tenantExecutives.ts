// Averrow — Executive identity registry (org-scoped, data-isolated).
//
// EXEC_IMPERSONATION_2026-07 Stage 1: the place to REGISTER a customer's
// named executives and manage them. Detection / alerts / triage / UI are
// Stages 2-5. Backed by the org_executives table (migration 0244).
//
// Isolation is belt-and-suspenders:
//   • outer net — routes sit behind requireOrgMember (auth.ts), which
//     confirms the caller's JWT org scope matches the :orgId param;
//   • inner net — every handler ALSO runs verifyOrgAccess / requireOrgAdmin
//     (ctx.orgId !== orgId), so a route that forgot its guard can't leak.
// Reads are member-visible; every mutation is org-admin+ and audited.
// An exec can only be attached to a brand the org actually owns.

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { requireOrgAdmin } from "./organizations";
import {
  validateExecutiveCreate,
  buildExecutiveUpdate,
} from "../lib/executive-registry";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

// ─── Inner-net read gate (mirrors tenantInvestigations) ──────
// Only super_admin bypasses; auditor is deliberately NOT exempt here —
// same asymmetry as the other tenant handlers (see CLAUDE.md §7).
function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

// An exec may only link to a brand the org owns (org_brands is the
// ownership table). Value-equality join matches how tenantInvestigations
// verifies item ownership.
async function orgOwnsBrand(env: Env, orgId: string, brandId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM org_brands WHERE org_id = ? AND brand_id = ? LIMIT 1",
  ).bind(orgId, brandId).first();
  return !!row;
}

// Confirm an executive belongs to the org (returns the row or null).
async function loadOwnedExecutive(env: Env, orgId: string, id: string) {
  return env.DB.prepare(
    "SELECT * FROM org_executives WHERE id = ? AND org_id = ?",
  ).bind(id, orgId).first<Record<string, unknown>>();
}

// Shape a raw row for the API: parse the JSON columns into real shapes.
function shapeExecutive(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    official_handles: parseJsonObject(row.official_handles),
    watch_platforms: parseJsonArray(row.watch_platforms),
  };
}

function parseJsonObject(value: unknown): Record<string, string> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* fall through to empty */
  }
  return [];
}

interface UpdateExecutiveBody {
  brand_id?: unknown;
  full_name?: unknown;
  title?: unknown;
  official_handles?: unknown;
  watch_platforms?: unknown;
  status?: unknown;
}

// ─── GET /api/orgs/:orgId/executives ─────────────────────────
// Optional ?brand_id= filter. Low-volume per-org list — bare env.DB read.

export async function handleListExecutives(
  request: Request, env: Env, orgId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const url = new URL(request.url);
    const brandId = url.searchParams.get("brand_id");

    const conditions = ["org_id = ?"];
    const bindings: unknown[] = [orgId];
    if (brandId) { conditions.push("brand_id = ?"); bindings.push(brandId); }
    const where = conditions.join(" AND ");

    const rows = await env.DB.prepare(
      `SELECT * FROM org_executives WHERE ${where} ORDER BY full_name ASC`,
    ).bind(...bindings).all<Record<string, unknown>>();

    const data = (rows.results ?? []).map(shapeExecutive);
    return json({ success: true, data, total: data.length }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/orgs/:orgId/executives ────────────────────────

export async function handleCreateExecutive(
  request: Request, env: Env, orgId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  try {
    const body = await request.json() as UpdateExecutiveBody;

    // brand_id is required on create and must belong to the org.
    if (typeof body.brand_id !== "string" || !body.brand_id.trim()) {
      return json({ success: false, error: "brand_id is required" }, 400, origin);
    }
    const brandId = body.brand_id.trim();
    if (!(await orgOwnsBrand(env, orgId, brandId))) {
      return json({ success: false, error: "Brand not found in your organization" }, 404, origin);
    }

    const validated = validateExecutiveCreate(body);
    if (!validated.ok) return json({ success: false, error: validated.error }, 400, origin);
    const v = validated.value;

    const id = crypto.randomUUID();
    // Stamp both timestamps explicitly with ISO/UTC so every row is
    // consistent from creation through update. The column DEFAULT
    // datetime('now') (space form, no Z) stays only as a fallback — the
    // update handler writes ISO, so create must too or the two columns
    // diverge in format (local-vs-UTC parse skew in the browser).
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO org_executives
        (id, org_id, brand_id, full_name, title, official_handles, watch_platforms, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, orgId, brandId, v.full_name, v.title,
      JSON.stringify(v.official_handles), JSON.stringify(v.watch_platforms), v.status,
      now, now,
    ).run();

    await audit(env, {
      action: "executive_create", userId: ctx.userId,
      resourceType: "org_executive", resourceId: id,
      details: { org_id: orgId, brand_id: brandId, full_name: v.full_name },
      outcome: "success", request,
    });

    return json({ success: true, data: { id } }, 201, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/executives/:execId ─────────────────

export async function handleGetExecutive(
  request: Request, env: Env, orgId: string, execId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const row = await loadOwnedExecutive(env, orgId, execId);
    if (!row) return json({ success: false, error: "Executive not found" }, 404, origin);
    return json({ success: true, data: shapeExecutive(row) }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── PATCH/PUT /api/orgs/:orgId/executives/:execId ───────────

export async function handleUpdateExecutive(
  request: Request, env: Env, orgId: string, execId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  try {
    const existing = await loadOwnedExecutive(env, orgId, execId);
    if (!existing) return json({ success: false, error: "Executive not found" }, 404, origin);

    const body = await request.json() as UpdateExecutiveBody;
    const sets: string[] = [];
    const binds: unknown[] = [];

    // brand_id needs a DB ownership round-trip, so it stays here; the rest
    // of the partial merge is assembled by the pure buildExecutiveUpdate.
    if (body.brand_id !== undefined) {
      if (typeof body.brand_id !== "string" || !body.brand_id.trim()) {
        return json({ success: false, error: "brand_id must be a non-empty string" }, 400, origin);
      }
      const brandId = body.brand_id.trim();
      if (!(await orgOwnsBrand(env, orgId, brandId))) {
        return json({ success: false, error: "Brand not found in your organization" }, 404, origin);
      }
      sets.push("brand_id = ?"); binds.push(brandId);
    }

    const built = buildExecutiveUpdate(body);
    if (!built.ok) return json({ success: false, error: built.error }, 400, origin);
    sets.push(...built.value.sets); binds.push(...built.value.binds);

    if (sets.length === 0) return json({ success: false, error: "No changes provided" }, 400, origin);

    sets.push("updated_at = ?"); binds.push(new Date().toISOString());
    await env.DB.prepare(
      `UPDATE org_executives SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`,
    ).bind(...binds, execId, orgId).run();

    await audit(env, {
      action: "executive_update", userId: ctx.userId,
      resourceType: "org_executive", resourceId: execId,
      details: { org_id: orgId, fields: sets.map((s) => s.split(" = ")[0]) },
      outcome: "success", request,
    });

    return json({ success: true, data: { id: execId } }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── DELETE /api/orgs/:orgId/executives/:execId ──────────────
// Customer PII — hard delete is acceptable for Stage 1.

export async function handleDeleteExecutive(
  request: Request, env: Env, orgId: string, execId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const denied = requireOrgAdmin(ctx, orgId, origin);
  if (denied) return denied;

  try {
    const existing = await loadOwnedExecutive(env, orgId, execId);
    if (!existing) return json({ success: false, error: "Executive not found" }, 404, origin);

    await env.DB.prepare(
      "DELETE FROM org_executives WHERE id = ? AND org_id = ?",
    ).bind(execId, orgId).run();

    await audit(env, {
      action: "executive_delete", userId: ctx.userId,
      resourceType: "org_executive", resourceId: execId,
      details: { org_id: orgId }, outcome: "success", request,
    });

    return json({ success: true, data: { id: execId } }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
