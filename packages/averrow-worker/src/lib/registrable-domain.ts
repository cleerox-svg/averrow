// Registrable domain ("eTLD+1") for the public free scan and lead
// auto-delivery, from a small built-in public-suffix table — no
// dependency on the full PSL.
//
//   registrableDomain("shop.acme.com")       → "acme.com"
//   registrableDomain("mail.acme.co.uk")     → "acme.co.uk"
//   registrableDomain("acme.adv.br")         → "acme.adv.br"
//   registrableDomain("shop.myshopify.com")  → "shop.myshopify.com"
//   registrableDomain("co.uk")               → null (a suffix, not registrable)
//
// Rules, in order:
//   1. Tenant hosts: a subdomain of a multi-tenant SaaS / hosting suffix
//      (TENANT_HOST_SUFFIXES) is its own registrable name — the tenant,
//      not the provider, is what a scan of shop.myshopify.com is about.
//      The provider's own domain (myshopify.com) stays registrable.
//      Auto-delivery still refuses tenant hosts: lib/freemail.ts
//      isSaasTenantDomain checks every parent of the host.
//   2. Known suffixes: the explicit multi-label suffixes below, plus
//      "<generic second level>.<two-letter ccTLD>" (com.tr, co.th, org.pe …)
//      for ccTLDs that are NOT open at the second level — so nic.io,
//      co.de and mil.ru are ordinary registrable names.
//   3. Otherwise, for a host of 3+ labels under a two-letter ccTLD whose
//      registry is not known to register directly at the second level
//      (DIRECT_SECOND_LEVEL_CCTLDS), keep 3 labels: the second level is
//      probably an unlisted category (acme.tokyo.jp, acme.eng.br).
//      Everything else keeps 2 labels.
// Mistakes here fail safe for auto-delivery: emailMatchesScannedDomain
// also requires an EXACT host match and refuses provider/tenant domains.

/** Explicit multi-label public suffixes (ICANN second levels + CentralNic). */
export const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  // UK
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk", "nhs.uk", "police.uk", "mod.uk",
  // Austria / France / Belgium / Switzerland (generic second levels under direct-sale ccTLDs)
  "ac.at", "gv.at", "co.at", "or.at", "gouv.fr", "asso.fr", "nom.fr", "tm.fr", "presse.fr", "ac.be",
  // Australia / NZ
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "ac.nz", "govt.nz", "school.nz", "geek.nz", "gen.nz", "kiwi.nz", "maori.nz", "iwi.nz",
  "cri.nz", "health.nz", "mil.nz", "parliament.nz",
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
  "adv.br", "eng.br", "art.br", "arq.br", "med.br", "odo.br", "vet.br", "psc.br", "blog.br", "wiki.br", "ind.br",
  "inf.br", "tur.br", "tv.br", "ong.br", "agr.br", "esp.br", "eco.br", "app.br", "dev.br", "log.br", "nom.br", "mus.br",
  "ab.ca", "bc.ca", "mb.ca", "nb.ca", "nf.ca", "nl.ca", "ns.ca", "nt.ca", "nu.ca", "on.ca", "pe.ca", "qc.ca", "sk.ca", "yk.ca", "gc.ca",
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
  "com.es", "nom.es", "org.es", "gob.es", "edu.es", "com.pt", "org.pt", "gov.pl", "edu.pl", "co.no", "gob.cl", "edu.co", "mil.co", "nom.co", "msk.ru", "spb.ru", "com.ru", "net.ru", "org.ru",
  // CentralNic / private-registry second levels sold as "domains"
  "uk.com", "us.com", "eu.com", "gb.com", "gb.net", "uk.net", "de.com", "jpn.com", "br.com", "cn.com", "za.com",
]);

/** Second-level labels that ccTLD registries commonly use as public suffixes. */
const GENERIC_SECOND_LEVELS: ReadonlySet<string> = new Set([
  "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc", "sch",
]);

/**
 * Two-letter ccTLDs whose registry sells names directly at the second
 * level (acme.de, nic.io) and whose second-level categories, if any, are
 * listed in MULTI_LABEL_SUFFIXES. Under these the generic second-level
 * heuristic does NOT apply and an unlisted second label is a registrable
 * name. A ccTLD not listed here gets the 3-label rule instead.
 */
export const DIRECT_SECOND_LEVEL_CCTLDS: ReadonlySet<string> = new Set([
  "ac", "ad", "ag", "ai", "am", "as", "at", "au", "be", "bg", "by", "bz", "ca", "cc", "cd", "ch", "cl", "co", "cx", "cz",
  "de", "dk", "ee", "es", "eu", "fi", "fm", "fr", "ge", "gg", "gl", "gs", "gy", "hk", "hn", "hr", "ie", "im", "in", "io",
  "is", "it", "je", "kz", "la", "li", "lt", "lu", "lv", "ly", "ma", "md", "me", "mk", "mn", "ms", "mu", "mx", "nl", "no",
  "nu", "nz", "pl", "pm", "pt", "pw", "re", "ro", "rs", "ru", "sc", "se", "sg", "sh", "si", "sk", "sm", "so", "st", "su",
  "sx", "tc", "tf", "tk", "tl", "to", "tv", "uk", "us", "vc", "vg", "wf", "ws", "yt",
]);

/**
 * Multi-tenant SaaS / hosting suffixes whose subdomains are customer
 * tenants (PSL "private" section style). Kept in sync with the tenant
 * hosts in lib/freemail.ts SAAS_TENANT_DOMAINS, which also lists vendor
 * domains whose subdomains are NOT tenants (salesforce.com, hubspot.com).
 */
export const TENANT_HOST_SUFFIXES: ReadonlySet<string> = new Set([
  "myshopify.com", "github.io", "gitlab.io", "bitbucket.io", "herokuapp.com",
  "zendesk.com", "freshdesk.com", "freshservice.com", "helpscoutdocs.com", "kayako.com", "zohodesk.com",
  "my.salesforce.com", "force.com", "hs-sites.com",
  "onmicrosoft.com", "sharepoint.com", "azurewebsites.net", "cloudapp.net", "atlassian.net",
  "appspot.com", "web.app", "firebaseapp.com",
  "netlify.app", "netlify.com", "vercel.app", "pages.dev", "workers.dev", "fly.dev", "onrender.com",
  "glitch.me", "repl.co", "replit.app", "amplifyapp.com", "surge.sh", "ngrok.io", "ngrok-free.app",
  "wixsite.com", "wordpress.com", "blogspot.com", "tumblr.com", "webflow.io", "godaddysites.com", "site123.me",
  "bigcartel.com", "square.site", "carrd.co", "notion.site", "substack.com", "mailchimpsites.com",
]);

const isCcTld = (label: string): boolean => /^[a-z]{2}$/.test(label);

/** True when `name` (lowercase, no trailing dot) is itself a public suffix. */
export function isPublicSuffix(name: string): boolean {
  const labels = name.split(".");
  if (labels.length === 1) return true;
  if (labels.length !== 2) return false;
  if (MULTI_LABEL_SUFFIXES.has(name)) return true;
  const tld = labels[1]!;
  return isCcTld(tld) && !DIRECT_SECOND_LEVEL_CCTLDS.has(tld) && GENERIC_SECOND_LEVELS.has(labels[0]!);
}

/**
 * The registrable domain of an already-normalised hostname, or null when
 * the hostname is itself a public suffix (co.uk, com) or empty.
 */
export function registrableDomain(host: string): string | null {
  const labels = host.split(".").filter(Boolean);
  const n = labels.length;
  if (n < 2) return null;
  // 1. Tenant hosts: the longest tenant suffix the host sits strictly under.
  for (let i = 1; i < n - 1; i++) {
    if (TENANT_HOST_SUFFIXES.has(labels.slice(i).join("."))) return labels.slice(i - 1).join(".");
  }
  // 2. Known suffixes.
  if (isPublicSuffix(labels.slice(-2).join("."))) {
    return n <= 2 ? null : labels.slice(-3).join(".");
  }
  // 3. Unlisted second level under a structured ccTLD → keep 3 labels.
  const tld = labels[n - 1]!;
  if (n >= 3 && isCcTld(tld) && !DIRECT_SECOND_LEVEL_CCTLDS.has(tld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}
