// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { corsHeaders } from "../lib/cors";
import type { Env } from "../types";

function csvResponse(csv: string, filename: string, origin: string | null): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...corsHeaders(origin),
    },
  });
}

function escapeCSV(val: unknown): string {
  const str = String(val ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCSV(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => escapeCSV(r[c])).join(",")).join("\n");
  return `${header}\n${body}`;
}

// ─── Export Scan History ──────────────────────────────────────
export async function handleExportScans(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(1000, parseInt(url.searchParams.get("limit") ?? "500", 10));

  try {
    const rows = await env.DB.prepare(
      `SELECT id, url, domain, trust_score, risk_level, source, created_at
       FROM scans WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(userId, limit).all();

    const csv = toCSV(
      ["id", "url", "domain", "trust_score", "risk_level", "source", "created_at"],
      rows.results,
    );
    return csvResponse(csv, `scans-export-${Date.now()}.csv`, origin);
  } catch {
    return csvResponse("Error exporting data", "error.csv", origin);
  }
}

// ─── Export Signals ───────────────────────────────────────────
export async function handleExportSignals(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(1000, parseInt(url.searchParams.get("limit") ?? "500", 10));

  try {
    const rows = await env.DB.prepare(
      `SELECT id, url, domain, trust_score, risk_level, source, created_at
       FROM scans ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();

    const csv = toCSV(
      ["id", "url", "domain", "trust_score", "risk_level", "source", "created_at"],
      rows.results,
    );
    return csvResponse(csv, `signals-export-${Date.now()}.csv`, origin);
  } catch {
    return csvResponse("Error exporting data", "error.csv", origin);
  }
}

// ─── Export Alerts ────────────────────────────────────────────
export async function handleExportAlerts(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const rows = await env.DB.prepare(
      `SELECT id, source, scan_ref, quality, status, created_at
       FROM signal_alerts ORDER BY created_at DESC LIMIT 500`
    ).all().catch(() => ({ results: [] as Record<string, unknown>[], success: true as const, meta: {} as D1Meta }));

    // Fallback: export high-risk scans as alerts
    if (rows.results.length === 0) {
      const scanRows = await env.DB.prepare(
        `SELECT id, domain, trust_score as quality, source, 'open' as status, created_at
         FROM scans WHERE risk_level IN ('critical', 'high')
         ORDER BY created_at DESC LIMIT 500`
      ).all();
      const csv = toCSV(
        ["id", "domain", "quality", "source", "status", "created_at"],
        scanRows.results,
      );
      return csvResponse(csv, `alerts-export-${Date.now()}.csv`, origin);
    }

    const csv = toCSV(
      ["id", "source", "scan_ref", "quality", "status", "created_at"],
      rows.results,
    );
    return csvResponse(csv, `alerts-export-${Date.now()}.csv`, origin);
  } catch {
    return csvResponse("Error exporting data", "error.csv", origin);
  }
}
