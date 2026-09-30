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
  /**
   * Is `registered` an OBSERVATION, or just the absence of one?
   *
   * `registered: false` has always carried two unrelated meanings: "both
   * DNS probes answered and neither returned a record" and "the probes
   * timed out / the resolver 5xx'd, so we learned nothing". Callers that
   * PERSIST `registered` must not conflate them — writing a transient
   * failure over a stored `registered = 1` manufactures a 1 -> 0 lapse,
   * and the next successful check then reads as a 0 -> 1 registration
   * that never happened (with a `first_seen` stamp, a Haiku call and an
   * alert behind it).
   *
   * true  → the value of `registered` is backed by an answer:
   *         either a record was seen (necessarily authoritative), or
   *         BOTH the A and MX queries returned a parseable response.
   * false → at least one probe failed AND nothing was found, so
   *         `registered` is a default, not a finding. Leave any stored
   *         registration state alone.
   *
   * `hasMx` / `hasWeb` / `ip` are only meaningful when this is true.
   */
  resolved: boolean;
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
  // Per-probe "we got a parseable answer" flags. Distinct from the
  // record-presence flags above: an NXDOMAIN is an ANSWER (answered =
  // true, registered = false) while a 3s timeout is not.
  let aAnswered = false;
  let mxAnswered = false;

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
      aAnswered = true;
      if (data.Answer && data.Answer.length > 0) {
        registered = true;
        ip = data.Answer[0]?.data;
      }
    }
  } catch {
    // DNS timeout, network error or unparseable body — NOT an answer.
    // `aAnswered` stays false so the caller can tell this apart from a
    // clean NXDOMAIN. A non-ok `aRes` lands here too (the `if` above is
    // simply not taken), which is the `!aRes.ok` half of the same defect.
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
      mxAnswered = true;
      if (data.Answer && data.Answer.length > 0) {
        hasMx = true;
        if (!registered) registered = true;
      }
    }
  } catch {
    // MX check failed — leave hasMx as false, and `mxAnswered` false so
    // the verdict below is not treated as authoritative.
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

  // A record we SAW is self-authenticating, so a positive `registered`
  // is always resolved. A negative one is only trustworthy when BOTH
  // probes answered: A alone answering NXDOMAIN while MX timed out
  // cannot rule out an MX-only registration, which is precisely the
  // BEC-precursor shape the lookalike scanner cares most about.
  const resolved = registered || (aAnswered && mxAnswered);

  return { registered, resolved, ip, hasMx, hasWeb };
}
