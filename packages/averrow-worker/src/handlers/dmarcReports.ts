// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * DMARC Report API Handlers
 *
 * Four endpoints for querying received DMARC aggregate reports.
 *
 * GET /api/dmarc-reports/overview          — admin global summary
 * GET /api/dmarc-reports/:brandId          — reports for a brand (last 50)
 * GET /api/dmarc-reports/:brandId/stats    — daily stats + totals
 * GET /api/dmarc-reports/:brandId/sources  — top source IPs
 */

import type { Env } from "../types";
import { json } from "../lib/cors";

// GET /api/dmarc-reports/overview — Admin: global summary (last 30 days)
export async function handleGetDmarcOverview(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  const [totals, topDomains, recentReports] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*)                  AS total_reports,
        SUM(total_messages)       AS total_emails,
        SUM(total_pass)           AS total_pass,
        SUM(total_fail)           AS total_fail,
        COUNT(DISTINCT domain)        AS monitored_domains,
        COUNT(DISTINCT reporter_org)  AS reporter_count
      FROM dmarc_reports
      WHERE received_at > datetime('now', '-30 days')
    `).first<{
      total_reports: number; total_emails: number; total_pass: number;
      total_fail: number; monitored_domains: number; reporter_count: number;
    }>(),

    env.DB.prepare(`
      SELECT domain,
             COUNT(*)            AS report_count,
             SUM(total_messages) AS total_emails,
             SUM(total_fail)     AS total_fail,
             MAX(received_at)    AS last_report
      FROM dmarc_reports
      WHERE received_at > datetime('now', '-30 days')
      GROUP BY domain
      ORDER BY total_emails DESC
      LIMIT 10
    `).all<{
      domain: string; report_count: number; total_emails: number;
      total_fail: number; last_report: string;
    }>(),

    env.DB.prepare(`
      SELECT id, domain, reporter_org,
             total_messages AS email_count,
             total_pass     AS pass_count,
             total_fail     AS fail_count,
             received_at
      FROM dmarc_reports
      ORDER BY received_at DESC
      LIMIT 20
    `).all<{
      id: number; domain: string; reporter_org: string;
      email_count: number; pass_count: number; fail_count: number; received_at: string;
    }>(),
  ]);

  return json(
    { success: true, data: { totals, top_domains: topDomains.results, recent_reports: recentReports.results } },
    200, origin,
  );
}

// GET /api/dmarc-reports/:brandId — Reports received for a brand (last 50)
export async function handleGetDmarcReports(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50"), 100);

  const [reports, totals] = await Promise.all([
    env.DB.prepare(`
      SELECT id, domain, reporter_org, reporter_email,
             date_begin, date_end,
             total_messages   AS email_count,
             total_pass       AS pass_count,
             total_fail       AS fail_count,
             policy_published AS dmarc_policy,
             received_at
      FROM dmarc_reports
      WHERE brand_id = ?
      ORDER BY received_at DESC
      LIMIT ?
    `).bind(brandId, limit).all<{
      id: number; domain: string; reporter_org: string; reporter_email: string;
      date_begin: string; date_end: string; email_count: number;
      pass_count: number; fail_count: number; dmarc_policy: string; received_at: string;
    }>(),

    env.DB.prepare(`
      SELECT COUNT(*)              AS report_count,
             SUM(total_messages)   AS total_emails,
             SUM(total_pass)       AS total_pass,
             SUM(total_fail)       AS total_fail,
             COUNT(DISTINCT reporter_org) AS reporter_count
      FROM dmarc_reports
      WHERE brand_id = ?
    `).bind(brandId).first<{
      report_count: number; total_emails: number; total_pass: number;
      total_fail: number; reporter_count: number;
    }>(),
  ]);

  return json({ success: true, data: reports.results, totals }, 200, origin);
}

// GET /api/dmarc-reports/:brandId/stats — Daily stats + summary totals
export async function handleGetDmarcStats(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  const brand = await env.DB.prepare(
    `SELECT COALESCE(canonical_domain, LOWER(name)) AS domain FROM brands WHERE id = ?`,
  ).bind(brandId).first<{ domain: string }>();

  if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

  const [daily, totals] = await Promise.all([
    env.DB.prepare(`
      SELECT date,
             total_messages AS email_count,
             passed         AS pass_count,
             failed         AS fail_count,
             unique_sources,
             top_fail_ips   AS top_failing_ips
      FROM dmarc_daily_stats
      WHERE domain = ?
      ORDER BY date DESC
      LIMIT 30
    `).bind(brand.domain).all<{
      date: string; email_count: number; pass_count: number;
      fail_count: number; unique_sources: number; top_failing_ips: string | null;
    }>(),

    env.DB.prepare(`
      SELECT COUNT(*)              AS report_count,
             SUM(total_messages)   AS total_emails,
             SUM(total_pass)       AS total_pass,
             SUM(total_fail)       AS total_fail,
             COUNT(DISTINCT reporter_org) AS reporter_count
      FROM dmarc_reports WHERE brand_id = ?
    `).bind(brandId).first<{
      report_count: number; total_emails: number; total_pass: number;
      total_fail: number; reporter_count: number;
    }>(),
  ]);

  return json({
    success: true,
    data: {
      domain: brand.domain,
      totals,
      daily: daily.results.map((d) => ({
        ...d,
        top_failing_ips: d.top_failing_ips ? (JSON.parse(d.top_failing_ips) as unknown[]) : [],
      })),
    },
  }, 200, origin);
}

// GET /api/dmarc-reports/:brandId/sources — Top source IPs (failing by default)
export async function handleGetDmarcSources(
  request: Request,
  env: Env,
  brandId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20"), 50);
  const failOnly = url.searchParams.get("fail_only") !== "false";

  const failFilter = failOnly
    ? `AND (rr.dkim_result != 'pass' OR rr.spf_result != 'pass')`
    : "";

  const sources = await env.DB.prepare(`
    SELECT
      rr.source_ip,
      SUM(rr.count) AS total_messages,
      SUM(CASE WHEN rr.dkim_result != 'pass' OR rr.spf_result != 'pass'
               THEN rr.count ELSE 0 END) AS fail_messages,
      rr.country_code,
      rr.org,
      rr.asn,
      rr.lat,
      rr.lng,
      COUNT(DISTINCT rr.report_id) AS report_count
    FROM dmarc_report_records rr
    JOIN dmarc_reports dr ON dr.id = rr.report_id
    WHERE dr.brand_id = ? ${failFilter}
    GROUP BY rr.source_ip, rr.country_code, rr.org, rr.asn, rr.lat, rr.lng
    ORDER BY fail_messages DESC, total_messages DESC
    LIMIT ?
  `).bind(brandId, limit).all<{
    source_ip: string; total_messages: number; fail_messages: number;
    country_code: string | null; org: string | null; asn: string | null;
    lat: number | null; lng: number | null; report_count: number;
  }>();

  return json({ success: true, data: sources.results }, 200, origin);
}
