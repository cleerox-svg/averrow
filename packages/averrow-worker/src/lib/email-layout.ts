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
 * Visual contract (facelift Phase 4 — R3 logo, indigo on graphite):
 *   - Logo: hosted R3 mark PNG at EMAIL_LOGO_URL
 *     (https://averrow.com/email/averrow-mark-r3.png, 144x144 shown at
 *     38x38) — a Worker route that re-serves the ops-built PNG with a
 *     one-year immutable cache for Gmail's image proxy
 *     (handlers/emailAssets.ts). Same asset as the abuse-mailbox-responder
 *     default. New filename, so no mail-proxy cache of the old mark applies.
 *   - Primary (CTA buttons, links, accent strip) is indigo #4c5cf8 with
 *     white text (5.0:1); #96acff for primary-coloured text on the dark
 *     card. Amber (#E5A832) is a STATUS colour only (warn badges).
 *   - Dark-mode armor: `data-ogsc` / `data-ogsb` counter-invert rules so
 *     Gmail Android + iOS Mail don't flip our intentionally-red mark to
 *     pink-on-white. Same pattern proven on the abuse-triage emails.
 *   - Header uses graphite #151619 (locked via !important) so dark-mode
 *     clients don't auto-paint over it.
 */

import { EMAIL_LOGO_URL, FACELIFT } from "../templates/brand";

const LOGO_URL = EMAIL_LOGO_URL;

/** Email palette — inline hex only (no CSS variables in mail clients). */
export const EMAIL_COLORS = {
  pageBg: FACELIFT.bgPage,          // #0a0b0e
  card: FACELIFT.bgCard,            // #151619
  footer: FACELIFT.bgCardDeep,      // #0f1013
  primary: FACELIFT.primary,        // #4c5cf8 — CTA fill, accent strip
  primaryText: FACELIFT.primaryText, // #96acff — links / eyebrows on the card
  text: FACELIFT.textPrimary,       // #f6f7f7
  textDim: FACELIFT.textSecondary,  // #c2c2c4
  textMuted: FACELIFT.textMuted,    // #8b8c8d
} as const;

/** Inline style for the primary CTA button: indigo fill, white text. */
export const EMAIL_CTA_STYLE =
  `display:inline-block;padding:14px 36px;background-color:${FACELIFT.primary};background:${FACELIFT.primary};color:#FFFFFF;font-family:'SF Mono','Menlo',Consolas,monospace;font-size:12px;font-weight:700;letter-spacing:0.18em;text-decoration:none;border-radius:8px;text-transform:uppercase;`;
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
  /** Accent colour for the thin strip below the header. Defaults to indigo
   *  (primary). Pass a status colour only for a status email (alerts). */
  accent?: string;
  /** Optional right-hand badge in the header (e.g. an OPERATIONAL chip). */
  headerBadge?: string;
  /** Body cell HTML between header and footer. */
  body: string;
  /** Optional footer note rendered above the brand line (e.g. recipient hint). */
  footerNote?: string;
  /** Override the default page background. Defaults to graphite #0a0b0e. */
  pageBg?: string;
}

export function emailShell(opts: EmailShellOptions): string {
  const accent = opts.accent ?? EMAIL_COLORS.primary;
  // Indigo at 9px on the card is below AA; use the primary-text tint for
  // the tagline when the accent is the primary. Status accents keep theirs.
  const taglineColor = accent === EMAIL_COLORS.primary ? EMAIL_COLORS.primaryText : accent;
  const pageBg = opts.pageBg ?? EMAIL_COLORS.pageBg;
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
  .av-card         { background:${EMAIL_COLORS.card} !important; }
  .av-brand-header { background:${EMAIL_COLORS.card} !important; }
  .av-brand-logo   { background:transparent !important; }
  .av-accent-line  { background:${accent} !important; }
  @media (prefers-color-scheme: dark) {
    .av-page         { background:${pageBg} !important; }
    .av-card         { background:${EMAIL_COLORS.card} !important; }
    .av-brand-header { background:${EMAIL_COLORS.card} !important; }
    .av-brand-logo   { background:transparent !important; }
    .av-accent-line  { background:${accent} !important; }
  }
  /* Gmail Android + iOS Mail counter-invert: re-flip the auto-inversion
     so the red R3 mark stays red. See abuse-mailbox-responder
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
<body class="av-page" style="margin:0;padding:0;background:${pageBg};font-family:${FONT_BODY};color:${EMAIL_COLORS.text};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${pageBg};padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" class="av-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${EMAIL_COLORS.card};border:1px solid rgba(255,255,255,0.06);border-radius:14px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.55);">
      <!-- Header -->
      <tr><td class="av-brand-header av-pad-x" style="background:${EMAIL_COLORS.card};padding:22px 28px;border-bottom:1px solid rgba(255,255,255,0.06);">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:middle;width:46px;">
              <img class="av-brand-logo" src="${LOGO_URL}" width="38" height="38" alt="Averrow" style="display:block;width:38px;height:38px;border:0;outline:none;">
            </td>
            <td style="vertical-align:middle;padding-left:14px;">
              <div style="font-family:${FONT_BODY};font-size:18px;font-weight:800;color:#FFFFFF;letter-spacing:0.06em;line-height:1.1;">AVERROW</div>
              <div style="font-family:${FONT_MONO};font-size:9px;letter-spacing:0.24em;color:${taglineColor};margin-top:3px;text-transform:uppercase;">${escapeHtml(tagline)}</div>
            </td>
            ${opts.headerBadge ? `<td style="vertical-align:middle;text-align:right;">${opts.headerBadge}</td>` : ""}
          </tr>
        </table>
      </td></tr>
      <!-- Accent strip -->
      <tr><td class="av-accent-line" style="height:3px;font-size:0;line-height:0;background:${accent};">&nbsp;</td></tr>
      <!-- Body -->
      <tr><td class="av-pad-x" style="padding:0;background:${EMAIL_COLORS.card};">${opts.body}</td></tr>
      <!-- Footer -->
      <tr><td class="av-pad-x" style="padding:22px 28px;border-top:1px solid rgba(255,255,255,0.06);background:${EMAIL_COLORS.footer};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              ${opts.footerNote ? `<div style="font-family:${FONT_BODY};font-size:11px;line-height:1.55;color:${EMAIL_COLORS.textMuted};margin-bottom:10px;">${opts.footerNote}</div>` : ""}
              <div style="font-family:${FONT_MONO};font-size:10px;letter-spacing:0.22em;color:#a1a1a3;text-transform:uppercase;">AVERROW · THREAT INTERCEPTOR</div>
              <div style="font-family:${FONT_BODY};font-size:11px;color:${EMAIL_COLORS.textMuted};margin-top:4px;">
                <a href="https://averrow.com" style="color:${EMAIL_COLORS.primaryText};text-decoration:none;">averrow.com</a>
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
