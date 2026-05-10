// Common types for free-source firmographic enrichers.
//
// Each source module exports a `lookup(domain, name)` function that
// returns Partial<BrandFirmographics> when data is found, or null
// when the source has nothing useful for this brand. Modules are
// pure-fetch + parse — no DB access, no side effects. The
// orchestrator in lib/firmographic-enricher.ts persists results.

export type RevenueBand =
  | '<10M' | '10-50M' | '50-250M' | '250M-1B' | '1B+';

export type EmployeeBand =
  | '<50' | '50-250' | '250-1K' | '1K-10K' | '10K+';

export interface BrandFirmographics {
  revenue_band:    RevenueBand | null;
  employee_band:   EmployeeBand | null;
  industry_naics:  string | null;        // 6-digit
  industry_sic:    string | null;        // 4-digit (legacy)
  founded_year:    number | null;
  is_public:       boolean | null;
  ticker:          string | null;
  parent_company:  string | null;
  source:          FirmographicSource;
  source_url:      string | null;
  confidence:      number;               // 0-100, source-trustworthiness
}

export type FirmographicSource =
  | 'sec_edgar'
  | 'companies_house'
  | 'wikidata'
  | 'wikipedia'
  | 'website_scraper'
  | 'pathfinder_ai'
  | 'customer';

export interface FirmographicLookupInput {
  domain: string;                        // 'acme.com'
  name: string;                          // 'Acme Corp'
}

export type FirmographicLookup =
  (input: FirmographicLookupInput) => Promise<Partial<BrandFirmographics> | null>;

// ─── Band mappers ─────────────────────────────────────────────────
// Convert raw revenue (USD) and employee count to canonical bands.

export function revenueToBand(usd: number | null): RevenueBand | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return null;
  if (usd <  10_000_000)        return '<10M';
  if (usd <  50_000_000)        return '10-50M';
  if (usd <  250_000_000)       return '50-250M';
  if (usd <  1_000_000_000)     return '250M-1B';
  return '1B+';
}

export function employeesToBand(n: number | null): EmployeeBand | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return null;
  if (n <  50)     return '<50';
  if (n <  250)    return '50-250';
  if (n <  1000)   return '250-1K';
  if (n <  10000)  return '1K-10K';
  return '10K+';
}
