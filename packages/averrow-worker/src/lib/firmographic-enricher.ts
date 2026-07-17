// Firmographic enricher orchestrator.
//
// Per Phase 2 plan: free 5-source enrichment (Apollo / ZoomInfo
// rejected as too expensive). PR4 ships the framework + 3 structured
// API sources (SEC EDGAR, Companies House, Wikidata). PR4b will add
// Wikipedia infobox parsing, brand-website scraping, and Pathfinder
// AI-piggyback extraction.
//
// Strategy: run sources in trust order, stop when we have decent
// coverage (revenue_band + employee_band + industry). The result
// is UPSERTed into brand_firmographics (PR1 sibling table).
//
// Coverage acceptance: 30-50% of brands stay null on these fields.
// UI hides those cells where missing. Tranco rank tier is the size
// proxy when firmographic data is unavailable.

import type { Env } from '../types';
import type {
  BrandFirmographics,
  FirmographicLookup,
  FirmographicLookupInput,
} from './firmographic-sources/types';
import { lookupSecEdgar } from './firmographic-sources/sec-edgar';
import { makeCompaniesHouseLookup } from './firmographic-sources/companies-house';
import { lookupWikidata } from './firmographic-sources/wikidata';

export interface EnrichmentResult {
  brand_id:      string;
  enriched:      boolean;
  sources_tried: string[];
  source:        string | null;     // first source that returned data
  data:          Partial<BrandFirmographics> | null;
}

export async function enrichBrandFirmographics(
  env: Env,
  brandId: string,
  domain: string,
  name: string,
): Promise<EnrichmentResult> {
  const sources: { id: string; lookup: FirmographicLookup }[] = [
    { id: 'sec_edgar',       lookup: lookupSecEdgar },
    { id: 'companies_house', lookup: makeCompaniesHouseLookup(env) },
    { id: 'wikidata',        lookup: lookupWikidata },
  ];

  const input: FirmographicLookupInput = { domain, name };
  const tried: string[] = [];
  let merged: Partial<BrandFirmographics> | null = null;
  let firstSource: string | null = null;

  for (const { id, lookup } of sources) {
    tried.push(id);
    let data: Partial<BrandFirmographics> | null = null;
    try {
      data = await lookup(input);
    } catch {
      // Source failure is silent — orchestrator continues to next source.
      // Per-source failures aren't actionable at the brand level.
    }
    if (!data) continue;
    if (!firstSource) firstSource = id;
    merged = mergeFields(merged, data);
    if (isComplete(merged)) break;
  }

  if (!merged) {
    return { brand_id: brandId, enriched: false, sources_tried: tried, source: null, data: null };
  }

  await persist(env, brandId, merged);

  return {
    brand_id: brandId,
    enriched: true,
    sources_tried: tried,
    source: firstSource,
    data: merged,
  };
}

// Take the first non-null value field-by-field. Higher-trust sources
// run first and "win" any field they populate; later sources only
// fill remaining nulls.
function mergeFields(
  base: Partial<BrandFirmographics> | null,
  next: Partial<BrandFirmographics>,
): Partial<BrandFirmographics> {
  if (!base) return next;
  const out: Partial<BrandFirmographics> = { ...base };
  for (const [k, v] of Object.entries(next) as Array<[keyof BrandFirmographics, unknown]>) {
    if ((out as Record<string, unknown>)[k] === undefined || (out as Record<string, unknown>)[k] === null) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function isComplete(data: Partial<BrandFirmographics>): boolean {
  return !!data.revenue_band && !!data.employee_band && (!!data.industry_naics || !!data.industry_sic);
}

async function persist(env: Env, brandId: string, data: Partial<BrandFirmographics>): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO brand_firmographics (
      brand_id, revenue_band, employee_band, industry_naics, industry_sic,
      founded_year, is_public, ticker, parent_company,
      source, source_url, confidence, enriched_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(brand_id) DO UPDATE SET
      revenue_band     = COALESCE(excluded.revenue_band,    revenue_band),
      employee_band    = COALESCE(excluded.employee_band,   employee_band),
      industry_naics   = COALESCE(excluded.industry_naics,  industry_naics),
      industry_sic     = COALESCE(excluded.industry_sic,    industry_sic),
      founded_year     = COALESCE(excluded.founded_year,    founded_year),
      is_public        = COALESCE(excluded.is_public,       is_public),
      ticker           = COALESCE(excluded.ticker,          ticker),
      parent_company   = COALESCE(excluded.parent_company,  parent_company),
      source           = excluded.source,
      source_url       = excluded.source_url,
      confidence       = excluded.confidence,
      updated_at       = datetime('now')
  `).bind(
    brandId,
    data.revenue_band ?? null,
    data.employee_band ?? null,
    data.industry_naics ?? null,
    data.industry_sic ?? null,
    data.founded_year ?? null,
    data.is_public === undefined || data.is_public === null ? null : (data.is_public ? 1 : 0),
    data.ticker ?? null,
    data.parent_company ?? null,
    data.source ?? 'unknown',
    data.source_url ?? null,
    data.confidence ?? 50,
  ).run();
}

// ─── Batch enricher ────────────────────────────────────────────────
//
// Runs nightly under the existing `enricher` cron. Picks brands that
// don't yet have a firmographic row (or whose row is older than 90
// days) and enriches them. Bounded by a per-tick limit + per-source
// bounded fetches so the cron tick doesn't blow its CPU budget.

export interface BatchEnrichmentSummary {
  scanned:    number;
  enriched:   number;
  no_match:   number;
  errors:     number;
  duration_ms: number;
}

const STALE_DAYS = 90;
const PER_TICK_LIMIT = 200;

export async function enrichFirmographicsBatch(env: Env): Promise<BatchEnrichmentSummary> {
  const start = Date.now();
  const summary: BatchEnrichmentSummary = {
    scanned: 0, enriched: 0, no_match: 0, errors: 0, duration_ms: 0,
  };

  // Prioritize monitored+customer tier brands. Tracked brands enrich
  // on demand only (most won't ever be queried for firmographic data).
  const targets = await env.DB.prepare(`
    SELECT b.id, b.canonical_domain, b.name
    FROM brands b
    LEFT JOIN brand_firmographics bf ON bf.brand_id = b.id
    WHERE b.tier IN ('monitored', 'customer')
      AND (
        bf.brand_id IS NULL
        OR julianday('now') - julianday(bf.updated_at) > ?
      )
    ORDER BY b.tier = 'customer' DESC, b.tranco_rank ASC NULLS LAST
    LIMIT ?
  `).bind(STALE_DAYS, PER_TICK_LIMIT).all<{
    id: string; canonical_domain: string; name: string;
  }>();

  summary.scanned = targets.results.length;

  for (const { id, canonical_domain, name } of targets.results) {
    try {
      const result = await enrichBrandFirmographics(env, id, canonical_domain, name);
      if (result.enriched) summary.enriched++;
      else summary.no_match++;
    } catch {
      summary.errors++;
    }
  }

  summary.duration_ms = Date.now() - start;
  return summary;
}
