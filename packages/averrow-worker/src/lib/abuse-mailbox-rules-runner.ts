// Averrow — Abuse Mailbox rules pass (I/O wrapper)
//
// Loads the evidence the pure `decideAbuseMailboxRulesVerdict`
// (lib/abuse-mailbox-rules.ts) needs, persists the verdict, and runs the
// side effects that follow a MALICIOUS rules verdict (named-threat stamp,
// threat promotion, operator notifications). No AI, ever — this path
// works under AI_MODE=rules_only.
//
// Two entry points:
//   runAbuseRulesForMessage(env, id) — one row; called by the per-message
//     AbuseMailboxTriageWorkflow minutes after receipt.
//   runAbuseRulesPass(env, { limit }) — bounded sweep over 'pending' rows;
//     called by the hourly `17 * * * *` abuse_mailbox_classifier agent so
//     anything the Workflow missed still gets a verdict.
//
// Concurrency: the verdict UPDATE is guarded by `classification =
// 'pending'`, and side effects run only when that UPDATE changed the row,
// so the Workflow and the cron sweeper racing on the same message produce
// exactly one verdict and one set of side effects.
//
// D1 cost: ≤ 20 indexed seeks on `idx_threats_domain` per message (one per
// distinct URL host), plus one brand read and one named_threats read per
// batch. The Sonnet deep analyzer is never called for rules verdicts.

import type { Env } from "../types";
import { logger } from "./logger";
import {
  decideAbuseMailboxRulesVerdict, runContentDetectors, isSharedHost, isOwnBrandHost,
  CORROBORATING_FEEDS, type RulesThreatCandidate, type RulesVerdict,
} from "./abuse-mailbox-rules";
import {
  loadNamedThreatCatalog, recordNamedThreatMatch, type NamedThreatEntry,
} from "./named-threat-matcher";
import { notifyAbuseVerdict, notifyNamedThreatIdentified } from "./abuse-mailbox-notify";

/** Max distinct URL hosts looked up per message (mirrors correlateUrls). */
const MAX_HOSTS_PER_MESSAGE = 20;
/** Max exact URLs bound per host lookup. */
const MAX_URLS_PER_HOST = 10;

/** Fixed operator-facing sentence per rule (never includes message content). */
export const RULES_OPERATOR_NOTE: Record<string, string> = {
  M1: "Links match infrastructure already confirmed malicious in threat intelligence.",
  M2: "Message matches the IOC or regex signature of a named threat in the catalog.",
  M3: "Message contains a high-specificity device-code sign-in lure.",
  M4: "Message carries an executable or disk-image attachment type.",
  review: "No deterministic rule matched; queued for analyst review.",
};

interface RulesRow {
  id:                    string;
  org_id:                number;
  brand_id:              string | null;
  inbound_alias:         string | null;
  original_from:         string | null;
  original_subject:      string | null;
  original_body_snippet: string | null;
  extracted_urls:        string | null;
  attachment_names:      string | null;
  auth_results:          string | null;
  sender_ip:             string | null;
  is_attachment_forward: number | null;
}

// `raw_headers` stores `_forwarded_inner` only when the report was a
// forward-as-attachment (handlers/abuseMailboxEmail.ts). instr() rather
// than json_* because the stored JSON can be truncated (capJson) and
// SQLite's JSON functions throw on malformed input.
const ROW_COLUMNS = `
  id, org_id, brand_id, inbound_alias, original_from, original_subject,
  original_body_snippet, extracted_urls, attachment_names, auth_results, sender_ip,
  CASE WHEN instr(COALESCE(raw_headers, ''), '"_forwarded_inner":') > 0 THEN 1 ELSE 0 END
    AS is_attachment_forward`;

export type RulesMessageOutcome =
  | { status: "classified"; verdict: RulesVerdict }
  /** Row no longer pending (already classified, follow-up, throttled, or
   *  another runner won the race). Nothing written. */
  | { status: "not_pending" }
  | { status: "error"; error: string };

export interface RulesPassResult {
  scanned:   number;
  malicious: number;
  review:    number;
  errors:    number;
}

interface BrandInfo { id: string; canonical_domain: string | null }

function parseJsonSafe<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

async function loadBrands(env: Env, ids: string[]): Promise<Map<string, BrandInfo>> {
  const out = new Map<string, BrandInfo>();
  if (ids.length === 0) return out;
  const ph = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, canonical_domain FROM brands WHERE id IN (${ph})`,
  ).bind(...ids).all<BrandInfo>();
  for (const r of rows.results ?? []) out.set(r.id, r);
  return out;
}

async function loadCatalogSafe(env: Env): Promise<NamedThreatEntry[]> {
  try {
    return await loadNamedThreatCatalog(env);
  } catch (err) {
    logger.warn("abuse_rules_named_threat_catalog_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Look up the threat rows relevant to the M1 rule for a message's URLs.
 * One indexed seek per distinct host. The SQL pre-filters (active, not
 * abuse_mailbox-sourced, exact URL or corroborated) and the pure decider
 * re-applies every condition, so the rule stays testable without D1.
 */
export async function loadRulesThreatCandidates(
  env: Env,
  urls: ReadonlyArray<{ url: string; domain: string | null }>,
  brandCanonical: string | null,
): Promise<RulesThreatCandidate[]> {
  const byHost = new Map<string, string[]>();
  for (const u of urls) {
    const host = u.domain?.trim().toLowerCase() || null;
    if (!host) continue;
    if (isOwnBrandHost(host, brandCanonical)) continue;
    const list = byHost.get(host) ?? [];
    if (list.length < MAX_URLS_PER_HOST) list.push(u.url);
    byHost.set(host, list);
    if (byHost.size >= MAX_HOSTS_PER_MESSAGE) break;
  }

  const feeds = Array.from(CORROBORATING_FEEDS);
  const out = new Map<string, RulesThreatCandidate>();
  for (const [host, hostUrls] of byHost) {
    const urlPh = hostUrls.map(() => "?").join(",");
    const shared = isSharedHost(host);
    // Shared hosting: only an exact URL match is evidence.
    const sql = shared
      ? `SELECT id, malicious_url, malicious_domain, source_feed, status, vt_malicious, gsb_flagged
         FROM threats
         WHERE malicious_domain = ?
           AND status = 'active'
           AND source_feed != 'abuse_mailbox'
           AND malicious_url IN (${urlPh})
         LIMIT 5`
      : `SELECT id, malicious_url, malicious_domain, source_feed, status, vt_malicious, gsb_flagged
         FROM threats
         WHERE malicious_domain = ?
           AND status = 'active'
           AND source_feed != 'abuse_mailbox'
           AND (malicious_url IN (${urlPh})
                OR COALESCE(vt_malicious, 0) > 0
                OR COALESCE(gsb_flagged, 0) = 1
                OR source_feed IN (${feeds.map(() => "?").join(",")}))
         LIMIT 5`;
    const binds: unknown[] = shared ? [host, ...hostUrls] : [host, ...hostUrls, ...feeds];
    const rows = await env.DB.prepare(sql).bind(...binds).all<RulesThreatCandidate>();
    for (const r of rows.results ?? []) out.set(r.id, r);
  }
  return Array.from(out.values());
}

async function applyRulesToRow(
  env: Env,
  row: RulesRow,
  brand: BrandInfo | null,
  catalog: ReadonlyArray<NamedThreatEntry>,
): Promise<RulesMessageOutcome> {
  const urls = parseJsonSafe<Array<{ url: string; domain: string | null }>>(row.extracted_urls) ?? [];
  const attachments = parseJsonSafe<Array<{ filename: string; mime_type: string | null }>>(row.attachment_names) ?? [];
  const authResults = parseJsonSafe<{ spf: string | null; dkim: string | null; dmarc: string | null }>(row.auth_results);

  const threatCandidates = await loadRulesThreatCandidates(env, urls, brand?.canonical_domain ?? null);
  const detectors = runContentDetectors(catalog, {
    subject:  row.original_subject,
    body:     row.original_body_snippet,
    urls,
    senderIp: row.sender_ip,
  });

  const verdict = decideAbuseMailboxRulesVerdict({
    brand: brand ? { id: brand.id, canonical_domain: brand.canonical_domain } : null,
    originalFrom: row.original_from,
    urls,
    attachments,
    authResults,
    isAttachmentForward: row.is_attachment_forward === 1,
    threatCandidates,
    namedThreat: detectors.namedThreat,
    namedThreatEntry: detectors.namedThreatEntry,
    deviceCode: detectors.deviceCode,
  });

  const ruleKey = verdict.kind === "malicious" ? verdict.primaryRule : "review";
  const label = verdict.kind === "malicious"
    ? `[Rules ${verdict.firedRules.join("+")} ${verdict.classification}]`
    : "[Rules review]";
  const technique = detectors.deviceCode.detected
    ? detectors.deviceCode.technique
    : (detectors.namedThreat?.technique ?? null);

  const upd = await env.DB.prepare(`
    UPDATE abuse_inbox_messages
    SET classification            = ?,
        classified_by             = 'rules',
        classification_confidence = ?,
        classification_reason     = ?,
        ai_assessment             = ?,
        ai_action                 = ?,
        severity                  = ?,
        detected_technique        = ?,
        named_threat_id           = ?,
        named_threat_name         = ?,
        updated_at                = datetime('now')
    WHERE id = ? AND classification = 'pending'
  `).bind(
    verdict.classification,
    verdict.confidence,
    verdict.reasonCodes.join(","),
    `${label} ${RULES_OPERATOR_NOTE[ruleKey]}`,
    verdict.action,
    verdict.severity,
    technique,
    detectors.namedThreat?.id ?? null,
    detectors.namedThreat?.name ?? null,
    row.id,
  ).run();
  const changes = typeof upd.meta?.changes === "number" ? upd.meta.changes : 1;
  if (changes === 0) return { status: "not_pending" };

  // Named-threat telemetry + operator alert, on any catalog match (weak
  // matches included — an operator should still see them on review rows).
  if (detectors.namedThreat) {
    try { await recordNamedThreatMatch(env, detectors.namedThreat.id); } catch { /* telemetry only */ }
    await notifyNamedThreatIdentified(env, {
      messageId: row.id,
      namedThreatId: detectors.namedThreat.id,
      namedThreatName: detectors.namedThreat.name,
      namedThreatSeverity: detectors.namedThreat.severity,
      technique,
      verdictLabel: verdict.kind === "malicious"
        ? `${verdict.classification} (rules ${verdict.firedRules.join("+")})`
        : "needs review (rules)",
      deviceCodeScore: detectors.deviceCode.score,
      deviceCodeSignals: detectors.deviceCode.signals,
    });
  }

  if (verdict.kind === "malicious") {
    // Promote only URLs on matched infrastructure (M1–M3; M4 alone never
    // promotes — an attachment says nothing about the links).
    if (verdict.promoteUrls.length > 0) {
      try {
        const { promoteToThreats } = await import("./abuse-mailbox-iocs");
        const promoteSet = new Set(verdict.promoteUrls.map((u) => u.toLowerCase()));
        const promoteList = urls.filter((u) => promoteSet.has(u.url.toLowerCase()));
        const promotedIds = await promoteToThreats(env, {
          urls: promoteList.map((u) => ({ url: u.url, domain: u.domain, count: 1 })),
          classification: verdict.classification,
          confidence: verdict.confidence,
          brandId: row.brand_id,
          senderIp: row.sender_ip,
          messageId: row.id,
          technique,
          namedThreatId: detectors.namedThreat?.id ?? null,
          excludeUrls: detectors.deviceCode.legitEndpointUrls,
        });
        if (promotedIds.length > 0) {
          await env.DB.prepare(
            `UPDATE abuse_inbox_messages SET promoted_threat_ids = ? WHERE id = ?`,
          ).bind(JSON.stringify(promotedIds), row.id).run();
        }
      } catch (err) {
        logger.warn("abuse_rules_promotion_failed", {
          message_id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await notifyAbuseVerdict(env, {
      messageId: row.id,
      orgId: row.org_id,
      brandId: row.brand_id,
      inboundAlias: row.inbound_alias,
      originalSubject: row.original_subject,
      classification: verdict.classification,
      severity: verdict.severity,
      confidence: verdict.confidence,
      action: verdict.action,
      message: RULES_OPERATOR_NOTE[verdict.primaryRule] ?? "",
      classifiedBy: "rules",
    });
  }

  return { status: "classified", verdict };
}

/** Rules verdict for one message (per-message Workflow entry point). */
export async function runAbuseRulesForMessage(env: Env, messageId: string): Promise<RulesMessageOutcome> {
  try {
    const row = await env.DB.prepare(`
      SELECT ${ROW_COLUMNS}
      FROM abuse_inbox_messages
      WHERE id = ? AND classification = 'pending' AND COALESCE(throttled, 0) = 0
    `).bind(messageId).first<RulesRow>();
    if (!row) return { status: "not_pending" };
    const brands = await loadBrands(env, row.brand_id ? [row.brand_id] : []);
    const catalog = await loadCatalogSafe(env);
    return await applyRulesToRow(env, row, row.brand_id ? brands.get(row.brand_id) ?? null : null, catalog);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn("abuse_rules_message_failed", { message_id: messageId, error });
    return { status: "error", error: error.slice(0, 500) };
  }
}

/** Bounded rules sweep over pending rows (hourly cron entry point). */
export async function runAbuseRulesPass(env: Env, opts?: { limit?: number }): Promise<RulesPassResult> {
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));
  const rows = await env.DB.prepare(`
    SELECT ${ROW_COLUMNS}
    FROM abuse_inbox_messages
    WHERE classification = 'pending' AND COALESCE(throttled, 0) = 0
    ORDER BY received_at ASC
    LIMIT ?
  `).bind(limit).all<RulesRow>();
  const list = rows.results ?? [];
  const result: RulesPassResult = { scanned: list.length, malicious: 0, review: 0, errors: 0 };
  if (list.length === 0) return result;

  const brandIds = Array.from(new Set(list.map((r) => r.brand_id).filter((b): b is string => !!b)));
  const brands = await loadBrands(env, brandIds);
  const catalog = await loadCatalogSafe(env);

  for (const row of list) {
    try {
      const outcome = await applyRulesToRow(env, row, row.brand_id ? brands.get(row.brand_id) ?? null : null, catalog);
      if (outcome.status === "classified") {
        if (outcome.verdict.kind === "malicious") result.malicious += 1;
        else result.review += 1;
      }
    } catch (err) {
      result.errors += 1;
      logger.warn("abuse_rules_row_failed", {
        message_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
