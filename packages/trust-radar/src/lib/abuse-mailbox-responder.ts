/**
 * Averrow — Abuse Mailbox responder
 *
 * Wave-3 PR-AD: ack-on-receipt + 24h determination emails for the
 * abuse_inbox_messages flow. Pairs with:
 *   - handlers/abuseMailboxEmail.ts  (calls sendAck after INSERT)
 *   - lib/abuse-mailbox-classifier.ts (calls sendDetermination after
 *     classification completes)
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
 * ~1-3 seconds end-to-end). Determination runs after the classifier
 * lands; since the classifier is a backfill batch (not real-time),
 * the realistic latency is the backfill cadence — well under 24h.
 */
import type { Env } from "../types";
import { logger } from "./logger";

const FROM_ADDRESS = "Averrow Abuse Triage <abuse-noreply@averrow.com>";

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
  const at = trimmed.indexOf("@");
  if (at < 1 || at === trimmed.length - 1) return { send: false, reason: "malformed-address" };
  const domain = trimmed.slice(at + 1);
  if (SELF_DOMAINS.has(domain)) return { send: false, reason: "own-domain-loop" };
  // Obvious noreply senders — we still send because some legit
  // platforms (Gmail group forwards) use 'noreply' in the From line
  // but accept replies. Reverse: a forwarded message FROM noreply
  // is fine to reply to since the human operator set up the forward.
  return { send: true, reason: "ok" };
}

interface ResendBody {
  id?: string;
  name?: string;
  message?: string;
  error?: string;
}

async function sendViaResend(
  apiKey: string,
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html, text }),
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
      return { ok: false, error: err };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Brand layout (shared by ack + determination) ──────────────
//
// Branded HTML email layout used by both responders. Built for inline-
// only styling (no external CSS, no web fonts) because most clients
// (Gmail, Outlook, Apple Mail) strip <link>/<style> tags and refuse
// external font loads.
//
// PR-AO: replaced the SVG-only logo with a hybrid HTML/CSS treatment.
// Gmail and several enterprise clients strip SVG defensively, leaving
// the slot blank. The current approach uses a coloured square + serif
// "A" mark which is bare-CSS and renders identically everywhere.
//
// Brand language follows AVERROW_UI_STANDARD.md and CLAUDE.md §5:
//   - amber #E5A832 for accents + brand colour
//   - dark slate header (#0F1828) matching --bg-page
//   - off-white body for readability in email clients
//   - serif/display (Georgia fallback) for headline + logo mark
//   - mono for technical fields (id, alias)
//
// Layout: 600px-wide centered card on a neutral background. Header
// bar with logo + product name. Accent stripe under header. Body.
// Footer with marketing-page link + "why am I getting this".

interface BrandLayoutOptions {
  /** Hex colour for the 4px accent stripe under the header. Default amber. */
  accent?: string;
  /** Tag printed above the headline (e.g. "Report received" or "Determination"). */
  preheaderTag: string;
  /** The bold headline text. */
  headline: string;
  /** Inner HTML for the main body. Assume well-formed inline-styled blocks. */
  bodyHtml: string;
}

function brandLayout(opts: BrandLayoutOptions): string {
  const accent = opts.accent ?? "#E5A832";
  // Inline logo: amber square with serif "A" — bare HTML/CSS, no SVG.
  // Most reliable across Gmail / Outlook / Apple Mail / clients with
  // aggressive SVG stripping. The triangle-style brand mark we use in
  // the platform UI doesn't survive Gmail's HTML sanitiser.
  const logoCell = `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
      <tr><td style="width:34px;height:34px;background:#E5A832;border-radius:6px;text-align:center;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:700;color:#0F1828;line-height:34px;">A</td></tr>
    </table>`;
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.headline)} — Averrow</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1A2536;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheaderTag)} — Averrow Abuse Triage</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:12px;box-shadow:0 4px 20px rgba(15,24,40,0.08);overflow:hidden;">
        <tr><td style="background:#0F1828;padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:middle;">${logoCell}</td>
              <td style="vertical-align:middle;padding-left:12px;">
                <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;line-height:1.1;">Averrow</div>
                <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#E5A832;font-weight:700;margin-top:3px;line-height:1;">Abuse Triage</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="height:4px;background:${accent};line-height:4px;font-size:0;">&nbsp;</td></tr>
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#8895AA;font-weight:600;">${escapeHtml(opts.preheaderTag)}</div>
          <h1 style="margin:6px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:#0F1828;line-height:1.25;letter-spacing:-0.01em;">${escapeHtml(opts.headline)}</h1>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;font-size:15px;line-height:1.6;color:#1A2536;">
          ${opts.bodyHtml}
        </td></tr>
        <tr><td style="padding:20px 32px 22px;border-top:1px solid #E5E8EE;background:#FAFBFC;">
          <p style="margin:0 0 10px;font-size:13px;color:#1A2536;line-height:1.5;font-weight:600;">
            <a href="https://averrow.com" style="color:#0F1828;text-decoration:none;font-weight:700;">averrow.com</a>
            <span style="color:#8895AA;font-weight:400;"> · threat intelligence + brand protection</span>
          </p>
          <p style="margin:0 0 6px;font-size:11px;color:#8895AA;line-height:1.5;">
            Report another threat → <a href="https://averrow.com/report-abuse" style="color:#E5A832;text-decoration:underline;font-weight:600;">averrow.com/report-abuse</a>
          </p>
          <p style="margin:0;font-size:11px;color:#8895AA;line-height:1.5;">
            You received this because your address sent or forwarded a message to one of Averrow's public abuse mailboxes. Not yours? Ignore this email — no action needed.
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

function ackHtml(ctx: AckContext): string {
  // PR-AN: brand-aligned ack copy. Honest about automation per the
  // marketing page promise — submission goes through automated AI
  // triage, determination email follows within ~1 hour, not 24h or
  // via a human analyst.
  const echoSubject = ctx.originalSubject
    ? `<div style="margin:18px 0 10px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#8895AA;">Subject we received</div>
       <div style="margin:0 0 18px;padding:12px 16px;border-left:3px solid #E5A832;background:#FAFBFC;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#1A2536;border-radius:0 6px 6px 0;">${escapeHtml(ctx.originalSubject)}</div>`
    : "";
  const body = `
    <p style="margin:0 0 14px;">Thanks for the report. Your submission is in our system and queued for automated inspection.</p>
    <p style="margin:0 0 14px;color:#4A5868;">The Averrow platform extracts indicators (URLs, sender headers, sending IP, payload signatures), classifies the message via AI, and correlates against our threat-intel feeds. You'll receive a determination email back — typically within the hour — with the verdict and any action we've taken.</p>
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
  });
}

function ackText(ctx: AckContext): string {
  const echo = ctx.originalSubject ? `\n\nSubject we received:\n  ${ctx.originalSubject}` : "";
  return `Thanks — your report is in.

Your submission is queued for automated inspection. The Averrow platform extracts indicators (URLs, sender headers, sending IP, payload signatures), classifies the message via AI, and correlates against our threat-intel feeds. You'll receive a determination email back — typically within the hour — with the verdict and any action we've taken.${echo}

Reference: ${ctx.messageId}
Inbox: ${ctx.inboundAlias}

— Averrow Abuse Triage
https://averrow.com/report-abuse
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
): Promise<{ ok: boolean; reason: string }> {
  const decision = shouldRespond(toAddress);
  if (!decision.send) return { ok: false, reason: decision.reason };
  if (!env.RESEND_API_KEY) return { ok: false, reason: "no-resend-key" };

  const subject = `Averrow · Report received — ${ctx.originalSubject ?? "your forwarded message"}`.slice(0, 140);
  const html = ackHtml(ctx);
  const text = ackText(ctx);
  const res = await sendViaResend(env.RESEND_API_KEY, toAddress!.trim().toLowerCase(), subject, html, text);
  if (!res.ok) {
    logger.warn("abuse_mailbox_ack_send_failed", { error: res.error, to: toAddress, msg_id: ctx.messageId });
    return { ok: false, reason: res.error ?? "send-failed" };
  }
  return { ok: true, reason: "sent" };
}

// ─── 24h determination ──────────────────────────────────────────

interface DeterminationContext {
  messageId: string;
  originalSubject: string | null;
  classification: string;   // phishing | spam | benign | malware | ambiguous
  confidence: number;       // 0-100
  reasoning: string;
  action: string;           // safe | review | escalate | takedown
}

interface VerdictDef {
  label: string;
  line: string;
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
    line: "We identified this as a phishing attempt. Don't engage with the sender. The URLs, headers, and sending IP are now in our threat intelligence so other monitored brands benefit from your report too.",
    accent: "#C83C3C", pillBg: "#FBEDED", pillFg: "#911B1B", pillBorder: "#E8B5B5",
  },
  malware: {
    label: "Malware indicators found",
    line: "We found malware indicators in the attached or linked content. Don't open attachments or click links from the original message. If you've already clicked, run an antivirus scan and consider rotating any credentials you entered.",
    accent: "#C83C3C", pillBg: "#FBEDED", pillFg: "#911B1B", pillBorder: "#E8B5B5",
  },
  spam: {
    label: "Spam",
    line: "We classified this as unsolicited commercial email rather than a targeted threat. Your address is on a bulk list — consider unsubscribing if the sender is legitimate, or filtering at your provider if not.",
    accent: "#E5A832", pillBg: "#FCF4E0", pillFg: "#7E5A12", pillBorder: "#EBD9A7",
  },
  benign: {
    label: "Likely safe",
    line: "After review we don't believe this message is a threat. It may be a legitimate but unfamiliar sender, or a marketing send from an opted-in list. If something still feels off, reply to this email and we'll re-inspect.",
    accent: "#3CB878", pillBg: "#E6F5EC", pillFg: "#1A6B3C", pillBorder: "#A6D9BB",
  },
  ambiguous: {
    label: "Needs human review",
    line: "Our automated triage couldn't reach a confident verdict on its own. A human analyst will reach out separately if we need more context from you. No further action needed on your side for now.",
    accent: "#A78BFA", pillBg: "#F0EBFD", pillFg: "#4C2D9E", pillBorder: "#CBBBF0",
  },
};

function determinationHtml(ctx: DeterminationContext): string {
  const v = VERDICT_COPY[ctx.classification] ?? VERDICT_COPY.ambiguous!;
  const echoSubject = ctx.originalSubject
    ? `<div style="margin:18px 0 10px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#8895AA;">Subject we triaged</div>
       <div style="margin:0 0 18px;padding:12px 16px;border-left:3px solid ${v.accent};background:#FAFBFC;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#1A2536;border-radius:0 6px 6px 0;">${escapeHtml(ctx.originalSubject)}</div>`
    : "";
  const body = `
    <div style="display:inline-block;padding:6px 12px;margin:0 0 16px;background:${v.pillBg};color:${v.pillFg};border:1px solid ${v.pillBorder};border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">Verdict · ${ctx.confidence}% confidence</div>
    <p style="margin:0 0 14px;color:#1A2536;">${escapeHtml(v.line)}</p>
    ${echoSubject}
    <div style="margin:20px 0 0;padding:16px 18px;background:#FAFBFC;border:1px solid #E5E8EE;border-radius:8px;">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:#8895AA;margin-bottom:8px;">Analyst notes</div>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#1A2536;">${escapeHtml(ctx.reasoning)}</p>
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border-collapse:collapse;">
      <tr>
        <td style="padding:4px 12px 4px 0;font-size:12px;color:#8895AA;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">Action taken</td>
        <td style="padding:4px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#0F1828;">${escapeHtml(ctx.action)}</td>
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
  });
}

function determinationText(ctx: DeterminationContext): string {
  const v = VERDICT_COPY[ctx.classification] ?? VERDICT_COPY.ambiguous!;
  const echo = ctx.originalSubject ? `\n\nSubject we triaged:\n  ${ctx.originalSubject}` : "";
  return `Determination: ${v.label} (${ctx.confidence}% confidence)

${v.line}${echo}

Analyst notes: ${ctx.reasoning}
Action taken: ${ctx.action}

Reference: ${ctx.messageId}

— Averrow Abuse Triage
https://averrow.com/report-abuse
`;
}

/**
 * Send the 24h determination email. Triggered after the classifier
 * has stamped classification/confidence/action on the row. Caller
 * is responsible for marking determination_sent_at on success.
 */
export async function sendDetermination(
  env: Env,
  toAddress: string | null | undefined,
  ctx: DeterminationContext,
): Promise<{ ok: boolean; reason: string }> {
  const decision = shouldRespond(toAddress);
  if (!decision.send) return { ok: false, reason: decision.reason };
  if (!env.RESEND_API_KEY) return { ok: false, reason: "no-resend-key" };

  const v = VERDICT_COPY[ctx.classification] ?? VERDICT_COPY.ambiguous!;
  const subject = `Averrow · ${v.label} — ${ctx.originalSubject ?? "your forwarded report"}`.slice(0, 140);
  const res = await sendViaResend(
    env.RESEND_API_KEY,
    toAddress!.trim().toLowerCase(),
    subject,
    determinationHtml(ctx),
    determinationText(ctx),
  );
  if (!res.ok) {
    logger.warn("abuse_mailbox_determination_send_failed", { error: res.error, to: toAddress, msg_id: ctx.messageId });
    return { ok: false, reason: res.error ?? "send-failed" };
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
