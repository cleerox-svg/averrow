import type { FeedModule, FeedContext, FeedResult } from "./types";
import type { Env } from "../types";
import { logger } from "../lib/logger";
import { withIndexHintFallback } from "../lib/indexed-by-fallback";
import { SURBL_WORK_SELECT_SQL } from "../lib/threat-rescan-predicates";
import { DnsblLookupError, dohLookupA, dnsblRunShouldFail, type DohAnswer } from "../lib/dnsbl-doh";

/**
 * SURBL — DNS-based domain reputation checks.
 *
 * Two modes:
 * A) Bulk enrichment (runs on cron via ingest()): queries recent threats for
 *    unchecked domains and validates them against multi.surbl.org via DNS-over-HTTPS.
 * B) Inline enrichment (exported checkSURBL function): other feeds call this
 *    after inserting a threat for immediate validation.
 *
 * SURBL bitmask decode:
 *   8  = PH (phishing)
 *   16 = MW (malware)
 *   64 = ABUSE (abused/redirector)
 *
 * Rate limit: max 50 DNS lookups per cron run (SURBL fair use).
 * Results cached in KV with 24h TTL to avoid repeat lookups.
 *
 * Lookup errors are never "clean" (lib/dnsbl-doh.ts): SERVFAIL/REFUSED,
 * SURBL's 127.0.0.1 "blocked" answer and transport failures leave the row
 * surbl_checked = 0. Each run starts with a self-test on SURBL's permanent
 * test point and fails the pull if it is not listed; a refused lookup
 * mid-run, or every lookup erroring, also fails the pull, so the feed
 * circuit breaker backs off and auto-pauses.
 */

export interface SURBLResult {
  listed: boolean;
  types: string[];
  raw: number | null;
}

const SURBL_BITMASK: Record<number, string> = {
  8: "PH",
  16: "MW",
  64: "ABUSE",
};

function decodeSURBLBitmask(lastOctet: number): string[] {
  const types: string[] = [];
  for (const [bit, label] of Object.entries(SURBL_BITMASK)) {
    if (lastOctet & Number(bit)) {
      types.push(label);
    }
  }
  return types;
}

/**
 * SURBL's permanent test point — listed on every SURBL list, forever. Each
 * ingest run resolves it first; if it does not come back listed, the
 * resolver path is blind (e.g. SURBL refuses public resolvers: SERVFAIL
 * "No Reachable Authority", live test 2026-11-14) and the run fails loudly
 * instead of stamping every domain clean.
 */
export const SURBL_TEST_POINT = "surbl-org-permanent-test-point.com";

/**
 * KV cache prefix. `v2`: entries written before 2026-11 could be a refused
 * lookup cached as "clean"; the new prefix never reads them. Only real
 * answers (listed / NXDOMAIN) are cached now — errors throw before put().
 */
const SURBL_CACHE_PREFIX = "surbl:v2:";

/**
 * Inline SURBL check — call from other feeds for immediate domain validation.
 * Results are cached in KV with 24h TTL. Throws `DnsblLookupError` when the
 * lookup failed or was refused; that is never a clean verdict.
 */
export async function checkSURBL(domain: string, env: Env): Promise<SURBLResult> {
  const cacheKey = `${SURBL_CACHE_PREFIX}${domain}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as SURBLResult;
  }

  const result = await dnsLookupSURBL(domain);
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
  return result;
}

/**
 * Decode a SURBL DoH answer. Exported for tests.
 *
 *   NXDOMAIN / empty NOERROR    → not listed
 *   127.0.0.1                   → SURBL "access blocked" → refused error
 *   127.0.0.X (X > 1)           → listed, X is the list bitmask
 *   anything else               → unexpected answer → refused error
 *                                 (e.g. a resolver rewriting NXDOMAIN)
 */
export function decodeSURBLAnswer(domain: string, answer: DohAnswer): SURBLResult {
  if (answer.status === 3 || answer.addresses.length === 0) {
    return { listed: false, types: [], raw: null };
  }
  for (const ip of answer.addresses) {
    if (ip === "127.0.0.1") {
      throw new DnsblLookupError("refused", `SURBL refused the query for ${domain} (127.0.0.1 = access blocked)`);
    }
    if (ip.startsWith("127.0.0.")) {
      const lastOctet = parseInt(ip.split(".")[3] ?? "0", 10);
      return { listed: true, types: decodeSURBLBitmask(lastOctet), raw: lastOctet };
    }
  }
  throw new DnsblLookupError("refused", `SURBL returned an unexpected answer for ${domain}: ${answer.addresses.join(",")}`);
}

async function dnsLookupSURBL(domain: string): Promise<SURBLResult> {
  return decodeSURBLAnswer(domain, await dohLookupA(`${domain}.multi.surbl.org`));
}

/**
 * Resolve the permanent test point (uncached). Throws a plain Error naming
 * the cause when it is not listed, so runFeed records the pull as failed and
 * the circuit breaker backs off / auto-pauses.
 */
export async function assertSURBLResolverWorks(): Promise<void> {
  let result: SURBLResult;
  try {
    result = await dnsLookupSURBL(SURBL_TEST_POINT);
  } catch (err) {
    throw new Error(`SURBL self-test failed: test point lookup errored (${err instanceof Error ? err.message : String(err)}) — lookups are not being answered; no domains checked`);
  }
  if (!result.listed) {
    throw new Error("SURBL self-test failed: permanent test point is not listed — resolver path is blind; no domains checked");
  }
}

/** Map SURBL type to severity escalation threshold */
function surblSeverityFloor(types: string[]): "critical" | "high" | "medium" {
  if (types.includes("PH") || types.includes("MW")) return "high";
  if (types.includes("ABUSE")) return "medium";
  return "medium";
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const surbl: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const { env } = ctx;

    // Self-test first: a blind resolver must fail the pull, not stamp
    // every domain checked-clean.
    await assertSURBLResolverWorks();

    // Query recent threats with unchecked domains (last 7 days, limit 200)
    // Seeks the partial index idx_threats_surbl_pending (migration 0322)
    // over unchecked rows only; was ~426K rows/call through
    // idx_threats_domain. Same WHERE as before, shared with Flight
    // Control's backlog count (lib/threat-rescan-predicates.ts).
    const unchecked = await withIndexHintFallback(SURBL_WORK_SELECT_SQL, (q) =>
      env.DB.prepare(q).all<{ malicious_domain: string }>());

    const domains = unchecked.results;
    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // Rate limit: max 50 DNS lookups per cron run
    const maxLookups = 50;
    const batch = domains.slice(0, maxLookups);

    for (const row of batch) {
      itemsFetched++;
      try {
        const result = await checkSURBL(row.malicious_domain, env);

        if (result.listed) {
          const surblType = result.types.join(",") || "UNKNOWN";
          const severityFloor = surblSeverityFloor(result.types);
          const confidenceBoost = result.types.includes("PH") ? 15 : 10;

          // Update all threats with this domain: set SURBL fields, escalate severity, boost confidence
          await env.DB.prepare(`
            UPDATE threats SET
              surbl_checked = 1,
              surbl_listed = 1,
              surbl_type = ?,
              confidence_score = MIN(100, COALESCE(confidence_score, 60) + ?),
              severity = CASE
                WHEN ? > COALESCE(
                  CASE severity
                    WHEN 'info' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2
                    WHEN 'high' THEN 3 WHEN 'critical' THEN 4 ELSE 0
                  END, 0)
                THEN ?
                ELSE severity
              END
            WHERE malicious_domain = ?
          `).bind(
            surblType,
            confidenceBoost,
            SEVERITY_RANK[severityFloor] ?? 2,
            severityFloor,
            row.malicious_domain,
          ).run();

          // Combined escalation: if SURBL listed AND VT already flagged (>= 3 engines), auto-escalate to critical
          await env.DB.prepare(`
            UPDATE threats SET severity = 'critical'
            WHERE malicious_domain = ?
              AND surbl_listed = 1
              AND vt_malicious >= 3
              AND severity != 'critical'
          `).bind(row.malicious_domain).run();

          itemsNew++;
        } else {
          // Mark as checked but clean. Guard on surbl_checked = 0 so we
          // don't rewrite the (often many) sibling threats that share this
          // domain and were already flagged checked on a prior pass —
          // surbl_checked = 1 is terminal, so re-writing them is pure
          // wasted D1 write volume (Phase 2 write-budget cut).
          await env.DB.prepare(`
            UPDATE threats SET surbl_checked = 1
            WHERE malicious_domain = ?
              AND surbl_checked = 0
          `).bind(row.malicious_domain).run();

          itemsDuplicate++; // "duplicate" in the sense of no new finding
        }
      } catch (err) {
        // A refused lookup means SURBL stopped answering mid-run: abort so
        // the pull is recorded failed. The row stays surbl_checked = 0.
        if (err instanceof DnsblLookupError && err.kind === "refused") {
          throw new Error(`SURBL lookups refused after ${itemsFetched - 1} checked: ${err.message}`);
        }
        logger.error("surbl_lookup_error", {
          domain: row.malicious_domain,
          error: err instanceof Error ? err.message : String(err),
        });
        itemsError++;
      }
    }

    if (dnsblRunShouldFail(itemsFetched, itemsError)) {
      throw new Error(`SURBL: all ${itemsFetched} lookups failed — no domains checked`);
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};
