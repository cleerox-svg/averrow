// Wikidata SPARQL firmographic lookup.
//
// Free, no rate limits documented. Coverage: top brands with
// Wikidata items (~10-15% of our 100K-brand catalog — heavily
// skewed to Tranco top-10K).
//
// Strategy:
//   1. Query Wikidata for an item with the brand's domain in
//      P856 (official website) OR P1581 (official site URL).
//   2. Fetch the item's claims for revenue (P2139), employees
//      (P1128), inception (P571), industry (P452), parent (P749),
//      stock exchange (P414), ticker (P249).
//
// Returns null when no Wikidata item matches the domain. Wikidata
// covers ~110K business orgs total per Phase 2 research, so most
// of our long tail will miss; use this to fill the head.

import type { FirmographicLookup, BrandFirmographics } from './types';
import { revenueToBand, employeesToBand } from './types';

const SPARQL_URL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'Averrow Trust Radar firmographic-enricher (ops@averrow.com)';
// Wikidata SPARQL can hang on complex queries. 8s is generous —
// most successful queries return in <2s. A hung query would
// otherwise let the per-job loop exceed the 15-min navigator
// reaper threshold, killing the entire enricher run.
const FETCH_TIMEOUT_MS = 8_000;

interface SparqlBinding {
  type:  string;
  value: string;
}

interface SparqlResults {
  results?: { bindings?: Array<Record<string, SparqlBinding>> };
}

export const lookupWikidata: FirmographicLookup = async ({ domain }) => {
  try {
    // Wikidata stores official websites with the leading https:// in
    // some entries and bare domain in others. Match either by extracting
    // the domain portion via STRSTR.
    const sparql = `
      SELECT ?item ?itemLabel ?revenue ?employees ?inception ?industry ?industryLabel
             ?ticker ?parent ?parentLabel ?exchange ?exchangeLabel WHERE {
        ?item wdt:P856 ?website .
        FILTER(CONTAINS(STR(?website), "${escapeSparql(domain)}"))
        OPTIONAL { ?item wdt:P2139 ?revenue . }
        OPTIONAL { ?item wdt:P1128 ?employees . }
        OPTIONAL { ?item wdt:P571  ?inception . }
        OPTIONAL { ?item wdt:P452  ?industry . }
        OPTIONAL { ?item wdt:P249  ?ticker . }
        OPTIONAL { ?item wdt:P749  ?parent . }
        OPTIONAL { ?item wdt:P414  ?exchange . }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
      }
      LIMIT 1
    `;

    const res = await fetch(`${SPARQL_URL}?query=${encodeURIComponent(sparql)}&format=json`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/sparql-results+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json() as SparqlResults;
    const row = data.results?.bindings?.[0];
    if (!row) return null;

    const itemUri = row['item']?.value ?? null;
    const revenueRaw = row['revenue']?.value ? Number(row['revenue'].value) : null;
    const employeesRaw = row['employees']?.value ? Number(row['employees'].value) : null;
    const founded = row['inception']?.value ? parseInt(row['inception'].value.slice(0, 4), 10) : null;
    const industry = row['industryLabel']?.value ?? null;
    const ticker = row['ticker']?.value ?? null;
    const parent = row['parentLabel']?.value ?? null;
    const exchange = row['exchangeLabel']?.value ?? null;

    return {
      revenue_band: revenueToBand(revenueRaw),
      employee_band: employeesToBand(employeesRaw),
      founded_year: founded,
      industry_naics: null,    // Wikidata uses its own taxonomy, not NAICS
      industry_sic: industry,  // store the human-readable label in SIC slot for now
      is_public: !!exchange,
      ticker,
      parent_company: parent,
      source: 'wikidata',
      source_url: itemUri,
      confidence: 65,          // crowdsourced — slightly less than EDGAR
    } satisfies Partial<BrandFirmographics>;
  } catch {
    return null;
  }
};

function escapeSparql(s: string): string {
  return s.replace(/["\\]/g, m => '\\' + m);
}
