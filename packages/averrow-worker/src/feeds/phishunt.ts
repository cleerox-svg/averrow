import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId64, extractDomain } from "./types";
import { bulkInsertThreats } from "../lib/feedRunner";
import { readCappedText } from "../lib/capped-body";

/**
 * phishunt.io — brand-labelled phishing URLs (structured JSON feed).
 *
 * Source: https://phishunt.io/feed.json (verified 2026-11-15: HTTP 200,
 * ~850 KB, ~690 records, regenerated hourly, edge-cached 15 min). Each
 * record is one URL currently considered active, with `url`, `domain`,
 * `company` (targeted brand slug), `ip`, `asn`, `country`, `org`, `cert`,
 * per-source booleans, a phishunt `score` and a `verdict`
 * (critical/high/medium/low/noise). The feed is a rolling window of active
 * detections, so most URLs repeat every pull; dedup is the deterministic
 * per-feed id (`threatId64`) + `INSERT OR IGNORE`, so a re-listed URL is a
 * cheap no-op and `itemsNew` counts only rows actually inserted.
 *
 * Licence: CC0 1.0 on every data output (phishunt.io/tos §7; attribution
 * appreciated, not required). The ToS calls the data "suspicion, not
 * verdict" and forbids publicly asserting a domain is confirmed phishing
 * solely because phishunt lists it — rows land as ordinary feed threats
 * that go through the normal triage/enrichment path. See
 * docs/licences/phishunt.md.
 *
 * Failure handling: HTTP error, a body over MAX_BODY_BYTES, non-JSON, a
 * non-array, an empty array (the window always holds hundreds of active
 * URLs, so empty means an upstream fault), an array where no record has a
 * usable `url`, or a verdict-schema change (zero rows while any record has an
 * unknown verdict, or unknown verdicts on more than half the records) all
 * THROW, so the pull is recorded `failed` and the circuit breaker sees it.
 * `noise` is counted separately and is a deliberate skip, so an all-noise
 * window is an empty success. Nothing is ever marked clean or removed.
 */

/** Hard cap on the response body. The live feed is ~0.85 MB. */
export const PHISHUNT_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Hard cap on rows inserted per pull (the live window is ~700). */
export const PHISHUNT_MAX_ROWS = 2_000;
const FETCH_TIMEOUT_MS = 45_000;
const MAX_URL_LENGTH = 2_048;

/**
 * phishunt verdict → (severity, confidence). `noise` is skipped: phishunt
 * itself scores it below its detection bar. Peer phishing URL feeds land at
 * high / 80-85 (openphish, phishing_database); phishunt's verdict is a
 * heuristic score, so only its top bands reach that level.
 */
const VERDICT_SCORING: Readonly<Record<string, { severity: "high" | "medium" | "low"; confidence: number }>> = {
  critical: { severity: "high", confidence: 85 },
  high: { severity: "high", confidence: 80 },
  medium: { severity: "medium", confidence: 70 },
  low: { severity: "low", confidence: 55 },
};

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const ASN_RE = /^(?:AS)?(\d{1,10})$/i;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Outcome of mapping one feed.json record. */
export type PhishuntRecordResult =
  | { kind: "row"; row: Omit<ThreatRow, "id"> }
  /** phishunt's own below-the-bar band: a deliberate skip. */
  | { kind: "noise" }
  /** A verdict we don't know, or none at all: a possible upstream schema change. */
  | { kind: "unknown_verdict"; verdict: string | null }
  /** Not an object, no usable http(s) URL, or no host. */
  | { kind: "invalid" };

/** Map one feed.json record to a threat row (without id). */
export function parsePhishuntRecord(rec: unknown): PhishuntRecordResult {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return { kind: "invalid" };
  const r = rec as Record<string, unknown>;
  const url = str(r.url);
  if (!url || url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(url)) return { kind: "invalid" };
  const domain = extractDomain(url);
  if (!domain || !domain.includes(".") || /\s/.test(domain)) return { kind: "invalid" };
  const verdict = str(r.verdict)?.toLowerCase() ?? null;
  if (verdict === "noise") return { kind: "noise" };
  const scoring = verdict === null ? undefined : VERDICT_SCORING[verdict];
  if (!scoring) return { kind: "unknown_verdict", verdict };

  const ip = str(r.ip);
  const asnMatch = str(r.asn)?.match(ASN_RE) ?? null;
  return {
    kind: "row",
    row: {
      source_feed: "phishunt",
      threat_type: "phishing",
      malicious_url: url,
      malicious_domain: domain,
      ioc_value: url,
      ip_address: ip && IPV4_RE.test(ip) ? ip : null,
      asn: asnMatch ? `AS${asnMatch[1]}` : null,
      severity: scoring.severity,
      confidence_score: scoring.confidence,
    },
  };
}

export interface PhishuntParse {
  rows: ThreatRow[];
  noise: number;
  unknownVerdict: number;
  invalid: number;
}

/**
 * Parse the feed body into deduped rows. Throws on a garbled/empty feed and
 * on a verdict-schema change: zero rows while any record carries an unknown
 * verdict, or unknown verdicts on more than half of the records. A window
 * that is all `noise` is a legitimate empty success.
 */
export async function parsePhishuntFeed(text: string): Promise<PhishuntParse> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("phishunt: response is not JSON");
  }
  if (!Array.isArray(body)) throw new Error("phishunt: expected a JSON array");
  if (body.length === 0) throw new Error("phishunt: feed is empty (upstream fault)");

  const seen = new Set<string>();
  const rows: ThreatRow[] = [];
  let noise = 0;
  let unknownVerdict = 0;
  let invalid = 0;
  const unknownSamples = new Set<string>();
  for (const rec of body as unknown[]) {
    const res = parsePhishuntRecord(rec);
    if (res.kind === "noise") { noise++; continue; }
    if (res.kind === "invalid") { invalid++; continue; }
    if (res.kind === "unknown_verdict") {
      unknownVerdict++;
      if (unknownSamples.size < 5) unknownSamples.add(res.verdict ?? "<missing>");
      continue;
    }
    const url = res.row.malicious_url as string;
    if (seen.has(url)) continue;
    seen.add(url);
    if (rows.length >= PHISHUNT_MAX_ROWS) continue;
    rows.push({ ...res.row, id: await threatId64("phishunt", "url", url) });
  }
  const total = body.length;
  // Nothing had a usable URL: a format change.
  if (rows.length === 0 && noise === 0 && unknownVerdict === 0) {
    throw new Error(`phishunt: no usable records in ${total} entries (format change?)`);
  }
  if (unknownVerdict > 0 && (rows.length === 0 || unknownVerdict * 2 > total)) {
    throw new Error(
      `phishunt: ${unknownVerdict}/${total} records carry an unknown verdict ` +
        `(${[...unknownSamples].join(", ")}): verdict schema changed?`,
    );
  }
  return { rows, noise, unknownVerdict, invalid };
}

export const phishunt: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const url = ctx.feedUrl?.trim() || "https://phishunt.io/feed.json";
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`phishunt HTTP ${res.status}`);
    const text = await readCappedText(res, PHISHUNT_MAX_BODY_BYTES);
    if (text === null) throw new Error(`phishunt: body larger than ${PHISHUNT_MAX_BODY_BYTES} bytes`);

    const { rows, unknownVerdict } = await parsePhishuntFeed(text);
    const { itemsNew, itemsDuplicate, itemsError } = await bulkInsertThreats(ctx.env.DB, rows);
    const result: FeedResult = { itemsFetched: rows.length, itemsNew, itemsDuplicate, itemsError };
    if (unknownVerdict > 0) result.warning = `phishunt: ${unknownVerdict} record(s) with an unknown verdict skipped`;
    return result;
  },
};
