/**
 * Threat Scoring & Classification — Centralized quality pipeline.
 *
 * Applied automatically by insertThreat() as defaults when feeds
 * don't provide their own scores. Also used for backfill queries.
 */

// ─── Confidence Score Calibration ────────────────────────────────

const SOURCE_BASELINE: Record<string, number> = {
  urlhaus: 80,
  malwarebazaar: 85,
  threatfox: 75,
  phishtank: 70,
  openphish: 65,
  phishdestroy: 60,
  sslbl: 70,
  ct_logs: 40,
  dshield: 50,
  cins_army: 55,
  feodo: 85,
  otx_alienvault: 60,
  cisa_kev: 70,
};

const TYPE_MODIFIER: Record<string, number> = {
  phishing: 10,
  c2: 15,
  malware_distribution: 10,
  typosquatting: -10,
  credential_harvesting: 10,
  malicious_ip: 0,
  scanning: -5,
  botnet: 15,
  malicious_ssl: 5,
  impersonation: 5,
};

/** Calculate confidence score from source + type + brand presence */
export function calculateConfidence(
  sourceFeed: string,
  threatType: string,
  hasBrand: boolean,
): number {
  const base = SOURCE_BASELINE[sourceFeed] ?? 50;
  const typeMod = TYPE_MODIFIER[threatType] ?? 0;
  const brandMod = hasBrand ? 10 : 0;
  return Math.min(100, Math.max(0, base + typeMod + brandMod));
}

// ─── Severity Assignment ─────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** Derive severity from confidence score */
export function calculateSeverity(confidenceScore: number): Severity {
  if (confidenceScore >= 80) return "critical";
  if (confidenceScore >= 60) return "high";
  if (confidenceScore >= 40) return "medium";
  if (confidenceScore >= 20) return "low";
  return "info";
}

// ─── Threat Type Reclassification Heuristics ─────────────────────

const CREDENTIAL_HARVEST_PATTERNS = /\/wp-admin|\/wp-login|\/login|\/signin|\/auth/i;
const MALWARE_EXT_PATTERNS = /\.exe(?:\?|$)|\.dll(?:\?|$)|\.zip(?:\?|$)|\.iso(?:\?|$)|\.msi(?:\?|$)|\.scr(?:\?|$)|\.bat(?:\?|$)/i;
const SUSPICIOUS_TLDS = /\.(top|xyz|buzz|tk|ml|ga|cf|gq|pw|club|icu|wang|work|surf|rest)$/i;
const RANDOM_DOMAIN_PATTERN = /^[a-z0-9]{12,}\.(top|xyz|buzz|tk|pw|club|icu)$/i;

/**
 * Quick heuristic reclassification — first-pass before AI Analyst.
 * Returns a new threat_type if heuristics match, or null to keep original.
 */
export function reclassifyThreatType(
  currentType: string,
  url: string | null,
  domain: string | null,
): string | null {
  // URL-based reclassification
  if (url) {
    if (CREDENTIAL_HARVEST_PATTERNS.test(url) && currentType !== "credential_harvesting") {
      return "credential_harvesting";
    }
    if (MALWARE_EXT_PATTERNS.test(url) && currentType !== "malware_distribution") {
      return "malware_distribution";
    }
  }

  // Domain-based reclassification
  if (domain) {
    // Random-looking domain with suspicious TLD → likely C2
    if (RANDOM_DOMAIN_PATTERN.test(domain) && currentType !== "c2") {
      return "c2";
    }
  }

  return null;
}

// ─── CT Log Brand Domain Matching ────────────────────────────────

/** Known legitimate domains owned by major brands */
export const KNOWN_BRAND_DOMAINS: Record<string, string[]> = {
  apple: ["apple.com", "icloud.com", "apple-dns.net", "mzstatic.com", "apple.news"],
  google: ["google.com", "googleapis.com", "googleusercontent.com", "gstatic.com", "youtube.com", "gmail.com", "googlevideo.com", "googleadservices.com", "google-analytics.com", "googlesyndication.com"],
  amazon: ["amazon.com", "amazonaws.com", "amazonses.com", "cloudfront.net", "amazon.co.uk", "amazon.de", "amazon.co.jp", "a2z.com"],
  microsoft: ["microsoft.com", "azure.com", "office.com", "outlook.com", "live.com", "windows.net", "microsoftonline.com", "office365.com", "azure-api.net", "msedge.net", "sharepoint.com"],
  facebook: ["facebook.com", "fbcdn.net", "instagram.com", "whatsapp.com", "meta.com", "fb.com", "facebookcorewwi.onion"],
  netflix: ["netflix.com", "nflxvideo.net", "nflximg.net", "nflxext.com", "nflxso.net"],
  roblox: ["roblox.com", "rbxcdn.com", "roblox.qq.com"],
  discord: ["discord.com", "discordapp.com", "discord.gg", "discord.media"],
  paypal: ["paypal.com", "paypalobjects.com", "paypal.me", "braintreegateway.com"],
  docusign: ["docusign.com", "docusign.net"],
  chase: ["chase.com", "jpmorgan.com", "jpmorganchase.com"],
  wellsfargo: ["wellsfargo.com", "wf.com"],
  bankofamerica: ["bankofamerica.com", "bofa.com", "bofasecure.com"],
};

/** Suspicious words that boost typosquat suspicion score */
const SUSPICIOUS_WORDS = /(?:login|verify|secure|update|account|signin|confirm|suspend|alert|recover|unlock|validate|billing|support|helpdesk|reset|password)/i;

/**
 * Check if a domain is a subdomain of any known brand domain.
 * Returns the brand keyword if matched, or null.
 */
export function isKnownBrandDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  for (const [brand, domains] of Object.entries(KNOWN_BRAND_DOMAINS)) {
    for (const owned of domains) {
      // Exact match or subdomain match
      if (d === owned || d.endsWith("." + owned)) {
        return brand;
      }
    }
  }
  return null;
}

/**
 * Master-brand alias resolver.
 *
 * Haiku occasionally returns sub-brand or service-name strings when
 * tagging threats — e.g. "Amazonses" for an Amazon SES phishing URL,
 * "Cloudfront" for an `*.cloudfront.net` lookalike, "Outlook" for an
 * O365 spoof. These aren't brands the customer wants in their inbox;
 * they should fold into the master brand (Amazon, Microsoft, etc.).
 *
 * Resolution order:
 *   1. If the raw name matches a master-brand key directly → use it.
 *   2. If the raw name matches the leading label of any known
 *      brand-owned domain (e.g. "amazonses" → "amazonses.com" in
 *      amazon's list) → use the master brand.
 *   3. If a domain was supplied, try `isKnownBrandDomain(domain)`.
 *   4. Otherwise return the original name unchanged.
 *
 * Returns a Title-Case display name (e.g. "Amazon").
 */
export function resolveMasterBrandName(
  rawName: string,
  domain?: string | null,
): string {
  if (!rawName || !rawName.trim()) return rawName;
  const stem = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  if (KNOWN_BRAND_DOMAINS[stem]) {
    return titleCase(stem);
  }

  for (const [master, domains] of Object.entries(KNOWN_BRAND_DOMAINS)) {
    if (master === stem) continue;
    for (const owned of domains) {
      // "amazonses" matches the leading label of "amazonses.com"
      const head = owned.split(".")[0]?.toLowerCase();
      if (head && head === stem) return titleCase(master);
    }
  }

  if (domain) {
    const matched = isKnownBrandDomain(domain);
    if (matched) return titleCase(matched);
  }

  return rawName;
}

/**
 * Calculate suspicion score for a domain suspected of typosquatting.
 * Higher = more suspicious. Only flag if >= 30.
 */
export function calculateSuspicionScore(
  domain: string,
  brandKeyword: string,
  isHomoglyph: boolean,
): number {
  let score = 0;

  // Known brand domain → auto-skip
  if (isKnownBrandDomain(domain) !== null) return -100;

  // Homoglyph variant (paypa1, rnicrosoft) → very suspicious
  if (isHomoglyph) score += 40;

  // Suspicious TLD
  if (SUSPICIOUS_TLDS.test(domain)) score += 20;

  // Contains full brand name + suspicious words
  if (domain.includes(brandKeyword) && SUSPICIOUS_WORDS.test(domain)) score += 25;

  // Contains brand keyword at all (baseline)
  if (domain.includes(brandKeyword)) score += 15;

  return score;
}
