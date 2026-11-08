/**
 * Invite acceptance landing page — shows invite details and "Sign in with Google" button.
 * Rendered server-side at /invite?token=... for users who land here from the email.
 *
 * Facelift Phase 4: R3 tile mark, indigo CTA (white text, 5.0:1), graphite
 * card, system font stack. See ./brand.ts.
 */

import { r3MarkSvg, R3_FAVICON_DATA_URI, FONT_SANS_STACK, FONT_MONO_STACK } from "./brand";

interface InvitePageData {
  email: string;
  role: string;
  orgName?: string;
  authUrl: string;
  expiresAt: string;
}

export function renderInviteAcceptPage(data: InvitePageData): string {
  const { email, role, orgName, authUrl, expiresAt } = data;
  const displayRole = role.charAt(0).toUpperCase() + role.slice(1);
  const formattedExpiry = formatExpiry(expiresAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="${R3_FAVICON_DATA_URI}" type="image/svg+xml">
  <title>Accept Invitation — Averrow</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0b0e;
      color: #f6f7f7;
      font-family: ${FONT_SANS_STACK};
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #151619;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      padding: 40px 32px;
      text-align: center;
    }
    .logo { margin-bottom: 16px; }
    .brand {
      font-family: ${FONT_MONO_STACK};
      font-size: 11px;
      letter-spacing: 3px;
      color: #a1a1a3;
      text-transform: uppercase;
      margin-bottom: 32px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 8px;
    }
    .org-name { color: #96acff; }
    .details {
      font-size: 14px;
      color: #a1a1a3;
      line-height: 1.6;
      margin: 16px 0;
    }
    .details strong { color: #f6f7f7; }
    .cta {
      display: inline-block;
      padding: 14px 40px;
      background: #4c5cf8;
      color: #ffffff;
      font-size: 14px;
      font-weight: 700;
      text-decoration: none;
      border-radius: 8px;
      letter-spacing: 0.5px;
      font-family: ${FONT_MONO_STACK};
      margin: 24px 0;
      transition: background 0.2s;
    }
    .cta:hover { background: #4f60ff; }
    .expiry {
      padding: 12px 16px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      font-size: 12px;
      color: #a1a1a3;
      margin-top: 16px;
    }
    .footer {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid rgba(255,255,255,0.06);
      font-family: ${FONT_MONO_STACK};
      font-size: 10px;
      letter-spacing: 2px;
      color: #a1a1a3;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      ${r3MarkSvg({ size: 40 })}
    </div>
    <div class="brand">Averrow</div>

    <h1>
      You've been invited to join<br>
      <span class="org-name">${escapeHtml(orgName ?? "Averrow")}</span>
    </h1>

    <p class="details">
      You'll be joining as <strong>${displayRole}</strong>.<br>
      Sign in with your <strong>${escapeHtml(email)}</strong> Google account to accept.
    </p>

    <a href="${escapeHtml(authUrl)}" class="cta">SIGN IN WITH GOOGLE</a>

    <div class="expiry">
      This invitation expires on ${formattedExpiry}.
    </div>

    <div class="footer">Averrow Threat Intelligence</div>
  </div>
</body>
</html>`;
}

export function renderInviteErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="${R3_FAVICON_DATA_URI}" type="image/svg+xml">
  <title>Invitation Error — Averrow</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0b0e;
      color: #f6f7f7;
      font-family: ${FONT_SANS_STACK};
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #151619;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      padding: 40px 32px;
      text-align: center;
    }
    .logo { margin-bottom: 16px; }
    .brand {
      font-family: ${FONT_MONO_STACK};
      font-size: 11px;
      letter-spacing: 3px;
      color: #a1a1a3;
      text-transform: uppercase;
      margin-bottom: 32px;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      color: #f87171;
      margin-bottom: 12px;
    }
    .message {
      font-size: 14px;
      color: #a1a1a3;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .link {
      display: inline-block;
      padding: 12px 32px;
      border: 1px solid rgba(255,255,255,0.15);
      color: #f6f7f7;
      font-size: 13px;
      text-decoration: none;
      border-radius: 8px;
      font-family: ${FONT_MONO_STACK};
      transition: border-color 0.2s;
    }
    .link:hover { border-color: rgba(255,255,255,0.3); }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      ${r3MarkSvg({ size: 40 })}
    </div>
    <div class="brand">Averrow</div>

    <h1>Invitation Error</h1>
    <p class="message">${escapeHtml(message)}</p>

    <a href="https://averrow.com/login" class="link">Go to Login</a>
  </div>
</body>
</html>`;
}

function formatExpiry(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
