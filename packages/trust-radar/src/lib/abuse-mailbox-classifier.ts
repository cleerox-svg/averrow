// Averrow — Abuse Mailbox AI classifier
//
// Per-message Haiku call that classifies forwarded suspicious emails
// sitting in `abuse_inbox_messages` with classification='pending'.
// Pairs with the Email Worker in `handlers/abuseMailboxEmail.ts`
// which inserts those rows.
//
// Cost shape: 1 Haiku call per message (~$0.001/message). At a
// realistic customer scale (5-20 forwarded mails/day across the
// fleet) this is sub-dollar/month — and customer-perceived value
// is high because the determination email is the entire pitch.
//
// Verdict surface (matches the schema in 0150_abuse_mailbox.sql):
//   classification ∈ phishing | spam | benign | malware | ambiguous
//   ai_action      ∈ safe | review | escalate | takedown
//   severity       ∈ LOW | MEDIUM | HIGH | CRITICAL
//
// We map the AI's verdict to severity here in code (not in the
// model output) so the threshold stays auditable + tunable
// without re-prompting.
//
// Per CLAUDE.md AI rules:
//   - Haiku for classification (this fits)
//   - All AI calls go through AI Gateway via callAnthropicJSON
//   - BudgetManager throttling is automatic via the haiku helper

import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../types';
import { callAnthropicJSON, AnthropicError } from './anthropic';
import { HOT_PATH_HAIKU } from './ai-models';

// ─── Public types ────────────────────────────────────────────────

export type AbuseClassification =
  | 'phishing'
  | 'spam'
  | 'benign'
  | 'malware'
  | 'ambiguous';

export type AbuseAction = 'safe' | 'review' | 'escalate' | 'takedown';

export type AbuseSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ClassifyResult {
  classification: AbuseClassification;
  action:         AbuseAction;
  confidence:     number;     // 0-100
  reasoning:      string;     // one short sentence
}

export interface AbuseClassifyContext {
  original_from:         string | null;
  original_subject:      string | null;
  original_body_snippet: string | null;
  url_count:             number;
  attachment_count:      number;
  brand_name:            string | null;
  brand_domain:          string | null;
  // PR-AX — IOC signals fed into the prompt for higher-fidelity verdicts.
  // All optional / nullable so legacy callers without PR-AX data still work.
  url_list?:             ReadonlyArray<{ url: string; domain: string | null; count: number }> | null;
  attachment_list?:      ReadonlyArray<{ filename: string; mime_type: string | null }> | null;
  auth_results?:         { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  sender_ip?:            string | null;
  correlated_threats_count?: number | null;
}

const SYSTEM_PROMPT = `You are a phishing analyst classifying forwarded suspicious emails.
Customers' employees forwarded these to their company's abuse alias.

Return JSON with exactly these keys:
- classification: "phishing" | "spam" | "benign" | "malware" | "ambiguous"
- action: "safe" | "review" | "escalate" | "takedown"
- confidence: 0-100 integer
- reasoning: one short sentence (max 200 chars)

Classification rules:
- "phishing" — credential harvesting, fake login pages, urgent payment
  requests impersonating a brand, fake invoice/order confirmations
  with bait links, account-suspension scams.
- "malware" — attachments or links plausibly delivering malicious
  payloads (.zip / .iso / .scr / fake invoice .pdf with macros,
  off-brand executable links).
- "spam" — bulk marketing, newsletter unsubscribed-by-employee,
  generic sales prospecting. Annoying but not malicious.
- "benign" — legitimate communication that the forwarder
  misidentified (real password reset they triggered, real receipt,
  real partner email).
- "ambiguous" — insufficient evidence to call. Default to this when
  uncertain. Operators clear ambiguous items faster than they
  recover from a misclassified phish.

Action mapping (advice for the security team):
- "safe" — file it; nothing required.
- "review" — human eyes recommended before responding to forwarder.
- "escalate" — likely active campaign; tell the security team.
- "takedown" — phishing/malware against a target brand we should
  initiate takedown for. Only for clear cases targeting the
  customer's own brand.

Be conservative on "benign" — false-benign is worse than
false-ambiguous. If the customer's brand is the SUBJECT of
impersonation in the forwarded mail, lean toward
phishing+takedown.`;

/**
 * Build the user-message prompt fragment from a message context.
 * Pure function — no I/O. Exposed for unit testing the shape of
 * what gets sent to the model.
 */
export function buildClassifyPrompt(ctx: AbuseClassifyContext): string {
  const lines: string[] = [];
  if (ctx.brand_name) {
    lines.push(`Customer brand: ${ctx.brand_name}${ctx.brand_domain ? ` (${ctx.brand_domain})` : ''}`);
  }
  lines.push(`Forwarded email metadata:`);
  if (ctx.original_from)    lines.push(`From: ${ctx.original_from}`);
  if (ctx.original_subject) lines.push(`Subject: ${ctx.original_subject}`);
  lines.push(`URLs in body: ${ctx.url_count}`);
  lines.push(`Attachments: ${ctx.attachment_count}`);

  // PR-AX — feed the structured IOC signals into the prompt when
  // available. These materially improve the verdict on edge cases
  // (auth-fail + body looks legit = still suspicious; auth-pass +
  // urgent-tone body = often legit transactional mail).
  if (ctx.auth_results) {
    const a = ctx.auth_results;
    const parts: string[] = [];
    if (a.spf)   parts.push(`SPF=${a.spf}`);
    if (a.dkim)  parts.push(`DKIM=${a.dkim}`);
    if (a.dmarc) parts.push(`DMARC=${a.dmarc}`);
    if (parts.length > 0) {
      lines.push(`Email auth: ${parts.join(' / ')}`);
    }
  }
  if (ctx.sender_ip) {
    lines.push(`Sender IP (from Received chain): ${ctx.sender_ip}`);
  }
  if (ctx.url_list && ctx.url_list.length > 0) {
    lines.push('');
    lines.push('URLs (up to first 10):');
    for (const u of ctx.url_list.slice(0, 10)) {
      const domainBit = u.domain ? ` [${u.domain}]` : '';
      const countBit  = u.count > 1 ? ` ×${u.count}` : '';
      lines.push(`  - ${u.url}${domainBit}${countBit}`);
    }
  }
  if (ctx.attachment_list && ctx.attachment_list.length > 0) {
    lines.push('');
    lines.push('Attachments:');
    for (const a of ctx.attachment_list.slice(0, 10)) {
      const mimeBit = a.mime_type ? ` (${a.mime_type})` : '';
      lines.push(`  - ${a.filename}${mimeBit}`);
    }
  }
  if (typeof ctx.correlated_threats_count === 'number' && ctx.correlated_threats_count > 0) {
    lines.push('');
    lines.push(`Platform correlation: ${ctx.correlated_threats_count} of these URLs/domains are already in our threat intelligence. This is a strong signal of an active or recurring campaign.`);
  }

  if (ctx.original_body_snippet) {
    lines.push('');
    lines.push('Body snippet (truncated):');
    lines.push(ctx.original_body_snippet.slice(0, 1500));
  }
  lines.push('');
  lines.push('Return JSON.');
  return lines.join('\n');
}

/**
 * Validate + normalize the raw model output. Any shape error returns
 * null so the caller can leave the row in classification='pending'
 * for a follow-up retry.
 */
export function parseClassifyResult(raw: unknown): ClassifyResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const cls    = obj.classification;
  const action = obj.action;
  const conf   = obj.confidence;
  const reason = obj.reasoning;

  const validCls: AbuseClassification[] = ['phishing', 'spam', 'benign', 'malware', 'ambiguous'];
  const validAct: AbuseAction[]         = ['safe', 'review', 'escalate', 'takedown'];

  if (typeof cls !== 'string' || !validCls.includes(cls as AbuseClassification)) return null;
  if (typeof action !== 'string' || !validAct.includes(action as AbuseAction))    return null;
  if (typeof conf !== 'number' || conf < 0 || conf > 100)                          return null;
  if (typeof reason !== 'string' || reason.length === 0)                           return null;

  return {
    classification: cls    as AbuseClassification,
    action:         action as AbuseAction,
    confidence:     Math.round(conf),
    reasoning:      reason.slice(0, 240).trim(),
  };
}

/**
 * Map a (classification, confidence) pair to a severity label that
 * gets stamped on the row. Threshold table is tuned so that
 * "phishing @ 80%+" pages the security team and "ambiguous @
 * any-conf" never auto-escalates. Pure function — unit-testable.
 */
export function severityFor(
  classification: AbuseClassification,
  confidence:     number,
): AbuseSeverity {
  if (classification === 'malware')  return 'CRITICAL';
  if (classification === 'phishing') return confidence >= 80 ? 'HIGH' : 'MEDIUM';
  if (classification === 'spam')     return 'LOW';
  if (classification === 'benign')   return 'LOW';
  return 'MEDIUM'; // ambiguous
}

/**
 * Call Haiku for one message and return a structured classification.
 * Returns null on transport failure or unparseable output — the
 * caller leaves the row in classification='pending' so the next
 * backfill pass can retry.
 */
export async function classifyAbuseMessageWithAI(
  env: Env,
  ctx: AbuseClassifyContext,
): Promise<ClassifyResult | null> {
  try {
    const { parsed } = await callAnthropicJSON<unknown>(env, {
      agentId: 'abuse_mailbox_classifier',
      runId:   null,
      model:   HOT_PATH_HAIKU,
      system:  SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildClassifyPrompt(ctx) }],
      maxTokens: 256,
    });
    return parseClassifyResult(parsed);
  } catch (err) {
    if (err instanceof AnthropicError) {
      console.error('[abuse_mailbox_classifier] anthropic error:', err.message);
    } else {
      console.error('[abuse_mailbox_classifier] unexpected error:',
        err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseJsonSafe<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

// ─── Backfill ────────────────────────────────────────────────────

export interface ClassifyBackfillResult {
  scanned:    number;
  classified: number;
  failed:     number;
  by_classification: Record<AbuseClassification | 'parse_error', number>;
}

interface MessageRow {
  id:                    string;
  org_id:                number;
  brand_id:              string | null;
  original_from:         string | null;
  original_subject:      string | null;
  original_body_snippet: string | null;
  url_count:             number;
  attachment_count:      number;
  // Wave-3 PR-AD: pulled into the classifier row so the determination
  // email can be sent immediately after the AI verdict lands, without
  // a second SELECT per row.
  forwarded_by_email:    string | null;
  inbound_alias:         string | null;
  determination_sent_at: string | null;
  // PR-AX: IOC signals + correlations + extracted lists for the
  // enriched prompt + the promotion step. All JSON-encoded; parsed
  // inline below before passing to the prompt builder.
  extracted_urls:        string | null;
  attachment_names:      string | null;
  auth_results:          string | null;
  sender_ip:             string | null;
  correlated_threat_ids: string | null;
}

interface BrandRow {
  id:               string;
  name:             string | null;
  canonical_domain: string | null;
}

/**
 * Backfill pass: classify abuse_inbox_messages rows that are still
 * in classification='pending'. Skips already-classified rows so the
 * call is idempotent on retry.
 *
 * - `limit` bounds the batch (default 50, max 200) to keep AI cost
 *   per call predictable. ~$0.001/message via Haiku.
 * - Operator runs repeatedly until `scanned < limit`.
 * - On parse failure, the row stays in 'pending' so the next pass
 *   can retry. We don't burn the row — phishing rows that failed
 *   today might be classifiable tomorrow once the model warms.
 * - Severity is computed in code (severityFor) so it stays
 *   auditable + tunable without re-prompting.
 */
export async function runAbuseClassifierBackfill(
  env:   Env,
  opts?: { limit?: number; offset?: number },
): Promise<ClassifyBackfillResult> {
  const limit  = Math.min(200, opts?.limit  ?? 50);
  const offset = Math.max(0,   opts?.offset ?? 0);

  // PR-AT: skip rate-limited rows. Each row carries forensic evidence
  // of the flood but doesn't pay for Haiku classification or the
  // Resend determination email. Operator can unset abuse_inbox_messages
  // .throttled = 0 to opt-in a specific message back into the pipeline.
  const rows = await env.DB.prepare(`
    SELECT id, org_id, brand_id, original_from, original_subject,
           original_body_snippet, url_count, attachment_count,
           forwarded_by_email, inbound_alias, determination_sent_at,
           extracted_urls, attachment_names, auth_results, sender_ip,
           correlated_threat_ids
    FROM abuse_inbox_messages
    WHERE classification = 'pending'
      AND COALESCE(throttled, 0) = 0
    ORDER BY received_at ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all<MessageRow>();

  // Bulk-load brand metadata for the batch in one query so we can
  // include the customer's brand name in the prompt for every
  // classification.
  const brandIds = Array.from(
    new Set(rows.results.map((r) => r.brand_id).filter((b): b is string => !!b))
  );
  const brandMap = await loadBrandsForClassifier(env.DB, brandIds);

  const result: ClassifyBackfillResult = {
    scanned:    rows.results.length,
    classified: 0,
    failed:     0,
    by_classification: {
      phishing:    0,
      spam:        0,
      benign:      0,
      malware:     0,
      ambiguous:   0,
      parse_error: 0,
    },
  };

  for (const m of rows.results) {
    const brand = m.brand_id ? brandMap.get(m.brand_id) ?? null : null;

    // PR-AX — pull IOC signals + correlations into the prompt for
    // better verdicts on edge cases. All JSON-parse failures degrade
    // silently to null (legacy / partial rows still classify on
    // whatever signals they DO carry).
    const urlList         = parseJsonSafe<Array<{ url: string; domain: string | null; count: number }>>(m.extracted_urls);
    const attachmentList  = parseJsonSafe<Array<{ filename: string; mime_type: string | null }>>(m.attachment_names);
    const authResults     = parseJsonSafe<{ spf: string | null; dkim: string | null; dmarc: string | null }>(m.auth_results);
    const correlatedIds   = parseJsonSafe<string[]>(m.correlated_threat_ids) ?? [];

    const verdict = await classifyAbuseMessageWithAI(env, {
      original_from:         m.original_from,
      original_subject:      m.original_subject,
      original_body_snippet: m.original_body_snippet,
      url_count:             m.url_count,
      attachment_count:      m.attachment_count,
      brand_name:            brand?.name             ?? null,
      brand_domain:          brand?.canonical_domain ?? null,
      url_list:              urlList,
      attachment_list:       attachmentList,
      auth_results:          authResults,
      sender_ip:             m.sender_ip,
      correlated_threats_count: correlatedIds.length,
    });

    if (!verdict) {
      result.failed += 1;
      result.by_classification.parse_error += 1;
      continue;
    }

    result.classified += 1;
    result.by_classification[verdict.classification] += 1;

    const severity = severityFor(verdict.classification, verdict.confidence);
    const aiAssessment =
      `[AI ${verdict.classification} @${verdict.confidence}%] ${verdict.reasoning}`;

    await env.DB.prepare(`
      UPDATE abuse_inbox_messages
      SET classification            = ?,
          classified_by             = 'ai',
          classification_confidence = ?,
          classification_reason     = ?,
          ai_assessment             = ?,
          ai_action                 = ?,
          severity                  = ?,
          updated_at                = datetime('now')
      WHERE id = ?
        AND classification = 'pending'
    `).bind(
      verdict.classification,
      verdict.confidence,
      verdict.reasoning,
      aiAssessment,
      verdict.action,
      severity,
      m.id,
    ).run();

    // ─── Wave-3 PR-AD: 24h determination email ─────────────────
    //
    // Fires immediately after the AI verdict lands. Skips rows that
    // already have determination_sent_at set (defensive — the
    // backfill is idempotent and could be replayed). Suppression for
    // empty/own-domain submitters is handled inside sendDetermination.
    if (!m.determination_sent_at && m.forwarded_by_email) {
      try {
        const { sendDetermination } = await import("./abuse-mailbox-responder");
        const detResult = await sendDetermination(env, m.forwarded_by_email, {
          messageId:       m.id,
          originalSubject: m.original_subject,
          classification:  verdict.classification,
          confidence:      verdict.confidence,
          reasoning:       verdict.reasoning,
          action:          verdict.action,
        });
        if (detResult.ok) {
          await env.DB.prepare(
            `UPDATE abuse_inbox_messages SET determination_sent_at = datetime('now') WHERE id = ?`,
          ).bind(m.id).run();
        }
        // Failures / suppressions logged inside sendDetermination.
      } catch (err) {
        console.warn(`[abuse-mailbox-classifier] determination send threw for ${m.id}:`, err);
      }
    }

    // ─── PR-AX: promote to platform threats ─────────────────────
    //
    // On HIGH/CRITICAL phishing/malware verdicts, push the message's
    // extracted URLs into the `threats` table. Deterministic threat
    // id from threatId(source, type, value) keeps repeated reports
    // idempotent. Stamps the new IDs back to the row so the UI can
    // show "promoted to platform" with deep-links.
    if (
      (verdict.classification === "phishing" || verdict.classification === "malware") &&
      (severity === "HIGH" || severity === "CRITICAL") &&
      urlList && urlList.length > 0
    ) {
      try {
        const { promoteToThreats } = await import("./abuse-mailbox-iocs");
        const promotedIds = await promoteToThreats(env, {
          urls: urlList,
          classification: verdict.classification,
          confidence:     verdict.confidence,
          brandId:        m.brand_id,
          senderIp:       m.sender_ip,
          messageId:      m.id,
        });
        if (promotedIds.length > 0) {
          await env.DB.prepare(
            `UPDATE abuse_inbox_messages SET promoted_threat_ids = ? WHERE id = ?`,
          ).bind(JSON.stringify(promotedIds), m.id).run();
        }
      } catch (err) {
        console.warn(`[abuse-mailbox-classifier] threat promotion failed for ${m.id}:`, err);
      }
    }

    // ─── PR-AW: in-app notification for HIGH/CRITICAL verdicts ─────
    //
    // Fires only for the verdicts that justify operator attention:
    // phishing or malware at HIGH/CRITICAL severity. Benign / spam /
    // ambiguous stay visible in the inbox UI without nagging.
    //
    // Audience routing:
    //   - brand-bound capture → 'tenant' (notification_subscriptions
    //     resolves to the brand's watchers in createNotification)
    //   - unbound capture     → 'super_admin' (covers the Averrow
    //     self-org, and any tenant submission the classifier couldn't
    //     bind to a known brand — both surfaces want admins to know)
    //
    // Dedup: per-message via group_key — each verdict is unique, no
    // time window collapsing needed.
    if (
      (verdict.classification === "phishing" || verdict.classification === "malware") &&
      (severity === "HIGH" || severity === "CRITICAL")
    ) {
      try {
        const { createNotification } = await import("./notifications");
        const audience: "tenant" | "super_admin" = m.brand_id ? "tenant" : "super_admin";
        const link = audience === "super_admin"
          ? `/v2/admin/abuse-mailbox#msg-${m.id}`
          : `/tenant/modules/abuse-mailbox#msg-${m.id}`;
        const subjectPreview = (m.original_subject ?? "(no subject)").slice(0, 80);
        await createNotification(env, {
          type: "abuse_mailbox_verdict",
          severity: severity === "CRITICAL" ? "critical" : "high",
          title: `${verdict.classification === "phishing" ? "Phishing" : "Malware"} confirmed — ${subjectPreview}`,
          message: verdict.reasoning,
          link,
          audience,
          brandId: m.brand_id,
          orgId: String(m.org_id),
          groupKey: `abuse_mailbox_verdict:${m.id}`,
          reasonText: m.brand_id
            ? "A capture targeting one of your monitored brands was classified as a confirmed threat."
            : "A capture sent to your abuse alias was classified as a confirmed threat.",
          recommendedAction: "Open the message in the Abuse Mailbox to review indicators and take action.",
          metadata: {
            message_id: m.id,
            inbound_alias: m.inbound_alias,
            classification: verdict.classification,
            confidence: verdict.confidence,
            ai_action: verdict.action,
          },
        });
      } catch (err) {
        console.warn(`[abuse-mailbox-classifier] verdict notification failed for ${m.id}:`, err);
      }
    }
  }

  return result;
}

async function loadBrandsForClassifier(
  db:       D1Database,
  brandIds: string[],
): Promise<Map<string, BrandRow>> {
  const result = new Map<string, BrandRow>();
  if (brandIds.length === 0) return result;
  const ph = brandIds.map(() => '?').join(',');
  const rows = await db.prepare(`
    SELECT id, name, canonical_domain
    FROM brands
    WHERE id IN (${ph})
  `).bind(...brandIds).all<BrandRow>();
  for (const r of rows.results) result.set(r.id, r);
  return result;
}
