/**
 * DNS-over-HTTPS A-record lookup for DNS blocklists (SURBL, Spamhaus DBL).
 *
 * The one rule this module exists for: a DNSBL answer is only "clean" when
 * the resolver says NXDOMAIN (or NOERROR with no answer). Everything else
 * that is not a recognised listing is a LOOKUP ERROR, never clean:
 *
 *   - HTTP failure / timeout / unparseable body, or SERVFAIL
 *     (RCODE 2) for one name                                     → transient
 *     (retry later; that name is backed off — see pickDnsblBatch)
 *   - RCODE REFUSED (5): the resolver refuses us                 → refused
 *   - any other RCODE (FORMERR = 1, NOTIMP = 4, …): a problem
 *     with this one query name                                   → row
 *   - a list's own "your query was blocked" answer codes
 *     (SURBL 127.0.0.1; Spamhaus 127.255.255.252/.254/.255)      → refused
 *
 * Kinds: `refused` aborts the whole run (fails the pull, so the feed
 * circuit breaker sees it); `transient` and `row` affect only that row.
 * SERVFAIL on the list's permanent TEST POINT still aborts the run: the
 * self-test treats any error there as fatal. Through a public resolver
 * SURBL answers SERVFAIL "No Reachable Authority" for every name (live
 * test 2026-11-14), which the self-test catches.
 *
 * Before this module both feeds read every one of those as "not listed" and
 * stamped the threat checked-clean, so a refused resolver silently produced
 * a platform-wide "clean" verdict (report: Free threat feeds 2026-11-13).
 */

export type DnsblErrorKind = "transient" | "refused" | "row";

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
    const kind: DnsblErrorKind = status === 2 || status === -1 ? "transient" : status === 5 ? "refused" : "row";
    throw new DnsblLookupError(kind, `DoH RCODE ${status} for ${name}${comment}`);
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

// ─── Query-name validation ─────────────────────────────────────────────

const MAX_DNS_NAME = 253;
const LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Normalise `domain` for a DNSBL query under `zone`, or return null when
 * it can never be a valid query: an IP literal, a name with characters or
 * labels DNS does not allow, a single label, a numeric TLD, or a query
 * name (`<domain>.<zone>`) longer than 253 characters. A null name is
 * stamped checked / not-applicable by the caller so it never returns to
 * the work set (and never aborts a run).
 */
export function dnsblQueryName(domain: string, zone: string): string | null {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (d === "" || d.includes(":") || d.includes("[") || IPV4_RE.test(d)) return null;
  if (`${d}.${zone}`.length > MAX_DNS_NAME) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  return d;
}

// ─── Transient-failure backoff ─────────────────────────────────────────

/** How long a name that failed transiently is moved behind fresh work. */
export const DNSBL_RETRY_BACKOFF_SECONDS = 6 * 3600;

/**
 * Pick up to `max` rows for this run so names that keep failing
 * transiently cannot pin the head of the work set. There is no attempt
 * counter column (adding one needs a migration), so a failed name gets a
 * KV marker (`<retryPrefix><name>`, 6h TTL, markDnsblRetry). Rows are
 * taken in work-set order, skipping marked names; marked names only fill
 * the batch when there is not enough fresh work, so they are still
 * retried rather than starved. Reads at most one KV key per candidate.
 */
export async function pickDnsblBatch<T>(
  rows: readonly T[],
  nameOf: (row: T) => string,
  kv: KVNamespace,
  retryPrefix: string,
  max: number,
): Promise<T[]> {
  const fresh: T[] = [];
  const deferred: T[] = [];
  for (const row of rows) {
    if (fresh.length >= max) break;
    let marked = false;
    try {
      marked = (await kv.get(`${retryPrefix}${nameOf(row)}`)) !== null;
    } catch {
      marked = false; // a KV error must not stall the feed
    }
    (marked ? deferred : fresh).push(row);
  }
  return fresh.concat(deferred).slice(0, max);
}

/** Back off a name after a transient / per-row lookup failure. Never throws. */
export async function markDnsblRetry(kv: KVNamespace, retryPrefix: string, name: string): Promise<void> {
  try {
    await kv.put(`${retryPrefix}${name}`, "1", { expirationTtl: DNSBL_RETRY_BACKOFF_SECONDS });
  } catch {
    /* backoff is best-effort */
  }
}
