// Abuse Mailbox Email Worker.
//
// Customers' employees forward suspicious emails to their org's
// verify-<tenant>@averrow.com alias (set in org_abuse_aliases).
// Cloudflare Email Routing delivers those messages to this
// handler, which:
//
//   1. Parses headers + body
//   2. Resolves the to-alias → org_abuse_aliases row → org_id
//   3. Extracts the *original* suspicious email's metadata from
//      the forwarded body (best-effort regex against the common
//      "On <date>, <sender> wrote:" pattern + From:/Subject:
//      header injection that Outlook/Gmail/Apple Mail use)
//   4. Inserts an abuse_inbox_messages row with
//      classification='pending'. Sprint follow-ups will:
//        a. Call Haiku for AI classification (sets
//           classification + ai_action + ai_assessment)
//        b. Send the instant ack email back to the forwarder
//        c. After classification, send the determination email
//           (24h flow per the customer-facing copy)
//
// We accept the email even if alias lookup fails — bouncing
// pisses off email providers and we'd rather have an unbound
// row to investigate than lose evidence. Such rows get
// org_id=NULL... wait, abuse_inbox_messages.org_id is NOT NULL.
// Decision: drop the message entirely if the alias isn't
// registered. Stripe-style: misdirected mail isn't our problem.
//
// Phase B-followup, post-launch.

import type { Env } from "../types";
import { decideAbuseMailboxThrottle, extractSenderDomain } from "../lib/abuse-mailbox-throttle";
import {
  parseAuthResults, parseSenderIp, correlateUrls,
} from "../lib/abuse-mailbox-iocs";

interface EmailMessage {
  from:     string;
  to:       string;
  headers:  Headers;
  raw:      ReadableStream<Uint8Array>;
  rawSize:  number;
  setReject(reason: string): void;
  forward(to: string, headers?: Headers): Promise<void>;
}

const SNIPPET_LIMIT     = 500;
const RAW_BODY_SCAN_MAX = 32_768;   // Skip past attachments; first ~32KB has the prose

// ─── PR-AS raw-capture caps ─────────────────────────────────────
// Caps enforced before INSERT to stay under D1's 1MB row limit.
// See migration 0184_abuse_mailbox_raw_capture.sql for the budget.
const RAW_BODY_STORE_MAX    = 256 * 1024;   // 256 KB plaintext body
const RAW_HEADERS_STORE_MAX = 64 * 1024;    // 64 KB headers JSON
const URLS_STORE_MAX        = 32 * 1024;    // 32 KB URL-list JSON
const ATTACHMENTS_STORE_MAX = 16 * 1024;    // 16 KB attachment-list JSON
const URL_LIST_MAX_ENTRIES  = 200;
const ATTACHMENT_MAX_ENTRIES = 50;
const SINGLE_URL_MAX        = 2_048;        // truncate any single URL beyond this

export async function handleAbuseMailboxEmail(
  message: EmailMessage,
  env:     Env,
): Promise<void> {
  // 1. Read the raw email + decode.
  const rawBuf = await streamToArrayBuffer(message.raw);
  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawBuf);

  // 2. Resolve the alias → org_id. We accept any alias case
  // because email addresses are case-insensitive on the local
  // part (per RFC 5321 §2.4 even though some servers honor
  // case sensitivity).
  const toAddress = message.to.trim().toLowerCase();
  const aliasRow = await env.DB.prepare(
    `SELECT org_id, alias FROM org_abuse_aliases WHERE LOWER(alias) = ?`,
  ).bind(toAddress).first<{ org_id: number; alias: string }>();

  if (!aliasRow) {
    // No alias registered for this address. Don't bounce — silently
    // drop. Bouncing trains email providers to deprioritize our
    // mail; silent drop is the platform-aligned answer.
    console.warn(`[abuse-mailbox] No alias bound for ${toAddress}; dropping`);
    return;
  }

  // 3. Parse headers from the OUTER envelope (this is the forward,
  // not the original suspicious email).
  const outerHeaders = extractHeaders(rawText);
  const forwardedBy = parseEmailAddress(outerHeaders["from"] ?? message.from);

  const body = extractBody(rawText, RAW_BODY_SCAN_MAX);

  // 4. Try to dig the original sender / subject / body from the
  // forwarded chunk. Forwarded mails typically have:
  //   ---------- Forwarded message ---------
  //   From: phisher@bad.example
  //   Date: ...
  //   Subject: URGENT
  //   To: victim@acme.com
  //
  //   <original body>
  // ...with variations across clients.
  //
  // PR-AO: when extractForwardedOriginal() returns nulls (no forwarded
  // section found — submitter wrote a fresh report instead of forwarding
  // an existing mail), fall back to the OUTER envelope as the "original".
  // For a fresh report, the outer From IS the original sender and the
  // outer Subject IS what the user wrote. Without this fallback the UI
  // displayed "(no subject) · from —" for every direct submission.
  const inner = extractForwardedOriginal(body);
  const outerSubjectRaw = (outerHeaders["subject"] ?? "").trim() || null;
  const outerBodySnippet = body.slice(0, SNIPPET_LIMIT) || null;
  const original = {
    from: inner.from ?? forwardedBy,
    subject: inner.subject ?? outerSubjectRaw,
    bodySnippet: inner.bodySnippet ?? outerBodySnippet,
  };

  // 5. Count + extract URLs and attachments.
  //
  // PR-AS: in addition to the existing counts (kept for the list
  // view's quick-read columns), capture the dereferenced URL list,
  // attachment filenames + MIME types, full body, and full headers
  // for drill-down + downstream AI analysis.
  const extractedUrls   = extractUrls(body);
  const urlCount        = extractedUrls.length;
  const attachmentList  = extractAttachments(rawText);
  const attachmentCount = attachmentList.length;
  const rawBody         = truncate(body, RAW_BODY_STORE_MAX);
  const rawHeadersJson  = capJson(outerHeaders, RAW_HEADERS_STORE_MAX);
  const urlsJson        = capJson(extractedUrls.slice(0, URL_LIST_MAX_ENTRIES), URLS_STORE_MAX);
  const attachmentsJson = capJson(attachmentList.slice(0, ATTACHMENT_MAX_ENTRIES), ATTACHMENTS_STORE_MAX);

  // PR-AX: parse auth results + sender IP from headers (pure, zero D1),
  // and correlate the extracted URLs against the platform's existing
  // threat intel. Correlations stamp on the row so the classifier sees
  // them and the UI can render "this URL is already known". Bounded
  // at the first 20 URLs internally.
  const authResults  = parseAuthResults(outerHeaders);
  const senderIp     = parseSenderIp(outerHeaders);
  const correlations = await correlateUrls(env, extractedUrls);
  const correlatedThreatIds = correlations.map((c) => c.threat_id);
  const authResultsJson     = JSON.stringify(authResults);
  const correlatedIdsJson   = JSON.stringify(correlatedThreatIds);

  // 5b. Throttle decision (PR-AT bad-actor protection).
  //
  // Reads per-sender + per-domain rolling-60-min counts. When fired,
  // the row is still INSERTed (forensic capture preserved) but the
  // downstream cost paths skip:
  //   - sendAck below
  //   - the AI classifier (filters throttled rows in runAbuseClassifierBackfill)
  //   - the determination email (gated on classification completing)
  const throttle = await decideAbuseMailboxThrottle(env, forwardedBy);
  const forwardedByDomain = extractSenderDomain(forwardedBy);
  if (throttle.throttled) {
    console.warn(
      `[abuse-mailbox] throttled — reason=${throttle.reason} ` +
      `sender=${forwardedBy} domain=${forwardedByDomain} ` +
      `sender_count=${throttle.sender_count_last_window} ` +
      `domain_count=${throttle.domain_count_last_window}`,
    );
    // PR-AW: notify super_admins when the throttle fires. Group-key dedup
    // is per-(reason|sender|domain), so a flood from one source produces
    // one notification per hour — not one per inbound message. Failures
    // here are non-fatal (the capture row + console.warn above remain
    // the source of truth).
    try {
      const { createNotification } = await import("../lib/notifications");
      const throttleDim = throttle.reason === "sender_rate_limit"
        ? `sender:${forwardedBy}`
        : `domain:${forwardedByDomain ?? "unknown"}`;
      const reasonLabel = throttle.reason === "sender_rate_limit"
        ? `Sender exceeded 20 messages in 60 minutes`
        : `Sending domain exceeded 50 messages in 60 minutes`;
      await createNotification(env, {
        type: "abuse_mailbox_flood_detected",
        severity: "medium",
        title: `Abuse mailbox flood detected — ${reasonLabel.toLowerCase()}`,
        message: `${forwardedBy ?? "(no sender)"} via ${forwardedByDomain ?? "(no domain)"} — ` +
          `${throttle.sender_count_last_window} from this sender / ` +
          `${throttle.domain_count_last_window} from this domain in the last hour.`,
        link: "/v2/admin/abuse-mailbox",
        audience: "super_admin",
        groupKey: `abuse_mailbox_flood_detected:${throttleDim}`,
        reasonText: "A single sender or sending domain is exceeding the per-hour capture limit on the public abuse aliases.",
        recommendedAction: "Open the Abuse Mailbox — flooding captures are still recorded but skip ack + classifier to preserve quota.",
        metadata: {
          throttle_reason: throttle.reason,
          sender_email: forwardedBy,
          sender_domain: forwardedByDomain,
          sender_count_last_window: throttle.sender_count_last_window,
          domain_count_last_window: throttle.domain_count_last_window,
          inbound_alias: aliasRow.alias,
        },
      });
    } catch (err) {
      console.warn("[abuse-mailbox] flood notification threw:", err);
    }
  }

  // 6. Insert the row.
  const messageId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO abuse_inbox_messages (
       id, org_id, brand_id, received_at, forwarded_by_email, forwarded_by_domain, inbound_alias,
       original_from, original_subject, original_body_snippet,
       attachment_count, url_count,
       raw_body, raw_headers, extracted_urls, attachment_names, raw_size_bytes,
       throttled, throttle_reason,
       auth_results, sender_ip, correlated_threat_ids,
       classification, severity, status,
       created_at, updated_at
     ) VALUES (?, ?, NULL, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'LOW', 'new', datetime('now'), datetime('now'))`,
  ).bind(
    messageId,
    aliasRow.org_id,
    forwardedBy,
    forwardedByDomain,
    aliasRow.alias,
    original.from,
    original.subject,
    original.bodySnippet,
    attachmentCount,
    urlCount,
    rawBody,
    rawHeadersJson,
    urlsJson,
    attachmentsJson,
    message.rawSize,
    throttle.throttled ? 1 : 0,
    throttle.reason,
    authResultsJson,
    senderIp,
    correlatedIdsJson,
  ).run();

  // ─── Wave-3 PR-AD: ack-on-receipt ──────────────────────────────
  //
  // Sends within ~1 minute of receipt per the marketing report-abuse
  // page SLA. Suppressed for empty/own-domain/malformed submitter
  // addresses (no harvester loop-back). Stamps ack_sent_at on success
  // so the operator UI can show ack state per message and so the
  // determination path knows the ack already fired.
  //
  // We DON'T retry on failure — the determination email arrives
  // within 24h regardless, and Resend transient failures are rare.
  //
  // PR-AT: skip when throttle.throttled. Sending an ack to a flooding
  // sender just gives them feedback that the alias is live and burns
  // Resend quota; the row is still captured for forensic purposes.
  if (!throttle.throttled) {
    try {
      const { sendAck } = await import("../lib/abuse-mailbox-responder");
      const ackResult = await sendAck(env, forwardedBy, {
        messageId,
        originalSubject: original.subject,
        inboundAlias: aliasRow.alias,
      });
      if (ackResult.ok) {
        await env.DB.prepare(
          `UPDATE abuse_inbox_messages SET ack_sent_at = datetime('now') WHERE id = ?`,
        ).bind(messageId).run();
      }
      // Suppression / failure logged inside sendAck; no extra noise here.
    } catch (err) {
      console.warn("[abuse-mailbox] ack send threw:", err);
    }
  }

  // ─── Wave-2 PR-AC: cross-link to spam_trap_captures ────────────
  //
  // When the alias resolves to the Averrow self-org (`_averrow_platform`
  // seeded by migration 0180), also insert a row into spam_trap_captures
  // with trap_channel='abuse_mailbox'. This surfaces the submission on
  // the unified Spam Trap view alongside seeded-honeypot captures —
  // covert spam trap framing from the audit. Tenant rows are NOT
  // cross-linked (their captures stay in the tenant's abuse_inbox
  // surface only; no platform-wide intel leak).
  //
  // We resolve the self-org id by slug at write time. Cheap (indexed,
  // org_id is the PK of org_abuse_aliases). Cached in-process for the
  // worker isolate lifetime.
  const selfOrgId = await getAverrowSelfOrgId(env);
  if (selfOrgId !== null && aliasRow.org_id === selfOrgId) {
    try {
      const fromAddr = parseEmailAddress(original.from ?? "");
      const fromDomain = fromAddr ? (fromAddr.split("@")[1] ?? null) : null;
      const trapDomain = aliasRow.alias.split("@")[1] ?? "averrow.com";
      await env.DB.prepare(
        `INSERT INTO spam_trap_captures (
           trap_address, trap_domain, trap_channel,
           from_address, from_domain,
           subject,
           url_count, attachment_count,
           category, severity,
           captured_at
         ) VALUES (?, ?, 'abuse_mailbox', ?, ?, ?, ?, ?, 'phishing', 'medium', datetime('now'))`,
      ).bind(
        aliasRow.alias,
        trapDomain,
        fromAddr || null,
        fromDomain,
        original.subject,
        urlCount,
        attachmentCount,
      ).run();
    } catch (err) {
      console.warn(`[abuse-mailbox] cross-link to spam_trap_captures failed:`, err);
      // Non-fatal — the abuse_inbox_messages row is already in.
    }
  }

  // Sprint follow-ups: AI classification + ack email + determination
  // email all hang off this row; they're separate cron / queue work.
}

// ─── Wave-2 PR-AC: in-process cache of the self-org id ──────────
// Resolves the _averrow_platform org id once per worker isolate, then
// short-circuits subsequent lookups. Matches the same pattern used in
// handlers/adminAbuseMailbox.ts but kept local here so the email path
// has zero import cost.
let cachedSelfOrgId: number | null = null;
async function getAverrowSelfOrgId(env: Env): Promise<number | null> {
  if (cachedSelfOrgId !== null) return cachedSelfOrgId;
  try {
    const row = await env.DB.prepare(
      "SELECT id FROM organizations WHERE slug = '_averrow_platform'",
    ).first<{ id: number }>();
    if (row?.id) {
      cachedSelfOrgId = row.id;
      return cachedSelfOrgId;
    }
  } catch {
    // Migration 0180 not yet applied — fall through to null.
  }
  return null;
}

// ─── Helpers (small + scoped to this file) ──────────────────────

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

function extractHeaders(rawText: string): Record<string, string> {
  let headerEnd = rawText.indexOf("\r\n\r\n");
  if (headerEnd < 0) headerEnd = rawText.indexOf("\n\n");
  const section = headerEnd > 0 ? rawText.substring(0, headerEnd) : rawText.substring(0, 5000);
  const headers: Record<string, string> = {};
  const unfolded = section.replace(/\r?\n(\s+)/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.substring(0, colon).trim().toLowerCase();
    const value = line.substring(colon + 1).trim();
    headers[name] = headers[name] ? headers[name] + "; " + value : value;
  }
  return headers;
}

function extractBody(rawText: string, maxLen: number): string {
  let bodyStart = rawText.indexOf("\r\n\r\n");
  if (bodyStart < 0) bodyStart = rawText.indexOf("\n\n");
  if (bodyStart < 0) return rawText.slice(0, maxLen);

  const offset = bodyStart + (rawText.charAt(bodyStart) === "\r" ? 4 : 2);
  const remainder = rawText.slice(offset, offset + maxLen);

  // Strip MIME boundary noise + return only the first plaintext
  // chunk. Multipart parsing is lossy but enough for a snippet.
  const plainStart = remainder.search(/Content-Type:\s*text\/plain/i);
  if (plainStart >= 0) {
    const afterCt = remainder.slice(plainStart);
    const bodyAfterHeaders = afterCt.search(/\r?\n\r?\n/);
    if (bodyAfterHeaders >= 0) {
      const start = afterCt.search(/\r?\n\r?\n/) + 4;
      return afterCt.slice(start).split(/--[-A-Za-z0-9]+/)[0]?.trim() ?? remainder;
    }
  }
  return remainder;
}

interface ForwardedOriginal {
  from:        string | null;
  subject:     string | null;
  bodySnippet: string | null;
}

const FORWARD_DELIMITERS = [
  /---------- Forwarded message ----------/i,
  /-----Original Message-----/i,
  /Begin forwarded message:/i,
  /^From:\s.+\nDate:\s.+\nSubject:\s.+/m,    // raw header injection style
];

function extractForwardedOriginal(body: string): ForwardedOriginal {
  // Find the start of the forwarded content. If we can't find any
  // marker, fall back to extracting headers from the start of the
  // body (sometimes Apple Mail just inlines original headers).
  let cutAt = 0;
  for (const re of FORWARD_DELIMITERS) {
    const m = re.exec(body);
    if (m) {
      cutAt = m.index + m[0].length;
      break;
    }
  }
  const forwarded = body.slice(cutAt).trimStart();

  // Pull out From: + Subject: from the first ~5 lines.
  const headerWindow = forwarded.split(/\r?\n/).slice(0, 10).join("\n");
  const fromMatch    = /^From:\s*(.+)$/im.exec(headerWindow);
  const subjectMatch = /^Subject:\s*(.+)$/im.exec(headerWindow);

  // Body snippet: lines AFTER the inline headers, capped.
  const bodyLines = forwarded.split(/\r?\n/);
  let bodyStart = 0;
  for (let i = 0; i < Math.min(bodyLines.length, 12); i++) {
    if (bodyLines[i]?.trim() === "") { bodyStart = i + 1; break; }
  }
  const snippet = bodyLines.slice(bodyStart).join("\n").trim().slice(0, SNIPPET_LIMIT);

  return {
    from:        fromMatch ? parseEmailAddress(fromMatch[1] ?? null) : null,
    subject:     subjectMatch ? (subjectMatch[1] ?? "").trim().slice(0, 500) : null,
    bodySnippet: snippet || null,
  };
}

function parseEmailAddress(value: string | null): string | null {
  if (!value) return null;
  // Handles "Name <addr@example.com>" and bare "addr@example.com".
  const angle = /<([^>]+)>/.exec(value);
  if (angle?.[1]) return angle[1].trim().toLowerCase();
  const trimmed = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

// ─── URL extraction ─────────────────────────────────────────────
//
// PR-AS: emit a dedup'd list of {url, domain, count} per message
// instead of just a count. URL is normalised (trailing punctuation
// stripped, capped to SINGLE_URL_MAX). Domain best-effort parsed
// from the URL (skipped if URL constructor throws).

export interface ExtractedUrl {
  url:    string;
  domain: string | null;
  count:  number;
}

const URL_RE = /https?:\/\/[^\s<>"'\]]+/gi;

function stripTrailingJunk(u: string): string {
  // Strip RFC822 / Markdown trailers commonly glued to the URL by the
  // sender's mail client: ),.,;.,!,?,>,",',],[,space-collapsed etc.
  return u.replace(/[)\].,;:!?'"]+$/g, "");
}

export function extractUrls(body: string): ExtractedUrl[] {
  const matches = body.match(URL_RE) ?? [];
  const buckets = new Map<string, { url: string; domain: string | null; count: number }>();
  for (const raw of matches) {
    const cleaned = stripTrailingJunk(raw).slice(0, SINGLE_URL_MAX);
    if (cleaned.length < 8) continue;
    let domain: string | null = null;
    try {
      domain = new URL(cleaned).hostname.toLowerCase() || null;
    } catch {
      // Malformed — keep the URL but no domain.
    }
    const key = cleaned.toLowerCase();
    const existing = buckets.get(key);
    if (existing) existing.count++;
    else buckets.set(key, { url: cleaned, domain, count: 1 });
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

// ─── Attachment extraction ─────────────────────────────────────
//
// PR-AS: emit a list of {filename, mime_type} per attachment header
// found in the raw text. Filename is decoded from MIME-encoded /
// RFC2231 forms where straightforward; falls back to the raw value
// otherwise. MIME type pulled from the nearest Content-Type header
// inside the same MIME part.

export interface ExtractedAttachment {
  filename:  string;
  mime_type: string | null;
}

export function extractAttachments(rawText: string): ExtractedAttachment[] {
  // Cap the scan window so we don't blow CPU on huge base64 payloads.
  // Attachments appear early in the multipart structure; 256KB covers
  // the headers of all reasonable forwards.
  const window = rawText.slice(0, 256 * 1024);
  const out: ExtractedAttachment[] = [];
  // Match each "Content-Disposition: attachment; filename=..." occurrence
  // and walk backwards to find the Content-Type for that MIME part.
  const re = /Content-Disposition:\s*attachment[^\n]*?filename\*?=([^;\r\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    if (out.length >= ATTACHMENT_MAX_ENTRIES) break;
    const rawValue = (m[1] ?? "").trim();
    const filename = decodeAttachmentFilename(rawValue);
    if (!filename) continue;
    // Look back up to 2KB for the preceding Content-Type header.
    const lookbackStart = Math.max(0, m.index - 2_048);
    const lookback = window.slice(lookbackStart, m.index);
    const ctMatch = /Content-Type:\s*([^;\r\n]+)/i.exec(lookback);
    const mimeType = ctMatch?.[1]?.trim().toLowerCase() ?? null;
    out.push({ filename, mime_type: mimeType });
  }
  return out;
}

function decodeAttachmentFilename(raw: string): string | null {
  if (!raw) return null;
  // Strip outer quotes.
  let v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  // RFC 2231: filename*=UTF-8''<percent-encoded>
  if (v.toLowerCase().startsWith("utf-8''")) {
    try { v = decodeURIComponent(v.slice(7)); } catch { /* fall through */ }
  }
  // RFC 2047 encoded-word: =?charset?B?...?= or =?charset?Q?...?=
  // Light-touch decoder — only the common UTF-8/B and Q variants.
  v = v.replace(/=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g, (_full, _cs, enc, payload) => {
    try {
      if (enc === "B" || enc === "b") {
        return decodeBase64Utf8(payload);
      }
      // Q encoding — _ is space, =HH is hex
      return payload
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_q: string, hex: string) =>
          String.fromCharCode(parseInt(hex, 16)));
    } catch {
      return payload;
    }
  });
  v = v.trim();
  if (!v) return null;
  // Cap at 256 chars to keep stored JSON small.
  return v.slice(0, 256);
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ─── Storage caps ──────────────────────────────────────────────

function truncate(s: string | null, max: number): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function capJson(value: unknown, max: number): string {
  const s = JSON.stringify(value);
  return s.length <= max ? s : s.slice(0, max);
}
