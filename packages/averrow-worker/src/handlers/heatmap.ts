// TODO: Refactor to use handler-utils (Phase 6 continuation)
import { json } from "../lib/cors";
import type { Env } from "../types";

export interface HeatPoint {
  lat: number;
  lng: number;
  intensity: number; // 0–1, derived from (100 - trust_score) / 100
  city: string;
  country: string;
  type: "phishing" | "malware" | "suspicious" | "safe";
}

export interface HeatmapResponse {
  points: HeatPoint[];
  stats: {
    totalScans: number;
    totalThreats: number;
    uniqueCountries: number;
    lastUpdated: string;
  };
}

export async function handleHeatmap(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const hours = Math.min(168, Math.max(1, parseInt(url.searchParams.get("hours") ?? "24", 10)));
  const filter = url.searchParams.get("filter") ?? "all";

  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  try {
    let whereClause = "WHERE s.created_at >= ? AND s.lat IS NOT NULL";
    const params: (string | number)[] = [since];

    if (filter === "phishing") {
      whereClause += " AND s.risk_level IN ('high', 'critical')";
    } else if (filter === "malware") {
      whereClause += " AND s.risk_level = 'critical'";
    }

    // Aggregate by ~1° geo cell for clustering, cap at 500 points
    const pointRows = await env.DB.prepare(`
      SELECT
        ROUND(s.lat, 1) AS lat,
        ROUND(s.lng, 1) AS lng,
        s.geo_city       AS city,
        s.geo_country    AS country,
        AVG(CASE WHEN s.trust_score IS NOT NULL THEN (100.0 - s.trust_score) / 100.0 ELSE 0.5 END) AS intensity,
        COUNT(*)         AS scan_count,
        MIN(s.risk_level) AS risk_level
      FROM scans s
      ${whereClause}
      GROUP BY ROUND(s.lat, 1), ROUND(s.lng, 1)
      ORDER BY intensity DESC
      LIMIT 500
    `).bind(...params).all<{
      lat: number; lng: number; city: string | null; country: string | null;
      intensity: number; scan_count: number; risk_level: string | null;
    }>();

    const statsRow = await env.DB.prepare(`
      SELECT
        COUNT(*)                                               AS total_scans,
        COUNT(CASE WHEN trust_score < 40 THEN 1 END)          AS total_threats,
        COUNT(DISTINCT geo_country_code)                       AS unique_countries
      FROM scans
      WHERE created_at >= ?
    `).bind(since).first<{ total_scans: number; total_threats: number; unique_countries: number }>();

    const response: HeatmapResponse = {
      points: (pointRows.results ?? []).map((p) => ({
        lat: p.lat,
        lng: p.lng,
        intensity: Math.min(1, Math.max(0, p.intensity ?? 0.5)),
        city: p.city ?? "Unknown",
        country: p.country ?? "Unknown",
        type: riskToType(p.risk_level),
      })),
      stats: {
        totalScans: statsRow?.total_scans ?? 0,
        totalThreats: statsRow?.total_threats ?? 0,
        uniqueCountries: statsRow?.unique_countries ?? 0,
        lastUpdated: new Date().toISOString(),
      },
    };

    return json({ success: true, data: response }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

function riskToType(risk: string | null): HeatPoint["type"] {
  if (risk === "critical") return "malware";
  if (risk === "high") return "phishing";
  if (risk === "medium" || risk === "low") return "suspicious";
  return "safe";
}
