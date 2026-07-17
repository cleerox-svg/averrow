/**
 * Brand Enrichment — Sessions A + B
 * Session A: logo_url, website_url, hq_lat, hq_lng, hq_country
 *   via Clearbit Logo API + DNS resolution.
 * Session B: sector (Haiku classification), registrar, registered_at,
 *   expires_at, registrant_country via IANA RDAP.
 */

import { resolveToIp, extractHostname } from "./domain-resolver";
import type { Env } from "../types";
import { callAnthropicText, type AnthropicEnv } from "./anthropic";
import { HOT_PATH_HAIKU } from "./ai-models";

// ── Canonical sector taxonomy ────────────────────────────────────
// Consistent values across the platform. Anything Haiku returns that's
// not in this list is coerced to "other".
export const SECTORS = [
  "finance",     // banks, payments, crypto, insurance
  "tech",        // software, SaaS, cloud, dev tools
  "ecommerce",   // retail, marketplaces, shopping
  "social",      // social networks, messaging, dating
  "media",       // news, streaming, entertainment
  "healthcare",  // pharma, health tech, medical
  "government",  // gov portals, public services
  "logistics",   // shipping, delivery, freight
  "telecom",     // carriers, ISPs, VoIP
  "gaming",      // games, esports, gaming platforms
  "education",   // edtech, universities, learning
  "travel",      // airlines, hotels, booking
  "energy",      // utilities, oil, renewable
  "legal",       // law firms, legal tech
  "other",       // catch-all
] as const;

export type Sector = (typeof SECTORS)[number];

// ── Heuristic sector classifier ─────────────────────────────────
// High-precision pre-filter: matches only obvious cases (TLDs that
// guarantee a sector, brand names containing unambiguous tokens).
// Returns null when ambiguous so the caller falls through to AI.
//
// Designed for ~30% hit rate on the Tranco top 100K, cutting AI
// spend on the long tail without sacrificing precision (false
// positives go straight into the brands.sector column and stay
// there). All matches use word-boundary or TLD-suffix logic.
export function heuristicClassifySector(domain: string, brandName: string): Sector | null {
  const d = domain.toLowerCase();
  const n = brandName.toLowerCase();

  // ── TLD-driven (highest precision) ──
  if (/(^|\.)gov(\.[a-z]{2,3})?$/.test(d)) return 'government';
  if (/(^|\.)mil(\.[a-z]{2,3})?$/.test(d)) return 'government';
  if (/(^|\.)edu(\.[a-z]{2,3})?$/.test(d)) return 'education';
  if (/(^|\.)ac\.[a-z]{2,3}$/.test(d))     return 'education';

  // ── Word-boundary token matching on brand name ──
  const has = (re: RegExp) => re.test(n);

  // Finance — banks, credit unions, insurance, payment, crypto
  if (has(/\b(bank|banque|banco)\b/)) return 'finance';
  if (has(/\bcredit\s*union\b/))      return 'finance';
  if (has(/\binsurance\b/))           return 'finance';
  if (has(/\b(crypto|coin|exchange|wallet)\b/) && has(/\b(coin|crypto|exchange|swap)\b/)) return 'finance';

  // Healthcare
  if (has(/\b(hospital|clinic|medical|pharma|pharmacy|health)\b/)) return 'healthcare';

  // Education
  if (has(/\b(university|college|academy|school)\b/)) return 'education';

  // Government (non-TLD signals)
  if (has(/\b(ministry|department\s+of|federal|municipal)\b/)) return 'government';

  // Travel
  if (has(/\b(airline|airways|airlines|hotel|airport|cruise|booking)\b/)) return 'travel';

  // Telecom
  if (has(/\b(telecom|mobile|wireless|broadband|cable\s*co)\b/)) return 'telecom';

  // Gaming
  if (has(/\b(games?|gaming|esports|playstation|xbox)\b/)) return 'gaming';

  // Energy / utilities
  if (has(/\b(energy|electric|gas\s*co|utility|power\s*co|solar)\b/)) return 'energy';

  // Media
  if (has(/\b(news|times|post|tribune|herald|press|tv|radio|broadcasting)\b/)) return 'media';

  // No confident match — let AI decide
  return null;
}

export interface BrandEnrichmentResult {
  logo_url:    string | null;
  website_url: string | null;
  hq_ip:       string | null;
  hq_lat:      number | null;
  hq_lng:      number | null;
  hq_country:  string | null;
}

// ── Logo URL ─────────────────────────────────────────────────────
// Clearbit Logo API returns PNG if found, 404 if not.
// We verify it resolves before storing.
async function resolveLogoUrl(domain: string): Promise<string | null> {
  const url = `https://logo.clearbit.com/${domain}`;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

// ── GeoIP for brand HQ ───────────────────────────────────────────
interface HqGeo {
  ip:      string;
  lat:     number;
  lng:     number;
  country: string;
}

async function resolveHqGeo(
  domain: string,
  cache: KVNamespace,
  env: Env,
): Promise<HqGeo | null> {
  const hostname = extractHostname(domain);
  if (!hostname) return null;

  // Check KV cache first
  const cacheKey = `hq_geo:${hostname}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as HqGeo;
    } catch {
      /* ignore */
    }
  }

  const ip = await resolveToIp(hostname);
  if (!ip) return null;

  // Use ipinfo.io with the existing token (same as the main threat-geo
  // pipeline). The free ipapi.co tier was rate-limiting every call to
  // null which caused brands to be marked enriched without any data.
  const token = env.IPINFO_TOKEN ?? "";
  const url = token
    ? `https://ipinfo.io/${ip}/json?token=${token}`
    : `https://ipinfo.io/${ip}/json`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      loc?:     string;
      country?: string;
      error?:   boolean;
      bogon?:   boolean;
    };
    if (data.error || data.bogon || !data.loc) return null;
    const parts = data.loc.split(",");
    if (parts.length !== 2) return null;
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (isNaN(lat) || isNaN(lng)) return null;

    const result: HqGeo = { ip, lat, lng, country: data.country ?? "" };
    await cache.put(cacheKey, JSON.stringify(result), {
      expirationTtl: 604800,
    });
    return result;
  } catch {
    return null;
  }
}

// ── Main enrichment function ──────────────────────────────────────
export async function enrichBrand(
  domain: string,
  cache: KVNamespace,
  env: Env,
): Promise<BrandEnrichmentResult> {
  // Run logo + geo in parallel
  const [logoResult, hqResult] = await Promise.allSettled([
    resolveLogoUrl(domain),
    resolveHqGeo(domain, cache, env),
  ]);

  const logoUrl =
    logoResult.status === "fulfilled" ? logoResult.value : null;
  const hqGeo =
    hqResult.status === "fulfilled" ? hqResult.value : null;

  return {
    logo_url:    logoUrl,
    website_url: `https://${domain}`,
    hq_ip:       hqGeo?.ip ?? null,
    hq_lat:      hqGeo?.lat ?? null,
    hq_lng:      hqGeo?.lng ?? null,
    hq_country:  hqGeo?.country ?? null,
  };
}

// ── RDAP registrant data ─────────────────────────────────────────
// IANA's free structured WHOIS replacement. https://rdap.org/domain/{domain}
// returns JSON with registrar, registration/expiry dates, registrant country.
export interface RdapResult {
  registrar:          string | null;
  registered_at:      string | null; // ISO date (YYYY-MM-DD)
  expires_at:         string | null; // ISO date (YYYY-MM-DD)
  registrant_country: string | null;
}

export async function fetchRdap(domain: string): Promise<RdapResult> {
  const empty: RdapResult = {
    registrar:          null,
    registered_at:      null,
    expires_at:         null,
    registrant_country: null,
  };

  try {
    const res = await fetch(
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      {
        headers: { Accept: "application/json" },
        signal:  AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) return empty;
    const data = (await res.json()) as Record<string, unknown>;

    // Extract registrar from entities array (role = "registrar")
    let registrar: string | null = null;
    const entities = data.entities as
      | Array<Record<string, unknown>>
      | undefined;
    if (entities) {
      const registrarEntity = entities.find(
        e =>
          Array.isArray(e.roles) &&
          (e.roles as string[]).includes("registrar"),
      );
      if (registrarEntity?.vcardArray) {
        const vcard = registrarEntity.vcardArray as unknown[][];
        const props = vcard[1];
        if (Array.isArray(props)) {
          const fn = props.find(
            (v: unknown) => Array.isArray(v) && (v as unknown[])[0] === "fn",
          ) as unknown[] | undefined;
          if (fn && typeof fn[3] === "string") {
            registrar = fn[3];
          }
        }
      }
    }

    // Extract dates from events array
    let registered_at: string | null = null;
    let expires_at:    string | null = null;
    const events = data.events as
      | Array<{ eventAction: string; eventDate: string }>
      | undefined;

    if (events) {
      const reg = events.find(e => e.eventAction === "registration");
      const exp = events.find(e => e.eventAction === "expiration");
      registered_at = reg?.eventDate?.slice(0, 10) ?? null;
      expires_at    = exp?.eventDate?.slice(0, 10) ?? null;
    }

    // Registrant country — vcard "adr" property, country-name subfield
    let registrant_country: string | null = null;
    if (entities) {
      const registrantEntity = entities.find(
        e =>
          Array.isArray(e.roles) &&
          (e.roles as string[]).includes("registrant"),
      );
      if (registrantEntity?.vcardArray) {
        const vcard = registrantEntity.vcardArray as unknown[][];
        const props = vcard[1];
        if (Array.isArray(props)) {
          const adr = props.find(
            (v: unknown) => Array.isArray(v) && (v as unknown[])[0] === "adr",
          ) as unknown[] | undefined;
          if (adr && typeof adr[3] === "object" && adr[3] !== null) {
            const params = adr[3] as Record<string, string>;
            registrant_country = params["country-name"] ?? null;
          }
          // Some RDAP servers put the country in a structured "adr" array
          // at position [4] with 7 fields. Country is the last element.
          if (!registrant_country && adr && Array.isArray(adr[3])) {
            const structured = adr[3] as string[];
            const country = structured[structured.length - 1];
            if (country && country.length <= 3) {
              registrant_country = country;
            }
          }
        }
      }
    }

    return { registrar, registered_at, expires_at, registrant_country };
  } catch {
    return empty;
  }
}

// ── Sector classification via Claude Haiku ───────────────────────
// One cheap Haiku call per brand. Fetches website <title> for extra
// context (best-effort). Returns a canonical Sector, or null if the
// call failed entirely. Uses the canonical Anthropic wrapper so the
// call lands in budget_ledger automatically; pass the live Env binding
// rather than just the bare API key.
export async function classifySector(
  env: AnthropicEnv,
  domain: string,
  brandName: string,
): Promise<Sector | null> {
  try {
    // Fetch website title for extra context (best-effort)
    let title = "";
    try {
      const res = await fetch(`https://${domain}`, {
        signal:  AbortSignal.timeout(3000),
        headers: { "User-Agent": "Averrow/1.0 brand-classifier" },
      });
      if (res.ok) {
        const html = await res.text();
        const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        title = match?.[1]?.trim().slice(0, 200) ?? "";
      }
    } catch {
      /* title fetch failed — classify on domain only */
    }

    const prompt = `Classify this brand into exactly one sector from this list:
${SECTORS.join(", ")}

Brand: ${brandName}
Domain: ${domain}
${title ? `Website title: ${title}` : ""}

Respond with ONLY the sector name, nothing else. Pick "other" if unsure.`;

    const { text } = await callAnthropicText(env, {
      agentId: "brand-enricher",
      runId: null,
      model: HOT_PATH_HAIKU,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 20,
      timeoutMs: 8_000,
    });

    const raw = text.trim().toLowerCase();
    // Validate it's a known sector; coerce anything unknown to "other"
    return SECTORS.includes(raw as Sector) ? (raw as Sector) : "other";
  } catch {
    return null;
  }
}
