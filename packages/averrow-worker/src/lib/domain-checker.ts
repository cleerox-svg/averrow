/**
 * Domain health checker — DNS + MX + HTTP HEAD probes.
 *
 * Shared by:
 *   - scanners/lookalike-domains.ts (lookalike registration detection)
 *   - agents/sparrow.ts Phase F (takedown resurrection detection)
 *
 * Uses Cloudflare DoH (cloudflare-dns.com) for DNS, no external API keys.
 */

export interface DomainCheckResult {
  registered: boolean;
  ip?: string;
  hasMx: boolean;
  hasWeb: boolean;
}

/**
 * Check if a domain is alive: A record, MX record, and web server.
 * Returns structured result with 3s timeout per check.
 *
 * SECURITY (audit L6): `domain` MUST be a platform-generated public
 * hostname (lookalike permutations, tracked takedown domains) — never
 * raw user input. This function probes the host directly over
 * HTTP(S); feeding it attacker-controlled values would make it an
 * SSRF primitive. Both probe branches use `redirect: 'manual'` so a
 * probed host cannot bounce the request elsewhere.
 */
export async function checkDomain(domain: string): Promise<DomainCheckResult> {
  let ip: string | undefined;
  let registered = false;
  let hasMx = false;
  let hasWeb = false;

  // A record check via Cloudflare DoH
  try {
    const aRes = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (aRes.ok) {
      const data = (await aRes.json()) as { Answer?: Array<{ data: string }> };
      if (data.Answer && data.Answer.length > 0) {
        registered = true;
        ip = data.Answer[0]?.data;
      }
    }
  } catch {
    // DNS timeout or network error — treat as not registered
  }

  // MX record check via Cloudflare DoH
  try {
    const mxRes = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (mxRes.ok) {
      const data = (await mxRes.json()) as { Answer?: Array<{ data: string }> };
      if (data.Answer && data.Answer.length > 0) {
        hasMx = true;
        if (!registered) registered = true;
      }
    }
  } catch {
    // MX check failed — leave hasMx as false
  }

  // Web check: HEAD request with 3s timeout
  if (registered) {
    try {
      const webRes = await fetch(`https://${domain}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      });
      // Any response (including redirects) means there's a web server
      hasWeb = webRes.status > 0;
    } catch {
      // Try HTTP as fallback
      try {
        const httpRes = await fetch(`http://${domain}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
          redirect: 'manual',
        });
        hasWeb = httpRes.status > 0;
      } catch {
        // No web server
      }
    }
  }

  return { registered, ip, hasMx, hasWeb };
}
