/**
 * Outbound URL guard — SSRF protection for org-configured webhook URLs.
 *
 * Validates that a destination is a plausible public HTTPS endpoint
 * before the platform will store it or POST to it. Rejects:
 *   - unparseable URLs
 *   - any scheme other than https:
 *   - IP-literal hostnames in private / loopback / link-local / CGNAT /
 *     unspecified ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
 *     100.64/10, 0.0.0.0/8, ::1, ::, fc00::/7, fe80::/10, IPv4-mapped IPv6)
 *   - localhost and *.local / *.internal names
 *   - the platform's own hosts (averrow.com, averrow.ca, *.workers.dev)
 *
 * NOTE: this is a static check. DNS rebinding (public name resolving to a
 * private IP) is not covered here — callers must also set
 * `redirect: "manual"` on the delivery fetch so a public endpoint cannot
 * bounce the request to an internal address.
 *
 * Audit finding M1 (docs/SECURITY_AUDIT_2026-07-12.md reconciliation table;
 * originally raised in docs/archive/SECURITY_AUDIT_2026-06-10.md).
 */

export type UrlGuardResult = { ok: true } | { ok: false; reason: string };

const PLATFORM_HOSTS = ["averrow.com", "averrow.ca"];
const BLOCKED_SUFFIXES = [".local", ".internal", ".workers.dev"];

/** Returns a rejection reason if the IPv4 address is non-public, else null. */
export function ipv4BlockReason(host: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null; // not an IPv4 literal
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return "Invalid IPv4 address";
  if (o[0] === 0) return "Unspecified address range (0.0.0.0/8) is not allowed";
  if (o[0] === 10) return "Private address range (10.0.0.0/8) is not allowed";
  if (o[0] === 127) return "Loopback address range (127.0.0.0/8) is not allowed";
  if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return "Private address range (172.16.0.0/12) is not allowed";
  if (o[0] === 192 && o[1] === 168) return "Private address range (192.168.0.0/16) is not allowed";
  if (o[0] === 169 && o[1] === 254) return "Link-local address range (169.254.0.0/16) is not allowed";
  if (o[0] === 100 && o[1]! >= 64 && o[1]! <= 127) return "Carrier-grade NAT range (100.64.0.0/10) is not allowed";
  return null;
}

/** Returns a rejection reason if the IPv6 address is non-public, else null. */
export function ipv6BlockReason(host: string): string | null {
  const addr = host.toLowerCase();
  if (addr === "::" || addr === "0:0:0:0:0:0:0:0") return "Unspecified IPv6 address is not allowed";
  if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return "Loopback IPv6 address is not allowed";

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — apply the IPv4 rules to the tail.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (mapped) {
    const reason = ipv4BlockReason(mapped[1]!);
    return reason ?? "IPv4-mapped IPv6 addresses are not allowed";
  }

  // First hextet checks (fc00::/7 ULA, fe80::/10 link-local).
  const firstGroup = addr.split(":")[0];
  if (firstGroup) {
    const v = parseInt(firstGroup, 16);
    if (!Number.isNaN(v)) {
      if ((v & 0xfe00) === 0xfc00) return "Unique-local IPv6 range (fc00::/7) is not allowed";
      if ((v & 0xffc0) === 0xfe80) return "Link-local IPv6 range (fe80::/10) is not allowed";
    }
  }
  return null;
}

/**
 * Validate an org-supplied outbound webhook URL.
 * Call at config-write time (handlers/organizations.ts) AND again at
 * delivery time (lib/webhooks.ts) for defense in depth — the stored
 * value may predate this guard.
 */
export function validateOutboundWebhookUrl(url: string): UrlGuardResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Webhook URL is not a valid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "Webhook URL must use https" };
  }

  // URL canonicalizes hostnames (decimal/hex/octal IPv4 forms become
  // dotted-quad), so checking parsed.hostname covers obfuscated literals.
  let host = parsed.hostname.toLowerCase().replace(/\.$/, "");

  // IPv6 literals arrive bracketed in URL.hostname.
  if (host.startsWith("[") && host.endsWith("]")) {
    const reason = ipv6BlockReason(host.slice(1, -1));
    if (reason) return { ok: false, reason };
    return { ok: true };
  }

  const v4Reason = ipv4BlockReason(host);
  if (v4Reason) return { ok: false, reason: v4Reason };

  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "localhost is not allowed" };
  }

  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { ok: false, reason: `Hostnames ending in ${suffix} are not allowed` };
    }
  }

  for (const platformHost of PLATFORM_HOSTS) {
    if (host === platformHost || host.endsWith(`.${platformHost}`)) {
      return { ok: false, reason: "Webhook URL cannot point at the platform's own hosts" };
    }
  }

  return { ok: true };
}

/**
 * Return a rejection reason if a resolved IP literal (v4 or v6) falls
 * in any private / loopback / link-local / CGNAT / metadata range,
 * else null. Thin dispatcher over the shared block helpers so the
 * SSRF page-fetcher (lib/page-fetch.ts) validates *resolved* IPs with
 * exactly the same range logic used for static webhook-URL checks —
 * no re-implementation of IP-range math. `169.254.169.254` (the cloud
 * metadata endpoint) is covered by the 169.254.0.0/16 link-local rule.
 */
export function resolvedIpBlockReason(ip: string): string | null {
  const trimmed = ip.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!trimmed) return 'Empty IP address';
  if (trimmed.includes(':')) {
    return ipv6BlockReason(trimmed) ?? null;
  }
  return ipv4BlockReason(trimmed);
}

/**
 * Static (pre-resolution) host block check for the SSRF page-fetcher.
 *
 * Unlike `validateOutboundWebhookUrl` this operates on a *bare
 * hostname* (not a full URL) and does NOT enforce a scheme — the
 * page-fetcher allows both http and https (phishing pages are
 * frequently plain http). Everything else is identical: reject IP
 * literals in non-public ranges (so a hostname that IS an IP literal
 * can't slip past), localhost, *.local / *.internal / *.workers.dev,
 * and the platform's own hosts.
 *
 * This is only the FIRST gate. The fetcher MUST still resolve the host
 * via DoH and run every resolved IP through `resolvedIpBlockReason`
 * before connecting (DNS-rebinding defense) — a public hostname can
 * still resolve to a private IP, which this static check cannot see.
 */
export function pageFetchHostStaticBlockReason(rawHost: string): string | null {
  const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return 'Empty host';
  if (host.includes(' ') || host.includes('/')) return 'Malformed host';

  // Bracketed IPv6 literal.
  if (host.startsWith('[') && host.endsWith(']')) {
    return ipv6BlockReason(host.slice(1, -1)) ?? null;
  }
  // Bare IPv6 literal (contains a colon and isn't host:port — page
  // hosts here never carry a port).
  if (host.includes(':')) {
    return ipv6BlockReason(host) ?? 'IPv6 host not allowed';
  }

  const v4Reason = ipv4BlockReason(host);
  if (v4Reason) return v4Reason;

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'localhost is not allowed';
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) return `Hostnames ending in ${suffix} are not allowed`;
  }
  for (const platformHost of PLATFORM_HOSTS) {
    if (host === platformHost || host.endsWith(`.${platformHost}`)) {
      return "Cannot fetch the platform's own hosts";
    }
  }
  return null;
}
