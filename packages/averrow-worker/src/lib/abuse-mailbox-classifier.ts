// Averrow — Abuse Mailbox AI classifier
//
// Per-message Haiku call that classifies forwarded suspicious emails.
// Pairs with the Email Worker in `handlers/abuseMailboxEmail.ts`
// which inserts those rows.
//
// Ordering (2026-10): the deterministic rules pass
// (lib/abuse-mailbox-rules-runner.ts) runs FIRST — per message in the
// AbuseMailboxTriageWorkflow and hourly in the abuse_mailbox_classifier
// agent — and works under AI_MODE=rules_only. This AI pass is the
// optional second opinion. It selects rows that are still 'pending' OR
// that the rules sent to review (classification='ambiguous' AND
// classified_by='rules'). It never touches a rules MALICIOUS verdict and
// never auto-graduates a rules row (a rules review row that exhausts its
// AI retries simply stays a rules review row).
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
import { callAnthropicJSON, AnthropicError, AiDisabledError, isAiRulesOnly } from './anthropic';
import { HOT_PATH_HAIKU } from './ai-models';
import { detectDeviceCodePhishing } from './device-code-detector';
import {
  loadNamedThreatCatalog, matchNamedThreat, recordNamedThreatMatch,
  type NamedThreatEntry,
} from './named-threat-matcher';
import { notifyAbuseVerdict, notifyNamedThreatIdentified } from './abuse-mailbox-notify';
import { ABUSE_RESPONSE_LOOKBACK, parseJsonSafe } from './abuse-mailbox-shared';

/** Fixed operator-facing notification sentence per AI verdict — the AI
 *  counterpart of RULES_OPERATOR_NOTE (abuse-mailbox-rules-runner.ts).
 *  The model's reasoning never goes in a notification: it is shaped by
 *  attacker-controlled message content (prompt-injection) and stays in
 *  classification_reason, visible in the Abuse Mailbox detail view. */
export const AI_OPERATOR_NOTE: Record<"phishing" | "malware", string> = {
  phishing: "Automated triage classified this report as phishing. Open it in the Abuse Mailbox to review the indicators.",
  malware:  "Automated triage classified this report as malware delivery. Open it in the Abuse Mailbox to review the indicators.",
};

// ─── Public types ────────────────────────────────────────────────

export type AbuseClassification =
  | 'phishing'
  | 'spam'
  | 'benign'
  | 'malware'
  | 'ambiguous'
  // PR-BD: submitter replied to one of our determination/ack
  // emails. Set at INSERT time in handlers/abuseMailboxEmail.ts so
  // the row never enters the AI pending queue. Admin reviews these
  // by hand from the UI's "follow_up" filter chip.
  | 'follow_up';

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
  if (classification === 'follow_up') return 'LOW';
  return 'MEDIUM'; // ambiguous
}

/**
 * Call Haiku for one message and return a structured classification or
 * the error reason. NX-poison-pill: callers can now distinguish a real
 * verdict from a transport/parse failure so they can persist the error
 * + bump the retry counter (migration 0196).
 */
export type ClassifyOutcome =
  | { ok: true; verdict: ClassifyResult }
  // `aiDisabled` — AI_MODE=rules_only refused the call before any request
  // left. A deliberate platform skip, not a classification failure: the
  // caller must NOT spend a retry attempt or graduate the row on it.
  | { ok: false; error: string; aiDisabled?: true };

export async function classifyAbuseMessageWithAI(
  env: Env,
  ctx: AbuseClassifyContext,
): Promise<ClassifyOutcome> {
  try {
    const { parsed } = await callAnthropicJSON<unknown>(env, {
      agentId: 'abuse_mailbox_classifier',
      runId:   null,
      model:   HOT_PATH_HAIKU,
      system:  SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildClassifyPrompt(ctx) }],
      maxTokens: 256,
    });
    const verdict = parseClassifyResult(parsed);
    if (!verdict) {
      return { ok: false, error: 'parse_error: model output did not match verdict schema' };
    }
    return { ok: true, verdict };
  } catch (err) {
    if (err instanceof AiDisabledError) {
      return { ok: false, error: err.message.slice(0, 500), aiDisabled: true };
    }
    const message = err instanceof AnthropicError ? err.message
                  : err instanceof Error           ? err.message
                  : String(err);
    if (err instanceof AnthropicError) {
      console.error('[abuse_mailbox_classifier] anthropic error:', message);
    } else {
      console.error('[abuse_mailbox_classifier] unexpected error:', message);
    }
    return { ok: false, error: message.slice(0, 500) };
  }
}

// ─── Backfill ────────────────────────────────────────────────────

export interface ClassifyBackfillResult {
  scanned:    number;
  classified: number;
  failed:     number;
  by_classification: Record<AbuseClassification | 'parse_error', number>;
  /**
   * True when the pass was skipped because AI_MODE=rules_only. Pending
   * rows are left untouched (no attempt bump, no graduation, no
   * determination email) so they classify once AI is re-enabled.
   */
  skipped_rules_only?: boolean;
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
  // NX-poison-pill (migration 0196): retry budget for Haiku-failing rows.
  classification_attempts: number | null;
  // 'rules' when the row is a rules REVIEW verdict awaiting AI; NULL when pending.
  classified_by:         string | null;
  // 1 when received_at is older than ABUSE_RESPONSE_LOOKBACK: classify,
  // but no promotion / deep analysis / notification / email.
  is_stale:              number | null;
}

/**
 * Max retries for a single message before the classifier auto-graduates
 * it to classification='ambiguous' / classified_by='auto_graduated'.
 * Caps the cost of a poison-pill row at 3× the per-message Haiku spend
 * (~$0.003 total) instead of every-orchestrator-tick forever.
 */
const MAX_CLASSIFY_ATTEMPTS = 3;

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
  opts?: {
    limit?: number;
    offset?: number;
    /** Classify exactly this row (per-message Workflow). */
    messageId?: string;
    /** Skip the inline determination send — the caller (the Workflow)
     *  sends it later via deliverAbuseDetermination. */
    deferDetermination?: boolean;
  },
): Promise<ClassifyBackfillResult> {
  const limit  = Math.min(200, opts?.limit  ?? 50);
  const offset = Math.max(0,   opts?.offset ?? 0);

  // AI_MODE=rules_only — skip this AI pass entirely BEFORE touching any
  // row. The deterministic rules pass (lib/abuse-mailbox-rules-runner.ts)
  // runs ahead of this gate in both the per-message Workflow and the
  // hourly agent, so reports still get a verdict + determination email.
  // Bumping classification_attempts here would burn the retry budget on
  // a deliberate skip and graduate rows within three ticks.
  if (isAiRulesOnly(env)) {
    return {
      scanned: 0, classified: 0, failed: 0,
      by_classification: {
        phishing: 0, spam: 0, benign: 0, malware: 0,
        ambiguous: 0, follow_up: 0, parse_error: 0,
      },
      skipped_rules_only: true,
    };
  }

  // PR-AT: skip rate-limited rows. Each row carries forensic evidence
  // of the flood but doesn't pay for Haiku classification or the
  // Resend determination email. Operator can unset abuse_inbox_messages
  // .throttled = 0 to opt-in a specific message back into the pipeline.
  //
  // NX-poison-pill (2026-05-16): skip rows whose classification_attempts
  // are at cap (migration 0196). The graduation UPDATE below catches the
  // 3rd attempt — rows that have already been graduated have
  // classification != 'pending' and don't match this WHERE anyway, so
  // the attempts filter is belt-and-suspenders for any row whose
  // attempts column drifts past cap without a graduation (e.g. concurrent
  // backfill, manual operator UPDATE).
  //
  // Eligible = still 'pending', or a rules REVIEW row. Rules MALICIOUS
  // rows (classified_by='rules', classification phishing/malware) are
  // never selected, so the AI can't overwrite them.
  //
  // `classification IN ('pending','ambiguous')` repeats the partial-index
  // predicate of idx_abuse_inbox_triage_queue (migration 0273).
  const rows = await env.DB.prepare(`
    SELECT id, org_id, brand_id, original_from, original_subject,
           original_body_snippet, url_count, attachment_count,
           forwarded_by_email, inbound_alias, determination_sent_at,
           extracted_urls, attachment_names, auth_results, sender_ip,
           correlated_threat_ids, classification_attempts, classified_by,
           CASE WHEN received_at < datetime('now', ?) THEN 1 ELSE 0 END AS is_stale
    FROM abuse_inbox_messages
    WHERE classification IN ('pending', 'ambiguous')
      AND (classification = 'pending'
           OR (classification = 'ambiguous' AND classified_by = 'rules'))
      AND COALESCE(throttled, 0) = 0
      AND COALESCE(classification_attempts, 0) < ?
      AND (? IS NULL OR id = ?)
    ORDER BY received_at ASC
    LIMIT ? OFFSET ?
  `).bind(
    ABUSE_RESPONSE_LOOKBACK,
    MAX_CLASSIFY_ATTEMPTS,
    opts?.messageId ?? null, opts?.messageId ?? null,
    limit, offset,
  ).all<MessageRow>();

  // Bulk-load brand metadata for the batch in one query so we can
  // include the customer's brand name in the prompt for every
  // classification.
  const brandIds = Array.from(
    new Set(rows.results.map((r) => r.brand_id).filter((b): b is string => !!b))
  );
  const brandMap = await loadBrandsForClassifier(env.DB, brandIds);

  // Load the named-threat catalog ONCE for the batch (small table, one
  // indexed read) so the per-message matcher stays pure + I/O-free.
  // Degrade silently if the table isn't present yet (pre-migration 0204).
  let namedThreatCatalog: NamedThreatEntry[] = [];
  try {
    namedThreatCatalog = await loadNamedThreatCatalog(env);
  } catch (err) {
    console.warn('[abuse-mailbox-classifier] named-threat catalog load failed:', err);
  }

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
      follow_up:   0,  // handler-set classification; backfill never emits this — always 0
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

    // NX-poison-pill: bump the attempt counter BEFORE the AI call so
    // even if Haiku crashes mid-classification, the counter advances
    // and the row gets one fewer retry. Concurrency safe under the
    // existing `WHERE classification = 'pending'` guard — once
    // classification flips, this UPDATE no-ops.
    const attemptN = (m.classification_attempts ?? 0) + 1;
    await env.DB.prepare(`
      UPDATE abuse_inbox_messages
      SET classification_attempts = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND (classification = 'pending'
             OR (classification = 'ambiguous' AND classified_by = 'rules'))
    `).bind(attemptN, m.id).run();

    const outcome = await classifyAbuseMessageWithAI(env, {
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

    if (!outcome.ok && outcome.aiDisabled) {
      // Defensive: AI was switched off mid-pass. Undo this row's attempt
      // bump so the deliberate skip doesn't count against its retry
      // budget, leave it 'pending', and stop — every remaining call in
      // this pass would be refused the same way.
      await env.DB.prepare(`
        UPDATE abuse_inbox_messages
        SET classification_attempts = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND (classification = 'pending'
               OR (classification = 'ambiguous' AND classified_by = 'rules'))
      `).bind(m.classification_attempts ?? 0, m.id).run();
      result.skipped_rules_only = true;
      break;
    }

    if (!outcome.ok) {
      result.failed += 1;
      result.by_classification.parse_error += 1;
      // Persist the error so an operator can see why a row keeps
      // failing without scraping logs. Trimmed to 500 chars in the
      // helper.
      await env.DB.prepare(`
        UPDATE abuse_inbox_messages
        SET last_classify_error = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND (classification = 'pending'
               OR (classification = 'ambiguous' AND classified_by = 'rules'))
      `).bind(outcome.error, m.id).run();

      // Graduate at the retry cap so the orchestrator's next tick
      // doesn't re-pick this row and re-spend Haiku tokens on a
      // message the model can't reliably classify (parse error,
      // truncated JSON, weird body content, etc.). 'ambiguous' is the
      // conservative landing zone — same as Haiku returns when it
      // can't decide on its own — and the operator can re-trigger
      // by setting classification='pending' + classification_attempts=0.
      // The `classification = 'pending'` guard below means a rules
      // review row is never auto-graduated — it stays classified_by=
      // 'rules' (and drops out of the selector at the attempt cap).
      if (attemptN >= MAX_CLASSIFY_ATTEMPTS) {
        await env.DB.prepare(`
          UPDATE abuse_inbox_messages
          SET classification         = 'ambiguous',
              classified_by          = 'auto_graduated',
              classification_reason  = ?,
              severity               = 'MEDIUM',
              updated_at             = datetime('now')
          WHERE id = ? AND classification = 'pending'
        `).bind(
          `Auto-graduated after ${attemptN} failed AI classification attempts. Last error: ${outcome.error.slice(0, 200)}`,
          m.id,
        ).run();
        result.by_classification.ambiguous += 1;
      }
      continue;
    }

    const verdict = outcome.verdict;
    const severity = severityFor(verdict.classification, verdict.confidence);
    const aiAssessment =
      `[AI ${verdict.classification} @${verdict.confidence}%] ${verdict.reasoning}`;

    const verdictUpdate = await env.DB.prepare(`
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
        AND (classification = 'pending'
             OR (classification = 'ambiguous' AND classified_by = 'rules'))
    `).bind(
      verdict.classification,
      verdict.confidence,
      verdict.reasoning,
      aiAssessment,
      verdict.action,
      severity,
      m.id,
    ).run();
    // Lost a race (a concurrent pass or an operator changed the row) —
    // no side effects for a verdict that did not land.
    if (typeof verdictUpdate.meta?.changes === "number" && verdictUpdate.meta.changes === 0) {
      continue;
    }
    // Count only verdicts that actually landed (a lost race is not a
    // classification by this pass).
    result.classified += 1;
    result.by_classification[verdict.classification] += 1;
    // A rules review row already had its detectors stamped, named-threat
    // match recorded and operator notified by the rules pass.
    const fromRulesReview = m.classified_by === "rules";
    // Backlog row (older than the response lookback): verdict + detector
    // stamp only — no alerts, promotion, deep analysis or email.
    const stale = m.is_stale === 1;

    // ─── Kali365 detection: device-code technique + named threat ──
    //
    // Runs on EVERY classified message regardless of the Haiku verdict.
    // Device-code phishing (Kali365 et al.) is engineered to defeat the
    // domain/lookalike detection the rest of the platform relies on —
    // the victim visits the REAL microsoft.com/devicelogin — so the only
    // detectable artifact is the lure CONTENT. Both detectors are pure.
    const deviceCode = detectDeviceCodePhishing({
      subject: m.original_subject,
      body:    m.original_body_snippet,
      urls:    urlList ?? [],
    });
    const namedMatch = matchNamedThreat(namedThreatCatalog, {
      subject:   m.original_subject,
      body:      m.original_body_snippet,
      urls:      urlList ?? [],
      ips:       m.sender_ip ? [m.sender_ip] : [],
      technique: deviceCode.technique,
    });
    const detectedTechnique = deviceCode.detected ? deviceCode.technique : (namedMatch?.technique ?? null);
    const namedThreatId   = namedMatch?.id ?? null;
    const namedThreatName = namedMatch?.name ?? null;

    if (detectedTechnique || namedThreatId) {
      try {
        await env.DB.prepare(
          `UPDATE abuse_inbox_messages
           SET detected_technique = ?, named_threat_id = ?, named_threat_name = ?
           WHERE id = ?`,
        ).bind(detectedTechnique, namedThreatId, namedThreatName, m.id).run();
      } catch (err) {
        // Non-fatal — e.g. migration 0206 not yet applied. Detection
        // shouldn't break the classification loop.
        console.warn(`[abuse-mailbox-classifier] technique stamp failed for ${m.id}:`, err);
      }
    }
    if (namedThreatId && !fromRulesReview && !stale) {
      try { await recordNamedThreatMatch(env, namedThreatId); } catch { /* telemetry only */ }
      // High-signal operator alert: we identified a named threat by name.
      // Deduped per named threat per day so a campaign doesn't flood.
      await notifyNamedThreatIdentified(env, {
        messageId: m.id,
        namedThreatId,
        namedThreatName,
        namedThreatSeverity: namedMatch?.severity ?? null,
        technique: detectedTechnique,
        verdictLabel: `${verdict.classification} @ ${verdict.confidence}%`,
        deviceCodeScore: deviceCode.score,
        deviceCodeSignals: deviceCode.signals,
      });
    }

    // ─── PR-AX: promote to platform threats ─────────────────────
    //
    // Runs BEFORE the determination email so the email's "What we
    // found" block can surface the real count of new indicators we
    // added to threat intelligence on this submission.
    //
    // On HIGH/CRITICAL phishing/malware verdicts, push the message's
    // extracted URLs into the `threats` table. Deterministic threat
    // id from threatId(source, type, value) keeps repeated reports
    // idempotent. Stamps the new IDs back to the row so the UI can
    // show "promoted to platform" with deep-links.
    //
    // Kali365 override: a high-specificity device-code signature
    // (endpoint + code cue, score >= 0.8) lets a phishing/malware verdict
    // promote even when Haiku UNDER-RATED its severity (e.g. landed it at
    // MEDIUM). We deliberately do NOT promote when Haiku said benign/spam
    // — promoting a "phishing" threat while the determination email tells
    // the user "benign" would be a contradiction. For that rarer case the
    // named_threat_identified notification above surfaces it to an
    // operator for human review instead.
    // Legitimate Microsoft endpoints (deviceCode.legitEndpointUrls) are
    // excluded from promotion — we never flag microsoft.com as malicious.
    let promotedIds: string[] = [];
    const verdictIsPhishingOrMalware =
      verdict.classification === "phishing" || verdict.classification === "malware";
    const verdictQualifies =
      verdictIsPhishingOrMalware && (severity === "HIGH" || severity === "CRITICAL");
    const deviceCodeQualifies =
      deviceCode.detected && deviceCode.score >= 0.8 && verdictIsPhishingOrMalware;
    if (!stale && (verdictQualifies || deviceCodeQualifies) && urlList && urlList.length > 0) {
      try {
        const { promoteToThreats } = await import("./abuse-mailbox-iocs");
        const promoteClassification: "phishing" | "malware" =
          verdict.classification === "malware" ? "malware" : "phishing";
        const promoteConfidence = verdictQualifies
          ? verdict.confidence
          : Math.max(verdict.confidence, Math.round(deviceCode.score * 100));
        promotedIds = await promoteToThreats(env, {
          urls: urlList,
          classification: promoteClassification,
          confidence:     promoteConfidence,
          brandId:        m.brand_id,
          senderIp:       m.sender_ip,
          messageId:      m.id,
          technique:      detectedTechnique,
          namedThreatId:  namedThreatId,
          excludeUrls:    deviceCode.legitEndpointUrls,
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

    // ─── PR-BC: deeper AI investigator on confirmed HIGH+ verdicts ──
    //
    // Runs after promotion so the analysis has the real promoted-count
    // context. Sonnet pass produces internal + external narratives plus
    // a specific recommended action. Severity-gated so cost stays
    // bounded (~10 confirmed/day × ~$0.003 = pennies/day).
    if (
      !stale &&
      (verdict.classification === "phishing" || verdict.classification === "malware") &&
      (severity === "HIGH" || severity === "CRITICAL")
    ) {
      try {
        const { runDeepAnalysis } = await import("./abuse-mailbox-deep-analyzer");
        const deep = await runDeepAnalysis(env, {
          message_id:       m.id,
          classification:   verdict.classification,
          confidence:       verdict.confidence,
          brand_name:       brand?.name             ?? null,
          brand_domain:     brand?.canonical_domain ?? null,
          original_from:    m.original_from,
          original_subject: m.original_subject,
          body_snippet:     m.original_body_snippet,
          url_list:         urlList ?? [],
          attachment_list:  attachmentList ?? [],
          auth_results:     authResults,
          sender_ip:        m.sender_ip,
          correlated_threat_ids: correlatedIds,
        });
        if (deep) {
          await env.DB.prepare(
            `UPDATE abuse_inbox_messages SET deep_analysis = ? WHERE id = ?`,
          ).bind(JSON.stringify(deep), m.id).run();
        }
      } catch (err) {
        console.warn(`[abuse-mailbox-classifier] deep analysis failed for ${m.id}:`, err);
      }
    }

    // ─── Determination email ───────────────────────────────────
    //
    // Exactly-once via deliverAbuseDetermination's atomic
    // determination_sent_at claim, so this, the per-message Workflow and
    // the hourly sweeper can never double-send. The per-message Workflow
    // passes deferDetermination and sends after its own short sleep.
    // Rows whose determination already went out (e.g. a rules review
    // email) are skipped by the claim.
    if (!stale && !opts?.deferDetermination && !m.determination_sent_at && m.forwarded_by_email) {
      const { deliverAbuseDetermination } = await import("./abuse-mailbox-determination");
      await deliverAbuseDetermination(env, m.id);
    }

    // ─── PR-AW: in-app notification for HIGH/CRITICAL verdicts ─────
    //
    // Fires only for the verdicts that justify operator attention:
    // phishing or malware at HIGH/CRITICAL severity. Benign / spam /
    // ambiguous stay visible in the inbox UI without nagging. Audience
    // routing + dedup live in notifyAbuseVerdict.
    if (
      !stale &&
      (verdict.classification === "phishing" || verdict.classification === "malware") &&
      (severity === "HIGH" || severity === "CRITICAL")
    ) {
      await notifyAbuseVerdict(env, {
        messageId: m.id,
        orgId: m.org_id,
        brandId: m.brand_id,
        inboundAlias: m.inbound_alias,
        classification: verdict.classification,
        severity,
        confidence: verdict.confidence,
        action: verdict.action,
        // Fixed copy — never verdict.reasoning. Notification text surfaces
        // in push / lock screens / tenant UIs; model reasoning is shaped by
        // attacker-controlled content and stays in classification_reason.
        message: AI_OPERATOR_NOTE[verdict.classification],
        classifiedBy: "ai",
      });
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
