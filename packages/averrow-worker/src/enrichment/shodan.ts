/**
 * Shodan InternetDB Enricher — Free, no API key required.
 *
 * Endpoint: https://internetdb.shodan.io/{ip}
 * Returns: open ports, known CVEs, CPEs, hostnames per IP.
 * Rate limit: ~1 req/second. Batch size kept at 30 for safety.
 * Results cached in KV for 24 hours to avoid re-querying the same IP.
 */

import type { Env } from "../types";
import type { EnrichmentResult } from "./types";

const BATCH_SIZE = 30;
const RATE_LIMIT_MS = 1100;
const CACHE_TTL = 24 * 60 * 60; // 24h
const CACHE_PREFIX = "shodan:";

interface ShodanResult {
  ip: string;
  ports: number[];
  cpes: string[];
  hostnames: string[];
  tags: string[];
  vulns: string[];
}

export async function enrichShodan(db: D1Database, env: Env): Promise<EnrichmentResult> {
  const rows = await db.prepare(
    `SELECT id, ip_address, severity, tags, metadata FROM threats
     WHERE ip_address IS NOT NULL
       AND json_extract(metadata, '$.shodan_checked') IS NULL
     LIMIT ?`
  ).bind(BATCH_SIZE).all<{ id: string; ip_address: string; severity: string; tags: string; metadata: string }>();

  const total = rows.results.length;
  if (total === 0) return { enriched: 0, skipped: 0, errors: 0 };

  let enriched = 0, skipped = 0, errors = 0;

  for (const row of rows.results) {
    let liveFetch = false;
    try {
      const cacheKey = CACHE_PREFIX + row.ip_address;
      let data: ShodanResult | null = null;

      // Check KV cache first
      const cached = await env.CACHE.get(cacheKey);
      if (cached) {
        data = JSON.parse(cached) as ShodanResult;
      } else {
        liveFetch = true;
        const res = await fetch(`https://internetdb.shodan.io/${row.ip_address}`, { signal: AbortSignal.timeout(30_000) });
        if (res.status === 404) {
          // IP not indexed — mark as checked so we don't retry
          await markChecked(db, row.id, row.metadata, { shodan_checked: true, shodan_indexed: false });
          await env.CACHE.put(cacheKey, JSON.stringify(null), { expirationTtl: CACHE_TTL });
          skipped++;
          await sleep(RATE_LIMIT_MS);
          continue;
        }
        if (!res.ok) { errors++; await sleep(RATE_LIMIT_MS); continue; }

        data = await res.json() as ShodanResult;
        await env.CACHE.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL });
      }

      if (!data) { skipped++; continue; }

      const hasCves = data.vulns && data.vulns.length > 0;
      const currentTags: string[] = safeParseJson(row.tags, []);
      const newTags = hasCves && !currentTags.includes("has-cves")
        ? [...currentTags, "has-cves"]
        : currentTags;

      // Escalate severity if IP has known CVEs and is currently low/medium
      const escalate = hasCves && (row.severity === "low" || row.severity === "medium");

      const meta = safeParseJson<Record<string, unknown>>(row.metadata, {});
      const updatedMeta = {
        ...meta,
        shodan_checked: true,
        shodan_indexed: true,
        shodan_ports: data.ports,
        shodan_vulns: data.vulns,
        shodan_hostnames: data.hostnames,
        shodan_cpes: data.cpes,
      };

      await db.prepare(
        `UPDATE threats SET
           metadata = ?,
           tags = ?,
           ${escalate ? "severity = 'high'," : ""}
           updated_at = datetime('now')
         WHERE id = ?`
      ).bind(JSON.stringify(updatedMeta), JSON.stringify(newTags), row.id).run();

      enriched++;
    } catch (err) {
      console.error(`[shodan] error for ${row.ip_address}:`, err);
      errors++;
    }

    if (liveFetch) await sleep(RATE_LIMIT_MS);
  }

  return { enriched, skipped, errors };
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
