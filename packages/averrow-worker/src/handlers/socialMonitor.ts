// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Social Monitoring API Handlers
// Refactored to use unified brand model (brands + social_profiles + brand_monitor_schedule)

import { json } from "../lib/cors";
import { audit } from "../lib/audit";
import { runSocialMonitorForBrand } from "../scanners/social-monitor";
import type { Env } from "../types";

// ─── GET /api/social/monitor — Social monitoring overview (all brands) ───

export async function handleSocialOverview(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Get all brands with social monitoring configured (official_handles IS NOT NULL)
    // that the user has in their monitored_brands
    const brands = await env.DB.prepare(`
      SELECT b.id, b.name AS brand_name, b.canonical_domain AS domain,
             b.official_handles, b.monitoring_tier, b.monitoring_status AS status,
             b.social_risk_score, b.last_social_scan, b.created_at
      FROM brands b
      INNER JOIN monitored_brands mb ON mb.brand_id = b.id
      WHERE b.official_handles IS NOT NULL
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(limit, offset).all();

    const total = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM brands b
       INNER JOIN monitored_brands mb ON mb.brand_id = b.id
       WHERE b.official_handles IS NOT NULL`
    ).first<{ n: number }>();

    // For each brand, get monitoring stats from social_profiles
    const brandsWithStats = await Promise.all(
      brands.results.map(async (brand: Record<string, unknown>) => {
        const brandId = brand.id as string;

        // Count open issues by severity from social_profiles
        const severityCounts = await env.DB.prepare(`
          SELECT severity, COUNT(*) AS count
          FROM social_profiles
          WHERE brand_id = ? AND status = 'active'
          GROUP BY severity
        `).bind(brandId).all();

        // Get last check time from brand_monitor_schedule
        const lastCheck = await env.DB.prepare(`
          SELECT MAX(last_checked) AS last_checked
          FROM brand_monitor_schedule
          WHERE brand_id = ? AND monitor_type = 'social' AND enabled = 1
        `).bind(brandId).first<{ last_checked: string | null }>();

        // Get next scheduled check
        const nextCheck = await env.DB.prepare(`
          SELECT MIN(next_check) AS next_check
          FROM brand_monitor_schedule
          WHERE brand_id = ? AND monitor_type = 'social' AND enabled = 1
        `).bind(brandId).first<{ next_check: string | null }>();

        const severityMap: Record<string, number> = {};
        for (const row of severityCounts.results) {
          severityMap[row.severity as string] = row.count as number;
        }

        return {
          ...brand,
          monitoring: {
            open_critical: severityMap["CRITICAL"] ?? 0,
            open_high: severityMap["HIGH"] ?? 0,
            open_medium: severityMap["MEDIUM"] ?? 0,
            open_low: severityMap["LOW"] ?? 0,
            last_checked: lastCheck?.last_checked ?? null,
            next_check: nextCheck?.next_check ?? null,
          },
        };
      })
    );

    return json({
      success: true,
      data: brandsWithStats,
      total: total?.n ?? 0,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/social/monitor/:brandId — Specific brand monitoring results ───

export async function handleBrandSocialMonitor(request: Request, env: Env, brandId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify ownership via monitored_brands or admin role
    const brand = await env.DB.prepare(
      "SELECT id, name, canonical_domain, official_handles FROM brands WHERE id = ?"
    ).bind(brandId).first();

    if (!brand) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    const ownership = await env.DB.prepare(
      "SELECT brand_id FROM monitored_brands WHERE brand_id = ?"
    ).bind(brandId).first();
    const userRow = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first<{ role: string }>();
    const isAdmin = userRow?.role === "admin" || userRow?.role === "super_admin";

    if (!ownership && !isAdmin) {
      return json({ success: false, error: "Brand not in your monitored list" }, 403, origin);
    }

    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");
    const status = url.searchParams.get("status") ?? "active";
    const severity = url.searchParams.get("severity");
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    // Build query with optional filters against social_profiles
    let where = `WHERE brand_id = ?`;
    const params: unknown[] = [brandId];

    if (platform) {
      where += ` AND platform = ?`;
      params.push(platform);
    }
    if (status) {
      where += ` AND status = ?`;
      params.push(status);
    }
    if (severity) {
      where += ` AND severity = ?`;
      params.push(severity);
    }

    const results = await env.DB.prepare(`
      SELECT * FROM social_profiles
      ${where}
      ORDER BY
        CASE severity
          WHEN 'CRITICAL' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'MEDIUM' THEN 3
          WHEN 'LOW' THEN 4
        END,
        created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM social_profiles ${where}`
    ).bind(...params).first<{ n: number }>();

    // Get schedule info from brand_monitor_schedule
    const schedule = await env.DB.prepare(
      "SELECT platform, last_checked, next_check, check_interval_hours, enabled FROM brand_monitor_schedule WHERE brand_id = ? AND monitor_type = 'social'"
    ).bind(brandId).all();

    return json({
      success: true,
      data: {
        brand: {
          id: brand.id,
          brand_name: brand.name,
          domain: brand.canonical_domain,
        },
        results: results.results,
        total: countRow?.n ?? 0,
        schedule: schedule.results,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/social/alerts — Active impersonation alerts ───

export async function handleSocialAlerts(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const severity = url.searchParams.get("severity");
    const status = url.searchParams.get("status") ?? "new";
    const limit = Math.min(100, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

    let where = `WHERE a.user_id = ? AND a.alert_type = 'social_impersonation'`;
    const params: unknown[] = [userId];

    if (severity) {
      where += ` AND a.severity = ?`;
      params.push(severity);
    }
    if (status) {
      where += ` AND a.status = ?`;
      params.push(status);
    }

    // Join against brands table instead of brand_profiles
    const alerts = await env.DB.prepare(`
      SELECT a.*, b.name AS brand_name, b.canonical_domain AS domain
      FROM alerts a
      LEFT JOIN brands b ON b.id = a.brand_id
      ${where}
      ORDER BY
        CASE a.severity
          WHEN 'CRITICAL' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'MEDIUM' THEN 3
          WHEN 'LOW' THEN 4
        END,
        a.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(...params, limit, offset).all();

    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM alerts a ${where}`
    ).bind(...params).first<{ n: number }>();

    return json({
      success: true,
      data: alerts.results,
      total: countRow?.n ?? 0,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── POST /api/social/scan/:brandId — Trigger immediate scan for a brand ───

export async function handleTriggerSocialScan(request: Request, env: Env, brandId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // Verify via brands + monitored_brands
    const brand = await env.DB.prepare(
      "SELECT id, name, canonical_domain, official_handles FROM brands WHERE id = ?"
    ).bind(brandId).first<{
      id: string;
      name: string;
      canonical_domain: string;
      official_handles: string;
    }>();

    if (!brand) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    const ownership = await env.DB.prepare(
      "SELECT brand_id FROM monitored_brands WHERE brand_id = ?"
    ).bind(brandId).first();
    const userRow = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(userId).first<{ role: string }>();
    const isAdmin = userRow?.role === "admin" || userRow?.role === "super_admin";

    if (!ownership && !isAdmin) {
      return json({ success: false, error: "Brand not in your monitored list" }, 403, origin);
    }

    // Run the scan using brands.id
    const results = await runSocialMonitorForBrand(env, {
      id: brand.id,
      brand_name: brand.name,
      domain: brand.canonical_domain,
      official_handles: brand.official_handles,
    });

    // Store results in social_profiles
    let alertsCreated = 0;
    for (const result of results) {
      const profileId = crypto.randomUUID();
      const handle = result.handleChecked.replace(/^@/, "");

      if (result.checkType === "handle_check") {
        // Official handle check — upsert as 'official' classification
        await env.DB.prepare(`
          INSERT INTO social_profiles
            (id, brand_id, platform, handle, profile_url, classification, classified_by,
             impersonation_score, impersonation_signals, severity, status, last_checked)
          VALUES (?, ?, ?, ?, ?, 'official', 'system', 0, '[]', 'LOW', 'active', datetime('now'))
          ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
            last_checked = datetime('now'),
            updated_at = datetime('now')
        `).bind(
          profileId, result.brandId, result.platform, handle,
          result.suspiciousAccountUrl ?? null,
        ).run();
      } else {
        // Impersonation scan result — upsert with score-based classification
        const classification = result.impersonationScore >= 0.7 ? "impersonation" : "suspicious";
        await env.DB.prepare(`
          INSERT INTO social_profiles
            (id, brand_id, platform, handle, profile_url, display_name,
             classification, classified_by, classification_confidence,
             impersonation_score, impersonation_signals, severity, status, last_checked)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, 'active', datetime('now'))
          ON CONFLICT (brand_id, platform, handle) DO UPDATE SET
            impersonation_score = excluded.impersonation_score,
            impersonation_signals = excluded.impersonation_signals,
            severity = excluded.severity,
            classification = excluded.classification,
            classification_confidence = excluded.classification_confidence,
            last_checked = datetime('now'),
            updated_at = datetime('now')
        `).bind(
          profileId, result.brandId, result.platform, handle,
          result.suspiciousAccountUrl ?? null,
          result.suspiciousAccountName ?? null,
          classification,
          result.impersonationScore,
          result.impersonationScore,
          JSON.stringify(result.impersonationSignals),
          result.severity,
        ).run();
      }

      // Create alerts for HIGH/CRITICAL
      if (result.severity === "HIGH" || result.severity === "CRITICAL") {
        const { createAlert } = await import("../lib/alerts");
        await createAlert(env.DB, {
          brandId: brand.id,
          userId,
          alertType: "social_impersonation",
          severity: result.severity,
          title: `${result.severity === "CRITICAL" ? "Likely" : "Possible"} impersonation on ${result.platform}: @${result.handleChecked}`,
          summary: `A ${result.platform} account "${result.handleChecked}" was detected that may be impersonating ${brand.name}. Impersonation score: ${(result.impersonationScore * 100).toFixed(0)}%.`,
          details: {
            platform: result.platform,
            handle: result.handleChecked,
            url: result.suspiciousAccountUrl,
            score: result.impersonationScore,
            signals: result.impersonationSignals,
            check_type: result.checkType,
          },
          sourceType: "social_monitor",
          sourceId: profileId,
        });
        alertsCreated++;
      }
    }

    // Update brand_monitor_schedule
    const now = new Date().toISOString();
    await env.DB.prepare(`
      UPDATE brand_monitor_schedule
      SET last_checked = ?,
          next_check = datetime(?, '+' || check_interval_hours || ' hours')
      WHERE brand_id = ? AND monitor_type = 'social' AND enabled = 1
    `).bind(now, now, brand.id).run();

    // Update brand's last_social_scan
    await env.DB.prepare(
      "UPDATE brands SET last_social_scan = ? WHERE id = ?"
    ).bind(now, brand.id).run();

    await audit(env, {
      action: "social_scan_triggered",
      userId,
      resourceType: "brand",
      resourceId: brand.id,
      details: {
        results_count: results.length,
        alerts_created: alertsCreated,
      },
      request,
    });

    return json({
      success: true,
      data: {
        brand_id: brand.id,
        brand_name: brand.name,
        results_count: results.length,
        alerts_created: alertsCreated,
        results,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
