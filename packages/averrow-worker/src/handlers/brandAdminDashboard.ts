// Averrow — Brand Admin Scoped Dashboard Handler
// Returns stats and data scoped to the user's org brands only.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { OrgScope } from "../middleware/auth";

// GET /api/dashboard/brand-admin
export async function handleBrandAdminDashboard(
  request: Request,
  env: Env,
  scope: OrgScope,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const { brand_ids, org_id } = scope;

    if (brand_ids.length === 0) {
      return json({
        success: true,
        data: {
          total_threats: 0,
          active_threats: 0,
          brand_count: 0,
          avg_email_score: null,
          recent_threats: [],
          brand_health: [],
          recent_alerts: [],
          takedown_summary: { total: 0, pending: 0, taken_down: 0, failed: 0 },
        },
      }, 200, origin);
    }

    const placeholders = brand_ids.map(() => "?").join(", ");

    const [totalThreats, activeThreats, brandCount, avgEmail, recentThreats, brandHealth, recentAlerts, takedowns] = await Promise.all([
      // Total threats for org brands
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IN (${placeholders})`
      ).bind(...brand_ids).first<{ n: number }>(),

      // Active threats for org brands
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM threats WHERE target_brand_id IN (${placeholders}) AND status = 'active'`
      ).bind(...brand_ids).first<{ n: number }>(),

      // Brand count
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM org_brands WHERE org_id = ?"
      ).bind(org_id).first<{ n: number }>(),

      // Average email security score
      env.DB.prepare(
        `SELECT AVG(email_security_score) AS avg_score FROM brands WHERE id IN (${placeholders})`
      ).bind(...brand_ids).first<{ avg_score: number | null }>(),

      // Recent threats (last 24h)
      env.DB.prepare(
        `SELECT t.id, t.threat_type, t.severity, t.malicious_domain, t.status,
                t.created_at, b.name AS brand_name
         FROM threats t
         LEFT JOIN brands b ON b.id = t.target_brand_id
         WHERE t.target_brand_id IN (${placeholders})
           AND t.created_at >= datetime('now', '-1 day')
         ORDER BY t.created_at DESC
         LIMIT 20`
      ).bind(...brand_ids).all(),

      // Brand health cards
      env.DB.prepare(
        `SELECT b.id, b.name, b.canonical_domain, b.email_security_score,
                b.email_security_grade, b.exposure_score,
                COUNT(t.id) AS threat_count,
                SUM(CASE WHEN t.status = 'active' THEN 1 ELSE 0 END) AS active_threats
         FROM brands b
         LEFT JOIN threats t ON t.target_brand_id = b.id
         WHERE b.id IN (${placeholders})
         GROUP BY b.id
         ORDER BY threat_count DESC`
      ).bind(...brand_ids).all(),

      // Recent alerts (org user alerts scoped to org brands)
      env.DB.prepare(
        `SELECT a.id, a.title, a.severity, a.status, a.alert_type,
                a.created_at, b.name AS brand_name
         FROM alerts a
         LEFT JOIN brands b ON b.id = a.brand_id
         WHERE a.brand_id IN (${placeholders})
         ORDER BY a.created_at DESC
         LIMIT 20`
      ).bind(...brand_ids).all(),

      // Takedown summary
      env.DB.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('draft', 'requested', 'submitted', 'pending_response') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'taken_down' THEN 1 ELSE 0 END) AS taken_down,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM takedown_requests
         WHERE brand_id IN (${placeholders})`
      ).bind(...brand_ids).first<{ total: number; pending: number; taken_down: number; failed: number }>(),
    ]);

    return json({
      success: true,
      data: {
        total_threats: totalThreats?.n ?? 0,
        active_threats: activeThreats?.n ?? 0,
        brand_count: brandCount?.n ?? 0,
        avg_email_score: avgEmail?.avg_score ?? null,
        recent_threats: recentThreats.results,
        brand_health: brandHealth.results,
        recent_alerts: recentAlerts.results,
        takedown_summary: {
          total: takedowns?.total ?? 0,
          pending: takedowns?.pending ?? 0,
          taken_down: takedowns?.taken_down ?? 0,
          failed: takedowns?.failed ?? 0,
        },
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
