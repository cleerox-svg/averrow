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
  /** Extra headers passed through to the recipient (List-Unsubscribe etc).
   *  Resend forwards these verbatim. */
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html,
      text,
    };
    if (extraHeaders && Object.keys(extraHeaders).length > 0) {
      body.headers = extraHeaders;
    }
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
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
// PR-AR — Logo + fonts:
//
// 1. Logo. Gmail's sanitiser silently drops inline <svg> AND blocks
//    SVG when referenced via <img src=".svg">, so the previous two
//    treatments (raw SVG, then SVG-in-img) both rendered an empty
//    box. Solution: recreate the Avro Arrow brandmark using HTML +
//    CSS only. A 38×38 dark-navy rounded square contains a Unicode
//    upward triangle ▲ (U+25B2) coloured platform-red #C83C3C — the
//    same shape language as packages/trust-radar/public/favicon.svg
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

// PR-BB: PNG inlined as base64 to avoid Gmail's image-proxy
// intermittently failing to load the hosted asset. Regenerate with:
//   base64 -w0 packages/trust-radar/public/logo-email-mark.png
const LOGO_DATA_URI = `iVBORw0KGgoAAAANSUhEUgAAAJAAAACQCAYAAADnRuK4AAAJlklEQVR42u2dX2gc1xXGv3NHuyuvG8le6g0olYSwzBIpWJZWIo0VPSSF4iiPVl1ao1KQY6PWYNet5arugx5aaAKF0j4USw9BTUVNKJTUcRP3JcGkNCJeVjHIieMGxTJRsGSMowjZ8u7e2wdLsSzrn6XR7J2d7wcHw0rs3Dk+97tnZr65AgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQghxlYNbt5Ye3Lq1lJlYGsUULE0E+GkI+AkzsTTCFCyhPmVl0cidOyMAMFNcXNU7NjbNrFCBVq8+09MHxJi4GBMvnp7uYEaoQKtXHyAUjcWuGKBy9qNrW2/erO4B7jI7VKAVicZi7QAqZXaGCVD+ZSy2n5lhAa1ID6BEpEtEMD8gcqKH+WIBrcSXsVibAIl56jMXiclYbC8zxAJaPiFKPaQ+X4dSJ9k3soCW5Pi2ba0CJBdRn7mo+/m2bXuYKRbQohige0n1mQ0FdDNTvIxfTH1aBDi/yqS1vDwx8R6zRgW6nwiRFdVnLoxSVCEq0H1OxON1AqQfKR9aN/7uxo0UFYjAETkp98Cqw3G6mDkqEH5dVpbQudylNUwmrRyn5jdjY5epQEG+8srlTgiglrl0XyqUyeUCr0KBVqCTZWXlovX/AITX+BUZI7Ljt198cZUKFMTeR+vjAoTXoD5zEVLAMSpQAOl5/PG4VmoEQHSdXzWttK7quX59nAoUqDNXRwWIrkN95iJqlDpCBQqS+sRiJSguvgpgi0tfOYlwuLLns89uUYGCcNKRyGEBtrigPnNRIjMznVSgIKhPWVlUiYwAiLv81ePamKqegJnvA6dARUodECDuovrMRdxRKnDm+0Ap0KlkMjRx/foV3DfLu821bGlpdc/wcGDM94FSoBvj4+3yoFne7SgPT04GynwfGAXqAVSkouKSMSaxoQkVuTwzOlrTA2gqUAFRXFHRBmMSG6g+92ajMYlIRUVgzPdBWsK6HsmusZ4w5qQJiLoHooBeqaxcySzvbojUvVxZuYcFVCiNnjHdnhXPbChjAmF7LXiZfaW8vAVKnc/HsbUxLb8cHS1o833BK5Ao5bn6zIUjUvAqVNAK9PuqqjpjTDqv56l14y9GRwvWfF/YCmTMSQEkXwokAKBUFxXIh/yhqiqhgUsWTBKtgJqjIyOXqUD+Up+1muXdDmWM6aIC+an32b693DFmPWZ5t8kUGbPj8MjIVSqQDyhav1ne7QhlC9R8X3AK9Oft2+MZwA2zvNtMh4Cqzk8/HacCWUzWGLfM8m5HNAccoQJZzB+rq0sU4KZZ3m0mM9ls5c8KyHxfUAqkALfN8m5HSaSoqJMKZCGnysqiuWh0I8zybjPuTE9XHSoQ831RoRSQ3rz5gNhfPAAQN5s3dwD4ExXIFvVJJkP46qsrxphKnwz5Wiwcrt5XAOb7glAgmZpqN0CliG/mQ/nNu3f3A3iVTXSe6Zl9VGBx47yUa7Egdr73/QmUJRJtSiThmd/ZpVAiiW8lEntZQPk/Af+pz/3m0/fme18P/tUnn2zVxpz19+Wjbu345JO3qEB5wADdflWfeb1QNxUoH+pTU9MCY86jANBKtXQMD79HBfKy8vPwqs5GRZHW3VQgD3mttrZO59ss7/ZyrHXjjz/+OEUF8iLZFpjlXQ+fmu99N4Nf27kzgbXtLG99KwTHqWm/ePEyFWgjB6y1LWZ51833ks12UYE2kL899VS59tYsPzT77y6PjpeB1jv2f/SRb8z3vnqYaoDjIuLdmxbG9N+bZuJVAYWM4xyDj6yvvlGgv+zcGQ9p7aVZPuOEQk8AQC6T+RxAyKPjTmeUqvrRxYu+MN/7pgcKAUdFJOrhA8+z+9LpiX3p9ISInPXwuNGI1r5RIF8U0F+rq0uUMZ0eN7X982S639OHrCKH/7Fr1xYWkFvqE40eFpEtHqrAxK1w+OuHtLfC4bMiMuHh8UuyWneygFzgTDIZVcARj9Vn4FAqlZkbw6FUKiPAgMdWj6NnkskoC2idzGQyB0Qk7qXZyyjV/9AFmVL9HpvO4nezWet3vrf6KuxUMhn6Zja7kTvLL3arYKjtww/rF/vZ3+vq0uLdPSEAuJbLZq0231t9H2hbNtsOEa/ftOhfcraJ9HtcQOVFRUVWm++tXcJ6ACUiXttVMzmRgaXGlBMZECBD870PCqiuoaFNvDbLK3V2Xzo9sdSY9qXTE6LUWY97oUT9rl17WUCPiJOHV3UcrftXHJfW/Z6b70WsNd9bWUD/rK9/ASJJj2f6xJjjPGDQf6O5+bE3mpsfm//ZmON4fU8IIlJ3pr5+DwtotZeGIr/Kwys2D9z7AQC5ffuHzu3bP5j/2ezvDNB8b2kBvdnQ0CLAszYsXwp4CcBBG5YxAVrOJJPPsoBWvjHVnYc3RYdeHBoaWlDISbm3jCbfbGhIzv/Zi0NDQyIy5Pk4gW4W0DK8XV9fJyJ7PJ/dc76f+YlR6uC833npoUI3xnMVUkDrwmLmneh5vNXU9DqM+Z4FQ5kyjvNE6+DgJAC8U1v7jTubNn0OoCTvIzPm9RdSqe9TgRYWT2NjQozZa4M/WQEDc8UDAM8ND08BOG3Jm6xtbzU2Jmz5f7PmUYYjcsLYUtBK9T30keP0QuuDNoxORLoAWPGg1Yol7FxTU7kAtuwsn/ruBx80LvaDfzc1XQBgQw+ScbLZHd9Jp/NuvrdCgZTIcUuKByLSu8w4+4wdBRTKhcNWmO/zvmSc2707LkCHJe9mTd0FTi+5zEajAwJMWtGnGXPg3O7d8cAXkJPLeW2WX27XsAea54U89+67UxA5bckuZ9GQBeb7vBbQv55+ukQBnRbtGNa3ioT1WjNeYw6/k2fzfV4LqFjEa7P8cpF6fnBwxd0xnh8cTIlIypIxl8imTZ2BLKAL+THLL9dT9D5C099nkQodvZBH833eCmgqEvHcLL9MTEWWaZ4XoiORARGZtGTs8alQqCNQBXQhmQwpY45Zoz7AwLeXaZ4XbaZtuTMNQCl1fLi2NhyYArodDrcLUGnNMqB13yMnTmtrmmkxpvxmaen+QBSQmTPL27Ppd6plFc3zQlrsaqYhQF4eBXl+wP80N7cJkLBo+epdc/KM6bNog6rEf595Zm/BF5ACbFKfKZXLnV7ruczY1UxDlPLcfO9pAb3f3NwqQNKvzfOizbQxpy26EVr3fnOzp+Z7bx+minRb9m5K37pnoFK9WMQ3nUe6Afj2TycQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCyCL8H0C5p06bA/91AAAAAElFTkSuQmCC`;

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
  // Logo: inline data: URI of the mark-only Avro Arrow.
  //
  // PR-BB (2026-05-18): previous treatment hosted the PNG at
  // https://averrow.com/logo-email-mark.png. Customer report
  // 2026-05-18: ack email rendered the logo correctly but the
  // determination email (sent ~35 min later to the same address)
  // showed a broken-image placeholder. The PNG URL itself returns
  // 200 OK with the right content-type, so the failure was on
  // Gmail's image-proxy side — most likely intermittent revalidation
  // failures due to the asset's `cache-control: max-age=0,
  // must-revalidate` header. Once the proxy fails a revalidation,
  // it can't display anything (no fallback to stale).
  //
  // Embedding as a data: URI eliminates the proxy entirely. Adds
  // ~3.3KB per email (base64 of the 2.5KB PNG). Worth it: this is
  // a customer-facing email and a broken logo undermines the trust
  // signal the whole abuse-triage flow exists to deliver.
  //
  // To regenerate after editing the source asset:
  //   base64 -w0 packages/trust-radar/public/logo-email-mark.png
  // Then paste the result into LOGO_DATA_URI below.
  //
  // Gmail Android dark mode (verified 2026-05-17 in production)
  // applies per-image color inversion when the IMG is detected as
  // "dark with some color content" — even when the surrounding TD
  // background is locked dark by our `.av-brand-header` rule. The
  // mark-only PNG (red arrow on transparent, no dark pixels) survives
  // that filter — verified rendering in production for the ack email.
  //
  // Source asset: public/favicon-mark.svg + scripts/generate-logo-assets.py
  // → public/logo-email-mark.png
  const logoCell = `<img class="av-brand-logo" src="data:image/png;base64,${LOGO_DATA_URI}" width="38" height="38" alt="Averrow" style="display:block;width:38px;height:38px;border:0;outline:none;">`;
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
  .av-brand-header { background:#0F1828 !important; }
  .av-brand-logo   { background:transparent !important; }
  .av-accent-line  { background:${accent} !important; }
  @media (prefers-color-scheme: dark) {
    .av-brand-header { background:#0F1828 !important; }
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
<title>${escapeHtml(opts.headline)} — Averrow</title>
</head>
<body style="margin:0;padding:0;background:#F3F4F6;font-family:${FONT_BODY};color:#1A2536;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheaderTag)} — Averrow Abuse Triage</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6;padding:32px 16px;font-family:${FONT_BODY};">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:12px;box-shadow:0 4px 20px rgba(15,24,40,0.08);overflow:hidden;">
        <tr><td class="av-brand-header" style="background:#0F1828;padding:20px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:middle;">${logoCell}</td>
              <td style="vertical-align:middle;padding-left:12px;">
                <div style="font-family:${FONT_BODY};font-size:20px;font-weight:800;color:#FFFFFF;letter-spacing:-0.01em;line-height:1.1;">Averrow</div>
                <div style="font-family:${FONT_BODY};font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#E5A832;font-weight:700;margin-top:3px;line-height:1;">Abuse Triage</div>
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
  const subject = `Averrow · Report received (Ref: ${ref})`;
  const html = ackHtml(ctx);
  const text = ackText(ctx);

  // List-Unsubscribe + one-click POST (RFC 8058). Gives Gmail a
  // recipient-controlled exit ramp — required to keep deliverability
  // for senders Gmail considers "bulk-adjacent" and a strong positive
  // reputation signal regardless of volume.
  const { unsubscribeUrl } = await import("../handlers/abuseMailboxUnsubscribe");
  const unsubUrl = await unsubscribeUrl(env, cleanedTo, ctx.messageId);
  const extraHeaders = {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  const res = await sendViaResend(env.RESEND_API_KEY, cleanedTo, subject, html, text, extraHeaders);
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

// ─── 24h determination ──────────────────────────────────────────

interface DeterminationContext {
  messageId: string;
  originalSubject: string | null;
  classification: string;   // phishing | spam | benign | malware | ambiguous
  confidence: number;       // 0-100
  reasoning: string;
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

function determinationHtml(ctx: DeterminationContext): string {
  const v = VERDICT_COPY[ctx.classification] ?? VERDICT_COPY.ambiguous!;
  const echoSubject = ctx.originalSubject
    ? `<div style="margin:18px 0 10px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#8895AA;">Subject we triaged</div>
       <div style="margin:0 0 18px;padding:12px 16px;border-left:3px solid ${v.accent};background:#FAFBFC;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#1A2536;border-radius:0 6px 6px 0;">${escapeHtml(ctx.originalSubject)}</div>`
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

  const nextStepsBlock = v.nextSteps.length > 0
    ? `<div style="margin:16px 0 0;padding:16px 18px;background:#FFFFFF;border:1px solid ${v.pillBorder};border-radius:8px;border-left:4px solid ${v.accent};">
         <div style="font-size:11px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:${v.pillFg};margin-bottom:10px;">What you should do</div>
         <ul style="margin:0;padding:0 0 0 18px;list-style:disc;color:#1A2536;font-size:14px;line-height:1.6;">
           ${v.nextSteps.map((s) => `<li style="margin:0 0 6px;">${escapeHtml(s)}</li>`).join("")}
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

  const body = `
    <div style="display:inline-block;padding:6px 12px;margin:0 0 16px;background:${v.pillBg};color:${v.pillFg};border:1px solid ${v.pillBorder};border-radius:999px;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;">Verdict · ${ctx.confidence}% confidence</div>
    <p style="margin:0 0 14px;color:#1A2536;">${escapeHtml(v.lead)}</p>
    ${echoSubject}
    ${findingsBlock}
    ${investigatorBlock}
    ${nextStepsBlock}
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

  const findings = buildFindings(ctx);
  const findingsBlock = findings.length > 0
    ? "\n\nWhat we found:\n" + findings.map((f) => `  - ${f}`).join("\n")
    : "";

  const nextStepsBlock = v.nextSteps.length > 0
    ? "\n\nWhat you should do:\n" + v.nextSteps.map((s) => `  - ${s}`).join("\n")
    : "";

  const investigatorClean = sanitizeForExternalEmail(ctx.deepAnalysisExternal);
  const investigatorBlock = investigatorClean
    ? `\n\nInvestigator findings:\n${investigatorClean}`
    : "";

  return `Determination: ${v.label} (${ctx.confidence}% confidence)

${v.lead}${echo}${findingsBlock}${investigatorBlock}${nextStepsBlock}

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
  const subject = `Averrow · ${v.label} (Ref: ${ref})`;

  const { unsubscribeUrl } = await import("../handlers/abuseMailboxUnsubscribe");
  const unsubUrl = await unsubscribeUrl(env, cleanedTo, ctx.messageId);
  const extraHeaders = {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  const res = await sendViaResend(
    env.RESEND_API_KEY,
    cleanedTo,
    subject,
    determinationHtml(ctx),
    determinationText(ctx),
    extraHeaders,
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
