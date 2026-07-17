// Averrow — Audit Logging (append-only to AUDIT_DB)

import type { Env, AuditOutcome } from "../types";

export interface AuditEntry {
  action: string;
  userId?: string | null;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  outcome?: AuditOutcome;
  request?: Request;
}

/**
 * Append an audit log entry to the AUDIT_DB.
 * Fire-and-forget — failures are logged to console but never block the caller.
 */
export async function audit(env: Env, entry: AuditEntry): Promise<void> {
  try {
    const id = crypto.randomUUID();
    const ip = entry.request?.headers.get("CF-Connecting-IP")
      ?? entry.request?.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
      ?? null;
    const ua = entry.request?.headers.get("User-Agent") ?? null;

    await env.AUDIT_DB.prepare(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address, user_agent, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        entry.userId ?? null,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        entry.details ? JSON.stringify(entry.details) : null,
        ip,
        ua,
        entry.outcome ?? "success",
      )
      .run();
  } catch (err) {
    console.error("[audit] failed to write:", err);
  }
}
