/**
 * Magic-link interstitial — the page GET /api/auth/magic-link/:token renders.
 *
 * Corporate mail scanners (Google Workspace, Defender Safe Links) prefetch
 * every link in an email. A single-use token consumed on GET is burned by
 * the scanner before the person clicks, so the GET only validates the token
 * and renders this page; the session is minted by the button's form POST to
 * /api/auth/magic-link/verify (token in the body). Scanners fetch, they
 * don't submit forms.
 *
 * Self-contained like the invite landing page (invite-accept.ts): facelift
 * Phase 4 R3 mark, colours from FACELIFT (./brand.ts), system font stack, the
 * shared THEME_PREPAINT_SCRIPT so a saved light preference doesn't flash. No
 * other script: the button is a plain form submit, so the page works under
 * the site CSP (form-action 'self') with JavaScript disabled.
 *
 * Referrer policy is `strict-origin`: the POST's Referer is the bare origin
 * (never this URL, which holds the token) and its `Origin` header is the
 * real site origin. `no-referrer` would make browsers send `Origin: null`.
 */

import { r3MarkSvg, R3_FAVICON_DATA_URI, FONT_SANS_STACK, FACELIFT } from "./brand";
import { THEME_PREPAINT_SCRIPT } from "./shared";
import { escapeHtml } from "../lib/email-layout";

export const MAGIC_LINK_VERIFY_PATH = "/api/auth/magic-link/verify";

/** `jane@acme.com` → `j***@acme.com`, so the person can see which account
 *  the link signs into without the page exposing the full address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email.charAt(0)}***${email.slice(at)}`;
}

export function renderMagicLinkConfirmPage(token: string, email: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
${THEME_PREPAINT_SCRIPT}
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <meta name="referrer" content="strict-origin">
  <link rel="icon" href="${R3_FAVICON_DATA_URI}" type="image/svg+xml">
  <title>Sign in — Averrow</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root, [data-theme="dark"] {
      --bg: ${FACELIFT.bgPage}; --card: ${FACELIFT.bgCard}; --border: rgba(255,255,255,0.08);
      --text: ${FACELIFT.textPrimary}; --muted: ${FACELIFT.textTertiary};
      --primary: ${FACELIFT.primary}; --primary-hover: ${FACELIFT.primaryHover};
      --primary-ink: #ffffff; --focus: ${FACELIFT.primaryText};
    }
    [data-theme="light"] {
      --bg: ${FACELIFT.bgPageLight}; --card: #ffffff; --border: rgba(18,22,29,0.14);
      --text: ${FACELIFT.textPrimaryLight}; --muted: ${FACELIFT.textTertiaryLight};
      --primary: ${FACELIFT.primaryLight}; --primary-hover: ${FACELIFT.primaryHoverLight};
      --primary-ink: #ffffff; --focus: ${FACELIFT.primaryTextLight};
    }
    body {
      background: var(--bg); color: var(--text);
      font-family: ${FONT_SANS_STACK};
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 24px 16px;
    }
    .card {
      background: var(--card); border: 1px solid var(--border); border-radius: 16px;
      max-width: 420px; width: 100%; padding: 40px 32px; text-align: center;
    }
    .logo { margin-bottom: 24px; display: flex; justify-content: center; }
    h1 { font-size: 22px; font-weight: 700; line-height: 1.3; margin-bottom: 8px; }
    p { font-size: 14px; color: var(--muted); line-height: 1.6; margin-bottom: 28px; }
    .account { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
    button {
      width: 100%; padding: 14px 24px; border: 0; border-radius: 10px;
      background: var(--primary); color: var(--primary-ink);
      font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
    }
    button:hover { background: var(--primary-hover); }
    button:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
    .fine { font-size: 12px; margin: 20px 0 0; }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">${r3MarkSvg({ size: 48, decorative: true })}</div>
    <h1>Sign in to Averrow</h1>
    <p>Continue as <span class="account" data-testid="magic-link-account">${escapeHtml(maskEmail(email))}</span>. This link works once.</p>
    <form method="post" action="${MAGIC_LINK_VERIFY_PATH}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit" data-testid="magic-link-confirm">Sign in to Averrow</button>
    </form>
    <p class="fine">If you didn't request this, you can close this page.</p>
  </main>
</body>
</html>`;
}
