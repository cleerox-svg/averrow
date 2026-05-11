// Averrow — Abuse Mailbox tenant module surface
//
// Per-tenant inbox for forwarded suspicious emails. Two endpoints:
//
//   GET /api/orgs/:orgId/modules/abuse-mailbox
//     Per-brand summary of inbound classified messages + the
//     org's verify alias (so the customer knows where to forward).
//
//   GET /api/orgs/:orgId/modules/abuse-mailbox/messages
//     Org-wide message list (default scope). Optional ?brandId=
//     filter to limit to one brand. Ordered by severity →
//     classification → recency.
//
// Email Worker wiring lands in a follow-up sprint; the surface
// is read-side ready now and will show empty-state until the
// first message arrives.
//
// Phase B sprint 6.

import { json } from "../lib/cors";
import type { Env } from "../types";
import type { AuthContext } from "../middleware/auth";
import { requireModule, ModuleNotEntitledError } from "../lib/entitlements";

function verifyOrgAccess(ctx: AuthContext, orgId: string): string | null {
  if (ctx.role === "super_admin") return null;
  if (ctx.orgId !== orgId) return "Not a member of this organization";
  return null;
}

interface AbuseMailboxBrandSummary {
  brand_id:                string;
  brand_name:              string;
  canonical_domain:        string;
  messages_total:          number;
  messages_phishing:       number;
  messages_malware:        number;
  messages_spam:           number;
  messages_benign:         number;
  messages_pending:        number;
  messages_high_critical:  number;
}

interface AliasRow {
  alias: string;
  forwarding_instructions: string | null;
}

interface UnboundCountsRow {
  unbound_total: number;
  unbound_pending: number;
}

// ─── GET /api/orgs/:orgId/modules/abuse-mailbox ─────────────────

export async function handleGetAbuseMailboxModuleSummary(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "abuse_mailbox");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Abuse Mailbox isn't enabled for your organization. Contact support@averrow.com.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  // Per-brand counts (only messages that have been bound to a known brand).
  const result = await env.DB.prepare(
    `SELECT
       b.id AS brand_id,
       b.name AS brand_name,
       b.canonical_domain,
       (SELECT COUNT(*) FROM abuse_inbox_messages m WHERE m.brand_id = b.id AND m.org_id = ?) AS messages_total,
       (SELECT COUNT(*) FROM abuse_inbox_messages m WHERE m.brand_id = b.id AND m.org_id = ? AND m.classification = 'phishing') AS messages_phishing,
       (SELECT COUNT(*) FROM abuse_inbox_messages m WHERE m.brand_id = b.id AND m.org_id = ? AND m.classification = 'malware')  AS messages_malware,
       (SELECT COUNT(*) FROM abuse_inbox_messages m WHERE m.brand_id = b.id AND m.org_id = ? AND m.classification = 'spam')     AS messages_spam,
       (SELECT COUNT(*) FROM abuse_inbox_messages m WHERE m.brand_id = b.id AND m.org_id = ? AND m.classification = 'benign')   AS messages_benign,
       (SELECT COUNT(*) FROM abuse_inbox_messages m WHERE m.brand_id = b.id AND m.org_id = ? AND m.classification = 'pending')  AS messages_pending,
       (SELECT COUNT(*) FROM abuse_inbox_messages m WHERE m.brand_id = b.id AND m.org_id = ? AND LOWER(m.severity) IN ('high','critical')) AS messages_high_critical
     FROM brands b
     JOIN org_brands ob ON ob.brand_id = b.id
     WHERE ob.org_id = ?
     ORDER BY ob.is_primary DESC, b.name`,
  ).bind(
    orgIdNum, orgIdNum, orgIdNum, orgIdNum, orgIdNum, orgIdNum, orgIdNum, orgIdNum,
  ).all<AbuseMailboxBrandSummary>();

  const brands = result.results ?? [];

  const totals = brands.reduce((acc, b) => ({
    messages_total:         acc.messages_total         + b.messages_total,
    messages_phishing:      acc.messages_phishing      + b.messages_phishing,
    messages_malware:       acc.messages_malware       + b.messages_malware,
    messages_spam:          acc.messages_spam          + b.messages_spam,
    messages_benign:        acc.messages_benign        + b.messages_benign,
    messages_pending:       acc.messages_pending       + b.messages_pending,
    messages_high_critical: acc.messages_high_critical + b.messages_high_critical,
  }), {
    messages_total: 0, messages_phishing: 0, messages_malware: 0,
    messages_spam: 0, messages_benign: 0, messages_pending: 0,
    messages_high_critical: 0,
  });

  // Messages that arrived for the org but the classifier couldn't bind to a known brand.
  const unbound = await env.DB.prepare(
    `SELECT
       COUNT(*) AS unbound_total,
       COUNT(CASE WHEN classification = 'pending' THEN 1 END) AS unbound_pending
     FROM abuse_inbox_messages
     WHERE org_id = ? AND brand_id IS NULL`,
  ).bind(orgIdNum).first<UnboundCountsRow>();

  // Org's verify alias (may not yet be provisioned).
  const aliasRow = await env.DB.prepare(
    `SELECT alias, forwarding_instructions
     FROM org_abuse_aliases
     WHERE org_id = ?`,
  ).bind(orgIdNum).first<AliasRow>();

  return json({
    success: true,
    data: {
      org_id: orgIdNum,
      alias: aliasRow ?? null,
      brands,
      totals,
      unbound: {
        total:   unbound?.unbound_total   ?? 0,
        pending: unbound?.unbound_pending ?? 0,
      },
    },
  }, 200, origin);
}

// ─── GET /api/orgs/:orgId/modules/abuse-mailbox/messages ────────

export interface AbuseInboxMessageRow {
  id:                       string;
  org_id:                   number;
  brand_id:                 string | null;
  received_at:              string;
  forwarded_by_email:       string | null;
  inbound_alias:            string | null;
  original_from:            string | null;
  original_subject:         string | null;
  original_body_snippet:    string | null;
  attachment_count:         number;
  url_count:                number;
  classification:           string;
  classified_by:            string | null;
  classification_confidence: number | null;
  classification_reason:    string | null;
  ai_assessment:            string | null;
  ai_action:                string | null;
  severity:                 string;
  status:                   string;
  ack_sent_at:              string | null;
  determination_sent_at:    string | null;
}

export async function handleListAbuseInboxMessages(
  request: Request,
  env:     Env,
  orgId:   string,
  ctx:     AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }

  try {
    if (ctx.role !== "super_admin") {
      await requireModule(env, orgIdNum, "abuse_mailbox");
    }
  } catch (err) {
    if (err instanceof ModuleNotEntitledError) {
      return json({
        success: false,
        error: "Abuse Mailbox isn't enabled for your organization.",
        code: "MODULE_NOT_ENTITLED",
      }, 403, origin);
    }
    throw err;
  }

  const url = new URL(request.url);
  const brandIdParam = url.searchParams.get("brandId");

  // If brandId is filtered, verify ownership for non-admins.
  if (brandIdParam && ctx.role !== "super_admin") {
    const brandOk = await env.DB.prepare(
      `SELECT b.id FROM brands b
       JOIN org_brands ob ON ob.brand_id = b.id
       WHERE b.id = ? AND ob.org_id = ?`,
    ).bind(brandIdParam, orgIdNum).first<{ id: string }>();
    if (!brandOk) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }
  }

  const MESSAGES_LIMIT = 100;
  const baseSelect = `
    SELECT id, org_id, brand_id, received_at, forwarded_by_email, inbound_alias,
           original_from, original_subject, original_body_snippet,
           attachment_count, url_count,
           classification, classified_by, classification_confidence,
           classification_reason, ai_assessment, ai_action,
           severity, status, ack_sent_at, determination_sent_at
    FROM abuse_inbox_messages
    WHERE org_id = ?
  `;
  const orderBy = `
    ORDER BY
      CASE LOWER(severity) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      CASE classification
        WHEN 'phishing'  THEN 1
        WHEN 'malware'   THEN 2
        WHEN 'ambiguous' THEN 3
        WHEN 'spam'      THEN 4
        WHEN 'pending'   THEN 5
        WHEN 'benign'    THEN 6
        ELSE 7
      END,
      received_at DESC
    LIMIT ?
  `;

  const messages = brandIdParam
    ? await env.DB.prepare(`${baseSelect} AND brand_id = ? ${orderBy}`)
        .bind(orgIdNum, brandIdParam, MESSAGES_LIMIT)
        .all<AbuseInboxMessageRow>()
    : await env.DB.prepare(`${baseSelect} ${orderBy}`)
        .bind(orgIdNum, MESSAGES_LIMIT)
        .all<AbuseInboxMessageRow>();

  return json({
    success: true,
    data: {
      org_id:    orgIdNum,
      brand_id:  brandIdParam ?? null,
      messages:  messages.results,
      page_size: MESSAGES_LIMIT,
    },
  }, 200, origin);
}
