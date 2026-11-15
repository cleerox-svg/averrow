import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId64 } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import type { Env } from "../types";

/**
 * CERT Polska Warning List (hole.cert.pl) — dangerous domains, human-curated
 * by CSIRT NASK, aimed at Polish internet users (SMS / marketplace / parcel /
 * bank lures on throwaway domains).
 *
 * Source: https://hole.cert.pl/domains/v2/domains.json (verified 2026-11-15:
 * HTTP 200, ~22 MB, ~124K records, regenerated about every 5 minutes, no
 * auth). Records are `{RegisterPositionId, DomainAddress, InsertDate,
 * DeleteDate}`, sorted by `RegisterPositionId` STRICTLY DESCENDING (newest
 * first). The list is a full 6-month snapshot; `DeleteDate` non-null marks a
 * removed entry. ~300-900 additions/day in Nov 2026.
 *
 * Diff by high-water mark instead of a snapshot: because the file is
 * newest-first with a monotonic id, "what was added since last run" is the
 * prefix of the file above the last id we settled. The module streams the
 * body and stops reading at that id, so a steady-state run reads a few KB
 * of a 22 MB file and never parses the whole snapshot (nrd_hagezi /
 * phishdestroy need a stored snapshot because their lists are unordered and
 * undated; this one does not). The watermark lives in KV
 * (`CERT_POLSKA_WATERMARK_KEY`) as `<id>:<ms of the run that wrote it>`.
 * If the one record at/below the watermark that the stream reads was
 * inserted after that run, the pull warns that an entry landed below the
 * watermark (deeper back-dated inserts are not detectable head-only).
 * Unicode (IDN) names are converted to punycode; failures are counted in
 * the pull warning. An `InsertDate` with no offset is read as UTC.
 *
 *   - First run (no watermark): baseline. Only the last 24h of additions
 *     (by `InsertDate`) are candidates; the 6-month back-catalog is never
 *     ingested (stale domains with first_seen=now would skew cubes and
 *     trends and flood the DNS queue).
 *   - Later runs: every record with id > watermark.
 *   - Inserts go oldest-first, at most `CERT_POLSKA_MAX_INSERTS_PER_RUN`
 *     per run, in chunks; the watermark advances only over a fully settled
 *     prefix (inserted, duplicate, deleted or invalid), so leftovers and a
 *     failed chunk carry to the next run.
 *   - Backlog larger than `CERT_POLSKA_MAX_SCAN_RECORDS` (e.g. after a long
 *     outage): the newest slice is ingested and the gap is skipped, with a
 *     pull warning.
 *   - The top id below the watermark (upstream renumbered): re-baseline the
 *     watermark, ingest nothing, warn.
 *
 * Failure handling: HTTP error, a body that is not a JSON array of objects,
 * a malformed object, a list with no valid record, or an insert failure
 * with nothing settled THROWS, so the pull is recorded `failed` and the
 * breaker sees it (a partial success returns with a warning). A failure never moves the
 * watermark and never marks anything clean or removed.
 *
 * Licence: "may be used by any user for any purpose, including commercial
 * purposes" (cert.pl/en/warning-list, Data usage policy). Attribution is not
 * required; where given it must not imply cooperation or endorsement by
 * NASK-PIB / CERT Polska. See docs/licences/cert_polska.md.
 */

export const CERT_POLSKA_URL = "https://hole.cert.pl/domains/v2/domains.json";
export const CERT_POLSKA_WATERMARK_KEY = "feed:cert_polska:watermark:v1";
/** Hard cap on new threat rows per run; leftovers carry via the watermark. */
export const CERT_POLSKA_MAX_INSERTS_PER_RUN = 500;
/** Records read past the head of the file before giving up on reaching the watermark. */
export const CERT_POLSKA_MAX_SCAN_RECORDS = 5_000;
/** Byte cap on the streamed prefix (5,000 records ≈ 0.75 MB). */
export const CERT_POLSKA_MAX_STREAM_BYTES = 6 * 1024 * 1024;
/** Baseline window: on the first run only additions this recent are ingested. */
export const CERT_POLSKA_BASELINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const INSERT_CHUNK = 50;
const FETCH_TIMEOUT_MS = 45_000;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface CertPolskaRecord {
  id: number;
  domain: string;
  insertMs: number;
  deleted: boolean;
}

/** Shape-check one JSON object; null = malformed. */
export function parseCertPolskaRecord(obj: unknown): CertPolskaRecord | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const r = obj as Record<string, unknown>;
  const id = r.RegisterPositionId;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof r.DomainAddress !== "string") return null;
  const insertMs = typeof r.InsertDate === "string" ? parseUtcDate(r.InsertDate) : NaN;
  if (!Number.isFinite(insertMs)) return null;
  const del = r.DeleteDate;
  if (del !== null && del !== undefined && typeof del !== "string") return null;
  return { id, domain: r.DomainAddress.trim().toLowerCase(), insertMs, deleted: typeof del === "string" && del !== "" };
}

/**
 * Parse an ISO-8601 timestamp; one without a zone designator is read as UTC
 * (`Date.parse` would read a date-time with no offset as LOCAL time).
 */
export function parseUtcDate(s: string): number {
  const t = s.trim();
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(t);
  const isDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t);
  return Date.parse(isDateTime && !hasZone ? `${t.replace(" ", "T")}Z` : t);
}

const NON_ASCII_RE = /[^\x00-\x7f]/;

/** True for a listed name with non-ASCII (Unicode / IDN) characters. */
export function isUnicodeDomain(d: string): boolean {
  return NON_ASCII_RE.test(d);
}

/**
 * Domain filter for a listed entry; null = not ingestible. Unicode (IDN)
 * names are converted to their punycode A-label form via the WHATWG URL
 * parser (`bücher.pl` → `xn--bcher-kva.pl`).
 */
export function normalizeCertPolskaDomain(d: string): string | null {
  let domain = d.replace(/\.$/, "");
  if (isUnicodeDomain(domain)) {
    // Letters/marks/digits, '-' and '.' only, so the URL parser can't read
    // a different host out of a name carrying '/', '@', ':' etc.
    if (!/^[\p{L}\p{M}\p{N}.-]+$/u.test(domain)) return null;
    try {
      domain = new URL(`http://${domain}/`).hostname;
    } catch {
      return null;
    }
  }
  if (domain.length < 4 || domain.length > 253) return null;
  return DOMAIN_RE.test(domain) ? domain : null;
}

/**
 * Incremental scanner for a top-level JSON array of objects. Feed it text
 * chunks; it returns each complete top-level object, parsed. Throws on
 * anything that is not `[ {…}, {…}, … ]`. Only brace depth and string state
 * are tracked, so nested arrays/objects inside an element are fine.
 */
export class JsonArrayObjectScanner {
  private buf = "";
  private started = false;
  private ended = false;
  private depth = 0;
  private inStr = false;
  private esc = false;
  private objStart = -1;

  get isEnded(): boolean {
    return this.ended;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  push(text: string): unknown[] {
    const out: unknown[] = [];
    if (this.ended) return out;
    const base = this.buf.length;
    this.buf += text;
    for (let i = base; i < this.buf.length; i++) {
      const c = this.buf[i]!;
      if (!this.started) {
        if (c === "[") this.started = true;
        else if (!/\s|﻿/.test(c)) throw new Error("cert_polska: body is not a JSON array");
        continue;
      }
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === "\\") this.esc = true;
        else if (c === "\"") this.inStr = false;
        continue;
      }
      if (this.depth === 0) {
        if (c === "{") {
          this.objStart = i;
          this.depth = 1;
        } else if (c === "]") {
          this.ended = true;
          this.buf = "";
          return out;
        } else if (c !== "," && !/\s/.test(c)) {
          throw new Error("cert_polska: array element is not an object");
        }
        continue;
      }
      if (c === "\"") this.inStr = true;
      else if (c === "{") this.depth++;
      else if (c === "}") {
        this.depth--;
        if (this.depth === 0) {
          const raw = this.buf.slice(this.objStart, i + 1);
          try {
            out.push(JSON.parse(raw));
          } catch {
            throw new Error("cert_polska: malformed JSON object");
          }
          this.objStart = -1;
        }
      }
    }
    // Keep only the unfinished object (if any) so the buffer stays small.
    if (this.depth > 0 && this.objStart >= 0) {
      this.buf = this.buf.slice(this.objStart);
      this.objStart = 0;
    } else {
      this.buf = "";
    }
    return out;
  }
}

export type ScanStop = "watermark" | "window" | "scan_cap" | "eof";

export interface CertPolskaScan {
  /** Id of the first valid record (the newest), or null if none. */
  topId: number | null;
  /** Records newer than the stop point, in file order (newest first). */
  collected: CertPolskaRecord[];
  /** The first record at or below the watermark (where the scan stopped), if any. */
  stopRecord: CertPolskaRecord | null;
  invalid: number;
  stop: ScanStop;
}

/**
 * Stream the list head until the watermark (or, with no watermark, the
 * baseline window) is reached. Cancels the body as soon as it stops.
 */
export async function scanCertPolska(
  body: ReadableStream<Uint8Array>,
  watermark: number | null,
  nowMs: number,
): Promise<CertPolskaScan> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const scanner = new JsonArrayObjectScanner();
  const windowStart = nowMs - CERT_POLSKA_BASELINE_WINDOW_MS;
  const collected: CertPolskaRecord[] = [];
  let topId: number | null = null;
  let stopRecord: CertPolskaRecord | null = null;
  let invalid = 0;
  let bytes = 0;
  let stop: ScanStop | null = null;
  try {
    outer: for (;;) {
      const { done, value } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (!done) bytes += value.byteLength;
      for (const obj of scanner.push(text)) {
        const rec = parseCertPolskaRecord(obj);
        if (!rec) {
          invalid++;
          continue;
        }
        if (topId === null) topId = rec.id;
        if (watermark !== null && rec.id <= watermark) { stop = "watermark"; stopRecord = rec; break outer; }
        if (watermark === null && rec.insertMs < windowStart) { stop = "window"; break outer; }
        collected.push(rec);
        if (collected.length >= CERT_POLSKA_MAX_SCAN_RECORDS) { stop = "scan_cap"; break outer; }
      }
      if (scanner.isEnded || done) {
        if (!scanner.hasStarted) throw new Error("cert_polska: empty body");
        if (!scanner.isEnded) throw new Error("cert_polska: truncated JSON array");
        stop = "eof";
        break;
      }
      if (bytes > CERT_POLSKA_MAX_STREAM_BYTES) { stop = "scan_cap"; break; }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { topId, collected, stopRecord, invalid, stop: stop ?? "eof" };
}

export interface CertPolskaWatermark {
  id: number;
  /** When the run that wrote this watermark ran (ms), if recorded. */
  writtenAtMs: number | null;
}

/** KV value `<id>:<writtenAtMs>` (a bare `<id>` is accepted). */
export function parseWatermark(raw: string | null): CertPolskaWatermark | null {
  if (raw === null) return null;
  const [idPart, atPart] = raw.split(":");
  const id = Number(idPart);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const at = atPart === undefined ? NaN : Number(atPart);
  return { id, writtenAtMs: Number.isSafeInteger(at) && at > 0 ? at : null };
}

export function formatWatermark(id: number, writtenAtMs: number): string {
  return `${id}:${writtenAtMs}`;
}

export const cert_polska: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const runAtMs = Date.now();
    const stored = parseWatermark(await ctx.env.CACHE.get(CERT_POLSKA_WATERMARK_KEY));
    const watermark = stored?.id ?? null;
    const url = ctx.feedUrl?.trim() || CERT_POLSKA_URL;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`cert_polska HTTP ${res.status}`);
    if (!res.body) throw new Error("cert_polska: empty body");

    const scan = await scanCertPolska(res.body, watermark, runAtMs);
    if (scan.topId === null) {
      throw new Error(
        scan.invalid > 0
          ? `cert_polska: no valid records (${scan.invalid} malformed — format change?)`
          : "cert_polska: list is empty (upstream fault)",
      );
    }

    const warnings: string[] = [];
    if (scan.invalid > 0) warnings.push(`${scan.invalid} malformed record(s) skipped`);
    const empty: FeedResult = { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };

    /** Best-effort watermark write; a failure becomes a pull warning. */
    const writeWatermark = async (id: number): Promise<void> => {
      try {
        await ctx.env.CACHE.put(CERT_POLSKA_WATERMARK_KEY, formatWatermark(id, runAtMs));
      } catch (err) {
        // Inserts (if any) landed; the next run re-reads them and INSERT OR
        // IGNORE makes the repeat a no-op.
        warnings.push(`watermark write failed (${err instanceof Error ? err.message : String(err)})`);
      }
    };
    const withWarnings = (r: FeedResult): FeedResult =>
      warnings.length > 0 ? { ...r, warning: `cert_polska: ${warnings.join("; ")}` } : r;

    // Upstream renumbered (the newest id is below what we already settled):
    // nothing in the file can be trusted to be new. Re-baseline, ingest nothing.
    if (watermark !== null && scan.topId < watermark) {
      warnings.push(`top RegisterPositionId ${scan.topId} < watermark ${watermark}: upstream renumbered, re-baselined`);
      await writeWatermark(scan.topId);
      return withWarnings(empty);
    }

    // Ids are expected to rise with time. The head-only stream reads exactly
    // one record at or below the watermark (the one it stops on); if that one
    // was inserted after the run that set the watermark, an entry was added
    // BELOW the watermark and that run could not have seen it. Records
    // further down are never read, so a deeper back-dated insert is not
    // detected (that would need reading past the watermark).
    if (scan.stopRecord && stored?.writtenAtMs && scan.stopRecord.insertMs > stored.writtenAtMs) {
      warnings.push(
        `record ${scan.stopRecord.id} (at/below watermark ${watermark}) was inserted after the last run; ` +
          `entries added below the watermark are missed`,
      );
    }

    // Oldest-first, so the watermark can advance over a settled prefix.
    let items = [...scan.collected].sort((a, b) => a.id - b.id);
    const gap = watermark !== null && scan.stop === "scan_cap";
    if (gap) {
      warnings.push(
        `backlog over ${CERT_POLSKA_MAX_SCAN_RECORDS} records since watermark ${watermark}: ingested the newest, skipped the rest`,
      );
    }

    // Select a prefix with at most MAX_INSERTS insertable rows. In the gap
    // case take the newest slice instead (the older part is skipped anyway).
    const insertable = (r: CertPolskaRecord): string | null => (r.deleted ? null : normalizeCertPolskaDomain(r.domain));
    if (gap) {
      let n = 0;
      let start = items.length;
      while (start > 0 && n < CERT_POLSKA_MAX_INSERTS_PER_RUN) {
        start--;
        if (insertable(items[start]!)) n++;
      }
      items = items.slice(start);
    }

    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;
    let attempted = 0;
    let settledThrough: number | null = null;
    let chunkItems: CertPolskaRecord[] = [];
    let chunkRows: ThreatRow[] = [];

    /** Insert the pending chunk; false = it failed (nothing in it is settled). */
    const flush = async (): Promise<boolean> => {
      if (chunkRows.length > 0) {
        const r = await bulkInsertThreats(ctx.env.DB, chunkRows, INSERT_CHUNK);
        itemsNew += r.itemsNew;
        itemsDuplicate += r.itemsDuplicate;
        itemsError += r.itemsError;
        if (r.itemsError > 0) return false;
      }
      if (chunkItems.length > 0) settledThrough = chunkItems[chunkItems.length - 1]!.id;
      chunkItems = [];
      chunkRows = [];
      return true;
    };

    let capped = false;
    let failed = false;
    let idnRejected = 0;
    for (const rec of items) {
      const domain = insertable(rec);
      if (domain && attempted >= CERT_POLSKA_MAX_INSERTS_PER_RUN) {
        capped = true;
        break;
      }
      if (!rec.deleted && !domain && isUnicodeDomain(rec.domain)) idnRejected++;
      chunkItems.push(rec);
      if (domain) {
        attempted++;
        chunkRows.push({
          id: await threatId64("cert_polska", "domain", domain),
          source_feed: "cert_polska",
          threat_type: "phishing",
          malicious_url: null,
          malicious_domain: domain,
          ioc_value: domain,
          severity: "high",
          confidence_score: 80,
        });
      }
      if (chunkRows.length >= INSERT_CHUNK && !(await flush())) {
        failed = true;
        break;
      }
    }
    if (!failed && !(await flush())) failed = true;
    const allSettled = !failed && !capped;

    // New watermark: everything settled → the newest id we have seen (the
    // top of the file, which also covers a baseline window with no
    // additions); otherwise the end of the settled prefix. Never backwards.
    const next = allSettled ? scan.topId : settledThrough;

    // A chunk failed and nothing at all was settled: the run made no
    // progress and the watermark stays put. Fail the pull so runFeed records
    // it and the circuit breaker backs off (a partial success still returns).
    if (failed && settledThrough === null) {
      throw new Error(
        `cert_polska: insert failed with nothing settled (${itemsError} row(s) errored); watermark unchanged`,
      );
    }

    if (next !== null && (watermark === null || next > watermark)) await writeWatermark(next);
    if (itemsError > 0) warnings.push(`${itemsError} row(s) failed to insert; retried next run`);
    if (idnRejected > 0) warnings.push(`${idnRejected} Unicode domain(s) failed validation and were skipped`);

    return withWarnings({ itemsFetched: attempted, itemsNew, itemsDuplicate, itemsError });
  },
};
