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
   * SCOPED TO `registered`, and to nothing else. This field used to
   * claim that "`hasMx` / `hasWeb` / `ip` are only meaningful when this
   * is true", which was false in BOTH directions:
   *
   *   * `resolved` can be true while `hasMx` / `ip` are meaningless — a
   *     SEEN A record short-circuits it (`registered || ...`), so an A
   *     answer with an MX timeout yields `resolved: true, hasMx: false`
   *     from a probe that learned nothing about mail; and an MX answer
   *     with an A timeout yields `resolved: true, ip: undefined` from a
   *     probe that learned nothing about the address.
   *   * `resolved` says nothing at all about the WEB probe, which has
   *     its own timeout and its own failure mode.
   *
   * Per-field answers are what a caller that PERSISTS these values
   * needs, so each now carries its own flag below. A caller must not
   * write a field whose flag is false: doing so records "not present"
   * for "we could not tell", which erases a known IP / MX / web server
   * on a transient probe failure and drops the row out of the cohorts
   * keyed on those columns.
   */
  resolved: boolean;
  /**
   * The A query returned a parseable response (an NXDOMAIN counts; a
   * timeout or non-ok DoH reply does not). `ip` is meaningful only when
   * this is true.
   */
  aAnswered: boolean;
  /**
   * The MX query returned a parseable response. `hasMx` is meaningful
   * only when this is true.
   */
  mxAnswered: boolean;
  /**
   * A web probe COMPLETED — any HTTP response, INCLUDING 403 / 404 / a
   * redirect, over https or the http fallback. False means every attempt
   * failed at the connection level (timeout, TCP reset, TLS failure,
   * tarpit) or that no probe was attempted at all (`registered` false).
   * `hasWeb` is meaningful only when this is true.
   */
  webAnswered: boolean;
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

  // Web check: HEAD request with 3s timeout.
  //
  // Both branches used to end in a bare `catch {}` commented "No web
  // server", leaving `hasWeb = false` — so a 3s timeout, a TCP reset, a
  // TLS failure and a tarpit were all indistinguishable from a domain
  // that genuinely serves nothing, and a caller persisting `hasWeb`
  // wrote 0 over a known 1. `webAnswered` is the same distinction the
  // DNS probes already draw: a 403/404/redirect IS an answer (the
  // `fetch` resolved), only a connection-level failure is not.
  let webAnswered = false;
  if (registered) {
    try {
      const webRes = await fetch(`https://${domain}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      });
      // Any response (including redirects) means there's a web server
      hasWeb = webRes.status > 0;
      webAnswered = true;
    } catch {
      // Try HTTP as fallback
      try {
        const httpRes = await fetch(`http://${domain}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
          redirect: 'manual',
        });
        hasWeb = httpRes.status > 0;
        webAnswered = true;
      } catch {
        // BOTH probes failed at the connection level. NOT an answer:
        // `webAnswered` stays false and `hasWeb` is a default, not a
        // finding.
      }
    }
  }
  // `registered === false` means no probe was attempted, so there is no
  // web answer either — which the `if` above already leaves correct.

  // A record we SAW is self-authenticating, so a positive `registered`
  // is always resolved. A negative one is only trustworthy when BOTH
  // probes answered: A alone answering NXDOMAIN while MX timed out
  // cannot rule out an MX-only registration, which is precisely the
  // BEC-precursor shape the lookalike scanner cares most about.
  const resolved = registered || (aAnswered && mxAnswered);

  return { registered, resolved, aAnswered, mxAnswered, webAnswered, ip, hasMx, hasWeb };
}
