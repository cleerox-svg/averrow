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

  // 5. Count URLs + attachments in the body.
  const urlCount = countUrls(body);
  const attachmentCount = countAttachments(rawText);

  // 6. Insert the row.
  const messageId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO abuse_inbox_messages (
       id, org_id, brand_id, received_at, forwarded_by_email, inbound_alias,
       original_from, original_subject, original_body_snippet,
       attachment_count, url_count,
       classification, severity, status,
       created_at, updated_at
     ) VALUES (?, ?, NULL, datetime('now'), ?, ?, ?, ?, ?, ?, ?, 'pending', 'LOW', 'new', datetime('now'), datetime('now'))`,
  ).bind(
    messageId,
    aliasRow.org_id,
    forwardedBy,
    aliasRow.alias,
    original.from,
    original.subject,
    original.bodySnippet,
    attachmentCount,
    urlCount,
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

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
function countUrls(body: string): number {
  return (body.match(URL_RE) ?? []).length;
}

function countAttachments(rawText: string): number {
  // Each attachment shows a Content-Disposition: attachment header.
  // Cap the search to RAW_BODY_SCAN_MAX*2 so we don't blow CPU on
  // huge messages.
  const window = rawText.slice(0, 65_536);
  const matches = window.match(/Content-Disposition:\s*attachment/gi);
  return matches?.length ?? 0;
}
