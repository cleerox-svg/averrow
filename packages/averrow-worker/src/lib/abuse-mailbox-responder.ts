/**
 * Averrow — Abuse Mailbox responder
 *
 * Wave-3 PR-AD: ack-on-receipt + determination emails for the
 * abuse_inbox_messages flow. Pairs with:
 *   - handlers/abuseMailboxEmail.ts  (calls sendAck after INSERT)
 *   - lib/abuse-mailbox-determination.ts (calls sendDetermination once a
 *     verdict exists — rules or AI — behind an atomic exactly-once claim)
 *
 * Both paths are best-effort: a Resend failure stamps an error
 * breadcrumb to console.warn but never propagates — losing an
 * outbound email is far better than losing the inbound capture.
 *
 * Suppression rules — we DON'T send to:
 *   - empty / malformed addresses
 *   - addresses on our own domains (would loop back into the same
 *     inbox handler if the recipient bounces or auto-replies)
 *   - obvious harvester / probe submissions (no submitter address
 *     extractable from the forwarded body)
 *
 * The submitter SLA from the marketing report-abuse page is:
 *   "instant ack + determination within 24 hours"
 * Ack runs synchronously from the email handler (typical latency
 * ~1-3 seconds end-to-end). The determination is sent by the
 * per-message AbuseMailboxTriageWorkflow a couple of minutes after
 * receipt (rules-based verdict, no AI required); the hourly
 * `17 * * * *` sweeper delivers anything the Workflow missed.
 */
import type { Env } from "../types";
import { logger } from "./logger";
import { registrableDomain } from "./domain-utils";
import {
  type AbuseBranding,
  DEFAULT_ABUSE_BRANDING,
  fromAddressFor,
} from "./abuse-mailbox-branding";

const SELF_DOMAINS = new Set([
  "averrow.com", "www.averrow.com",
  "averrow.ca", "www.averrow.ca",
  "trustradar.ca", "www.trustradar.ca",
  "lrxradar.com", "www.lrxradar.com",
]);

/**
 * Decide whether to send a responder email to `toAddress`. Suppresses
 * empty/malformed addresses, own-domain loops, and submissions where
 * the original submitter never identified themselves (a noreply
 * forwarder, harvester probe, etc.).
 *
 * The returned reason is logged on suppression so the operator can
 * audit silent drops in the abuse-mailbox surface.
 */
export function shouldRespond(toAddress: string | null | undefined): { send: boolean; reason: string } {
  if (!toAddress) return { send: false, reason: "no-address" };
  const trimmed = toAddress.trim().toLowerCase();
  if (!trimmed) return { send: false, reason: "empty-address" };
  // Same strict single-address validator the ingest guard used — the
  // recipient handed to Resend is always exactly one plain mailbox.
  const parsed = parseSingleRecipient(trimmed);
  if (!parsed || parsed !== trimmed) return { send: false, reason: "malformed-address" };
  const domain = parsed.slice(parsed.indexOf("@") + 1);
  if (SELF_DOMAINS.has(domain)) return { send: false, reason: "own-domain-loop" };
  // Obvious noreply senders — we still send because some legit
  // platforms (Gmail group forwards) use 'noreply' in the From line
  // but accept replies. Reverse: a forwarded message FROM noreply
  // is fine to reply to since the human operator set up the forward.
  return { send: true, reason: "ok" };
}

// RFC 5322 dot-atom local part (no quoted local parts) @ LDH hostname.
const MAILBOX_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Strict single-mailbox parser for a From header value (or a bare
 * address). Returns the lower-cased plain address, or null when the value
 * is anything other than exactly ONE mailbox:
 *   - quoted display names are removed first (so `"Doe, John" <j@x.com>` is
 *     fine), then any remaining `,` / `;` (address lists, or several From
 *     headers merged by the header parser) rejects;
 *   - at most one `<…>` pair, and it must be the only `@`-bearing part;
 *   - the address itself must be a plain dot-atom mailbox (MAILBOX_RE),
 *     <= 254 chars.
 * Pure. Used ONCE at ingest; the normalized value is stored as
 * forwarded_by_email and is the exact Resend `to`.
 */
export function parseSingleRecipient(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.replace(/[\r\n]+/g, " ").trim();
  if (!v) return null;
  // Strip quoted display-name strings (with backslash escapes).
  v = v.replace(/"(?:[^"\\]|\\.)*"/g, " ");
  if (v.includes('"')) return null;               // unbalanced quote
  if (/[,;]/.test(v)) return null;                // list / merged headers
  if ((v.match(/@/g) ?? []).length !== 1) return null;
  const opens = (v.match(/</g) ?? []).length;
  const closes = (v.match(/>/g) ?? []).length;
  let addr: string;
  if (opens === 0 && closes === 0) {
    addr = v.trim();
  } else if (opens === 1 && closes === 1) {
    const m = /^([^<>]*)<([^<>]*)>\s*$/.exec(v);
    if (!m) return null;
    addr = (m[2] ?? "").trim();
  } else {
    return null;
  }
  addr = addr.toLowerCase();
  if (addr.length > 254 || !MAILBOX_RE.test(addr)) return null;
  return addr;
}

/** Our receiving MTA's authserv-id. Only Authentication-Results headers
 *  carrying it are trusted — any other authserv-id (including headers that
 *  arrived inside the message) is attacker-suppliable. */
export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

interface ParsedAuthHeader {
  authservId: string;
  dmarc: string | null;
  dmarcHeaderFrom: string | null;
}

/** Parse one Authentication-Results / ARC-Authentication-Results value. */
export function parseAuthResultsHeader(value: string): ParsedAuthHeader | null {
  // Comments (RFC 8601 CFWS) can contain ';' — drop them first.
  let flat = value.replace(/\s+/g, " ");
  for (let i = 0; i < 3; i++) flat = flat.replace(/\([^()]*\)/g, " ");
  const parts = flat.split(";").map((p) => p.trim()).filter((p) => p.length > 0);
  // ARC-Authentication-Results starts with the instance tag "i=N".
  if (parts[0] && /^i\s*=\s*\d+$/i.test(parts[0])) parts.shift();
  const authservId = (parts.shift() ?? "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!authservId) return null;
  let dmarc: string | null = null;
  let dmarcHeaderFrom: string | null = null;
  for (const p of parts) {
    const m = /^dmarc\s*=\s*([a-z]+)/i.exec(p);
    if (!m) continue;
    dmarc = (m[1] ?? "").toLowerCase();
    const hf = /\bheader\.from\s*=\s*([^\s;]+)/i.exec(p);
    dmarcHeaderFrom = hf?.[1] ? hf[1].toLowerCase().replace(/\.$/, "") : null;
    break;
  }
  return { authservId, dmarc, dmarcHeaderFrom };
}

/**
 * Backscatter guard — POSITIVE authentication. The ack / determination go
 * to the header-From of the forward, which a sender can forge; replying to
 * a forged From would make us a backscatter source. Reply ONLY when:
 *
 *   1. the header-From parses as exactly one mailbox (parseSingleRecipient);
 *   2. its registrable domain equals the SMTP envelope sender's;
 *   3. the TOPMOST Authentication-Results header whose authserv-id is
 *      mx.cloudflare.net (falling back to the topmost such
 *      ARC-Authentication-Results) exists — every header with any other
 *      authserv-id is ignored — and
 *   4. it reports dmarc=pass with header.from equal to the header-From
 *      domain.
 *
 * Headers are passed in message order (topmost first). Pure. `reason` is a
 * fixed code stamped into abuse_inbox_messages.responder_suppressed_reason
 * when `send` is false; `recipient` is the single normalized address to
 * store and to hand to Resend.
 */
export function decideBackscatterGuard(input: {
  headerFrom:   string | null | undefined;
  envelopeFrom: string | null | undefined;
  authResultsHeaders:    ReadonlyArray<string>;
  arcAuthResultsHeaders: ReadonlyArray<string>;
}): { send: boolean; reason: string; recipient: string | null } {
  const recipient = parseSingleRecipient(input.headerFrom);
  if (!recipient) return { send: false, reason: "backscatter:invalid_recipient", recipient: null };
  const fromDomain = recipient.slice(recipient.indexOf("@") + 1);

  const envelope = parseSingleRecipient(input.envelopeFrom);
  const regOf = (d: string): string => registrableDomain(d) ?? d;
  if (!envelope || regOf(envelope.slice(envelope.indexOf("@") + 1)) !== regOf(fromDomain)) {
    return { send: false, reason: "backscatter:domain_mismatch", recipient };
  }

  const trusted = (headers: ReadonlyArray<string>): ParsedAuthHeader | null => {
    for (const h of headers) {
      const p = parseAuthResultsHeader(h);
      if (p && p.authservId === TRUSTED_AUTHSERV_ID) return p;
    }
    return null;
  };
  const auth = trusted(input.authResultsHeaders) ?? trusted(input.arcAuthResultsHeaders);
  if (!auth) return { send: false, reason: "backscatter:no_trusted_auth", recipient };
  if (auth.dmarc !== "pass") return { send: false, reason: "backscatter:dmarc_not_pass", recipient };
  if (auth.dmarcHeaderFrom !== fromDomain) {
    return { send: false, reason: "backscatter:domain_mismatch", recipient };
  }
  return { send: true, reason: "ok", recipient };
}

interface ResendBody {
  id?: string;
  name?: string;
  message?: string;
  error?: string;
}

async function sendViaResend(
  apiKey: string,
  fromAddress: string,
  to: string,
  subject: string,
  html: string,
  text: string,
  /** Extra headers passed through to the recipient (List-Unsubscribe etc).
   *  Resend forwards these verbatim. */
  extraHeaders?: Record<string, string>,
  /** Address the recipient's Reply lands at. Routed to the same
   *  inbound alias the submitter forwarded to originally, so the
   *  classifier picks the reply up as a follow_up row. Null/undef
   *  → no reply_to in the payload (Resend defaults to From). */
  replyTo?: string | null,
  /** Resend Idempotency-Key: a retried POST with the same key within 24h
   *  is not sent twice. */
  idempotencyKey?: string,
): Promise<{ ok: boolean; error?: string; status?: number }> {
  try {
    const body: Record<string, unknown> = {
      from: fromAddress,
      to: [to],
      subject,
      html,
      text,
    };
    if (replyTo) {
      body.reply_to = replyTo;
    }
    if (extraHeaders && Object.keys(extraHeaders).length > 0) {
      body.headers = extraHeaders;
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let parsed: ResendBody = {};
      try { parsed = JSON.parse(body) as ResendBody; } catch { /* non-JSON */ }
      const err = [
        `HTTP ${res.status}`,
        parsed.name ?? null,
        parsed.message ?? parsed.error ?? body.slice(0, 200),
      ].filter(Boolean).join(" / ");
      return { ok: false, error: err, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Resend statuses that mean the request (recipient / payload) itself is
 *  invalid — retrying cannot succeed. 401/403 (our key) and 429/5xx are
 *  transient from the row's point of view. */
export function isPermanentResendStatus(status: number | undefined): boolean {
  return status === 400 || status === 422;
}

/**
 * Defang URLs / domains / IPv4s in attacker-controlled text we echo back
 * (the forwarded subject): schemes are stripped and the dots of
 * domain-like tokens become "[.]", so mail clients don't auto-link them.
 */
export function defangForEcho(s: string): string {
  return s
    .replace(/\b(?:h(?:tt|xx)ps?|ftp):\/\//gi, "")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => ip.replace(/\./g, "[.]"))
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b/gi, (d) => d.replace(/\./g, "[.]"));
}

// ─── Brand layout (shared by ack + determination) ──────────────
//
// Branded HTML email layout used by both responders. Built for inline-
// only styling (no external CSS, no web fonts) because most clients
// (Gmail, Outlook, Apple Mail) strip <link>/<style> tags and refuse
// external font loads.
//
// PR-AR — Logo + fonts:
//
// 1. Logo. Gmail's sanitiser silently drops inline <svg> AND blocks
//    SVG when referenced via <img src=".svg">, so the previous two
//    treatments (raw SVG, then SVG-in-img) both rendered an empty
//    box. Solution: recreate the Avro Arrow brandmark using HTML +
//    CSS only. A 38×38 dark-navy rounded square contains a Unicode
//    upward triangle ▲ (U+25B2) coloured platform-red #C83C3C — the
//    same shape language as packages/averrow-worker/public/favicon.svg
//    without depending on any image-rendering pipeline. Renders
//    identically in Gmail, Apple Mail, Outlook 365 web, Yahoo, and
//    iOS/Android Mail.
//
// 2. Fonts. Pulled from packages/averrow-ops/tailwind.config.ts
//    + index.css — the platform body uses 'Plus Jakarta Sans' and
//    mono blocks use 'JetBrains Mono'. Email clients other than
//    Apple Mail won't actually fetch these, but listing them at the
//    head of the stack means Apple Mail (which DOES load custom
//    fonts via the system fallback chain when installed) and any
//    desktop client where the user has Plus Jakarta Sans installed
//    will pick it up. Everyone else falls through to -apple-system
//    / BlinkMacSystemFont / Segoe UI — same as platform behaviour
//    on a fresh device before the @font-face fetch completes.
//
// Brand language follows AVERROW_UI_STANDARD.md and CLAUDE.md §5:
//   - amber #E5A832 for accents + brand colour
//   - red    #C83C3C for the brandmark + critical verdicts
//   - dark slate header (#0F1828) matching --bg-page
//   - off-white body for readability in email clients
//
// Layout: 600px-wide centered card on a neutral background. Header
// bar with logo + product name. Accent stripe under header. Body.
// Footer with marketing-page link + "why am I getting this".

const FONT_BODY = `'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const FONT_MONO = `'JetBrains Mono','IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace`;


interface BrandLayoutOptions {
  /** Hex colour for the 4px accent stripe under the header. Defaults to the brand accent. */
  accent?: string;
  /** Tag printed above the headline (e.g. "Report received" or "Determination"). */
  preheaderTag: string;
  /** The bold headline text. */
  headline: string;
  /** Inner HTML for the main body. Assume well-formed inline-styled blocks. */
  bodyHtml: string;
  /** Per-org branding (header name/logo/colours/footer links). */
  branding: AbuseBranding;
}

function brandLayout(opts: BrandLayoutOptions): string {
  const b = opts.branding;
  const accent = opts.accent ?? b.accent;
  // Logo: hosted PNG of the platform favicon, mark-only.
  //
  // PR-BF (2026-05-18): reverted PR-BB's `data:image/png;base64,...`
  // approach. Gmail mobile (Android in particular) refuses to render
  // <img src="data:..."> for security reasons — the broken-image
  // placeholder customers reported was the data URI being stripped
  // by the mobile client. Back to a hosted URL so Gmail's image
  // proxy fetches it normally.
  //
  // To fix the OTHER half — the original PR-BB symptom (Gmail proxy
  // intermittently failing to load the hosted asset due to
  // revalidation misses on the default `cache-control: max-age=0,
  // must-revalidate` header) — PR-BF added a per-path
  //   Cache-Control: public, max-age=31536000, immutable
  // rule in public/_headers for /logo-email*.png. Long cache means
  // the proxy fetches once, caches for a year, never re-validates.
  // Exactly the right behaviour for a brandmark that essentially
  // never changes (and would get a new filename if it did).
  //
  // The [data-ogsc] / [data-ogsb] counter-invert CSS below (also
  // from PR-BB) is preserved: when the image DOES load on Gmail
  // Android dark mode, the CSS counter-inverts the auto-flip so
  // the logo's designed crimson red survives. Harmless when no
  // dark-mode marker attribute is present.
  //
  // Source asset: public/favicon-mark.svg + scripts/generate-logo-assets.py
  // → public/logo-email-mark.png (served at the URL below with the
  //   PR-BF long-cache header from _headers).
  const logoCell = `<img class="av-brand-logo" src="${escapeAttr(b.logoUrl)}" width="38" height="38" alt="${escapeAttr(b.logoAlt)}" style="display:block;width:38px;height:38px;border:0;outline:none;">`;
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- PR-BA: tell Gmail mobile / iOS Mail / dark-mode-aware clients
     that this email is intentionally designed for both light and
     dark backgrounds. Without these declarations Gmail mobile's
     "dark mode helper" sees our dark-navy logo tile (#080E18) and
     auto-inverts it to white, flipping the PNG to red-on-white. -->
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  /* Pin the brand palette so dark-mode clients don't transform it.
     The body card stays light; only the dark-on-purpose header +
     accent strip are locked. PR-BA covered .av-brand-header (the
     dark-navy strip behind the logo). 2026-05-17 user report
     surfaced two follow-ups:
       1. .av-brand-logo background isn't needed any more — the IMG
          is mark-only now (no tile), so no background to lock.
          Kept here as a no-op safety in case any client paints
          behind the transparent IMG.
       2. .av-accent-line was a bare inline-style TD — Gmail
          Android inverted its color (amber → violet for the
          common case). Re-asserting it here with !important + the
          per-verdict dynamic accent. */
  .av-brand-header { background:${b.headerBg} !important; }
  .av-brand-logo   { background:transparent !important; }
  .av-accent-line  { background:${accent} !important; }
  @media (prefers-color-scheme: dark) {
    .av-brand-header { background:${b.headerBg} !important; }
    .av-brand-logo   { background:transparent !important; }
    .av-accent-line  { background:${accent} !important; }
  }
  /* PR-BB: Gmail Android dark mode counter-invert.
     Gmail Android applies a per-image color inversion to images
     classified as "dark with some color content" — flipping our
     red Avro Arrow PNG to a near-white pink. The body element gets
     a data-ogsc attribute when Gmail Android applies dark mode.
     Targeting [data-ogsc] .av-brand-logo with filter: invert(1)
     hue-rotate(180deg) re-inverts what Gmail just inverted —
     net result: the red arrow stays red.
     hue-rotate(180deg) is the colour-correction follow-up to
     filter:invert (invert flips the hue too; rotating brings it
     back to the original). The combination is the canonical Gmail
     Android dark-mode workaround. */
  [data-ogsc] .av-brand-logo {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  /* iOS Mail dark mode marker (parallels data-ogsc). Safe no-op
     if not applied. */
  [data-ogsb] .av-brand-logo {
    filter: invert(1) hue-rotate(180deg) !important;
  }
</style>
<title>${escapeHtml(opts.headline)} — ${escapeHtml(b.productName)}</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:${FONT_BODY};color:#1A2536;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheaderTag)} — ${escapeHtml(b.fromName)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:32px 16px;font-family:${FONT_BODY};">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:12px;box-shadow:0 4px 20px rgba(15,24,40,0.08);overflow:hidden;">
        <tr><td class="av-brand-header" style="background:${b.headerBg};padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:middle;">${logoCell}</td>
              <td style="vertical-align:middle;padding-left:12px;">
                <div style="font-family:${FONT_BODY};font-size:20px;font-weight:800;color:#FFFFFF;letter-spacing:-0.01em;line-height:1.1;">${escapeHtml(b.productName)}</div>
                <div style="font-family:${FONT_BODY};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${accent};font-weight:700;margin-top:3px;line-height:1;">${escapeHtml(b.tagline)}</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td class="av-accent-line" style="height:4px;background:${accent};line-height:4px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-family:${FONT_BODY};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#8895AA;font-weight:600;">${escapeHtml(opts.preheaderTag)}</div>
          <h1 style="margin:6px 0 0;font-family:${FONT_BODY};font-size:26px;font-weight:800;color:#0F1828;line-height:1.25;letter-spacing:-0.015em;">${escapeHtml(opts.headline)}</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;font-family:${FONT_BODY};font-size:15px;line-height:1.6;color:#1A2536;">
          ${opts.bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 32px 22px;border-top:1px solid #E5E8EE;background:#FAFBFC;font-family:${FONT_BODY};">
          <p style="margin:0 0 10px;font-size:13px;color:#1A2536;line-height:1.5;font-weight:600;">
            <a href="${escapeAttr(b.websiteUrl)}" style="color:#0F1828;text-decoration:none;font-weight:700;">${escapeHtml(b.websiteLabel)}</a>
            <span style="color:#8895AA;font-weight:400;"> · ${escapeHtml(b.footerNote)}</span>
          </p>
          <p style="margin:0 0 6px;font-size:11px;color:#8895AA;line-height:1.5;">
            Report another threat → <a href="${escapeAttr(b.reportUrl)}" style="color:${accent};text-decoration:underline;font-weight:600;">${escapeHtml(b.reportLabel)}</a>
          </p>
          <p style="margin:0;font-size:11px;color:#8895AA;line-height:1.5;">
            You received this because your address sent or forwarded a message to one of ${escapeHtml(b.productName)}'s public abuse mailboxes. Not yours? Ignore this email — no action needed.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ─── Ack-on-receipt ─────────────────────────────────────────────

interface AckContext {
  /** abuse_inbox_messages.id — used in the email subject so a
   *  reply from the submitter can be threaded by support. */
  messageId: string;
  /** abuse_inbox_messages.original_subject — what the submitter
   *  forwarded. Echoing it back proves we received the right one. */
  originalSubject: string | null;
  /** Public alias the submission hit (abuse@/phishing@/report@/security@). */
  inboundAlias: string;
}

/**
 * Ack body copy (shared by HTML + text). Honest about what happens next:
 * indicators are checked against threat intelligence by deterministic
 * rules; a match yields a determination within minutes, anything else
 * goes to an analyst and the reporter is told so. No AI claim — the
 * determination does not depend on an AI call.
 */
export function ackExplainer(productName: string): string {
  return `The ${productName} platform extracts indicators (links, sender headers, sending IP, attachments) ` +
    `and checks them against our threat-intelligence feeds. If they match known malicious activity, ` +
    `you'll receive a determination email shortly. Otherwise your report goes to an analyst for review ` +
    `and you'll get an email confirming that.`;
}

function ackHtml(ctx: AckContext, b: AbuseBranding): string {
  const echoSubject = ctx.originalSubject
    ? `<div style="margin:18px 0 10px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#8895AA;">Subject we received</div>
       <div style="margin:0 0 18px;padding:12px 16px;border-left:3px solid #E5A832;background:#FAFBFC;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#1A2536;border-radius:0 6px 6px 0;">${escapeHtml(defangForEcho(ctx.originalSubject))}</div>`
    : "";
  const body = `
    <p style="margin:0 0 14px;">Thanks for the report. Your submission is in our system and queued for automated inspection.</p>
    <p style="margin:0 0 14px;color:#4A5868;">${escapeHtml(ackExplainer(b.productName))}</p>
    ${echoSubject}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-collapse:collapse;">
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#8895AA;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Reference</td>
        <td style="padding:4px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#0F1828;">${escapeHtml(ctx.messageId)}</td>
      </tr>
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#8895AA;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Inbox</td>
        <td style="padding:4px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#E5A832;">${escapeHtml(ctx.inboundAlias)}</td>
      </tr>
    </table>
  `;
  return brandLayout({
    preheaderTag: "Report received",
    headline: "Thanks — your report is in",
    bodyHtml: body,
    branding: b,
  });
}

function ackText(ctx: AckContext, b: AbuseBranding): string {
  const echo = ctx.originalSubject ? `\n\nSubject we received:\n  ${defangForEcho(ctx.originalSubject)}` : "";
  return `Thanks — your report is in.

Your submission is queued for automated inspection. ${ackExplainer(b.productName)}${echo}

Reference: ${ctx.messageId}
Inbox: ${ctx.inboundAlias}

— ${b.fromName}
${b.reportUrl}
`;
}

/**
 * Send the instant-ack email to `toAddress`. Caller is responsible
 * for marking abuse_inbox_messages.ack_sent_at = datetime('now') on
 * success. Returns ok=false (with reason) on any failure so the
 * caller can decide whether to retry on the next pass.
 */
export async function sendAck(
  env: Env,
  toAddress: string | null | undefined,
  ctx: AckContext,
  branding: AbuseBranding = DEFAULT_ABUSE_BRANDING,
): Promise<{ ok: boolean; reason: string }> {
  const decision = shouldRespond(toAddress);
  if (!decision.send) return { ok: false, reason: decision.reason };
  if (!env.RESEND_API_KEY) return { ok: false, reason: "no-resend-key" };

  const cleanedTo = toAddress!.trim().toLowerCase();

  // Honour List-Unsubscribe opt-outs (PR-BC). Idempotent — duplicate
  // sends to opted-out recipients silently no-op rather than burning
  // the Resend quota AND the recipient's tolerance.
  if (await isOptedOut(env, cleanedTo)) {
    return { ok: false, reason: "opted-out" };
  }

  // Subject (PR-BC): drop the embedded original phishing/spam
  // subject. Gmail's content classifier scores phishing-language in
  // OUR subject against us, so quoting "Urgent: Netflix expires
  // today" inside our subject scored these mails as suspicious for
  // some recipients. The original subject is still visible in the
  // body under "Subject we received". The 8-char prefix of the
  // message UUID gives a stable Ref for support-side correlation.
  const ref = ctx.messageId.slice(0, 8);
  const subject = `${branding.subjectPrefix} · Report received (Ref: ${ref})`;
  const html = ackHtml(ctx, branding);
  const text = ackText(ctx, branding);

  // List-Unsubscribe + one-click POST (RFC 8058). Gives Gmail a
  // recipient-controlled exit ramp — required to keep deliverability
  // for senders Gmail considers "bulk-adjacent" and a strong positive
  // reputation signal regardless of volume.
  const { unsubscribeUrl } = await import("../handlers/abuseMailboxUnsubscribe");
  // L5: unsubscribeUrl returns null when ABUSE_UNSUBSCRIBE_SECRET is
  // unset — omit the headers entirely rather than emit a broken link.
  const unsubUrl = await unsubscribeUrl(env, cleanedTo, ctx.messageId);
  const extraHeaders = unsubUrl ? {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  } : undefined;

  const res = await sendViaResend(
    env.RESEND_API_KEY, fromAddressFor(branding), cleanedTo, subject, html, text, extraHeaders,
    ctx.inboundAlias, `abuse-ack/${ctx.messageId}`,
  );
  if (!res.ok) {
    logger.warn("abuse_mailbox_ack_send_failed", { error: res.error, to: toAddress, msg_id: ctx.messageId });
    return { ok: false, reason: res.error ?? "send-failed" };
  }
  return { ok: true, reason: "sent" };
}

/** Look up email_optouts. Returns true if the recipient has opted
 *  out via a List-Unsubscribe one-click (or any other source row). */
async function isOptedOut(env: Env, email: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS y FROM email_optouts WHERE email = ? LIMIT 1",
    ).bind(email).first<{ y: number }>();
    return !!row;
  } catch (err) {
    // Table may not exist yet on dev DBs; never block on this check.
    console.warn("[abuse-mailbox-responder] optout lookup failed:", err);
    return false;
  }
}

// ─── Determination ──────────────────────────────────────────────

interface DeterminationContext {
  messageId: string;
  /** The inbound alias the submitter originally forwarded TO
   *  (e.g. phishing@averrow.ca). Used as reply_to so the recipient's
   *  reply lands back in the abuse-mailbox classifier pipeline and
   *  gets tagged as `follow_up` on intake. Nullable to allow legacy
   *  callers / rows where the alias wasn't recorded. */
  inboundAlias: string | null;
  originalSubject: string | null;
  classification: string;   // phishing | spam | benign | malware | ambiguous
  confidence: number;       // 0-100
  // No model/rules reasoning field: "Analyst notes" is always FIXED copy
  // (RULES_EMAIL_NOTE / AI_EMAIL_NOTE) so attacker-influenced model output
  // can never reach the reporter (prompt-injection).
  action: string;           // safe | review | escalate | takedown
  // ── PR-AY: richer context surfaced in the determination email ──
  // All optional/nullable so legacy callers continue to work; absent
  // fields just suppress the matching findings bullet.
  authResults?: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  urlCount?: number | null;
  attachmentCount?: number | null;
  correlatedCount?: number | null;   // platform threats this submission already matches
  promotedCount?: number | null;     // platform threats this submission CREATED
  // PR-BC — sanitized investigator narrative from the Sonnet deep
  // analyzer. Only populated on HIGH/CRITICAL phishing/malware
  // verdicts where the Sonnet pass succeeded. The deep analyzer
  // already strips IPs/URLs/emails before this gets here, and the
  // sanitizeForExternalEmail helper below is a defense-in-depth
  // second pass in case the model leaked anything past the prompt.
  deepAnalysisExternal?: string | null;
  /** abuse_inbox_messages.classified_by. 'rules' switches the email to
   *  the deterministic-verdict copy: no confidence %, a FIXED analyst
   *  note per rule, never the stored reason codes. */
  classifiedBy?: string | null;
  /** Primary rule for a rules verdict (M1–M4) or 'review'. */
  rulesRule?: "M1" | "M2" | "M3" | "M4" | "review" | null;
}

/** Fixed recipient-facing analyst note per rule. Never includes message
 *  content, matched strings, or reason codes. */
export const RULES_EMAIL_NOTE: Record<"M1" | "M2" | "M3" | "M4" | "review", string> = {
  M1: "Links in this message match infrastructure already confirmed malicious in our threat intelligence.",
  M2: "This message matches the signature of a known, named phishing campaign.",
  M3: "This message contains a device-code sign-in lure, a known account-takeover technique.",
  M4: "This message carries an executable or disk-image attachment type commonly used to deliver malware.",
  review: "Automated checks found no match against known malicious activity, so an analyst will review your report.",
};

/** First next-step for a rules review verdict. */
export const RULES_REVIEW_FIRST_STEP =
  "An analyst will review your report; we'll only contact you if we need more context.";

/** Fixed recipient-facing analyst note per AI verdict. The model's own
 *  reasoning is NEVER emailed — it is shaped by attacker-controlled
 *  message content (prompt-injection), so only these sentences go out. */
export const AI_EMAIL_NOTE: Record<string, string> = {
  phishing:  "Automated analysis found the hallmarks of a phishing attempt in this message.",
  malware:   "Automated analysis found indicators that this message delivers malicious software.",
  spam:      "Automated analysis found this to be unsolicited bulk email rather than a targeted threat.",
  benign:    "Automated analysis found no indicators of a threat in this message.",
  ambiguous: "Automated analysis could not reach a confident verdict, so an analyst will review your report.",
};

/** Verdict sources that are automated (no human decided the action). */
const AUTOMATED_SOURCES: ReadonlySet<string> = new Set(["rules", "ai", "auto_graduated"]);

/**
 * Human-readable "Action taken" for an ai_action value. An automated
 * verdict never claims "Takedown initiated" — no takedown is filed without
 * a human — it reads "Reported to our threat team" instead. Only a manual
 * (operator) verdict may say a takedown was initiated.
 */
export function humanizeAction(action: string | null | undefined, classifiedBy?: string | null): string {
  const automated = classifiedBy === undefined || classifiedBy === null || AUTOMATED_SOURCES.has(classifiedBy);
  switch (action) {
    case "takedown": return automated ? "Reported to our threat team" : "Takedown initiated";
    case "escalate": return "Reported to our threat team";
    case "review":   return "Queued for analyst review";
    case "safe":     return "No action needed";
    default:         return "Recorded";
  }
}

function isRulesVerdict(ctx: DeterminationContext): boolean {
  return ctx.classifiedBy === "rules";
}

/** Analyst-notes text: fixed per-rule sentence for rules verdicts, fixed
 *  per-classification sentence otherwise. Never model output. */
function analystNote(ctx: DeterminationContext): string {
  if (isRulesVerdict(ctx)) return RULES_EMAIL_NOTE[ctx.rulesRule ?? "review"];
  return AI_EMAIL_NOTE[ctx.classification] ?? AI_EMAIL_NOTE.ambiguous!;
}

/** Per-verdict next steps; rules review rows lead with the analyst line. */
function nextStepsFor(ctx: DeterminationContext, v: VerdictDef): ReadonlyArray<string> {
  if (isRulesVerdict(ctx) && (ctx.rulesRule ?? "review") === "review") {
    return [RULES_REVIEW_FIRST_STEP, ...v.nextSteps.slice(1)];
  }
  return v.nextSteps;
}

interface VerdictDef {
  label: string;
  /** Lead paragraph — sets the tone + tells the recipient what the verdict means. */
  lead: string;
  /** Bulleted "what you should do" actions. Per-verdict, plain-English. */
  nextSteps: ReadonlyArray<string>;
  /** Accent stripe colour under the brand header. */
  accent: string;
  /** Verdict-tone callout colour (for the "Verdict" pill block). */
  pillBg: string;
  pillFg: string;
  pillBorder: string;
}
const VERDICT_COPY: Record<string, VerdictDef> = {
  phishing: {
    label: "Phishing confirmed",
    lead:
      "We identified this as a phishing attempt. The goal of these messages is to steal credentials, payment info, " +
      "or get malware on your device by impersonating a legitimate brand. Don't click the links, don't reply, and " +
      "don't act on what the message asks for.",
    nextSteps: [
      "If you clicked a link or entered credentials before reporting, change those passwords now and notify your IT/security team.",
      "Block the sender at your email provider.",
      "Delete the original message — don't forward it, even with a 'be careful' note.",
    ],
    accent: "#C83C3C", pillBg: "#FBEDED", pillFg: "#911B1B", pillBorder: "#E8B5B5",
  },
  malware: {
    label: "Malware indicators found",
    lead:
      "We found malware indicators in the attached or linked content. Opening the attachment or clicking the " +
      "link could install software that steals data, ransoms your files, or gives an attacker remote access.",
    nextSteps: [
      "If you opened the attachment or clicked a link: disconnect from the network if you can, run a full antivirus scan, and contact your IT/security team immediately.",
      "Rotate any credentials you entered before or after the click.",
      "Don't forward the message — receivers can still click despite warnings.",
    ],
    accent: "#C83C3C", pillBg: "#FBEDED", pillFg: "#911B1B", pillBorder: "#E8B5B5",
  },
  spam: {
    label: "Spam",
    lead:
      "We classified this as unsolicited commercial email rather than a targeted threat. Annoying, but not " +
      "malicious. Your address is likely on a bulk list — that usually reflects exposure from a breach or a list " +
      "broker, not anything you did.",
    nextSteps: [
      "Look for an unsubscribe link inside the original message and use it if the sender appears legitimate.",
      "If they ignore the unsubscribe, mark the message as spam at your email provider — most providers will block similar senders going forward.",
      "Consider adding the sender's domain to your block list.",
    ],
    accent: "#E5A832", pillBg: "#FCF4E0", pillFg: "#7E5A12", pillBorder: "#EBD9A7",
  },
  benign: {
    label: "Likely safe",
    lead:
      "After review we don't believe this message is a threat. It may be a legitimate but unfamiliar sender, or a " +
      "marketing send from an opted-in list.",
    nextSteps: [
      "If something still feels off, reply to this email with more context and we'll re-inspect.",
      "If you're not sure who the sender is, ask the named brand through a known channel — their official website, not anything inside the message.",
    ],
    accent: "#3CB878", pillBg: "#E6F5EC", pillFg: "#1A6B3C", pillBorder: "#A6D9BB",
  },
  ambiguous: {
    label: "Needs human review",
    lead:
      "Our automated triage couldn't reach a confident verdict on its own. This usually means the message has " +
      "mixed signals — legitimate-looking but with suspicious phrasing, or a new pattern we haven't seen at scale yet.",
    nextSteps: [
      "A human analyst will reach out separately if we need more context from you. No further action needed on your side for now.",
      "Until then, don't act on anything the original message asks for.",
      "If the matter is urgent, contact your IT/security team directly through a known channel.",
    ],
    accent: "#A78BFA", pillBg: "#F0EBFD", pillFg: "#4C2D9E", pillBorder: "#CBBBF0",
  },
};

// ─── PR-BC external-narrative sanitizer ─────────────────────────
//
// Belt-and-suspenders pass on any string we're about to embed in
// an outbound email. The deep analyzer's Sonnet prompt explicitly
// forbids IPs/URLs/emails in the external narrative AND the
// analyzer itself runs a regex scrub before storing the result.
// This is a third gate at the email-send boundary — anything that
// slips through both upstream layers gets caught here.
//
// Patterns scrubbed:
//   IPv4 / IPv6  → "[ip]"
//   https URLs   → "[link]"
//   email addrs  → "[sender]"
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{0,4}\b/g;
const URL_RE  = /https?:\/\/[^\s<>"']+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function sanitizeForExternalEmail(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(URL_RE, "[link]")
    .replace(IPV4_RE, "[ip]")
    .replace(IPV6_RE, "[ip]")
    .replace(EMAIL_RE, "[sender]")
    .replace(/\s{2,}/g, " ")
    .trim() || null;
}

// ─── PR-AY helpers — translate raw signals into recipient-facing copy ───

/**
 * Map SPF / DKIM / DMARC verdicts to a single plain-English sentence.
 * The recipient is typically a non-technical employee, so we avoid the
 * acronyms and convert to the consequence ("looks like impersonation"
 * / "matches the legitimate sender").
 *
 * Returns null when no auth verdicts are present at all (header was
 * missing) — the caller suppresses the bullet entirely in that case.
 */
export function interpretAuth(
  auth: { spf: string | null; dkim: string | null; dmarc: string | null } | null | undefined,
  classification: string,
): string | null {
  if (!auth) return null;
  const verdicts = [auth.spf, auth.dkim, auth.dmarc].filter((v): v is string => Boolean(v));
  if (verdicts.length === 0) return null;
  const isFail = (v: string | null): boolean => v === "fail" || v === "permerror";
  const isPass = (v: string | null): boolean => v === "pass";
  const failed = verdicts.filter(isFail);
  const passed = verdicts.filter(isPass);

  if (failed.length > 0 && passed.length === 0) {
    return (classification === "phishing" || classification === "malware")
      ? "Email authentication failed — typical of an impersonated sender."
      : "Email authentication failed, which usually means the message wasn't actually sent from the address it claims.";
  }
  if (failed.length > 0) {
    return "Email authentication had mixed results — some checks failed, some passed. This can indicate a forwarded message or partial spoofing.";
  }
  if (passed.length === verdicts.length) {
    return (classification === "phishing" || classification === "malware")
      ? "Email authentication passed — the attacker controls the sending domain or has compromised a legitimate sender."
      : "Email authentication passed all checks, consistent with a legitimate sender.";
  }
  return "Email authentication ran but didn't produce a strong signal in either direction.";
}

/**
 * Build the bulleted findings list — what we actually looked at /
 * what changed in our threat intelligence as a result of this report.
 * Returns null when there's nothing meaningful to surface (legacy
 * row, ambiguous verdict on a sparse message).
 */
export type DeterminationContextForFindings = DeterminationContext;

export function buildFindings(ctx: DeterminationContext): string[] {
  const out: string[] = [];

  // Auth — only when there's a real verdict
  const authLine = interpretAuth(ctx.authResults, ctx.classification);
  if (authLine) out.push(authLine);

  // URL / promotion line — phrasing differs by verdict
  if (typeof ctx.urlCount === "number" && ctx.urlCount > 0) {
    const promoted = ctx.promotedCount ?? 0;
    if (promoted > 0) {
      out.push(
        `${ctx.urlCount} link${ctx.urlCount === 1 ? "" : "s"} in the message; ` +
        `${promoted} new indicator${promoted === 1 ? " has" : "s have"} been added to Averrow's threat intelligence. ` +
        `Your report makes the platform smarter for every customer we monitor.`
      );
    } else if (ctx.classification === "benign") {
      out.push(
        `${ctx.urlCount} link${ctx.urlCount === 1 ? "" : "s"} in the message, none matched our threat intelligence.`
      );
    } else if (ctx.classification === "spam") {
      out.push(
        `${ctx.urlCount} link${ctx.urlCount === 1 ? "" : "s"} in the message, mostly commercial — no malicious indicators.`
      );
    } else {
      out.push(
        `${ctx.urlCount} link${ctx.urlCount === 1 ? "" : "s"} were extracted and inspected.`
      );
    }
  }

  // Attachment line — only mention when present
  if (typeof ctx.attachmentCount === "number" && ctx.attachmentCount > 0) {
    if (ctx.classification === "malware") {
      out.push(
        `${ctx.attachmentCount} attachment${ctx.attachmentCount === 1 ? "" : "s"} flagged for malicious content.`
      );
    } else {
      out.push(
        `${ctx.attachmentCount} attachment${ctx.attachmentCount === 1 ? "" : "s"} were inspected.`
      );
    }
  }

  // Correlation line — strong "we've seen this before" signal
  if (typeof ctx.correlatedCount === "number" && ctx.correlatedCount > 0) {
    out.push(
      `${ctx.correlatedCount} indicator${ctx.correlatedCount === 1 ? "" : "s"} in this message match patterns ` +
      `we're already tracking on the platform — this looks like part of an ongoing campaign.`
    );
  }

  return out;
}

function determinationHtml(ctx: DeterminationContext, b: AbuseBranding): string {
  const v = VERDICT_COPY[ctx.classification] ?? VERDICT_COPY.ambiguous!;
  const echoSubject = ctx.originalSubject
    ? `<div style="margin:18px 0 10px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#8895AA;">Subject we triaged</div>
       <div style="margin:0 0 18px;padding:12px 16px;border-left:3px solid ${v.accent};background:#FAFBFC;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#1A2536;border-radius:0 6px 6px 0;">${escapeHtml(defangForEcho(ctx.originalSubject))}</div>`
    : "";

  const findings = buildFindings(ctx);
  const findingsBlock = findings.length > 0
    ? `<div style="margin:20px 0 0;padding:16px 18px;background:#FAFBFC;border:1px solid #E5E8EE;border-radius:8px;">
         <div style="font-size:11px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:#8895AA;margin-bottom:10px;">What we found</div>
         <ul style="margin:0;padding:0 0 0 18px;list-style:disc;color:#1A2536;font-size:14px;line-height:1.6;">
           ${findings.map((f) => `<li style="margin:0 0 6px;">${escapeHtml(f)}</li>`).join("")}
         </ul>
       </div>`
    : "";

  const steps = nextStepsFor(ctx, v);
  const nextStepsBlock = steps.length > 0
    ? `<div style="margin:16px 0 0;padding:16px 18px;background:#FFFFFF;border:1px solid ${v.pillBorder};border-radius:8px;border-left:4px solid ${v.accent};">
         <div style="font-size:11px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:${v.pillFg};margin-bottom:10px;">What you should do</div>
         <ul style="margin:0;padding:0 0 0 18px;list-style:disc;color:#1A2536;font-size:14px;line-height:1.6;">
           ${steps.map((s) => `<li style="margin:0 0 6px;">${escapeHtml(s)}</li>`).join("")}
         </ul>
       </div>`
    : "";

  // PR-BC investigator narrative — only present on HIGH/CRITICAL
  // confirmed verdicts where the Sonnet deep analyzer succeeded.
  // Triple-sanitized by this point (prompt + analyzer regex + final
  // email-boundary scrub) — IPs / URLs / sender emails are guaranteed
  // not to appear in the rendered output.
  const investigatorClean = sanitizeForExternalEmail(ctx.deepAnalysisExternal);
  const investigatorBlock = investigatorClean
    ? `<div style="margin:16px 0 0;padding:16px 18px;background:#FAFBFC;border:1px solid #E5E8EE;border-radius:8px;">
         <div style="font-size:11px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:#8895AA;margin-bottom:8px;">Investigator findings</div>
         <p style="margin:0;font-size:14px;line-height:1.6;color:#1A2536;">${escapeHtml(investigatorClean)}</p>
       </div>`
    : "";

  // Rules verdicts are deterministic — a confidence % would be invented.
  const pillText = isRulesVerdict(ctx) ? "Verdict" : `Verdict · ${ctx.confidence}% confidence`;
  const body = `
    <div style="display:inline-block;padding:6px 12px;margin:0 0 16px;background:${v.pillBg};color:${v.pillFg};border:1px solid ${v.pillBorder};border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">${escapeHtml(pillText)}</div>
    <p style="margin:0 0 14px;color:#1A2536;">${escapeHtml(v.lead)}</p>
    ${echoSubject}
    ${findingsBlock}
    ${investigatorBlock}
    ${nextStepsBlock}
    <div style="margin:20px 0 0;padding:16px 18px;background:#FAFBFC;border:1px solid #E5E8EE;border-radius:8px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:#8895AA;margin-bottom:8px;">Analyst notes</div>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#1A2536;">${escapeHtml(analystNote(ctx))}</p>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-collapse:collapse;">
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#8895AA;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Action taken</td>
        <td style="padding:4px 0;font-size:12px;color:#0F1828;">${escapeHtml(humanizeAction(ctx.action, ctx.classifiedBy))}</td>
      </tr>
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#8895AA;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Reference</td>
        <td style="padding:4px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#0F1828;">${escapeHtml(ctx.messageId)}</td>
      </tr>
    </table>
  `;
  return brandLayout({
    accent: v.accent,
    preheaderTag: "Determination",
    headline: v.label,
    bodyHtml: body,
    branding: b,
  });
}

function determinationText(ctx: DeterminationContext, b: AbuseBranding): string {
  const v = VERDICT_COPY[ctx.classification] ?? VERDICT_COPY.ambiguous!;
  const echo = ctx.originalSubject ? `\n\nSubject we triaged:\n  ${defangForEcho(ctx.originalSubject)}` : "";

  const findings = buildFindings(ctx);
  const findingsBlock = findings.length > 0
    ? "\n\nWhat we found:\n" + findings.map((f) => `  - ${f}`).join("\n")
    : "";

  const steps = nextStepsFor(ctx, v);
  const nextStepsBlock = steps.length > 0
    ? "\n\nWhat you should do:\n" + steps.map((s) => `  - ${s}`).join("\n")
    : "";

  const investigatorClean = sanitizeForExternalEmail(ctx.deepAnalysisExternal);
  const investigatorBlock = investigatorClean
    ? `\n\nInvestigator findings:\n${investigatorClean}`
    : "";

  const headline = isRulesVerdict(ctx)
    ? `Determination: ${v.label}`
    : `Determination: ${v.label} (${ctx.confidence}% confidence)`;
  return `${headline}

${v.lead}${echo}${findingsBlock}${investigatorBlock}${nextStepsBlock}

Analyst notes: ${analystNote(ctx)}
Action taken: ${humanizeAction(ctx.action, ctx.classifiedBy)}

Reference: ${ctx.messageId}

— ${b.fromName}
${b.reportUrl}
`;
}

/**
 * Send the determination email. Triggered once a verdict (rules or AI)
 * is stamped on the row. Exactly-once bookkeeping (the
 * determination_sent_at claim) lives in lib/abuse-mailbox-determination.ts
 * — call deliverAbuseDetermination rather than this directly.
 */
export async function sendDetermination(
  env: Env,
  toAddress: string | null | undefined,
  ctx: DeterminationContext,
  branding: AbuseBranding = DEFAULT_ABUSE_BRANDING,
): Promise<{ ok: boolean; reason: string; permanent?: boolean }> {
  const decision = shouldRespond(toAddress);
  if (!decision.send) return { ok: false, reason: decision.reason };
  if (!env.RESEND_API_KEY) return { ok: false, reason: "no-resend-key" };

  const cleanedTo = toAddress!.trim().toLowerCase();
  if (await isOptedOut(env, cleanedTo)) {
    return { ok: false, reason: "opted-out" };
  }

  const v = VERDICT_COPY[ctx.classification] ?? VERDICT_COPY.ambiguous!;
  // PR-BC: same subject-content rationale as sendAck — the per-
  // verdict label (e.g. "Phishing confirmed") is brand-safe; the
  // forwarded original subject moves into the body's "Subject we
  // triaged" block (unchanged).
  const ref = ctx.messageId.slice(0, 8);
  const subject = `${branding.subjectPrefix} · ${v.label} (Ref: ${ref})`;

  const { unsubscribeUrl } = await import("../handlers/abuseMailboxUnsubscribe");
  // L5: unsubscribeUrl returns null when ABUSE_UNSUBSCRIBE_SECRET is
  // unset — omit the headers entirely rather than emit a broken link.
  const unsubUrl = await unsubscribeUrl(env, cleanedTo, ctx.messageId);
  const extraHeaders = unsubUrl ? {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  } : undefined;

  const res = await sendViaResend(
    env.RESEND_API_KEY,
    fromAddressFor(branding),
    cleanedTo,
    subject,
    determinationHtml(ctx, branding),
    determinationText(ctx, branding),
    extraHeaders,
    ctx.inboundAlias,
    // A retry after a lost response (claim released, re-claimed) is a
    // no-op at Resend — see lib/abuse-mailbox-determination.ts.
    `abuse-determination/${ctx.messageId}`,
  );
  if (!res.ok) {
    logger.warn("abuse_mailbox_determination_send_failed", { error: res.error, to: toAddress, msg_id: ctx.messageId });
    return { ok: false, reason: res.error ?? "send-failed", permanent: isPermanentResendStatus(res.status) };
  }
  return { ok: true, reason: "sent" };
}

// ─── Helpers ─────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a value destined for an href/src attribute. URLs are already
 *  https-validated at load time; this is defense-in-depth on the quoting. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
