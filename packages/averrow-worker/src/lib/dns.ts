/**
 * DNS Resolution — Resolve domains to IP addresses using Cloudflare DoH.
 *
 * Free, no auth required. Uses DNS-over-HTTPS (RFC 8484).
 */

interface DoHAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DoHResponse {
  Status: number;
  Answer?: DoHAnswer[];
}

/**
 * Resolve a single domain to its first A-record IP.
 * Returns null if resolution fails or no A record exists.
 */
export async function resolveToIP(domain: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      { headers: { Accept: "application/dns-json" } },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as DoHResponse;
    // Type 1 = A record
    const aRecord = data.Answer?.find((a) => a.type === 1);
    return aRecord?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Batch resolve domains to IPs. Processes concurrently with concurrency limit.
 */
export async function batchResolve(
  domains: string[],
  concurrency = 10,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const unique = [...new Set(domains)];
  for (let i = 0; i < unique.length; i += concurrency) {
    const chunk = unique.slice(i, i + concurrency);
    const resolved = await Promise.allSettled(
      chunk.map(async (domain) => {
        const ip = await resolveToIP(domain);
        if (ip) results.set(domain, ip);
      }),
    );
    // Brief pause between chunks to respect rate limits
    if (i + concurrency < unique.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}
