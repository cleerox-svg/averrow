/**
 * Enrichment Chain — Post-ingestion context enrichment using free APIs.
 *
 * Each enricher is idempotent: it checks a metadata flag before processing
 * a threat and sets it on completion, so re-runs safely skip already-enriched rows.
 *
 * Enrichers (run concurrently):
 *   1. RDAP   — adds domain age to domain-based threats
 *   2. DNS    — adds DNS health signals to domain-based threats
 *
 * Shodan InternetDB was removed 2026-11-14: its terms require an enterprise
 * licence for commercial use. Do not re-add it without that licence.
 *
 * NOTE: `runEnrichmentChain` has no caller anywhere in the worker (verified
 * 2026-11-14); this module is currently dead code.
 */

import type { Env } from "../types";
import { enrichRdap } from "./rdap";
import { enrichDns } from "./dns";

export { enrichRdap, enrichDns };

export async function runEnrichmentChain(db: D1Database, env: Env): Promise<void> {
  // RDAP and DNS are independent — run them concurrently
  const [rdapResult, dnsResult] = await Promise.allSettled([
    enrichRdap(db, env),
    enrichDns(db, env),
  ]);

  if (rdapResult.status === "fulfilled") {
    // result available but no logging needed
  } else {
    console.error("[rdap] enrichment chain error:", rdapResult.reason);
  }

  if (dnsResult.status === "fulfilled") {
    // result available but no logging needed
  } else {
    console.error("[dns] enrichment chain error:", dnsResult.reason);
  }
}
