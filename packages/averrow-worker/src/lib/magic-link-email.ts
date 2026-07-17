/**
 * Magic-link sign-in email — branded HTML via Resend.
 *
 * Uses the shared `email-layout.emailShell()` so the logo / header /
 * footer match every other Averrow email exactly. Returns
 * `{ ok, id?, error? }` with the same shape as sendInviteEmail.
 */

import { logger } from './logger';
import { MAGIC_LINK_EXPIRY_MINUTES } from './magic-link';
import { emailShell, escapeHtml } from './email-layout';

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
  const body = `
  <tr><td style="padding:32px 28px 8px;">
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#E8ECF2;line-height:1.3;">Sign in to Averrow</h1>
    <p style="margin:14px 0 0;font-size:14px;line-height:1.6;color:#9AAABF;">
      Click the button below to sign in. This link expires in
      <strong style="color:#E8ECF2;">${MAGIC_LINK_EXPIRY_MINUTES} minutes</strong> and can only be used once.
    </p>
  </td></tr>
  <tr><td style="padding:24px 28px 8px;" align="center">
    <a class="av-cta" href="${escapeHtml(signInUrl)}" style="display:inline-block;padding:14px 36px;background:linear-gradient(180deg,#E5A832 0%,#B8821F 100%);color:#0B1320;font-family:'SF Mono','Menlo',Consolas,monospace;font-size:12px;font-weight:700;letter-spacing:0.18em;text-decoration:none;border-radius:8px;text-transform:uppercase;">
      Sign in to Averrow
    </a>
  </td></tr>
  <tr><td style="padding:20px 28px 8px;">
    <p style="margin:0;font-size:11px;line-height:1.55;color:#6B7A90;">
      If the button doesn't work, copy this link into your browser:<br>
      <span style="color:#9AAABF;font-family:'SF Mono','Menlo',Consolas,monospace;word-break:break-all;">${escapeHtml(signInUrl)}</span>
    </p>
  </td></tr>
  <tr><td style="padding:8px 28px 28px;">
    <div style="margin:18px 0 0;padding:14px 16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;">
      <p style="margin:0;font-size:12px;color:#9AAABF;line-height:1.55;">
        <strong style="color:#E8ECF2;">Didn't request this?</strong>
        Someone tried to sign in to Averrow with this email address. No account
        changes happen until the link is clicked — you can safely ignore this email.
      </p>
      ${(ipAddress || userAgent) ? `
      <p style="margin:10px 0 0;font-size:10px;line-height:1.55;color:#6B7A90;font-family:'SF Mono','Menlo',Consolas,monospace;">
        ${ipAddress ? `Requested from: ${escapeHtml(ipAddress)}<br>` : ''}
        ${userAgent ? `Browser: ${escapeHtml(userAgent.slice(0, 80))}` : ''}
      </p>` : ''}
    </div>
  </td></tr>
  `;

  return emailShell({
    title: 'Your Averrow sign-in link',
    preheader: `Sign in to Averrow — expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes.`,
    body,
  });
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
