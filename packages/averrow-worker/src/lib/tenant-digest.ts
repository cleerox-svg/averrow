// Tenant weekly digest — orchestration (S4, docs/IMPROVEMENT_PLAN_2026-06.md).
//
// Sends one email per org per ISO week summarizing the week's protection
// activity for the org's digest-enabled brands. Dispatched by the dedicated
// `24 14 * * 1` cron (Mondays 14:24 UTC) and the manual internal endpoint
// POST /api/internal/digest/weekly-tenant/run.
//
// Send gating (ALL required):
//   1. env.TENANT_DIGEST_MODE === 'live'   — platform kill switch, default off
//      (working-agreement §4: outward traffic ships dark). The manual
//      endpoint may pass ignoreMode for a supervised test send.
//   2. Brand opt-in — org_brands.monitoring_config_json.weekly_digest=true
//      (default false; tenant-editable via PATCH monitoring-config).
//   3. Recipient opt-in — users keep their `intelligence_digest`
//      notification preference on (defaults on; user-toggleable).
//
// Dedup: KV stamp `tenant_digest:org_<id>:<iso-week>` (14-day TTL) makes
// re-runs and cron+manual overlap safe.

import type { Env } from "../types";
import { logger } from "./logger";
import {
  buildTenantDigestEmail,
  sendDigestEmail,
  type BrandDigestData,
  type OrgDigestData,
} from "./tenant-digest-email";

const KV_PREFIX = "tenant_digest";
const KV_TTL_SECONDS = 14 * 24 * 3600;
const TOP_THREATS_PER_BRAND = 5;
const MAX_RECIPIENTS_PER_ORG = 50;

export function isDigestLiveMode(env: Env): boolean {
  return env.TENANT_DIGEST_MODE === "live";
}

/** ISO-8601 week label, e.g. 2026-W24. Used only as a dedup key. */
export function isoWeekLabel(d: Date): string {
  // Thursday-of-week trick: ISO week number = week containing Thursday.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((t.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7,
  );
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface DigestBrandRow {
  org_id:     number;
  org_name:   string;
  brand_id:   string;
  brand_name: string;
  email_security_grade: string | null;
}

export interface OrgDigestOutcome {
  org_id:     number;
  status:     "sent" | "skipped_dedup" | "skipped_empty_recipients" | "failed";
  recipients?: number;
  error?:     string;
}

export interface DigestRunResult {
  mode:     "live" | "off";
  orgs:     number;
  outcomes: OrgDigestOutcome[];
}

/** Orgs × digest-enabled brands. JSON true → json_extract returns 1. */
async function findDigestBrands(env: Env): Promise<DigestBrandRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ob.org_id, o.name AS org_name,
            b.id AS brand_id, b.name AS brand_name, b.email_security_grade
     FROM org_brands ob
     JOIN organizations o ON o.id = ob.org_id
     JOIN brands b ON b.id = ob.brand_id
     WHERE json_extract(ob.monitoring_config_json, '$.weekly_digest') = 1
     ORDER BY ob.org_id, b.name`,
  ).all<DigestBrandRow>();
  return rows.results ?? [];
}

async function collectBrandDigest(env: Env, row: DigestBrandRow): Promise<BrandDigestData> {
  const [counts, top, alerts] = await Promise.all([
    env.DB.prepare(
      `SELECT severity, COUNT(*) AS n
       FROM threats
       WHERE target_brand_id = ? AND created_at >= datetime('now', '-7 days')
       GROUP BY severity`,
    ).bind(row.brand_id).all<{ severity: string; n: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(malicious_domain, malicious_url, id) AS indicator,
              threat_type, severity
       FROM threats
       WHERE target_brand_id = ? AND created_at >= datetime('now', '-7 days')
       ORDER BY CASE severity
                  WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                  WHEN 'medium' THEN 2 ELSE 3 END,
                created_at DESC
       LIMIT ?`,
    ).bind(row.brand_id, TOP_THREATS_PER_BRAND).all<{ indicator: string; threat_type: string; severity: string }>(),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN status = 'resolved' AND updated_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS resolved
       FROM alerts
       WHERE brand_id = ?`,
    ).bind(row.brand_id).first<{ opened: number | null; resolved: number | null }>(),
  ]);

  const bySeverity: BrandDigestData["threatsBySeverity"] = {};
  let newThreats = 0;
  for (const c of counts.results ?? []) {
    newThreats += c.n;
    if (c.severity === "critical" || c.severity === "high" || c.severity === "medium" || c.severity === "low") {
      bySeverity[c.severity] = c.n;
    }
  }

  return {
    brandId:    row.brand_id,
    brandName:  row.brand_name,
    newThreats,
    threatsBySeverity: bySeverity,
    topThreats: top.results ?? [],
    alertsOpened:   alerts?.opened ?? 0,
    alertsResolved: alerts?.resolved ?? 0,
    emailGrade: row.email_security_grade,
  };
}

async function collectOrgTakedowns(env: Env, orgId: number): Promise<OrgDigestData["takedowns"]> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN submitted_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS submitted,
       SUM(CASE WHEN status = 'taken_down' AND updated_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status IN ('submitted', 'pending_response') THEN 1 ELSE 0 END) AS pending
     FROM takedown_requests
     WHERE org_id = ?`,
  ).bind(orgId).first<{ submitted: number | null; completed: number | null; pending: number | null }>();
  return {
    submitted: row?.submitted ?? 0,
    completed: row?.completed ?? 0,
    pending:   row?.pending ?? 0,
  };
}

/** Active org members whose intelligence_digest preference is on (default on). */
async function findRecipients(env: Env, orgId: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT u.email
     FROM org_members om
     JOIN users u ON u.id = om.user_id
     LEFT JOIN notification_preferences np ON np.user_id = u.id
     WHERE om.org_id = ?
       AND u.status = 'active'
       AND u.email IS NOT NULL
       AND COALESCE(np.intelligence_digest, 1) = 1
     LIMIT ?`,
  ).bind(orgId, MAX_RECIPIENTS_PER_ORG).all<{ email: string }>();
  return (rows.results ?? []).map((r) => r.email);
}

export interface RunDigestOptions {
  /** Restrict to one org — manual test path. */
  orgId?: number;
  /** Bypass the KV week stamp (manual re-send). */
  force?: boolean;
  /** Bypass TENANT_DIGEST_MODE for a supervised test send (internal endpoint only). */
  ignoreMode?: boolean;
}

export async function runWeeklyTenantDigest(
  env: Env,
  opts: RunDigestOptions = {},
): Promise<DigestRunResult> {
  const live = isDigestLiveMode(env) || opts.ignoreMode === true;
  if (!live) {
    logger.info("tenant_digest_skipped_mode_off", {});
    return { mode: "off", orgs: 0, outcomes: [] };
  }

  const week = isoWeekLabel(new Date());
  const now = new Date();
  const weekEndIso = now.toISOString().slice(0, 10);
  const weekStartIso = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);

  const allBrands = await findDigestBrands(env);
  const byOrg = new Map<number, DigestBrandRow[]>();
  for (const row of allBrands) {
    if (opts.orgId !== undefined && row.org_id !== opts.orgId) continue;
    const list = byOrg.get(row.org_id) ?? [];
    list.push(row);
    byOrg.set(row.org_id, list);
  }

  const outcomes: OrgDigestOutcome[] = [];

  for (const [orgId, brandRows] of byOrg) {
    try {
      const stampKey = `${KV_PREFIX}:org_${orgId}:${week}`;
      if (!opts.force) {
        const already = await env.CACHE.get(stampKey);
        if (already) {
          outcomes.push({ org_id: orgId, status: "skipped_dedup" });
          continue;
        }
      }

      const recipients = await findRecipients(env, orgId);
      if (recipients.length === 0) {
        outcomes.push({ org_id: orgId, status: "skipped_empty_recipients" });
        continue;
      }

      const brands = [];
      for (const b of brandRows) brands.push(await collectBrandDigest(env, b));

      const data: OrgDigestData = {
        orgName: brandRows[0]?.org_name ?? `Org ${orgId}`,
        weekStartIso,
        weekEndIso,
        brands,
        takedowns: await collectOrgTakedowns(env, orgId),
      };
      const email = buildTenantDigestEmail(data);

      let sentAny = false;
      let lastError: string | undefined;
      for (const to of recipients) {
        const sent = await sendDigestEmail(env, to, email);
        if (sent.ok) sentAny = true;
        else lastError = sent.error;
      }

      if (sentAny) {
        await env.CACHE.put(stampKey, new Date().toISOString(), { expirationTtl: KV_TTL_SECONDS });
        outcomes.push({ org_id: orgId, status: "sent", recipients: recipients.length });
        logger.info("tenant_digest_sent", { org_id: orgId, recipients: recipients.length, week });
      } else {
        outcomes.push({ org_id: orgId, status: "failed", error: lastError });
        logger.warn("tenant_digest_failed", { org_id: orgId, error: lastError });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({ org_id: orgId, status: "failed", error: msg });
      logger.error("tenant_digest_org_failed", { org_id: orgId, error: msg });
    }
  }

  return { mode: "live", orgs: byOrg.size, outcomes };
}
