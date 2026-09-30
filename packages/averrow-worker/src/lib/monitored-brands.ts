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
 * ── The predicate is `tier` ALONE. Do not add a second term. ─────────
 *
 * STANDING STIPULATION (user decision, 2026-09-30): every brand the
 * platform monitors gets typosquat coverage, regardless of tenant
 * assignment or `monitoring_status`. Mirrored in `CLAUDE.md` §8 ("Brand
 * scope"), `docs/AI_AGENTS.md` (the lookalike_scanner row) and spec
 * §5.1a. `phantom_enumerator` already selects on this same predicate, so
 * it is the population a sibling agent has used in production all along.
 *
 * Two narrowings have been tried and reverted. BOTH ARE CLOSED — a
 * future change that re-adds either is reintroducing a known defect:
 *
 *   1. `EXISTS (org_brands …)` — the original gate. Admitted 3 brands of
 *      114,251, which left the hourly seeder a no-op BY CONSTRUCTION for
 *      four months (its `NOT EXISTS` is one-shot per brand, and those
 *      three were seeded in March-May). Closed because a typosquat is
 *      actor evidence, not a per-customer entitlement.
 *   2. `AND monitoring_status = 'active'` — closed on evidence, not
 *      preference. See the audit below. It is also the spelling that
 *      LOOKS right, which is why the audit is kept in full.
 *
 * Measured against production across the three forms:
 *
 *   `EXISTS (org_brands …)`            →     3 brands,    36 analyzable
 *   ...`AND monitoring_status='active'`→   360 brands,    17 analyzable
 *   `tier IN ('monitored','customer')` → 1,867 brands, ~56,010 candidates
 *
 * Note the middle row: adding the flag to a widened tier predicate cut
 * the analyzable population BELOW the narrow gate it replaced, because
 * two of the three `customer`-tier brands are flagged `inactive`. It
 * would have halved the pipeline on the change meant to widen it.
 *
 * ── `monitoring_status` is VESTIGIAL. Audited 2026-09-30. ────────────
 *
 * An earlier version of this comment claimed the `monitored` tier
 * "does honour the flag, because there `inactive` is the only thing
 * distinguishing it from the 114K-brand catalog." That was an
 * unverified assumption and it is FALSE. Corrected here rather than
 * quietly deleted, because the wrong version is the intuitive one and
 * the next reader will arrive at it again.
 *
 * NOTHING IN THE REPOSITORY EVER WRITES `'inactive'`. Grep it: the only
 * occurrences beside a write are two schema DEFAULT clauses (migrations
 * 0036 and 0042's table rebuild). Every other reference is a
 * `WHERE monitoring_status = 'active'` read. So the value cannot express
 * an operator decision to stop watching a brand — no code path can set
 * it. `updateBrandField` (`db/brands.ts`) does list the column in its
 * allowlist, and has zero call sites.
 *
 * The flag cross-cuts tier instead of refining it:
 *
 *   tier       status     count
 *   tracked    inactive   111,753
 *   monitored  inactive     1,505
 *   tracked    active         631   ← catalog rows, flagged active
 *   monitored  active         359
 *   customer   inactive         2
 *   customer   active           1
 *
 * `'paused'` — the third value migration 0036 documents — has never
 * existed in a single row. What actually distinguishes a monitored-tier
 * brand from the catalog is `tier` itself, set mechanically by migration
 * 0156 from `threat_count > 0`, independent of this column.
 *
 * Three findings that settle it:
 *   - `handleAddMonitoredBrand` (`handlers/brands.ts`) — the handler for
 *     an operator explicitly adding a brand to monitoring — omits
 *     `monitoring_status` from its INSERT, so a brand someone asked to
 *     monitor is born `inactive`. That is why 2 of 3 customer brands are.
 *   - 678 distinct `monitored` + `inactive` brands hold an ENABLED
 *     `brand_monitor_schedule` row. The platform schedules monitors for
 *     brands this column calls inactive.
 *   - The real watchlist is the `monitored_brands` table, which has the
 *     columns a decision needs (`added_by`, `added_at`, `removed_at`).
 *     `monitoring_status='active'` is a denormalized copy of it from one
 *     March 2026 seed run: 815 of 991 active rows are in it, and 0 of
 *     113,258 inactive non-customer rows are.
 *
 * Absence of `'active'` is therefore not the presence of a decision to
 * stop. (`'active'` does carry intent — it marks the curated seed set —
 * but a curated subset is not the target population, and it was only
 * ever a usable staging filter, never a principled one. It is now gone.)
 *
 * ── THE POPULATION IS WIDE AND THE THROUGHPUT IS NOT. Read this. ─────
 *
 * 1,867 brands is ~56,010 candidate rows against `checkLookalikeBatch`'s
 * `LIMIT 50`/hour — about a 47-DAY cycle to DNS-check each row once. That
 * is a known, ACCEPTED interim state, not an oversight, and not a bug to
 * be fixed by raising the LIMIT on its own. The alert-volume half of the
 * problem is already handled (first-contact baselining plus the
 * HIGH/CRITICAL floor in `lookalike-alert-policy.ts`); the throughput
 * half is not, and raising caps without the following would make things
 * worse rather than better:
 *
 *   1. A wall-clock budget guard in `checkLookalikeBatch`. It has none
 *      (only a 60s sub-budget for inline page fetches), and it selects
 *      `ORDER BY last_checked ASC NULLS FIRST` while stamping
 *      `last_checked` per row mid-run. Raise the LIMIT past what fits a
 *      15-minute invocation and the worker is killed with rows
 *      unstamped, so the next tick selects the same rows and dies the
 *      same way — head-of-line blocking that never self-clears, and no
 *      feed-style breaker applies here.
 *   2. A TIERED re-check cadence. Uniform 24h over 56,010 rows needs
 *      ~2,335 rows/hour; at CONCURRENCY 5 a slice of 3s DNS timeouts
 *      costs 9s, so the worst case runs ~70 min against a 15-min
 *      ceiling. Subrequests are not the constraint (50,000 configured,
 *      ~7,000 needed) — wall clock is. Registered-daily plus
 *      unregistered-weekly lands at ~530-1,034 rows/hour, which fits.
 *      Budget the `last_checked IS NULL` cohort EXPLICITLY: during the
 *      initial drain every row is NULL, falls in neither tier, and
 *      would starve the re-check of already-known rows below today's
 *      cadence without anyone noticing.
 *   3. `PAGE_DIAG_ROW_LIMIT` (`handlers/diagnostics.ts`, 20,000). At the
 *      35% registration band the page-analyzed population is ~18,200 —
 *      just under. Cross it and `truncated` flips, and every
 *      `ai_build.*` rate becomes a lower bound. Those rates ARE §5.2's
 *      promotion gate, so widening past that limit would break the
 *      measurement the widening exists to enable.
 *
 * Raise them in their own change, with their own cost argument — a
 * bigger population behind unchanged caps just moves the starvation from
 * "nothing to analyze" to "a 47-day cycle", which is harder to notice.
 *
 * Interpolated into SQL as trusted static text: every token is a
 * compile-time literal in this file, no caller input reaches it, and the
 * callers' own filter VALUES still bind. Assumes the brands table is
 * aliased `b`, which both call sites do.
 */
export const MONITORED_BRAND_PREDICATE_SQL =
  `b.tier IN ('monitored', 'customer')`;

/**
 * Tier values the predicate admits. Exported for tests so the allowlist
 * is asserted rather than re-typed, and so adding a tier is a visible
 * edit in one place.
 */
export const MONITORED_BRAND_TIERS = ['monitored', 'customer'] as const;
