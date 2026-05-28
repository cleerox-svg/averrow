// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Email Security Posture — API Route Handlers
 *
 * GET  /api/email-security/:brandId          → Get latest scan for a brand
 * GET  /api/email-security/:brandId/history  → Recent historical scans (timeline)
 * POST /api/email-security/scan/:brandId     → Trigger manual scan for a brand
 * GET  /api/email-security/scan-all          → Trigger scan of all brands (admin)
 * GET  /api/v1/public/email-security/:domain → Public endpoint (live scan)
 * GET  /api/email-security/stats             → Aggregate grade distribution stats
 */

import { json } from '../lib/cors';
import { runEmailSecurityScan, saveEmailSecurityScan } from '../email-security';
import type { BIMIResult } from '../email-security';
import { createAlert } from '../lib/alerts';
import type { EmailSecurityScan, Env } from '../types';

// ─── GET /api/email-security/:brandId ─────────────────────────────────────

export async function handleGetEmailSecurity(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  try {
    const row = await env.DB.prepare(`
      SELECT * FROM email_security_scans
      WHERE brand_id = ?
      ORDER BY scanned_at DESC
      LIMIT 1
    `).bind(brandId).first<EmailSecurityScan>();

    if (!row) {
      return json({ success: true, data: null }, 200, origin);
    }

    return json({
      success: true,
      data: {
        ...row,
        dkim_selectors_found: safeJson(row.dkim_selectors_found, []),
        mx_providers: safeJson(row.mx_providers, []),
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/email-security/:brandId/history ─────────────────────────────
//
// Returns up to N most-recent scans for a brand as a compact timeline.
// One row per scan with a derived `protocols_passing` count (out of 4 —
// SPF / DKIM / DMARC / MX, matching the rendering on the brand card)
// and the DMARC policy at each point in time. Used by the Email
// Posture history strip on the brand Surface tab so operators can see
// when a brand strengthened or weakened its email posture.

export async function handleGetEmailSecurityHistory(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  try {
    const url = new URL(request.url);
    const limit = Math.min(90, Math.max(1, parseInt(url.searchParams.get('limit') ?? '30', 10)));

    const rows = await env.DB.prepare(`
      SELECT id, scanned_at, spf_exists, dkim_exists, dmarc_exists, dmarc_policy, mx_exists
      FROM email_security_scans
      WHERE brand_id = ?
      ORDER BY scanned_at DESC
      LIMIT ?
    `).bind(brandId, limit).all<{
      id: number;
      scanned_at: string;
      spf_exists: number;
      dkim_exists: number;
      dmarc_exists: number;
      dmarc_policy: string | null;
      mx_exists: number;
    }>();

    const history = (rows.results ?? []).map((row) => {
      const passing =
        (row.spf_exists ? 1 : 0) +
        (row.dkim_exists ? 1 : 0) +
        (row.dmarc_exists ? 1 : 0) +
        (row.mx_exists ? 1 : 0);
      return {
        scanned_at:   row.scanned_at,
        spf_exists:   !!row.spf_exists,
        dkim_exists:  !!row.dkim_exists,
        dmarc_exists: !!row.dmarc_exists,
        dmarc_policy: row.dmarc_policy,
        mx_exists:    !!row.mx_exists,
        protocols_passing: passing,
      };
    });

    return json({ success: true, data: history }, 200, origin);
  } catch {
    return json({ success: false, error: 'An internal error occurred' }, 500, origin);
  }
}

// ─── POST /api/email-security/scan/:brandId ───────────────────────────────

export async function handleScanBrandEmailSecurity(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  try {
    const brand = await env.DB.prepare(
      'SELECT id, canonical_domain, name FROM brands WHERE id = ?'
    ).bind(brandId).first<{ id: number; canonical_domain: string | null; name: string }>();

    if (!brand) {
      return json({ success: false, error: 'Brand not found' }, 404, origin);
    }

    // Fall back to lowercase name if canonical_domain is not set
    const domain = brand.canonical_domain || brand.name.toLowerCase();
    if (!domain) {
      return json({ success: false, error: 'Brand has no domain or name' }, 400, origin);
    }

    const result = await runEmailSecurityScan(domain);
    await saveEmailSecurityScan(env.DB, brand.id, result);

    // Fetch previous BIMI/DMARC state for change detection
    const prev = await env.DB.prepare(
      `SELECT bimi_record, bimi_grade, email_security_grade
       FROM brands WHERE id = ?`
    ).bind(brand.id).first<{
      bimi_record: string | null;
      bimi_grade: string | null;
      email_security_grade: string | null;
    }>();

    const previousBimiRecord = prev?.bimi_record ?? null;
    const previousGrade = prev?.email_security_grade ?? null;

    // Persist BIMI fields + email security score
    await env.DB.prepare(`
      UPDATE brands
      SET email_security_score = ?,
          email_security_grade = ?,
          email_security_scanned_at = datetime('now'),
          bimi_record = ?,
          bimi_svg_url = ?,
          bimi_vmc_url = ?,
          bimi_vmc_valid = ?,
          bimi_vmc_expiry = ?,
          bimi_grade = ?,
          bimi_last_checked = datetime('now')
      WHERE id = ?
    `).bind(
      result.score, result.grade,
      result.bimi.record,
      result.bimi.svg_url,
      result.bimi.vmc_url,
      result.bimi.vmc_valid ? 1 : 0,
      result.bimi.vmc_expiry,
      result.bimi.grade,
      brand.id,
    ).run();

    // Generate BIMI-related alerts
    await emitBIMIAlerts(env.DB, String(brand.id), domain, result.bimi, previousBimiRecord, previousGrade, result.dmarc.policy);

    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/email-security/scan-all (admin) ─────────────────────────────

export async function handleScanAllEmailSecurity(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);

    const brandsToScan = await env.DB.prepare(`
      SELECT b.id, b.canonical_domain AS domain
      FROM brands b
      WHERE b.canonical_domain IS NOT NULL
        AND (b.email_security_scanned_at IS NULL
             OR b.email_security_scanned_at < datetime('now', '-7 days'))
      ORDER BY b.email_security_scanned_at ASC NULLS FIRST
      LIMIT ?
    `).bind(limit).all<{ id: number; domain: string }>();

    let scanned = 0;
    let errors = 0;

    for (const brand of brandsToScan.results) {
      try {
        const result = await runEmailSecurityScan(brand.domain);
        await saveEmailSecurityScan(env.DB, brand.id, result);

        // Fetch previous state for change detection
        const prev = await env.DB.prepare(
          `SELECT bimi_record, email_security_grade FROM brands WHERE id = ?`
        ).bind(brand.id).first<{
          bimi_record: string | null;
          email_security_grade: string | null;
        }>();

        await env.DB.prepare(`
          UPDATE brands
          SET email_security_score = ?,
              email_security_grade = ?,
              email_security_scanned_at = datetime('now'),
              bimi_record = ?,
              bimi_svg_url = ?,
              bimi_vmc_url = ?,
              bimi_vmc_valid = ?,
              bimi_vmc_expiry = ?,
              bimi_grade = ?,
              bimi_last_checked = datetime('now')
          WHERE id = ?
        `).bind(
          result.score, result.grade,
          result.bimi.record,
          result.bimi.svg_url,
          result.bimi.vmc_url,
          result.bimi.vmc_valid ? 1 : 0,
          result.bimi.vmc_expiry,
          result.bimi.grade,
          brand.id,
        ).run();

        await emitBIMIAlerts(env.DB, String(brand.id), brand.domain, result.bimi, prev?.bimi_record ?? null, prev?.email_security_grade ?? null, result.dmarc.policy);
        scanned++;
      } catch (e) {
        console.error(`[email-security] scan failed for ${brand.domain}:`, e);
        errors++;
      }
    }

    return json({
      success: true,
      data: { scanned, errors, total: brandsToScan.results.length },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/v1/public/email-security/:domain ────────────────────────────

export async function handlePublicEmailSecurity(
  request: Request,
  env: Env,
  rawDomain: string,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  const startTime = Date.now();

  // Normalize domain
  const domain = rawDomain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');

  if (!domain || !domain.includes('.')) {
    return json({ success: false, error: 'Invalid domain' }, 400, origin);
  }

  try {
    // Check KV cache first (1 hour TTL)
    const cacheKey = `email-sec:${domain}`;
    const cached = await env.CACHE.get(cacheKey, 'json') as unknown;
    if (cached) {
      return json({ success: true, data: cached, cached: true }, 200, origin);
    }

    // Run live scan
    const result = await runEmailSecurityScan(domain);

    // Cache result for 1 hour
    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });

    // If domain matches a monitored brand, persist to DB
    const brand = await env.DB.prepare(
      "SELECT id FROM brands WHERE canonical_domain = ?"
    ).bind(domain).first<{ id: number }>();

    if (brand) {
      await saveEmailSecurityScan(env.DB, brand.id, result);

      const prev = await env.DB.prepare(
        `SELECT bimi_record, email_security_grade FROM brands WHERE id = ?`
      ).bind(brand.id).first<{
        bimi_record: string | null;
        email_security_grade: string | null;
      }>();

      await env.DB.prepare(`
        UPDATE brands
        SET email_security_score = ?,
            email_security_grade = ?,
            email_security_scanned_at = datetime('now'),
            bimi_record = ?,
            bimi_svg_url = ?,
            bimi_vmc_url = ?,
            bimi_vmc_valid = ?,
            bimi_vmc_expiry = ?,
            bimi_grade = ?,
            bimi_last_checked = datetime('now')
        WHERE id = ?
      `).bind(
        result.score, result.grade,
        result.bimi.record,
        result.bimi.svg_url,
        result.bimi.vmc_url,
        result.bimi.vmc_valid ? 1 : 0,
        result.bimi.vmc_expiry,
        result.bimi.grade,
        brand.id,
      ).run();

      await emitBIMIAlerts(env.DB, String(brand.id), domain, result.bimi, prev?.bimi_record ?? null, prev?.email_security_grade ?? null, result.dmarc.policy);
    }

    return json({ success: true, data: result }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── GET /api/email-security/stats ────────────────────────────────────────

export async function handleEmailSecurityStats(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  try {
    const [gradeRows, totalRow, unscannedRow, worstBrands] = await Promise.all([
      // Grade distribution
      env.DB.prepare(`
        SELECT email_security_grade AS grade, COUNT(*) AS count
        FROM brands
        WHERE email_security_grade IS NOT NULL
        GROUP BY email_security_grade
        ORDER BY CASE grade
          WHEN 'A+' THEN 1 WHEN 'A' THEN 2 WHEN 'B' THEN 3
          WHEN 'C' THEN 4 WHEN 'D' THEN 5 WHEN 'F' THEN 6 ELSE 7 END
      `).all<{ grade: string; count: number }>(),

      // Scanned total
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM brands WHERE email_security_score IS NOT NULL"
      ).first<{ n: number }>(),

      // Unscanned count
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM brands WHERE email_security_score IS NULL"
      ).first<{ n: number }>(),

      // Worst-protected brands (all F/D/C grades, up to 200)
      env.DB.prepare(`
        SELECT b.id, b.name, b.canonical_domain, b.email_security_score, b.email_security_grade,
               (SELECT COUNT(*) FROM threats t WHERE t.target_brand_id = b.id AND t.status = 'active') AS active_threats
        FROM brands b
        WHERE b.email_security_score IS NOT NULL AND b.email_security_grade IN ('F', 'D', 'C')
        ORDER BY b.email_security_score ASC
        LIMIT 200
      `).all<{
        id: string; name: string; canonical_domain: string;
        email_security_score: number; email_security_grade: string;
        active_threats: number;
      }>(),
    ]);

    // DMARC policy distribution (from latest scans)
    const dmarcRows = await env.DB.prepare(`
      SELECT dmarc_policy, COUNT(*) AS count
      FROM email_security_scans ess
      WHERE ess.id IN (
        SELECT MAX(id) FROM email_security_scans GROUP BY brand_id
      )
      GROUP BY dmarc_policy
    `).all<{ dmarc_policy: string | null; count: number }>();

    const avgRow = await env.DB.prepare(
      "SELECT AVG(email_security_score) AS avg FROM brands WHERE email_security_score IS NOT NULL"
    ).first<{ avg: number | null }>();

    return json({
      success: true,
      data: {
        grade_distribution: gradeRows.results,
        dmarc_distribution: dmarcRows.results,
        total_scanned: totalRow?.n ?? 0,
        total_unscanned: unscannedRow?.n ?? 0,
        average_score: Math.round(avgRow?.avg ?? 0),
        worst_brands: worstBrands.results,
      },
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── BIMI Alert Emitter ───────────────────────────────────────────────────

/**
 * Emit alerts when BIMI/DMARC state changes between scans.
 * Uses a system userId since these are automated alerts.
 */
async function emitBIMIAlerts(
  db: D1Database,
  brandId: string,
  domain: string,
  bimi: BIMIResult,
  previousBimiRecord: string | null,
  previousGrade: string | null,
  currentDmarcPolicy: string | null,
): Promise<void> {
  const systemUserId = 'system';

  // 1. BIMI record removed
  if (previousBimiRecord && !bimi.record) {
    await createAlert(db, {
      brandId,
      userId: systemUserId,
      alertType: 'bimi_removed',
      severity: 'HIGH',
      title: `BIMI record removed for ${domain}`,
      summary: `The BIMI DNS record for ${domain} has been removed. ` +
        `Email logo display in Gmail and Apple Mail will stop.`,
      details: { domain, previous_record: previousBimiRecord },
      sourceType: 'email_security_scan',
    });
  }

  // 2. DMARC policy downgraded (was reject, now something weaker)
  if (previousGrade && currentDmarcPolicy) {
    // A+ / A / B grades all imply DMARC reject was in place
    const previousWasReject = ['A+', 'A', 'B'].includes(previousGrade);
    if (previousWasReject && currentDmarcPolicy !== 'reject') {
      await createAlert(db, {
        brandId,
        userId: systemUserId,
        alertType: 'dmarc_downgraded',
        severity: 'CRITICAL',
        title: `DMARC policy downgraded for ${domain}`,
        summary: `DMARC policy changed to '${currentDmarcPolicy}'. ` +
          `Email spoofing protection is now reduced.`,
        details: { domain, new_policy: currentDmarcPolicy, previous_grade: previousGrade },
        sourceType: 'email_security_scan',
      });
    }
  }

  // 3. VMC certificate expiring soon
  if (bimi.vmc_expiry) {
    const expiryDate = new Date(bimi.vmc_expiry);
    if (!isNaN(expiryDate.getTime())) {
      const daysUntilExpiry = Math.ceil(
        (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
        await createAlert(db, {
          brandId,
          userId: systemUserId,
          alertType: 'vmc_expiring',
          severity: daysUntilExpiry <= 7 ? 'CRITICAL' : 'HIGH',
          title: `VMC certificate expiring in ${daysUntilExpiry} days for ${domain}`,
          summary: `The Verified Mark Certificate for ${domain} expires on ` +
            `${expiryDate.toDateString()}. Renew to maintain Gmail BIMI display.`,
          details: { domain, expiry_date: bimi.vmc_expiry, days_remaining: daysUntilExpiry },
          sourceType: 'email_security_scan',
        });
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function safeJson<T>(str: string | null | undefined, fallback: T): T {
  if (!str) return fallback;
  try { return JSON.parse(str) as T; } catch { return fallback; }
}
