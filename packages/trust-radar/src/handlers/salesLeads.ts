// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Sales Leads Admin API — CRUD endpoints for Pathfinder-generated leads.
 */

import { json } from "../lib/cors";
import type { Env, UpdateSalesLeadBody } from "../types";
import { refreshLeadFirmographics } from "../db/sales-leads";
import { enrichBrandFirmographics } from "../lib/firmographic-enricher";

// ─── List all sales leads (paginated, filterable) ────────────────

export async function handleListSalesLeads(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const pitchAngle = url.searchParams.get("pitch_angle");
    const minScore = url.searchParams.get("min_score");
    const maxScore = url.searchParams.get("max_score");
    const sort = url.searchParams.get("sort") || "score";
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) { conditions.push("status = ?"); params.push(status); }
    if (pitchAngle) { conditions.push("pitch_angle = ?"); params.push(pitchAngle); }
    if (minScore) { conditions.push("prospect_score >= ?"); params.push(parseFloat(minScore)); }
    if (maxScore) { conditions.push("prospect_score <= ?"); params.push(parseFloat(maxScore)); }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const orderBy = sort === "date" ? "created_at DESC" : sort === "status" ? "status, prospect_score DESC" : "prospect_score DESC";

    const rows = await env.DB.prepare(
      `SELECT * FROM sales_leads${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    const total = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM sales_leads${where}`
    ).bind(...params).first<{ n: number }>();

    // Pipeline stats — status strings normalized in migration 0191 to match
    // what the UI actually sends (drafted / meeting, not outreach_drafted /
    // meeting_booked). Don't reintroduce the long forms here.
    const stats = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
        SUM(CASE WHEN status = 'researched' THEN 1 ELSE 0 END) as researched_count,
        SUM(CASE WHEN status = 'drafted' THEN 1 ELSE 0 END) as drafted_count,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_count,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
        SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) as responded_count,
        SUM(CASE WHEN status = 'meeting' THEN 1 ELSE 0 END) as meeting_count,
        SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted_count,
        SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) as declined_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
      FROM sales_leads
    `).first();

    return json({ success: true, data: { leads: rows.results, total: total?.n ?? 0, stats } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Get single lead detail ──────────────────────────────────────

export async function handleGetSalesLead(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const lead = await env.DB.prepare("SELECT * FROM sales_leads WHERE id = ?").bind(id).first();
    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);
    return json({ success: true, data: lead }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Update lead (edit outreach, notes, etc.) ────────────────────

export async function handleUpdateSalesLead(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as UpdateSalesLeadBody;
    const allowed: (keyof UpdateSalesLeadBody)[] = [
      "status", "notes", "outreach_variant_1", "outreach_variant_2",
      "outreach_selected", "outreach_channel", "target_name", "target_title",
      "target_email", "target_linkedin",
      // Manual override fields — a rep can correct AI snapshot data.
      "company_industry", "company_size", "company_hq", "security_maturity",
    ];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      if (body[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(body[key]);
      }
    }
    if (updates.length === 0) return json({ success: false, error: "No valid updates" }, 400, origin);

    updates.push("updated_at = datetime('now')");
    values.push(id);

    await env.DB.prepare(`UPDATE sales_leads SET ${updates.join(", ")} WHERE id = ?`).bind(...values).run();

    // Log activity
    await env.DB.prepare(
      "INSERT INTO lead_activity_log (lead_id, activity_type, details_json, performed_by, created_at) VALUES (?, 'updated', ?, 'admin', datetime('now'))"
    ).bind(id, JSON.stringify(body)).run();

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Status transition endpoints ─────────────────────────────────

async function transitionStatus(
  env: Env, id: string, newStatus: string,
  extraUpdates: string[] = [], extraValues: unknown[] = [],
  origin: string | null = null,
): Promise<Response> {
  try {
    const sets = [`status = ?`, `updated_at = datetime('now')`, ...extraUpdates];
    const vals = [newStatus, ...extraValues, id];
    await env.DB.prepare(`UPDATE sales_leads SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();

    await env.DB.prepare(
      "INSERT INTO lead_activity_log (lead_id, activity_type, details_json, performed_by, created_at) VALUES (?, ?, ?, 'admin', datetime('now'))"
    ).bind(id, `status_${newStatus}`, JSON.stringify({ new_status: newStatus })).run();

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleApproveLead(request: Request, env: Env, id: string): Promise<Response> {
  return transitionStatus(env, id, "approved", [], [], request.headers.get("Origin"));
}

export async function handleSendLead(request: Request, env: Env, id: string): Promise<Response> {
  return transitionStatus(env, id, "sent", ["outreach_sent_at = datetime('now')"], [], request.headers.get("Origin"));
}

export async function handleRespondLead(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { sentiment?: string };
    return transitionStatus(env, id, "responded",
      ["response_received_at = datetime('now')", "response_sentiment = ?"],
      [body.sentiment ?? "neutral"], origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export async function handleBookLead(request: Request, env: Env, id: string): Promise<Response> {
  // Status is the short canonical form 'meeting' (migration 0191). The
  // meeting_booked_at column name retains its historical spelling.
  return transitionStatus(env, id, "meeting", ["meeting_booked_at = datetime('now')"], [], request.headers.get("Origin"));
}

export async function handleConvertLead(request: Request, env: Env, id: string): Promise<Response> {
  return transitionStatus(env, id, "converted", [], [], request.headers.get("Origin"));
}

export async function handleDeclineLead(request: Request, env: Env, id: string): Promise<Response> {
  return transitionStatus(env, id, "declined", [], [], request.headers.get("Origin"));
}

export async function handleDeleteSalesLead(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    await env.DB.prepare("DELETE FROM lead_activity_log WHERE lead_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM sales_leads WHERE id = ?").bind(id).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Manual firmographic refresh ─────────────────────────────────
//
// Two-step refresh of a single lead's firmographic snapshot:
//   1. Re-run the SEC/Wikidata enricher against the brand to pull the
//      latest revenue/employee/ticker/breach data into brand_firmographics.
//   2. Copy the refreshed brand_firmographics row onto the sales_leads
//      snapshot columns so the UI shows the updated values.
//
// Cheap (no AI) — meant for the "Refresh" button on the lead detail
// card. The full AI re-enrichment is a separate endpoint that goes
// through Pathfinder's Haiku call.

export async function handleRefreshLeadFirmographics(
  request: Request, env: Env, id: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const lead = await env.DB.prepare(
      "SELECT brand_id, company_domain, company_name FROM sales_leads WHERE id = ?"
    ).bind(id).first<{ brand_id: string; company_domain: string | null; company_name: string | null }>();

    if (!lead) {
      return json({ success: false, error: "Lead not found" }, 404, origin);
    }

    // Step 1: refresh the source-of-truth firmographics row. Best-effort
    // — if every source returns null we still want to snapshot whatever
    // brand_firmographics already has.
    if (lead.company_domain && lead.company_name) {
      try {
        await enrichBrandFirmographics(env, lead.brand_id, lead.company_domain, lead.company_name);
      } catch {
        // Source failure is non-fatal; snapshot whatever we have.
      }
    }

    // Step 2: copy refreshed brand_firmographics row onto this lead.
    const updated = await refreshLeadFirmographics(env, parseInt(id, 10));

    await env.DB.prepare(
      "INSERT INTO lead_activity_log (lead_id, activity_type, details_json, performed_by, created_at) VALUES (?, 'firmographics_refreshed', ?, 'admin', datetime('now'))"
    ).bind(id, JSON.stringify({ updated })).run();

    return json({ success: true, data: { updated } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Activity log for a lead ─────────────────────────────────────

export async function handleLeadActivity(request: Request, env: Env, id: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM lead_activity_log WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50"
    ).bind(id).all();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── Pipeline stats ──────────────────────────────────────────────

export async function handleSalesLeadStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const pipeline = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
        SUM(CASE WHEN status = 'researched' THEN 1 ELSE 0 END) as researched_count,
        SUM(CASE WHEN status = 'drafted' THEN 1 ELSE 0 END) as drafted_count,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved_count,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_count,
        SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) as responded_count,
        SUM(CASE WHEN status = 'meeting' THEN 1 ELSE 0 END) as meeting_count,
        SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted_count,
        SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) as declined_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected_count
      FROM sales_leads
    `).first();

    const weekly = await env.DB.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as identified_7d,
        SUM(CASE WHEN outreach_sent_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as sent_7d,
        SUM(CASE WHEN response_received_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as responded_7d
      FROM sales_leads
    `).first();

    const stats = pipeline as { sent_count?: number; responded_count?: number; converted_count?: number } | null;
    const sentTotal = stats?.sent_count ?? 0;
    const respondedTotal = stats?.responded_count ?? 0;
    const convertedTotal = stats?.converted_count ?? 0;

    return json({
      success: true,
      data: {
        pipeline,
        weekly,
        response_rate: sentTotal > 0 ? Math.round((respondedTotal / sentTotal) * 100) : 0,
        conversion_rate: sentTotal > 0 ? Math.round((convertedTotal / sentTotal) * 100) : 0,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
