// Averrow — Tenant Investigations / Cases (org-scoped, data-isolated).
//
// TENANT_ANALYST_UX_RESEARCH_2026-06 #7 (§5.6): a case object grouping
// related signals/threats/takedowns under one investigation with a
// status, an owner, a notes timeline, and an audit trail. Backed by the
// investigations / investigation_items / investigation_notes tables
// (migration 0222). Reads are member-visible; every mutation is
// analyst+ (canPerformHITL) and audited.

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

// ─── Helpers (local — mirror tenantData.ts's private gates) ──

const ORG_ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1, analyst: 2, admin: 3, owner: 4,
};

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

function canPerformHITL(ctx: AuthContext): boolean {
  if (ctx.role === "super_admin") return true;
  return (ORG_ROLE_HIERARCHY[ctx.orgRole ?? ""] ?? 0) >= (ORG_ROLE_HIERARCHY["analyst"] ?? 2);
}

const VALID_STATUS = new Set(["open", "monitoring", "closed"]);
const VALID_SEVERITY = new Set(["critical", "high", "medium", "low"]);
const VALID_ITEM_TYPE = new Set(["alert", "threat", "takedown"]);

interface InvestigationBody {
  title?: string;
  description?: string | null;
  status?: string;
  severity?: string;
  assigned_to?: string | null;
}
interface ItemBody { item_type?: string; item_id?: string; note?: string | null }
interface NoteBody { body?: string }

// Confirm an investigation belongs to the org (returns the row or null).
async function loadOwnedInvestigation(env: Env, orgId: string, id: string) {
  return env.DB.prepare(
    "SELECT * FROM investigations WHERE id = ? AND org_id = ?",
  ).bind(id, orgId).first<Record<string, unknown>>();
}

// Resolve display names for a set of user ids in one query.
async function resolveNames(env: Env, ids: Array<string | null | undefined>): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => typeof x === "string" && !!x))];
  const map: Record<string, string> = {};
  if (unique.length === 0) return map;
  const ph = unique.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, COALESCE(display_name, name, email) AS name FROM users WHERE id IN (${ph})`,
  ).bind(...unique).all<{ id: string; name: string }>();
  for (const r of rows.results ?? []) map[r.id] = r.name;
  return map;
}

// ─── GET /api/orgs/:orgId/investigations ─────────────────────

export async function handleListInvestigations(
  request: Request, env: Env, orgId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const conditions = ["i.org_id = ?"];
    const bindings: unknown[] = [orgId];
    if (status && VALID_STATUS.has(status)) { conditions.push("i.status = ?"); bindings.push(status); }
    const where = conditions.join(" AND ");

    const rows = await env.DB.prepare(`
      SELECT i.*,
             (SELECT COUNT(*) FROM investigation_items it WHERE it.investigation_id = i.id) AS item_count,
             (SELECT COUNT(*) FROM investigation_notes n WHERE n.investigation_id = i.id) AS note_count
      FROM investigations i
      WHERE ${where}
      ORDER BY CASE i.status WHEN 'open' THEN 1 WHEN 'monitoring' THEN 2 ELSE 3 END,
               i.updated_at DESC
      LIMIT ? OFFSET ?
    `).bind(...bindings, limit, offset).all<Record<string, unknown>>();

    const total = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM investigations i WHERE ${where}`,
    ).bind(...bindings).first<{ total: number }>();

    const statusBreakdown = await env.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM investigations WHERE org_id = ? GROUP BY status",
    ).bind(orgId).all<{ status: string; count: number }>();

    const items = rows.results ?? [];
    const names = await resolveNames(env, items.flatMap((r) => [r.assigned_to as string, r.created_by as string]));
    const data = items.map((r) => ({
      ...r,
      assigned_to_name: r.assigned_to ? (names[r.assigned_to as string] ?? null) : null,
      created_by_name: r.created_by ? (names[r.created_by as string] ?? null) : null,
    }));

    return json({
      success: true, data, total: total?.total ?? 0,
      status_breakdown: statusBreakdown.results ?? [],
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/orgs/:orgId/investigations ────────────────────

export async function handleCreateInvestigation(
  request: Request, env: Env, orgId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);
  if (!canPerformHITL(ctx)) return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);

  try {
    const body = await request.json() as InvestigationBody & { items?: ItemBody[] };
    const title = (body.title ?? "").trim();
    if (!title) return json({ success: false, error: "Title is required" }, 400, origin);

    const severity = body.severity && VALID_SEVERITY.has(body.severity) ? body.severity : "medium";
    const id = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO investigations (id, org_id, title, description, status, severity, created_by)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).bind(id, orgId, title, body.description?.trim() || null, severity, ctx.userId).run();

    // Optional seed items (e.g. "open investigation from this signal").
    const seeds = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    for (const it of seeds) {
      if (!it.item_type || !it.item_id || !VALID_ITEM_TYPE.has(it.item_type)) continue;
      await env.DB.prepare(`
        INSERT OR IGNORE INTO investigation_items (id, investigation_id, item_type, item_id, note, added_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), id, it.item_type, it.item_id, it.note?.trim() || null, ctx.userId).run();
    }

    await audit(env, {
      action: "investigation_create", userId: ctx.userId,
      resourceType: "investigation", resourceId: id,
      details: { org_id: orgId, title, seeded_items: seeds.length },
      outcome: "success", request,
    });

    return json({ success: true, data: { id } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/orgs/:orgId/investigations/:id ─────────────────

export async function handleGetInvestigation(
  request: Request, env: Env, orgId: string, id: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);

  try {
    const inv = await loadOwnedInvestigation(env, orgId, id);
    if (!inv) return json({ success: false, error: "Investigation not found" }, 404, origin);

    const itemRows = await env.DB.prepare(
      "SELECT * FROM investigation_items WHERE investigation_id = ? ORDER BY added_at ASC",
    ).bind(id).all<Record<string, unknown>>();
    const items = await resolveItemSummaries(env, itemRows.results ?? []);

    const noteRows = await env.DB.prepare(
      "SELECT * FROM investigation_notes WHERE investigation_id = ? ORDER BY created_at ASC",
    ).bind(id).all<Record<string, unknown>>();
    const noteAuthorNames = await resolveNames(env, (noteRows.results ?? []).map((n) => n.author_id as string));
    const notes = (noteRows.results ?? []).map((n) => ({
      ...n, author_name: n.author_id ? (noteAuthorNames[n.author_id as string] ?? null) : null,
    }));

    const names = await resolveNames(env, [inv.assigned_to as string, inv.created_by as string]);

    return json({
      success: true,
      data: {
        ...inv,
        assigned_to_name: inv.assigned_to ? (names[inv.assigned_to as string] ?? null) : null,
        created_by_name: inv.created_by ? (names[inv.created_by as string] ?? null) : null,
        items, notes,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// Resolve a friendly title/severity/status per linked item, batched by type.
async function resolveItemSummaries(env: Env, rows: Array<Record<string, unknown>>) {
  const byType = { alert: [] as string[], threat: [] as string[], takedown: [] as string[] };
  for (const r of rows) {
    const t = r.item_type as keyof typeof byType;
    if (byType[t]) byType[t].push(r.item_id as string);
  }

  const summary: Record<string, { label: string; severity: string | null; status: string | null }> = {};
  const fetchInto = async (ids: string[], sql: (ph: string) => string) => {
    if (ids.length === 0) return;
    const ph = ids.map(() => "?").join(",");
    const res = await env.DB.prepare(sql(ph)).bind(...ids).all<{ id: string; label: string; severity: string | null; status: string | null }>();
    for (const row of res.results ?? []) summary[`${row.id}`] = { label: row.label, severity: row.severity, status: row.status };
  };

  await fetchInto(byType.alert, (ph) =>
    `SELECT id, title AS label, severity, status FROM alerts WHERE id IN (${ph})`);
  await fetchInto(byType.threat, (ph) =>
    `SELECT id, COALESCE(malicious_domain, malicious_url, ip_address, threat_type) AS label, severity, status FROM threats WHERE id IN (${ph})`);
  await fetchInto(byType.takedown, (ph) =>
    `SELECT id, target_value AS label, severity, status FROM takedown_requests WHERE id IN (${ph})`);

  return rows.map((r) => {
    const s = summary[`${r.item_id}`];
    return {
      id: r.id, item_type: r.item_type, item_id: r.item_id, note: r.note, added_at: r.added_at,
      label: s?.label ?? null, severity: s?.severity ?? null, item_status: s?.status ?? null,
    };
  });
}

// ─── PATCH /api/orgs/:orgId/investigations/:id ───────────────

export async function handleUpdateInvestigation(
  request: Request, env: Env, orgId: string, id: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);
  if (!canPerformHITL(ctx)) return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);

  try {
    const inv = await loadOwnedInvestigation(env, orgId, id);
    if (!inv) return json({ success: false, error: "Investigation not found" }, 404, origin);

    const body = await request.json() as InvestigationBody;
    const sets: string[] = [];
    const binds: unknown[] = [];

    if (typeof body.title === "string") {
      const t = body.title.trim();
      if (!t) return json({ success: false, error: "Title cannot be empty" }, 400, origin);
      sets.push("title = ?"); binds.push(t);
    }
    if (body.description !== undefined) { sets.push("description = ?"); binds.push(body.description?.trim() || null); }
    if (body.severity !== undefined) {
      if (!VALID_SEVERITY.has(body.severity ?? "")) return json({ success: false, error: "Invalid severity" }, 400, origin);
      sets.push("severity = ?"); binds.push(body.severity);
    }
    if (body.status !== undefined) {
      if (!VALID_STATUS.has(body.status ?? "")) return json({ success: false, error: "Invalid status" }, 400, origin);
      sets.push("status = ?"); binds.push(body.status);
      sets.push("closed_at = ?"); binds.push(body.status === "closed" ? new Date().toISOString() : null);
    }
    if (body.assigned_to !== undefined) {
      if (body.assigned_to) {
        // Validate the assignee is an active member of this org.
        const member = await env.DB.prepare(
          `SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
        ).bind(orgId, body.assigned_to).first();
        if (!member) return json({ success: false, error: "Assignee must be an active org member" }, 400, origin);
      }
      sets.push("assigned_to = ?"); binds.push(body.assigned_to || null);
    }

    if (sets.length === 0) return json({ success: false, error: "No changes provided" }, 400, origin);

    sets.push("updated_at = ?"); binds.push(new Date().toISOString());
    await env.DB.prepare(
      `UPDATE investigations SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`,
    ).bind(...binds, id, orgId).run();

    await audit(env, {
      action: "investigation_update", userId: ctx.userId,
      resourceType: "investigation", resourceId: id,
      details: { org_id: orgId, fields: sets.map((s) => s.split(" = ")[0]) },
      outcome: "success", request,
    });

    return json({ success: true, data: { id } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/orgs/:orgId/investigations/:id/items ──────────

export async function handleAddInvestigationItem(
  request: Request, env: Env, orgId: string, id: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);
  if (!canPerformHITL(ctx)) return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);

  try {
    const inv = await loadOwnedInvestigation(env, orgId, id);
    if (!inv) return json({ success: false, error: "Investigation not found" }, 404, origin);

    const body = await request.json() as ItemBody;
    if (!body.item_type || !VALID_ITEM_TYPE.has(body.item_type)) {
      return json({ success: false, error: "Invalid item_type" }, 400, origin);
    }
    if (!body.item_id) return json({ success: false, error: "item_id is required" }, 400, origin);

    // Confirm the linked item belongs to a brand the org owns, so a case
    // can't reference another tenant's data.
    const owned = await verifyItemOwnership(env, orgId, body.item_type, body.item_id);
    if (!owned) return json({ success: false, error: "Item not found in your organization" }, 404, origin);

    const itemId = crypto.randomUUID();
    const res = await env.DB.prepare(`
      INSERT OR IGNORE INTO investigation_items (id, investigation_id, item_type, item_id, note, added_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(itemId, id, body.item_type, body.item_id, body.note?.trim() || null, ctx.userId).run();

    // Touch the case so it sorts to the top of the list.
    await env.DB.prepare("UPDATE investigations SET updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id).run();

    await audit(env, {
      action: "investigation_item_add", userId: ctx.userId,
      resourceType: "investigation", resourceId: id,
      details: { org_id: orgId, item_type: body.item_type, item_id: body.item_id },
      outcome: "success", request,
    });

    const added = (res.meta?.changes ?? 0) > 0;
    return json({ success: true, data: { added } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// An item is in-scope when it (or its brand) belongs to the org.
async function verifyItemOwnership(env: Env, orgId: string, type: string, itemId: string): Promise<boolean> {
  if (type === "alert") {
    const r = await env.DB.prepare(`
      SELECT 1 FROM alerts a JOIN org_brands ob ON ob.brand_id = a.brand_id AND ob.org_id = ?
      WHERE a.id = ? LIMIT 1`).bind(orgId, itemId).first();
    return !!r;
  }
  if (type === "threat") {
    const r = await env.DB.prepare(`
      SELECT 1 FROM threats t JOIN org_brands ob ON ob.brand_id = t.target_brand_id AND ob.org_id = ?
      WHERE t.id = ? LIMIT 1`).bind(orgId, itemId).first();
    return !!r;
  }
  if (type === "takedown") {
    const r = await env.DB.prepare(
      "SELECT 1 FROM takedown_requests WHERE id = ? AND org_id = ? LIMIT 1",
    ).bind(itemId, orgId).first();
    return !!r;
  }
  return false;
}

// ─── DELETE /api/orgs/:orgId/investigations/:id/items/:itemId ─

export async function handleRemoveInvestigationItem(
  request: Request, env: Env, orgId: string, id: string, itemId: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);
  if (!canPerformHITL(ctx)) return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);

  try {
    const inv = await loadOwnedInvestigation(env, orgId, id);
    if (!inv) return json({ success: false, error: "Investigation not found" }, 404, origin);

    await env.DB.prepare(
      "DELETE FROM investigation_items WHERE id = ? AND investigation_id = ?",
    ).bind(itemId, id).run();

    await audit(env, {
      action: "investigation_item_remove", userId: ctx.userId,
      resourceType: "investigation", resourceId: id,
      details: { org_id: orgId, item_link_id: itemId },
      outcome: "success", request,
    });

    return json({ success: true, data: { id } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/orgs/:orgId/investigations/:id/notes ──────────

export async function handleAddInvestigationNote(
  request: Request, env: Env, orgId: string, id: string, ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessErr = verifyOrgAccess(ctx, orgId);
  if (accessErr) return json({ success: false, error: accessErr }, 403, origin);
  if (!canPerformHITL(ctx)) return json({ success: false, error: "Requires org role: analyst or higher" }, 403, origin);

  try {
    const inv = await loadOwnedInvestigation(env, orgId, id);
    if (!inv) return json({ success: false, error: "Investigation not found" }, 404, origin);

    const body = await request.json() as NoteBody;
    const text = (body.body ?? "").trim();
    if (!text) return json({ success: false, error: "Note body is required" }, 400, origin);

    const noteId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO investigation_notes (id, investigation_id, author_id, body) VALUES (?, ?, ?, ?)",
    ).bind(noteId, id, ctx.userId, text).run();

    await env.DB.prepare("UPDATE investigations SET updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id).run();

    await audit(env, {
      action: "investigation_note_add", userId: ctx.userId,
      resourceType: "investigation", resourceId: id,
      details: { org_id: orgId }, outcome: "success", request,
    });

    return json({ success: true, data: { id: noteId } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
