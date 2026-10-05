// Registrable domain ("eTLD+1") for the public free scan and lead
// auto-delivery, from a small built-in public-suffix table — no
// dependency on the full PSL.
//
//   registrableDomain("shop.acme.com")    → "acme.com"
//   registrableDomain("mail.acme.co.uk")  → "acme.co.uk"
//   registrableDomain("co.uk")            → null (a suffix, not registrable)
//
// Coverage: the explicit multi-label suffixes below, plus a heuristic for
// "<generic second level>.<two-letter ccTLD>" (com.tr, co.th, org.pe …),
// which is how most ccTLD registries that use second levels name them.
// Anything else is treated as a single-label suffix. Mistakes here fail
// safe for auto-delivery: a wrongly-short suffix makes two unrelated
// names share a registrable domain, so emailMatchesScannedDomain also
// requires an EXACT host match and refuses provider/tenant domains.

/** Explicit multi-label public suffixes (ICANN second levels + CentralNic). */
export const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  // UK
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk", "nhs.uk", "police.uk", "mod.uk",
  // Australia / NZ
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "ac.nz", "govt.nz", "school.nz", "geek.nz",
  // Japan
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp", "lg.jp",
  // Korea
  "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr", "re.kr",
  // China / HK / TW / SG / MY
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  "com.hk", "net.hk", "org.hk", "edu.hk", "gov.hk",
  "com.tw", "net.tw", "org.tw", "edu.tw", "gov.tw", "idv.tw",
  "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg",
  "com.my", "net.my", "org.my", "edu.my", "gov.my",
  // India
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "gov.in", "res.in",
  // Americas
  "com.br", "net.br", "org.br", "gov.br", "edu.br",
  "com.mx", "net.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "net.ar", "org.ar", "gob.ar", "com.co", "net.co", "org.co", "gov.co",
  "com.pe", "com.ve", "com.uy", "com.ec",
  // Africa / Middle East
  "co.za", "org.za", "net.za", "gov.za", "ac.za", "web.za",
  "com.ng", "com.eg", "co.ke", "or.ke", "co.tz", "co.ug",
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  "com.sa", "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
  "com.pk", "com.bd", "com.ph", "com.vn", "co.th", "in.th", "ac.th", "go.th", "co.id", "or.id", "ac.id", "go.id",
  // Europe
  "co.at", "or.at", "com.pl", "net.pl", "org.pl", "com.ua", "co.ua", "com.gr", "com.cy", "com.mt", "co.hu",
  // CentralNic / private-registry second levels sold as "domains"
  "uk.com", "us.com", "eu.com", "gb.com", "gb.net", "uk.net", "de.com", "jpn.com", "br.com", "cn.com", "za.com",
]);

/** Second-level labels that ccTLD registries commonly use as public suffixes. */
const GENERIC_SECOND_LEVELS: ReadonlySet<string> = new Set([
  "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc", "sch",
]);

/** True when `name` (lowercase, no trailing dot) is itself a public suffix. */
export function isPublicSuffix(name: string): boolean {
  const labels = name.split(".");
  if (labels.length === 1) return true;
  if (labels.length !== 2) return false;
  if (MULTI_LABEL_SUFFIXES.has(name)) return true;
  return GENERIC_SECOND_LEVELS.has(labels[0]!) && /^[a-z]{2}$/.test(labels[1]!);
}

/**
 * The registrable domain of an already-normalised hostname, or null when
 * the hostname is itself a public suffix (co.uk, com) or empty.
 */
export function registrableDomain(host: string): string | null {
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  const suffixLabels = isPublicSuffix(lastTwo) ? 2 : 1;
  if (labels.length <= suffixLabels) return null;
  return labels.slice(-(suffixLabels + 1)).join(".");
}
