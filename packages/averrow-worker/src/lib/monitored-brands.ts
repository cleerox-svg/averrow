/**
 * "The platform monitors this brand" — ONE definition of the brand
 * population that lookalike generation and page analysis operate over.
 *
 * Lives in lib/ rather than beside either caller ON PURPOSE.
 * `scanners/lookalike-domains.ts` already imports
 * `runPageAnalysisForDomain` from `scanners/lookalike-page-analysis.ts`,
 * so exporting this from either of them would close an import cycle.
 * TypeScript accepts such a cycle and it would even work today, because
 * both call sites interpolate the constant inside a function body where
 * ESM live bindings have resolved by call time — but it breaks silently
 * the moment someone hoists one of those SQL strings to module scope,
 * where the binding is still in its temporal dead zone and the predicate
 * lands in the query as the literal text `undefined`. A neutral module
 * removes the hazard instead of documenting it.
 *
 * ── Why `brands.tier` and not `org_brands` ──────────────────────────
 *
 * Both gates previously required `org_brands` membership, i.e. that a
 * tenant had been assigned the brand. That is the brand-protection
 * reading; Averrow is a threat-ACTOR intelligence platform where
 * patterns are the product (CLAUDE.md §13), and a typosquat of any
 * monitored brand is evidence about an actor whether or not a customer
 * pays for that brand.
 *
 * The narrow gate had a measurable cost. In production it admitted
 * THREE brands (Google, Httpwg, Slate) out of 114,251.
 * `lookalike_domains` therefore held 120 rows whose newest was four
 * months old, ~36 of them were eligible for page analysis, and §5.2's
 * promotion gate needed ~285 scored rows against 19 — arithmetically
 * unreachable rather than merely slow. See spec §5.1a.
 *
 * ── Why the `customer` tier is NOT filtered on monitoring_status ─────
 *
 * The obvious spelling of this predicate is
 * `tier IN ('monitored','customer') AND monitoring_status = 'active'`.
 * It is wrong, and measurably so. Two of the three `customer`-tier
 * brands in production carry `monitoring_status <> 'active'`, so that
 * form cut the analyzable population (registered + has_web + resolving)
 * from 36 rows to 17 — it would have HALVED the existing pipeline on
 * the same change that was meant to widen it.
 *
 * Measured against production the day this landed:
 *
 *   old `org_brands` membership gate  →   3 brands, 36 analyzable rows
 *   this predicate                    → 362 brands, 36 analyzable rows
 *   ...AND monitoring_status='active' → 360 brands, 17 analyzable rows
 *
 * So `customer` is unconditional: a paying customer's brand is monitored
 * by definition, and `monitoring_status` on those rows tracks something
 * else (scan scheduling state), not whether we care about the brand.
 * `monitored` tier — the 359 brands this change adds — does honour the
 * flag, because there `inactive` is the only thing distinguishing it
 * from the 114K-brand catalog.
 *
 * ── Why `monitored` + active is a stage, not the end state ───────────
 *
 *   tier monitored + active, plus all customer →   362 brands, ~10,860 rows
 *   tier monitored + customer, any status      → 1,867 brands, ~56,010 rows
 *
 * The 362-brand stage yields roughly 540 scored rows at observed rates,
 * comfortably past the ~285 §5.2 needs for n>=30 in its positive-control
 * arm, while staying inside existing throughput. The full 1,867 does not:
 * `checkLookalikeBatch` reads 50 rows/hour, so 56,010 rows take about 47
 * DAYS to DNS-check even once, against roughly 9 days for 10,860.
 *
 * So widening past this stage is gated on raising that limit and
 * `PAGE_ANALYSIS_LIMIT` first. Both were sized when this table held 120
 * rows and become the binding constraint as soon as population is no
 * longer the one that binds. Raise them in their own change, with their
 * own cost argument — a bigger population behind unchanged caps just
 * moves the starvation from "nothing to analyze" to "a 47-day cycle",
 * which is harder to notice.
 *
 * Interpolated into SQL as trusted static text: every token is a
 * compile-time literal in this file, no caller input reaches it, and the
 * callers' own filter VALUES still bind. Assumes the brands table is
 * aliased `b`, which both call sites do.
 */
export const MONITORED_BRAND_PREDICATE_SQL =
  `(b.tier = 'customer' OR (b.tier = 'monitored' AND b.monitoring_status = 'active'))`;

/**
 * Tier values the predicate admits. Exported for tests so the allowlist
 * is asserted rather than re-typed, and so adding a tier is a visible
 * edit in one place.
 */
export const MONITORED_BRAND_TIERS = ['monitored', 'customer'] as const;

/** The `monitoring_status` the predicate requires. */
export const MONITORED_BRAND_STATUS = 'active' as const;
