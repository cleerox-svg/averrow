import type { FeedModule, FeedContext, FeedResult } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import { logger } from "../lib/logger";
import { BrandMatcher, buildBrandKeywords, type BrandMatchEntry } from "../lib/nrd-brand-match";
import {
  NRD_ARCHIVE_PREFIX,
  NRD_DOMAINS_PER_STATEMENT,
  NRD_STATEMENTS_PER_BATCH,
  storeNrdReference,
} from "../lib/nrd-store";

// Re-exported: tests and docs refer to these through the feed module.
export {
  NRD_ARCHIVE_PREFIX,
  NRD_DOMAINS_PER_STATEMENT,
  NRD_INSERT_SQL,
  NRD_STATEMENTS_PER_BATCH,
  storeNrdReference,
} from "../lib/nrd-store";
export {
  BrandMatcher,
  GENERIC_KEYWORDS,
  GLUE_WORDS,
  NRD_KEYWORD_DEMOTE_AFTER,
  STRONG_WORDS,
  WEAK_WORDS,
  brandKeywords,
  buildBrandKeywords,
  collectBrandMatchRows,
  isGenericKeyword,
  keywordNeedles,
  registrableLabels,
} from "../lib/nrd-brand-match";
export type { BrandKeywordSpec, BrandMatchEntry } from "../lib/nrd-brand-match";

/**
 * NRD Feed — Newly Registered Domains via Hagezi's NRD 7-day list.
 *
 * Source: https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt
 * (GPL-3.0, data from Stamus Labs, regenerated daily ~06–07 UTC). ~3.1M
 * domains for the trailing 7 days (~443K/day, ~175K/day .com), ~51 MB plain
 * text (~17 MB gzip on the wire). Replaced the WhoisDS free daily ZIP on
 * 2026-10-05: WhoisDS's free tier turned out to be a uniform random 70K
 * sample of each day (prod nrd_domains held exactly 69,999 / 70,000 rows
 * per day), and every one of a 108-domain sample of those rows is present
 * in this list.
 *
 * The list is a ROLLING 7-day window with no per-domain dates, so each run
 * DIFFS today's list against the previous run's snapshot:
 *
 *   1. Conditional GET (`If-None-Match` = the snapshot's stored ETag). 304,
 *      or a `# Version:` header equal to the snapshot's, is a no-op — the
 *      feed is scheduled every 2h but the list changes once a day.
 *   2. Today's body (streamed, never materialised) and the snapshot (R2,
 *      gzip, streamed) are read as two sorted line iterators and
 *      merge-diffed; a domain present today but not in the snapshot is new.
 *      Both lists are in byte (LC_ALL=C) order, which matches JS `<` on
 *      ASCII; an out-of-order line is a format change and throws.
 *   3. New domains are buffered and flushed every NRD_FLUSH_EVERY. Each
 *      flush (a) stores in nrd_domains ONLY the "matchable" ones — see
 *      "What lands in nrd_domains" below, (b) streams ALL of them into the
 *      R2 archive, and (c) brand-matches ALL of them, inserting the matches
 *      via bulkInsertThreats in the same flush — so memory stays bounded
 *      even if a brand keyword floods.
 *   4. Every today-line that is old (in the snapshot) or was actually
 *      flushed is gzip-streamed into the NEW snapshot as it is read. A new
 *      domain beyond the per-run cap (NRD_MAX_NEW_PER_RUN) is left OUT of
 *      the snapshot, so the next run sees it as new again: the cap DEFERS,
 *      never drops, and successive runs converge. A run that deferred
 *      anything stores no etag/version on the snapshot, so the next 2-hourly
 *      run re-diffs instead of short-circuiting on an unchanged list. The
 *      cap bounds brand-matching CPU, filter probes and archive memory per
 *      run.
 *   5. The snapshot is PUT to R2 only after every D1 write succeeded, so a
 *      failed run leaves the old snapshot and the retry re-diffs (INSERT OR
 *      IGNORE + deterministic threatId make that idempotent).
 *
 * Brand matching (lib/nrd-brand-match.ts, redesigned 2026-10-06) looks for
 * COMBOSQUATS only — exact dnstwist typosquats are claimed precisely via
 * nrd_domains + lib/lookalike-nrd-matcher.ts. A brand keyword (display name,
 * hyphenated name, or the canonical domain's registrable label when that is
 * distinctive) counts only as a '-'/'.'-delimited token or concatenated with
 * lure/glue words and digits (`paypal-secure-login`, `coinbasevalidate`,
 * `micros0ft-support`), never embedded in another word. GENERIC keywords (≤4
 * chars, a curated dictionary word, or a lure word: line, att, booking,
 * apple, …) also need a STRONG phishing/parcel word (login, verify, wallet,
 * refund, tracking, …) in their segment or in the nearest non-glue segment
 * (glue such as my/id/pay/prime/www/com is transparent: `att.com-login`,
 * `apple-id-verify`); their digit-swapped variants (`amaz0n`, `app1e`) match
 * as distinctive. Winner: longest needle, then lowest brand id (brands are
 * loaded ORDER BY b.id), so attribution never depends on D1 row order. A
 * brand with NRD_KEYWORD_DEMOTE_AFTER (100) distinctive-path rows in one run
 * has its keywords demoted to the generic rule for the rest of that run
 * (`nrd_hagezi_keywords_demoted` log; opts.keywordDemoteAfter in tests). The
 * old substring match produced 43,010 threats on the first full Hagezi day
 * (51,564 on a 443K-domain sample); the new rules give ~315/day on the same
 * samples. Canonical-domain exclusion, one row per domain and the ThreatRow
 * fields are unchanged.
 *
 * What lands in nrd_domains (D1 write cut, owner decision 2026-10-05): only
 * new domains EQUAL to a `lookalike_domains.domain` or a
 * `phantom_domains.domain`. Those are the only rows either nrd_domains
 * reader can ever return: lib/lookalike-nrd-matcher.ts joins
 * `lookalike_domains l ON l.domain = n.domain` and lib/phantom-matcher.ts
 * joins `nrd_domains t ON t.domain = p.domain`. The filter is IN the insert
 * (NRD_INSERT_SQL): `… SELECT j.value, ? FROM json_each(?) j WHERE EXISTS
 * (… l.domain = j.value) OR EXISTS (… p.domain = j.value)` — the same `=` on
 * the same BINARY-collated TEXT columns as the matchers' joins, evaluated by
 * SQLite, so it is identical to them by construction (no JS-side
 * normalisation to drift). The stored value is the reader-normalised domain
 * (trimmed + lowercased, exactly as before); both lookalike/phantom writers
 * store lowercase ASCII, IDNs as `xn--` punycode, as the Hagezi list does.
 * Storing every NRD (~443K/day) cost ~1.3M row-writes/day plus as many again
 * for the 30-day purge; the filtered set is a handful of rows a day. The
 * full day is in the R2 archive, and brand keyword matches go to `threats`
 * regardless.
 *
 *   * Cost: still 2 binds and ≤1000 domains per statement, 20 statements per
 *     db.batch(). Each new domain costs ~2 index probes (lookalike, then
 *     phantom when the first misses) on idx_lookalike_domain (0282) /
 *     idx_phantom_domain (0258) — both covering index SEARCHes, pinned by
 *     EXPLAIN QUERY PLAN in test/nrd-hagezi-matchable.test.ts — ≈0.9M
 *     row-reads/day at ~443K new domains/day, and row-writes only for the
 *     matches. No in-memory set, no extra load query.
 *   * Writes go through env.DB (the primary), so the EXISTS sees every
 *     lookalike/phantom row committed before the flush.
 *   * Matchability is decided at ingest, so a lookalike permutation or
 *     phantom created AFTER its domain's NRD listing was diffed would miss
 *     its NRD. lib/nrd-archive-backcheck.ts closes that: the seeders hand it
 *     the domains they just inserted, it scans the last NRD_BACKCHECK_DAYS
 *     (8) of archive objects and stores any hit (with the archive's date)
 *     so the matchers pick it up. Older than 8 days → not recovered.
 *
 * Daily archive (tiered retention, owner decision 2026-10-05): nrd_domains
 * keeps only ~30 days hot in D1 (lib/nrd-retention.ts), and the archive is
 * now the ONLY copy of an unmatchable NRD: every NEW domain this run
 * processed (flushed — never a deferred/capped one), stored in D1 or not, is
 * gzip-streamed into an archive object in the NRD_ARCHIVE R2 bucket, at
 * `daily/<registered_date>/<version|unversioned>-<first domain>.txt.gz`
 * (nrdArchiveKey; customMetadata count / stored_in_d1 / version /
 * list_modified / registered_date). It is PUT once every nrd_domains write
 * (storeNrdReference) succeeded — regardless of threat-insert errors — and
 * BEFORE the snapshot put. A failed
 * archive put throws, the snapshot does not advance, and the next run
 * re-diffs, re-inserts (INSERT OR IGNORE) and rewrites the same key; the
 * same happens after a threat-insert error holds the snapshot. The first
 * domain in the key keeps a deferral catch-up run on the same list version
 * from overwriting the previous run's object, while a retry of the same set
 * overwrites itself idempotently. Zero new → no object. Bootstrap
 * archives nothing. NRD_ARCHIVE is REQUIRED: unbound → the run throws
 * before fetching, because the archive is the system of record for NRDs.
 *
 * FeedResult: itemsFetched = list domains read (as before); itemsNew /
 * itemsDuplicate / itemsError = brand-match THREAT rows inserted / already
 * present (or repeated in the list) / failed — not NRD counts. NRD counts
 * (new, stored_in_d1, archived, deferred) are in the `nrd_hagezi_diffed` log.
 *
 * First run (no snapshot): write the snapshot only and insert nothing, so
 * the 3.1M-row window isn't dumped into D1 in one pull; the next daily list
 * then yields just the new day.
 *
 * `registered_date` is a "first listed" approximation — (list
 * `# Last modified` date − 1 day), or UTC yesterday without the header —
 * not a WHOIS creation date. Both nrd_domains readers (lib/phantom-matcher.ts,
 * lib/lookalike-nrd-matcher.ts) cursor on `created_at`; the lookalike
 * matcher reads `registered_date` only to stamp `first_seen` and to apply
 * its 30-day claim window. It is also the archive object's date partition.
 *
 * Snapshot lives in the GEOIP_STAGING R2 bucket under NRD_SNAPSHOT_KEY. The
 * GeoIP workflow only ever deletes its own staging key there, never lists
 * or sweeps the bucket.
 */

export const NRD_HAGEZI_URL = "https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt";

/** R2 key (GEOIP_STAGING bucket) of the previous run's gzip'd domain list. */
export const NRD_SNAPSHOT_KEY = "nrd/hagezi-nrd7.txt.gz";


/** Replace anything outside [A-Za-z0-9._-] so a key part never adds a
 *  path segment or an awkward character to the R2 key. */
function archiveKeyPart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * R2 key (NRD_ARCHIVE bucket) of one run's archived domains:
 * `daily/<registered_date>/<version or "unversioned">-<first domain>.txt.gz`.
 */
export function nrdArchiveKey(registeredDate: string, version: string | null, firstDomain: string): string {
  const v = version ? archiveKeyPart(version) : "unversioned";
  return `${NRD_ARCHIVE_PREFIX}${archiveKeyPart(registeredDate)}/${v}-${archiveKeyPart(firstDomain)}.txt.gz`;
}

/** Max new domains processed (filtered into nrd_domains, archived and
 *  brand-matched) per run (~2.3 days of list growth). Bounds matching CPU
 *  and archive memory. The rest are deferred to the next run (kept out of
 *  the snapshot). */
export const NRD_MAX_NEW_PER_RUN = 1_000_000;

/** Timeout for the response HEADERS. The body has its own idle timeout,
 *  because the body is read across D1 flushes that can take minutes in
 *  total — a whole-request AbortSignal.timeout would abort it mid-diff. */
const FETCH_HEADERS_TIMEOUT_MS = 60_000;

/** Abort the body if no chunk arrives for this long. */
const BODY_IDLE_TIMEOUT_MS = 60_000;

/** Characters buffered before a write into the snapshot CompressionStream. */
const SNAPSHOT_WRITE_CHARS = 64 * 1024;

/** New domains buffered before a flush (filtered storeNrdReference +
 *  archive + brand match): exactly one db.batch() call per flush. */
export const NRD_FLUSH_EVERY = NRD_DOMAINS_PER_STATEMENT * NRD_STATEMENTS_PER_BATCH;

export interface NrdIngestOptions {
  /** Override NRD_MAX_NEW_PER_RUN (tests). */
  maxNewPerRun?: number;
  /** Override NRD_FLUSH_EVERY (tests). */
  flushEvery?: number;
  /** Override NRD_KEYWORD_DEMOTE_AFTER (tests). */
  keywordDemoteAfter?: number;
}

export const nrd_hagezi: FeedModule = {
  ingest: (ctx) => ingestNrdHagezi(ctx),
};

const NOOP: FeedResult = { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };

/** Feed body, with test-tunable limits. */
export async function ingestNrdHagezi(ctx: FeedContext, opts: NrdIngestOptions = {}): Promise<FeedResult> {
  const maxNew = opts.maxNewPerRun ?? NRD_MAX_NEW_PER_RUN;
  const flushEvery = opts.flushEvery ?? NRD_FLUSH_EVERY;
  const bucket = ctx.env.GEOIP_STAGING;
  if (!bucket) {
    throw new Error(
      `NRD Hagezi: GEOIP_STAGING (R2) binding not configured — the diff snapshot is stored at ${NRD_SNAPSHOT_KEY} in that bucket`,
    );
  }

  const archiveBucket = ctx.env.NRD_ARCHIVE;
  if (!archiveBucket) {
    throw new Error(
      `NRD Hagezi: NRD_ARCHIVE (R2) binding not configured — every new domain is archived under ${NRD_ARCHIVE_PREFIX} in that bucket (averrow-nrd-archive); it is the only copy of the NRDs nrd_domains does not store`,
    );
  }

  const prevHead = await bucket.head(NRD_SNAPSHOT_KEY);
  const prevMeta = prevHead?.customMetadata ?? {};

  const res = await fetchList(prevHead ? prevMeta.etag : undefined);
  if (res.status === 304) {
    await cancelBody(res);
    logger.info("nrd_hagezi_not_modified", { etag: prevMeta.etag ?? null, version: prevMeta.version ?? null });
    return { ...NOOP };
  }
  if (!res.ok) {
    await cancelBody(res);
    throw new Error(`NRD Hagezi: list fetch returned HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("NRD Hagezi: list response has no body");
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (/text\/html/i.test(contentType)) {
    await cancelBody(res);
    throw new Error(`NRD Hagezi: expected a plain-text domain list, got content-type "${contentType}"`);
  }

  const today = new SortedDomainReader(lineReader(res.body.pipeThrough(new TextDecoderStream()), BODY_IDLE_TIMEOUT_MS), "list");
  let prev: SortedDomainReader | null = null;
  const snapshot = new SnapshotWriter();
  let archive: SnapshotWriter | null = null;

  try {
    const header = await today.readHeader();
    const etag = res.headers.get("etag");

    if (prevHead && header.version !== null && header.version === (prevMeta.version ?? null)) {
      logger.info("nrd_hagezi_same_version", { version: header.version });
      return { ...NOOP };
    }

    const registeredDate = registeredDateFromHeader(header.lastModified);

    // ── Bootstrap: no snapshot → write it, insert nothing. ──
    if (!prevHead) {
      let lines = 0;
      for (let d = await today.next(); d !== null; d = await today.next()) {
        lines++;
        await snapshot.add(d);
      }
      assertListShape(lines, today.contentLines, header);
      await bucket.put(NRD_SNAPSHOT_KEY, await snapshot.finish(), {
        customMetadata: snapshotMetadata(etag, header, 0),
      });
      logger.info("nrd_hagezi_bootstrap", { lines, version: header.version, snapshotKey: NRD_SNAPSHOT_KEY });
      return { itemsFetched: lines, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    const prevObj = await bucket.get(NRD_SNAPSHOT_KEY);
    if (!prevObj) {
      throw new Error(`NRD Hagezi: snapshot ${NRD_SNAPSHOT_KEY} vanished between head() and get() — retry`);
    }
    prev = new SortedDomainReader(
      lineReader(prevObj.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream()), 0),
      `snapshot ${NRD_SNAPSHOT_KEY} (delete that R2 object to re-bootstrap)`,
      (err) => {
        logger.error("nrd_hagezi_snapshot_unreadable", {
          key: NRD_SNAPSHOT_KEY,
          error: err instanceof Error ? err.message : String(err),
        });
        // Keep the runtime cause (never upstream text) so a transient R2 read
        // drop isn't mistaken for corruption — deleting a good snapshot loses
        // every domain first listed since it was written.
        const cause = err instanceof Error ? err.message : String(err);
        return new Error(
          `NRD Hagezi: snapshot ${NRD_SNAPSHOT_KEY} could not be decompressed/read (${cause.slice(0, 120)}) — usually transient, the next run retries; only if this repeats across runs (corrupt or not gzip), delete that object from the GEOIP_STAGING R2 bucket to re-bootstrap`,
        );
      },
    );

    const archiveWriter = new SnapshotWriter();
    archive = archiveWriter; // aborted in `finally` unless finished
    let archiveFirst: string | null = null;
    let archived = 0;

    const matcher = new BrandMatcher(await loadBrandKeywords(ctx.env.DB), { demoteAfter: opts.keywordDemoteAfter });
    // Carried across flushes so an in-list repeat split over two chunks is
    // still one threat + one in-payload duplicate.
    const matched = new Set<string>();
    const totals = { matches: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    let pending: string[] = [];
    let lines = 0;
    let newTotal = 0;
    let newProcessed = 0;
    let storedInD1 = 0;

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      // Only domains a matcher join can return land in D1 — the filter is
      // in the INSERT itself (NRD_INSERT_SQL, module header).
      storedInD1 += await storeNrdReference(ctx.env.DB, pending, registeredDate);
      // Archive EVERY flushed domain (never a deferred one), stored or not.
      for (const d of pending) await archiveWriter.add(d);
      archiveFirst ??= pending[0]!;
      archived += pending.length;
      if (!matcher.empty) {
        const { rows, inPayloadDuplicates } = matcher.collect(pending, matched);
        // Dedup is the deterministic per-feed threatId PK (INSERT OR IGNORE);
        // bulkInsertThreats bumps brands.threat_count only for rows that
        // landed. No KV dedup keys are read or written by this feed.
        const r = await bulkInsertThreats(ctx.env.DB, rows);
        totals.matches += rows.length;
        totals.itemsNew += r.itemsNew;
        totals.itemsDuplicate += r.itemsDuplicate + inPayloadDuplicates;
        totals.itemsError += r.itemsError;
      }
      pending = [];
    };

    // ── Merge-diff: emit today-lines absent from the snapshot. ──
    let p = await prev.next();
    for (let d = await today.next(); d !== null; d = await today.next()) {
      lines++;
      while (p !== null && p < d) p = await prev.next();
      if (p === d) {
        await snapshot.add(d);
        continue;
      }
      newTotal++;
      // Over the cap: leave it OUT of the new snapshot so the next run sees
      // it as new again (deferred, not dropped).
      if (newProcessed >= maxNew) continue;
      newProcessed++;
      await snapshot.add(d);
      pending.push(d);
      if (pending.length >= flushEvery) await flush();
    }
    await flush();
    assertListShape(lines, today.contentLines, header);
    const { itemsNew, itemsDuplicate, itemsError } = totals;
    const deferred = newTotal - newProcessed;

    if (deferred > 0) {
      logger.warn("nrd_hagezi_deferred", { newTotal, processed: newProcessed, deferred, cap: maxNew });
    }
    const demoted = matcher.demotedKeywords();
    if (demoted.length > 0) {
      // A "distinctive" keyword flooded (≥ NRD_KEYWORD_DEMOTE_AFTER rows this
      // run) and was matched as generic afterwards — a stop-list candidate
      // for GENERIC_KEYWORDS (lib/nrd-brand-match.ts).
      logger.warn("nrd_hagezi_keywords_demoted", { keywords: demoted.slice(0, 50), count: demoted.length });
    }

    // Archive whenever every nrd_domains write landed (we got here, so
    // storeNrdReference never threw) — independent of threat-insert errors:
    // the archive is the only copy of the unstored domains, and a retry
    // rewrites the same key anyway. BEFORE the snapshot: if this put throws,
    // the snapshot stays and the next run re-diffs + rewrites the same
    // archive key.
    if (archived > 0 && archiveFirst !== null) {
      const archiveKey = nrdArchiveKey(registeredDate, header.version, archiveFirst);
      await archiveBucket.put(archiveKey, await archiveWriter.finish(), {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: {
          count: String(archived),
          stored_in_d1: String(storedInD1),
          version: header.version ?? "unversioned",
          list_modified: header.lastModified ?? "",
          registered_date: registeredDate,
        },
      });
      logger.info("nrd_hagezi_archived", { key: archiveKey, count: archived, storedInD1 });
    }

    // Snapshot advances only when every D1 write landed. A failed threat
    // chunk (bulkInsertThreats reports it as itemsError rather than throwing)
    // must keep the old snapshot, or those matches would never be retried.
    if (itemsError > 0) {
      logger.warn("nrd_hagezi_snapshot_held", { reason: "threat_insert_errors", itemsError, version: header.version });
    } else {
      await bucket.put(NRD_SNAPSHOT_KEY, await snapshot.finish(), {
        customMetadata: snapshotMetadata(etag, header, deferred),
      });
    }

    logger.info("nrd_hagezi_diffed", {
      version: header.version,
      registeredDate,
      lines,
      newTotal,
      archived,
      storedInD1,
      deferred,
      matches: totals.matches,
      demotedKeywords: matcher.demotedKeywords(),
      itemsNew,
      itemsDuplicate,
      itemsError,
    });

    return { itemsFetched: lines, itemsNew, itemsDuplicate, itemsError };
  } finally {
    snapshot.abort();
    archive?.abort();
    await today.cancel();
    if (prev) await prev.cancel();
  }
}

async function fetchList(etag: string | undefined): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "Averrow-ThreatIntel/1.0" };
  if (etag) headers["If-None-Match"] = etag;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_HEADERS_TIMEOUT_MS);
  try {
    return await fetch(NRD_HAGEZI_URL, { headers, signal: controller.signal });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `no response within ${FETCH_HEADERS_TIMEOUT_MS / 1000}s`
      : err instanceof Error ? err.message : String(err);
    throw new Error(`NRD Hagezi: list fetch failed — ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelBody(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already closed */ }
}

async function loadBrandKeywords(db: D1Database): Promise<BrandMatchEntry[]> {
  const brands = await db.prepare(
    `SELECT b.id, b.name, b.canonical_domain
     FROM brands b
     INNER JOIN monitored_brands mb ON mb.brand_id = b.id
     WHERE mb.status = 'active'
     ORDER BY b.id`
  ).all<{ id: string; name: string; canonical_domain: string }>();
  // Sorted + deduped by brand id (buildBrandKeywords sorts again, so the
  // lowest-id tie-break never depends on D1 row order); keywords classified
  // generic/distinctive once per run (lib/nrd-brand-match.ts).
  return buildBrandKeywords(brands.results);
}

// ─── List header ─────────────────────────────────────────────────────

export interface NrdListHeader {
  version: string | null;
  /** Raw `# Last modified:` value, e.g. "05 Oct 2026 06:11 UTC". */
  lastModified: string | null;
  /** `# Number of entries:` value. */
  entries: number | null;
}

function parseHeaderLine(line: string, h: NrdListHeader): void {
  const m = /^#\s*([^:]+):\s*(.*)$/.exec(line);
  if (!m) return;
  const key = m[1]!.trim().toLowerCase();
  const value = m[2]!.trim();
  if (key === "version") h.version = value || null;
  else if (key === "last modified") h.lastModified = value || null;
  else if (key === "number of entries") {
    const n = Number(value.replace(/[,_\s]/g, ""));
    h.entries = Number.isFinite(n) ? n : null;
  }
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * registered_date for rows from this list: the list's `Last modified` UTC
 * date minus one day (the list is regenerated each morning from the previous
 * day's registrations), else UTC yesterday. Exported for tests.
 */
export function registeredDateFromHeader(lastModified: string | null, now: Date = new Date()): string {
  const m = lastModified ? /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/.exec(lastModified.trim()) : null;
  const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  const base = m && month !== undefined
    ? new Date(Date.UTC(Number(m[3]), month, Number(m[1])))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  base.setUTCDate(base.getUTCDate() - 1);
  return base.toISOString().slice(0, 10);
}

/**
 * Snapshot customMetadata. When the run deferred domains (per-run cap), the
 * etag/version are deliberately omitted: the snapshot is then NOT a complete
 * image of that list version, so the next run must neither send
 * If-None-Match nor take the same-version shortcut — it re-diffs and picks
 * up the deferred domains.
 */
function snapshotMetadata(etag: string | null, header: NrdListHeader, deferred: number): Record<string, string> {
  const meta: Record<string, string> = {};
  if (deferred === 0) {
    if (etag) meta.etag = etag;
    if (header.version) meta.version = header.version;
  } else {
    meta.deferred = String(deferred);
  }
  if (header.lastModified) meta.list_modified = header.lastModified;
  return meta;
}

/**
 * Integrity checks once the whole list has been read. An empty list never
 * succeeds silently, and a body shorter than its own `Number of entries`
 * header (a truncated download) fails before the snapshot is replaced.
 *
 * Wording is deliberate (and never includes upstream text): none of these match autoPauseFeed's permanent-error
 * taxonomy (lib/feedRunner.ts — 404/410, "upstream archived", "no longer
 * publishes", "Gone", "served no data on N consecutive days"). An empty or
 * short list from a daily-regenerated GitHub file is a bad build, not a dead
 * source, so it stays `auto:consecutive_failures` and the 4h sweep revives it.
 */
function assertListShape(lines: number, contentLines: number, header: NrdListHeader): void {
  if (lines === 0) {
    throw new Error(
      `NRD Hagezi: list contained zero domains (version ${header.version ?? "unknown"}) — refusing to treat an empty list as success`,
    );
  }
  // Compared against RAW non-comment, non-blank lines (not the post-filter
  // domain count), so an entry the domain filter skips can't trip it.
  if (header.entries !== null && header.entries !== contentLines) {
    throw new Error(
      `NRD Hagezi: list body has ${contentLines} entries but its header declares ${header.entries} — truncated or malformed download`,
    );
  }
}

// ─── Streaming line readers ──────────────────────────────────────────

interface LineReader {
  next(): Promise<string | null>;
  cancel(): Promise<void>;
}

/** Split a text stream into lines without buffering it whole. `idleMs` > 0
 *  aborts when no chunk arrives within that window. */
function lineReader(stream: ReadableStream<string>, idleMs: number): LineReader {
  const reader = stream.getReader();
  let buf = "";
  let lines: string[] = [];
  let idx = 0;
  let done = false;

  const read = async (): Promise<ReadableStreamReadResult<string>> => {
    if (idleMs <= 0) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`NRD Hagezi: list body stalled — no data for ${idleMs / 1000}s`)),
        idleMs,
      );
    });
    try {
      return await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async next() {
      for (;;) {
        if (idx < lines.length) return lines[idx++]!;
        if (done) {
          if (buf.length > 0) { const last = buf; buf = ""; return last; }
          return null;
        }
        const { done: d, value } = await read();
        if (d) { done = true; continue; }
        buf += value;
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        lines = parts;
        idx = 0;
      }
    },
    async cancel() {
      try { await reader.cancel(); } catch { /* already closed/errored */ }
    },
  };
}

/**
 * Yields normalised domains (trimmed, lowercased, must contain a '.') in
 * non-decreasing order; skips `#` comment and blank lines. Throws on an
 * out-of-order line — the merge-diff is only correct over sorted input — or
 * on an HTML/markup first line. Equal adjacent lines are allowed (counted as
 * in-payload duplicates downstream).
 */
class SortedDomainReader {
  private last: string | null = null;
  private pendingFirst: string | null = null;
  private seenContent = false;
  /** Raw non-comment, non-blank lines seen (before the '.' filter). */
  contentLines = 0;

  /**
   * `label` must be FIXED text — it goes into thrown messages, which
   * autoPauseFeed pattern-matches; upstream content is only ever logged.
   * `onReadError` maps a stream read failure to a precise error.
   */
  constructor(
    private readonly lines: LineReader,
    private readonly label: string,
    private readonly onReadError?: (err: unknown) => Error,
  ) {}

  private async readLine(): Promise<string | null> {
    if (!this.onReadError) return this.lines.next();
    try {
      return await this.lines.next();
    } catch (err) {
      throw this.onReadError(err);
    }
  }

  /** Consume leading `#` lines; stops at (and buffers) the first other line. */
  async readHeader(): Promise<NrdListHeader> {
    const h: NrdListHeader = { version: null, lastModified: null, entries: null };
    for (let raw = await this.readLine(); raw !== null; raw = await this.readLine()) {
      const line = raw.trim();
      if (line === "") continue;
      if (line.startsWith("#")) { parseHeaderLine(line, h); continue; }
      this.pendingFirst = raw;
      break;
    }
    return h;
  }

  async next(): Promise<string | null> {
    for (;;) {
      let raw: string | null;
      if (this.pendingFirst !== null) { raw = this.pendingFirst; this.pendingFirst = null; }
      else raw = await this.readLine();
      if (raw === null) return null;
      const line = raw.trim().toLowerCase();
      if (line === "" || line.startsWith("#")) continue;
      this.contentLines++;
      if (!this.seenContent) {
        this.seenContent = true;
        if (line.startsWith("<")) {
          logger.error("nrd_hagezi_html_body", { source: this.label, snippet: raw.trim().slice(0, 200) });
          throw new Error(`NRD Hagezi: ${this.label} is HTML/markup, not a domain list`);
        }
      }
      if (!line.includes(".")) continue;
      if (this.last !== null && line < this.last) {
        logger.error("nrd_hagezi_out_of_order", {
          source: this.label,
          line: line.slice(0, 200),
          previous: this.last.slice(0, 200),
          lineIndex: this.contentLines,
        });
        throw new Error(
          `NRD Hagezi: ${this.label} is not sorted — source format changed; the merge-diff requires byte-sorted input`,
        );
      }
      this.last = line;
      return line;
    }
  }

  cancel(): Promise<void> {
    return this.lines.cancel();
  }
}

/**
 * Streams lines into a gzip CompressionStream (used for both the diff
 * snapshot and the daily archive object), draining its readable
 * concurrently (awaiting write() without a reader deadlocks on backpressure)
 * into in-memory chunks; `finish()` returns them as a Blob for the R2 put.
 * Peak is still ~2× the ~17 MB gzip (the Blob copies its parts).
 */
class SnapshotWriter {
  private readonly cs = new CompressionStream("gzip");
  private readonly writer = this.cs.writable.getWriter();
  private readonly encoder = new TextEncoder();
  private readonly chunks: Array<Uint8Array<ArrayBuffer>> = [];
  private readonly drained: Promise<void>;
  private buf = "";
  private finished = false;

  constructor() {
    const reader = this.cs.readable.getReader();
    this.drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // Always a plain ArrayBuffer in practice; the guard satisfies the
        // BlobPart type without copying (SharedArrayBuffer → copy).
        if (value) this.chunks.push(isArrayBufferBacked(value) ? value : new Uint8Array(value));
      }
    })();
    // Abort path rejects `drained`; observe it so it is never unhandled.
    this.drained.catch(() => undefined);
  }

  async add(domain: string): Promise<void> {
    this.buf += domain + "\n";
    if (this.buf.length >= SNAPSHOT_WRITE_CHARS) {
      const out = this.buf;
      this.buf = "";
      await this.writer.write(this.encoder.encode(out));
    }
  }

  async finish(): Promise<Blob> {
    if (this.buf.length > 0) {
      await this.writer.write(this.encoder.encode(this.buf));
      this.buf = "";
    }
    await this.writer.close();
    await this.drained;
    this.finished = true;
    const out = new Blob(this.chunks);
    this.chunks.length = 0;
    return out;
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    this.writer.abort().catch(() => undefined);
  }
}

function isArrayBufferBacked(u: Uint8Array): u is Uint8Array<ArrayBuffer> {
  return u.buffer instanceof ArrayBuffer;
}
