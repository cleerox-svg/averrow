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
//   4. Decides the backscatter guard (strict single-mailbox From +
//      envelope registrable-domain match + dmarc=pass from OUR MTA's
//      Authentication-Results) and the flood throttle, then inserts an
//      abuse_inbox_messages row with classification='pending' carrying
//      both decisions, then:
//        a. Sends the instant ack email back to the forwarder (only when
//           the guard passed and the row isn't throttled / a follow-up)
//        b. Dispatches the per-message AbuseMailboxTriageWorkflow for
//           every non-throttled, non-follow-up row: rules-based verdict →
//           ~2 min → determination email (suppressed rows get the verdict
//           but no email; the hourly `17 * * * *` agent is the sweeper)
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

  // Tier 3: resolve per-org responder branding once. Drives the ack
  // From/subject/branding AND the follow-up detection regex below
  // (the reply subject carries the org's branded prefix, not "Averrow").
  const { loadAbuseBranding } = await import("../lib/abuse-mailbox-branding");
  const branding = await loadAbuseBranding(env, aliasRow.org_id);

  // 3. Parse headers from the OUTER envelope (this is the forward,
  // not the original suspicious email).
  const outerHeaders = extractHeaders(rawText);

  // ─── Backscatter guard (computed BEFORE the INSERT) ─────────────
  //
  // The ack / determination go to the header-From, which a sender can
  // forge. decideBackscatterGuard parses that header ONCE with a strict
  // single-mailbox validator and requires POSITIVE authentication: the
  // FIRST (topmost) plain Authentication-Results header must carry our own
  // MTA's authserv-id (mx.cloudflare.net) and report dmarc=pass for the
  // header-From domain, and that domain must match the SMTP envelope
  // sender's registrable domain. A different topmost authserv-id, no
  // Authentication-Results, or an ARC-only message → suppressed; lower
  // instances and ARC-Authentication-Results are never consulted (they
  // arrived with the message). The decision is written by the INSERT
  // itself (responder_suppressed_reason + responder_guard_version) —
  // there is no window in which a suppressed row looks email-eligible.
  //
  // Header source: the RAW header block, via extractHeaderInstances, in
  // wire order (topmost first). NOT message.headers: Headers.get() joins
  // duplicate fields with ", " — and ',' is legal inside an
  // Authentication-Results value — so instance boundaries (and therefore
  // "which one is topmost") cannot be recovered from it reliably.
  const { decideBackscatterGuard, RESPONDER_GUARD_VERSION } = await import("../lib/abuse-mailbox-responder");
  const rawFromHeader = outerHeaders["from"] ?? null;
  const backscatter = decideBackscatterGuard({
    headerFrom:   rawFromHeader ?? message.from,
    envelopeFrom: message.from,
    authResultsHeaders: extractHeaderInstances(rawText, "authentication-results"),
  });
  // The strictly-parsed recipient is the stored forwarded_by_email and the
  // exact Resend `to`. When the From header is not a single valid mailbox,
  // keep a best-effort parse for forensics — that row is suppressed.
  const forwardedBy = backscatter.recipient ?? parseEmailAddress(rawFromHeader ?? message.from);

  const bodyParts = extractBodyParts(rawText, RAW_BODY_SCAN_MAX);
  const body = bodyParts.text ||
    (bodyParts.html ? htmlToText(bodyParts.html).slice(0, RAW_BODY_SCAN_MAX) : "");

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
  const inlineInner = extractForwardedOriginal(body, forwardedBy);
  const outerSubjectRaw = decodeEncodedWords(outerHeaders["subject"] ?? "").trim() || null;
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
  // HTML hrefs too: a phishing button's real target often never appears
  // in the text/plain alternative.
  const outerUrls       = mergeUrlLists(extractUrls(body), extractUrls(extractHtmlHrefs(bodyParts.html)));
  const innerUrls       = rfc822Inner
    ? mergeUrlLists(extractUrls(rfc822Inner.body), extractUrls(rfc822Inner.hrefs))
    : [];
  const extractedUrls   = mergeUrlLists(outerUrls, innerUrls);
  const urlCount        = extractedUrls.length;
  const attachmentList  = extractAttachments(rawText);
  const attachmentCount = attachmentList.length;
  // Store the inner (phishing) body when available — that's the
  // forensic value. Falls back to outer body for direct submissions
  // and inline forwards (which already include inner content in body).
  const storedBody      = rfc822Inner?.body || body;
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
    // When no forwarded original was recovered, original.from is the
    // REPORTER (PR-AO fallback). Their domain says nothing about which
    // brand is being impersonated — matching on it tagged every Gmail
    // user's report as brand_gmail_com.
    const fromIsReporter = !rfc822Inner?.from && !inlineInner.from;
    const fromDomain = original.from && !fromIsReporter
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
      // PR-BR: strip CR/LF before logging — matched_on is taken from
      // attacker-controlled email subject / from-domain / body
      // snippet. Newline injection in logs can corrupt log-parsing
      // pipelines. Cloudflare's logs are JSON-encoded so impact is
      // bounded, but the canonical strip is cheap.
      const safeMatchedOn = match.matched_on.replace(/[\r\n\t]/g, " ").slice(0, 80);
      const safeBrandName = match.brand_name.replace(/[\r\n\t]/g, " ");
      console.log(
        `[abuse-mailbox] brand match: ${safeBrandName} ` +
        `(${match.signal}, conf=${match.confidence}, on="${safeMatchedOn}")`,
      );
    }
  } catch (err) {
    console.warn("[abuse-mailbox] brand match failed:", err);
  }

  // 5b. Throttle decision (PR-AT bad-actor protection).
  //
  // Rolling-60-min caps per sender, per sender REGISTRABLE domain, per
  // org and globally. When fired, the row is still INSERTed (forensic
  // capture preserved) but the downstream cost paths skip:
  //   - sendAck + the triage Workflow dispatch below
  //   - the rules pass and the AI classifier (both filter throttled rows)
  //   - the determination email (the claim refuses throttled rows)
  const { throttleReasonLabel } = await import("../lib/abuse-mailbox-throttle");
  const throttle = await decideAbuseMailboxThrottle(env, forwardedBy, { orgId: aliasRow.org_id });
  const forwardedByDomain = extractSenderDomain(forwardedBy);
  if (throttle.throttled) {
    console.warn(
      `[abuse-mailbox] throttled — reason=${throttle.reason} ` +
      `sender=${forwardedBy} domain=${throttle.sender_reg_domain} ` +
      `sender_count=${throttle.sender_count_last_window} ` +
      `domain_count=${throttle.domain_count_last_window} ` +
      `org_count=${throttle.org_count_last_window} ` +
      `global_count=${throttle.global_count_last_window}`,
    );
    // PR-AW: notify super_admins when the throttle fires. Group-key dedup
    // is per-(reason|dimension), so a flood from one source produces one
    // notification per hour — not one per inbound message. Failures here
    // are non-fatal (the capture row + console.warn above remain the
    // source of truth).
    try {
      const { createNotification } = await import("../lib/notifications");
      const throttleDim =
        throttle.reason === "sender_rate_limit" ? `sender:${forwardedBy}`
        : throttle.reason === "domain_rate_limit" ? `domain:${throttle.sender_reg_domain ?? "unknown"}`
        : throttle.reason === "org_rate_limit" ? `org:${aliasRow.org_id}`
        : "global";
      const reasonLabel = throttleReasonLabel(throttle.reason);
      await createNotification(env, {
        type: "abuse_mailbox_flood_detected",
        severity: "medium",
        title: `Abuse mailbox flood detected — ${reasonLabel.toLowerCase()}`,
        message: `${forwardedBy ?? "(no sender)"} via ${throttle.sender_reg_domain ?? "(no domain)"} — ` +
          `${throttle.sender_count_last_window} from this sender / ` +
          `${throttle.domain_count_last_window} from this domain / ` +
          `${throttle.org_count_last_window} to this org / ` +
          `${throttle.global_count_last_window} overall in the last hour (counts capped at each limit).`,
        // Path is basename-relative — `/v2/admin/...` would get
        // double-prefixed by React Router's basename="/v2" and 404.
        link: "/admin/abuse-mailbox",
        audience: "super_admin",
        groupKey: `abuse_mailbox_flood_detected:${throttle.reason ?? "unknown"}:${throttleDim}`,
        reasonText: "Abuse-alias captures are exceeding a per-hour limit (per sender, sending domain, organization, or overall).",
        recommendedAction: "Open the Abuse Mailbox — flooding captures are still recorded but skip ack, triage and determination emails to preserve quota.",
        metadata: {
          throttle_reason: throttle.reason,
          sender_email: forwardedBy,
          sender_domain: forwardedByDomain,
          sender_reg_domain: throttle.sender_reg_domain,
          sender_count_last_window: throttle.sender_count_last_window,
          domain_count_last_window: throttle.domain_count_last_window,
          org_count_last_window: throttle.org_count_last_window,
          global_count_last_window: throttle.global_count_last_window,
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
    // Match a reply to one of OUR outbound emails: "Re: <prefix> · …".
    // The prefix is the org's branded subject prefix (Tier 3), falling
    // back to "Averrow". Escape it so a prefix with regex metachars is
    // matched literally.
    const escaped = branding.subjectPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const followUpRe = new RegExp(`^re\\s*:\\s*${escaped}\\s*\\u00B7`, "i");
    return followUpRe.test(s);
  })();
  const initialClassification = isFollowUp ? "follow_up" : "pending";
  const initialSeverity = "LOW";

  if (!backscatter.send) {
    console.warn(`[abuse-mailbox] responder suppressed for ${messageId}: ${backscatter.reason}`);
  }

  await env.DB.prepare(
    `INSERT INTO abuse_inbox_messages (
       id, org_id, brand_id, received_at, forwarded_by_email, forwarded_by_domain, inbound_alias,
       original_from, original_subject, original_body_snippet,
       attachment_count, url_count,
       raw_body, raw_headers, extracted_urls, attachment_names, raw_size_bytes,
       throttled, throttle_reason,
       auth_results, sender_ip, correlated_threat_ids,
       classification, severity, status,
       responder_suppressed_reason, forwarded_by_reg_domain, responder_guard_version,
       created_at, updated_at
     ) VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, datetime('now'), datetime('now'))`,
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
    backscatter.send ? null : backscatter.reason,
    throttle.sender_reg_domain,
    // Marks this row as decided by the guard above (migration 0273); rows a
    // pre-guard Worker inserted stay NULL and are never emailed.
    RESPONDER_GUARD_VERSION,
  ).run();

  // ─── Wave-3 PR-AD: ack-on-receipt ──────────────────────────────
  //
  // Sends within ~1 minute of receipt per the marketing report-abuse
  // page SLA. Suppressed for empty/own-domain/malformed submitter
  // addresses (no harvester loop-back). Stamps ack_sent_at on success
  // so the operator UI can show ack state per message and so the
  // determination path knows the ack already fired.
  //
  // We DON'T retry on failure — the determination email follows
  // regardless (per-message Workflow, hourly sweeper as backstop).
  //
  // PR-AT: skip when throttle.throttled. Sending an ack to a flooding
  // sender just gives them feedback that the alias is live and burns
  // Resend quota; the row is still captured for forensic purposes.
  //
  // PR-BD: also skip for follow_up rows. The submitter is replying
  // to one of our previous emails — they're already in conversation.
  // Auto-acking their reply would generate the "got it!" -> "you
  // got it!" loop that abuse-mailbox responders are notorious for.
  //
  // Backscatter: skip when the header-From can't be trusted (above).
  const triageEligible = !throttle.throttled && !isFollowUp;
  if (triageEligible && backscatter.send && backscatter.recipient) {
    try {
      const { sendAck } = await import("../lib/abuse-mailbox-responder");
      const ackResult = await sendAck(env, backscatter.recipient, {
        messageId,
        originalSubject: original.subject,
        inboundAlias: aliasRow.alias,
      }, branding);
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

  // ─── Per-message triage Workflow ───────────────────────────────
  //
  // Rules verdict now → ~2 min sleep → at-most-once determination email
  // (workflows/abuseMailboxTriage.ts). Dispatched for EVERY non-throttled,
  // non-follow-up row — including rows whose emails are suppressed — so
  // the verdict (and any promotion / tenant notification) lands within
  // minutes instead of waiting for the hourly sweep; the send step is a
  // no-op for suppressed rows (the claim refuses them). Dispatch failure
  // must never break ingest — the hourly `17 * * * *` sweeper classifies
  // and emails anything the Workflow didn't. Instance id is per message,
  // so a re-delivery of the same Workflow create is a no-op.
  if (triageEligible && env.ABUSE_MAILBOX_TRIAGE) {
    try {
      const { abuseTriageInstanceId } = await import("../lib/abuse-mailbox-triage-pipeline");
      await env.ABUSE_MAILBOX_TRIAGE.create({
        id: abuseTriageInstanceId(messageId),
        params: { messageId },
      });
    } catch (err) {
      console.warn("[abuse-mailbox] triage workflow dispatch failed (hourly sweeper will cover):", err);
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

  // Verdict + determination email are produced by the triage Workflow
  // dispatched above (or by the hourly sweeper) — not inline here.
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

/**
 * Every instance of one header in the OUTER header block, in message order
 * (topmost first), unfolded. extractHeaders() merges repeats with "; " and
 * message.headers.get() with ", ", both of which lose the boundaries
 * between Authentication-Results headers — the backscatter guard needs the
 * topmost one on its own.
 *
 * Ordering assumption: index 0 is the header nearest the top of the wire
 * message, i.e. the one our receiving MTA prepended last. Prod evidence
 * (raw_headers JSON maps, built by extractHeaders from this same raw
 * block): every row's `authentication-results` starts with
 * `mx.cloudflare.net` and is never "; "-joined with another instance, so
 * Cloudflare Email Routing's own header is always this array's [0].
 */
export function extractHeaderInstances(rawText: string, name: string): string[] {
  let headerEnd = rawText.indexOf("\r\n\r\n");
  if (headerEnd < 0) headerEnd = rawText.indexOf("\n\n");
  const section = headerEnd > 0 ? rawText.substring(0, headerEnd) : rawText.substring(0, 5000);
  const unfolded = section.replace(/\r?\n(\s+)/g, " ");
  const wanted = name.toLowerCase();
  const out: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (line.substring(0, colon).trim().toLowerCase() !== wanted) continue;
    out.push(line.substring(colon + 1).trim());
  }
  return out;
}

// ─── MIME body walker ────────────────────────────────────────────
//
// extractBody used to take "the first text/plain chunk" and cut it at the
// first `--word` run, standing in for the MIME boundary. Gmail's inline
// forward marker `---------- Forwarded message ---------` matches that
// pattern, so every Gmail forward was cut right after the reporter's
// signature: no forwarded From/Subject, no body, no URLs — and the rules
// had nothing to decide on (prod rows 2026-10-03, raw_body = 27 bytes).
// It also never decoded quoted-printable / base64, which Gmail uses for
// any non-ASCII body.
//
// This walks the real structure: the boundary comes from the part's own
// Content-Type header, nested multiparts are recursed, transfer encodings
// and charsets are decoded, and text/html is the fallback when a message
// has no text/plain part. Still lossy by design (first text part wins) —
// enough for snippets, URL extraction, and the rules snapshot.

const MAX_MIME_DEPTH = 6;

export interface MimeBodyParts {
  /** First text/plain part, decoded. Empty when none. */
  text: string;
  /** First text/html part, decoded. Null when none. */
  html: string | null;
}

function splitHeaderBody(raw: string): { head: string; body: string } {
  // A part with no headers starts with its blank separator line.
  const lead = /^\r?\n/.exec(raw);
  if (lead) return { head: "", body: raw.slice(lead[0].length) };
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: "" };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

function headerParam(value: string, name: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i");
  const m = re.exec(value);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function bytesFromBinaryString(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder((charset || "utf-8").trim().toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** Decode a part body per Content-Transfer-Encoding + charset. */
export function decodeTransferEncoding(body: string, cte: string | null, charset: string | null): string {
  const enc = (cte ?? "").trim().toLowerCase();
  if (enc === "base64") {
    try {
      // A part cut at the scan cap can end mid-quantum; atob would throw
      // and leave encoded text behind. Decode the whole quanta we have.
      const clean = body.replace(/[^A-Za-z0-9+/=]/g, "");
      return decodeBytes(bytesFromBinaryString(atob(clean.slice(0, clean.length - (clean.length % 4)))), charset);
    } catch {
      return body;
    }
  }
  if (enc === "quoted-printable") {
    const bin = body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return decodeBytes(bytesFromBinaryString(bin), charset);
  }
  // 7bit / 8bit / binary: the raw text was decoded as UTF-8 upstream.
  return body;
}

function walkMime(raw: string, depth: number, out: MimeBodyParts): void {
  if (depth > MAX_MIME_DEPTH) return;
  const { head, body } = splitHeaderBody(raw);
  const headers = extractHeaders(head + "\r\n\r\n");
  const ct = headers["content-type"] ?? "text/plain";
  const type = (ct.split(";")[0] ?? "").trim().toLowerCase();

  if (type.startsWith("multipart/")) {
    const boundary = headerParam(ct, "boundary");
    if (!boundary) {
      // Malformed multipart: keep the raw text rather than nothing.
      if (!out.text) out.text = body.trim();
      return;
    }
    // Delimiters are only valid at the start of a line (RFC 2046 §5.1.1);
    // "--<boundary>" mid-line is body text. The leading CRLF lets a
    // delimiter on the body's very first line match too.
    const delim = new RegExp(`\\r?\\n--${escapeRegExp(boundary)}`);
    const chunks = `\r\n${body}`.split(delim);
    // chunks[0] is the preamble; a chunk starting with "--" is the epilogue.
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (chunk.startsWith("--")) break;
      walkMime(chunk.replace(/^[ \t]*\r?\n/, ""), depth + 1, out);
      if (out.text && out.html !== null) return;
    }
    return;
  }

  // A forwarded message/rfc822 part is handled by extractInnerRfc822Message;
  // don't let the inner email's text stand in for the reporter's own.
  if (type === "message/rfc822") return;
  const disposition = (headers["content-disposition"] ?? "").toLowerCase();
  if (disposition.startsWith("attachment")) return;

  const cte = headers["content-transfer-encoding"] ?? null;
  const charset = headerParam(ct, "charset");
  if (type === "text/plain" && !out.text) {
    out.text = decodeTransferEncoding(body, cte, charset).trim();
  } else if (type === "text/html" && out.html === null) {
    out.html = decodeTransferEncoding(body, cte, charset);
  }
}

/** Walk a full raw message (headers + body) into its first text/plain and text/html parts. */
export function extractBodyParts(rawText: string, maxLen: number): MimeBodyParts {
  const out: MimeBodyParts = { text: "", html: null };
  // Headers are never large; cap the body we walk so a huge base64
  // attachment can't blow CPU.
  const { head, body } = splitHeaderBody(rawText);
  walkMime(`${head}\r\n\r\n${body.slice(0, maxLen * 4)}`, 0, out);
  out.text = out.text.slice(0, maxLen);
  if (out.html !== null) out.html = out.html.slice(0, maxLen);
  return out;
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** HTML entities: named basics + numeric (&#116; / &#x74;). `&amp;` last,
 *  so "&amp;lt;" stays "&lt;" instead of becoming "<". */
export function decodeHtmlEntities(v: string): string {
  return v
    .replace(/&#(\d{1,7});/g, (m, d: string) => {
      const n = Number(d);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, h: string) => {
      const n = parseInt(h, 16);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

// Attacker-controlled input: every pattern below is linear. A tag is
// `<` + at most MAX_TAG_LEN non-angle chars + `>`; no lazy `[\s\S]*?`
// spans and no nested unbounded quantifiers (an earlier version took
// tens of seconds on 20 KB of unclosed `<a href="x"`).
const MAX_TAG_LEN = 2048;
const TAG_RE = new RegExp(`<([^<>]{0,${MAX_TAG_LEN}})>`, "g");
const HREF_IN_TAG_RE = /\bhref\s{0,8}=\s{0,8}(?:"([^"]{1,2048})"|'([^']{1,2048})')/i;
const BLOCK_TAG_RE = /^\/?(p|div|tr|li|br|h[1-6]|table|ul|ol)\b/i;

/** Plain text from HTML: links kept as `text (href)` so extractUrls still sees them. */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  let last = 0;
  let skipUntil: string | null = null;   // inside <script>/<style>/<head>
  let pendingHref: string | null = null;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    const inner = m[1] ?? "";
    const name = (/^\/?([a-z0-9]{1,10})/i.exec(inner)?.[1] ?? "").toLowerCase();
    if (skipUntil === null) parts.push(html.slice(last, m.index));
    last = m.index + m[0].length;

    if (skipUntil !== null) {
      if (inner.startsWith("/") && name === skipUntil) skipUntil = null;
      continue;
    }
    if (!inner.startsWith("/") && (name === "script" || name === "style" || name === "head")) {
      skipUntil = name;
      continue;
    }
    if (name === "a" && !inner.startsWith("/")) {
      const h = HREF_IN_TAG_RE.exec(inner);
      pendingHref = h ? (h[1] ?? h[2] ?? null) : null;
      continue;
    }
    if (name === "a" && inner.startsWith("/")) {
      if (pendingHref) parts.push(` (${decodeHtmlEntities(pendingHref)})`);
      pendingHref = null;
      continue;
    }
    parts.push(BLOCK_TAG_RE.test(inner) ? "\n" : " ");
  }
  if (skipUntil === null) parts.push(html.slice(last));
  return decodeHtmlEntities(parts.join(""))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n[ \t\n]*/g, (nl) => (nl.split("\n").length > 2 ? "\n\n" : "\n"))
    .trim();
}

/** href targets in an HTML part — phishing buttons hide the real link here. */
export function extractHtmlHrefs(html: string | null): string {
  if (!html) return "";
  const out: string[] = [];
  const re = /\bhref\s{0,8}=\s{0,8}["']([^"'<>]{1,2048})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 200) {
    const href = decodeHtmlEntities(m[1]!).trim();
    if (/^https?:\/\//i.test(href)) out.push(href);
  }
  return out.join("\n");
}

interface ForwardedOriginal {
  from:        string | null;
  subject:     string | null;
  bodySnippet: string | null;
}

const FORWARD_DELIMITERS = [
  /-{5,}\s*Forwarded message\s*-{5,}/i,
  /-----Original Message-----/i,
  /Begin forwarded message:/i,
  /^From:\s.+\r?\nDate:\s.+\r?\nSubject:\s.+/m,    // raw header injection style
];

/** Explicit forward markers (no raw-header pattern: inside a layer that
 *  pattern matches the layer's own header block and cuts it mid-way). */
const LAYER_MARKERS = FORWARD_DELIMITERS.slice(0, 3);
/** Raw "From:/Date:/Subject:" injection — top-level fallback only. */
const RAW_HEADER_MARKER = FORWARD_DELIMITERS[3]!;

/** Earliest explicit forward marker in `text`, or null. */
function firstForwardMarker(text: string): { index: number; end: number } | null {
  let best: { index: number; end: number } | null = null;
  for (const re of LAYER_MARKERS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, end: m.index + m[0].length };
  }
  return best;
}

/** Max nested forward layers walked (reporter re-forwarding their own forward). */
const MAX_FORWARD_LAYERS = 5;

/**
 * Original sender / subject / body of an inline forward.
 *
 * Nested forwards: a reporter who forwards their OWN earlier forward
 * produces "Forwarded message / From: <reporter>" on top of the real one.
 * Layers whose From is the reporter are skipped until the first layer
 * from someone else. Safe against spoofing: only layers ABOVE the first
 * non-reporter sender are skipped, and an attacker's content always sits
 * below that sender, so a fake marker inside a phish is never reached.
 */
export function extractForwardedOriginal(body: string, reporter: string | null = null): ForwardedOriginal {
  const reporterAddr = reporter?.trim().toLowerCase() || null;
  let rest = body;
  let parsed: ForwardedOriginal = { from: null, subject: null, bodySnippet: null };
  for (let layer = 0; layer < MAX_FORWARD_LAYERS; layer++) {
    let marker = firstForwardMarker(rest);
    if (!marker && layer === 0) {
      // Raw header injection style, or headers inlined at the top (Apple
      // Mail) — both only meaningful for the first layer.
      const raw = RAW_HEADER_MARKER.exec(rest);
      if (raw) marker = { index: raw.index, end: raw.index };
    }
    if (!marker && layer > 0) break;
    const forwarded = (marker ? rest.slice(marker.end) : rest).trimStart();
    parsed = parseForwardBlock(forwarded);
    if (!marker || !reporterAddr || parsed.from !== reporterAddr) break;
    // This layer is the reporter's own forward — look one layer deeper.
    const next = firstForwardMarker(forwarded);
    if (!next) break;
    rest = forwarded;
  }
  return parsed;
}

function parseForwardBlock(forwarded: string): ForwardedOriginal {
  // Header block: the first lines up to the first blank line (cap 12).
  const lines = forwarded.split(/\r?\n/);
  let headerEnd = Math.min(lines.length, 12);
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    if (lines[i]?.trim() === "") { headerEnd = i; break; }
  }
  const header = lines.slice(0, headerEnd);
  // Unfold: a line that doesn't start a new "Name:" header continues the
  // previous one (Gmail wraps long Subject lines).
  const fields: string[] = [];
  for (const l of header) {
    if (/^[A-Za-z][A-Za-z-]{0,30}:\s/.test(l) || fields.length === 0) fields.push(l);
    else fields[fields.length - 1] += ` ${l.trim()}`;
  }
  const fromLine    = fields.find((f) => /^From:\s/i.test(f));
  const subjectLine = fields.find((f) => /^Subject:\s/i.test(f));
  const snippet = lines.slice(headerEnd + 1).join("\n").trim().slice(0, SNIPPET_LIMIT);
  return {
    from:        fromLine ? parseEmailAddress(fromLine.replace(/^From:\s*/i, "")) : null,
    subject:     subjectLine ? subjectLine.replace(/^Subject:\s*/i, "").trim().slice(0, 500) || null : null,
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
  /** Newline-joined http(s) href targets from the inner email's HTML part. */
  hrefs:   string;
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
  // The inner message ends at the ENCLOSING part's next delimiter — not at
  // the first `--x` line, which is usually the inner message's own
  // multipart/alternative delimiter (that cut every Gmail/Outlook
  // forward-as-attachment down to an empty body). The enclosing delimiter
  // is the last `--<boundary>` line before this part's headers.
  const after = scanWindow.slice(innerStart);
  const before = scanWindow.slice(0, ctIdx);
  const outerDelims = [...before.matchAll(/(?:^|\n)--([A-Za-z0-9'()+_,./:=?-]{1,70})[ \t]*\r?$/gm)];
  const outerBoundary = outerDelims.length > 0 ? outerDelims[outerDelims.length - 1]![1]! : null;
  let innerEnd = scanWindow.length;
  if (outerBoundary) {
    const end = new RegExp(`\\r?\\n--${escapeRegExp(outerBoundary)}(?:--)?[ \\t]*(?:\\r?\\n|$)`).exec(after);
    if (end) innerEnd = innerStart + end.index;
  } else {
    const boundaryMatch = /\r?\n--[A-Za-z0-9'()+_,./:=?-]+/.exec(after);
    if (boundaryMatch) innerEnd = innerStart + boundaryMatch.index;
  }
  const innerRaw = scanWindow.slice(innerStart, innerEnd);

  if (innerRaw.trim().length === 0) return null;

  // Parse the inner email's headers + body using the same helpers.
  // extractBody walks the inner multipart too (covers the common case
  // of HTML+plaintext alternatives inside the forwarded message).
  const innerHeaders = extractHeaders(innerRaw);
  const innerParts = extractBodyParts(innerRaw, maxBodyLen);
  const innerBody = innerParts.text ||
    (innerParts.html ? htmlToText(innerParts.html).slice(0, maxBodyLen) : "");
  const innerFrom = parseEmailAddress(innerHeaders["from"] ?? null);
  const innerSubject = decodeEncodedWords(innerHeaders["subject"] ?? "").trim() || null;

  return {
    from: innerFrom,
    subject: innerSubject ? innerSubject.slice(0, 500) : null,
    body: innerBody,
    hrefs: extractHtmlHrefs(innerParts.html),
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
  v = decodeEncodedWords(v);
  v = v.trim();
  if (!v) return null;
  // Cap at 256 chars to keep stored JSON small.
  return v.slice(0, 256);
}

/**
 * RFC 2047 encoded-words (=?charset?B|Q?...?=) → text. Adjacent words
 * separated only by whitespace are joined without it (§6.2), and the
 * decoded bytes go through the declared charset, so multi-byte UTF-8
 * (emoji, accents) survives Q encoding.
 */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (full, cs: string, enc: string, payload: string) => {
      try {
        const bin = enc === "B" || enc === "b"
          ? atob(payload)
          : payload.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_q, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)));
        return decodeBytes(bytesFromBinaryString(bin), cs);
      } catch {
        return full;
      }
    });
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
