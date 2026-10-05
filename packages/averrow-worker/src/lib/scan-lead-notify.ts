// Free-scan lead emails.
//
//   notifySalesOfNewLead          → sales@averrow.com, every lead.
//   sendScanReportLink            → the prospect, when their email domain
//                                   matches the scanned domain and the
//                                   report was generated automatically.
//   sendScanFollowUpConfirmation  → the prospect, otherwise: a short note
//                                   that the team will follow up (no
//                                   scanned domain in it).
//
// Daily caps on all three live in handlers/brandScan.ts (handleLeadCapture).
//
// Prospect emails never include a caller-supplied name or company, and
// only say a report is attached/linked when it actually is. Plain Averrow
// voice. Failures are non-fatal and returned, never thrown on HTTP errors
// — the caller has already committed the lead row.

import type { Env } from "../types";
import { logger } from "./logger";

const FROM_ADDRESS = "Averrow Sales <sales@averrow.com>";
const NOTIFY_TO = "sales@averrow.com";
// Transactional sender (verified domain, same one used for invites and
// magic links) — distinct from sales@ so prospect replies don't thread
// into the internal lead alert. Replies go to sales@.
const PROSPECT_FROM_ADDRESS = "Averrow <noreply@averrow.com>";

export type LeadDelivery = "emailed" | "team_follow_up";

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
}

type SendResult = { ok: boolean; id?: string; error?: string };

async function sendEmail(
  env: Env,
  logEvent: string,
  logRef: Record<string, unknown>,
  payload: { from: string; to: string[]; subject: string; html: string; text: string; reply_to?: string },
): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    logger.warn(`${logEvent}-skipped`, { ...logRef, reason: "no RESEND_API_KEY" });
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as ResendResponse;
  if (!res.ok) {
    const error = body.message ?? body.error ?? `HTTP ${res.status}`;
    logger.error(logEvent, { ...logRef, error });
    return { ok: false, error };
  }
  logger.info(logEvent, { ...logRef, resendId: body.id });
  return { ok: true, id: body.id };
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

// ─── Internal: new lead → sales ──────────────────────────────────────

interface NewLeadNotifyParams {
  leadId: string;
  email: string;
  company: string | null;
  domain: string | null;
  correlatedBrandId: string | null;
  delivery: LeadDelivery;
  adminUrlBase: string;
}

export async function notifySalesOfNewLead(env: Env, params: NewLeadNotifyParams): Promise<SendResult> {
  const subject = `New scan lead — ${params.email}${params.correlatedBrandId ? " (already-monitored brand)" : ""}`;
  // Scan Leads lives as a tab inside the Leads page.
  const adminLink = `${params.adminUrlBase}/v2/leads?view=scan&lead=${encodeURIComponent(params.leadId)}`;
  const deliveryText = params.delivery === "emailed"
    ? "Report emailed to the prospect automatically (email domain matches the scanned domain)."
    : "Follow-up needed: the prospect was told the team will be in touch.";
  return sendEmail(env, "scan-lead-notify", { leadId: params.leadId }, {
    from: FROM_ADDRESS,
    to: [NOTIFY_TO],
    subject,
    html: buildSalesHtml(params, adminLink, deliveryText),
    text: [
      "New scan lead",
      "",
      `Email:        ${params.email}`,
      `Company:      ${params.company ?? "—"}`,
      `Domain:       ${params.domain ?? "—"}`,
      `Brand status: ${params.correlatedBrandId ? "Already monitored" : "New brand"}`,
      `Delivery:     ${deliveryText}`,
      "",
      `Open in admin: ${adminLink}`,
      "",
      `Lead id: ${params.leadId}`,
    ].join("\n"),
  });
}

function buildSalesHtml(p: NewLeadNotifyParams, adminLink: string, deliveryText: string): string {
  const badge = p.correlatedBrandId
    ? `<span style="background:#fff8e6;color:#b07c00;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;">Already monitored</span>`
    : `<span style="background:#e6f7ee;color:#1a6b3c;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;">New brand</span>`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;color:#222;line-height:1.6;">
    <div style="color:#E5A832;font-weight:600;letter-spacing:2px;font-size:11px;text-transform:uppercase;margin-bottom:12px;">New scan lead · Averrow</div>
    <h2 style="font-size:18px;margin:0 0 16px;color:#111;">A visitor asked for their scan report</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#666;width:30%;">Email</td><td style="padding:6px 0;"><strong>${escapeHtml(p.email)}</strong></td></tr>
      <tr><td style="padding:6px 0;color:#666;">Company</td><td style="padding:6px 0;">${escapeHtml(p.company ?? "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Domain</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(p.domain ?? "—")}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Brand status</td><td style="padding:6px 0;">${badge}</td></tr>
      <tr><td style="padding:6px 0;color:#666;">Delivery</td><td style="padding:6px 0;">${escapeHtml(deliveryText)}</td></tr>
    </table>
    <div style="text-align:center;margin:24px 0 0;">
      <a href="${escapeHtml(adminLink)}" style="display:inline-block;background:#E5A832;color:#111;text-decoration:none;font-weight:600;padding:10px 24px;border-radius:4px;">Open in admin</a>
    </div>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
    <div style="color:#888;font-size:11px;text-align:center;">Lead id: <code>${escapeHtml(p.leadId)}</code></div>
  </div>
</body></html>`;
}

// ─── Prospect emails ─────────────────────────────────────────────────

const FOOTER_HTML = `<hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
    <div style="color:#888;font-size:11px;">Averrow · LRX Enterprises Inc. · You are receiving this because this address was entered on the free scan at averrow.com.</div>`;
const FOOTER_TEXT = "Averrow · LRX Enterprises Inc.\nYou are receiving this because this address was entered on the free scan at averrow.com.";

function prospectShell(heading: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;color:#222;line-height:1.6;">
    <div style="color:#C83C3C;font-weight:700;letter-spacing:2px;font-size:12px;text-transform:uppercase;margin-bottom:16px;">Averrow</div>
    <h2 style="font-size:18px;margin:0 0 16px;color:#111;">${heading}</h2>
    ${bodyHtml}
    ${FOOTER_HTML}
  </div>
</body></html>`;
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export interface ScanReportLinkParams {
  email: string;
  domain: string;
  shareUrl: string;
  expiresAt: string;
}

/** The report link, sent only to an address at the scanned domain. */
export async function sendScanReportLink(env: Env, p: ScanReportLinkParams): Promise<SendResult> {
  const expiry = formatExpiry(p.expiresAt);
  const html = prospectShell(
    `Your scan report for ${escapeHtml(p.domain)}`,
    `<p style="margin:0 0 14px;">Here is the report for <strong style="font-family:monospace;">${escapeHtml(p.domain)}</strong> from the free scan you ran on averrow.com. It covers your email authentication, the lookalike domains the scan found registered, and what Averrow would watch for you.</p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${escapeHtml(p.shareUrl)}" style="display:inline-block;background:#C83C3C;color:#fff;text-decoration:none;font-weight:600;padding:10px 24px;border-radius:4px;">View your report</a>
    </div>
    <p style="margin:0 0 14px;">The link works until ${escapeHtml(expiry)}. Anyone with the link can open the report, so share it only with your team.</p>
    <p style="margin:0 0 14px;">Questions about the findings? Reply to this email and someone from our team will answer.</p>`,
  );
  const text = [
    `Your scan report for ${p.domain}`,
    "",
    `Here is the report for ${p.domain} from the free scan you ran on averrow.com. It covers your email authentication, the lookalike domains the scan found registered, and what Averrow would watch for you.`,
    "",
    `View your report: ${p.shareUrl}`,
    "",
    `The link works until ${expiry}. Anyone with the link can open the report, so share it only with your team.`,
    "",
    "Questions about the findings? Reply to this email and someone from our team will answer.",
    "",
    FOOTER_TEXT,
  ].join("\n");
  return sendEmail(env, "scan-report-link", { domain: p.domain }, {
    from: PROSPECT_FROM_ADDRESS,
    to: [p.email],
    reply_to: NOTIFY_TO,
    subject: `Your Averrow scan report for ${p.domain}`,
    html,
    text,
  });
}

export interface ScanFollowUpParams {
  email: string;
}

/**
 * Confirmation that the team will follow up. Claims nothing else, and
 * does not repeat the scanned domain (appsec L4): this address did not
 * prove any connection to it, so the email must not carry attacker-chosen
 * text into a third party's inbox.
 */
export async function sendScanFollowUpConfirmation(env: Env, p: ScanFollowUpParams): Promise<SendResult> {
  const html = prospectShell(
    "We received your request",
    `<p style="margin:0 0 14px;">Thanks for running the free scan on averrow.com. We have your request for the full report.</p>
    <p style="margin:0 0 14px;">Someone from our team will follow up with you directly about the report.</p>
    <p style="margin:0 0 14px;">If you have questions in the meantime, reply to this email.</p>`,
  );
  const text = [
    "We received your request",
    "",
    "Thanks for running the free scan on averrow.com. We have your request for the full report.",
    "",
    "Someone from our team will follow up with you directly about the report.",
    "",
    "If you have questions in the meantime, reply to this email.",
    "",
    FOOTER_TEXT,
  ].join("\n");
  return sendEmail(env, "scan-follow-up", {}, {
    from: PROSPECT_FROM_ADDRESS,
    to: [p.email],
    reply_to: NOTIFY_TO,
    subject: "We received your Averrow scan request",
    html,
    text,
  });
}
