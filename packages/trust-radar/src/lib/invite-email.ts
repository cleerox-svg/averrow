/**
 * Invitation Email — sends branded invite via Resend API.
 * Matches the Averrow design system (Deep Space background, amber accents).
 */
import { logger } from "./logger";

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!-- PR-BA: declare dark-mode awareness so Gmail mobile / iOS Mail
       don't auto-invert our intentionally-dark brand palette. -->
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <style>:root{color-scheme:light dark;supported-color-schemes:light dark;}</style>
  <title>You've been invited to ${orgName} on Averrow</title>
</head>
<body style="margin:0;padding:0;background:#080C14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#080C14;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:12px;overflow:hidden;">

          <!-- Header with logo -->
          <tr>
            <td style="padding:32px 32px 24px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.06);">
              <!-- Deep Arrow logo mark -->
              <div style="display:inline-block;margin-bottom:12px;">
                <svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <linearGradient id="arrow" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" style="stop-color:#6B1010"/>
                      <stop offset="100%" style="stop-color:#C83C3C"/>
                    </linearGradient>
                  </defs>
                  <polygon points="18,2 34,30 18,22 2,30" fill="url(#arrow)"/>
                </svg>
              </div>
              <div style="font-family:monospace;font-size:11px;letter-spacing:3px;color:#8896AB;text-transform:uppercase;">AVERROW</div>
            </td>
          </tr>

          <!-- Main content -->
          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#E8ECF1;line-height:1.3;">
                You've been invited to join<br>
                <span style="color:#E5A832;">${escapeHtml(orgName)}</span>
              </h1>

              <p style="margin:16px 0;font-size:15px;line-height:1.6;color:#8896AB;">
                <strong style="color:#E8ECF1;">${escapeHtml(invitedByName)}</strong> has invited you to join as
                <strong style="color:#E8ECF1;">${displayRole}</strong>.
              </p>

              <p style="margin:16px 0;font-size:14px;line-height:1.6;color:#8896AB;">
                Averrow is an AI-powered threat intelligence platform that detects brand impersonation,
                phishing, and cyber threats in real-time.
              </p>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;">
                <tr>
                  <td align="center">
                    <a href="${escapeHtml(acceptUrl)}"
                       style="display:inline-block;padding:14px 40px;background:#E5A832;color:#080C14;font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;letter-spacing:0.5px;font-family:monospace;">
                      ACCEPT INVITATION
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <div style="margin:24px 0 0;padding:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">
                <p style="margin:0;font-size:12px;color:#8896AB;line-height:1.5;">
                  This invitation expires on <strong style="color:#E8ECF1;">${formattedExpiry}</strong>.<br>
                  If you didn't expect this invitation, you can safely ignore this email.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:24px 32px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
              <p style="margin:0 0 4px;font-family:monospace;font-size:10px;letter-spacing:2px;color:#8896AB;text-transform:uppercase;">
                Averrow Threat Interceptor
              </p>
              <p style="margin:0;font-size:12px;color:#555;">
                <a href="https://averrow.com" style="color:#0A8AB5;text-decoration:none;">averrow.com</a>
              </p>
            </td>
          </tr>

        </table>

        <!-- Sub-footer -->
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
          <tr>
            <td style="padding:16px 0;text-align:center;">
              <p style="margin:0;font-size:11px;color:#555;line-height:1.5;">
                This email was sent to ${escapeHtml(recipientEmail)} because someone invited you to Averrow.<br>
                If you believe this was sent in error, no action is needed.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
