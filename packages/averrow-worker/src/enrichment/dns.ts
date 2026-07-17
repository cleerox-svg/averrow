/**
 * DNS Validation Enricher — Free, uses Cloudflare DNS-over-HTTPS.
 *
 * Checks per domain:
 *   - A record  → does the domain resolve to an IP?
 *   - MX record → does it have mail exchange records?
 *   - SPF (TXT) → v=spf1 present?
 *   - DMARC (TXT on _dmarc.*) → DMARC policy present?
 *
 * Legitimate infrastructure domains generally have all four.
 * Missing A record (NXDOMAIN) or missing SPF/DMARC on a phishing domain
 * raises confidence. Batch size: 200, processed in parallel groups of 20.
 */

import type { Env } from "../types";
import type { EnrichmentResult } from "./types";

const BATCH_SIZE = 200;
const PARALLEL_GROUP = 20; // concurrent DoH requests per domain set
const DOH_BASE = "https://cloudflare-dns.com/dns-query";

interface DoHResponse {
  Status: number; // 0 = NOERROR, 3 = NXDOMAIN
  Answer?: Array<{ type: number; data: string }>;
}

interface DnsProfile {
  resolves: boolean;
  has_mx: boolean;
  has_spf: boolean;
  has_dmarc: boolean;
}

export async function enrichDns(db: D1Database, _env: Env): Promise<EnrichmentResult> {
  const rows = await db.prepare(
    `SELECT id, domain, metadata FROM threats
     WHERE domain IS NOT NULL
       AND json_extract(metadata, '$.dns_checked') IS NULL
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(BATCH_SIZE).all<{ id: string; domain: string; metadata: string }>();

  if (rows.results.length === 0) return { enriched: 0, skipped: 0, errors: 0 };

  let enriched = 0, errors = 0;

  // Process in parallel groups to stay polite while keeping throughput high
  for (let i = 0; i < rows.results.length; i += PARALLEL_GROUP) {
    const group = rows.results.slice(i, i + PARALLEL_GROUP);

    await Promise.allSettled(
      group.map(async (row) => {
        try {
          const profile = await queryDnsProfile(row.domain);

          const meta = safeParseJson<Record<string, unknown>>(row.metadata, {});

          // Boost confidence for domains with no A record (NXDOMAIN phishing domains
          // often get taken down but still appear in feeds) or no SPF/DMARC
          const suspiciousDns = !profile.resolves || (!profile.has_spf && !profile.has_dmarc);
          const confidenceBoost = suspiciousDns
            ? ", confidence = MIN(confidence + 0.10, 0.99)"
            : "";

          await db.prepare(
            `UPDATE threats SET
               metadata = ?
               ${confidenceBoost},
               updated_at = datetime('now')
             WHERE id = ?`
          ).bind(
            JSON.stringify({
              ...meta,
              dns_checked: true,
              dns_resolves: profile.resolves,
              dns_has_mx: profile.has_mx,
              dns_has_spf: profile.has_spf,
              dns_has_dmarc: profile.has_dmarc,
            }),
            row.id,
          ).run();

          enriched++;
        } catch (err) {
          console.error(`[dns] error for ${row.domain}:`, err);
          errors++;
        }
      })
    );
  }

  return { enriched, skipped: 0, errors };
}

async function queryDnsProfile(domain: string): Promise<DnsProfile> {
  const [aRes, mxRes, txtRes, dmarcRes] = await Promise.allSettled([
    dohQuery(domain, "A"),
    dohQuery(domain, "MX"),
    dohQuery(domain, "TXT"),
    dohQuery(`_dmarc.${domain}`, "TXT"),
  ]);

  const a = aRes.status === "fulfilled" ? aRes.value : null;
  const mx = mxRes.status === "fulfilled" ? mxRes.value : null;
  const txt = txtRes.status === "fulfilled" ? txtRes.value : null;
  const dmarc = dmarcRes.status === "fulfilled" ? dmarcRes.value : null;

  const resolves = a !== null && a.Status === 0 && (a.Answer?.length ?? 0) > 0;
  const has_mx = mx !== null && mx.Status === 0 && (mx.Answer?.length ?? 0) > 0;

  const txtRecords = txt?.Answer?.map(r => r.data.replace(/"/g, "")) ?? [];
  const has_spf = txtRecords.some(r => r.startsWith("v=spf1"));

  const dmarcRecords = dmarc?.Answer?.map(r => r.data.replace(/"/g, "")) ?? [];
  const has_dmarc = dmarcRecords.some(r => r.startsWith("v=DMARC1"));

  return { resolves, has_mx, has_spf, has_dmarc };
}

async function dohQuery(name: string, type: string): Promise<DoHResponse | null> {
  try {
    const url = `${DOH_BASE}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000), headers: { Accept: "application/dns-json" },
    });
    if (!res.ok) return null;
    return await res.json() as DoHResponse;
  } catch {
    return null;
  }
}

function safeParseJson<T>(str: string, fallback: T): T {
  try { return JSON.parse(str) as T; } catch { return fallback; }
}
