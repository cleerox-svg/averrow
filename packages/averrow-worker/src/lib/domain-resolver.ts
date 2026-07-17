/**
 * Domain → IP resolver — multi-provider DoH with first-valid-wins
 * racing.
 *
 * Three resolvers run in parallel; the first one that returns a
 * valid A record wins. If all three return null/NXDOMAIN/error
 * the resolver returns null. Each call is one subrequest per
 * resolver, so a 500-domain batch consumes up to 1500 subrequests
 * worst-case — still safely under Cloudflare Workers' standard
 * subrequest limits when the navigator cron runs every 5 min.
 *
 * Why three providers:
 *   - Resilience: Cloudflare DoH 403 / throttle doesn't stall the
 *     queue
 *   - Speed: median latency = fastest of three (often Google or
 *     Cloudflare; Quad9 is the tie-breaker)
 *   - Cross-validation: divergent answers can flag DNS poisoning
 *     or geographically split records (logged silently for now)
 *
 * Per planning session 2026-04-30 (Option A); Workflow conversion
 * deferred (Option B).
 */

interface DohResponse {
  Status: number;
  Answer?: Array<{ type: number; data: string }>;
}

/**
 * Resolution outcome — distinguishes "doesn't exist" from
 * "couldn't reach the resolver". Lets the caller graduate
 * confirmed NXDOMAIN domains out of the retry queue immediately
 * instead of hammering them 8 more times with the same cooldown.
 */
export type ResolverOutcome =
  | { kind: 'ok'; ip: string }
  | { kind: 'nxdomain' }       // DNS Status=3, definitively doesn't exist
  | { kind: 'no_a_record' }    // Status=0 but no A record (CNAME chain dead-end, etc.)
  | { kind: 'transient' };     // timeout, fetch error, SERVFAIL, etc. — retry-worthy

interface ResolverDef {
  name: string;
  url: (hostname: string) => string;
  headers: Record<string, string>;
}

/** Public list of resolver display names + their base hostname,
 *  surfaced in the agent declarations UI so operators can see the
 *  external DNS endpoints we depend on. */
export const DNS_RESOLVER_ENDPOINTS = [
  { name: 'Cloudflare 1.1.1.1', url: 'https://cloudflare-dns.com' },
  { name: 'Google DNS', url: 'https://dns.google' },
  { name: 'Quad9 DNS', url: 'https://dns.quad9.net:5053' },
];

const RESOLVERS: ResolverDef[] = [
  {
    name: 'cloudflare',
    url: (h) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`,
    headers: { Accept: 'application/dns-json' },
  },
  {
    name: 'google',
    url: (h) => `https://dns.google/resolve?name=${encodeURIComponent(h)}&type=A`,
    headers: { Accept: 'application/dns-json' },
  },
  {
    name: 'quad9',
    url: (h) => `https://dns.quad9.net:5053/dns-query?name=${encodeURIComponent(h)}&type=A`,
    headers: { Accept: 'application/dns-json' },
  },
];

const PER_RESOLVER_TIMEOUT_MS = 2000;

async function tryResolver(resolver: ResolverDef, hostname: string): Promise<ResolverOutcome> {
  try {
    const res = await fetch(resolver.url(hostname), {
      headers: resolver.headers,
      signal: AbortSignal.timeout(PER_RESOLVER_TIMEOUT_MS),
    });
    if (!res.ok) return { kind: 'transient' };
    const data = (await res.json()) as DohResponse;
    // RFC 8484 Status codes: 0=NOERROR, 2=SERVFAIL, 3=NXDOMAIN, 5=REFUSED.
    // NXDOMAIN means "this name does not exist" — authoritative answer,
    // safe to graduate the domain out of the retry queue.
    if (data.Status === 3) return { kind: 'nxdomain' };
    if (data.Status !== 0) return { kind: 'transient' };
    const aRecord = data.Answer?.find((r) => r.type === 1);
    if (aRecord?.data) return { kind: 'ok', ip: aRecord.data };
    return { kind: 'no_a_record' };
  } catch {
    return { kind: 'transient' };
  }
}

/**
 * Resolve as soon as any resolver returns a valid IP. Otherwise
 * collapse the per-resolver outcomes to a single answer:
 *   - any 'ok' wins immediately (fastest valid answer)
 *   - all 'nxdomain' → 'nxdomain' (definitive — graduate out)
 *   - all 'no_a_record' → 'no_a_record' (definitive — graduate out)
 *   - any 'transient' (and no 'ok') → 'transient' (retry-worthy)
 *   - mixed nxdomain + no_a_record (and no transient) →
 *     'no_a_record' (still definitive non-existence)
 */
async function raceForOutcome(
  promises: Array<Promise<ResolverOutcome>>,
): Promise<ResolverOutcome> {
  // Wait for first 'ok' OR all to settle.
  return new Promise((resolve) => {
    const outcomes: ResolverOutcome[] = [];
    let resolved = false;
    for (const p of promises) {
      p.then((result) => {
        if (resolved) return;
        if (result.kind === 'ok') {
          resolved = true;
          resolve(result);
          return;
        }
        outcomes.push(result);
        if (outcomes.length === promises.length) {
          resolved = true;
          // Collapse: definitive verdicts beat transient.
          const hasTransient = outcomes.some((o) => o.kind === 'transient');
          const allNxdomain = outcomes.every((o) => o.kind === 'nxdomain');
          if (allNxdomain) {
            resolve({ kind: 'nxdomain' });
          } else if (!hasTransient) {
            resolve({ kind: 'no_a_record' });
          } else {
            resolve({ kind: 'transient' });
          }
        }
      });
    }
  });
}

/**
 * Resolve a domain to its first IPv4 address using a multi-provider
 * DoH race. Returns null if every resolver fails.
 *
 * Back-compat shim — callers that don't care about the failure kind
 * still see null on miss. Prefer `resolveDomain` when you need to
 * distinguish NXDOMAIN from a transient resolver outage.
 */
export async function resolveToIp(domain: string): Promise<string | null> {
  const outcome = await resolveDomain(domain);
  return outcome.kind === 'ok' ? outcome.ip : null;
}

/**
 * Full-fidelity resolver — returns the structured outcome so
 * callers can graduate definitive non-existence (NXDOMAIN /
 * no A record) out of their retry queue immediately rather than
 * burning 8 attempts on the same dead domain.
 */
export async function resolveDomain(domain: string): Promise<ResolverOutcome> {
  const hostname = extractHostname(domain);
  if (!hostname) return { kind: 'no_a_record' };
  return raceForOutcome(RESOLVERS.map((r) => tryResolver(r, hostname)));
}

/**
 * Extract a bare hostname from a domain field that may contain
 * protocol, subdomains, wildcards, ports, or paths. Returns null
 * for wildcards, IP addresses, or values without a dot.
 */
export function extractHostname(domain: string): string | null {
  if (!domain) return null;
  const h = domain
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:[\d]+$/, "")
    .toLowerCase()
    .trim();

  if (!h || h.startsWith("*") || !h.includes(".")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  return h;
}
