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
//   runAbuseRulesPass(env, { limit }) — bounded sweep over 'pending' rows,
//     NEWEST first; called by the hourly `17 * * * *` abuse_mailbox_classifier
//     agent (and the admin run-classifier endpoint) so anything the
//     Workflow missed still gets a verdict.
//
// Backlog: a row older than ABUSE_RESPONSE_LOOKBACK (2 days) is still
// classified, but gets no promotion, no notification and no email — the
// verdict UPDATE stamps responder_suppressed_reason='backlog:stale' so no
// responder path can email it later.
//
// Concurrency: the verdict UPDATE is guarded by `classification =
// 'pending'`, and side effects run only when that UPDATE changed the row,
// so the Workflow and the cron sweeper racing on the same message produce
// exactly one verdict and one set of side effects.
//
// D1 cost: ≤ 20 indexed seeks on `idx_threats_domain` per message (one per
// distinct URL host), plus one brand read, one named_threats read and one
// (KV-cached, hourly) brand_safe_domains read per batch. The Sonnet deep
// analyzer is never called for rules verdicts.

import type { Env } from "../types";
import { logger } from "./logger";
import { extractDomain } from "./domain-utils";
import {
  decideAbuseMailboxRulesVerdict, runContentDetectors, normalizeMessageUrls, normHost,
  isSharedHost, isOwnBrandHost, DOMAIN_LEVEL_FEEDS,
  type RulesThreatCandidate, type RulesVerdict,
} from "./abuse-mailbox-rules";
import {
  loadNamedThreatCatalog, recordNamedThreatMatch, type NamedThreatEntry,
} from "./named-threat-matcher";
import { notifyAbuseVerdict, notifyNamedThreatIdentified } from "./abuse-mailbox-notify";
import {
  ABUSE_RESPONSE_LOOKBACK, IS_ATTACHMENT_FORWARD_SQL, parseJsonSafe, type AuthTriple,
} from "./abuse-mailbox-shared";

/** Max distinct URL hosts looked up per message (mirrors correlateUrls). */
const MAX_HOSTS_PER_MESSAGE = 20;
/** Max exact URLs bound per host lookup. */
const MAX_URLS_PER_HOST = 10;
/** KV cache for the brand safe-domain set (slow-changing reference data). */
const SAFE_DOMAINS_CACHE_KEY = "abuse_mailbox.safe_domains";
const SAFE_DOMAINS_TTL_SECONDS = 3600;

/** Fixed operator-facing sentence per rule (never includes message content). */
export const RULES_OPERATOR_NOTE: Record<string, string> = {
  M1: "Links match infrastructure already confirmed malicious in threat intelligence.",
  M2: "Message matches the IOC or regex signature of a named threat in the catalog.",
  M3: "Message contains a high-specificity device-code sign-in lure.",
  M4: "Message carries an executable or disk-image attachment type.",
  H1: "Several independent phishing hallmarks (sender/brand mismatch, lure wording, risky links or attachments, auth failures) — likely phishing, no intel confirmation.",
  review: "No deterministic rule matched; queued for analyst review.",
};

/** responder_suppressed_reason stamped on backlog rows by the verdict UPDATE. */
export const BACKLOG_SUPPRESSED_REASON = "backlog:stale";

interface RulesRow {
  id:                    string;
  org_id:                number;
  brand_id:              string | null;
  inbound_alias:         string | null;
  original_from:         string | null;
  forwarded_by_email:    string | null;
  original_subject:      string | null;
  original_body_snippet: string | null;
  body_text:             string | null;
  extracted_urls:        string | null;
  attachment_names:      string | null;
  auth_results:          string | null;
  sender_ip:             string | null;
  is_attachment_forward: number | null;
  /** 1 when received_at is older than ABUSE_RESPONSE_LOOKBACK. */
  is_stale:              number | null;
}

// The single `?` is ABUSE_RESPONSE_LOOKBACK — bind it first.
const ROW_COLUMNS = `
  id, org_id, brand_id, inbound_alias, original_from, forwarded_by_email, original_subject,
  original_body_snippet, substr(raw_body, 1, 20000) AS body_text, extracted_urls, attachment_names, auth_results, sender_ip,
  ${IS_ATTACHMENT_FORWARD_SQL} AS is_attachment_forward,
  CASE WHEN received_at < datetime('now', ?) THEN 1 ELSE 0 END AS is_stale`;

export type RulesMessageOutcome =
  | { status: "classified"; verdict: RulesVerdict; stale: boolean }
  /** Row no longer pending (already classified, follow-up, throttled, or
   *  another runner won the race). Nothing written. */
  | { status: "not_pending" }
  | { status: "error"; error: string };

export interface RulesPassResult {
  scanned:   number;
  malicious: number;
  review:    number;
  /** Of the classified rows, how many were backlog (no side effects). */
  stale:     number;
  errors:    number;
}

interface BrandInfo { id: string; canonical_domain: string | null }

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

/** brand_safe_domains as a lib/safeDomains.ts lookup set, KV-cached. An
 *  unavailable table degrades to an empty set (the own-brand check still
 *  applies). */
async function loadSafeDomainsSafe(env: Env): Promise<Set<string>> {
  try {
    const { cachedValue } = await import("./cached-value");
    const { loadSafeDomainSet } = await import("./safeDomains");
    const list = await cachedValue<string[]>(env, SAFE_DOMAINS_CACHE_KEY, SAFE_DOMAINS_TTL_SECONDS,
      async () => Array.from(await loadSafeDomainSet(env.DB)));
    return new Set(list);
  } catch (err) {
    logger.warn("abuse_rules_safe_domains_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

/**
 * Look up the threat rows relevant to the M1 rule for a message's URLs
 * (already unwrapped — normalizeMessageUrls). One indexed seek per distinct
 * host. The SQL pre-filters (active, not abuse_mailbox-sourced, exact URL or
 * domain-level-corroborated; exact URL only on shared hosts) and the pure
 * decider re-applies every condition, so the rule stays testable without D1.
 */
export async function loadRulesThreatCandidates(
  env: Env,
  urls: ReadonlyArray<{ url: string; domain: string | null }>,
  brandCanonical: string | null,
): Promise<RulesThreatCandidate[]> {
  const byHost = new Map<string, string[]>();
  for (const u of urls) {
    const host = normHost(u.domain);
    if (!host) continue;
    if (isOwnBrandHost(host, brandCanonical)) continue;
    if (!byHost.has(host) && byHost.size >= MAX_HOSTS_PER_MESSAGE) continue;
    const list = byHost.get(host) ?? [];
    if (list.length < MAX_URLS_PER_HOST) list.push(u.url);
    byHost.set(host, list);
  }

  const feeds = Array.from(DOMAIN_LEVEL_FEEDS);
  const out = new Map<string, RulesThreatCandidate>();
  for (const [host, hostUrls] of byHost) {
    const urlPh = hostUrls.map(() => "?").join(",");
    const shared = isSharedHost(host);
    // Shared hosting: only an exact URL match is evidence. Otherwise exact
    // URL rows sort first so the LIMIT never crowds them out.
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
         ORDER BY (malicious_url IN (${urlPh})) DESC
         LIMIT 5`;
    const binds: unknown[] = shared
      ? [host, ...hostUrls]
      : [host, ...hostUrls, ...feeds, ...hostUrls];
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
  safeDomains: ReadonlySet<string>,
): Promise<RulesMessageOutcome> {
  const urls = normalizeMessageUrls(
    parseJsonSafe<Array<{ url: string; domain: string | null }>>(row.extracted_urls) ?? [],
  );
  const attachments = parseJsonSafe<Array<{ filename: string; mime_type: string | null }>>(row.attachment_names) ?? [];
  const authResults = parseJsonSafe<AuthTriple>(row.auth_results);
  const stale = row.is_stale === 1;

  const threatCandidates = await loadRulesThreatCandidates(env, urls, brand?.canonical_domain ?? null);
  const detectors = runContentDetectors(catalog, {
    subject:  row.original_subject,
    body:     row.original_body_snippet,
    urls,
    senderIp: row.sender_ip,
  });

  // original_from falls back to the REPORTER when intake recovered no
  // forwarded sender (fresh report). The reporter is not the suspect —
  // judging their domain against the brand would invent a mismatch.
  const senderIsReporter = !!row.original_from && !!row.forwarded_by_email &&
    row.original_from.toLowerCase() === row.forwarded_by_email.toLowerCase();

  const verdict = decideAbuseMailboxRulesVerdict({
    brand: brand ? { id: brand.id, canonical_domain: brand.canonical_domain } : null,
    safeDomains,
    originalFrom: senderIsReporter ? null : row.original_from,
    subject: row.original_subject,
    bodyText: row.body_text || row.original_body_snippet,
    urls,
    attachments,
    authResults,
    isAttachmentForward: row.is_attachment_forward === 1,
    threatCandidates,
    namedThreat: detectors.namedThreat,
    strongNamedThreat: detectors.strongNamedThreat,
    strongNamedThreatEntry: detectors.strongNamedThreatEntry,
    deviceCode: detectors.deviceCode,
  });

  const ruleKey = verdict.kind === "malicious" ? verdict.primaryRule : "review";
  const label = verdict.kind === "malicious"
    ? `[Rules ${verdict.firedRules.join("+")} ${verdict.classification}]`
    : "[Rules review]";
  // The match M2 acted on wins the stamp; otherwise the best-evidence one.
  const stampedNamed = (verdict.kind === "malicious" && verdict.firedRules.includes("M2")
    ? detectors.strongNamedThreat
    : null) ?? detectors.namedThreat;
  const technique = detectors.deviceCode.detected
    ? detectors.deviceCode.technique
    : (stampedNamed?.technique ?? null);
  // M1 evidence: the qualifying threats replace the intake correlation (the
  // determination's "matches patterns we're tracking" count reads this).
  // Other verdicts keep the intake value.
  const correlatedJson = verdict.kind === "malicious" && verdict.qualifyingThreatIds.length > 0
    ? JSON.stringify(verdict.qualifyingThreatIds)
    : null;

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
        correlated_threat_ids     = COALESCE(?, correlated_threat_ids),
        responder_suppressed_reason = CASE WHEN ? = 1
          THEN COALESCE(responder_suppressed_reason, ?)
          ELSE responder_suppressed_reason END,
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
    stampedNamed?.id ?? null,
    stampedNamed?.name ?? null,
    correlatedJson,
    stale ? 1 : 0,
    BACKLOG_SUPPRESSED_REASON,
    row.id,
  ).run();
  const changes = typeof upd.meta?.changes === "number" ? upd.meta.changes : 1;
  if (changes === 0) return { status: "not_pending" };

  // Backlog: classify only — no telemetry bumps, alerts, promotion or email.
  if (stale) return { status: "classified", verdict, stale: true };

  // Named-threat telemetry + operator alert, on any catalog match (weak
  // matches included — an operator should still see them on review rows).
  if (stampedNamed) {
    try { await recordNamedThreatMatch(env, stampedNamed.id); } catch { /* telemetry only */ }
    await notifyNamedThreatIdentified(env, {
      messageId: row.id,
      namedThreatId: stampedNamed.id,
      namedThreatName: stampedNamed.name,
      namedThreatSeverity: stampedNamed.severity,
      technique,
      verdictLabel: verdict.kind === "malicious"
        ? `${verdict.classification} (rules ${verdict.firedRules.join("+")})`
        : "needs review (rules)",
      deviceCodeScore: detectors.deviceCode.score,
      deviceCodeSignals: detectors.deviceCode.signals,
    });
  }

  if (verdict.kind === "malicious") {
    // Promote only the EXACT matched URLs (M1 exact-URL / M2 IOC-url). A
    // domain-level match, M3 and M4 never promote. The sender IP is never
    // copied onto promoted threats — it is the relay that delivered the
    // lure, not the infrastructure the URL points at.
    if (verdict.promoteUrls.length > 0) {
      try {
        const { promoteToThreats } = await import("./abuse-mailbox-iocs");
        const promotedIds = await promoteToThreats(env, {
          urls: verdict.promoteUrls.map((u) => ({ url: u, domain: extractDomain(u), count: 1 })),
          classification: verdict.classification,
          confidence: verdict.confidence,
          brandId: row.brand_id,
          senderIp: null,
          messageId: row.id,
          technique,
          namedThreatId: stampedNamed?.id ?? null,
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
      classification: verdict.classification,
      severity: verdict.severity,
      confidence: verdict.confidence,
      action: verdict.action,
      message: RULES_OPERATOR_NOTE[verdict.primaryRule] ?? "",
      classifiedBy: "rules",
      likely: verdict.primaryRule === "H1",
    });
  }

  return { status: "classified", verdict, stale: false };
}

/** Rules verdict for one message (per-message Workflow entry point). */
export async function runAbuseRulesForMessage(env: Env, messageId: string): Promise<RulesMessageOutcome> {
  try {
    const row = await env.DB.prepare(`
      SELECT ${ROW_COLUMNS}
      FROM abuse_inbox_messages
      WHERE id = ? AND classification = 'pending' AND COALESCE(throttled, 0) = 0
    `).bind(ABUSE_RESPONSE_LOOKBACK, messageId).first<RulesRow>();
    if (!row) return { status: "not_pending" };
    const brands = await loadBrands(env, row.brand_id ? [row.brand_id] : []);
    const catalog = await loadCatalogSafe(env);
    const safeDomains = await loadSafeDomainsSafe(env);
    return await applyRulesToRow(env, row, row.brand_id ? brands.get(row.brand_id) ?? null : null, catalog, safeDomains);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn("abuse_rules_message_failed", { message_id: messageId, error });
    return { status: "error", error: error.slice(0, 500) };
  }
}

/** Bounded rules sweep over pending rows, newest first (hourly cron and
 *  admin entry point). */
export async function runAbuseRulesPass(env: Env, opts?: { limit?: number }): Promise<RulesPassResult> {
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));
  // `classification IN (...)` repeats the partial-index predicate of
  // idx_abuse_inbox_triage_queue (migration 0273) so the planner can use it.
  const rows = await env.DB.prepare(`
    SELECT ${ROW_COLUMNS}
    FROM abuse_inbox_messages
    WHERE classification IN ('pending', 'ambiguous')
      AND classification = 'pending'
      AND COALESCE(throttled, 0) = 0
    ORDER BY received_at DESC
    LIMIT ?
  `).bind(ABUSE_RESPONSE_LOOKBACK, limit).all<RulesRow>();
  const list = rows.results ?? [];
  const result: RulesPassResult = { scanned: list.length, malicious: 0, review: 0, stale: 0, errors: 0 };
  if (list.length === 0) return result;

  const brandIds = Array.from(new Set(list.map((r) => r.brand_id).filter((b): b is string => !!b)));
  const brands = await loadBrands(env, brandIds);
  const catalog = await loadCatalogSafe(env);
  const safeDomains = await loadSafeDomainsSafe(env);

  for (const row of list) {
    try {
      const outcome = await applyRulesToRow(env, row, row.brand_id ? brands.get(row.brand_id) ?? null : null, catalog, safeDomains);
      if (outcome.status === "classified") {
        if (outcome.verdict.kind === "malicious") result.malicious += 1;
        else result.review += 1;
        if (outcome.stale) result.stale += 1;
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
