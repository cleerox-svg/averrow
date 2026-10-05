/**
 * Strict hostname validator / normaliser for domains supplied by
 * UNAUTHENTICATED callers (public scan widgets, /assess, lead capture).
 *
 * Those endpoints store the domain (brand_scans, scan_leads, assessments,
 * brands) and the public pages render it back, so anything that is not a
 * plain DNS hostname is rejected outright — not sanitised. The previous
 * check (`domain.includes(".")`) let `<img src=x onerror=alert(1)>.com`
 * through into a stored-XSS sink on the /assess results page.
 *
 * Accepts: `Example.COM`, `https://example.com/path?q#f`, `example.com:8443`,
 * `example.com.` (trailing dot), `xn--mnchen-3ya.de`, `münchen.de`
 * (converted to its punycode A-label).
 *
 * Rejects: single labels, IP literals, userinfo (`a@b.com`), whitespace,
 * `<`, `>`, quotes or any character outside `[a-z0-9-.]`, labels that
 * start/end with a hyphen or exceed 63 chars, numeric or malformed TLDs,
 * and hostnames longer than 253 chars.
 */

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// TLD: letters only (2–63), or an IDN A-label (xn--…).
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const MAX_HOSTNAME_LENGTH = 253;
// Raw-input cap before any parsing — a URL with a long path is fine, a
// megabyte of junk is not worth looking at.
const MAX_RAW_INPUT_LENGTH = 2048;

export interface NormalizePublicHostnameOptions {
  /** Drop a leading `www.` (matches the /api/v1/public/* handlers). */
  stripWww?: boolean;
}

/**
 * Returns the normalised lowercase hostname, or `null` when the input is
 * not a valid public DNS hostname. Never throws.
 */
export function normalizePublicHostname(
  input: unknown,
  opts: NormalizePublicHostnameOptions = {},
): string | null {
  if (typeof input !== "string") return null;
  if (input.length === 0 || input.length > MAX_RAW_INPUT_LENGTH) return null;

  let host = input.trim().toLowerCase();
  // Strip a URL scheme, then everything from the first path/query/fragment
  // delimiter onward.
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const cut = host.search(/[/?#]/);
  if (cut !== -1) host = host.slice(0, cut);
  // Strip a numeric port. Any other ':' (IPv6, junk) fails the charset check.
  host = host.replace(/:\d{1,5}$/, "");
  host = host.replace(/\.$/, "");
  if (opts.stripWww && host.startsWith("www.")) host = host.slice(4);

  // Internationalised input: let the WHATWG URL parser apply IDNA (UTS #46)
  // to get the punycode A-label form, then validate that strictly. Only for
  // input whose remaining characters are non-ASCII letters plus the plain
  // hostname charset, so URL's lenient parsing can't smuggle anything in.
  if (/[^\x00-\x7f]/.test(host)) {
    if (/[\s<>"'`@\\%]/.test(host)) return null;
    try {
      host = new URL(`http://${host}/`).hostname;
    } catch {
      return null;
    }
  }

  if (host.length === 0 || host.length > MAX_HOSTNAME_LENGTH) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return null;
  }
  const tld = labels[labels.length - 1]!;
  if (!TLD_RE.test(tld)) return null;
  return host;
}
