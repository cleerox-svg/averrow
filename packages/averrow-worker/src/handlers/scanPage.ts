// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { renderScanResult, type ScanRecord } from "../templates/scan-result";
import type { Env } from "../types";

export async function handleScanPage(
  _request: Request,
  env: Env,
  scanId: string
): Promise<Response> {
  if (!scanId || scanId.length > 64) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    const row = await env.DB.prepare(
      `SELECT id, url, domain, trust_score, risk_level, flags, metadata,
              geo_city, geo_country, cached, created_at
       FROM scans WHERE id = ? LIMIT 1`
    ).bind(scanId).first<{
      id: string; url: string; domain: string; trust_score: number;
      risk_level: string; flags: string; metadata: string;
      geo_city: string | null; geo_country: string | null;
      cached: number; created_at: string;
    }>();

    if (!row) {
      return new Response("Scan not found", { status: 404 });
    }

    const scan: ScanRecord = {
      ...row,
      flags: JSON.parse(row.flags || "[]"),
      metadata: JSON.parse(row.metadata || "{}"),
    };

    return new Response(renderScanResult(scan), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("scanPage error:", err);
    return new Response("Error loading scan", { status: 500 });
  }
}
