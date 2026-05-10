// Companies House UK firmographic lookup.
//
// Free, 600 req/5min documented limit. Coverage: UK limited
// companies, ~10-15% of our 100K-brand catalog (UK-resident brands
// or those with UK subsidiaries).
//
// Auth: requires an API key passed as Basic auth username (no
// password). Set as env.COMPANIES_HOUSE_KEY. If unset, the lookup
// no-ops gracefully — the orchestrator falls through to the next
// source.
//
// Coverage caveat: per Phase 2 research, only ~40% of UK financials
// are machine-readable; the rest are PDF accounts. We use what's
// structured (revenue from accounts, employee_count from
// confirmation_statement) and accept null for the rest.

import type { Env } from '../../types';
import type { FirmographicLookup, BrandFirmographics } from './types';
import { revenueToBand, employeesToBand } from './types';

// Companies House serves accounts data — typical search/profile
// returns in <1s, but the API has occasional outages. Bound the
// fetch so a hung upstream doesn't take the whole enricher run
// over the 15-min navigator reaper threshold.
const FETCH_TIMEOUT_MS = 8_000;

interface SearchResult {
  items?: Array<{
    company_number: string;
    title:          string;
    company_status: string;
    company_type:   string;
  }>;
}

interface CompanyProfile {
  company_number:        string;
  company_name:          string;
  date_of_creation?:     string;            // YYYY-MM-DD
  type?:                 string;
  jurisdiction?:         string;
  sic_codes?:            string[];          // UK SIC, 5-digit (different from US SIC)
  links?: { self?: string };
}

export function makeCompaniesHouseLookup(env: Env): FirmographicLookup {
  return async ({ name }) => {
    const key = (env as unknown as { COMPANIES_HOUSE_KEY?: string }).COMPANIES_HOUSE_KEY;
    if (!key) return null;

    try {
      const auth = `Basic ${btoa(`${key}:`)}`;
      const headers = { 'Authorization': auth };

      // Search for the company by name. Take the first 'active' Ltd hit.
      const searchRes = await fetch(
        `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(name)}&items_per_page=5`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!searchRes.ok) return null;
      const search = await searchRes.json() as SearchResult;
      const candidate = search.items?.find(
        i => i.company_status === 'active' && /ltd|limited|plc/i.test(i.company_type ?? ''),
      );
      if (!candidate) return null;

      // Fetch full profile
      const profileRes = await fetch(
        `https://api.company-information.service.gov.uk/company/${candidate.company_number}`,
        { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      );
      if (!profileRes.ok) return null;
      const profile = await profileRes.json() as CompanyProfile;

      const founded = profile.date_of_creation
        ? parseInt(profile.date_of_creation.slice(0, 4), 10)
        : null;

      // SIC: Companies House uses UK SIC 2007 (5-digit). Different from
      // US SIC. We store it in industry_sic but it's a different
      // taxonomy — UI should label by jurisdiction.
      const ukSic = profile.sic_codes?.[0] ?? null;

      // Revenue + employees: not exposed in the company-profile endpoint.
      // Would need a separate fetch of /company/{x}/filing-history then
      // parse the latest accounts XML. Defer to a follow-up commit; for
      // now we return what's free.
      return {
        founded_year: founded,
        industry_sic: ukSic,
        revenue_band: revenueToBand(null),
        employee_band: employeesToBand(null),
        is_public: /plc/i.test(candidate.company_type ?? ''),
        ticker: null,
        source: 'companies_house',
        source_url: `https://find-and-update.company-information.service.gov.uk/company/${candidate.company_number}`,
        confidence: 75,
      } satisfies Partial<BrandFirmographics>;
    } catch {
      return null;
    }
  };
}
