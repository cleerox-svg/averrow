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

// /api/export/scans and /api/export/signals (exports of `scans` rows) were
// retired with the URL-scan feature (2026-10-04); `scans` never existed in prod.

// ─── Export Alerts ────────────────────────────────────────────
export async function handleExportAlerts(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const rows = await env.DB.prepare(
      `SELECT id, source, scan_ref, quality, status, created_at
       FROM signal_alerts ORDER BY created_at DESC LIMIT 500`
    ).all().catch(() => ({ results: [] as Record<string, unknown>[], success: true as const, meta: {} as D1Meta }));

    const csv = toCSV(
      ["id", "source", "scan_ref", "quality", "status", "created_at"],
      rows.results,
    );
    return csvResponse(csv, `alerts-export-${Date.now()}.csv`, origin);
  } catch {
    return csvResponse("Error exporting data", "error.csv", origin);
  }
}
