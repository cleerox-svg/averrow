/**
 * RDAP Domain Age Enricher — Free, no API key required.
 *
 * Uses rdap.org (ICANN RDAP registry aggregator) to look up domain registration
 * dates. Flags domains registered < 30 days as suspicious (strong phishing signal).
 *
 * Rate limit: ~200ms between requests. Batch size: 100.
 */

import type { Env } from "../types";
import type { EnrichmentResult } from "./types";

const BATCH_SIZE = 100;
const RATE_LIMIT_MS = 200;
const SUSPICIOUS_AGE_DAYS = 30;

interface RdapResponse {
  events?: Array<{ eventAction: string; eventDate: string }>;
  entities?: Array<{
    roles?: string[];
    vcardArray?: unknown[];
  }>;
}

export async function enrichRdap(db: D1Database, _env: Env): Promise<EnrichmentResult> {
  const rows = await db.prepare(
    `SELECT id, domain, metadata FROM threats
     WHERE domain IS NOT NULL
       AND json_extract(metadata, '$.rdap_checked') IS NULL
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(BATCH_SIZE).all<{ id: string; domain: string; metadata: string }>();

  if (rows.results.length === 0) return { enriched: 0, skipped: 0, errors: 0 };

  let enriched = 0, skipped = 0, errors = 0;

  for (const row of rows.results) {
    try {
      const apexDomain = getApexDomain(row.domain);
      const rdapData = await fetchRdap(apexDomain);

      if (!rdapData) {
        await markChecked(db, row.id, row.metadata, { rdap_checked: true });
        skipped++;
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const registrationDate = rdapData.events?.find(
        e => e.eventAction === "registration"
      )?.eventDate ?? null;

      const ageDays = registrationDate
        ? Math.floor((Date.now() - new Date(registrationDate).getTime()) / 86_400_000)
        : null;

      const registrar = extractRegistrar(rdapData);
      const isSuspicious = ageDays !== null && ageDays < SUSPICIOUS_AGE_DAYS;

      const meta = safeParseJson<Record<string, unknown>>(row.metadata, {});
      const updatedMeta = {
        ...meta,
        rdap_checked: true,
        rdap_registration_date: registrationDate,
        rdap_age_days: ageDays,
        rdap_registrar: registrar,
        rdap_suspicious_new: isSuspicious,
      };

      // Escalate confidence for very new domains used in phishing/malware
      const confidenceBoost = isSuspicious ? ", confidence = MIN(confidence + 0.15, 0.99)" : "";

      await db.prepare(
        `UPDATE threats SET
           metadata = ?
           ${confidenceBoost},
           updated_at = datetime('now')
         WHERE id = ?`
      ).bind(JSON.stringify(updatedMeta), row.id).run();

      enriched++;
    } catch (err) {
      console.error(`[rdap] error for ${row.domain}:`, err);
      errors++;
    }

    await sleep(RATE_LIMIT_MS);
  }

  return { enriched, skipped, errors };
}

async function fetchRdap(domain: string): Promise<RdapResponse | null> {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: AbortSignal.timeout(30_000), headers: { Accept: "application/rdap+json" },
    });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) return null;
    return await res.json() as RdapResponse;
  } catch {
    return null;
  }
}

/** Extract registrar name from RDAP entity list */
function extractRegistrar(data: RdapResponse): string | null {
  const registrarEntity = data.entities?.find(e => e.roles?.includes("registrar"));
  if (!registrarEntity) return null;

  // vcardArray format: [["vcard", [["fn", {}, "text", "Registrar Name"], ...]]]
  const vcard = registrarEntity.vcardArray as [string, Array<[string, unknown, string, string]>] | undefined;
  if (!vcard?.[1]) return null;

  const fn = (vcard[1] as Array<[string, unknown, string, string]>).find(entry => entry[0] === "fn");
  return fn?.[3] ?? null;
}

/** Extract apex/registrable domain. Strips subdomains using last-2-labels heuristic. */
function getApexDomain(domain: string): string {
  const parts = domain.split(".");
  if (parts.length <= 2) return domain;
  // Handle common 2-level TLDs: co.uk, com.au, org.uk, etc.
  const sld = parts[parts.length - 2] ?? "";
  const knownSlds = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "ltd", "plc"]);
  if (sld.length > 0 && sld.length <= 3 && knownSlds.has(sld)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

async function markChecked(
  db: D1Database,
  id: string,
  existingMeta: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const meta = safeParseJson<Record<string, unknown>>(existingMeta, {});
  await db.prepare(
    `UPDATE threats SET metadata = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(JSON.stringify({ ...meta, ...extra }), id).run();
}

function safeParseJson<T>(str: string, fallback: T): T {
  try { return JSON.parse(str) as T; } catch { return fallback; }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
