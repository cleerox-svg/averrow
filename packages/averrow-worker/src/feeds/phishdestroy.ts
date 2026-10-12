import type { FeedModule, FeedContext, FeedResult } from "./types";
import { calculateConfidence, calculateSeverity, reclassifyThreatType } from "../lib/threatScoring";
import { tagThreat, isIdpFamilyTag } from "../lib/idp-tagging";
import { enqueueAutoCaptures, type AutoCaptureItem } from "../lib/page-capture";
import type { Env } from "../types";

/**
 * PhishDestroy (destroylist): a curated list of phishing and scam domains.
 * Source: https://github.com/phishdestroy/destroylist
 * Format: a JSON array of domain strings (~218K on 2026-10-12, 5.6 MB),
 * sorted ALPHABETICALLY. The list has no timestamps and no newest-first
 * order, so nothing in the payload says which entries are new.
 *
 * Steady-state DIFF ingestion (2026-10-12):
 *
 *   1. Normalise the list and hash each domain to 64 bits.
 *   2. Compare against the previous run's snapshot (a sorted
 *      BigUint64Array of hashes in KV, ~1.75 MB, under KV's 25 MiB
 *      value limit). Only domains NOT in the snapshot are candidates.
 *   3. Drop candidates already in `threats` (any feed) with an
 *      indexed `malicious_domain IN (…)` lookup (idx_threats_domain),
 *      ≤99 binds per statement (D1's 100-bind limit).
 *   4. Insert at most MAX_INSERTS_PER_RUN rows. Candidates not reached
 *      (and rows in a failed insert chunk) are left OUT of the new
 *      snapshot, so the next run's diff picks them up again.
 *   5. Write the snapshot only AFTER the inserts. If that write fails,
 *      the next run re-diffs against the old snapshot and step 3 skips
 *      what was already inserted.
 *
 * First run (no snapshot): record the baseline and insert nothing. The
 * ~218K back-catalog is NOT ingested, because it would add dead
 * domains with first_seen=now, skew the cubes and provider trend
 * counts, and flood the DNS queue. The earlier full-list cursor walk
 * did exactly that and was replaced for that reason.
 *
 * Writes are chunked `db.batch(INSERT OR IGNORE)` (CLAUDE.md §8). Ids
 * come from a 64-bit SHA-256 prefix (`phishdestroyThreatId`), not the
 * 32-bit `threatId` hash. Rows created under the old id scheme are
 * never duplicated, because step 3 matches on the domain, not the id.
 */

const BATCH_CHUNK = 50;
/** Hard cap on new threat rows per run; leftovers carry via the diff. */
export const MAX_INSERTS_PER_RUN = 1_000;
/** D1 allows 100 bound parameters per statement. */
const LOOKUP_CHUNK = 99;
/**
 * Upper bound on candidates examined per run (existence lookups). With
 * the cap above this allows ~51 lookups/run even when most candidates
 * already exist in threats via other feeds.
 */
const MAX_CANDIDATES_EXAMINED = 5_000;

/**
 * Canonical upstream list. Verified 2026-10-12: HTTP 200, a JSON array
 * of ~218K domain strings. Same URL migration 0008 seeds into
 * feed_configs.source_url.
 */
export const PHISHDESTROY_LIST_URL =
  "https://raw.githubusercontent.com/phishdestroy/destroylist/main/list.json";

/** KV key for the previous-run snapshot (sorted 64-bit domain hashes). */
export const PHISHDESTROY_SNAPSHOT_KEY = "feed:phishdestroy:snapshot:v1";

interface FetchedList {
  body: unknown;
  /** Set when the configured source_url 404'd and the canonical URL was used. */
  fallbackNote: string | null;
}

/**
 * Fetches the list. If the operator-edited `feed_configs.source_url`
 * returns 404, falls back to the canonical URL. Every error names the
 * URL or URLs it tried, so `feed_status.last_error` says what to fix.
 */
async function fetchList(configuredUrl: string): Promise<FetchedList> {
  const primary = configuredUrl.trim() || PHISHDESTROY_LIST_URL;
  const urls = primary === PHISHDESTROY_LIST_URL ? [primary] : [primary, PHISHDESTROY_LIST_URL];
  const notFound: string[] = [];
  for (const url of urls) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) {
      notFound.push(url);
      continue;
    }
    if (!res.ok) throw new Error(`PhishDestroy HTTP ${res.status} (${url})`);
    const fallbackNote =
      notFound.length > 0
        ? `WARNING: feed_configs.source_url ${notFound[0]} returned HTTP 404; ` +
          `ingested from canonical ${url}. Update source_url to the canonical URL.`
        : null;
    return { body: await res.json(), fallbackNote };
  }
  throw new Error(
    `PhishDestroy HTTP 404 (${notFound.join(", ")}): list not found. Check ` +
      `https://github.com/phishdestroy/destroylist for a moved/discontinued list; ` +
      `update feed_configs.source_url or disable the feed.`,
  );
}

/**
 * Writes the fallback warning onto this run's in-flight `feed_pull_history`
 * row. feedRunner's success finalize sets status and counts but never
 * touches `error_message`, so the note stays on the pull row. Operators
 * see it in the feed detail pull history (`GET /api/feeds/:name`).
 * `feed_status.last_error` is no use here: the success path clears it.
 * Best-effort.
 */
async function notePullHistory(env: Env, feedName: string, note: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE feed_pull_history SET error_message = ?
        WHERE id = (SELECT id FROM feed_pull_history
                     WHERE feed_name = ? AND completed_at IS NULL
                     ORDER BY started_at DESC LIMIT 1)`,
    ).bind(note.slice(0, 1000), feedName).run();
  } catch {
    // The console line below still records it.
  }
  console.warn(`[phishdestroy] ${note}`);
}

/** Shape filter + normalisation for one payload entry; null = reject. */
export function normalizeDestroylistEntry(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const trimmed = d.trim().toLowerCase();
  // Must contain a dot, no whitespace, no protocol prefix, no leading
  // wildcard. The wildcard filter mirrors the SQL gate in
  // lib/dns-backfill (`malicious_domain NOT LIKE '*%'`).
  if (trimmed.length < 4) return null;
  if (!trimmed.includes(".")) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.startsWith("*")) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return null;
  return trimmed;
}

/**
 * 64-bit snapshot hash: two independently seeded 32-bit lanes
 * (cyrb53-style mixing). Pure JS, so hashing 218K domains every run
 * costs milliseconds. It is used only for snapshot membership. A
 * collision (~n²/2^65, about 1e-9 at 218K) makes one new domain look
 * already seen. Threat ids use SHA-256 instead (see below).
 */
export function domainHash64(s: string): bigint {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (BigInt(h1 >>> 0) << 32n) | BigInt(h2 >>> 0);
}

/**
 * Collision-safe threat id: `thr-phishdestroy-` plus the first 64 bits
 * (16 hex chars) of SHA-256("phishdestroy:domain:<domain>"). Legacy
 * `threatId` ids are base36 of a 31-bit value (at most 6 chars), so the
 * two id spaces can never collide.
 */
export async function phishdestroyThreatId(domain: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`phishdestroy:domain:${domain}`));
  const hex = Array.from(new Uint8Array(digest, 0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `thr-phishdestroy-${hex}`;
}

function hasHash(sorted: BigUint64Array, h: bigint): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === h) return true;
    if (v < h) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

async function loadSnapshot(env: Env): Promise<BigUint64Array | null> {
  const buf = await env.CACHE.get(PHISHDESTROY_SNAPSHOT_KEY, "arrayBuffer");
  if (buf === null || buf.byteLength % 8 !== 0) return null;
  return new BigUint64Array(buf);
}

async function saveSnapshot(env: Env, hashes: BigUint64Array): Promise<void> {
  const sorted = hashes.slice().sort();
  await env.CACHE.put(PHISHDESTROY_SNAPSHOT_KEY, sorted.buffer);
}

/** Of `domains`, returns those already present in threats (any feed). */
async function existingDomains(env: Env, domains: string[]): Promise<Set<string>> {
  const placeholders = domains.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT malicious_domain FROM threats WHERE malicious_domain IN (${placeholders})`,
  ).bind(...domains).all<{ malicious_domain: string }>();
  return new Set((res.results ?? []).map((r) => r.malicious_domain.toLowerCase()));
}

export const phishdestroy: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { body, fallbackNote } = await fetchList(ctx.feedUrl);
    if (!Array.isArray(body)) throw new Error("PhishDestroy: expected JSON array");
    if (fallbackNote) await notePullHistory(ctx.env, ctx.feedName, fallbackNote);
    const empty: FeedResult = { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };

    // Normalise + dedupe the full list in memory, hashing as we go.
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const entry of body as unknown[]) {
      const d = normalizeDestroylistEntry(entry);
      if (d === null || seen.has(d)) continue;
      seen.add(d);
      domains.push(d);
    }
    if (domains.length === 0) return empty;
    const hashes = new BigUint64Array(domains.length);
    for (let i = 0; i < domains.length; i++) hashes[i] = domainHash64(domains[i]!);

    const previous = await loadSnapshot(ctx.env);
    if (previous === null) {
      // Baseline run: remember the current list, ingest nothing.
      await saveSnapshot(ctx.env, hashes);
      return empty;
    }

    // Diff: indices of domains absent from the previous snapshot.
    const candidates: number[] = [];
    for (let i = 0; i < domains.length; i++) {
      if (!hasHash(previous, hashes[i]!)) candidates.push(i);
    }

    // Existence filter + cap. `processed` = candidate settled this run
    // (already in threats, or inserted); everything else carries over.
    const processed = new Set<number>();
    const toInsert: number[] = [];
    let itemsDuplicate = 0;
    const examineLimit = Math.min(candidates.length, MAX_CANDIDATES_EXAMINED);
    for (let i = 0; i < examineLimit && toInsert.length < MAX_INSERTS_PER_RUN; i += LOOKUP_CHUNK) {
      const chunk = candidates.slice(i, Math.min(i + LOOKUP_CHUNK, examineLimit));
      const existing = await existingDomains(ctx.env, chunk.map((k) => domains[k]!));
      for (const k of chunk) {
        if (existing.has(domains[k]!)) {
          processed.add(k);
          itemsDuplicate++;
        } else if (toInsert.length < MAX_INSERTS_PER_RUN) {
          toInsert.push(k);
        }
      }
    }

    // Every row is type='phishing' from the same feed, so the scoring
    // inputs don't vary by domain. Resolve them once.
    const finalType = reclassifyThreatType("phishing", null, null) ?? "phishing";
    const finalConfidence = 80; // pre-#998 default for phishdestroy
    // calculateConfidence has feed-aware overrides; feeding it to severity
    // keeps us aligned with single-row insertThreat() callers.
    const finalSeverity = calculateSeverity(calculateConfidence("phishdestroy", finalType, false));

    // IdP-impersonation tagging (lib/idp-tagging.ts) is domain-only: there
    // is no brand context here, so only strong lures and IdP tenant hosts tag.
    const rows = await Promise.all(
      toInsert.map(async (k) => {
        const domain = domains[k]!;
        const idp = tagThreat({ malicious_domain: domain, malicious_url: `https://${domain}` });
        const id = await phishdestroyThreatId(domain);
        const stmt = ctx.env.DB.prepare(
          `INSERT OR IGNORE INTO threats
             (id, source_feed, threat_type, malicious_url, malicious_domain,
              ioc_value, severity, confidence_score, status, technique, impersonated_idp,
              first_seen, last_seen, created_at)
           VALUES (?, 'phishdestroy', ?, ?, ?, ?, ?, ?, 'active', ?, ?,
                   datetime('now'), datetime('now'), datetime('now'))`,
        ).bind(id, finalType, `https://${domain}`, domain, domain, finalSeverity, finalConfidence,
          idp.technique, idp.impersonated_idp);
        return { k, id, domain, stmt, idpFamily: isIdpFamilyTag(idp) };
      }),
    );

    let itemsNew = 0;
    let itemsError = 0;
    const captureItems: AutoCaptureItem[] = [];
    for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
      const chunk = rows.slice(i, i + BATCH_CHUNK);
      try {
        const results = await ctx.env.DB.batch(chunk.map((r) => r.stmt));
        for (let j = 0; j < chunk.length; j++) {
          const row = chunk[j]!;
          processed.add(row.k);
          // INSERT OR IGNORE: changes=1 → new row, changes=0 → id collision.
          const changed = results[j]?.meta?.changes ?? 0;
          if (changed > 0) {
            itemsNew++;
            if (row.idpFamily) captureItems.push({ threatId: row.id, maliciousDomain: row.domain });
          } else {
            itemsDuplicate++;
          }
        }
      } catch (err) {
        // Not marked processed, so the chunk retries next run via the diff.
        itemsError += chunk.length;
        console.error(`[phishdestroy] batch ${i}-${i + chunk.length} failed:`, err);
      }
    }

    // New IdP-family rows → page-capture queue (lib/page-capture.ts).
    // Best-effort, never throws, never awaits the browser.
    if (captureItems.length > 0) await enqueueAutoCaptures(ctx.env.DB, captureItems);

    // Snapshot AFTER inserts: the current list minus every unsettled candidate.
    const carry = new Set<bigint>();
    for (const k of candidates) if (!processed.has(k)) carry.add(hashes[k]!);
    const next = carry.size === 0 ? hashes : hashes.filter((h) => !carry.has(h));
    try {
      await saveSnapshot(ctx.env, next);
    } catch (err) {
      // The inserts above landed, so don't fail the pull. The next run
      // re-diffs against the old snapshot, and the existence lookup
      // skips this run's rows.
      await notePullHistory(ctx.env, ctx.feedName,
        `WARNING: snapshot write failed (${err instanceof Error ? err.message : String(err)}); next run re-diffs.`);
    }

    return { itemsFetched: itemsNew + itemsDuplicate + itemsError, itemsNew, itemsDuplicate, itemsError };
  },
};
