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
import { loadMonitoredBrands, matchAbuseMailboxBrand } from "../lib/abuse-mailbox-brand-match";

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
  // forwarded chunk. Two paths, tried in order:
  //
  //   (a) PR-AZ: `message/rfc822` attachment — Gmail/Outlook/Apple
  //       Mail "Forward as attachment". The original email is wrapped
  //       in a MIME part we can parse cleanly. This is the most
  //       reliable signal when present.
  //   (b) Inline forward — "---------- Forwarded message ---------"
  //       or "-----Original Message-----" header injection that
  //       Outlook/Gmail/Apple Mail use for inline forwards.
  //
  // PR-AO: when both return nulls (submitter wrote a fresh report
  // instead of forwarding), fall back to the OUTER envelope as the
  // "original". For a fresh report, the outer From IS the original
  // sender and the outer Subject IS what the user wrote.
  const rfc822Inner = extractInnerRfc822Message(rawText, RAW_BODY_SCAN_MAX);
  const inlineInner = extractForwardedOriginal(body);
  const outerSubjectRaw = (outerHeaders["subject"] ?? "").trim() || null;
  const outerBodySnippet = body.slice(0, SNIPPET_LIMIT) || null;

  // Precedence: rfc822 inner → inline inner → outer envelope.
  const innerFrom    = rfc822Inner?.from    ?? inlineInner.from    ?? forwardedBy;
  const innerSubject = rfc822Inner?.subject ?? inlineInner.subject ?? outerSubjectRaw;
  const innerBodySnippet =
    (rfc822Inner?.body ? rfc822Inner.body.slice(0, SNIPPET_LIMIT) : null)
    ?? inlineInner.bodySnippet
    ?? outerBodySnippet;
  const original = {
    from: innerFrom,
    subject: innerSubject,
    bodySnippet: innerBodySnippet,
  };

  // 5. Count + extract URLs and attachments.
  //
  // PR-AS: in addition to the existing counts (kept for the list
  // view's quick-read columns), capture the dereferenced URL list,
  // attachment filenames + MIME types, full body, and full headers
  // for drill-down + downstream AI analysis.
  //
  // PR-AZ: union URLs from outer body + inner rfc822 body so URLs
  // hidden inside a forward-as-attachment surface to extractUrls,
  // correlateUrls, and the classifier prompt. dedupeUrlLists merges
  // by URL string and sums counts.
  const outerUrls       = extractUrls(body);
  const innerUrls       = rfc822Inner ? extractUrls(rfc822Inner.body) : [];
  const extractedUrls   = mergeUrlLists(outerUrls, innerUrls);
  const urlCount        = extractedUrls.length;
  const attachmentList  = extractAttachments(rawText);
  const attachmentCount = attachmentList.length;
  // Store the inner (phishing) body when available — that's the
  // forensic value. Falls back to outer body for direct submissions
  // and inline forwards (which already include inner content in body).
  const storedBody      = rfc822Inner?.body ?? body;
  const rawBody         = truncate(storedBody, RAW_BODY_STORE_MAX);
  // PR-AZ: when an rfc822 inner message exists, store BOTH header sets
  // so the admin UI can show the phisher's full header chain alongside
  // the user's forward path. Outer remains under top-level keys (keeps
  // existing readers working); inner goes under `_forwarded_inner`.
  const headersForStorage: Record<string, unknown> = rfc822Inner
    ? { ...outerHeaders, _forwarded_inner: rfc822Inner.headers }
    : outerHeaders;
  const rawHeadersJson  = capJson(headersForStorage, RAW_HEADERS_STORE_MAX);
  const urlsJson        = capJson(extractedUrls.slice(0, URL_LIST_MAX_ENTRIES), URLS_STORE_MAX);
  const attachmentsJson = capJson(attachmentList.slice(0, ATTACHMENT_MAX_ENTRIES), ATTACHMENTS_STORE_MAX);

  // PR-AX: parse auth results + sender IP from headers (pure, zero D1),
  // and correlate the extracted URLs against the platform's existing
  // threat intel. Correlations stamp on the row so the classifier sees
  // them and the UI can render "this URL is already known". Bounded
  // at the first 20 URLs internally.
  //
  // PR-AZ: auth/IP parsed from the INNER rfc822 headers when present.
  // Outer envelope SPF/DKIM = the user's mail provider (always passes
  // on a forward); inner = the original sender (the actual signal).
  const authSource   = rfc822Inner?.headers ?? outerHeaders;
  const authResults  = parseAuthResults(authSource);
  const senderIp     = parseSenderIp(authSource);
  const correlations = await correlateUrls(env, extractedUrls);
  const correlatedThreatIds = correlations.map((c) => c.threat_id);
  const authResultsJson     = JSON.stringify(authResults);
  const correlatedIdsJson   = JSON.stringify(correlatedThreatIds);

  // 5c. PR-BA: match against monitored brands so promoted threats
  // get `target_brand_id` set. Without this, abuse-mailbox-sourced
  // threats land in the global threats table unlinked — tenants
  // monitoring an impersonated brand never see them on the brand
  // page. Pure function over the extracted signals + a single
  // catalog query. Failures here are non-fatal: row INSERT proceeds
  // with brand_id=NULL, same as pre-PR-BA.
  let matchedBrandId: string | null = null;
  let brandMatchSignal: string | null = null;
  try {
    const monitoredBrands = await loadMonitoredBrands(env);
    const fromDomain = original.from
      ? (original.from.split("@")[1] ?? "").toLowerCase() || null
      : null;
    const match = matchAbuseMailboxBrand(
      {
        from_domain:  fromDomain,
        subject:      original.subject,
        body_snippet: original.bodySnippet,
        url_domains:  extractedUrls.map((u) => u.domain),
      },
      monitoredBrands,
    );
    if (match) {
      matchedBrandId = match.brand_id;
      brandMatchSignal = match.signal;
      console.log(
        `[abuse-mailbox] brand match: ${match.brand_name} ` +
        `(${match.signal}, conf=${match.confidence}, on="${match.matched_on.slice(0, 80)}")`,
      );
    }
  } catch (err) {
    console.warn("[abuse-mailbox] brand match failed:", err);
  }

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
        // Path is basename-relative — `/v2/admin/...` would get
        // double-prefixed by React Router's basename="/v2" and 404.
        link: "/admin/abuse-mailbox",
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

  // PR-BD: follow-up detection. When a submitter replies to one of
  // our ack / determination emails, the reply lands back at the same
  // inbound alias (reply_to wired to inbound_alias in the responder).
  // We don't want such replies to enter the AI pending queue (waste
  // of Haiku + would trigger another determination email loop). And
  // we don't want to ack them — the submitter is already in
  // conversation. Detection heuristic: subject begins with "Re:"
  // followed by "Averrow ·" — Gmail/Apple Mail / Outlook all preserve
  // that prefix when the user hits Reply on our outbound. False
  // positives are bounded: a brand-new abuse report whose forwarded
  // content originally said "Re: Averrow ·" is rare, and the
  // operator can always re-classify by hand from the admin UI.
  const isFollowUp = (() => {
    const s = (original.subject ?? "").trim();
    if (!s) return false;
    return /^re\s*:\s*averrow\s*·/i.test(s);
  })();
  const initialClassification = isFollowUp ? "follow_up" : "pending";
  const initialSeverity = "LOW";

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
     ) VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))`,
  ).bind(
    messageId,
    aliasRow.org_id,
    matchedBrandId,
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
    initialClassification,
    initialSeverity,
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
  //
  // PR-BD: also skip for follow_up rows. The submitter is replying
  // to one of our previous emails — they're already in conversation.
  // Auto-acking their reply would generate the "got it!" -> "you
  // got it!" loop that abuse-mailbox responders are notorious for.
  if (!throttle.throttled && !isFollowUp) {
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
  // PR-BP: 5MB cap. Cloudflare Email Routing accepts up to 25MB per
  // message; without a per-handler cap, a flood of 25MB payloads
  // OOMs the Worker isolate (128MB ceiling). Mirrors dmarc-receiver.ts.
  const MAX_RAW_BYTES = 5 * 1024 * 1024;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
    if (totalLength > MAX_RAW_BYTES) {
      console.warn("[abuse-mailbox] Email exceeds 5MB — truncating");
      break;
    }
  }
  const out = new Uint8Array(Math.min(totalLength, MAX_RAW_BYTES));
  let offset = 0;
  for (const c of chunks) {
    const remaining = out.length - offset;
    if (remaining <= 0) break;
    if (c.length <= remaining) {
      out.set(c, offset);
      offset += c.length;
    } else {
      out.set(c.subarray(0, remaining), offset);
      offset += remaining;
      break;
    }
  }
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

/**
 * Merge two ExtractedUrl lists by URL string (case-insensitive), summing
 * counts. Re-sorted desc by count. Used to combine outer-wrapper URLs +
 * inner-rfc822 URLs when the user forwards as attachment.
 */
export function mergeUrlLists(a: ExtractedUrl[], b: ExtractedUrl[]): ExtractedUrl[] {
  const buckets = new Map<string, ExtractedUrl>();
  for (const u of [...a, ...b]) {
    const key = u.url.toLowerCase();
    const existing = buckets.get(key);
    if (existing) existing.count += u.count;
    else buckets.set(key, { ...u });
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
  const seen = new Set<string>();
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
    seen.add(filename.toLowerCase());
  }

  // PR-AZ: also surface `message/rfc822` parts even when they lack a
  // filename= parameter on Content-Disposition. Gmail's "Forward as
  // attachment" emits the nested email as a bare attachment with no
  // filename, so the regex above missed it — making `attachment_count`
  // misleading and hiding the fact that the inner message is the only
  // place real phishing signals live.
  const rfcRe = /Content-Type:\s*message\/rfc822/gi;
  let r: RegExpExecArray | null;
  let rfcIdx = 1;
  while ((r = rfcRe.exec(window)) !== null) {
    if (out.length >= ATTACHMENT_MAX_ENTRIES) break;
    // If a nearby Content-Disposition has a filename, the previous
    // loop already captured it — don't duplicate.
    const lookahead = window.slice(r.index, r.index + 1024);
    const dispMatch = /Content-Disposition:[^\n]*filename\*?=([^;\r\n]+)/i.exec(lookahead);
    if (dispMatch) {
      const fn = decodeAttachmentFilename((dispMatch[1] ?? "").trim());
      if (fn && seen.has(fn.toLowerCase())) continue;
    }
    out.push({ filename: `forwarded-message-${rfcIdx}.eml`, mime_type: 'message/rfc822' });
    rfcIdx++;
  }

  return out;
}

// ─── Inner message/rfc822 extraction (PR-AZ) ────────────────────
//
// When a user forwards a phishing email as an *attachment* (Gmail's
// "Forward as attachment", Outlook's "Forward as attachment", Apple
// Mail's "Forward as attachment"), the original email is wrapped in
// a `message/rfc822` MIME part of the outer multipart envelope. Our
// existing `extractBody` returns only the first text/plain part —
// which on a forward-as-attachment is the user's outer wrapper (just
// their signature), leaving the actual phishing content invisible to
// extractUrls / extractForwardedOriginal / the classifier prompt.
//
// Production audit (2026-05-19): four consecutive forwarded phishing
// submissions were classified benign because every signal — url_count,
// attachment_count, original_subject, body_snippet — came from the
// 32-byte outer wrapper, not the 15+KB inner phishing email.
//
// Fix: detect `Content-Type: message/rfc822` MIME parts, walk past
// the part-level headers to the inner RFC822 message body, then parse
// THAT as a complete email (headers + body) and surface From/Subject/
// body/URLs to the caller. The handler prefers these inner values
// over the existing inline-forward heuristic.
//
// Returns null when no rfc822 part is found, or when boundary
// detection fails. Caller falls back to the previous extraction
// path (inline forward delimiters → outer envelope).

export interface InnerRfc822Message {
  from:    string | null;
  subject: string | null;
  /** Full plaintext body of the inner email (capped to maxBodyLen). */
  body:    string;
  /** Inner email's raw headers, lower-cased keys, same shape as extractHeaders. */
  headers: Record<string, string>;
}

export function extractInnerRfc822Message(
  rawText: string,
  maxBodyLen = RAW_BODY_SCAN_MAX,
): InnerRfc822Message | null {
  // The MIME boundary marker that ends a part is `\r\n--<boundary>`.
  // We don't need to recover the exact boundary string — a permissive
  // regex over the bcharsnospace set (RFC 2046 §5.1.1) is enough to
  // locate the next part separator.
  //
  // Scan window is large but bounded; rfc822 parts can be tens of KB.
  const scanWindow = rawText.slice(0, 512 * 1024);

  // Find the start of a message/rfc822 part header.
  const ctIdx = scanWindow.search(/Content-Type:\s*message\/rfc822/i);
  if (ctIdx < 0) return null;

  // Walk forward to the blank line that separates the part headers
  // from the part body. The part body — for message/rfc822 — IS a
  // complete RFC822 email with its own headers + body.
  const partStart = ctIdx;
  const afterCt = scanWindow.slice(partStart);
  const blankLine = afterCt.search(/\r?\n\r?\n/);
  if (blankLine < 0) return null;
  const innerStart = partStart + blankLine + (afterCt.charAt(blankLine) === '\r' ? 4 : 2);

  // The inner message ends at the next MIME boundary marker. Boundary
  // chars per RFC 2046: ALPHA DIGIT '()+_,-./:=?
  const after = scanWindow.slice(innerStart);
  const boundaryMatch = /\r?\n--[A-Za-z0-9'()+_,./:=?-]+/.exec(after);
  const innerEnd = boundaryMatch ? innerStart + boundaryMatch.index : scanWindow.length;
  const innerRaw = scanWindow.slice(innerStart, innerEnd);

  if (innerRaw.trim().length === 0) return null;

  // Parse the inner email's headers + body using the same helpers.
  // extractBody walks the inner multipart too (covers the common case
  // of HTML+plaintext alternatives inside the forwarded message).
  const innerHeaders = extractHeaders(innerRaw);
  const innerBody = extractBody(innerRaw, maxBodyLen);
  const innerFrom = parseEmailAddress(innerHeaders["from"] ?? null);
  const innerSubject = (innerHeaders["subject"] ?? "").trim() || null;

  return {
    from: innerFrom,
    subject: innerSubject ? innerSubject.slice(0, 500) : null,
    body: innerBody,
    headers: innerHeaders,
  };
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
