/**
 * Invite acceptance landing page — shows invite details and "Sign in with Google" button.
 * Rendered server-side at /invite?token=... for users who land here from the email.
 */

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
  <title>Accept Invitation — Averrow</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #080C14;
      color: #E8ECF1;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #111827;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      padding: 40px 32px;
      text-align: center;
    }
    .logo { margin-bottom: 16px; }
    .brand {
      font-family: monospace;
      font-size: 11px;
      letter-spacing: 3px;
      color: #8896AB;
      text-transform: uppercase;
      margin-bottom: 32px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 8px;
    }
    .org-name { color: #E5A832; }
    .details {
      font-size: 14px;
      color: #8896AB;
      line-height: 1.6;
      margin: 16px 0;
    }
    .details strong { color: #E8ECF1; }
    .cta {
      display: inline-block;
      padding: 14px 40px;
      background: #E5A832;
      color: #080C14;
      font-size: 14px;
      font-weight: 700;
      text-decoration: none;
      border-radius: 8px;
      letter-spacing: 0.5px;
      font-family: monospace;
      margin: 24px 0;
      transition: background 0.2s;
    }
    .cta:hover { background: #d49a2a; }
    .expiry {
      padding: 12px 16px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      font-size: 12px;
      color: #8896AB;
      margin-top: 16px;
    }
    .footer {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid rgba(255,255,255,0.06);
      font-family: monospace;
      font-size: 10px;
      letter-spacing: 2px;
      color: #8896AB;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
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
  <title>Invitation Error — Averrow</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #080C14;
      color: #E8ECF1;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #111827;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      padding: 40px 32px;
      text-align: center;
    }
    .logo { margin-bottom: 16px; }
    .brand {
      font-family: monospace;
      font-size: 11px;
      letter-spacing: 3px;
      color: #8896AB;
      text-transform: uppercase;
      margin-bottom: 32px;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      color: #C83C3C;
      margin-bottom: 12px;
    }
    .message {
      font-size: 14px;
      color: #8896AB;
      line-height: 1.6;
      margin-bottom: 24px;
    }
    .link {
      display: inline-block;
      padding: 12px 32px;
      border: 1px solid rgba(255,255,255,0.15);
      color: #E8ECF1;
      font-size: 13px;
      text-decoration: none;
      border-radius: 8px;
      font-family: monospace;
      transition: border-color 0.2s;
    }
    .link:hover { border-color: rgba(255,255,255,0.3); }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
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
