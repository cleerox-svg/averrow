// Public "proof" aggregates for GET /api/v1/public/stats → `proof`.
//
// Disclosure register G1 (docs/DISCLOSURE_REGISTER.md §4) — measured,
// T1-safe numbers the marketing site can publish instead of hard-coded
// claims. Every value is an aggregate; nothing here names a brand, feed,
// vendor, rule, threshold or customer.
//
// Cost discipline (CLAUDE.md §8): two cachedValue blocks so anonymous
// traffic never reaches D1 more than once per TTL.
//   - `public.proof.core.v1`     (1h)  — four index-backed counts.
//   - `public.proof.velocity.v1` (6h)  — one 30-day range read over
//     threats(first_seen) (idx_threats_first_seen). The only threats read
//     here; a longer TTL keeps it to four range scans a day.
// A failing block yields nulls for its fields and is NOT cached (the
// compute throws, cachedValue skips the PUT), so the next request retries.
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
//   pct_live_within_24h   — of threats first seen in the last 30 days whose
//                           weaponization velocity is computable
//                           (weaponization_flag NOT NULL, migration 0259),
//                           the share flagged `very_fast` (≤24h from
//                           registration to first-live). Percent 0–100,
//                           1 decimal. null when that sample is < 30.
//   pct_live_within_72h   — same sample, `very_fast` + `fast` (≤72h).
//   velocity_sample_30d   — the sample size behind both percentages.

import type { Env } from "../types";
import { cachedValue } from "./cached-value";
import { cachedCount } from "./cached-count";
import { MONITORED_BRAND_PREDICATE_SQL } from "./monitored-brands";

export interface PublicProof {
  lookalikes_found_30d: number | null;
  operations_tracked: number | null;
  monitored_brands: number | null;
  brands_in_catalog: number | null;
  pct_live_within_24h: number | null;
  pct_live_within_72h: number | null;
  velocity_sample_30d: number | null;
  generated_at: string;
}

interface ProofCore {
  lookalikes_found_30d: number;
  operations_tracked: number;
  monitored_brands: number;
  generated_at: string;
}

interface ProofVelocity {
  pct_live_within_24h: number | null;
  pct_live_within_72h: number | null;
  velocity_sample_30d: number;
  generated_at: string;
}

export const PROOF_CORE_TTL_S = 3600;
export const PROOF_VELOCITY_TTL_S = 21600;
/** Below this many computable rows a percentage is not published. */
export const VELOCITY_MIN_SAMPLE = 30;
/** Cluster statuses that count as a live operation (handlers/operations.ts). */
export const LIVE_OPERATION_STATUSES = ["active", "accelerating", "pivot"] as const;

/** Percentage helper — 1 decimal, null below the sample floor. */
export function velocityPct(numerator: number, sample: number): number | null {
  if (sample < VELOCITY_MIN_SAMPLE || sample <= 0) return null;
  return Math.round((numerator / sample) * 1000) / 10;
}

async function computeCore(env: Env): Promise<ProofCore> {
  const statusPlaceholders = LIVE_OPERATION_STATUSES.map(() => "?").join(", ");
  const [lookalikes, operations, monitored] = await Promise.all([
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
  ]);
  return {
    lookalikes_found_30d: lookalikes?.n ?? 0,
    operations_tracked: operations?.n ?? 0,
    monitored_brands: monitored?.n ?? 0,
    generated_at: new Date().toISOString(),
  };
}

async function computeVelocity(env: Env): Promise<ProofVelocity> {
  const row = await env.DB.prepare(
    `SELECT COUNT(weaponization_flag) AS sample,
            SUM(CASE WHEN weaponization_flag = 'very_fast' THEN 1 ELSE 0 END) AS within_24h,
            SUM(CASE WHEN weaponization_flag IN ('very_fast', 'fast') THEN 1 ELSE 0 END) AS within_72h
       FROM threats
      WHERE first_seen >= datetime('now', '-30 days')`,
  ).first<{ sample: number | null; within_24h: number | null; within_72h: number | null }>();
  const sample = row?.sample ?? 0;
  return {
    pct_live_within_24h: velocityPct(row?.within_24h ?? 0, sample),
    pct_live_within_72h: velocityPct(row?.within_72h ?? 0, sample),
    velocity_sample_30d: sample,
    generated_at: new Date().toISOString(),
  };
}

export async function getPublicProof(env: Env): Promise<PublicProof> {
  const [core, velocity, catalog] = await Promise.allSettled([
    cachedValue<ProofCore>(env, "public.proof.core.v1", PROOF_CORE_TTL_S, () => computeCore(env)),
    cachedValue<ProofVelocity>(env, "public.proof.velocity.v1", PROOF_VELOCITY_TTL_S, () => computeVelocity(env)),
    // Same key + TTL as lib/public-stats.ts so both read one KV entry.
    cachedCount(env, "count.brands.total", 3600, async () => {
      const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM brands").first<{ n: number }>();
      return r?.n ?? 0;
    }),
  ]);

  const c = core.status === "fulfilled" ? core.value : null;
  const v = velocity.status === "fulfilled" ? velocity.value : null;
  // generated_at = when the oldest contributing block was computed, so a
  // consumer can print an honest "as of" date.
  const stamps = [c?.generated_at, v?.generated_at].filter((s): s is string => typeof s === "string").sort();

  return {
    lookalikes_found_30d: c?.lookalikes_found_30d ?? null,
    operations_tracked: c?.operations_tracked ?? null,
    monitored_brands: c?.monitored_brands ?? null,
    brands_in_catalog: catalog.status === "fulfilled" && catalog.value > 0 ? catalog.value : null,
    pct_live_within_24h: v?.pct_live_within_24h ?? null,
    pct_live_within_72h: v?.pct_live_within_72h ?? null,
    velocity_sample_30d: v?.velocity_sample_30d ?? null,
    generated_at: stamps[0] ?? new Date().toISOString(),
  };
}
