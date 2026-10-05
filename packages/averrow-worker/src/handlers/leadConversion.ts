// Sales-funnel actions on a scan_leads row:
//   1. Send templated outreach email with the qualified-report share URL
//   2. Convert a qualified lead into a tenant organization
//
// Both endpoints are super_admin-only. The outreach endpoint requires a
// previously-generated qualified report (400 otherwise) so the email
// always carries a real share link — except for an address that does not
// match the scanned domain, which only ever gets a scan-only report
// (built on demand; see the outreach handler). The convert endpoint is independent
// of outreach — admin can spin up a tenant without sending mail (e.g.
// when the deal closes on a call).

import { json } from "../lib/cors";
import { emailMatchesScannedDomain } from "../lib/free-scan-view";
import { sendLeadOutreachEmail } from "../lib/lead-outreach-email";
import { createQualifiedReport } from "./qualifiedReport";
import { normalizeLeadEmail } from "./brandScan";
import type { Env } from "../types";

interface QualifiedReportPayload {
  content?: "full" | "scan_only";
  brand: { domain: string; name: string | null };
  executive_summary: { risk_grade: string; key_findings: string[] };
}

// ─── Slug generation (mirrors organizations.ts pattern) ──────────

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function generateInviteCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Outreach handler ─────────────────────────────────────────────
//
// Domain check (same rule as lead-form auto-delivery, H1): a FULL report
// (Averrow threat data) is only ever emailed to an address whose host is
// exactly the lead's scanned domain (emailMatchesScannedDomain). For any
// other address the email carries a SCAN-ONLY report — the lead's most
// recent active scan-only report, or a fresh one built here (no AI, no
// threats reads). Staff still generate and view full reports in the
// console; they are just never mailed to an unverified address.

export interface LeadOutreachOptions {
  /**
   * For an unverified address, build a fresh scan-only report even when
   * an active one exists (the one-click report-and-outreach route, which
   * has just generated a fresh full report for the console).
   */
  freshScanOnly?: boolean;
}

export async function handleSendLeadOutreach(
  request: Request,
  env: Env,
  leadId: string,
  userId: string,
  opts: LeadOutreachOptions = {},
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (!env.RESEND_API_KEY) {
      return json({ success: false, error: "Email sending not configured (missing RESEND_API_KEY)" }, 500, origin);
    }

    const lead = await env.DB.prepare(
      "SELECT id, email, name, company, domain, scan_id FROM scan_leads WHERE id = ?",
    ).bind(leadId).first<{
      id: string; email: string; name: string | null; company: string | null; domain: string | null; scan_id: string | null;
    }>();

    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);

    const url = new URL(request.url);
    // Rows captured before strict host validation may hold a malformed
    // address (e.g. `x@acme.com/foo`); never send to one.
    const recipient = normalizeLeadEmail(lead.email);
    if (!recipient) {
      return json({ success: false, error: "Lead email address is not valid" }, 409, origin);
    }
    const domainVerified = lead.domain != null && emailMatchesScannedDomain(recipient, lead.domain);

    // Verified address: the most recent active report, any content (share
    // URL must be one we previously generated — if none, the admin
    // generates first). Unverified address: scan-only reports only.
    let report: { share_token: string; payload_json: string } | null = null;
    if (domainVerified || !opts.freshScanOnly) {
      report = await env.DB.prepare(`
        SELECT share_token, payload_json
        FROM qualified_reports
        WHERE lead_id = ? AND expires_at > datetime('now')
          AND (? = 1 OR json_extract(payload_json, '$.content') = 'scan_only')
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).bind(leadId, domainVerified ? 1 : 0).first<{ share_token: string; payload_json: string }>();
    }

    if (!report && !domainVerified) {
      if (!lead.domain) return json({ success: false, error: "Lead has no domain to scan" }, 400, origin);
      try {
        const created = await createQualifiedReport(env, {
          leadId,
          domain: lead.domain,
          company: lead.company,
          scanId: lead.scan_id,
          generatedBy: userId,
          appOrigin: url.origin,
          content: "scan_only",
        });
        report = { share_token: created.shareToken, payload_json: JSON.stringify(created.payload) };
      } catch {
        report = null;
      }
      if (!report) {
        return json({
          success: false,
          error: "The lead's email address does not match the scanned domain, so only a scan-only report may be emailed, and one could not be built. Follow up manually.",
        }, 409, origin);
      }
    }

    if (!report) {
      return json({
        success: false,
        error: "No active qualified report found for this lead. Generate one first via POST /api/admin/leads/:id/qualified-report.",
      }, 400, origin);
    }

    // Resolve sender name from the super_admin's user record (best-effort —
    // email still sends if lookup fails, signed by 'The Averrow team').
    const sender = await env.DB.prepare(
      "SELECT name FROM users WHERE id = ?",
    ).bind(userId).first<{ name: string | null }>();

    const shareUrl = `${url.origin}/qualified-report/${report.share_token}`;
    const unsubscribeUrl = `${url.origin}/unsubscribe?email=${encodeURIComponent(lead.email)}`;
    const payload = JSON.parse(report.payload_json) as QualifiedReportPayload;
    // Defence in depth: never email full content to an unverified address.
    const content = payload.content === "scan_only" ? "scan_only" : "full";
    if (!domainVerified && content !== "scan_only") {
      return json({ success: false, error: "Refusing to email a full report to an address that does not match the scanned domain" }, 409, origin);
    }

    const result = await sendLeadOutreachEmail(env.RESEND_API_KEY, {
      recipientEmail: recipient,
      recipientName: lead.name,
      brandName: payload.brand.name ?? payload.brand.domain,
      brandDomain: payload.brand.domain,
      riskGrade: payload.executive_summary.risk_grade,
      keyFindings: payload.executive_summary.key_findings,
      qualifiedReportUrl: shareUrl,
      senderName: sender?.name ?? null,
      unsubscribeUrl,
    });

    if (!result.ok) {
      return json({ success: false, error: `Email send failed: ${result.error}` }, 502, origin);
    }

    await env.DB.prepare(`
      UPDATE scan_leads
      SET outreach_sent_at = datetime('now'),
          outreach_email_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(result.id ?? null, leadId).run();

    return json({
      success: true,
      data: {
        sent_to: lead.email,
        email_id: result.id,
        share_url: shareUrl,
        content,
        domain_verified: domainVerified,
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}

// ─── Convert-to-tenant handler ────────────────────────────────────

export async function handleConvertLeadToTenant(
  request: Request,
  env: Env,
  leadId: string,
  userId: string,
  workerCtx?: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => ({})) as {
      org_name?: string;
      plan?: string;
      max_brands?: number;
      max_members?: number;
    };

    const lead = await env.DB.prepare(
      "SELECT id, email, name, company, domain, status, correlated_brand_id, converted_org_id FROM scan_leads WHERE id = ?",
    ).bind(leadId).first<{
      id: string; email: string; name: string | null; company: string | null;
      domain: string | null; status: string;
      correlated_brand_id: string | null; converted_org_id: number | null;
    }>();

    if (!lead) return json({ success: false, error: "Lead not found" }, 404, origin);
    if (!lead.domain) return json({ success: false, error: "Lead has no domain — cannot create brand record" }, 400, origin);
    if (lead.converted_org_id) {
      return json({ success: false, error: `Lead already converted to org id ${lead.converted_org_id}` }, 409, origin);
    }

    const orgName = body.org_name ?? lead.company ?? lead.domain;
    const domain = lead.domain.toLowerCase().trim();

    // ─── Resolve brand: correlate or create ─────────────────────
    // Per product spec: if a brands row already exists for this domain,
    // reuse it (correlate the form submission with that brand). Else
    // INSERT a new brands row. The correlated_brand_id column may already
    // be set from the original lead-capture flow; trust that if present.
    let brandId: string | null = lead.correlated_brand_id;
    let brandWasCreated = false;

    if (!brandId) {
      const existing = await env.DB.prepare(
        "SELECT id FROM brands WHERE canonical_domain = ?",
      ).bind(domain).first<{ id: string }>();

      if (existing) {
        brandId = existing.id;
      } else {
        brandId = `b_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        await env.DB.prepare(`
          INSERT INTO brands (id, name, canonical_domain, first_seen)
          VALUES (?, ?, ?, datetime('now'))
        `).bind(brandId, orgName, domain).run();
        brandWasCreated = true;
      }
    }

    // ─── Create the organization ────────────────────────────────
    let slug = generateSlug(orgName);
    if (!slug) slug = `org-${Date.now().toString(36)}`;
    const dup = await env.DB.prepare(
      "SELECT id FROM organizations WHERE slug = ?",
    ).bind(slug).first();
    if (dup) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

    const inviteCode = generateInviteCode();
    await env.DB.prepare(`
      INSERT INTO organizations (name, slug, plan, status, invite_code, max_brands, max_members)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).bind(
      orgName, slug,
      body.plan ?? "starter",
      inviteCode,
      body.max_brands ?? 5,
      body.max_members ?? 10,
    ).run();

    const org = await env.DB.prepare(
      "SELECT id FROM organizations WHERE slug = ?",
    ).bind(slug).first<{ id: number }>();

    if (!org) {
      return json({ success: false, error: "Organization insert succeeded but row could not be read back" }, 500, origin);
    }
    const orgId = org.id;

    // ─── Add super_admin as owner-role member ───────────────────
    // Lead's prospect-side primary user joins later via invite.
    // TEMPORARY placeholder (PR-F): the one allowed staff org membership.
    // The PR-F staff guards ignore provisioned_by='lead_conversion', and the
    // first customer accepting an org_role='owner' invite for this org
    // deactivates this row (handleInviteAcceptance, handlers/auth.ts).
    await env.DB.prepare(`
      INSERT INTO org_members (org_id, user_id, role, status, accepted_at, provisioned_by)
      VALUES (?, ?, 'owner', 'active', datetime('now'), 'lead_conversion')
    `).bind(orgId, userId).run();

    // ─── Link brand to org + register for monitoring ────────────
    // Idempotent on both inserts (UNIQUE PKs); ignore conflicts since this
    // handler can be re-run after a partial failure.
    try {
      await env.DB.prepare(
        "INSERT INTO org_brands (org_id, brand_id, is_primary) VALUES (?, ?, 1)",
      ).bind(orgId, brandId).run();
      // NX2: when an org claims a brand, retro-populate the last 90 days of
      // alerts from the source tables so the tenant's Signals tab shows
      // history immediately. Fire-and-forget via waitUntil so the response
      // returns instantly; idempotent if it runs again on retry.
      if (workerCtx) {
        const { backfillAlertsForBrand } = await import("../lib/alert-backfill");
        workerCtx.waitUntil(
          backfillAlertsForBrand(env, brandId).catch(err =>
            console.error('[leadConversion] alert backfill failed:', err)),
        );
      }
    } catch { /* dup, fine */ }

    // monitored_brands row links brand -> tenant scope. Per product spec,
    // auto-create + auto-monitor so the new tenant has signal flowing
    // immediately. Status 'new' so the agent mesh picks it up on the
    // next cron tick.
    try {
      await env.DB.prepare(`
        INSERT INTO monitored_brands (brand_id, tenant_id, added_by, status)
        VALUES (?, ?, ?, 'new')
      `).bind(brandId, String(orgId), userId).run();
    } catch { /* dup, fine */ }

    // ─── Update the lead ─────────────────────────────────────────
    await env.DB.prepare(`
      UPDATE scan_leads
      SET status = 'converted',
          correlated_brand_id = COALESCE(correlated_brand_id, ?),
          converted_org_id = ?,
          converted_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(brandId, orgId, leadId).run();

    return json({
      success: true,
      data: {
        org_id: orgId,
        slug,
        invite_code: inviteCode,
        brand_id: brandId,
        brand_was_created: brandWasCreated,
        super_admin_role: "owner",
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}
