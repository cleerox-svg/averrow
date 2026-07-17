// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import type { Env, CreateTicketBody, UpdateTicketBody, AddEvidenceBody, CreateErasureBody, UpdateErasureBody } from "../types";

// ─── Investigation Tickets ──────────────────────────────────────

export async function handleListTickets(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const status = url.searchParams.get("status");
    const severity = url.searchParams.get("severity");

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status) { conditions.push("status = ?"); params.push(status); }
    if (severity) { conditions.push("severity = ?"); params.push(severity); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = await env.DB.prepare(
      `SELECT id, ticket_id, title, severity, status, priority, category, assignee_id,
              tags, sla_due_at, created_by, created_at, updated_at
       FROM investigation_tickets ${where} ORDER BY created_at DESC LIMIT ?`
    ).bind(...params).all();

    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical
      FROM investigation_tickets
    `).first();

    return json({ success: true, data: { tickets: rows.results, stats } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleGetTicket(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const ticket = await env.DB.prepare("SELECT * FROM investigation_tickets WHERE id = ?").bind(id).first();
    if (!ticket) return json({ success: false, error: "Ticket not found" }, 404, origin);

    const evidence = await env.DB.prepare(
      "SELECT id, capture_type, target_url, captured_by, captured_at FROM evidence_captures WHERE ticket_id = ? ORDER BY created_at DESC"
    ).bind(id).all();

    const erasures = await env.DB.prepare(
      "SELECT id, target_type, target_value, provider, status, method, submitted_at, resolved_at FROM erasure_actions WHERE ticket_id = ? ORDER BY created_at DESC"
    ).bind(id).all();

    return json({ success: true, data: { ticket, evidence: evidence.results, erasures: erasures.results } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleCreateTicket(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as CreateTicketBody;
    const id = crypto.randomUUID();

    // Generate sequential ticket ID
    const last = await env.DB.prepare(
      "SELECT ticket_id FROM investigation_tickets ORDER BY created_at DESC LIMIT 1"
    ).first<{ ticket_id: string }>();
    const seq = last ? parseInt(last.ticket_id.replace("LRX-", ""), 10) + 1 : 1;
    const ticketId = `LRX-${String(seq).padStart(5, "0")}`;

    await env.DB.prepare(
      `INSERT INTO investigation_tickets (id, ticket_id, title, description, severity, status, priority, category, tags, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      id, ticketId, body.title ?? "Untitled Investigation", body.description ?? null,
      body.severity ?? "medium", body.priority ?? "normal", body.category ?? "general",
      JSON.stringify(body.tags ?? []), userId,
    ).run();

    return json({ success: true, data: { id, ticketId } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleUpdateTicket(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as UpdateTicketBody;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status) { updates.push("status = ?"); values.push(body.status); }
    if (body.severity) { updates.push("severity = ?"); values.push(body.severity); }
    if (body.priority) { updates.push("priority = ?"); values.push(body.priority); }
    if (body.assignee_id) { updates.push("assignee_id = ?"); values.push(body.assignee_id); }
    if (body.notes) { updates.push("notes = ?"); values.push(body.notes); }
    if (body.resolution) { updates.push("resolution = ?"); values.push(body.resolution); }

    if (updates.length === 0) return json({ success: false, error: "No valid fields" }, 400, origin);

    updates.push("updated_at = datetime('now')");
    if (body.status === "resolved") updates.push("resolved_at = datetime('now')");
    if (body.status === "closed") updates.push("closed_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(`UPDATE investigation_tickets SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Evidence Attachment ─────────────────────────────────────────

export async function handleAddEvidence(request: Request, env: Env, ticketId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const ticket = await env.DB.prepare("SELECT id FROM investigation_tickets WHERE id = ?").bind(ticketId).first();
    if (!ticket) return json({ success: false, error: "Ticket not found" }, 404, origin);

    const body = await request.json() as AddEvidenceBody;
    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO evidence_captures (id, ticket_id, capture_type, target_url, content_hash, storage_path, metadata_json, captured_by, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).bind(
      id,
      ticketId,
      body.capture_type ?? "screenshot",
      body.target_url ?? null,
      body.content_hash ?? null,
      body.storage_path ?? null,
      JSON.stringify(body.metadata ?? {}),
      userId,
    ).run();

    return json({ success: true, data: { id } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Erasure Actions (Takedowns) ────────────────────────────────

export async function handleListErasures(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const status = url.searchParams.get("status");

    let query = `SELECT id, ticket_id, target_type, target_value, provider, provider_email,
                        method, status, submitted_at, acknowledged_at, resolved_at, created_by, created_at
                 FROM erasure_actions`;
    const params: unknown[] = [];
    if (status) { query += " WHERE status = ?"; params.push(status); }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const rows = await env.DB.prepare(query).bind(...params).all();

    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) as acknowledged,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM erasure_actions
    `).first();

    return json({ success: true, data: { erasures: rows.results, stats } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleCreateErasure(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as CreateErasureBody;
    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO erasure_actions (id, ticket_id, target_type, target_value, provider, provider_email, method, status, abuse_notice, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      id, body.ticket_id ?? null, body.target_type ?? "domain", body.target_value ?? "",
      body.provider ?? "", body.provider_email ?? null, body.method ?? "email",
      body.abuse_notice ?? null, userId,
    ).run();

    return json({ success: true, data: { id } }, 201, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleUpdateErasure(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as UpdateErasureBody;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.status) {
      updates.push("status = ?"); values.push(body.status);
      if (body.status === "submitted") updates.push("submitted_at = datetime('now')");
      if (body.status === "acknowledged") updates.push("acknowledged_at = datetime('now')");
      if (body.status === "resolved") updates.push("resolved_at = datetime('now')");
    }
    if (body.response) { updates.push("response = ?"); values.push(body.response); }

    if (updates.length === 0) return json({ success: false, error: "No valid fields" }, 400, origin);
    updates.push("updated_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(`UPDATE erasure_actions SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

