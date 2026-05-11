/**
 * DMARC Aggregate Report Receiver
 *
 * Processes DMARC aggregate reports delivered via Cloudflare Email Routing.
 * Reports arrive as RFC 822 emails with XML attachments (ZIP or GZIP compressed).
 *
 * Implements RFC 7489 aggregate report parsing with no external npm packages.
 * Uses DecompressionStream for ZIP (deflate-raw) and GZIP decompression.
 *
 * Critical: never call setReject() — Google/Microsoft stop sending on bounces.
 */

import type { Env } from "./types";
import { createNotification } from "./lib/notifications";

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

// ─── Internal types ───────────────────────────────────────────────

interface DmarcRecord {
  source_ip: string;
  message_count: number;
  disposition: string;
  dkim_result: string;
  spf_result: string;
  header_from: string;
  envelope_from: string;
  envelope_to: string;
}

interface DmarcReport {
  reporter_org: string;
  reporter_email: string;
  report_id: string;
  date_begin: number;
  date_end: number;
  domain: string;
  dmarc_policy: string;
  records: DmarcRecord[];
}

// ─── Main entry point ─────────────────────────────────────────────

export async function handleDmarcEmail(message: EmailMessage, env: Env): Promise<void> {
  try {
    const rawBytes = await readStream(message.raw);
    const xmlData = await extractXmlFromEmail(rawBytes);

    if (!xmlData) {
      console.warn("[dmarc] No DMARC XML found in email — discarding silently");
      return;
    }

    const report = parseDmarcXml(xmlData);
    if (!report) {
      console.warn("[dmarc] XML parse failed — discarding");
      return;
    }

    await saveDmarcReport(env, report, message.from, xmlData);
  } catch (err) {
    // Never reject/bounce — always accept silently
    console.error("[dmarc] Processing error:", err);
  }
}

// ─── Stream reading ───────────────────────────────────────────────

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  const MAX = 5 * 1024 * 1024; // 5MB cap

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalSize += value.length;
    if (totalSize > MAX) {
      console.warn("[dmarc] Email exceeds 5MB — truncating");
      break;
    }
  }

  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// ─── MIME parsing ─────────────────────────────────────────────────

async function extractXmlFromEmail(rawBytes: Uint8Array): Promise<string | null> {
  const dec = new TextDecoder("utf-8");
  const rawStr = dec.decode(rawBytes);

  // Split headers / body
  const headerEnd = rawStr.indexOf("\r\n\r\n");
  const headerStr = headerEnd >= 0 ? rawStr.slice(0, headerEnd) : rawStr.slice(0, 4096);
  const bodyStartOffset = headerEnd >= 0 ? headerEnd + 4 : 0;

  const ctMatch = headerStr.match(/^Content-Type:\s*([^;\r\n]+)/im);
  const contentType = ctMatch?.[1]?.trim().toLowerCase() ?? "";

  const boundaryMatch = headerStr.match(/boundary=["']?([^"'\r\n;]+)["']?/i);
  const boundary = boundaryMatch?.[1]?.trim() ?? null;

  if (boundary && contentType.startsWith("multipart/")) {
    return parseMultipart(rawBytes, rawStr, bodyStartOffset, boundary);
  }

  // Single-part — try to decompress/decode directly
  const bodyBytes = rawBytes.slice(bodyStartOffset);
  return decompressAndDecode(bodyBytes, contentType, "");
}

async function parseMultipart(
  rawBytes: Uint8Array,
  rawStr: string,
  bodyStart: number,
  boundary: string,
): Promise<string | null> {
  const body = rawStr.slice(bodyStart);
  const delimiter = `--${boundary}`;
  const parts = body.split(delimiter);

  for (const part of parts) {
    if (!part || part.startsWith("--")) continue; // preamble / epilogue

    const partSep = part.indexOf("\r\n\r\n");
    if (partSep < 0) continue;

    const partHeaders = part.slice(0, partSep);
    const partBodyStr = part.slice(partSep + 4);

    const ctM = partHeaders.match(/^Content-Type:\s*([^;\r\n]+)/im);
    const partCt = ctM?.[1]?.trim().toLowerCase() ?? "";

    const encM = partHeaders.match(/^Content-Transfer-Encoding:\s*(\S+)/im);
    const encoding = encM?.[1]?.trim().toLowerCase() ?? "";

    const cdM = partHeaders.match(/^Content-Disposition:[^\r\n]*/im);
    const cd = cdM?.[0]?.toLowerCase() ?? "";
    const fnM = cd.match(/filename[*]?=["']?([^"';\r\n]+)["']?/i);
    const filename = fnM?.[1]?.toLowerCase().replace(/['"]/g, "") ?? "";

    // Skip text-only parts
    if (partCt.startsWith("text/plain") || partCt.startsWith("text/html")) continue;

    const looksLikeDmarc =
      filename.includes("dmarc") ||
      filename.endsWith(".xml") ||
      filename.endsWith(".xml.gz") ||
      filename.endsWith(".xml.zip") ||
      filename.endsWith(".zip") ||
      filename.endsWith(".gz") ||
      partCt.includes("xml") ||
      partCt.includes("zip") ||
      partCt.includes("gzip") ||
      (partCt.includes("octet-stream") && (cd.includes("attachment") || filename !== ""));

    if (!looksLikeDmarc) continue;

    let partBytes: Uint8Array;
    if (encoding === "base64") {
      partBytes = base64Decode(partBodyStr.replace(/\s+/g, ""));
    } else {
      partBytes = new TextEncoder().encode(partBodyStr);
    }

    const xml = await decompressAndDecode(partBytes, partCt, filename);
    if (xml && (xml.includes("<feedback>") || xml.includes("<?xml"))) {
      return xml;
    }
  }

  return null;
}

async function decompressAndDecode(
  bytes: Uint8Array,
  _contentType: string,
  _hint: string,
): Promise<string | null> {
  if (bytes.length === 0) return null;

  try {
    // ZIP: PK\x03\x04
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      const out = await decompressZip(bytes);
      if (out) return new TextDecoder().decode(out);
    }

    // GZIP: 1F 8B
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const out = await streamDecompress(bytes, "gzip");
      if (out) return new TextDecoder().decode(out);
    }

    // Try raw UTF-8
    const str = new TextDecoder("utf-8").decode(bytes);
    if (str.trimStart().startsWith("<?xml") || str.includes("<feedback>")) return str;
  } catch (err) {
    console.error("[dmarc] decompressAndDecode error:", err);
  }

  return null;
}

// ─── ZIP decompression (manual local file header parsing) ────────

async function decompressZip(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    // ZIP Local File Header layout (little-endian):
    // 0x00  4  Signature (PK\x03\x04)
    // 0x04  2  Version needed
    // 0x06  2  General purpose bit flag
    // 0x08  2  Compression method (8=deflate, 0=stored)
    // 0x0a  2  Last mod time
    // 0x0c  2  Last mod date
    // 0x0e  4  CRC-32
    // 0x12  4  Compressed size
    // 0x16  4  Uncompressed size
    // 0x1a  2  File name length
    // 0x1c  2  Extra field length
    // 0x1e  N  File name
    // 0x1e+N M  Extra field
    // [data starts here]

    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const compressionMethod = v.getUint16(8, true);
    const compressedSize = v.getUint32(18, true);
    const fileNameLen = v.getUint16(26, true);
    const extraLen = v.getUint16(28, true);
    const dataOffset = 30 + fileNameLen + extraLen;

    if (dataOffset >= bytes.length) {
      console.error("[dmarc] ZIP: dataOffset beyond file");
      return null;
    }

    const dataLen = compressedSize > 0 ? compressedSize : bytes.length - dataOffset;
    const compressed = bytes.slice(dataOffset, dataOffset + dataLen);

    if (compressionMethod === 0) return compressed; // stored
    if (compressionMethod === 8) return streamDecompress(compressed, "deflate-raw");

    console.warn(`[dmarc] ZIP: unsupported compression method ${compressionMethod}`);
    return null;
  } catch (err) {
    console.error("[dmarc] ZIP parse error:", err);
    return null;
  }
}

async function streamDecompress(
  bytes: Uint8Array,
  format: "deflate-raw" | "gzip" | "deflate",
): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(bytes as BufferSource).catch(() => {});
    writer.close().catch(() => {});

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalSize += value.length;
      if (totalSize > 10 * 1024 * 1024) {
        console.warn("[dmarc] Decompressed data > 10MB — aborting");
        return null;
      }
    }

    const out = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  } catch (err) {
    console.error(`[dmarc] streamDecompress(${format}) error:`, err);
    return null;
  }
}

// ─── Base64 decode ────────────────────────────────────────────────

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── RFC 7489 XML parsing (regex-based, no DOM) ───────────────────

function xmlTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1]?.trim() ?? "";
}

function xmlTagAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1];
    if (val !== undefined) out.push(val.trim());
  }
  return out;
}

function parseDmarcXml(xml: string): DmarcReport | null {
  try {
    const metadata = xmlTag(xml, "report_metadata");
    if (!metadata) {
      console.warn("[dmarc] No report_metadata in XML");
      return null;
    }

    const policy = xmlTag(xml, "policy_published");
    const dateRange = xmlTag(metadata, "date_range");

    const reporter_org = xmlTag(metadata, "org_name");
    const reporter_email = xmlTag(metadata, "email");
    const report_id = xmlTag(metadata, "report_id");
    const date_begin = parseInt(xmlTag(dateRange, "begin"), 10) || 0;
    const date_end = parseInt(xmlTag(dateRange, "end"), 10) || 0;
    const domain = xmlTag(policy, "domain");
    const dmarc_policy = xmlTag(policy, "p");

    const recordXmls = xmlTagAll(xml, "record");
    const records: DmarcRecord[] = [];

    for (const rec of recordXmls) {
      const row = xmlTag(rec, "row");
      const ids = xmlTag(rec, "identifiers");
      const pe = xmlTag(row, "policy_evaluated");

      const source_ip = xmlTag(row, "source_ip");
      if (!source_ip) continue;

      records.push({
        source_ip,
        message_count: parseInt(xmlTag(row, "count"), 10) || 0,
        disposition: xmlTag(pe, "disposition"),
        dkim_result: xmlTag(pe, "dkim"),
        spf_result: xmlTag(pe, "spf"),
        header_from: xmlTag(ids, "header_from"),
        envelope_from: xmlTag(ids, "envelope_from") || xmlTag(ids, "envelope-from"),
        envelope_to: xmlTag(ids, "envelope_to") || xmlTag(ids, "envelope-to"),
      });
    }

    if (!domain) {
      console.warn("[dmarc] No domain in policy_published — discarding");
      return null;
    }

    return { reporter_org, reporter_email, report_id, date_begin, date_end, domain, dmarc_policy, records };
  } catch (err) {
    console.error("[dmarc] parseDmarcXml error:", err);
    return null;
  }
}

// ─── D1 persistence ───────────────────────────────────────────────

async function saveDmarcReport(
  env: Env,
  report: DmarcReport,
  senderEmail: string,
  rawXml: string,
): Promise<void> {
  // Helper local for the existing db-flavored statements below.
  const db = env.DB;
  // Match brand by canonical_domain or name
  const brand = await db
    .prepare(
      `SELECT id FROM brands
       WHERE canonical_domain = ?1
          OR canonical_domain = ?2
          OR LOWER(name) = ?1
       LIMIT 1`,
    )
    .bind(report.domain, report.domain.replace(/^www\./, ""))
    .first<{ id: number }>();

  const brandId = brand?.id ?? null;
  const reportId = crypto.randomUUID();

  // Compute totals
  let passCount = 0;
  let failCount = 0;
  for (const r of report.records) {
    if (r.dkim_result === "pass" && r.spf_result === "pass") {
      passCount += r.message_count;
    } else {
      failCount += r.message_count;
    }
  }
  const emailCount = passCount + failCount;

  // Cap raw XML at 50KB
  const cappedXml = rawXml.length > 50000 ? rawXml.slice(0, 50000) + "…[truncated]" : rawXml;

  await db
    .prepare(
      `INSERT INTO dmarc_reports
         (id, brand_id, domain, reporter_org, reporter_email, date_begin, date_end,
          email_count, pass_count, fail_count, dmarc_policy, raw_xml, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      reportId, brandId, report.domain, report.reporter_org, senderEmail,
      report.date_begin, report.date_end, emailCount, passCount, failCount,
      report.dmarc_policy, cappedXml,
    )
    .run();

  // Insert records in D1 batches of 50
  const BATCH = 50;
  for (let i = 0; i < report.records.length; i += BATCH) {
    const stmts = report.records.slice(i, i + BATCH).map((r) =>
      db
        .prepare(
          `INSERT INTO dmarc_report_records
             (id, report_id, source_ip, message_count, disposition,
              dkim_result, spf_result, header_from, envelope_from, envelope_to)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(), reportId, r.source_ip, r.message_count,
          r.disposition, r.dkim_result, r.spf_result,
          r.header_from, r.envelope_from, r.envelope_to,
        ),
    );
    await db.batch(stmts);
  }

  // Upsert daily stats
  const reportDate =
    report.date_end > 0
      ? new Date(report.date_end * 1000).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

  const uniqueSources = new Set(report.records.map((r) => r.source_ip)).size;

  const failingByIp = new Map<string, number>();
  for (const r of report.records) {
    if (r.dkim_result !== "pass" || r.spf_result !== "pass") {
      failingByIp.set(r.source_ip, (failingByIp.get(r.source_ip) ?? 0) + r.message_count);
    }
  }
  const topFailing = [...failingByIp.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ip, count]) => ({ ip, count }));

  await db
    .prepare(
      `INSERT INTO dmarc_daily_stats
         (id, domain, date, email_count, pass_count, fail_count, unique_sources, top_failing_ips)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain, date) DO UPDATE SET
         email_count    = email_count    + excluded.email_count,
         pass_count     = pass_count     + excluded.pass_count,
         fail_count     = fail_count     + excluded.fail_count,
         unique_sources = excluded.unique_sources,
         top_failing_ips = excluded.top_failing_ips`,
    )
    .bind(
      crypto.randomUUID(), report.domain, reportDate,
      emailCount, passCount, failCount, uniqueSources,
      JSON.stringify(topFailing),
    )
    .run();

  // Notify on notable failure rate (>10% with ≥100 emails)
  if (brandId && failCount > 0 && emailCount >= 100) {
    const failRate = failCount / emailCount;
    if (failRate > 0.1) {
      const failPct = Math.round(failRate * 100);
      try {
        await createNotification(env, {
          type: "brand_threat",
          severity: failRate > 0.5 ? "critical" : "high",
          title: `DMARC failures detected for ${report.domain}`,
          message: `${failPct}% of ${emailCount.toLocaleString()} emails failed DMARC — reported by ${report.reporter_org}`,
          // Deep-link to the brand's detail page. v3 BrandDetail's
          // default 'Surface' tab renders EmailPostureCard with
          // SPF/DKIM/DMARC/BIMI/VMC breakdown — exactly where the
          // operator wants to land when reading this notification.
          link: `/brands/${brandId}`,
          metadata: { brand_id: String(brandId), domain: report.domain },
        });
      } catch (notifErr) {
        console.error("[dmarc] notification error:", notifErr);
      }
    }
  }
}
