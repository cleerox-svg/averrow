import type { FeedModule, FeedContext, FeedResult } from "./types";
import {
  dedupeBy,
  parseAsnDropJson,
  spamhausCreditLine,
  type AsnDropRecord,
  type SpamhausDropMetadata,
} from "../lib/spamhaus-drop-json";

/**
 * Spamhaus ASN-DROP — Autonomous System Numbers controlled by spammers or
 * cyber criminals, plus hijacked ASNs (feed key `spamhaus_asn_drop`).
 *
 * Reference data, not IOCs: the daily pull upserts `spamhaus_asn_drop`
 * (migration 0327) — one row per ASN, keyed by the platform's only ASN
 * normaliser (`asnKey`, lib/shared-infra-asns.ts → `AS<digits>`), with
 * first_seen / last_seen / removed_at so a delisting is visible rather
 * than a silent DELETE. Like `cf_radar_bots`, it writes no `threats` and
 * always reports itemsNew = 0, so it never wakes Sentinel.
 *
 * Metadata / evidence ONLY: it never gates alert triage, never creates
 * alerts, and does not feed NEXUS confidence. Today's single reader is the
 * staff-only provider detail (`GET /api/providers/:id` → `spamhaus_asn_drop`).
 *
 * Licence: free for any business, with credit to The Spamhaus Project; the
 * list's date and © text are stored on every row (`list_timestamp`,
 * `list_copyright`) per Spamhaus's "the date and © text should remain with
 * the file and data". Spamhaus asks for at most one automated download per
 * hour; the feed_configs interval is 24h.
 *
 * Delisting sweep: rows not refreshed by this pull are stamped
 * `removed_at`, but ONLY when the pull is demonstrably complete (metadata
 * line present, every record parsed and every upsert batch landed).
 * Otherwise the sweep is skipped and the pull carries a warning, so a
 * truncated download can never mass-delist the table.
 */

export const ASN_DROP_URL = "https://www.spamhaus.org/drop/asndrop.json";
const FETCH_TIMEOUT_MS = 30_000;
/** 9 binds per upsert; 50 statements per db.batch (well inside D1 limits). */
const BATCH_SIZE = 50;

/** SQLite `datetime('now')`-shaped UTC stamp, shared by every row of one pull. */
export function sqliteUtcStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * True when the delisting sweep is safe: the list's own metadata says how
 * many records it holds, we parsed all of them, and every upsert batch
 * landed. `parsedCount` is the PRE-dedupe parsed count — metadata.records
 * counts lines, so a list carrying one duplicate ASN would otherwise never
 * look complete and the sweep would be disabled forever.
 */
export function asnDropSweepAllowed(
  parsedCount: number,
  malformed: number,
  metadata: SpamhausDropMetadata | null,
  batchFailures: number,
): boolean {
  if (batchFailures > 0 || malformed > 0) return false;
  if (!metadata || metadata.records === null) return false;
  return parsedCount >= metadata.records;
}

const UPSERT_SQL = `INSERT INTO spamhaus_asn_drop
    (asn, asn_number, as_name, as_domain, country_code, rir,
     first_seen, last_seen, removed_at, list_timestamp, list_copyright)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL, ?8, ?9)
  ON CONFLICT(asn) DO UPDATE SET
    asn_number     = excluded.asn_number,
    as_name        = excluded.as_name,
    as_domain      = excluded.as_domain,
    country_code   = excluded.country_code,
    rir            = excluded.rir,
    last_seen      = excluded.last_seen,
    removed_at     = NULL,
    list_timestamp = excluded.list_timestamp,
    list_copyright = excluded.list_copyright`;

const SWEEP_SQL = `UPDATE spamhaus_asn_drop
     SET removed_at = ?1
   WHERE removed_at IS NULL AND last_seen < ?1`;

export const spamhaus_asn_drop: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const db = ctx.env.DB;

    const res = await fetch(ASN_DROP_URL, {
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`spamhaus_asn_drop: HTTP ${res.status} fetching asndrop.json`);

    const parsed = parseAsnDropJson(await res.text());
    if (parsed.records.length === 0) {
      throw new Error(`spamhaus_asn_drop: asndrop.json parsed 0 records (${parsed.malformed} malformed lines)`);
    }

    const unique: AsnDropRecord[] = dedupeBy(parsed.records, (r) => r.asn);
    const stamp = sqliteUtcStamp(new Date());
    const credit = spamhausCreditLine("ASN-DROP List", parsed.metadata);
    const listTimestamp = parsed.metadata?.timestamp ?? null;

    let stored = 0;
    let batchFailures = 0;
    let firstError: string | null = null;
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const stmts = unique.slice(i, i + BATCH_SIZE).map((r) =>
        db.prepare(UPSERT_SQL).bind(
          r.asn, r.asnNumber, r.asName, r.asDomain, r.countryCode, r.rir,
          stamp, listTimestamp, credit,
        ),
      );
      try {
        await db.batch(stmts);
        stored += stmts.length;
      } catch (e) {
        batchFailures++;
        if (!firstError) firstError = String(e).slice(0, 200);
      }
    }
    if (stored === 0) {
      throw new Error(`spamhaus_asn_drop: every upsert batch failed: ${firstError ?? "unknown error"}`);
    }

    const warnings: string[] = [];
    if (parsed.malformed > 0) warnings.push(`${parsed.malformed} malformed lines skipped`);
    if (batchFailures > 0) warnings.push(`${batchFailures} upsert batch(es) failed: ${firstError}`);
    if (!parsed.metadata) warnings.push("metadata line missing");

    // Completeness = every parsed line (pre-dedupe) vs the list's own count;
    // batchFailures === 0 guarantees every unique ASN was stored.
    if (asnDropSweepAllowed(parsed.records.length, parsed.malformed, parsed.metadata, batchFailures)) {
      await db.prepare(SWEEP_SQL).bind(stamp).run();
    } else {
      warnings.push(`delisting sweep skipped (parsed ${parsed.records.length}, stored ${stored}, list claims ${parsed.metadata?.records ?? "unknown"})`);
    }

    return {
      itemsFetched: unique.length,
      // Context feed: never counts as new threat items (Sentinel stays asleep).
      itemsNew: 0,
      itemsDuplicate: stored,
      itemsError: batchFailures,
      ...(warnings.length > 0 ? { warning: `spamhaus_asn_drop: ${warnings.join("; ")}` } : {}),
    };
  },
};
