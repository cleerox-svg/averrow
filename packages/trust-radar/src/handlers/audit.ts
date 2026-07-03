// Averrow — Audit Log Viewer (Admin)

import { json } from "../lib/cors";
import type { Env } from "../types";

// GET /api/admin/audit
export async function handleListAuditLog(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(200, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
    const userId = url.searchParams.get("user_id");
    const action = url.searchParams.get("action");
    const resourceType = url.searchParams.get("resource_type");
    const outcome = url.searchParams.get("outcome");
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const window = url.searchParams.get("window");
    const search = url.searchParams.get("search");

    const conditions: string[] = [];
    const params: unknown[] = [];

    // window shorthand: 24h, 7d, 30d, all
    if (window && !since) {
      const days = window === "24h" ? 1 : window === "30d" ? 30 : window === "all" ? 3650 : 7;
      conditions.push("timestamp >= datetime('now', ?)");
      params.push(`-${days} days`);
    }

    if (userId) { conditions.push("user_id = ?"); params.push(userId); }
    if (action) { conditions.push("action = ?"); params.push(action); }
    if (resourceType) { conditions.push("resource_type = ?"); params.push(resourceType); }
    if (outcome) { conditions.push("outcome = ?"); params.push(outcome); }
    if (since) { conditions.push("timestamp >= ?"); params.push(since); }
    if (until) { conditions.push("timestamp <= ?"); params.push(until); }
    if (search) {
      conditions.push("(action LIKE ? OR ip_address LIKE ? OR resource_type LIKE ? OR user_id LIKE ?)");
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countParams = [...params];
    params.push(limit, offset);

    // Aggregates + filter options computed over the FULL filtered set, not
    // the returned page — the UI's stat cards and resource-type dropdown
    // previously derived from the visible 50 rows, so they under-reported
    // and shifted as the operator paginated.
    const [rows, total, stats, resourceTypes] = await Promise.all([
      env.AUDIT_DB.prepare(
        `SELECT id, timestamp, user_id, action, resource_type, resource_id, details, ip_address, user_agent, outcome
         FROM audit_log ${where}
         ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      ).bind(...params).all(),
      env.AUDIT_DB.prepare(`SELECT COUNT(*) AS n FROM audit_log ${where}`)
        .bind(...countParams).first<{ n: number }>(),
      env.AUDIT_DB.prepare(
        `SELECT
           SUM(CASE WHEN timestamp >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS today,
           SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END)                    AS failures,
           SUM(CASE WHEN outcome = 'denied'  THEN 1 ELSE 0 END)                    AS denied,
           COUNT(DISTINCT action)                                                  AS unique_actions
         FROM audit_log ${where}`,
      ).bind(...countParams).first<{ today: number; failures: number; denied: number; unique_actions: number }>(),
      env.AUDIT_DB.prepare(
        `SELECT DISTINCT resource_type FROM audit_log ${where}
          ORDER BY resource_type LIMIT 100`,
      ).bind(...countParams).all<{ resource_type: string | null }>(),
    ]);

    return json({
      success: true,
      data: rows.results,
      total: total?.n ?? 0,
      stats: {
        today:          stats?.today          ?? 0,
        failures:       stats?.failures       ?? 0,
        denied:         stats?.denied         ?? 0,
        unique_actions: stats?.unique_actions ?? 0,
      },
      resource_types: (resourceTypes.results ?? [])
        .map(r => r.resource_type)
        .filter((v): v is string => !!v),
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/admin/audit/export (CSV)
export async function handleExportAuditLog(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const since = url.searchParams.get("since") ?? new Date(Date.now() - 30 * 86400000).toISOString();
    const until = url.searchParams.get("until") ?? new Date().toISOString();

    const rows = await env.AUDIT_DB.prepare(
      `SELECT timestamp, user_id, action, resource_type, resource_id, outcome, ip_address, details
       FROM audit_log
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp DESC
       LIMIT 10000`,
    ).bind(since, until).all();

    const header = "timestamp,user_id,action,resource_type,resource_id,outcome,ip_address,details\n";
    const csvRows = rows.results.map((r: Record<string, unknown>) =>
      [r.timestamp, r.user_id, r.action, r.resource_type, r.resource_id, r.outcome, r.ip_address, `"${String(r.details ?? "").replace(/"/g, '""')}"`].join(","),
    );

    return new Response(header + csvRows.join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="audit-log-${since.slice(0, 10)}.csv"`,
      },
    });
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, request.headers.get("Origin"));
  }
}
