// IANA RDAP bootstrap → per-TLD RDAP server resolver.
//
// rdap.org used to be our aggregator but they started returning
// HTTP 403 "Host not in allowlist" to Cloudflare Workers some
// time before 2026-05-16. That blocked 100% of our WHOIS
// enrichment — the threats table had registrar populated on
// 0/355,946 rows at audit time (PR-C). RDAP responses were all
// silently null and nobody noticed.
//
// IANA publishes the authoritative TLD → RDAP server map at
// https://data.iana.org/rdap/dns.json. We cache it in KV for 7
// days (it changes monthly at most) and resolve domain → TLD →
// server directly. No more aggregator dependency, no allowlist
// games. Each TLD's RDAP server accepts standard RDAP queries.

import type { Env } from "../types";

const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_KV_KEY = "rdap:bootstrap:v1";
const BOOTSTRAP_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Static fallback for the top TLDs in case the IANA bootstrap fetch
// fails (sandbox eaten, IANA transient, etc.). Hand-curated from
// IANA's published map. Covers the long tail of impersonation
// domains we see; less-common ccTLDs fall through to "no RDAP server"
// rather than crash the enrichment pipeline.
const STATIC_FALLBACK: Record<string, string> = {
  com:  "https://rdap.verisign.com/com/v1/",
  net:  "https://rdap.verisign.com/net/v1/",
  org:  "https://rdap.publicinterestregistry.org/rdap/",
  info: "https://rdap.identitydigital.services/rdap/",
  biz:  "https://rdap.nic.biz/",
  io:   "https://rdap.identitydigital.services/rdap/",
  co:   "https://rdap.nic.co/",
  app:  "https://rdap.nic.google/",
  dev:  "https://rdap.nic.google/",
  xyz:  "https://rdap.centralnic.com/xyz/",
  online: "https://rdap.centralnic.com/online/",
  site: "https://rdap.centralnic.com/site/",
  shop: "https://rdap.centralnic.com/shop/",
  store: "https://rdap.centralnic.com/store/",
  top:  "https://rdap.nic.top/",
  club: "https://rdap.nic.club/",
  uk:   "https://rdap.nominet.uk/uk/",
  de:   "https://rdap.denic.de/",
  fr:   "https://rdap.nic.fr/",
  ca:   "https://rdap.cira.ca/rdap/",
  au:   "https://rdap.auda.org.au/",
  nl:   "https://rdap.sidn.nl/",
  pl:   "https://rdap.dns.pl/",
  ru:   "https://api.rdap.nic.ru/",
  cn:   "https://rdap.cnnic.cn/",
  jp:   "https://rdap.jprs.jp/",
  br:   "https://rdap.registro.br/",
  it:   "https://rdap.nic.it/",
  es:   "https://rdap.nic.es/",
  mx:   "https://rdap.mx/",
};

// Shape of IANA bootstrap: { services: [ [tlds[], servers[]], ... ] }
interface IanaBootstrap {
  services: Array<[string[], string[]]>;
}

interface BootstrapCacheEntry {
  bootstrap: IanaBootstrap;
  t: number;
}

let memoryBootstrap: BootstrapCacheEntry | null = null;

async function loadBootstrap(env: Env): Promise<IanaBootstrap | null> {
  if (memoryBootstrap && Date.now() - memoryBootstrap.t < BOOTSTRAP_TTL_SECONDS * 1000) {
    return memoryBootstrap.bootstrap;
  }
  try {
    const cached = await env.CACHE.get(BOOTSTRAP_KV_KEY);
    if (cached) {
      const entry = JSON.parse(cached) as BootstrapCacheEntry;
      if (Date.now() - entry.t < BOOTSTRAP_TTL_SECONDS * 1000) {
        memoryBootstrap = entry;
        return entry.bootstrap;
      }
    }
  } catch {
    // KV transient or malformed cache — fall through to refetch.
  }

  try {
    const res = await fetch(BOOTSTRAP_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const bootstrap = (await res.json()) as IanaBootstrap;
    const entry: BootstrapCacheEntry = { bootstrap, t: Date.now() };
    memoryBootstrap = entry;
    try {
      await env.CACHE.put(BOOTSTRAP_KV_KEY, JSON.stringify(entry), {
        expirationTtl: BOOTSTRAP_TTL_SECONDS * 2,
      });
    } catch {
      // Cache write failure is non-fatal; we still have in-memory.
    }
    return bootstrap;
  } catch {
    return null;
  }
}

/**
 * Resolve a domain's TLD to its authoritative RDAP base URL.
 * Returns null if no server is registered for the TLD.
 *
 * Example: `getRdapServerForDomain(env, "foo.com")` →
 *   "https://rdap.verisign.com/com/v1/"
 */
export async function getRdapServerForDomain(
  env: Env,
  domain: string,
): Promise<string | null> {
  const tld = domain.split(".").pop()?.toLowerCase();
  if (!tld) return null;

  const bootstrap = await loadBootstrap(env);
  if (bootstrap) {
    for (const [tlds, servers] of bootstrap.services) {
      if (tlds.includes(tld) && servers.length > 0) {
        // Prefer https; fall back to first listed.
        const httpsServer = servers.find((s) => s.startsWith("https://"));
        return httpsServer ?? servers[0] ?? null;
      }
    }
  }

  // Bootstrap fetch failed OR TLD not in the IANA map — fall back
  // to the static top-TLD list. Covers the long tail of phishing
  // domains we see (mostly .com / .net / .org / .io / .xyz / .top).
  return STATIC_FALLBACK[tld] ?? null;
}
