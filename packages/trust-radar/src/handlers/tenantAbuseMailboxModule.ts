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

interface AbuseMailboxTotals {
  messages_total:         number;
  messages_phishing:      number;
  messages_malware:       number;
  messages_spam:          number;
  messages_benign:        number;
  messages_pending:       number;
  messages_high_critical: number;
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

  // Org-wide totals (PR-AT follow-up): compute directly over all
  // org messages including unbound ones, not by summing brand rollups.
  // The previous reduce-over-brands logic silently dropped every
  // brand_id IS NULL row from the KPI strip, so an org with 16
  // unclassified messages showed "Total Captures: 0" — see the
  // operator-spotted regression on 2026-05-15.
  const totalsRow = await env.DB.prepare(
    `SELECT
       COUNT(*) AS messages_total,
       COUNT(CASE WHEN classification = 'phishing' THEN 1 END) AS messages_phishing,
       COUNT(CASE WHEN classification = 'malware'  THEN 1 END) AS messages_malware,
       COUNT(CASE WHEN classification = 'spam'     THEN 1 END) AS messages_spam,
       COUNT(CASE WHEN classification = 'benign'   THEN 1 END) AS messages_benign,
       COUNT(CASE WHEN classification = 'pending'  THEN 1 END) AS messages_pending,
       COUNT(CASE WHEN LOWER(severity) IN ('high','critical') THEN 1 END) AS messages_high_critical
     FROM abuse_inbox_messages
     WHERE org_id = ?`,
  ).bind(orgIdNum).first<AbuseMailboxTotals>();

  const totals: AbuseMailboxTotals = totalsRow ?? {
    messages_total: 0, messages_phishing: 0, messages_malware: 0,
    messages_spam: 0, messages_benign: 0, messages_pending: 0,
    messages_high_critical: 0,
  };

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
  forwarded_by_domain:      string | null;
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
  throttled:                number;          // 0 | 1 — PR-AT
  throttle_reason:          string | null;   // 'sender_rate_limit' | 'domain_rate_limit' | null
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
    SELECT id, org_id, brand_id, received_at, forwarded_by_email, forwarded_by_domain, inbound_alias,
           original_from, original_subject, original_body_snippet,
           attachment_count, url_count,
           classification, classified_by, classification_confidence,
           classification_reason, ai_assessment, ai_action,
           severity, status, ack_sent_at, determination_sent_at,
           COALESCE(throttled, 0) AS throttled, throttle_reason
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

// ─── GET /api/orgs/:orgId/modules/abuse-mailbox/messages/:id ────
//
// PR-AS: per-message detail endpoint. Returns the full row plus the
// raw-capture fields (parsed JSON for headers / URL list / attachment
// list). Kept separate from the list endpoint so the list payload
// stays compact — bodies can be up to 256KB each.

export interface ExtractedUrlRow {
  url:    string;
  domain: string | null;
  count:  number;
}

export interface ExtractedAttachmentRow {
  filename:  string;
  mime_type: string | null;
}

export interface AbuseInboxMessageDetail extends AbuseInboxMessageRow {
  raw_body:              string | null;
  raw_headers:           Record<string, string> | null;
  extracted_urls:        ExtractedUrlRow[]        | null;
  attachment_names:      ExtractedAttachmentRow[] | null;
  raw_size_bytes:        number | null;
  // PR-AX
  auth_results:          { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  sender_ip:             string | null;
  correlated_threat_ids: string[] | null;
  promoted_threat_ids:   string[] | null;
}

interface AbuseInboxMessageDetailRow extends AbuseInboxMessageRow {
  raw_body:              string | null;
  raw_headers:           string | null;
  extracted_urls:        string | null;
  attachment_names:      string | null;
  raw_size_bytes:        number | null;
  // PR-AX
  auth_results:          string | null;
  sender_ip:             string | null;
  correlated_threat_ids: string | null;
  promoted_threat_ids:   string | null;
}

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

export async function handleGetAbuseInboxMessageDetail(
  request:   Request,
  env:       Env,
  orgId:     string,
  messageId: string,
  ctx:       AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const accessError = verifyOrgAccess(ctx, orgId);
  if (accessError) return json({ success: false, error: accessError }, 403, origin);

  const orgIdNum = Number(orgId);
  if (!Number.isFinite(orgIdNum)) {
    return json({ success: false, error: "Invalid organization id" }, 400, origin);
  }
  if (!messageId || messageId.length > 64) {
    return json({ success: false, error: "Invalid message id" }, 400, origin);
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

  const row = await env.DB.prepare(
    `SELECT id, org_id, brand_id, received_at, forwarded_by_email, forwarded_by_domain, inbound_alias,
            original_from, original_subject, original_body_snippet,
            attachment_count, url_count,
            classification, classified_by, classification_confidence,
            classification_reason, ai_assessment, ai_action,
            severity, status, ack_sent_at, determination_sent_at,
            COALESCE(throttled, 0) AS throttled, throttle_reason,
            raw_body, raw_headers, extracted_urls, attachment_names, raw_size_bytes,
            auth_results, sender_ip, correlated_threat_ids, promoted_threat_ids
     FROM abuse_inbox_messages
     WHERE id = ? AND org_id = ?`,
  ).bind(messageId, orgIdNum).first<AbuseInboxMessageDetailRow>();

  if (!row) {
    return json({ success: false, error: "Message not found" }, 404, origin);
  }

  const detail: AbuseInboxMessageDetail = {
    ...row,
    raw_headers:           safeJsonParse<Record<string, string>>(row.raw_headers),
    extracted_urls:        safeJsonParse<ExtractedUrlRow[]>(row.extracted_urls),
    attachment_names:      safeJsonParse<ExtractedAttachmentRow[]>(row.attachment_names),
    auth_results:          safeJsonParse<{ spf: string | null; dkim: string | null; dmarc: string | null }>(row.auth_results),
    correlated_threat_ids: safeJsonParse<string[]>(row.correlated_threat_ids),
    promoted_threat_ids:   safeJsonParse<string[]>(row.promoted_threat_ids),
  };

  return json({ success: true, data: detail }, 200, origin);
}
