// IP address sanitization at feed-ingest boundaries.
//
// Some threat feeds (notably ThreatFox via ioc_type='ip:port') emit
// IPs with a port suffix — `172.67.165.77:443`. We store these
// in `threats.ip_address`, but the column's contract is *just an
// IP* — every downstream consumer (cartographer's ip-api batch,
// the GeoIP MMDB lookup, NEXUS clustering, the threats UI) expects
// a bare IPv4 string. Pre-fix, those `:port` rows would fail every
// enrichment attempt for 5 retries and exhaust into the
// cartographer-stuck queue.
//
// IPv6 is intentionally pass-through: we don't yet resolve v6 in
// the MMDB, and IPv6 addresses contain colons by design (`2001:db8::1`).
// We only strip when the input matches an IPv4 + optional `:port`
// shape — anything else is left alone for the downstream parser to
// handle.

const IPV4_WITH_OPTIONAL_PORT = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

/**
 * Returns the bare IPv4 if the input is `1.2.3.4` or `1.2.3.4:port`,
 * otherwise returns the input unchanged. Trims surrounding whitespace.
 *
 * Examples:
 *   '172.67.165.77:443' → '172.67.165.77'
 *   '172.67.165.77'     → '172.67.165.77'
 *   '2001:db8::1'       → '2001:db8::1'    (IPv6 untouched)
 *   ''                  → ''
 *   null                → null
 */
export function sanitizeIp(ip: string | null | undefined): string | null {
  if (ip == null) return null;
  const trimmed = ip.trim();
  if (trimmed === '') return trimmed;
  const match = IPV4_WITH_OPTIONAL_PORT.exec(trimmed);
  if (match && match[1]) return match[1];
  return trimmed;
}
