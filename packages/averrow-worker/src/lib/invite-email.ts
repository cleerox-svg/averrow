/**
 * Invitation Email — sends branded invite via Resend API.
 * Uses the shared email shell (`email-layout.ts`) so the header logo
 * and footer match every other Averrow transactional email.
 */
import { logger } from "./logger";
import { emailShell, escapeHtml, EMAIL_COLORS, EMAIL_CTA_STYLE } from "./email-layout";

const FROM_ADDRESS = "Averrow <noreply@averrow.com>";

interface InviteEmailParams {
  recipientEmail: string;
  orgName: string;
  role: string;
  invitedByName: string;
  acceptUrl: string;
  expiresAt: string;
}

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
  statusCode?: number;
}

export async function sendInviteEmail(
  apiKey: string,
  params: InviteEmailParams,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const html = buildInviteEmail(params);
  const subject = `You've been invited to join ${params.orgName} on Averrow`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [params.recipientEmail],
      subject,
      html,
    }),
  });

  const body = (await res.json()) as ResendResponse;
  if (!res.ok) {
    const error = body.message ?? body.error ?? `HTTP ${res.status}`;
    logger.error("invite-email", { to: params.recipientEmail, error });
    return { ok: false, error };
  }

  logger.info("invite-email", { to: params.recipientEmail, resendId: body.id });
  return { ok: true, id: body.id };
}

function formatExpiry(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

function capitalizeRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function buildInviteEmail(params: InviteEmailParams): string {
  const { recipientEmail, orgName, role, invitedByName, acceptUrl, expiresAt } = params;
  const formattedExpiry = formatExpiry(expiresAt);
  const displayRole = capitalizeRole(role);

  const body = `
  <tr><td style="padding:32px 28px 8px;">
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#f6f7f7;line-height:1.3;">
      You've been invited to join<br>
      <span style="color:${EMAIL_COLORS.primaryText};">${escapeHtml(orgName)}</span>
    </h1>
    <p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#c2c2c4;">
      <strong style="color:#f6f7f7;">${escapeHtml(invitedByName)}</strong> has invited you to join as
      <strong style="color:#f6f7f7;">${escapeHtml(displayRole)}</strong>.
    </p>
    <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#c2c2c4;">
      Averrow is an AI-powered threat intelligence platform that detects brand impersonation,
      phishing, and cyber threats in real-time.
    </p>
  </td></tr>
  <tr><td style="padding:28px 28px 8px;" align="center">
    <a class="av-cta" href="${escapeHtml(acceptUrl)}" style="${EMAIL_CTA_STYLE}">
      Accept Invitation
    </a>
  </td></tr>
  <tr><td style="padding:20px 28px 28px;">
    <div style="margin:0;padding:14px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">
      <p style="margin:0;font-size:12px;color:#c2c2c4;line-height:1.55;">
        This invitation expires on <strong style="color:#f6f7f7;">${escapeHtml(formattedExpiry)}</strong>.<br>
        If you didn't expect this invitation, you can safely ignore this email.
      </p>
    </div>
  </td></tr>
  `;

  return emailShell({
    title: `You've been invited to ${orgName} on Averrow`,
    preheader: `${invitedByName} invited you to join ${orgName} as ${displayRole}.`,
    body,
    footerNote: `Sent to ${escapeHtml(recipientEmail)} because someone invited you to Averrow.`,
  });
}
