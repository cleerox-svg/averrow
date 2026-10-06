/**
 * Staff view of marketing contact/demo form submissions (DISCLOSURE_REGISTER G33).
 *
 *   GET   /api/admin/contact-submissions        list, newest first, paginated
 *   PATCH /api/admin/contact-submissions/:id    mark handled / reopen
 *
 * Both are gated with requireSales at the route (routes/admin.ts), the same
 * guard as the /api/admin/sales-leads lifecycle: prospect data has no
 * permission flag in lib/role-permissions.ts.
 *
 * `ip_address` is never selected (it is always NULL since migration 0287).
 */
import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { getDbContext, getReadSession } from "../lib/db";
import { logger } from "../lib/logger";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";

export const CONTACT_LIST_MAX_LIMIT = 100;
const CONTACT_LIST_DEFAULT_LIMIT = 50;

const LIST_COLUMNS = `id, name, email, company, company_size, interest, domain, message,
  created_at, notified_at, notify_status, handled_at, handled_by`;

export interface ContactSubmissionRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  company_size: string | null;
  interest: string | null;
  domain: string | null;
  message: string;
  created_at: string;
  notified_at: string | null;
  notify_status: string | null;
  handled_at: string | null;
  handled_by: string | null;
}

function parseIntParam(raw: string | null, fallback: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function handleListContactSubmissions(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(
      CONTACT_LIST_MAX_LIMIT,
      Math.max(1, parseIntParam(url.searchParams.get("limit"), CONTACT_LIST_DEFAULT_LIMIT)),
    );
    const offset = Math.max(0, parseIntParam(url.searchParams.get("offset"), 0));
    const status = url.searchParams.get("status") ?? "all";
    if (status !== "all" && status !== "open" && status !== "handled") {
      return json({ success: false, error: "status must be one of: all, open, handled" }, 400, origin);
    }
    // Fixed fragments only — no caller text is interpolated.
    const where = status === "open"
      ? " WHERE handled_at IS NULL"
      : status === "handled"
        ? " WHERE handled_at IS NOT NULL"
        : "";

    const session = getReadSession(env, getDbContext(request));
    const [rows, total] = await Promise.all([
      session.prepare(
        `SELECT ${LIST_COLUMNS} FROM contact_submissions${where}
          ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).bind(limit, offset).all<ContactSubmissionRow>(),
      // Small table (marketing form volume), not threats — a plain count is fine.
      session.prepare(`SELECT COUNT(*) AS n FROM contact_submissions${where}`).first<{ n: number }>(),
    ]);

    return json(
      { success: true, data: rows.results ?? [], total: total?.n ?? 0, limit, offset },
      200,
      origin,
    );
  } catch (err) {
    logger.error("contact-submissions-list-failed", { error: err instanceof Error ? err.message : String(err) });
    return json({ success: false, error: "Failed to load contact submissions" }, 500, origin);
  }
}

export async function handleUpdateContactSubmission(
  request: Request,
  env: Env,
  ctx: AuthContext,
  id: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (!id) return json({ success: false, error: "Missing id" }, 400, origin);
    const raw: unknown = await request.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return json({ success: false, error: "Invalid request body" }, 400, origin);
    }
    const handled = (raw as Record<string, unknown>).handled;
    if (typeof handled !== "boolean") {
      return json({ success: false, error: "`handled` must be true or false" }, 400, origin);
    }

    // Each UPDATE matches only a row whose state actually changes, so
    // `changes` says whether anything happened: re-marking a handled row (or
    // reopening an open one) is a no-op that writes no audit row.
    const result = handled
      ? await env.DB.prepare(
          `UPDATE contact_submissions
              SET handled_at = datetime('now'), handled_by = ?
            WHERE id = ? AND handled_at IS NULL`,
        ).bind(ctx.userId, id).run()
      : await env.DB.prepare(
          `UPDATE contact_submissions SET handled_at = NULL, handled_by = NULL
            WHERE id = ? AND handled_at IS NOT NULL`,
        ).bind(id).run();
    const changed = (result.meta?.changes ?? 0) > 0;

    if (changed) {
      await audit(env, {
        action: handled ? "contact_submission_handled" : "contact_submission_reopened",
        userId: ctx.userId,
        resourceType: "contact_submission",
        resourceId: id,
        request,
      });
    }

    const row = await env.DB.prepare(
      `SELECT ${LIST_COLUMNS} FROM contact_submissions WHERE id = ?`,
    ).bind(id).first<ContactSubmissionRow>();
    if (!row) {
      return json({ success: false, error: "Submission not found" }, 404, origin);
    }
    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    logger.error("contact-submission-update-failed", {
      submissionId: id,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ success: false, error: "Failed to update contact submission" }, 500, origin);
  }
}
