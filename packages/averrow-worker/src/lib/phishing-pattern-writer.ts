// Averrow — AI-phishing phase-1 D1 read/write layer (W1.5).
//
// The glue between the PURE measurement core
// (`phishing-pattern-signals.ts`, W1.4) and D1. Reads a bounded batch of
// `spam_trap_captures` rows (LEFT JOIN threats + hosting_providers for the
// §6.3 infrastructure passthrough columns, + brands for the slotting brand
// name), runs `measureCapture` per row, refines `template_detected` against
// existing campaign peers (§3.6), and upserts one `phishing_pattern_signals`
// row per capture via `INSERT … ON CONFLICT(capture_id) DO UPDATE`.
//
// Boundaries this file honours (spec + CLAUDE.md §8):
//   * READS go through the caller-supplied read replica handle
//     (`getReadSession`); WRITES go through `env.DB` directly.
//   * Prepared statements only — every value is bound, never interpolated.
//   * `ON CONFLICT(capture_id) DO UPDATE` — never SELECT-then-INSERT; the
//     re-run over the same captures is idempotent (byte-identical measured
//     values; only `written`/`updated` classification differs).
//   * `ai_generated_probability` is NEVER written — the column name does not
//     appear in the INSERT column list OR the DO UPDATE SET list, so it stays
//     NULL for every row forever (spec §0.2 rule 1). `assertEvidenceOnly`
//     runs as a belt-and-braces runtime guard on top of the type-level one.
//   * This is the per-capture writer only. The campaign-grain rollup
//     (`campaign_pattern_stats`) + authoritative `template_detected` re-stamp
//     is W1.6 — NOT built here. The writer leaves `campaign_key` /
//     `campaign_key_kind` populated so W1.6 can aggregate.
//
// Not an AgentModule: dispatched from an admin backfill endpoint, so — like
// `runAlertTriageBackfill` — it writes NO `agent_runs` / `agent_events` rows
// (spec §11).

import type { Env } from '../types';
import type { D1Database } from '@cloudflare/workers-types';
import {
  PHISHING_SIGNAL_CALIBRATION,
  assertEvidenceOnly,
  computeTemplateDetected,
  measureCapture,
  deriveCampaignKey,
  type CaptureInput,
  type PerCaptureSignals,
  type CampaignKeyKind,
} from './phishing-pattern-signals';

/** Anything with a `.prepare()` — both `D1Database` and `D1DatabaseSession`
 *  (the read-replica handle from `getReadSession`) satisfy this. */
type Queryable = Pick<D1Database, 'prepare'>;

/** Rows written per D1 `batch()` so a single call stays inside CPU/statement
 *  limits. Bounded backfill, not a hot path. */
const WRITE_CHUNK = 50;

/** Keys for the `by_key_kind` / distribution buckets; the NULL campaign key
 *  is reported under this label. */
const NO_KEY = 'none';

// ─── Joined candidate row (capture + threat/provider/brand passthrough) ──

interface CandidateRow {
  capture_id: number;
  subject: string | null;
  body_preview: string | null;
  raw_headers: string | null;
  urls_found: string | null;
  sending_ip: string | null;
  from_address: string | null;
  from_domain: string | null;
  helo_hostname: string | null;
  x_mailer: string | null;
  trap_address: string | null;
  spoofed_brand_id: string | null;
  spoofed_domain: string | null;
  brand_match_method: string | null;
  threat_id: string | null;
  captured_at: string | null;
  // Joined passthroughs (§6.3) — NULL when threat_id is NULL.
  threat_campaign_id: string | null; // threats.campaign_id (campaign-key rule 1)
  sender_asn: string | null; // threats.asn
  ssl_cert_issuer: string | null; // threats.ssl_cert_issuer
  domain_age_days: number | null; // threats.domain_age_days
  sender_asn_org: string | null; // hosting_providers.name
  brand_name: string | null; // brands.name (slotting)
  existing_signal_id: string | null; // phishing_pattern_signals.id — non-NULL ⇒ already written
}

// The join order matters only for readability; LEFT JOINs keep every capture.
const CANDIDATE_SELECT = `
  SELECT stc.id                 AS capture_id,
         stc.subject            AS subject,
         stc.body_preview       AS body_preview,
         stc.raw_headers        AS raw_headers,
         stc.urls_found         AS urls_found,
         stc.sending_ip         AS sending_ip,
         stc.from_address       AS from_address,
         stc.from_domain        AS from_domain,
         stc.helo_hostname      AS helo_hostname,
         stc.x_mailer           AS x_mailer,
         stc.trap_address       AS trap_address,
         stc.spoofed_brand_id   AS spoofed_brand_id,
         stc.spoofed_domain     AS spoofed_domain,
         stc.brand_match_method AS brand_match_method,
         stc.threat_id          AS threat_id,
         stc.captured_at        AS captured_at,
         t.campaign_id          AS threat_campaign_id,
         t.asn                  AS sender_asn,
         t.ssl_cert_issuer      AS ssl_cert_issuer,
         t.domain_age_days      AS domain_age_days,
         h.name                 AS sender_asn_org,
         b.name                 AS brand_name,
         p.id                   AS existing_signal_id
  FROM spam_trap_captures stc
  LEFT JOIN threats t              ON t.id = stc.threat_id
  LEFT JOIN hosting_providers h    ON h.id = t.hosting_provider_id
  LEFT JOIN brands b               ON b.id = stc.spoofed_brand_id
  LEFT JOIN phishing_pattern_signals p ON p.capture_id = stc.id
  ORDER BY stc.id
  LIMIT ? OFFSET ?
`;

function toCaptureInput(row: CandidateRow): CaptureInput {
  return {
    captureId: row.capture_id,
    subject: row.subject,
    bodyPreview: row.body_preview,
    rawHeaders: row.raw_headers,
    urlsFound: row.urls_found,
    sendingIp: row.sending_ip,
    fromAddress: row.from_address,
    fromDomain: row.from_domain,
    heloHostname: row.helo_hostname,
    xMailer: row.x_mailer,
    trapAddress: row.trap_address,
    spoofedBrandId: row.spoofed_brand_id,
    spoofedDomain: row.spoofed_domain,
    brandMatchMethod: row.brand_match_method,
    brandName: row.brand_name,
    threatId: row.threat_id,
    threatCampaignId: row.threat_campaign_id,
    capturedAt: row.captured_at,
  };
}

// ─── Bounds ──────────────────────────────────────────────────────────────

export const PHISHING_BACKFILL_DEFAULT_LIMIT = 500;
export const PHISHING_BACKFILL_MAX_LIMIT = 1000;

export function clampLimit(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return PHISHING_BACKFILL_DEFAULT_LIMIT;
  return Math.max(1, Math.min(PHISHING_BACKFILL_MAX_LIMIT, Math.floor(raw)));
}

export function clampOffset(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

// ─── Dry-run corpus stats (writes nothing — spec §8 reality-check) ───────

export interface PhishingCorpusStats {
  dry_run: true;
  limit: number;
  offset: number;
  /** Full COUNT(*) over spam_trap_captures — every capture is a candidate. */
  total_candidate_captures: number;
  /** Signals rows already written (drives written/updated expectations). */
  signals_rows_existing: number;
  /** Captures whose threat_id joins a threat with a non-NULL campaign_id
   *  (campaign-key rule 1 availability). */
  captures_with_threat_campaign_id: number;
  preview_length_distribution: {
    null_or_empty: number;
    short_1_99: number;
    medium_100_249: number;
    long_250_499: number;
    truncated_500_plus: number;
  };
  /** Rows actually loaded for the campaign-group analysis below (<= limit). */
  sample_size: number;
  /** campaign_key_kind counts over the loaded sample (incl. `none`). */
  key_kind_distribution: Record<string, number>;
  /** Members-per-candidate-group breakdown over the sample-derived keys. */
  group_size_distribution: {
    groups_total: number;
    singletons: number;
    small_2_4: number;
    at_or_above_min_members: number; // >= MIN_CAMPAIGN_MEMBERS (rollup floor)
    largest_group: number;
    /** The MIN_CAMPAIGN_MEMBERS floor this breakdown is measured against. */
    min_campaign_members: number;
  };
}

export async function computePhishingCorpusStats(
  read: Queryable,
  limit: number,
  offset: number,
): Promise<PhishingCorpusStats> {
  const [totalRow, existingRow, threatCampRow, previewRow, sample] = await Promise.all([
    read.prepare('SELECT COUNT(*) AS n FROM spam_trap_captures').first<{ n: number }>(),
    read.prepare('SELECT COUNT(*) AS n FROM phishing_pattern_signals').first<{ n: number }>(),
    read
      .prepare(`
        SELECT COUNT(*) AS n
        FROM spam_trap_captures stc
        JOIN threats t ON t.id = stc.threat_id
        WHERE stc.threat_id IS NOT NULL AND t.campaign_id IS NOT NULL
      `)
      .first<{ n: number }>(),
    read
      .prepare(`
        SELECT
          SUM(CASE WHEN body_preview IS NULL OR length(body_preview) = 0 THEN 1 ELSE 0 END) AS null_or_empty,
          SUM(CASE WHEN length(body_preview) BETWEEN 1 AND 99 THEN 1 ELSE 0 END)            AS short_1_99,
          SUM(CASE WHEN length(body_preview) BETWEEN 100 AND 249 THEN 1 ELSE 0 END)         AS medium_100_249,
          SUM(CASE WHEN length(body_preview) BETWEEN 250 AND 499 THEN 1 ELSE 0 END)         AS long_250_499,
          SUM(CASE WHEN length(body_preview) >= 500 THEN 1 ELSE 0 END)                      AS truncated_500_plus
        FROM spam_trap_captures
      `)
      .first<{
        null_or_empty: number | null;
        short_1_99: number | null;
        medium_100_249: number | null;
        long_250_499: number | null;
        truncated_500_plus: number | null;
      }>(),
    read.prepare(CANDIDATE_SELECT).bind(limit, offset).all<CandidateRow>(),
  ]);

  // Members-per-candidate-group over the loaded sample. campaign_key is not a
  // stored capture column, so it is derived in TS per row (pure, no I/O).
  const keyKindDistribution: Record<string, number> = {};
  const groupSizes = new Map<string, number>();
  for (const row of sample.results) {
    const { campaign_key, campaign_key_kind } = deriveCampaignKey(toCaptureInput(row));
    const kindLabel = campaign_key_kind ?? NO_KEY;
    keyKindDistribution[kindLabel] = (keyKindDistribution[kindLabel] ?? 0) + 1;
    if (campaign_key != null) {
      groupSizes.set(campaign_key, (groupSizes.get(campaign_key) ?? 0) + 1);
    }
  }

  const minMembers = PHISHING_SIGNAL_CALIBRATION.MIN_CAMPAIGN_MEMBERS;
  let singletons = 0;
  let small = 0;
  let atOrAboveMin = 0;
  let largest = 0;
  for (const size of groupSizes.values()) {
    if (size === 1) singletons++;
    else if (size < minMembers) small++;
    if (size >= minMembers) atOrAboveMin++;
    if (size > largest) largest = size;
  }

  return {
    dry_run: true,
    limit,
    offset,
    total_candidate_captures: totalRow?.n ?? 0,
    signals_rows_existing: existingRow?.n ?? 0,
    captures_with_threat_campaign_id: threatCampRow?.n ?? 0,
    preview_length_distribution: {
      null_or_empty: previewRow?.null_or_empty ?? 0,
      short_1_99: previewRow?.short_1_99 ?? 0,
      medium_100_249: previewRow?.medium_100_249 ?? 0,
      long_250_499: previewRow?.long_250_499 ?? 0,
      truncated_500_plus: previewRow?.truncated_500_plus ?? 0,
    },
    sample_size: sample.results.length,
    key_kind_distribution: keyKindDistribution,
    group_size_distribution: {
      groups_total: groupSizes.size,
      singletons,
      small_2_4: small,
      at_or_above_min_members: atOrAboveMin,
      largest_group: largest,
      min_campaign_members: minMembers,
    },
  };
}

// ─── Real run (measure + upsert) ─────────────────────────────────────────

export interface PhishingBackfillResult {
  dry_run: false;
  limit: number;
  offset: number;
  scanned: number;
  /** New rows inserted (capture had no prior signals row). */
  written: number;
  /** Existing rows re-measured in place via ON CONFLICT DO UPDATE. */
  updated: number;
  /** Rows persisted but below the 12-token shingle floor (template_hash
   *  NULL) — no template signal established. Still written (evidence-only
   *  lane). Subset of scanned, overlaps written+updated. */
  skipped_below_floor: number;
  /** written/updated/skipped_below_floor split by campaign_key_kind
   *  (`none` = NULL campaign key — capture joins no rollup). */
  by_key_kind: Record<
    string,
    { scanned: number; written: number; updated: number; skipped_below_floor: number }
  >;
}

interface MeasuredRow {
  row: CandidateRow;
  signals: PerCaptureSignals;
  existed: boolean;
}

/**
 * §3.6 requirement 2 — refine each capture's insert-time `template_detected`
 * seed against up to MAX_PEER_COMPARISONS existing + in-batch peers sharing
 * its campaign_key. Best-effort: the authoritative re-stamp is the W1.6
 * rollup pass. Self is excluded by capture_id so a re-processed row never
 * matches itself.
 */
async function refineTemplateDetected(read: Queryable, measured: MeasuredRow[]): Promise<void> {
  const max = PHISHING_SIGNAL_CALIBRATION.MAX_PEER_COMPARISONS;

  // In-batch peers per campaign_key: capture_id → template_hash (hashed only).
  const inBatchByKey = new Map<string, Array<{ id: number; hash: string }>>();
  for (const m of measured) {
    const key = m.signals.campaign_key;
    const hash = m.signals.template_hash;
    if (key == null || hash == null) continue;
    const list = inBatchByKey.get(key) ?? [];
    list.push({ id: m.signals.capture_id, hash });
    inBatchByKey.set(key, list);
  }

  // DB peers (top MAX by capture_id) for every campaign_key that has at least
  // one hashed member — keys with no hashed member can never detect anything.
  const dbPeersByKey = new Map<string, Array<{ id: number; hash: string }>>();
  const keysToQuery = [...inBatchByKey.keys()];
  await Promise.all(
    keysToQuery.map(async (key) => {
      const res = await read
        .prepare(`
          SELECT capture_id, template_hash
          FROM phishing_pattern_signals
          WHERE campaign_key = ? AND template_hash IS NOT NULL
          ORDER BY capture_id DESC
          LIMIT ?
        `)
        .bind(key, max)
        .all<{ capture_id: number; template_hash: string }>();
      dbPeersByKey.set(
        key,
        res.results.map((r) => ({ id: r.capture_id, hash: r.template_hash })),
      );
    }),
  );

  for (const m of measured) {
    const key = m.signals.campaign_key;
    const selfHash = m.signals.template_hash;
    if (key == null || selfHash == null) continue; // NULL-hash rows stay 0

    const selfId = m.signals.capture_id;
    const peers: string[] = [];
    for (const p of dbPeersByKey.get(key) ?? []) {
      if (p.id !== selfId) peers.push(p.hash);
      if (peers.length >= max) break;
    }
    if (peers.length < max) {
      for (const p of inBatchByKey.get(key) ?? []) {
        if (p.id === selfId) continue;
        peers.push(p.hash);
        if (peers.length >= max) break;
      }
    }
    m.signals.template_detected = computeTemplateDetected(selfHash, peers);
  }
}

/**
 * The per-capture writer (spec §5 flow, §10 column contract). Reads a bounded
 * batch off the read replica, measures each capture with the pure core,
 * refines `template_detected`, and upserts `phishing_pattern_signals` via
 * `env.DB` (writes never go through a read session).
 *
 * Idempotent: `ON CONFLICT(capture_id) DO UPDATE` re-measures existing rows
 * in place with byte-identical values (classified_at is preserved on update),
 * so a second identical run writes 0 NEW rows and only updates.
 */
export async function runPhishingSignalWriter(
  env: Env,
  read: Queryable,
  limit: number,
  offset: number,
): Promise<PhishingBackfillResult> {
  const candidates = await read.prepare(CANDIDATE_SELECT).bind(limit, offset).all<CandidateRow>();

  const measured: MeasuredRow[] = [];
  for (const row of candidates.results) {
    const signals = await measureCapture(toCaptureInput(row));
    // Belt-and-braces: the type system already forbids a non-null
    // ai_generated_probability; this catches a row assembled from `unknown`.
    assertEvidenceOnly(signals);
    measured.push({ row, signals, existed: row.existing_signal_id != null });
  }

  await refineTemplateDetected(read, measured);

  // Upsert. `ai_generated_probability` appears in NEITHER the column list nor
  // the DO UPDATE SET — it is never written, so it stays NULL forever
  // (spec §0.2 rule 1). `classified_at` is set on INSERT only and preserved on
  // UPDATE, keeping the measured columns byte-identical across re-runs.
  const insertSql = `
    INSERT INTO phishing_pattern_signals (
      capture_id, fluency_score, template_detected, template_hash,
      vocabulary_complexity, sentence_structure_variance, url_obfuscation_type,
      redirect_chain_depth, landing_page_hash, sender_ip, sender_asn,
      sender_asn_org, mail_server_fingerprint, ssl_cert_issuer, domain_age_days,
      brand_targeted, impersonation_technique, visual_similarity_score,
      classification, classified_at, campaign_key, campaign_key_kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    ON CONFLICT(capture_id) DO UPDATE SET
      fluency_score               = excluded.fluency_score,
      template_detected           = excluded.template_detected,
      template_hash               = excluded.template_hash,
      vocabulary_complexity       = excluded.vocabulary_complexity,
      sentence_structure_variance = excluded.sentence_structure_variance,
      url_obfuscation_type        = excluded.url_obfuscation_type,
      redirect_chain_depth        = excluded.redirect_chain_depth,
      landing_page_hash           = excluded.landing_page_hash,
      sender_ip                   = excluded.sender_ip,
      sender_asn                  = excluded.sender_asn,
      sender_asn_org              = excluded.sender_asn_org,
      mail_server_fingerprint     = excluded.mail_server_fingerprint,
      ssl_cert_issuer             = excluded.ssl_cert_issuer,
      domain_age_days             = excluded.domain_age_days,
      brand_targeted              = excluded.brand_targeted,
      impersonation_technique     = excluded.impersonation_technique,
      visual_similarity_score     = excluded.visual_similarity_score,
      classification              = excluded.classification,
      campaign_key                = excluded.campaign_key,
      campaign_key_kind           = excluded.campaign_key_kind
  `;
  const stmt = env.DB.prepare(insertSql);

  const statements = measured.map((m) => {
    const s = m.signals;
    return stmt.bind(
      s.capture_id,
      s.fluency_score,
      s.template_detected,
      s.template_hash,
      s.vocabulary_complexity,
      s.sentence_structure_variance,
      s.url_obfuscation_type,
      s.redirect_chain_depth,
      s.landing_page_hash,
      s.sender_ip,
      m.row.sender_asn, // §6.3 threats.asn passthrough
      m.row.sender_asn_org, // §6.3 hosting_providers.name passthrough
      s.mail_server_fingerprint,
      m.row.ssl_cert_issuer, // §6.3 threats.ssl_cert_issuer passthrough
      m.row.domain_age_days, // §6.3 threats.domain_age_days passthrough
      s.brand_targeted,
      s.impersonation_technique,
      s.visual_similarity_score,
      s.classification,
      s.campaign_key,
      s.campaign_key_kind,
    );
  });

  for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
    await env.DB.batch(statements.slice(i, i + WRITE_CHUNK));
  }

  // Tally. written/updated is decided by whether the capture had a prior
  // signals row (existing_signal_id); skipped_below_floor counts rows with a
  // NULL template_hash (below the 12-token shingle floor) — still persisted.
  const byKeyKind: PhishingBackfillResult['by_key_kind'] = {};
  const track = (
    kind: CampaignKeyKind | null,
    field: 'scanned' | 'written' | 'updated' | 'skipped_below_floor',
  ) => {
    const label = kind ?? NO_KEY;
    if (!byKeyKind[label]) {
      byKeyKind[label] = { scanned: 0, written: 0, updated: 0, skipped_below_floor: 0 };
    }
    byKeyKind[label][field] += 1;
  };

  let written = 0;
  let updated = 0;
  let skippedBelowFloor = 0;
  for (const m of measured) {
    const kind = m.signals.campaign_key_kind;
    track(kind, 'scanned');
    if (m.existed) {
      updated++;
      track(kind, 'updated');
    } else {
      written++;
      track(kind, 'written');
    }
    if (m.signals.template_hash == null) {
      skippedBelowFloor++;
      track(kind, 'skipped_below_floor');
    }
  }

  return {
    dry_run: false,
    limit,
    offset,
    scanned: measured.length,
    written,
    updated,
    skipped_below_floor: skippedBelowFloor,
    by_key_kind: byKeyKind,
  };
}
