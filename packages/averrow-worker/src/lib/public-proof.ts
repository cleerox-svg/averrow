// Public "proof" aggregates for GET /api/v1/public/stats → `proof`.
//
// Disclosure register G1 (docs/DISCLOSURE_REGISTER.md §4) — measured,
// T1-safe numbers the marketing site can publish instead of hard-coded
// claims. Every value is an aggregate; nothing here names a brand, feed,
// vendor, rule, threshold or customer.
//
// Cost discipline (CLAUDE.md §8): one cachedValue block
// (`public.proof.core.v2`, 1h) so anonymous traffic reaches D1 at most once
// per hour. Every query is index-served (idx_lookalike_registered,
// idx_clusters_status, idx_brands_tier); nothing here reads `threats`.
// A failing compute is NOT written to the 1h cache; instead a short
// negative-cache stamp (`public_proof:core:failed`, 10 min) makes every
// request in that window answer all-null without retrying D1.
//
// Weaponization velocity (pct registered→live within 24h) was removed from
// the public block (2026-10-05 review): the 30-day range over threats has
// no first_seen index in prod (idx_threats_first_seen was dropped out of
// band — see migration 0277), and the velocity writer only runs from an
// admin endpoint, so the sample is usually below the n >= 30 floor anyway.
// Re-add only behind a scheduled writer and an index or cube.
//
// Definitions (keep in sync with docs/API_REFERENCE.md):
//   lookalikes_found_30d  — lookalike_domains rows with registered = 1 whose
//                           `first_seen` (the observed 0→1 registration
//                           transition, migration 0267 — NOT our first
//                           baseline check) falls in the last 30 days.
//   operations_tracked    — distinct operations among LIVE infrastructure
//                           clusters (status active / accelerating / pivot)
//                           seen in the last 30 days. An operation is the
//                           connected component (`component_id`, migration
//                           0240) when NEXUS has grouped the cluster, else
//                           the cluster itself — so a multi-lane operator
//                           counts once, not once per lane.
//   monitored_brands      — brands under continuous monitoring:
//                           MONITORED_BRAND_PREDICATE_SQL
//                           (tier IN ('monitored','customer')).
//   brands_in_catalog     — every row in `brands` (the passive catalog,
//                           incl. tier='tracked'). Never label this
//                           "monitored" (register L12).

import type { Env } from "../types";
import { cachedValue } from "./cached-value";
import { cachedCount } from "./cached-count";
import { MONITORED_BRAND_PREDICATE_SQL } from "./monitored-brands";

export interface PublicProof {
  lookalikes_found_30d: number | null;
  operations_tracked: number | null;
  monitored_brands: number | null;
  brands_in_catalog: number | null;
  generated_at: string;
}

interface ProofCore {
  lookalikes_found_30d: number;
  operations_tracked: number;
  monitored_brands: number;
  brands_in_catalog: number;
  generated_at: string;
}

export const PROOF_CORE_TTL_S = 3600;
/** Negative-cache window after a failed compute. */
export const PROOF_FAILURE_TTL_S = 600;
const PROOF_FAILED_KEY = "public_proof:core:failed";
/** Cluster statuses that count as a live operation (handlers/operations.ts). */
export const LIVE_OPERATION_STATUSES = ["active", "accelerating", "pivot"] as const;

async function computeCore(env: Env): Promise<ProofCore> {
  const statusPlaceholders = LIVE_OPERATION_STATUSES.map(() => "?").join(", ");
  const [lookalikes, operations, monitored, catalog] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains
        WHERE registered = 1 AND first_seen >= datetime('now', '-30 days')`,
    ).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT COALESCE(component_id, id)) AS n
         FROM infrastructure_clusters
        WHERE status IN (${statusPlaceholders})
          AND last_seen >= datetime('now', '-30 days')`,
    ).bind(...LIVE_OPERATION_STATUSES).first<{ n: number }>(),
    // Static trusted predicate text (see lib/monitored-brands.ts) — no
    // caller input reaches this SQL. Served by idx_brands_tier.
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM brands b WHERE ${MONITORED_BRAND_PREDICATE_SQL}`,
    ).first<{ n: number }>(),
    // Same key + TTL as lib/public-stats.ts so both read one KV entry.
    cachedCount(env, "count.brands.total", 3600, async () => {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM brands").first<{ n: number }>();
      return r?.n ?? 0;
    }),
  ]);
  return {
    lookalikes_found_30d: lookalikes?.n ?? 0,
    operations_tracked: operations?.n ?? 0,
    monitored_brands: monitored?.n ?? 0,
    brands_in_catalog: catalog,
    generated_at: new Date().toISOString(),
  };
}

async function getCore(env: Env): Promise<ProofCore | null> {
  try {
    if (await env.CACHE.get(PROOF_FAILED_KEY)) return null;
  } catch { /* KV transient — fall through to the normal path */ }
  try {
    return await cachedValue<ProofCore>(env, "public.proof.core.v2", PROOF_CORE_TTL_S, () => computeCore(env));
  } catch {
    try {
      await env.CACHE.put(PROOF_FAILED_KEY, "1", { expirationTtl: PROOF_FAILURE_TTL_S });
    } catch { /* best-effort */ }
    return null;
  }
}

export async function getPublicProof(env: Env): Promise<PublicProof> {
  const c = await getCore(env);
  return {
    lookalikes_found_30d: c?.lookalikes_found_30d ?? null,
    operations_tracked: c?.operations_tracked ?? null,
    monitored_brands: c?.monitored_brands ?? null,
    brands_in_catalog: c && c.brands_in_catalog > 0 ? c.brands_in_catalog : null,
    // When the core block was computed (an honest "as of" date).
    generated_at: c?.generated_at ?? new Date().toISOString(),
  };
}
