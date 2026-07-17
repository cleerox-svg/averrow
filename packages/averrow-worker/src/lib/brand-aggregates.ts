// Catalog-level aggregate queries for the Brands Intel page.
//
// Per PR13: each aggregate is a single GROUP BY (or small JOIN) over
// the catalog. Wrapped in cachedValue (5min TTL) so the Intel page
// stays cheap even when the catalog grows to 100K+ brands. Per
// CLAUDE.md: bare COUNT(*) FROM threats is a code-review red flag —
// these aggregates use existing pre-computed columns where possible.
//
// Four panels:
//   emailSecurityAggregate   — grade distribution + DMARC enforcement
//   pressureAggregate        — top-N by lookalikes / social-imps / app-imps / dark-web
//   compositionAggregate     — tier / source / Tranco bucket / HQ country
//   postureAggregate         — Brand-Health + Brand-Exposure distributions

import type { Env } from '../types';
import { cachedValue } from './cached-value';

// ── Email Security ─────────────────────────────────────────────

export interface EmailSecurityAggregate {
  grade_distribution: Array<{ grade: string; count: number }>;
  total_graded:       number;
  ungraded:           number;
  dmarc_distribution: Array<{ policy: string; count: number }>;
  dmarc_enforcing:    number;     // policy IN ('quarantine','reject')
}

export async function emailSecurityAggregate(env: Env): Promise<EmailSecurityAggregate> {
  return cachedValue<EmailSecurityAggregate>(
    env, 'brand-aggregate.email-security', 300,
    async () => {
      const grades = await env.DB.prepare(`
        SELECT email_security_grade AS grade, COUNT(*) AS count
        FROM brands
        WHERE email_security_grade IS NOT NULL
        GROUP BY email_security_grade
        ORDER BY CASE email_security_grade
          WHEN 'A+' THEN 0 WHEN 'A' THEN 1 WHEN 'A-' THEN 2
          WHEN 'B+' THEN 3 WHEN 'B' THEN 4 WHEN 'B-' THEN 5
          WHEN 'C+' THEN 6 WHEN 'C' THEN 7 WHEN 'C-' THEN 8
          WHEN 'D+' THEN 9 WHEN 'D' THEN 10 WHEN 'D-' THEN 11
          WHEN 'F'  THEN 12 ELSE 13 END
      `).all<{ grade: string; count: number }>();

      const totals = await env.DB.prepare(`
        SELECT
          SUM(CASE WHEN email_security_grade IS NOT NULL THEN 1 ELSE 0 END) AS graded,
          SUM(CASE WHEN email_security_grade IS NULL     THEN 1 ELSE 0 END) AS ungraded
        FROM brands
      `).first<{ graded: number; ungraded: number }>();

      // DMARC enforcement from latest email_security_scans row per brand.
      // Sub-select picks each brand's most recent scan; outer GROUP BY
      // counts policies. Uses brand_id which is stored as INTEGER on
      // that table — coerce join via canonical_domain for safety.
      const dmarcRows = await env.DB.prepare(`
        SELECT
          COALESCE(s.dmarc_policy,
                   CASE WHEN s.dmarc_exists=1 THEN 'unspecified' ELSE 'none' END) AS policy,
          COUNT(*) AS count
        FROM (
          SELECT brand_id, dmarc_policy, dmarc_exists,
                 ROW_NUMBER() OVER (PARTITION BY brand_id ORDER BY id DESC) rn
          FROM email_security_scans
        ) s
        WHERE s.rn = 1
        GROUP BY policy
        ORDER BY count DESC
      `).all<{ policy: string; count: number }>();

      const dmarcEnforcing = dmarcRows.results
        .filter(r => r.policy === 'quarantine' || r.policy === 'reject')
        .reduce((s, r) => s + r.count, 0);

      return {
        grade_distribution: grades.results,
        total_graded:       totals?.graded ?? 0,
        ungraded:           totals?.ungraded ?? 0,
        dmarc_distribution: dmarcRows.results,
        dmarc_enforcing:    dmarcEnforcing,
      };
    },
  );
}

// ── Pressure ─────────────────────────────────────────────

export interface PressureAggregate {
  top_lookalikes:        Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>;
  top_social_imps:       Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>;
  top_app_imps:          Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>;
  top_dark_web:          Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>;
}

export async function pressureAggregate(env: Env): Promise<PressureAggregate> {
  return cachedValue<PressureAggregate>(
    env, 'brand-aggregate.pressure', 300,
    async () => {
      const baseSelect = (joinTable: string, where: string) => `
        SELECT b.id AS brand_id, b.name AS brand_name, b.canonical_domain, b.logo_url, COUNT(*) AS count
        FROM ${joinTable} t
        JOIN brands b ON b.id = t.brand_id
        ${where}
        GROUP BY b.id, b.name, b.canonical_domain, b.logo_url
        ORDER BY count DESC
        LIMIT 8
      `;

      // Lookalikes: query threats table (where the production
      // typosquat-scanner output lands — 27K+ rows attributed by
      // target_brand_id), not lookalike_domains (a 30-row curated
      // workspace that's mostly empty under the registered=1 +
      // status='monitoring' filter). Same root cause + pattern as
      // PR-H fixed for the tenant Domain Findings page. Aliasing
      // target_brand_id as brand_id so it shapes-matches baseSelect.
      const lookalikesSql = `
        SELECT b.id AS brand_id, b.name AS brand_name, b.canonical_domain, b.logo_url, COUNT(*) AS count
        FROM threats t
        JOIN brands b ON b.id = t.target_brand_id
        WHERE t.threat_type = 'typosquatting'
          AND t.target_brand_id IS NOT NULL
          AND t.status = 'active'
        GROUP BY b.id, b.name, b.canonical_domain, b.logo_url
        ORDER BY count DESC
        LIMIT 8
      `;

      const [lookalikes, social, apps, dark] = await Promise.all([
        env.DB.prepare(lookalikesSql)
          .all<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>(),
        env.DB.prepare(baseSelect('social_profiles',
          "WHERE t.classification IN ('impersonation','suspicious') AND COALESCE(t.status,'active') = 'active'"))
          .all<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>(),
        env.DB.prepare(baseSelect('app_store_listings',
          "WHERE t.classification IN ('impersonation','suspicious') AND COALESCE(t.status,'active') = 'active'"))
          .all<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>(),
        // dark_web_mentions ingestion isn't built yet — table is
        // empty (verified 2026-05-14). Keeping the query in place so
        // the card lights up the moment data starts landing; for now
        // it returns zero rows and the UI shows "No signal yet". See
        // docs/PLATFORM_DATA_DEPENDENCIES.md §6.
        env.DB.prepare(baseSelect('dark_web_mentions',
          "WHERE t.classification = 'confirmed' AND COALESCE(t.status,'active') = 'active'"))
          .all<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>(),
      ]);

      return {
        top_lookalikes:  lookalikes.results,
        top_social_imps: social.results,
        top_app_imps:    apps.results,
        top_dark_web:    dark.results,
      };
    },
  );
}

// ── Composition ─────────────────────────────────────────────

export interface CompositionAggregate {
  tier_mix:      Array<{ tier: string; count: number }>;
  source_mix:    Array<{ source: string; count: number }>;
  tranco_buckets:Array<{ bucket: string; count: number }>;
  hq_countries:  Array<{ country: string; count: number }>;
  total:         number;
}

export async function compositionAggregate(env: Env): Promise<CompositionAggregate> {
  return cachedValue<CompositionAggregate>(
    env, 'brand-aggregate.composition', 300,
    async () => {
      const [tier, source, tranco, geo, total] = await Promise.all([
        env.DB.prepare(`
          SELECT tier, COUNT(*) AS count FROM brands
          GROUP BY tier
          ORDER BY CASE tier WHEN 'customer' THEN 0 WHEN 'monitored' THEN 1 WHEN 'tracked' THEN 2 ELSE 3 END
        `).all<{ tier: string; count: number }>(),
        env.DB.prepare(`
          SELECT COALESCE(source,'unknown') AS source, COUNT(*) AS count
          FROM brands
          GROUP BY source
          ORDER BY count DESC
        `).all<{ source: string; count: number }>(),
        env.DB.prepare(`
          SELECT
            CASE
              WHEN tranco_rank IS NULL              THEN 'unranked'
              WHEN tranco_rank <= 1000              THEN '1-1K'
              WHEN tranco_rank <= 10000             THEN '1K-10K'
              WHEN tranco_rank <= 100000            THEN '10K-100K'
              ELSE '100K+'
            END AS bucket,
            COUNT(*) AS count
          FROM brands
          GROUP BY bucket
          ORDER BY CASE bucket
            WHEN '1-1K'    THEN 0
            WHEN '1K-10K'  THEN 1
            WHEN '10K-100K' THEN 2
            WHEN '100K+'   THEN 3
            ELSE 4 END
        `).all<{ bucket: string; count: number }>(),
        env.DB.prepare(`
          SELECT hq_country AS country, COUNT(*) AS count
          FROM brands
          WHERE hq_country IS NOT NULL AND hq_country != ''
          GROUP BY hq_country
          ORDER BY count DESC
          LIMIT 15
        `).all<{ country: string; count: number }>(),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM brands`).first<{ n: number }>(),
      ]);

      return {
        tier_mix:       tier.results,
        source_mix:     source.results,
        tranco_buckets: tranco.results,
        hq_countries:   geo.results,
        total:          total?.n ?? 0,
      };
    },
  );
}

// ── Posture ─────────────────────────────────────────────

export interface PostureAggregate {
  health_grade_distribution: Array<{ grade: string; count: number }>;
  health_score_buckets:      Array<{ bucket: string; count: number }>;
  exposure_score_buckets:    Array<{ bucket: string; count: number }>;
  improving_brands:          Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; delta: number; latest: number }>;
  declining_brands:          Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; delta: number; latest: number }>;
  total_scored:              number;
}

export async function postureAggregate(env: Env): Promise<PostureAggregate> {
  return cachedValue<PostureAggregate>(
    env, 'brand-aggregate.posture', 300,
    async () => {
      const [healthGrades, healthBuckets, exposureBuckets, total] = await Promise.all([
        env.DB.prepare(`
          SELECT brand_health_grade AS grade, COUNT(*) AS count
          FROM brands
          WHERE brand_health_grade IS NOT NULL
          GROUP BY brand_health_grade
          ORDER BY CASE brand_health_grade
            WHEN 'A+' THEN 0 WHEN 'A' THEN 1 WHEN 'A-' THEN 2
            WHEN 'B+' THEN 3 WHEN 'B' THEN 4 WHEN 'B-' THEN 5
            WHEN 'C'  THEN 6 WHEN 'D'  THEN 7
            WHEN 'F'  THEN 8 ELSE 9 END
        `).all<{ grade: string; count: number }>(),
        env.DB.prepare(`
          SELECT
            CASE
              WHEN brand_health_score IS NULL  THEN 'unscored'
              WHEN brand_health_score >= 80    THEN '80-100'
              WHEN brand_health_score >= 60    THEN '60-79'
              WHEN brand_health_score >= 40    THEN '40-59'
              WHEN brand_health_score >= 20    THEN '20-39'
              ELSE '0-19'
            END AS bucket,
            COUNT(*) AS count
          FROM brands
          WHERE tier IN ('monitored','customer')
          GROUP BY bucket
          ORDER BY CASE bucket
            WHEN '80-100' THEN 0 WHEN '60-79' THEN 1
            WHEN '40-59'  THEN 2 WHEN '20-39' THEN 3
            WHEN '0-19'   THEN 4 ELSE 5 END
        `).all<{ bucket: string; count: number }>(),
        env.DB.prepare(`
          SELECT
            CASE
              WHEN brand_exposure_score IS NULL  THEN 'unscored'
              WHEN brand_exposure_score >= 80    THEN '80-100'
              WHEN brand_exposure_score >= 60    THEN '60-79'
              WHEN brand_exposure_score >= 40    THEN '40-59'
              WHEN brand_exposure_score >= 20    THEN '20-39'
              ELSE '0-19'
            END AS bucket,
            COUNT(*) AS count
          FROM brands
          WHERE tier IN ('monitored','customer')
          GROUP BY bucket
          ORDER BY CASE bucket
            WHEN '0-19'   THEN 0 WHEN '20-39' THEN 1
            WHEN '40-59'  THEN 2 WHEN '60-79' THEN 3
            WHEN '80-100' THEN 4 ELSE 5 END
        `).all<{ bucket: string; count: number }>(),
        env.DB.prepare(`
          SELECT COUNT(*) AS n FROM brands
          WHERE brand_health_score IS NOT NULL
        `).first<{ n: number }>(),
      ]);

      // Improving / declining: compare latest snapshot to the OLDEST
      // snapshot within the last 1-8 days. PR-T loosened this from a
      // strict 6-8 day window because brand_score_snapshots was empty
      // for months (orchestrator hour===0 starvation; see cron handler
      // for `16 0 * * *`) and even after the dedicated cron started
      // populating it, customers wouldn't see Improving/Declining
      // cards for a full week. Loosened window lights them up as soon
      // as ≥1 day of history exists, then naturally extends to the
      // full 7-day diff as history accumulates. brand_score_snapshots
      // is keyed by (brand_id, snapshot_day) so the windowed CTE is
      // cheap (index seek per brand).
      //
      // WS-A #4: dropped the `ABS(delta) >= 5` threshold. Brand-health
      // score moves slowly — production had 5,000 paired brands but
      // only TWO over the threshold, leaving the Improving / Declining
      // cards permanently empty. The card already renders the actual
      // delta beside each brand, so a top-K-by-magnitude is more
      // informative: even a +2 / -3 mover is the BIGGEST shift in the
      // portfolio that day. Tie-break by latest DESC so when several
      // brands have identical small deltas we surface the higher-score
      // ones first.
      const movers = await env.DB.prepare(`
        WITH paired AS (
          SELECT
            s.brand_id,
            s.brand_health_score AS latest,
            (SELECT brand_health_score
             FROM brand_score_snapshots s2
             WHERE s2.brand_id = s.brand_id
               AND julianday('now') - julianday(s2.snapshot_day) BETWEEN 1 AND 8
               AND s2.snapshot_day <> s.snapshot_day
             ORDER BY s2.snapshot_day ASC LIMIT 1) AS prev
          FROM brand_score_snapshots s
          WHERE s.snapshot_day = (
            SELECT MAX(snapshot_day) FROM brand_score_snapshots
            WHERE brand_id = s.brand_id
          )
            AND s.brand_health_score IS NOT NULL
        )
        SELECT
          p.brand_id, b.name AS brand_name, b.canonical_domain, b.logo_url,
          p.latest, (p.latest - p.prev) AS delta
        FROM paired p
        JOIN brands b ON b.id = p.brand_id
        WHERE p.prev IS NOT NULL AND p.latest <> p.prev
        ORDER BY ABS(p.latest - p.prev) DESC, p.latest DESC
        LIMIT 20
      `).all<{
        brand_id: string; brand_name: string; canonical_domain: string;
        logo_url: string | null; latest: number; delta: number;
      }>();

      const improving = movers.results.filter(m => m.delta > 0).slice(0, 5);
      const declining = movers.results.filter(m => m.delta < 0).slice(0, 5);

      return {
        health_grade_distribution: healthGrades.results,
        health_score_buckets:      healthBuckets.results,
        exposure_score_buckets:    exposureBuckets.results,
        improving_brands:          improving,
        declining_brands:          declining,
        total_scored:              total?.n ?? 0,
      };
    },
  );
}
