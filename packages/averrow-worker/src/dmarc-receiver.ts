/**
 * DMARC Aggregate Report Receiver
 *
 * Processes DMARC aggregate reports delivered via Cloudflare Email Routing
 * to the addresses in lib/dmarc-rua.ts. Reports arrive as RFC 822 emails
 * with XML attachments (ZIP, GZIP or plain).
 *
 * Pipeline per message (all bounded; the input is unauthenticated):
 *   1. MIME → XML. Raw email ≤ 5 MB; ≤ 3 candidate attachments and ≤ 12 MB
 *      decompressed in total per email (zip/gzip bomb guard).
 *   2. Parse (lib/dmarc-aggregate-xml.ts): RFC 7489 + RFC 9990 shapes,
 *      hostile-input caps; per-report totals clamped.
 *   3. Provenance (lib/dmarc-provenance.ts): From domain + our MTA's
 *      topmost Authentication-Results → `verified`.
 *   4. Gates (lib/dmarc-enrollment.ts): brand match → eligible brand →
 *      enrolled canonical domain → wall-clock rate caps. Every miss is a
 *      counted drop; nothing is stored or notified.
 *   5. One atomic, retried D1 batch: claim the (domain, reporter,
 *      report_id) key in dmarc_report_seen, upsert dmarc_daily_stats and
 *      insert the dmarc_reports row — both guarded on our claim and on no
 *      row carrying it yet, so a retry or a resend never double-counts.
 *      The row is found again by claim_id (no reliance on RETURNING).
 *   6. Per-source records (≤ MAX_STORED_RECORDS, failing first), retried
 *      per batch. A report left incomplete (processed = 0, or a dead
 *      worker's stale processed = 2) is completed by a resend carrying the
 *      same totals instead of being dropped as duplicate.
 *   7. Staff notification (verified reports only) and the source rollup
 *      under waitUntil; a rollup that never lands is caught up by
 *      Navigator (lib/dmarc-source-rollup.ts runDmarcRollupCatchUp).
 *
 * dmarc_reports.processed: 2 = being written, 1 = complete, 0 = incomplete
 * (records failed — a resend recovers it).
 *
 * DMARC pass = aligned DKIM pass OR aligned SPF pass (RFC 7489 §6.6.2,
 * RFC 9989). Before 2026-11-14 this file required BOTH.
 *
 * Critical: never call setReject() — Google/Microsoft stop sending on
 * bounces. Every error is caught, logged and counted; nothing propagates to
 * the email handler.
 */

import type { Env } from "./types";
import { createNotification } from "./lib/notifications";
import {
  DMARC_XML_LIMITS,
  dmarcReportDay,
  dmarcReportEpochIso,
  encodeRecordAuth,
  isDmarcReportInWindow,
  parseDmarcAggregateXml,
  type DmarcAggregateRecord,
  type DmarcAggregateReport,
} from "./lib/dmarc-aggregate-xml";
import {
  checkDmarcEnrollment,
  isDmarcEligibleBrand,
  recordDmarcDrop,
  resolveDmarcBrand,
  takeDmarcIngestSlot,
  type DmarcBrand,
  type DmarcDropReason,
} from "./lib/dmarc-enrollment";
import { readDmarcProvenance, type DmarcProvenance, type DmarcProvenanceOptions } from "./lib/dmarc-provenance";
import { DMARC_STALE_PROCESSING_AGE, pickDkimDomain, recordDmarcPassed, runDmarcSourceRollup } from "./lib/dmarc-source-rollup";
import { withD1Retry, D1_OVERLOAD_RETRY_BASE_MS } from "./lib/d1-retry";

export { dmarcReportDay } from "./lib/dmarc-aggregate-xml";

// ─── Cloudflare Email Worker types ───────────────────────────────

export interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

/** Raw email read cap. */
export const MAX_EMAIL_BYTES = 5 * 1024 * 1024;
/** Decompressed XML cap for one attachment. */
export const MAX_XML_BYTES = 10 * 1024 * 1024;
/** Decompressed bytes across all attachments of one email (S3). */
export const MAX_EMAIL_DECOMPRESSED_BYTES = 12 * 1024 * 1024;
/** Candidate attachments tried per email (S3). */
export const MAX_CANDIDATE_ATTACHMENTS = 3;
/**
 * Per-source rows stored per report (failing records first). Unverified
 * reports keep fewer: their evidence is forgeable, and the smaller cap is
 * what lets the retention sweep keep up with the unverified ingest cap
 * (lib/dmarc-retention.ts).
 */
export const MAX_STORED_RECORDS = { verified: 1000, unverified: 250 } as const;

/** Rows per multi-row records INSERT: 12 columns × 8 = 96 binds (< 100). */
const RECORD_ROWS_PER_STMT = 8;
const RECORD_STMTS_PER_BATCH = 50;

const RETRY = { overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS } as const;

export type DmarcIngestOutcome =
  | {
      status: "stored";
      reportRowId: number;
      brandId: string;
      pass: number;
      fail: number;
      storedRecords: number;
      complete: boolean;
      recovered: boolean;
      verified: boolean;
    }
  | { status: "dropped"; reason: DmarcDropReason }
  | { status: "error"; error: string };

type WaitUntil = Pick<ExecutionContext, "waitUntil">;

// ─── Main entry point ─────────────────────────────────────────────

export async function handleDmarcEmail(
  message: EmailMessage,
  env: Env,
  ctx?: WaitUntil,
  opts: { provenance?: DmarcProvenanceOptions } = {},
): Promise<DmarcIngestOutcome> {
  try {
    const rawBytes = await readStream(message.raw, MAX_EMAIL_BYTES);
    const provenance = readDmarcProvenance(new TextDecoder("utf-8").decode(rawBytes.subarray(0, 65_536)), message.from, opts.provenance);
    const xmlData = await extractXmlFromEmail(rawBytes);
    const report = xmlData ? parseDmarcAggregateXml(xmlData) : null;
    if (!xmlData || !report) {
      await recordDmarcDrop(env, "unparseable");
      return { status: "dropped", reason: "unparseable" };
    }
    return await ingestDmarcReport(env, report, { senderEmail: message.from, provenance }, xmlData, ctx);
  } catch (err) {
    // Never reject/bounce — accept, log, count (a total failure must not
    // read as a quiet day in diagnostics).
    const error = err instanceof Error ? err.message : String(err);
    console.error("[dmarc] Processing error:", error);
    await recordDmarcDrop(env, "error");
    return { status: "error", error };
  }
}

// ─── Stream reading ───────────────────────────────────────────────

async function readStream(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - totalSize;
    if (value.length > room) {
      if (room > 0) chunks.push(value.subarray(0, room));
      totalSize = max;
      console.warn("[dmarc] Email exceeds cap — truncating");
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    totalSize += value.length;
  }
  return concat(chunks, totalSize);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ─── MIME parsing ─────────────────────────────────────────────────

/** Shared per-email decompression budget (S3). */
interface ExtractBudget {
  bytesLeft: number;
  attachmentsLeft: number;
}

/** A DMARC feedback document: `<feedback` with any namespace prefix. */
function looksLikeFeedbackXml(s: string): boolean {
  return /<(?:[A-Za-z_][\w.-]{0,63}:)?feedback[\s>]/.test(s.slice(0, 4096)) || s.trimStart().startsWith("<?xml");
}

export async function extractXmlFromEmail(rawBytes: Uint8Array): Promise<string | null> {
  const budget: ExtractBudget = { bytesLeft: MAX_EMAIL_DECOMPRESSED_BYTES, attachmentsLeft: MAX_CANDIDATE_ATTACHMENTS };
  const rawStr = new TextDecoder("utf-8").decode(rawBytes);

  // Split headers / body (tolerate bare-LF messages).
  let headerEnd = rawStr.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (headerEnd < 0) {
    headerEnd = rawStr.indexOf("\n\n");
    sepLen = 2;
  }
  const headerStr = headerEnd >= 0 ? rawStr.slice(0, headerEnd) : rawStr.slice(0, 4096);
  const bodyStart = headerEnd >= 0 ? headerEnd + sepLen : 0;

  const contentType = headerStr.match(/^Content-Type:\s*([^;\r\n]+)/im)?.[1]?.trim().toLowerCase() ?? "";
  const boundary = headerStr.match(/boundary=["']?([^"'\r\n;]+)["']?/i)?.[1]?.trim() ?? null;
  const encoding = headerStr.match(/^Content-Transfer-Encoding:\s*(\S+)/im)?.[1]?.trim().toLowerCase() ?? "";

  if (boundary && contentType.startsWith("multipart/")) {
    return parseMultipart(rawStr.slice(bodyStart), boundary, 0, budget);
  }

  // Single-part body.
  budget.attachmentsLeft--;
  const bodyBytes = encoding === "base64" ? base64Decode(rawStr.slice(bodyStart)) : rawBytes.slice(bodyStart);
  return bodyBytes ? decompressAndDecode(bodyBytes, budget) : null;
}

async function parseMultipart(body: string, boundary: string, depth: number, budget: ExtractBudget): Promise<string | null> {
  if (depth > 3) return null;
  const parts = body.split(`--${boundary}`);

  for (const part of parts) {
    if (budget.attachmentsLeft <= 0 || budget.bytesLeft <= 0) return null;
    if (!part || part.startsWith("--")) continue; // preamble / epilogue

    let partSep = part.indexOf("\r\n\r\n");
    let sepLen = 4;
    if (partSep < 0) {
      partSep = part.indexOf("\n\n");
      sepLen = 2;
    }
    if (partSep < 0) continue;

    const partHeaders = part.slice(0, partSep);
    const partBodyStr = part.slice(partSep + sepLen);

    const partCt = partHeaders.match(/^Content-Type:\s*([^;\r\n]+)/im)?.[1]?.trim().toLowerCase() ?? "";
    const encoding = partHeaders.match(/^Content-Transfer-Encoding:\s*(\S+)/im)?.[1]?.trim().toLowerCase() ?? "";
    const cd = partHeaders.match(/^Content-Disposition:[^\r\n]*/im)?.[0]?.toLowerCase() ?? "";
    const filename = (cd.match(/filename[*]?=["']?([^"';\r\n]+)["']?/i)?.[1] ?? partHeaders.match(/name=["']?([^"';\r\n]+)["']?/i)?.[1] ?? "")
      .toLowerCase().replace(/['"]/g, "");

    // Nested multipart (e.g. mixed → alternative + attachment).
    if (partCt.startsWith("multipart/")) {
      const nested = partHeaders.match(/boundary=["']?([^"'\r\n;]+)["']?/i)?.[1]?.trim();
      if (nested) {
        const xml = await parseMultipart(partBodyStr, nested, depth + 1, budget);
        if (xml) return xml;
      }
      continue;
    }

    // Skip text-only parts
    if (partCt.startsWith("text/plain") || partCt.startsWith("text/html")) continue;

    const looksLikeDmarc =
      filename.includes("dmarc") ||
      filename.endsWith(".xml") ||
      filename.endsWith(".gz") ||
      filename.endsWith(".zip") ||
      partCt.includes("xml") ||
      partCt.includes("zip") ||
      partCt.includes("gzip") ||
      (partCt.includes("octet-stream") && (cd.includes("attachment") || filename !== ""));
    if (!looksLikeDmarc) continue;

    budget.attachmentsLeft--;
    const partBytes = encoding === "base64" ? base64Decode(partBodyStr) : new TextEncoder().encode(partBodyStr);
    if (!partBytes) continue;

    const xml = await decompressAndDecode(partBytes, budget);
    if (xml && looksLikeFeedbackXml(xml)) return xml;
  }

  return null;
}

async function decompressAndDecode(bytes: Uint8Array, budget: ExtractBudget): Promise<string | null> {
  if (bytes.length === 0) return null;
  try {
    let out: Uint8Array | null;
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      out = await decompressZip(bytes, budget);
    } else if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      out = await streamDecompress(bytes, "gzip", budget);
    } else {
      out = bytes.length <= Math.min(MAX_XML_BYTES, budget.bytesLeft) ? bytes : null;
      if (out) budget.bytesLeft -= out.length;
    }
    if (!out) return null;
    const str = new TextDecoder("utf-8").decode(out);
    return looksLikeFeedbackXml(str) ? str : null;
  } catch (err) {
    console.error("[dmarc] decompressAndDecode error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── ZIP decompression (first local file entry) ──────────────────

async function decompressZip(bytes: Uint8Array, budget: ExtractBudget): Promise<Uint8Array | null> {
  try {
    // Local File Header (little-endian): 0x08 method, 0x12 compressed
    // size, 0x1a name length, 0x1c extra length, data at 30 + N + M.
    if (bytes.length < 30) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const compressionMethod = v.getUint16(8, true);
    const compressedSize = v.getUint32(18, true);
    const dataOffset = 30 + v.getUint16(26, true) + v.getUint16(28, true);
    if (dataOffset >= bytes.length) return null;

    const dataLen = compressedSize > 0 ? Math.min(compressedSize, bytes.length - dataOffset) : bytes.length - dataOffset;
    const compressed = bytes.slice(dataOffset, dataOffset + dataLen);

    if (compressionMethod === 0) {
      if (compressed.length > Math.min(MAX_XML_BYTES, budget.bytesLeft)) return null;
      budget.bytesLeft -= compressed.length;
      return compressed;
    }
    if (compressionMethod === 8) return streamDecompress(compressed, "deflate-raw", budget);
    console.warn(`[dmarc] ZIP: unsupported compression method ${compressionMethod}`);
    return null;
  } catch (err) {
    console.error("[dmarc] ZIP parse error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Decompress with a hard output cap (min of the per-attachment cap and
 *  what is left of the email's budget); the reader is cancelled at the cap. */
async function streamDecompress(bytes: Uint8Array, format: "deflate-raw" | "gzip", budget: ExtractBudget): Promise<Uint8Array | null> {
  const cap = Math.min(MAX_XML_BYTES, budget.bytesLeft);
  let total = 0;
  try {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(bytes as BufferSource).catch(() => {});
    writer.close().catch(() => {});

    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        console.warn("[dmarc] Decompressed data over cap — aborting");
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return concat(chunks, total);
  } catch (err) {
    console.error(`[dmarc] streamDecompress(${format}) error:`, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    budget.bytesLeft -= Math.min(total, cap + 1);
  }
}

/** Base64 → bytes; null on invalid input (e.g. a body cut off by the 5 MB
 *  read cap) instead of throwing. */
function base64Decode(b64: string): Uint8Array | null {
  try {
    const clean = b64.replace(/\s+/g, "");
    const binary = atob(clean.slice(0, clean.length - (clean.length % 4)));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Failing records first (by volume), then passing — what we keep when a
 *  report has more rows than MAX_STORED_RECORDS. */
function recordsToStore(records: DmarcAggregateRecord[], max: number): DmarcAggregateRecord[] {
  if (records.length <= max) return records;
  return [...records]
    .sort((a, b) => Number(recordDmarcPassed(a)) - Number(recordDmarcPassed(b)) || b.message_count - a.message_count)
    .slice(0, max);
}

/**
 * B3c: a report claiming more than maxReportMessages messages is scaled
 * down proportionally (each record ≥ 1), so stats and notification numbers
 * stay sane while the pass/fail rate is kept.
 */
export function clampReportVolume(records: DmarcAggregateRecord[]): { records: DmarcAggregateRecord[]; clamped: boolean } {
  const total = records.reduce((n, r) => n + r.message_count, 0);
  if (total <= DMARC_XML_LIMITS.maxReportMessages) return { records, clamped: false };
  const f = DMARC_XML_LIMITS.maxReportMessages / total;
  return { records: records.map((r) => ({ ...r, message_count: Math.max(1, Math.floor(r.message_count * f)) })), clamped: true };
}

/** Claim guard: our claim won the seen-key AND no report row carries it yet. */
const CLAIM_GUARD_SQL = `EXISTS (SELECT 1 FROM dmarc_report_seen
     WHERE domain = ? AND reporter_org = ? AND report_id = ? AND claim_id = ?)
   AND NOT EXISTS (SELECT 1 FROM dmarc_reports WHERE claim_id = ?)`;

export interface DmarcSenderInfo {
  senderEmail: string;
  provenance: DmarcProvenance;
}

// ─── Ingest ───────────────────────────────────────────────────────

export async function ingestDmarcReport(
  env: Env,
  parsed: DmarcAggregateReport,
  sender: DmarcSenderInfo,
  rawXml: string,
  ctx?: WaitUntil,
  nowMs = Date.now(),
): Promise<DmarcIngestOutcome> {
  const db = env.DB;
  const drop = async (reason: DmarcDropReason): Promise<DmarcIngestOutcome> => {
    await recordDmarcDrop(env, reason, nowMs);
    return { status: "dropped", reason };
  };
  const verified = sender.provenance.verified;

  // 4. Gates. The date window costs no D1 read.
  if (!isDmarcReportInWindow(parsed.date_begin, parsed.date_end, nowMs)) return drop("out_of_window");
  const brand = await resolveDmarcBrand(db, parsed.domain);
  if (!brand) return drop("no_brand");
  if (!isDmarcEligibleBrand(brand)) return drop("ineligible_brand");
  const enrollment = await checkDmarcEnrollment(env, brand, nowMs);
  if (!enrollment.enrolled) return drop("unenrolled");
  const slot = await takeDmarcIngestSlot(env, brand.id, verified, nowMs);
  if (!slot.allowed) return drop("rate_limited");

  const { records, clamped } = clampReportVolume(parsed.records);
  const report: DmarcAggregateReport = { ...parsed, records };

  // Totals — DMARC passes when EITHER aligned check passes.
  let pass = 0;
  let fail = 0;
  const failingByIp = new Map<string, number>();
  for (const r of report.records) {
    if (recordDmarcPassed(r)) {
      pass += r.message_count;
    } else {
      fail += r.message_count;
      failingByIp.set(r.source_ip, (failingByIp.get(r.source_ip) ?? 0) + r.message_count);
    }
  }
  const total = pass + fail;
  const uniqueSources = new Set(report.records.map((r) => r.source_ip)).size;
  const topFailing = [...failingByIp.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10)
    .map(([ip, count]) => ({ ip, count }));
  const reportDate = dmarcReportDay(report.date_begin, report.date_end, nowMs);

  // 5. Dedup claim + daily stats + report row, atomically, retried.
  const seenKey = [report.domain, report.reporter_org, report.report_id || `sha256:${await sha256Hex(rawXml)}`];
  const claimId = crypto.randomUUID();
  const guardBinds = [...seenKey, claimId, claimId];
  const notes = [
    report.truncated ? `truncated: more than ${report.records.length} records parsed` : null,
    clamped ? "clamped: report volume scaled to the per-report cap" : null,
  ].filter((e): e is string => !!e);

  await withD1Retry(() => db.batch([
    db.prepare(
      `INSERT INTO dmarc_report_seen (domain, reporter_org, report_id, claim_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(domain, reporter_org, report_id) DO NOTHING`,
    ).bind(...seenKey, claimId),
    // Keyed by the BRAND's canonical domain (what /stats and
    // /spoof-sources read), so a subdomain's reports roll into the brand.
    // top_fail_ips / reporters are merged, not overwritten. unique_sources
    // can't be merged without the IP set — MAX is a lower bound. Runs
    // BEFORE the report insert so its NOT EXISTS guard still sees no row.
    db.prepare(
      `INSERT INTO dmarc_daily_stats
         (domain, brand_id, date, total_messages, passed, failed,
          unique_sources, top_fail_ips, reporters)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${CLAIM_GUARD_SQL}
       ON CONFLICT(domain, date) DO UPDATE SET
         brand_id       = COALESCE(dmarc_daily_stats.brand_id, excluded.brand_id),
         total_messages = dmarc_daily_stats.total_messages + excluded.total_messages,
         passed         = dmarc_daily_stats.passed + excluded.passed,
         failed         = dmarc_daily_stats.failed + excluded.failed,
         unique_sources = MAX(dmarc_daily_stats.unique_sources, excluded.unique_sources),
         top_fail_ips   = (SELECT json_group_array(json_object('ip', ip, 'count', n)) FROM (
                             SELECT ip, SUM(n) AS n FROM (
                               SELECT json_extract(value, '$.ip') AS ip, json_extract(value, '$.count') AS n
                                 FROM json_each(COALESCE(dmarc_daily_stats.top_fail_ips, '[]'))
                               UNION ALL
                               SELECT json_extract(value, '$.ip'), json_extract(value, '$.count')
                                 FROM json_each(COALESCE(excluded.top_fail_ips, '[]')))
                             WHERE ip IS NOT NULL
                             GROUP BY ip ORDER BY n DESC, ip LIMIT 10)),
         reporters      = (SELECT json_group_array(value) FROM (
                             SELECT value FROM json_each(COALESCE(dmarc_daily_stats.reporters, '[]'))
                             UNION SELECT value FROM json_each(COALESCE(excluded.reporters, '[]'))
                             LIMIT 50))`,
    ).bind(
      brand.canonical_domain, brand.id, reportDate, total, pass, fail, uniqueSources,
      JSON.stringify(topFailing), JSON.stringify(report.reporter_org ? [report.reporter_org] : []),
      ...guardBinds,
    ),
    // raw_xml is no longer stored (B1c): truncated XML has no forensic
    // value; the dedup key keeps the XML's sha256 when there is no id.
    db.prepare(
      `INSERT INTO dmarc_reports
         (brand_id, domain, reporter_org, reporter_email, report_id,
          date_begin, date_end, total_records, total_messages,
          total_pass, total_fail, policy_published, raw_xml, received_at, processed, process_error,
          sender_domain, sender_auth, verified, claim_id, processing_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'), 2, ?, ?, ?, ?, ?, datetime('now')
       WHERE ${CLAIM_GUARD_SQL}`,
    ).bind(
      brand.id, report.domain, report.reporter_org, sender.senderEmail.slice(0, 200), report.report_id,
      String(report.date_begin), String(report.date_end), report.records.length,
      total, pass, fail, report.dmarc_policy, notes.join("; ") || null,
      sender.provenance.senderDomain, sender.provenance.senderAuth, verified ? 1 : 0, claimId,
      ...guardBinds,
    ),
  ]), { ...RETRY, label: "dmarc-claim" });

  // Find the row by our claim (B4e — not by batch RETURNING).
  let reportRowId: number;
  let recovered = false;
  // On a recovery the stored row's provenance governs, not the resend's.
  let rowVerified = verified;
  const mine = await db.prepare("SELECT id FROM dmarc_reports WHERE claim_id = ?").bind(claimId).first<{ id: number }>();
  if (mine) {
    reportRowId = mine.id;
  } else {
    // Claim lost: a duplicate — unless the original was left incomplete
    // (processed = 0, or a dead worker's processed = 2 older than
    // DMARC_STALE_PROCESSING_AGE), in which case this resend finishes it. Stats
    // are NOT re-counted, and the resend must carry the same totals as the
    // stored original (otherwise it is a different document → duplicate).
    const prior = await db.prepare(
      `SELECT r.id AS id, r.verified AS verified, r.total_pass AS total_pass, r.total_fail AS total_fail
       FROM dmarc_report_seen s JOIN dmarc_reports r ON r.claim_id = s.claim_id
       WHERE s.domain = ? AND s.reporter_org = ? AND s.report_id = ?
         AND (r.processed = 0 OR (r.processed = 2 AND r.processing_at < datetime('now', ?)))`,
    ).bind(...seenKey, DMARC_STALE_PROCESSING_AGE).first<{ id: number; verified: number; total_pass: number; total_fail: number }>();
    if (!prior || prior.total_pass !== pass || prior.total_fail !== fail) return drop("duplicate");
    const taken = await withD1Retry(() =>
      db.prepare(
        `UPDATE dmarc_reports SET processed = 2, processing_at = datetime('now')
         WHERE id = ? AND (processed = 0 OR (processed = 2 AND processing_at < datetime('now', ?)))`,
      ).bind(prior.id, DMARC_STALE_PROCESSING_AGE).run(), RETRY);
    if ((taken.meta?.changes ?? 0) === 0) return drop("duplicate");
    await withD1Retry(() => db.prepare("DELETE FROM dmarc_report_records WHERE report_id = ?").bind(prior.id).run(), RETRY);
    reportRowId = prior.id;
    recovered = true;
    // A resend can't upgrade a report's provenance, only keep or lose it.
    rowVerified = prior.verified === 1 && verified;
  }

  // 6. Per-source records (multi-row INSERTs, ≤96 binds each, retried per batch).
  const stored = recordsToStore(report.records, MAX_STORED_RECORDS[rowVerified ? "verified" : "unverified"]);
  const stmts: D1PreparedStatement[] = [];
  const rowsPerStmt: number[] = [];
  for (let i = 0; i < stored.length; i += RECORD_ROWS_PER_STMT) {
    const rows = stored.slice(i, i + RECORD_ROWS_PER_STMT);
    const binds: Array<string | number | null> = [];
    for (const r of rows) {
      const spf = r.spf_auth.find((s) => s.scope === "mfrom") ?? r.spf_auth[0];
      binds.push(
        reportRowId, r.source_ip, r.message_count, r.disposition || null,
        r.dkim_result || null, r.spf_result || null, recordDmarcPassed(r) ? "pass" : "fail",
        r.header_from || null, r.envelope_from || null,
        pickDkimDomain(r), spf?.domain ?? null, encodeRecordAuth(r),
      );
    }
    stmts.push(db.prepare(
      `INSERT INTO dmarc_report_records
         (report_id, source_ip, count, disposition, dkim_result, spf_result, dmarc_result,
          header_from, envelope_from, dkim_domain, spf_domain, auth_json)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
    ).bind(...binds));
    rowsPerStmt.push(rows.length);
  }
  let storedCount = 0;
  let recordsError: string | null = null;
  for (let i = 0; i < stmts.length; i += RECORD_STMTS_PER_BATCH) {
    const batchRows = rowsPerStmt.slice(i, i + RECORD_STMTS_PER_BATCH).reduce((a, b) => a + b, 0);
    let attempt = 0;
    try {
      // A bare INSERT is not idempotent: if an attempt committed but its
      // response was lost, a blind retry would duplicate the rows. Before
      // each RETRY, count this report's rows (idx_drr_report) — if the
      // batch already landed, it is done.
      await withD1Retry(async () => {
        if (attempt++ > 0) {
          const have = await db.prepare("SELECT COUNT(*) AS n FROM dmarc_report_records WHERE report_id = ?")
            .bind(reportRowId).first<{ n: number }>();
          if ((have?.n ?? 0) >= storedCount + batchRows) return;
        }
        await db.batch(stmts.slice(i, i + RECORD_STMTS_PER_BATCH));
      }, { ...RETRY, label: "dmarc-records" });
      storedCount += batchRows;
    } catch (err) {
      recordsError = `records: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
      console.error("[dmarc] record insert error:", recordsError);
      break;
    }
  }
  const complete = recordsError === null;

  const finalError = [...notes, recordsError].filter((e): e is string => !!e).join("; ") || null;
  await withD1Retry(() => db.batch([
    db.prepare("UPDATE dmarc_reports SET processed = ?, process_error = ? WHERE id = ?")
      .bind(complete ? 1 : 0, finalError, reportRowId),
    db.prepare("UPDATE dmarc_enrollment SET last_report_at = datetime('now') WHERE brand_id = ?").bind(brand.id),
  ]), { ...RETRY, label: "dmarc-finalize" });

  if (complete) {
    // 7a. Staff notification — verified reports only.
    if (rowVerified) await maybeNotifyDmarcFailures(env, brand, reportDate, total, fail);

    // 7b. Source rollup (ipinfo only for verified reports). A rollup that
    // doesn't land is caught up by Navigator from the stored records.
    {
      const rollup = runDmarcSourceRollup(env, {
        reportRowId,
        brandId: brand.id,
        date: reportDate,
        reporterOrg: report.reporter_org,
        verified: rowVerified,
        firstSeen: dmarcReportEpochIso(report.date_begin, nowMs),
        lastSeen: dmarcReportEpochIso(report.date_end, nowMs),
        records: stored,
      }, { geo: rowVerified, nowMs, overloadRetry: true }).catch((err: unknown) => {
        console.error("[dmarc] source rollup error:", err instanceof Error ? err.message : String(err));
      });
      if (ctx) ctx.waitUntil(rollup);
      else await rollup;
    }
  }

  return { status: "stored", reportRowId, brandId: brand.id, pass, fail, storedRecords: storedCount, complete, recovered, verified: rowVerified };
}

/** Fail-rate threshold: > 10% of ≥ 100 messages. */
export const DMARC_NOTIFY_MIN_MESSAGES = 100;
export const DMARC_NOTIFY_MIN_FAIL_RATE = 0.1;

/**
 * Staff notification (B3b). Until report provenance is proven against real
 * mail this goes to the TEAM audience only, at `high` (never `critical`),
 * and only for verified reports. Text is built only from the brand's own
 * canonical domain (brands table) and numbers we computed — nothing from
 * the XML's free text.
 */
async function maybeNotifyDmarcFailures(env: Env, brand: DmarcBrand, reportDate: string, total: number, fail: number): Promise<void> {
  if (fail <= 0 || total < DMARC_NOTIFY_MIN_MESSAGES) return;
  const failRate = fail / total;
  if (failRate <= DMARC_NOTIFY_MIN_FAIL_RATE) return;
  const failPct = Math.round(failRate * 100);
  try {
    await createNotification(env, {
      audience: "team",
      brandId: brand.id,
      groupKey: `email_security_change:dmarc_failures:${brand.id}`,
      type: "email_security_change",
      severity: "high",
      title: `DMARC failures detected for ${brand.canonical_domain}`,
      message: `${failPct}% of ${total.toLocaleString("en-US")} messages in a verified DMARC aggregate report for ${reportDate} failed DMARC`,
      link: `/brands/${brand.id}`,
      metadata: { brand_id: brand.id, domain: brand.canonical_domain, date: reportDate, fail_rate: failPct },
    });
  } catch (notifErr) {
    console.error("[dmarc] notification error:", notifErr instanceof Error ? notifErr.message : String(notifErr));
  }
}
