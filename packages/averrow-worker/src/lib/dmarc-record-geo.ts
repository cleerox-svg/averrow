/**
 * Cartographer Phase 4 — geo-enrich DMARC report source IPs (up to 10 per
 * cycle). Extracted from agents/cartographer.ts so it can be tested; the
 * budget gate and error handling stay in Cartographer.
 *
 * The read (`DISTINCT source_ip … WHERE country_code IS NULL LIMIT 10`)
 * rides the partial index idx_drr_geo_pending (migration 0329). Every IP it
 * returns must LEAVE that queue, or ten junk IPs pin the LIMIT 10 slots
 * forever:
 *   resolved          country_code / org / asn / lat / lng from ipinfo
 *   not geolocatable  'PRIV' — private, bogon, CGNAT, documentation and
 *                     benchmarking ranges and IPv6 (isReservedForGeo; the
 *                     'PRIV' sentinel this phase already used for private IPs)
 *   lookup failed     'XX' — the platform's unknown-country sentinel
 *                     (cube-healer / observatory treat 'XX' as "no country")
 * An IP that was not attempted (monthly ipinfo budget spent, per-cycle cap)
 * stays queued for the next cycle. Caveat: batchGeoLookup stops on HTTP 429
 * and does not say which IP hit it, so that one IP is marked 'XX'.
 */

import type { Env } from "../types";
import { batchGeoLookup } from "./geoip";
import { isReservedForGeo } from "./dmarc-source-rollup";

export const DMARC_GEO_QUEUE_SQL = `
        SELECT DISTINCT source_ip FROM dmarc_report_records
        WHERE country_code IS NULL AND source_ip IS NOT NULL
        LIMIT 10
      `;

export interface DmarcRecordGeoResult {
  enriched: number;
  reserved: number;
  failed: number;
}

export async function geoEnrichDmarcRecords(env: Env): Promise<DmarcRecordGeoResult> {
  const out: DmarcRecordGeoResult = { enriched: 0, reserved: 0, failed: 0 };
  const queued = await env.DB.prepare(DMARC_GEO_QUEUE_SQL).all<{ source_ip: string }>();
  const ips = (queued.results ?? []).map((r) => r.source_ip);
  if (ips.length === 0) return out;

  const lookup = ips.filter((ip) => !isReservedForGeo(ip));
  const { results: geoMap, attempted } = await batchGeoLookup(lookup, env.CACHE, env.IPINFO_TOKEN);

  for (const [ip, geo] of geoMap.entries()) {
    await env.DB.prepare(`
            UPDATE dmarc_report_records
            SET country_code = ?, org = ?, asn = ?, lat = ?, lng = ?
            WHERE source_ip = ? AND country_code IS NULL
          `).bind(geo.countryCode ?? "XX", geo.org, geo.as, geo.lat, geo.lng, ip).run();
    out.enriched++;
  }
  const mark = async (ip: string, code: "PRIV" | "XX"): Promise<void> => {
    await env.DB.prepare(
      "UPDATE dmarc_report_records SET country_code = ? WHERE source_ip = ? AND country_code IS NULL",
    ).bind(code, ip).run();
  };
  for (const ip of ips) {
    if (isReservedForGeo(ip)) {
      await mark(ip, "PRIV");
      out.reserved++;
    } else if (attempted.has(ip) && !geoMap.has(ip)) {
      await mark(ip, "XX");
      out.failed++;
    }
  }
  return out;
}
