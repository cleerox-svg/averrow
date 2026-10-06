// Contact/demo form → staff email (DISCLOSURE_REGISTER G33).
//
// POST /api/contact (handlers/contact.ts) stores the row first, then calls
// notifyContactSubmission. The email goes to one internal inbox. Owner
// decision: that address must never appear on the public website or in any
// API response, so it lives only in this constant.
//
// Sending is capped platform-wide per UTC day (KV counter). Like the
// free-scan sales alert (handlers/brandScan.ts reserveSalesNotify) the cap
// fails CLOSED: a KV error means no email, the row is still stored, and the
// submission still shows in GET /api/admin/contact-submissions.

import type { Env } from "../types";
import { escapeHtml } from "./email-layout";
import { sendEmail } from "./scan-lead-notify";

const CONTACT_NOTIFY_TO = "claude.leroux@averrow.com";
// Verified transactional sender (same as invites / scan prospect emails).
const CONTACT_FROM_ADDRESS = "Averrow Website <noreply@averrow.com>";

export const CONTACT_NOTIFY_DAILY_CAP = 50;
const DAILY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;
// The message goes in the email in full up to this length; the stored row
// always has the whole text.
const EMAIL_MESSAGE_MAX = 5000;
const SUBJECT_COMPANY_MAX = 80;

export const contactNotifyKey = (day = new Date().toISOString().slice(0, 10)) =>
  `contact:notify:${day}`;

/** Form `interest` values (marketing contact.astro / demo.astro) → label. */
const INTEREST_LABELS: Record<string, string> = {
  general: "General inquiry",
  demo: "Demo request",
  enterprise: "Plans and enterprise inquiry",
  security: "Security report",
  press: "Press inquiry",
  partnership: "Partnership inquiry",
  partners: "Partnership inquiry",
  careers: "Careers inquiry",
};

/**
 * Subject/heading label. The /demo form (marketing ContactForm.astro, demo
 * variant) sends `domain` and no `interest`, so a submission with a domain
 * and no interest is a demo request.
 */
export function interestLabel(interest: string | null, domain: string | null = null): string {
  if (!interest) return domain ? INTEREST_LABELS.demo! : "Contact form";
  return INTEREST_LABELS[interest.toLowerCase()] ?? "Contact form";
}

export type ContactNotifyStatus = "sent" | "failed" | "capped" | "cap_error";

export interface ContactSubmissionNotice {
  id: string;
  name: string;
  email: string;
  company: string | null;
  companySize: string | null;
  interest: string | null;
  domain: string | null;
  message: string;
}

/** One line, no control characters (header-safe), length-capped. */
function headerText(s: string, max: number): string {
  const flat = s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function buildContactSubject(n: ContactSubmissionNotice): string {
  const company = n.company ? headerText(n.company, SUBJECT_COMPANY_MAX) : "";
  return `[Averrow website] ${interestLabel(n.interest, n.domain)}${company ? ` — ${company}` : ""}`;
}

// Strict enough to be a single Reply-To mailbox: no whitespace, quotes,
// angle brackets, commas or semicolons that could add or rewrite recipients.
const REPLY_TO_RE = /^[^\s@<>"'(),;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function safeReplyTo(email: string): string | null {
  return email.length <= 254 && REPLY_TO_RE.test(email) ? email : null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n\n[truncated — full text in the admin list]` : s;
}

export function buildContactEmail(n: ContactSubmissionNotice): { subject: string; html: string; text: string } {
  const label = interestLabel(n.interest, n.domain);
  const message = truncate(n.message, EMAIL_MESSAGE_MAX);
  const rows: Array<[string, string]> = [
    ["Name", n.name],
    ["Email", n.email],
    ["Company", n.company ?? "—"],
    ["Company size", n.companySize ?? "—"],
    ["Interest", n.interest ? `${label} (${n.interest})` : label],
  ];
  if (n.domain) rows.push(["Domain", n.domain]);

  const rowHtml = rows
    .map(([k, v]) =>
      `<tr><td style="padding:6px 0;color:#666;width:30%;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:6px 0;">${escapeHtml(v)}</td></tr>`)
    .join("\n      ");

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;color:#222;line-height:1.6;">
    <div style="color:#E5A832;font-weight:600;letter-spacing:2px;font-size:11px;text-transform:uppercase;margin-bottom:12px;">Website form · Averrow</div>
    <h2 style="font-size:18px;margin:0 0 16px;color:#111;">${escapeHtml(label)}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${rowHtml}
    </table>
    <div style="margin:16px 0 0;color:#666;font-size:13px;">Message</div>
    <div style="margin:4px 0 0;padding:12px;background:#fafafa;border:1px solid #eee;border-radius:4px;font-size:14px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(message)}</div>
    <p style="margin:16px 0 0;color:#666;font-size:13px;">Reply to this email to answer the sender directly.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px;">
    <div style="color:#888;font-size:11px;text-align:center;">Submission id: <code>${escapeHtml(n.id)}</code></div>
  </div>
</body></html>`;

  const pad = (k: string) => `${k}:`.padEnd(14, " ");
  const text = [
    label,
    "",
    ...rows.map(([k, v]) => `${pad(k)}${v}`),
    "",
    "Message:",
    message,
    "",
    "Reply to this email to answer the sender directly.",
    "",
    `Submission id: ${n.id}`,
  ].join("\n");

  return { subject: buildContactSubject(n), html, text };
}

/** Reserve one notification email today. Fails CLOSED on a KV error. */
async function reserveContactNotify(env: Env): Promise<"ok" | "capped" | "cap_error"> {
  try {
    const key = contactNotifyKey();
    const sent = parseInt((await env.CACHE.get(key)) ?? "0", 10) || 0;
    if (sent >= CONTACT_NOTIFY_DAILY_CAP) return "capped";
    await env.CACHE.put(key, String(sent + 1), { expirationTtl: DAILY_COUNTER_TTL_SECONDS });
    return "ok";
  } catch {
    return "cap_error";
  }
}

/**
 * Email one stored submission to staff. Never throws: the caller has
 * already committed the row and must answer the visitor with success.
 */
export async function notifyContactSubmission(
  env: Env,
  n: ContactSubmissionNotice,
): Promise<ContactNotifyStatus> {
  const reserved = await reserveContactNotify(env);
  if (reserved !== "ok") return reserved;
  try {
    const { subject, html, text } = buildContactEmail(n);
    const replyTo = safeReplyTo(n.email);
    const result = await sendEmail(env, "contact-notify", { submissionId: n.id }, {
      from: CONTACT_FROM_ADDRESS,
      to: [CONTACT_NOTIFY_TO],
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    });
    return result.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
