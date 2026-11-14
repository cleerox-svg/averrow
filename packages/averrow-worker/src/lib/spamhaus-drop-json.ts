/**
 * Parsers for the Spamhaus DROP JSON files (drop_v4.json, asndrop.json).
 *
 * Wire format (verified against the live files 2026-11-14): NDJSON — one
 * JSON object per line, then ONE trailing metadata line:
 *
 *   {"cidr":"1.10.16.0/20","sblid":"SBL256894","rir":"apnic"}
 *   {"asn":245,"rir":"arin","domain":"planningresearchcorp.com","cc":"US","asname":"PRC-AS"}
 *   {"type":"metadata","timestamp":1794634004,"size":107327,"records":1759,
 *    "copyright":"(c) 2026 The Spamhaus Project SLU","terms":"https://www.spamhaus.org/drop/terms/"}
 *
 * Spamhaus terms: free for any business with credit to The Spamhaus
 * Project, and "the date and © text should remain with the file and
 * data" — so the metadata line is parsed and carried to storage.
 *
 * Parsing is defensive: a line that is not JSON, not an object, or lacks
 * the required fields is counted in `malformed` and skipped. Callers decide
 * whether a pull with zero records is a failure (both feeds treat it as one).
 */

import { asnKey } from "./shared-infra-asns";

export interface SpamhausDropMetadata {
  /** Unix seconds — the list's generation time. */
  timestamp: number | null;
  /** Record count the list claims to hold (excludes the metadata line). */
  records: number | null;
  /** Copyright line, e.g. "(c) 2026 The Spamhaus Project SLU". */
  copyright: string | null;
  terms: string | null;
}

export interface ParsedNdjson<T> {
  records: T[];
  metadata: SpamhausDropMetadata | null;
  /** Non-empty lines that could not be parsed into a record or metadata. */
  malformed: number;
}

export interface DropCidrRecord {
  cidr: string;
  sblId: string | null;
}

export interface AsnDropRecord {
  /** Canonical `AS<digits>` key (lib/shared-infra-asns.ts asnKey). */
  asn: string;
  asnNumber: number;
  asName: string | null;
  asDomain: string | null;
  countryCode: string | null;
  rir: string | null;
}

const IPV4_CIDR_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
const SBL_RE = /^SBL\d+$/i;
const MAX_TEXT = 200;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = MAX_TEXT): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseMetadata(o: Record<string, unknown>): SpamhausDropMetadata {
  return {
    timestamp: num(o["timestamp"]),
    records: num(o["records"]),
    copyright: str(o["copyright"]),
    terms: str(o["terms"]),
  };
}

function parseNdjson<T>(
  text: string,
  toRecord: (o: Record<string, unknown>) => T | null,
): ParsedNdjson<T> {
  const records: T[] = [];
  let metadata: SpamhausDropMetadata | null = null;
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: unknown;
    try {
      o = JSON.parse(trimmed);
    } catch {
      malformed++;
      continue;
    }
    if (!isObject(o)) {
      malformed++;
      continue;
    }
    if (o["type"] === "metadata") {
      metadata = parseMetadata(o);
      continue;
    }
    const rec = toRecord(o);
    if (rec === null) malformed++;
    else records.push(rec);
  }
  return { records, metadata, malformed };
}

/** drop_v4.json → IPv4 CIDR records (same acceptance rule as the old drop.txt parser). */
export function parseDropV4Json(text: string): ParsedNdjson<DropCidrRecord> {
  return parseNdjson(text, (o) => {
    const cidr = str(o["cidr"]);
    if (!cidr || !IPV4_CIDR_RE.test(cidr)) return null;
    const sbl = str(o["sblid"]);
    return { cidr, sblId: sbl && SBL_RE.test(sbl) ? sbl : null };
  });
}

/** asndrop.json → ASN records keyed by the platform's canonical asnKey. */
export function parseAsnDropJson(text: string): ParsedNdjson<AsnDropRecord> {
  return parseNdjson(text, (o) => {
    const raw = o["asn"];
    if (typeof raw !== "number" && typeof raw !== "string") return null;
    const key = asnKey(raw);
    if (!key) return null;
    const asnNumber = Number(key.slice(2));
    if (!Number.isSafeInteger(asnNumber) || asnNumber <= 0 || asnNumber > 4294967295) return null;
    const cc = str(o["cc"], 8);
    return {
      asn: key,
      asnNumber,
      asName: str(o["asname"]),
      asDomain: str(o["domain"]),
      countryCode: cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null,
      rir: str(o["rir"], 16),
    };
  });
}

/** Dedupe by a key, keeping the first occurrence. */
export function dedupeBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/** "Spamhaus DROP List 2026-11-14 - (c) 2026 The Spamhaus Project SLU" style credit, for storage next to the data. */
export function spamhausCreditLine(list: string, meta: SpamhausDropMetadata | null): string {
  const date = meta?.timestamp ? new Date(meta.timestamp * 1000).toISOString().slice(0, 10) : "date unknown";
  const copyright = meta?.copyright ?? "(c) The Spamhaus Project SLU";
  return `Spamhaus ${list} ${date} - ${copyright}`;
}
