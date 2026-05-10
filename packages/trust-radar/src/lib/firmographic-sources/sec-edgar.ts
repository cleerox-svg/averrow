// SEC EDGAR firmographic lookup.
//
// Free, no rate limits documented (SEC requests "fair use" headers
// and a User-Agent identifying the requester). Coverage: US public
// companies only, ~5-8% of our 100K-brand catalog.
//
// Lookup flow:
//   1. Resolve domain → CIK via EDGAR's company-tickers.json (one
//      file, ~10K companies, refresh via KV cache).
//   2. CIK → company-facts JSON for revenue + employee count.
//
// Returns null when the domain doesn't match a US public co — most
// of our catalog. That's expected; the orchestrator falls through
// to the next source.

import type { FirmographicLookup, BrandFirmographics } from './types';
import { revenueToBand, employeesToBand } from './types';

const USER_AGENT = 'Averrow Trust Radar firmographic-enricher (ops@averrow.com)';

// Public ticker file maps ticker → CIK + company name + exchange.
// Re-fetched at most every 7 days (Tranco-rank-style cadence).
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

// SEC EDGAR is generally fast but the company-tickers download is
// ~1.5MB and CIK fact files can be larger; allow a slightly more
// generous timeout than other sources. Still well below the
// 15-min navigator reaper threshold.
const FETCH_TIMEOUT_MS = 10_000;

interface TickerRow {
  cik_str: number;
  ticker:  string;
  title:   string;
}

// Crude domain-to-name match. EDGAR's company name format ("APPLE
// INC", "MICROSOFT CORP") often matches our brand name with light
// normalization. False positives are minimized by the strict ticker
// shape — only US public co's get hits.
export const lookupSecEdgar: FirmographicLookup = async ({ domain, name }) => {
  try {
    const tickers = await fetchTickers();
    if (!tickers) return null;

    const normalized = normalizeName(name);
    const domainBase = domain.split('.')[0]?.toLowerCase() ?? '';

    let match: TickerRow | undefined;
    for (const row of Object.values(tickers)) {
      const t = row as TickerRow;
      const tNorm = normalizeName(t.title);
      if (tNorm === normalized) { match = t; break; }
      // Domain base match: 'apple' vs 'apple inc' / 'microsoft' vs 'microsoft corp'
      if (tNorm.startsWith(domainBase + ' ') || tNorm === domainBase) { match = t; break; }
    }
    if (!match) return null;

    const facts = await fetchCompanyFacts(match.cik_str);
    if (!facts) {
      // Still useful — we know it's public, ticker, and name
      return {
        is_public: true,
        ticker: match.ticker,
        source: 'sec_edgar',
        source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pad10(match.cik_str)}`,
        confidence: 70,
      } satisfies Partial<BrandFirmographics>;
    }

    const revenue = extractLatestUsdValue(facts, [
      'us-gaap:Revenues',
      'us-gaap:SalesRevenueNet',
      'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
    ]);
    const employees = extractLatestIntValue(facts, [
      'dei:EntityCommonStockSharesOutstanding', // not employees — placeholder; see below
    ]);
    // SEC tags employees inconsistently; for now leave employee_band null
    // unless we add a specific extractor. Most brand-fit decisions can
    // proceed on revenue + ticker alone.
    void employees;

    return {
      revenue_band: revenueToBand(revenue),
      industry_naics: facts.entityName ? null : null, // EDGAR exposes SIC, not NAICS
      industry_sic: facts.sic ?? null,
      is_public: true,
      ticker: match.ticker,
      source: 'sec_edgar',
      source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pad10(match.cik_str)}`,
      confidence: 90,
    } satisfies Partial<BrandFirmographics>;
  } catch {
    return null;
  }
};

// ─── Internals ─────────────────────────────────────────────────────

let _tickersCache: Record<string, TickerRow> | null = null;
let _tickersFetchedAt = 0;
const TICKERS_TTL_MS = 7 * 24 * 60 * 60_000;

async function fetchTickers(): Promise<Record<string, TickerRow> | null> {
  if (_tickersCache && Date.now() - _tickersFetchedAt < TICKERS_TTL_MS) {
    return _tickersCache;
  }
  const res = await fetch(TICKERS_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = await res.json() as Record<string, TickerRow>;
  _tickersCache = data;
  _tickersFetchedAt = Date.now();
  return data;
}

interface CompanyFacts {
  entityName?: string;
  sic?:        string;
  facts?: {
    'us-gaap'?: Record<string, FactConcept>;
    'dei'?:     Record<string, FactConcept>;
  };
}

interface FactConcept {
  units?: Record<string, FactDataPoint[]>;
}

interface FactDataPoint {
  val:   number;
  end?:  string;
  fy?:   number;
  form?: string;
}

async function fetchCompanyFacts(cik: number): Promise<CompanyFacts | null> {
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(cik)}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return res.json() as Promise<CompanyFacts>;
}

function extractLatestUsdValue(facts: CompanyFacts, conceptPaths: string[]): number | null {
  for (const path of conceptPaths) {
    const [taxonomy, concept] = path.split(':') as ['us-gaap' | 'dei', string];
    const conceptData = facts.facts?.[taxonomy]?.[concept];
    const usdSeries = conceptData?.units?.['USD'];
    if (!usdSeries || usdSeries.length === 0) continue;
    // Take latest annual 10-K filing
    const annual = usdSeries.filter(p => p.form === '10-K').sort(
      (a, b) => (b.fy ?? 0) - (a.fy ?? 0)
    );
    if (annual[0]) return annual[0].val;
  }
  return null;
}

function extractLatestIntValue(facts: CompanyFacts, conceptPaths: string[]): number | null {
  return extractLatestUsdValue(facts, conceptPaths);
}

function pad10(n: number): string {
  return String(n).padStart(10, '0');
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,'"`]/g, '')
    .replace(/\b(inc|corp|corporation|ltd|llc|plc|sa|ag|nv|gmbh|holdings?|co|company|the)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
