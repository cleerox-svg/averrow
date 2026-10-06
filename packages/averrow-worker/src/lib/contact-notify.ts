// Contact/demo form → staff email (DISCLOSURE_REGISTER G33).
//
// POST /api/contact (handlers/contact.ts) stores the row first, then calls
// notifyContactSubmission. The email goes to one internal inbox. Owner
// decision: that address must never appear on the public website or in any
// API response, so it lives only in this constant.
//
// Sending is capped platform-wide per UTC day. The counter is a D1 row
// (contact_rate, lib/contact-rate.ts) bumped by one atomic statement, so
// concurrent submissions can't both take the last slot or fail each other.
// A slot is held while the email is in flight and given back if the send
// fails (Resend error, network error, no RESEND_API_KEY), so only accepted
// emails count. When the counter first goes past the cap that day, one
// "daily cap reached" notice goes to the same inbox; later submissions are
// stored, visible in GET /api/admin/contact-submissions, and not emailed.
// A D1 error on the counter fails CLOSED (no email, row still stored),
// like the free-scan sales alert (handlers/brandScan.ts reserveSalesNotify).

import type { Env } from "../types";
import { escapeHtml } from "./email-layout";
import { logger } from "./logger";
import { sendEmail } from "./scan-lead-notify";
import { incrementContactRate, refundContactRate } from "./contact-rate";

const CONTACT_NOTIFY_TO = "claude.leroux@averrow.com";
// Verified transactional sender (same as invites / scan prospect emails).
const CONTACT_FROM_ADDRESS = "Averrow Website <noreply@averrow.com>";

export const CONTACT_NOTIFY_DAILY_CAP = 50;
// Counter rows outlive their UTC day by a day before the purge may take them.
const DAILY_COUNTER_KEEP_MS = 2 * 24 * 60 * 60 * 1000;
// The message goes in the email in full up to this length; the stored row
// always has the whole text.
const EMAIL_MESSAGE_MAX = 5000;
const SUBJECT_COMPANY_MAX = 40;
const SUBJECT_PREFIX = "[Averrow website]";

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** contact_rate key counting staff emails for one UTC day. */
export const contactNotifyKey = (day = utcDay()) => `contact:notify:${day}`;
/** contact_rate key recording that the cap-reached notice went out that day. */
export const contactCapNoticeKey = (day = utcDay()) => `contact:notify-cap-notice:${day}`;

/**
 * `interest` values the marketing ContactForm.astro sends → label. The
 * contact variant's select offers general / demo / enterprise / partnership;
 * the demo variant always sends "demo". `security` is kept only so rows from
 * the retired security-report option still read correctly.
 */
const INTEREST_LABELS: Record<string, string> = {
  general: "General inquiry",
  demo: "Demo request",
  enterprise: "Plans and enterprise inquiry",
  partnership: "Partnership inquiry",
  security: "Security report",
};

/**
 * Subject/heading label. The /demo form now sends `interest: "demo"`; a
 * submission with a domain and no interest (older demo-form clients sent
 * only the domain) is still read as a demo request.
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
  return `${SUBJECT_PREFIX} ${interestLabel(n.interest, n.domain)}${company ? ` — ${company}` : ""}`;
}

// Strict enough to be a single Reply-To mailbox: no whitespace, quotes,
// angle brackets, commas or semicolons that could add or rewrite recipients.
const REPLY_TO_RE = /^[^\s@<>"'(),;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function safeReplyTo(email: string): string | null {
  return email.length <= 254 && REPLY_TO_RE.test(email) ? email : null;
}

/**
 * First line of every notification. The form is public and unauthenticated:
 * nothing in it (name, company, email, domain) has been verified.
 */
export const UNVERIFIED_LINE =
  "Unverified website submission: the sender's name, company, email and domain have not been checked.";

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
    <div style="margin:0 0 12px;padding:8px 12px;background:#fff7e6;border:1px solid #f0c36d;border-radius:4px;color:#7a4b00;font-size:13px;font-weight:600;">${UNVERIFIED_LINE}</div>
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
    UNVERIFIED_LINE,
    "",
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

type Reservation = { status: "ok"; key: string } | { status: "capped" | "cap_error" };

/**
 * Take one of today's email slots. Over the cap the slot is given straight
 * back (so the counter never sits above the cap), and the first submission
 * that finds the cap full that day sends the cap-reached notice.
 * Fails CLOSED on a D1 error.
 */
async function reserveContactNotify(env: Env, now: number): Promise<Reservation> {
  const day = utcDay(now);
  const key = contactNotifyKey(day);
  const expiresAt = Date.parse(`${day}T00:00:00Z`) + DAILY_COUNTER_KEEP_MS;
  let n: number;
  try {
    n = await incrementContactRate(env.DB, key, expiresAt);
  } catch (err) {
    logger.error("contact-notify-cap-error", { error: err instanceof Error ? err.message : String(err) });
    return { status: "cap_error" };
  }
  if (n <= CONTACT_NOTIFY_DAILY_CAP) return { status: "ok", key };
  await refundQuietly(env, key);
  await sendCapReachedNoticeOnce(env, day, expiresAt);
  return { status: "capped" };
}

async function refundQuietly(env: Env, key: string): Promise<void> {
  try {
    await refundContactRate(env.DB, key);
  } catch (err) {
    logger.warn("contact-notify-refund-failed", { key, error: err instanceof Error ? err.message : String(err) });
  }
}

export function buildCapReachedEmail(day: string): { subject: string; html: string; text: string } {
  const subject = `${SUBJECT_PREFIX} Daily email cap reached`;
  const body =
    `The website contact form has sent ${CONTACT_NOTIFY_DAILY_CAP} notification emails today (${day}, UTC), ` +
    "the daily cap. Further submissions are stored but not emailed until 00:00 UTC. " +
    "Review them in the admin contact submissions list.";
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px;background:#fff;color:#222;line-height:1.6;">
    <h2 style="font-size:18px;margin:0 0 16px;color:#111;">Daily email cap reached</h2>
    <p style="margin:0;font-size:14px;">${escapeHtml(body)}</p>
  </div>
</body></html>`;
  return { subject, html, text: `Daily email cap reached\n\n${body}` };
}

/**
 * Send the cap-reached notice at most once per UTC day. Its own counter
 * decides who sends it; a failed send gives the slot back so the next
 * capped submission tries again. Never throws.
 */
async function sendCapReachedNoticeOnce(env: Env, day: string, expiresAt: number): Promise<void> {
  const key = contactCapNoticeKey(day);
  let n: number;
  try {
    n = await incrementContactRate(env.DB, key, expiresAt);
  } catch (err) {
    logger.error("contact-notify-cap-notice-error", { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (n !== 1) return;
  let ok = false;
  try {
    const { subject, html, text } = buildCapReachedEmail(day);
    const result = await sendEmail(env, "contact-notify-cap-reached", { day }, {
      from: CONTACT_FROM_ADDRESS,
      to: [CONTACT_NOTIFY_TO],
      subject,
      html,
      text,
    });
    ok = result.ok;
  } catch (err) {
    logger.error("contact-notify-cap-reached", { day, error: err instanceof Error ? err.message : String(err) });
  }
  if (!ok) await refundQuietly(env, key);
}

/**
 * Email one stored submission to staff. Never throws: the caller has
 * already committed the row and must answer the visitor with success.
 */
export async function notifyContactSubmission(
  env: Env,
  n: ContactSubmissionNotice,
  now = Date.now(),
): Promise<ContactNotifyStatus> {
  const reserved = await reserveContactNotify(env, now);
  if (reserved.status !== "ok") return reserved.status;
  let ok = false;
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
    ok = result.ok;
  } catch (err) {
    logger.error("contact-notify", { submissionId: n.id, error: err instanceof Error ? err.message : String(err) });
  }
  // Only an accepted email keeps its slot.
  if (!ok) await refundQuietly(env, reserved.key);
  return ok ? "sent" : "failed";
}
