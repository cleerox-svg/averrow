// Public "proof" aggregates for GET /api/v1/public/stats → `proof`.
//
// Disclosure register G1 (docs/DISCLOSURE_REGISTER.md §4) — measured,
// T1-safe numbers the marketing site can publish instead of hard-coded
// claims. Every value is an aggregate; nothing here names a brand, feed,
// vendor, rule, threshold or customer.
//
// Cost discipline (CLAUDE.md §8): one cachedValue block
// (`public.proof.core.v3`, 1h) so anonymous traffic reaches D1 at most once
// per hour. Every query is index-served (idx_lookalike_registered,
// idx_lookalike_first_seen, idx_clusters_status, idx_brands_tier); nothing
// here reads `threats`.
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
//   lookalikes_found_30d  — REGISTERED lookalikes DISCOVERED in the last 30
//                           days: registered = 1 and
//                           COALESCE(first_seen, baseline_established_at)
//                           (the confirmed registration date, else our first
//                           baseline check that found it registered) in the
//                           last 30 days. Rows created before 2026-09-30
//                           (LOOKALIKE_PROOF_POPULATION_START) are excluded:
//                           the ~120-row legacy population that predates the
//                           monitored-brand seeder (merged 2026-10-01) was
//                           re-baselined by migrations 0267/0269, so a recent
//                           baseline on it is a backfill, not a discovery.
//                           Key name kept for compatibility (2026-10-05).
//   new_registrations_30d — CONFIRMED new registrations in the last 30 days:
//                           registration_evidence IN ('nrd','observed')
//                           (migration 0282) and first_seen in the last 30
//                           days. 'observed' = a registered 0→1 transition on
//                           an already-baselined row; 'nrd' = the registries'
//                           newly-registered list dated it (claimed only when
//                           we had not already seen it registered before that
//                           date — lib/lookalike-nrd-matcher.ts). The literal
//                           `first_seen > baseline_established_at` test is
//                           deliberately NOT applied: the checker stamps the
//                           baseline when it first resolves an NRD-dated row,
//                           i.e. AFTER the registration date, so it would drop
//                           every NRD registration the moment it is checked.
//                           The "new, not pre-existing" condition is enforced
//                           where the evidence is written instead.
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

/** Lookalike rows created before this are the pre-seeder legacy population. */
export const LOOKALIKE_PROOF_POPULATION_START = "2026-09-30";

export interface PublicProof {
  lookalikes_found_30d: number | null;
  new_registrations_30d: number | null;
  operations_tracked: number | null;
  monitored_brands: number | null;
  brands_in_catalog: number | null;
  generated_at: string;
}

interface ProofCore {
  lookalikes_found_30d: number;
  new_registrations_30d: number;
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
  const [lookalikes, newRegistrations, operations, monitored, catalog] = await Promise.all([
    // Served by idx_lookalike_registered (partial, registered = 1).
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains
        WHERE registered = 1
          AND COALESCE(first_seen, baseline_established_at) >= datetime('now', '-30 days')
          AND created_at >= ?`,
    ).bind(LOOKALIKE_PROOF_POPULATION_START).first<{ n: number }>(),
    // Served by idx_lookalike_first_seen (partial, first_seen IS NOT NULL).
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM lookalike_domains
        WHERE first_seen >= datetime('now', '-30 days')
          AND registration_evidence IN ('nrd', 'observed')`,
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
    new_registrations_30d: newRegistrations?.n ?? 0,
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
    return await cachedValue<ProofCore>(env, "public.proof.core.v3", PROOF_CORE_TTL_S, () => computeCore(env));
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
    new_registrations_30d: c?.new_registrations_30d ?? null,
    operations_tracked: c?.operations_tracked ?? null,
    monitored_brands: c?.monitored_brands ?? null,
    brands_in_catalog: c && c.brands_in_catalog > 0 ? c.brands_in_catalog : null,
    // When the core block was computed (an honest "as of" date).
    generated_at: c?.generated_at ?? new Date().toISOString(),
  };
}
