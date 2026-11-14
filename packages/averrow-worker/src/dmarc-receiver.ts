/**
 * DMARC Aggregate Report Receiver
 *
 * Processes DMARC aggregate reports delivered via Cloudflare Email Routing
 * to the addresses in lib/dmarc-rua.ts. Reports arrive as RFC 822 emails
 * with XML attachments (ZIP, GZIP or plain).
 *
 * Pipeline per message (all bounded; the input is unauthenticated):
 *   1. MIME → XML. Raw email capped at 5 MB, decompressed XML at
 *      MAX_XML_BYTES (zip/gzip bomb guard).
 *   2. Parse (lib/dmarc-aggregate-xml.ts): RFC 7489 + RFC 9990 shapes,
 *      namespace prefixes, auth_results, override reasons; hostile-input
 *      caps on records, fields and IPs.
 *   3. Brand match: indexed `canonical_domain IN (policy domain, parents)`.
 *   4. Enrollment gate (lib/dmarc-enrollment.ts): only brands whose own
 *      `_dmarc` record names our RUA address. Everything else is dropped
 *      and counted — never stored, never notified.
 *   5. One atomic D1 batch: claim the (domain, reporter, report_id) key in
 *      dmarc_report_seen, insert the dmarc_reports row and upsert
 *      dmarc_daily_stats — the last two guarded on our claim, so a resent
 *      report changes nothing.
 *   6. Per-source records (≤ MAX_STORED_RECORDS, failing first), the
 *      tenant notification, and the source rollup under waitUntil.
 *
 * DMARC pass = aligned DKIM pass OR aligned SPF pass (RFC 7489 §6.6.2,
 * RFC 9989). Before 2026-11-14 this file required BOTH, so total_fail,
 * dmarc_daily_stats.failed and the notification over-counted.
 *
 * Critical: never call setReject() — Google/Microsoft stop sending on
 * bounces. Every error is caught and logged; nothing propagates to the
 * email handler.
 */

import type { Env } from "./types";
import { createNotification } from "./lib/notifications";
import { parseDmarcAggregateXml, type DmarcAggregateRecord, type DmarcAggregateReport } from "./lib/dmarc-aggregate-xml";
import { checkDmarcEnrollment, recordDmarcDrop, resolveDmarcBrand, type DmarcBrand } from "./lib/dmarc-enrollment";
import { recordDmarcPassed, runDmarcSourceRollup } from "./lib/dmarc-source-rollup";

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
/** Decompressed XML cap — a zip/gzip bomb stops here. */
export const MAX_XML_BYTES = 10 * 1024 * 1024;
/** Per-source rows stored per report (failing records first). */
export const MAX_STORED_RECORDS = 1000;
/** raw_xml column cap. */
const RAW_XML_CAP = 50_000;
/** Rows per multi-row records INSERT: 11 columns × 8 = 88 binds (< 100). */
const RECORD_ROWS_PER_STMT = 8;
const RECORD_STMTS_PER_BATCH = 50;

export type DmarcIngestOutcome =
  | { status: "stored"; reportRowId: number; brandId: string; pass: number; fail: number; storedRecords: number }
  | { status: "dropped"; reason: "no_brand" | "unenrolled" | "duplicate" | "unparseable" }
  | { status: "error"; error: string };

type WaitUntil = Pick<ExecutionContext, "waitUntil">;

// ─── Main entry point ─────────────────────────────────────────────

export async function handleDmarcEmail(message: EmailMessage, env: Env, ctx?: WaitUntil): Promise<DmarcIngestOutcome> {
  try {
    const rawBytes = await readStream(message.raw, MAX_EMAIL_BYTES);
    const xmlData = await extractXmlFromEmail(rawBytes);
    if (!xmlData) {
      await recordDmarcDrop(env, "unparseable");
      return { status: "dropped", reason: "unparseable" };
    }
    const report = parseDmarcAggregateXml(xmlData);
    if (!report) {
      await recordDmarcDrop(env, "unparseable");
      return { status: "dropped", reason: "unparseable" };
    }
    return await ingestDmarcReport(env, report, message.from, xmlData, ctx);
  } catch (err) {
    // Never reject/bounce — always accept silently.
    const error = err instanceof Error ? err.message : String(err);
    console.error("[dmarc] Processing error:", error);
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

/** A DMARC feedback document: `<feedback` with any namespace prefix. */
function looksLikeFeedbackXml(s: string): boolean {
  return /<(?:[A-Za-z_][\w.-]{0,63}:)?feedback[\s>]/.test(s.slice(0, 4096)) || s.trimStart().startsWith("<?xml");
}

export async function extractXmlFromEmail(rawBytes: Uint8Array): Promise<string | null> {
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
    return parseMultipart(rawStr.slice(bodyStart), boundary, 0);
  }

  // Single-part body.
  const bodyStr = rawStr.slice(bodyStart);
  const bodyBytes = encoding === "base64" ? base64Decode(bodyStr.replace(/\s+/g, "")) : rawBytes.slice(bodyStart);
  return decompressAndDecode(bodyBytes);
}

async function parseMultipart(body: string, boundary: string, depth: number): Promise<string | null> {
  if (depth > 3) return null;
  const parts = body.split(`--${boundary}`);

  for (const part of parts) {
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
        const xml = await parseMultipart(partBodyStr, nested, depth + 1);
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

    const partBytes = encoding === "base64"
      ? base64Decode(partBodyStr.replace(/\s+/g, ""))
      : new TextEncoder().encode(partBodyStr);

    const xml = await decompressAndDecode(partBytes);
    if (xml && looksLikeFeedbackXml(xml)) return xml;
  }

  return null;
}

async function decompressAndDecode(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length === 0) return null;
  try {
    // ZIP: PK\x03\x04
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      const out = await decompressZip(bytes);
      return out ? new TextDecoder().decode(out) : null;
    }
    // GZIP: 1F 8B
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const out = await streamDecompress(bytes, "gzip");
      return out ? new TextDecoder().decode(out) : null;
    }
    // Plain XML
    if (bytes.length > MAX_XML_BYTES) return null;
    const str = new TextDecoder("utf-8").decode(bytes);
    if (looksLikeFeedbackXml(str)) return str;
  } catch (err) {
    console.error("[dmarc] decompressAndDecode error:", err instanceof Error ? err.message : String(err));
  }
  return null;
}

// ─── ZIP decompression (first local file entry) ──────────────────

async function decompressZip(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    // Local File Header (little-endian): 0x08 method, 0x12 compressed
    // size, 0x1a name length, 0x1c extra length, data at 30 + N + M.
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 30) return null;
    const compressionMethod = v.getUint16(8, true);
    const compressedSize = v.getUint32(18, true);
    const dataOffset = 30 + v.getUint16(26, true) + v.getUint16(28, true);
    if (dataOffset >= bytes.length) return null;

    const dataLen = compressedSize > 0 ? Math.min(compressedSize, bytes.length - dataOffset) : bytes.length - dataOffset;
    const compressed = bytes.slice(dataOffset, dataOffset + dataLen);

    if (compressionMethod === 0) return compressed.length <= MAX_XML_BYTES ? compressed : null; // stored
    if (compressionMethod === 8) return streamDecompress(compressed, "deflate-raw");
    console.warn(`[dmarc] ZIP: unsupported compression method ${compressionMethod}`);
    return null;
  } catch (err) {
    console.error("[dmarc] ZIP parse error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Decompress with a hard output cap; the reader is cancelled at the cap. */
async function streamDecompress(bytes: Uint8Array, format: "deflate-raw" | "gzip"): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(bytes as BufferSource).catch(() => {});
    writer.close().catch(() => {});

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_XML_BYTES) {
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
  }
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * UTC report day. The range end is exclusive in practice (Google sends
 * 00:00:00–23:59:59, others end at the next midnight), so take end − 1 s.
 * A date outside [now − 60 d, now + 2 d] (hostile or broken) is replaced by
 * today so it can't scatter rows across arbitrary days.
 */
export function dmarcReportDay(begin: number, end: number, nowMs: number): string {
  const t = end > 0 ? Math.max(end - 1, begin) : begin;
  let ms = t > 0 ? t * 1000 : nowMs;
  if (ms < nowMs - 60 * 86_400_000 || ms > nowMs + 2 * 86_400_000) ms = nowMs;
  return new Date(ms).toISOString().slice(0, 10);
}

function epochIso(sec: number, fallbackMs: number): string {
  const ms = sec > 0 ? sec * 1000 : fallbackMs;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date(fallbackMs).toISOString();
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Failing records first (by volume), then passing — what we keep when a
 *  report has more rows than MAX_STORED_RECORDS. */
function recordsToStore(records: DmarcAggregateRecord[]): DmarcAggregateRecord[] {
  if (records.length <= MAX_STORED_RECORDS) return records;
  return [...records]
    .sort((a, b) => Number(recordDmarcPassed(a)) - Number(recordDmarcPassed(b)) || b.message_count - a.message_count)
    .slice(0, MAX_STORED_RECORDS);
}

const SEEN_CLAIM_SQL = `EXISTS (SELECT 1 FROM dmarc_report_seen
   WHERE domain = ? AND reporter_org = ? AND report_id = ? AND claim_id = ?)`;

// ─── Ingest ───────────────────────────────────────────────────────

export async function ingestDmarcReport(
  env: Env,
  report: DmarcAggregateReport,
  senderEmail: string,
  rawXml: string,
  ctx?: WaitUntil,
  nowMs = Date.now(),
): Promise<DmarcIngestOutcome> {
  const db = env.DB;

  // 3. Brand.
  const brand = await resolveDmarcBrand(db, report.domain);
  if (!brand) {
    await recordDmarcDrop(env, "no_brand", nowMs);
    return { status: "dropped", reason: "no_brand" };
  }

  // 4. Enrollment gate.
  const enrollment = await checkDmarcEnrollment(env, brand, report.domain, nowMs);
  if (!enrollment.enrolled) {
    await recordDmarcDrop(env, "unenrolled", nowMs);
    return { status: "dropped", reason: "unenrolled" };
  }

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

  // 5. Dedup claim + report row + daily stats, atomically.
  const seenDomain = report.domain;
  const seenOrg = report.reporter_org;
  const seenId = report.report_id || `sha256:${await sha256Hex(rawXml)}`;
  const claimId = crypto.randomUUID();
  const claimBinds = [seenDomain, seenOrg, seenId, claimId];
  const cappedXml = rawXml.length > RAW_XML_CAP ? `${rawXml.slice(0, RAW_XML_CAP)}…[truncated]` : rawXml;
  const processError = report.truncated ? `truncated: more than ${report.records.length} records parsed` : null;

  const results = await db.batch([
    db.prepare(
      `INSERT INTO dmarc_report_seen (domain, reporter_org, report_id, claim_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(domain, reporter_org, report_id) DO NOTHING`,
    ).bind(...claimBinds),
    db.prepare(
      `INSERT INTO dmarc_reports
         (brand_id, domain, reporter_org, reporter_email, report_id,
          date_begin, date_end, total_records, total_messages,
          total_pass, total_fail, policy_published, raw_xml, received_at, processed, process_error)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 0, ?
       WHERE ${SEEN_CLAIM_SQL}
       RETURNING id`,
    ).bind(
      brand.id, report.domain, report.reporter_org, senderEmail.slice(0, 200), report.report_id,
      String(report.date_begin), String(report.date_end), report.records.length,
      total, pass, fail, report.dmarc_policy, cappedXml, processError,
      ...claimBinds,
    ),
    // Keyed by the BRAND's canonical domain (what /stats and
    // /spoof-sources read), so a subdomain's reports roll into the brand.
    // top_fail_ips / reporters are merged, not overwritten. unique_sources
    // can't be merged without the IP set — MAX is a lower bound.
    db.prepare(
      `INSERT INTO dmarc_daily_stats
         (domain, brand_id, date, total_messages, passed, failed,
          unique_sources, top_fail_ips, reporters)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${SEEN_CLAIM_SQL}
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
      ...claimBinds,
    ),
  ]);

  const inserted = (results[1]?.results as Array<{ id: number }> | undefined)?.[0]?.id;
  if (!inserted) {
    await recordDmarcDrop(env, "duplicate", nowMs);
    return { status: "dropped", reason: "duplicate" };
  }
  const reportRowId = Number(inserted);

  // 6a. Per-source records (multi-row INSERTs, ≤88 binds each).
  const stored = recordsToStore(report.records);
  let recordsError: string | null = null;
  try {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < stored.length; i += RECORD_ROWS_PER_STMT) {
      const rows = stored.slice(i, i + RECORD_ROWS_PER_STMT);
      const binds: Array<string | number | null> = [];
      for (const r of rows) {
        const spf = r.spf_auth.find((s) => s.scope === "mfrom") ?? r.spf_auth[0];
        binds.push(
          reportRowId, r.source_ip, r.message_count, r.disposition || null,
          r.dkim_result || null, r.spf_result || null, recordDmarcPassed(r) ? "pass" : "fail",
          r.header_from || null, r.envelope_from || null,
          r.dkim_auth[0]?.domain ?? null, spf?.domain ?? null,
        );
      }
      stmts.push(db.prepare(
        `INSERT INTO dmarc_report_records
           (report_id, source_ip, count, disposition, dkim_result, spf_result, dmarc_result,
            header_from, envelope_from, dkim_domain, spf_domain)
         VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      ).bind(...binds));
    }
    for (let i = 0; i < stmts.length; i += RECORD_STMTS_PER_BATCH) {
      await db.batch(stmts.slice(i, i + RECORD_STMTS_PER_BATCH));
    }
  } catch (err) {
    recordsError = `records: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
    console.error("[dmarc] record insert error:", recordsError);
  }

  const finalError = [processError, recordsError].filter((e): e is string => !!e).join("; ") || null;
  await db.batch([
    db.prepare("UPDATE dmarc_reports SET processed = ?, process_error = ? WHERE id = ?")
      .bind(recordsError ? 0 : 1, finalError, reportRowId),
    db.prepare("UPDATE dmarc_enrollment SET last_report_at = datetime('now') WHERE brand_id = ?").bind(brand.id),
  ]);

  // 6b. Tenant notification (enrolled brand only — we are past the gate).
  await maybeNotifyDmarcFailures(env, brand, reportDate, total, fail);

  // 6c. Source rollup — metadata only, off the critical path.
  const rollup = runDmarcSourceRollup(env, {
    brandId: brand.id,
    date: reportDate,
    reporterOrg: report.reporter_org,
    reportRowId,
    firstSeen: epochIso(report.date_begin, nowMs),
    lastSeen: epochIso(report.date_end, nowMs),
    records: report.records,
  }).catch((err: unknown) => {
    console.error("[dmarc] source rollup error:", err instanceof Error ? err.message : String(err));
  });
  if (ctx) ctx.waitUntil(rollup);
  else await rollup;

  return { status: "stored", reportRowId, brandId: brand.id, pass, fail, storedRecords: recordsError ? 0 : stored.length };
}

/** Fail-rate threshold: > 10% of ≥ 100 messages. */
export const DMARC_NOTIFY_MIN_MESSAGES = 100;
export const DMARC_NOTIFY_MIN_FAIL_RATE = 0.1;

/**
 * Tenant notification. Text is built ONLY from the brand's own canonical
 * domain (from the brands table) and numbers we computed — no reporter
 * org, report id or other free text from the (unauthenticated) XML.
 */
async function maybeNotifyDmarcFailures(env: Env, brand: DmarcBrand, reportDate: string, total: number, fail: number): Promise<void> {
  if (fail <= 0 || total < DMARC_NOTIFY_MIN_MESSAGES) return;
  const failRate = fail / total;
  if (failRate <= DMARC_NOTIFY_MIN_FAIL_RATE) return;
  const failPct = Math.round(failRate * 100);
  try {
    await createNotification(env, {
      // 'email_security_change' (user-toggleable, PR-B); tenant audience —
      // DMARC failure is brand business (N1). Own group key so a grade-
      // change notification for the brand doesn't suppress this one.
      audience: "tenant",
      brandId: brand.id,
      groupKey: `email_security_change:dmarc_failures:${brand.id}`,
      type: "email_security_change",
      severity: failRate > 0.5 ? "critical" : "high",
      title: `DMARC failures detected for ${brand.canonical_domain}`,
      message: `${failPct}% of ${total.toLocaleString("en-US")} messages in a DMARC aggregate report for ${reportDate} failed DMARC`,
      link: `/brands/${brand.id}`,
      metadata: { brand_id: brand.id, domain: brand.canonical_domain, date: reportDate, fail_rate: failPct },
    });
  } catch (notifErr) {
    console.error("[dmarc] notification error:", notifErr instanceof Error ? notifErr.message : String(notifErr));
  }
}
