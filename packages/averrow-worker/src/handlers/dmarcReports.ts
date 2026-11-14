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
 * GET /api/dmarc-reports/:brandId/setup    — hosted-RUA onboarding state
 * GET /api/dmarc-reports/:brandId/spoof-sources — classified failing sources
 *
 * All staff-only at the route layer (routes/email-security.ts).
 */

import type { Env } from "../types";
import { json } from "../lib/cors";
import { attachBookmark, getDbContext, getReadSession } from "../lib/db";
import {
  DMARC_RUA_PRIMARY,
  DMARC_RUA_TAG_VALUE,
  ruaIncludesAverrow,
} from "../lib/dmarc-rua";
import {
  ENROLLMENT_REVERIFY_DAYS,
  isDmarcEligibleBrand,
  liveDmarcRuaState,
  ruaAuthorizationRecordOk,
  sqliteTsAgeDays,
} from "../lib/dmarc-enrollment";
import { mergeDmarcSourceClass, type DmarcSourceClass } from "../lib/dmarc-source-classify";

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

  // DMARC fails only when NEITHER aligned check passed (pass = dkim OR
  // spf). The old `!= 'pass' OR != 'pass'` counted any single failure.
  const failFilter = failOnly
    ? `AND COALESCE(rr.dkim_result, '') <> 'pass' AND COALESCE(rr.spf_result, '') <> 'pass'`
    : "";

  const sources = await env.DB.prepare(`
    SELECT
      rr.source_ip,
      SUM(rr.count) AS total_messages,
      SUM(CASE WHEN COALESCE(rr.dkim_result, '') <> 'pass' AND COALESCE(rr.spf_result, '') <> 'pass'
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

// ─── Hosted DMARC reporting (sensor) ────────────────────────────────

/** Days without a report after which a receiving brand reads `stale`. */
export const DMARC_RECEIVING_WINDOW_DAYS = 7;

export type DmarcSetupState = "no_dmarc" | "rua_missing" | "awaiting_reports" | "receiving" | "stale";

function sqliteTsMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Pure state machine for the setup endpoint (unit-tested). */
export function deriveDmarcSetupState(opts: {
  lastReportAt: string | null;
  ruaIncludesAverrow: boolean;
  dmarcRecordExists: boolean;
  nowMs: number;
}): DmarcSetupState {
  const last = sqliteTsMs(opts.lastReportAt);
  if (last !== null) {
    return opts.nowMs - last <= DMARC_RECEIVING_WINDOW_DAYS * 86_400_000 ? "receiving" : "stale";
  }
  if (opts.ruaIncludesAverrow) return "awaiting_reports";
  return opts.dmarcRecordExists ? "rua_missing" : "no_dmarc";
}

// GET /api/dmarc-reports/:brandId/setup — onboarding state for hosted RUA.
export async function handleGetDmarcSetup(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const session = getReadSession(env, getDbContext(request));
  try {
    const brand = await session.prepare("SELECT id, canonical_domain, tier, source FROM brands WHERE id = ?")
      .bind(brandId).first<{ id: string; canonical_domain: string; tier: string | null; source: string | null }>();
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    const scan = await session.prepare(
      "SELECT dmarc_exists, dmarc_rua, scanned_at FROM email_security_scans WHERE brand_id = ? ORDER BY scanned_at DESC LIMIT 1",
    ).bind(brand.id).first<{ dmarc_exists: number | null; dmarc_rua: string | null; scanned_at: string | null }>();
    const enrollment = await session.prepare(
      "SELECT rua_verified_at, verified_via, last_report_at FROM dmarc_enrollment WHERE brand_id = ?",
    ).bind(brand.id).first<{ rua_verified_at: string; verified_via: string; last_report_at: string | null }>();
    const lastReport = await session.prepare(
      "SELECT MAX(received_at) AS last FROM dmarc_reports WHERE brand_id = ?",
    ).bind(brand.id).first<{ last: string | null }>();

    // The scan answers when it already shows our address; otherwise ask
    // DNS for the CANONICAL domain's own record. The cache is read but
    // this route never writes a negative into it (S1), and a resolver
    // failure is reported as such rather than as "no DMARC record".
    let ruaOurs = ruaIncludesAverrow(scan?.dmarc_rua ?? null);
    let ruaSource: "scan" | "live_dns" | "live_dns_failed" = "scan";
    let dmarcExists = !!scan?.dmarc_exists;
    if (!ruaOurs) {
      const live = await liveDmarcRuaState(env, brand, { cacheNegative: false });
      ruaSource = live === "lookup_failed" ? "live_dns_failed" : "live_dns";
      ruaOurs = live === "averrow";
      if (live !== "lookup_failed") dmarcExists = live !== "no_dmarc" || dmarcExists;
    }

    const lastReportAt = lastReport?.last ?? enrollment?.last_report_at ?? null;
    const state = deriveDmarcSetupState({ lastReportAt, ruaIncludesAverrow: ruaOurs, dmarcRecordExists: dmarcExists, nowMs: Date.now() });
    const auth = await ruaAuthorizationRecordOk(env, brand.canonical_domain);
    const enrollmentValid = !!enrollment && sqliteTsAgeDays(enrollment.rua_verified_at, Date.now()) <= ENROLLMENT_REVERIFY_DAYS;

    return attachBookmark(json({
      success: true,
      data: {
        brand_id: brand.id,
        domain: brand.canonical_domain,
        state,
        rua_address: DMARC_RUA_PRIMARY,
        rua_value: DMARC_RUA_TAG_VALUE,
        rua_includes_averrow: ruaOurs,
        rua_checked_via: ruaSource,
        authorization_required: auth.required,
        authorization_record_ok: auth.ok,
        authorization_record_name: auth.record_name,
        authorization_record_value: "v=DMARC1;",
        // Current validity, not row existence: verified within the
        // re-verify window (the receiver re-checks DNS after it lapses).
        enrolled: enrollmentValid,
        eligible: isDmarcEligibleBrand(brand),
        verified_via: enrollment?.verified_via ?? null,
        verified_at: enrollment?.rua_verified_at ?? null,
        reverify_after_days: ENROLLMENT_REVERIFY_DAYS,
        last_report_at: lastReportAt,
        last_scan_at: scan?.scanned_at ?? null,
      },
    }, 200, origin), session);
  } catch (err) {
    console.error("[dmarc-setup] failed:", err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

export const DMARC_SPOOF_SOURCES_TTL_S = 300;
export const DMARC_SPOOF_SOURCES_LIMIT = 200;

export function dmarcSpoofSourcesCacheKey(brandId: string, days: number): string {
  return `dmarc:spoof_sources:v2:${brandId}:${days}`;
}

/** Merge a `group_concat(DISTINCT source_class)` list with the classifier's
 *  total order; unknown tokens are ignored. */
export function mergeClassList(list: string | null): DmarcSourceClass {
  let out: DmarcSourceClass = "aligned_pass";
  for (const c of (list ?? "").split(",")) {
    if (c === "aligned_pass" || c === "forwarder_likely" || c === "unaligned_shared_esp" || c === "spoof_candidate") {
      out = mergeDmarcSourceClass(out, c);
    }
  }
  return out;
}

// GET /api/dmarc-reports/:brandId/spoof-sources?days=7|30
// Reads ONLY the dmarc_source_daily rollup (+ dmarc_daily_stats series).
export async function handleGetDmarcSpoofSources(request: Request, env: Env, brandId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  const rawDays = new URL(request.url).searchParams.get("days");
  if (rawDays !== null && rawDays !== "" && rawDays !== "7" && rawDays !== "30") {
    return json({ success: false, error: "days must be 7 or 30" }, 400, origin);
  }
  const days = rawDays === "30" ? 30 : 7;

  const cacheKey = dmarcSpoofSourcesCacheKey(brandId, days);
  try {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return json({ success: true, data: JSON.parse(cached) as unknown }, 200, origin);
  } catch {
    // KV transient — fall through.
  }

  const session = getReadSession(env, getDbContext(request));
  try {
    const brand = await session.prepare("SELECT id, canonical_domain FROM brands WHERE id = ?")
      .bind(brandId).first<{ id: string; canonical_domain: string }>();
    if (!brand) return json({ success: false, error: "Brand not found" }, 404, origin);

    const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    // PK (brand_id, date, source_ip) range. Per-IP attributes are stable
    // across days; MAX picks the non-null value deterministically.
    const rows = await session.prepare(
      `SELECT d.source_ip, d.messages, d.fail_messages, d.verified_fail_messages, d.classes, d.rules, d.asn, d.as_org,
              d.country_code, d.hosting_provider_id, hp.name AS provider_name, d.cluster_id,
              d.asn_drop_listed, d.first_seen, d.last_seen, d.days_seen
       FROM (
         SELECT source_ip,
                SUM(messages) AS messages, SUM(fail_messages) AS fail_messages,
                SUM(verified_fail_messages) AS verified_fail_messages,
                group_concat(DISTINCT source_class) AS classes,
                group_concat(DISTINCT source_rule) AS rules,
                MAX(asn) AS asn, MAX(as_org) AS as_org, MAX(country_code) AS country_code,
                MAX(hosting_provider_id) AS hosting_provider_id, MAX(cluster_id) AS cluster_id,
                MAX(asn_drop_listed) AS asn_drop_listed,
                MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen,
                COUNT(*) AS days_seen
         FROM dmarc_source_daily
         WHERE brand_id = ? AND date >= ?
         GROUP BY source_ip
       ) d
       LEFT JOIN hosting_providers hp ON hp.id = d.hosting_provider_id
       ORDER BY d.fail_messages DESC, d.source_ip
       LIMIT ${DMARC_SPOOF_SOURCES_LIMIT}`,
    ).bind(brand.id, since).all<{
      source_ip: string; messages: number; fail_messages: number; verified_fail_messages: number; classes: string | null; rules: string | null;
      asn: string | null; as_org: string | null; country_code: string | null;
      hosting_provider_id: string | null; provider_name: string | null; cluster_id: string | null;
      asn_drop_listed: number; first_seen: string; last_seen: string; days_seen: number;
    }>();

    const daily = await session.prepare(
      `SELECT date, total_messages, passed, failed FROM dmarc_daily_stats
       WHERE domain = ? AND date >= ? ORDER BY date`,
    ).bind(brand.canonical_domain, since).all<{ date: string; total_messages: number; passed: number; failed: number }>();

    const sources = (rows.results ?? []).map((r) => ({
      source_ip: r.source_ip,
      source_class: mergeClassList(r.classes),
      source_rules: (r.rules ?? "").split(",").filter((x) => x !== ""),
      messages: r.messages,
      fail_messages: r.fail_messages,
      // B3d: how much of the failing volume came from verified reports;
      // unverified_only = every report behind this source is unverified
      // (forgeable) evidence.
      verified_fail_messages: r.verified_fail_messages,
      unverified_only: r.verified_fail_messages === 0,
      asn: r.asn,
      as_org: r.as_org,
      country_code: r.country_code,
      provider: r.hosting_provider_id ? { id: r.hosting_provider_id, name: r.provider_name } : null,
      cluster_id: r.cluster_id,
      asn_drop_listed: r.asn_drop_listed === 1,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      days_seen: r.days_seen,
    }));
    const data = {
      brand_id: brand.id,
      domain: brand.canonical_domain,
      days,
      since,
      sources,
      daily: (daily.results ?? []).map((d) => ({ date: d.date, total: d.total_messages, passed: d.passed, failed: d.failed })),
      summary: {
        sources: sources.length,
        spoof_candidate_sources: sources.filter((s) => s.source_class === "spoof_candidate").length,
        unverified_only_sources: sources.filter((s) => s.unverified_only).length,
        fail_messages: sources.reduce((n, s) => n + s.fail_messages, 0),
        truncated: sources.length >= DMARC_SPOOF_SOURCES_LIMIT,
      },
    };
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: DMARC_SPOOF_SOURCES_TTL_S });
    } catch {
      // serve uncached
    }
    return attachBookmark(json({ success: true, data }, 200, origin), session);
  } catch (err) {
    console.error("[dmarc-spoof-sources] failed:", err instanceof Error ? err.message : String(err));
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
