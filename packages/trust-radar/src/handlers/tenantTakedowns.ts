// Averrow — tenant-facing takedowns surface
//
// Customer-facing read of takedown_requests + takedown_submissions
// scoped to the caller's org. Two endpoints:
//
//   GET /api/orgs/:orgId/takedowns
//     List takedowns for the org. Optional filters:
//       ?status=  (draft | submitted | taken_down | failed | …)
//       ?module=  (domain | social | app_store | dark_web | …)
//       ?brandId= (must belong to the caller's org)
//     Capped at 200 rows, ordered status-priority then created_at desc.
//
//   GET /api/orgs/:orgId/takedowns/:takedownId
//     Single takedown with full submission audit trail
//     (takedown_submissions rows ordered most-recent first).
//
// No new schema — rides what Phase C C1-C3 already built. The
// org-scope filter (org_id = orgIdNum) is the source of truth for
// tenant isolation; super_admin bypasses to support cross-tenant
// staff workflows.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

export interface TakedownListRow {
  id:                     string;
  org_id:                 number | null;
  brand_id:               string;
  brand_name:             string | null;
  module_key:             string | null;
  target_type:            string;
  target_value:           string;
  target_url:             string | null;
  status:                 string;
  severity:               string;
  provider_name:          string | null;
  provider_method:        string | null;
  evidence_summary:       string;
  submitted_at:           string | null;
  resolved_at:            string | null;
  resolution:             string | null;
  created_at:             string;
  submission_count:       number;
}

const STATUS_PRIORITY = [
  "draft",
  "requested",
  "submitted",
  "pending_response",
  "taken_down",
  "failed",
  "expired",
] as const;

// ─── GET /api/orgs/:orgId/takedowns ─────────────────────────────

export async function handleListTenantTakedowns(
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

  const url = new URL(request.url);
  const statusParam  = url.searchParams.get("status");
  const moduleParam  = url.searchParams.get("module");
  const brandIdParam = url.searchParams.get("brandId");

  // Brand-ownership check for non-admins when ?brandId= is filtered.
  if (brandIdParam && ctx.role !== "super_admin") {
    const brandOk = await env.DB.prepare(
      `SELECT b.id FROM brands b
       JOIN org_brands ob ON ob.brand_id = b.id
       WHERE b.id = ? AND ob.org_id = ?`,
    ).bind(brandIdParam, orgIdNum).first<{ id: string }>();
    if (!brandOk) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }
  }

  const LIMIT = 200;

  // Build the WHERE dynamically based on filters; bind args parallel.
  // Status priority via CASE so 'draft' / 'submitted' surface above
  // resolved/expired by default.
  const whereClauses: string[] = ["tr.org_id = ?"];
  const binds: unknown[]       = [orgIdNum];
  if (statusParam)  { whereClauses.push("tr.status = ?");      binds.push(statusParam); }
  if (moduleParam)  { whereClauses.push("tr.module_key = ?");  binds.push(moduleParam); }
  if (brandIdParam) { whereClauses.push("tr.brand_id = ?");    binds.push(brandIdParam); }

  binds.push(LIMIT);

  const result = await env.DB.prepare(
    `SELECT tr.id, tr.org_id, tr.brand_id, b.name AS brand_name,
            tr.module_key, tr.target_type, tr.target_value, tr.target_url,
            tr.status, tr.severity, tr.provider_name, tr.provider_method,
            tr.evidence_summary, tr.submitted_at, tr.resolved_at,
            tr.resolution, tr.created_at,
            (SELECT COUNT(*) FROM takedown_submissions ts WHERE ts.takedown_id = tr.id) AS submission_count
     FROM takedown_requests tr
     LEFT JOIN brands b ON b.id = tr.brand_id
     WHERE ${whereClauses.join(" AND ")}
     ORDER BY
       CASE tr.status
         WHEN 'draft'            THEN 1
         WHEN 'requested'        THEN 2
         WHEN 'submitted'        THEN 3
         WHEN 'pending_response' THEN 4
         WHEN 'taken_down'       THEN 5
         WHEN 'failed'           THEN 6
         WHEN 'expired'          THEN 7
         ELSE 8
       END,
       tr.created_at DESC
     LIMIT ?`,
  ).bind(...binds).all<TakedownListRow>();

  const takedowns = result.results ?? [];

  // Tally by status for the headline cards in averrow-tenant.
  const byStatus: Record<string, number> = {};
  for (const t of takedowns) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }

  return json({
    success: true,
    data: {
      org_id:    orgIdNum,
      takedowns,
      page_size: LIMIT,
      totals: {
        total:                  takedowns.length,
        by_status:              byStatus,
        active:                 (byStatus["draft"]      ?? 0)
                              + (byStatus["requested"]  ?? 0)
                              + (byStatus["submitted"]  ?? 0)
                              + (byStatus["pending_response"] ?? 0),
        completed:              byStatus["taken_down"]  ?? 0,
        failed_or_expired:      (byStatus["failed"]     ?? 0)
                              + (byStatus["expired"]   ?? 0),
      },
      status_priority: STATUS_PRIORITY,
    },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/takedowns/:takedownId ─────────────────

export interface TakedownDetailRow extends TakedownListRow {
  source_type:            string | null;
  source_id:              string | null;
  evidence_detail:        string | null;
  evidence_urls:          string | null;
  screenshot_url:         string | null;
  provider_abuse_contact: string | null;
  priority_score:         number;
  requested_at:           string | null;
  response_received_at:   string | null;
  response_notes:         string | null;
  notes:                  string | null;
  updated_at:             string;
}

export interface TakedownSubmissionAuditRow {
  id:                string;
  takedown_id:       string;
  provider_id:       number | null;
  submitter_kind:    string;
  submitter_target:  string | null;
  request_summary:   string | null;
  outcome:           string;
  response_status:   number | null;
  response_body:     string | null;
  ticket_id:         string | null;
  error_message:     string | null;
  attempted_at:      string;
  duration_ms:       number | null;
}

export async function handleGetTenantTakedownDetail(
  request:    Request,
  env:        Env,
  orgId:      string,
  takedownId: string,
  ctx:        AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  // For non-admins, ownership is enforced via tr.org_id = ?.
  // super_admin reads any takedown.
  const takedown = ctx.role === "super_admin"
    ? await env.DB.prepare(
        `SELECT tr.*, b.name AS brand_name,
                (SELECT COUNT(*) FROM takedown_submissions ts WHERE ts.takedown_id = tr.id) AS submission_count
         FROM takedown_requests tr
         LEFT JOIN brands b ON b.id = tr.brand_id
         WHERE tr.id = ?`,
      ).bind(takedownId).first<TakedownDetailRow>()
    : await env.DB.prepare(
        `SELECT tr.*, b.name AS brand_name,
                (SELECT COUNT(*) FROM takedown_submissions ts WHERE ts.takedown_id = tr.id) AS submission_count
         FROM takedown_requests tr
         LEFT JOIN brands b ON b.id = tr.brand_id
         WHERE tr.id = ? AND tr.org_id = ?`,
      ).bind(takedownId, orgIdNum).first<TakedownDetailRow>();

  if (!takedown) {
    return json({ success: false, error: "Takedown not found" }, 404, origin);
  }

  const submissions = await env.DB.prepare(
    `SELECT id, takedown_id, provider_id, submitter_kind, submitter_target,
            request_summary, outcome, response_status, response_body,
            ticket_id, error_message, attempted_at, duration_ms
     FROM takedown_submissions
     WHERE takedown_id = ?
     ORDER BY attempted_at DESC
     LIMIT 100`,
  ).bind(takedownId).all<TakedownSubmissionAuditRow>();

  return json({
    success: true,
    data: {
      takedown,
      submissions: submissions.results,
    },
  }, 200, origin);
}
