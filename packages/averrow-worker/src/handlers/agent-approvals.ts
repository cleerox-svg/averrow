/**
 * Admin endpoints for the AGENT_STANDARD §12.1 deployment-approval
 * flow. Phase 5.4a — endpoints only; the runner integration that
 * creates pending rows on first run + the /agents/:id/review UI
 * land in Phase 5.4b.
 *
 * Routes (all super_admin gated):
 *   GET  /api/admin/agents/approvals/pending
 *        → list all rows currently in 'pending' or 'changes_requested'
 *   GET  /api/admin/agents/approvals/:id
 *        → single approval row (or 404)
 *   GET  /api/admin/agents/approvals/:id/review-bundle
 *        → approval row + last 10 agent_runs + last 10 agent_outputs
 *   POST /api/admin/agents/approvals/:id/approve
 *        body { notes?: string }
 *        → flips pending|changes_requested → approved
 *   POST /api/admin/agents/approvals/:id/reject
 *        body { notes: string }   (>=5 chars required)
 *        → flips pending|changes_requested|approved → rejected
 *   POST /api/admin/agents/approvals/:id/request-changes
 *        body { notes: string }   (>=5 chars required)
 *        → flips pending → changes_requested
 */

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import {
  approve as approveDeployment,
  reject as rejectDeployment,
  requestChanges,
  listPending as libListPending,
  getApprovalState,
  getReviewBundle as libGetReviewBundle,
} from "../lib/agent-approvals";
import type { Env } from "../types";

export async function handleListPendingApprovals(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await libListPending(env.DB);
    return json({ success: true, data: { pending: rows, total: rows.length } }, 200, origin);
  } catch (err) {
    return json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      500,
      origin,
    );
  }
}

export async function handleGetApproval(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!agentId) return json({ success: false, error: "missing agent_id" }, 400, origin);
  try {
    const row = await getApprovalState(env.DB, agentId);
    if (!row) return json({ success: false, error: `no approval row for ${agentId}` }, 404, origin);
    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    return json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      500,
      origin,
    );
  }
}

export async function handleGetReviewBundle(
  request: Request,
  env: Env,
  agentId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!agentId) return json({ success: false, error: "missing agent_id" }, 400, origin);
  try {
    const bundle = await libGetReviewBundle(env.DB, agentId);
    if (!bundle.approval) {
      return json(
        { success: false, error: `no approval row for ${agentId}` },
        404,
        origin,
      );
    }
    return json({ success: true, data: bundle }, 200, origin);
  } catch (err) {
    return json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      500,
      origin,
    );
  }
}

export async function handleApproveAgent(
  request: Request,
  env: Env,
  agentId: string,
  reviewerId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!agentId) return json({ success: false, error: "missing agent_id" }, 400, origin);
  let body: { notes?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { /* empty body OK on approve */ }
  const notes = typeof body.notes === "string" ? body.notes : null;
  try {
    const row = await approveDeployment(env.DB, agentId, reviewerId, notes);
    await audit(env, {
      action: "agent_approval_approved",
      userId: reviewerId,
      resourceType: "agent",
      resourceId: agentId,
      details: { notes_present: notes !== null && notes.length > 0 },
      request,
    });
    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no pending approval row/i.test(msg)) {
      return json({ success: false, error: msg }, 404, origin);
    }
    return json({ success: false, error: msg }, 500, origin);
  }
}

export async function handleRejectAgent(
  request: Request,
  env: Env,
  agentId: string,
  reviewerId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!agentId) return json({ success: false, error: "missing agent_id" }, 400, origin);
  let body: { notes?: unknown } = {};
  try { body = await request.json() as typeof body; } catch {
    return json({ success: false, error: "JSON body required with notes field" }, 400, origin);
  }
  const notes = typeof body.notes === "string" ? body.notes : "";
  try {
    const row = await rejectDeployment(env.DB, agentId, reviewerId, notes);
    await audit(env, {
      action: "agent_approval_rejected",
      userId: reviewerId,
      resourceType: "agent",
      resourceId: agentId,
      details: { notes_length: notes.length },
      request,
    });
    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/notes is required|no row found/i.test(msg)) {
      return json({ success: false, error: msg }, /notes/i.test(msg) ? 400 : 404, origin);
    }
    return json({ success: false, error: msg }, 500, origin);
  }
}

export async function handleRequestChangesAgent(
  request: Request,
  env: Env,
  agentId: string,
  reviewerId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!agentId) return json({ success: false, error: "missing agent_id" }, 400, origin);
  let body: { notes?: unknown } = {};
  try { body = await request.json() as typeof body; } catch {
    return json({ success: false, error: "JSON body required with notes field" }, 400, origin);
  }
  const notes = typeof body.notes === "string" ? body.notes : "";
  try {
    const row = await requestChanges(env.DB, agentId, reviewerId, notes);
    await audit(env, {
      action: "agent_approval_changes_requested",
      userId: reviewerId,
      resourceType: "agent",
      resourceId: agentId,
      details: { notes_length: notes.length },
      request,
    });
    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/notes is required|no pending row/i.test(msg)) {
      return json({ success: false, error: msg }, /notes/i.test(msg) ? 400 : 404, origin);
    }
    return json({ success: false, error: msg }, 500, origin);
  }
}
