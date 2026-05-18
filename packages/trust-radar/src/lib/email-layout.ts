/**
 * Shared email layout — the canonical Averrow header + footer + dark-mode
 * armor used by every transactional email this Worker sends.
 *
 * Before this file each email handler hand-rolled its own <header>, which
 * is how the daily briefing ended up shipping without a logo and the
 * magic-link email used a different mark from the invite email.
 *
 * Public API:
 *   - `emailShell({ ... })` wraps inner HTML in the standard outer shell
 *     (head, dark-mode meta, brand header, content, footer).
 *   - `escapeHtml(s)` for safe value interpolation.
 *
 * Visual contract:
 *   - Logo: hosted PNG at https://averrow.com/logo-email-mark.png (38x38).
 *     This is the same asset abuse-mailbox-responder.ts uses — keeping the
 *     URL stable means Gmail's image proxy keeps it cached across every
 *     email family. See the long PR-BF note in abuse-mailbox-responder.ts
 *     for the cache-control reasoning.
 *   - Dark-mode armor: `data-ogsc` / `data-ogsb` counter-invert rules so
 *     Gmail Android + iOS Mail don't flip our intentionally-red mark to
 *     pink-on-white. Same pattern proven on the abuse-triage emails.
 *   - Header uses #0F1828 (locked via !important) so dark-mode clients
 *     don't auto-paint over it.
 */

const LOGO_URL = "https://averrow.com/logo-email-mark.png";
const FONT_BODY =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_MONO =
  "'SF Mono','Menlo',Consolas,'Courier New',monospace";

export interface EmailShellOptions {
  /** Browser tab / preview title. */
  title: string;
  /** Inbox preview line (rendered hidden in DOM). */
  preheader: string;
  /** Tagline rendered under "AVERROW" in the header. */
  tagline?: string;
  /** Accent colour for the thin strip below the header. Defaults to amber. */
  accent?: string;
  /** Optional right-hand badge in the header (e.g. an OPERATIONAL chip). */
  headerBadge?: string;
  /** Body cell HTML between header and footer. */
  body: string;
  /** Optional footer note rendered above the brand line (e.g. recipient hint). */
  footerNote?: string;
  /** Override the default page background. Defaults to #060A14 (Deep Space). */
  pageBg?: string;
}

export function emailShell(opts: EmailShellOptions): string {
  const accent = opts.accent ?? "#E5A832";
  const pageBg = opts.pageBg ?? "#060A14";
  const tagline = opts.tagline ?? "THREAT INTERCEPTOR";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<style>
  :root{color-scheme:light dark;supported-color-schemes:light dark;}
  /* Lock the dark-by-design surfaces so dark-mode helpers don't repaint them. */
  .av-page         { background:${pageBg} !important; }
  .av-card         { background:#0F1828 !important; }
  .av-brand-header { background:#0F1828 !important; }
  .av-brand-logo   { background:transparent !important; }
  .av-accent-line  { background:${accent} !important; }
  @media (prefers-color-scheme: dark) {
    .av-page         { background:${pageBg} !important; }
    .av-card         { background:#0F1828 !important; }
    .av-brand-header { background:#0F1828 !important; }
    .av-brand-logo   { background:transparent !important; }
    .av-accent-line  { background:${accent} !important; }
  }
  /* Gmail Android + iOS Mail counter-invert: re-flip the auto-inversion
     so the crimson Avro Arrow stays crimson. See abuse-mailbox-responder
     for the full PR-BB write-up. */
  [data-ogsc] .av-brand-logo,
  [data-ogsb] .av-brand-logo { filter: invert(1) hue-rotate(180deg) !important; }
  /* Modest hover affordance for the CTA button on desktop clients
     that respect inline :hover (Apple Mail does, Gmail doesn't). */
  a.av-cta:hover { filter: brightness(1.08); }
  /* Mobile widths: drop the 600px container down without breaking
     the table-based layout used everywhere else. */
  @media only screen and (max-width: 600px) {
    .av-shell { width:100% !important; max-width:100% !important; }
    .av-pad-x { padding-left:20px !important; padding-right:20px !important; }
  }
</style>
</head>
<body class="av-page" style="margin:0;padding:0;background:${pageBg};font-family:${FONT_BODY};color:#E2E8F0;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${pageBg};padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" class="av-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#0F1828;border:1px solid rgba(255,255,255,0.06);border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.55);">
      <!-- Header -->
      <tr><td class="av-brand-header av-pad-x" style="background:#0F1828;padding:22px 28px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle;width:46px;">
              <img class="av-brand-logo" src="${LOGO_URL}" width="38" height="38" alt="Averrow" style="display:block;width:38px;height:38px;border:0;outline:none;">
            </td>
            <td style="vertical-align:middle;padding-left:14px;">
              <div style="font-family:${FONT_BODY};font-size:18px;font-weight:800;color:#FFFFFF;letter-spacing:0.06em;line-height:1.1;">AVERROW</div>
              <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.24em;color:${accent};margin-top:3px;text-transform:uppercase;">${escapeHtml(tagline)}</div>
            </td>
            ${opts.headerBadge ? `<td style="vertical-align:middle;text-align:right;">${opts.headerBadge}</td>` : ""}
          </tr>
        </table>
      </td></tr>
      <!-- Accent strip -->
      <tr><td class="av-accent-line" style="height:3px;font-size:0;line-height:0;background:${accent};">&nbsp;</td></tr>
      <!-- Body -->
      <tr><td class="av-pad-x" style="padding:0;background:#0F1828;">${opts.body}</td></tr>
      <!-- Footer -->
      <tr><td class="av-pad-x" style="padding:22px 28px;border-top:1px solid rgba(255,255,255,0.06);background:#0B1320;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              ${opts.footerNote ? `<div style="font-family:${FONT_BODY};font-size:11px;line-height:1.55;color:#6B7A90;margin-bottom:10px;">${opts.footerNote}</div>` : ""}
              <div style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.22em;color:#8896AB;text-transform:uppercase;">AVERROW · THREAT INTERCEPTOR</div>
              <div style="font-family:${FONT_BODY};font-size:11px;color:#6B7A90;margin-top:4px;">
                <a href="https://averrow.com" style="color:${accent};text-decoration:none;">averrow.com</a>
                &nbsp;·&nbsp;
                LRX Enterprises Inc.
              </div>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function escapeHtml(str: string | null | undefined): string {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inline-styled header badge for the right side of the brand header
 * (used by the daily briefing to surface OPERATIONAL / DEGRADED).
 */
export function headerStatusBadge(label: string, kind: "ok" | "warn" | "alert"): string {
  const bg = kind === "ok" ? "#10b981" : kind === "warn" ? "#E5A832" : "#C83C3C";
  const fg = kind === "warn" ? "#1A1108" : "#FFFFFF";
  return `<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${bg};color:${fg};font-family:${FONT_MONO};font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;">${escapeHtml(label)}</span>`;
}
