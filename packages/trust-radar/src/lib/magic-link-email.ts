/**
 * Magic-link sign-in email — branded HTML via Resend.
 *
 * Mirrors the visual conventions of `lib/invite-email.ts`:
 *   - Deep Space background (#060A14) matching the SPA's --bg-page
 *   - Amber accent (#E5A832) on the CTA button
 *   - Plain-text fallback for clients that don't render HTML
 *
 * Sends from the same `noreply@averrow.com` verified Resend sender as
 * the invite emails. Returns `{ ok, id?, error? }` with the same shape
 * for symmetry with sendInviteEmail.
 */

import { logger } from './logger';
import { MAGIC_LINK_EXPIRY_MINUTES } from './magic-link';

const FROM_ADDRESS = 'Averrow <noreply@averrow.com>';

interface MagicLinkEmailParams {
  recipientEmail: string;
  signInUrl: string;
  ipAddress: string | null;
  userAgent: string | null;
}

interface ResendResponse {
  id?: string;
  error?: string;
  message?: string;
  statusCode?: number;
}

export async function sendMagicLinkEmail(
  apiKey: string,
  params: MagicLinkEmailParams,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const html = buildHtml(params);
  const text = buildText(params);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [params.recipientEmail],
      subject: 'Your Averrow sign-in link',
      html,
      text,
    }),
  });

  const body = (await res.json()) as ResendResponse;
  if (!res.ok) {
    const error = body.message ?? body.error ?? `HTTP ${res.status}`;
    logger.error('magic-link-email', { to: params.recipientEmail, error });
    return { ok: false, error };
  }

  logger.info('magic-link-email', { to: params.recipientEmail, resendId: body.id });
  return { ok: true, id: body.id };
}

function buildHtml({ signInUrl, ipAddress, userAgent }: MagicLinkEmailParams): string {
  // Single-column responsive table; works in Gmail / Outlook / Apple Mail.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Your Averrow sign-in link</title>
<!-- PR-BA: declare dark-mode awareness so Gmail mobile / iOS Mail
     don't auto-invert our intentionally-dark brand palette. -->
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>:root{color-scheme:light dark;supported-color-schemes:light dark;}</style>
</head>
<body style="margin:0;padding:0;background:#060A14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:rgba(255,255,255,0.92);">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#060A14;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:rgba(22,30,48,0.85);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:32px;">
          <tr><td>
            <p style="margin:0 0 24px 0;font-size:20px;font-weight:700;color:#E5A832;letter-spacing:0.5px;">AVERROW</p>
            <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:600;color:rgba(255,255,255,0.92);">Sign in to Averrow</h1>
            <p style="margin:0 0 24px 0;font-size:14px;line-height:1.5;color:rgba(255,255,255,0.60);">
              Click the button below to sign in. This link expires in
              <strong style="color:rgba(255,255,255,0.85);">${MAGIC_LINK_EXPIRY_MINUTES} minutes</strong> and can only be used once.
            </p>
            <p style="margin:24px 0;text-align:center;">
              <a href="${escapeHtml(signInUrl)}"
                 style="display:inline-block;background:linear-gradient(180deg,#E5A832 0%,#B8821F 100%);color:#060A14;text-decoration:none;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;">
                Sign in to Averrow
              </a>
            </p>
            <p style="margin:24px 0 0 0;font-size:11px;line-height:1.5;color:rgba(255,255,255,0.40);">
              If the button doesn't work, copy this link into your browser:<br>
              <span style="color:rgba(255,255,255,0.55);font-family:'Courier New',Courier,monospace;word-break:break-all;">${escapeHtml(signInUrl)}</span>
            </p>
            <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0;">
            <p style="margin:0;font-size:11px;line-height:1.5;color:rgba(255,255,255,0.40);">
              <strong style="color:rgba(255,255,255,0.55);">Didn't request this?</strong><br>
              Someone (possibly you) tried to sign in to Averrow with this email address.
              If it wasn't you, you can safely ignore this email — no account changes
              happen until the link is clicked.
            </p>
            ${(ipAddress || userAgent) ? `
            <p style="margin:16px 0 0 0;font-size:10px;line-height:1.5;color:rgba(255,255,255,0.30);font-family:'Courier New',Courier,monospace;">
              ${ipAddress ? `Requested from: ${escapeHtml(ipAddress)}<br>` : ''}
              ${userAgent ? `Browser: ${escapeHtml(userAgent.slice(0, 80))}` : ''}
            </p>` : ''}
          </td></tr>
        </table>
        <p style="margin:16px 0 0 0;font-size:10px;color:rgba(255,255,255,0.25);">Averrow · Threat Interceptor</p>
      </td>
    </tr>
  </table>
</body></html>`;
}

function buildText({ signInUrl }: MagicLinkEmailParams): string {
  return [
    'Sign in to Averrow',
    '',
    `Click this link to sign in. It expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes and can only be used once.`,
    '',
    signInUrl,
    '',
    "Didn't request this? You can safely ignore this email.",
    '',
    'Averrow · Threat Interceptor',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
