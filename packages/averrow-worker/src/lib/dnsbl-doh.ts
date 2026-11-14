/**
 * DNS-over-HTTPS A-record lookup for DNS blocklists (SURBL, Spamhaus DBL).
 *
 * The one rule this module exists for: a DNSBL answer is only "clean" when
 * the resolver says NXDOMAIN (or NOERROR with no answer). Everything else
 * that is not a recognised listing is a LOOKUP ERROR, never clean:
 *
 *   - HTTP failure / timeout / unparseable body                → transient
 *   - DNS status other than NOERROR / NXDOMAIN (SERVFAIL = 2,
 *     REFUSED = 5, …). Through a public resolver SURBL answers
 *     SERVFAIL "No Reachable Authority" (live test 2026-11-14)   → refused
 *   - a list's own "your query was blocked" answer codes
 *     (SURBL 127.0.0.1; Spamhaus 127.255.255.252/.254/.255)      → refused
 *
 * Before this module both feeds read every one of those as "not listed" and
 * stamped the threat checked-clean, so a refused resolver silently produced
 * a platform-wide "clean" verdict (report: Free threat feeds 2026-11-13).
 */

export type DnsblErrorKind = "transient" | "refused";

export class DnsblLookupError extends Error {
  readonly kind: DnsblErrorKind;
  constructor(kind: DnsblErrorKind, message: string) {
    super(message);
    this.name = "DnsblLookupError";
    this.kind = kind;
  }
}

export interface DohAnswer {
  /** DNS RCODE: 0 NOERROR, 3 NXDOMAIN, 2 SERVFAIL, 5 REFUSED. */
  status: number;
  /** A-record data values, in answer order. */
  addresses: string[];
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 30_000;

/**
 * Resolve `name` (type A) over DoH. Throws `DnsblLookupError` for a
 * transport failure or any RCODE other than NOERROR / NXDOMAIN; the caller
 * decodes the addresses (and its list's own error codes).
 */
export async function dohLookupA(name: string): Promise<DohAnswer> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=A`;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      headers: { Accept: "application/dns-json" },
    });
  } catch (err) {
    throw new DnsblLookupError("transient", `DoH fetch failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new DnsblLookupError("transient", `DoH HTTP ${res.status} for ${name}`);
  }

  let data: { Status?: unknown; Answer?: unknown; Comment?: unknown };
  try {
    data = (await res.json()) as { Status?: unknown; Answer?: unknown; Comment?: unknown };
  } catch {
    throw new DnsblLookupError("transient", `DoH returned a non-JSON body for ${name}`);
  }

  const status = typeof data.Status === "number" ? data.Status : -1;
  if (status !== 0 && status !== 3) {
    const comment = Array.isArray(data.Comment) ? ` (${data.Comment.map(String).join("; ")})` : "";
    throw new DnsblLookupError("refused", `DoH RCODE ${status} for ${name}${comment}`);
  }

  const addresses: string[] = [];
  if (status === 0 && Array.isArray(data.Answer)) {
    for (const a of data.Answer) {
      if (a && typeof a === "object" && "data" in a && typeof (a as { data: unknown }).data === "string") {
        // Only A records (type 1); CNAME hops carry a hostname in `data`.
        const type = (a as { type?: unknown }).type;
        if (type === undefined || type === 1) addresses.push((a as { data: string }).data);
      }
    }
  }
  return { status, addresses };
}

/**
 * End-of-run verdict for a DNSBL ingest loop: fail (throw) the pull when
 * every attempted lookup errored, so the feed circuit breaker backs off and
 * eventually auto-pauses. A `refused` error aborts the loop immediately and
 * never reaches this check.
 */
export function dnsblRunShouldFail(attempted: number, errors: number): boolean {
  return attempted > 0 && errors === attempted;
}
