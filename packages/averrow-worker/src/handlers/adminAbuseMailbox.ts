// PR-AA — Averrow self abuse-mailbox admin surface
//
// Wraps the tenant abuse-mailbox handler with the synthetic
// `_averrow_platform` org id so /admin/abuse-mailbox in the ops UI
// can read Averrow's own captures (mail sent to the public
// abuse@/phishing@/report@/security@ aliases advertised on the
// marketing site) without anyone needing to know the magic id.
//
// The synthetic org is seeded by migration 0180. We resolve its id
// at request time via a slug lookup so the handler never depends on
// hardcoded numeric ids that drift between dev/staging/prod.
//
// Auth: super_admin only — these are platform-internal captures,
// not customer data.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import {
  handleGetAbuseMailboxModuleSummary,
  handleListAbuseInboxMessages,
  handleGetAbuseInboxMessageDetail,
  handleUpdateAbuseInboxMessageStatus,
  handleGetAbuseMailboxIntel,
} from "./tenantAbuseMailboxModule";

/** Reserved slug for the Averrow self-org. Seeded by migration 0180. */
export const AVERROW_SELF_ORG_SLUG = "_averrow_platform";

/**
 * Resolve the Averrow self-org id by slug. Returns null when the
 * migration hasn't been applied. Cached in-memory for the lifetime
 * of the worker invocation; CF Workers recycle the isolate frequently
 * enough that we don't need a longer-lived cache.
 */
let cachedSelfOrgId: number | null = null;
async function getAverrowSelfOrgId(env: Env): Promise<number | null> {
  if (cachedSelfOrgId !== null) return cachedSelfOrgId;
  const row = await env.DB.prepare(
    "SELECT id FROM organizations WHERE slug = ?",
  ).bind(AVERROW_SELF_ORG_SLUG).first<{ id: number }>();
  if (row?.id) {
    cachedSelfOrgId = row.id;
    return cachedSelfOrgId;
  }
  return null;
}

/**
 * GET /api/admin/abuse-mailbox
 *
 * Same payload shape as the tenant `/api/orgs/:orgId/modules/abuse-mailbox`
 * endpoint, hardcoded to the Averrow self-org. Super_admin only.
 */
export async function handleAdminAbuseMailboxSummary(
  request: Request,
  env:     Env,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "super_admin required" }, 403, origin);
  }
  const selfOrgId = await getAverrowSelfOrgId(env);
  if (selfOrgId === null) {
    return json({
      success: false,
      error: "Averrow self-org not provisioned — run migration 0180_averrow_self_abuse_mailbox.sql",
      code: "SELF_ORG_NOT_PROVISIONED",
    }, 503, origin);
  }
  // Delegate to the tenant handler. Pass super_admin ctx unchanged so
  // its entitlement check is skipped.
  return handleGetAbuseMailboxModuleSummary(request, env, String(selfOrgId), ctx);
}

/**
 * GET /api/admin/abuse-mailbox/messages
 *
 * Same payload shape as `/api/orgs/:orgId/modules/abuse-mailbox/messages`,
 * scoped to the Averrow self-org. Super_admin only.
 */
export async function handleAdminAbuseMailboxMessages(
  request: Request,
  env:     Env,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "super_admin required" }, 403, origin);
  }
  const selfOrgId = await getAverrowSelfOrgId(env);
  if (selfOrgId === null) {
    return json({
      success: false,
      error: "Averrow self-org not provisioned — run migration 0180_averrow_self_abuse_mailbox.sql",
      code: "SELF_ORG_NOT_PROVISIONED",
    }, 503, origin);
  }
  return handleListAbuseInboxMessages(request, env, String(selfOrgId), ctx);
}

/**
 * GET /api/admin/abuse-mailbox/messages/:id
 *
 * Per-message detail with raw body / headers / URL list / attachment
 * filenames (PR-AS). Same payload shape as the tenant detail endpoint,
 * scoped to the Averrow self-org. Super_admin only.
 */
export async function handleAdminAbuseMailboxMessageDetail(
  request:   Request,
  env:       Env,
  messageId: string,
  ctx:       AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "super_admin required" }, 403, origin);
  }
  const selfOrgId = await getAverrowSelfOrgId(env);
  if (selfOrgId === null) {
    return json({
      success: false,
      error: "Averrow self-org not provisioned — run migration 0180_averrow_self_abuse_mailbox.sql",
      code: "SELF_ORG_NOT_PROVISIONED",
    }, 503, origin);
  }
  return handleGetAbuseInboxMessageDetail(request, env, String(selfOrgId), messageId, ctx);
}

/**
 * PATCH /api/admin/abuse-mailbox/messages/:id/status
 * PR-BD — status transition wrapper for the Averrow self-org.
 */
export async function handleAdminAbuseMailboxMessageStatusUpdate(
  request:   Request,
  env:       Env,
  messageId: string,
  ctx:       AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "super_admin required" }, 403, origin);
  }
  const selfOrgId = await getAverrowSelfOrgId(env);
  if (selfOrgId === null) {
    return json({
      success: false,
      error: "Averrow self-org not provisioned",
      code: "SELF_ORG_NOT_PROVISIONED",
    }, 503, origin);
  }
  return handleUpdateAbuseInboxMessageStatus(request, env, String(selfOrgId), messageId, ctx);
}

/**
 * PATCH /api/admin/abuse-mailbox/messages/bulk-status
 * Bulk triage — same self-org resolution as the single-message path.
 */
export async function handleAdminAbuseMailboxBulkStatusUpdate(
  request: Request,
  env:     Env,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "super_admin required" }, 403, origin);
  }
  const selfOrgId = await getAverrowSelfOrgId(env);
  if (selfOrgId === null) {
    return json({
      success: false,
      error: "Averrow self-org not provisioned",
      code: "SELF_ORG_NOT_PROVISIONED",
    }, 503, origin);
  }
  const { handleBulkUpdateAbuseInboxMessageStatus } = await import("./tenantAbuseMailboxModule");
  return handleBulkUpdateAbuseInboxMessageStatus(request, env, String(selfOrgId), ctx);
}

/**
 * GET /api/admin/abuse-mailbox/intel
 * PR-BD — Intel summary aggregated over deep_analysis rows.
 */
export async function handleAdminAbuseMailboxIntel(
  request: Request,
  env:     Env,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (ctx.role !== "super_admin") {
    return json({ success: false, error: "super_admin required" }, 403, origin);
  }
  const selfOrgId = await getAverrowSelfOrgId(env);
  if (selfOrgId === null) {
    return json({
      success: false,
      error: "Averrow self-org not provisioned",
      code: "SELF_ORG_NOT_PROVISIONED",
    }, 503, origin);
  }
  return handleGetAbuseMailboxIntel(request, env, String(selfOrgId), ctx);
}
