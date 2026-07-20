/**
 * Domain extraction utilities — single canonical implementation.
 *
 * Handles: URLs (https://example.com/path), emails (user@example.com), bare domains.
 */

/**
 * Extract domain from a URL, email address, or bare domain string.
 * Returns lowercase hostname without www. prefix, or null on failure.
 */
export function extractDomain(input: string): string | null {
  if (!input) return null;
  try {
    // Handle email addresses
    if (input.includes('@') && !input.includes('://')) {
      const domain = input.split('@').pop()?.toLowerCase().trim();
      return domain || null;
    }
    // Handle URLs
    let url = input.trim();
    if (!url.startsWith('http')) url = 'https://' + url;
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // Handle bare domains
    const cleaned = input.toLowerCase().trim().replace(/^www\./, '').split('/')[0];
    return cleaned || null;
  }
}

/**
 * Compact multi-part public-suffix set. Not the full PSL — a
 * deterministic approximation covering the common two-label
 * ccTLD registries so `login.acme.co.uk` reduces to `acme.co.uk`
 * rather than `co.uk`. Mis-classifying an obscure suffix is
 * low-risk here: the only consumer (off-domain form comparison in
 * page-phishing-scorer.ts) fails toward "same domain" / "keep", the
 * conservative direction.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.in', 'net.in', 'org.in', 'gov.in', 'firm.in',
  'co.za', 'org.za', 'gov.za',
  'com.mx', 'com.sg', 'com.hk', 'com.tw', 'com.tr', 'com.ua',
  'co.kr', 'or.kr', 'com.ar', 'com.co', 'co.id', 'com.my', 'com.ph', 'com.vn',
]);

/**
 * Registrable domain (approximate eTLD+1) for a hostname. Lower-cases,
 * strips a trailing dot, and collapses to the last two labels — or the
 * last three when the final two form a known multi-part suffix.
 *
 * Returns null for empty input, single-label hosts, and IP literals
 * (callers compare host origins; IPs are handled by the SSRF guard).
 *
 *   registrableDomain('login.acme-secure.com') -> 'acme-secure.com'
 *   registrableDomain('mail.acme.co.uk')        -> 'acme.co.uk'
 *   registrableDomain('acme.com')               -> 'acme.com'
 */
export function registrableDomain(host: string): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  // Strip an accidental leading protocol/port/path if a full URL slipped in.
  h = h.replace(/^[a-z]+:\/\//, '').replace(/[:/].*$/, '');
  if (!h || h.includes(' ')) return null;
  // IPv4 / IPv6 literals are not registrable domains.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return null;

  const labels = h.split('.').filter((l) => l.length > 0);
  if (labels.length < 2) return null;

  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_PART_TLDS.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}
