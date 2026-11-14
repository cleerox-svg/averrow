/**
 * Hosted DMARC aggregate reporting (RUA) — the addresses Averrow receives
 * aggregate reports on, and the helpers that decide whether a domain has
 * asked for its reports to come to us.
 *
 * Mail routing reality (verified 2026-11-14, docs/SPAM_TRAP_ASSESSMENT_2026-09.md
 * §4 and docs/EMAIL_ROUTING_RUNBOOK.md): averrow.com's MX is Google
 * Workspace, which answers 550 for `dmarc_rua@averrow.com`, so that address
 * has never delivered a report. Only zones on Cloudflare Email Routing
 * (averrow.ca, trustradar.ca, lrxradar.com) reach the Worker's `email()`
 * handler. The primary address therefore lives on averrow.ca.
 *
 * Changing the primary address is ONE constant (DMARC_RUA_PRIMARY); the
 * report-authorization host (RFC 7489 §7.1 / RFC 9990 §3) follows it.
 */

/** The address customers publish in `rua=`. Owner default: averrow.ca. */
export const DMARC_RUA_PRIMARY = "dmarc_rua@averrow.ca";

/**
 * Addresses that were advertised before the primary moved. Still routed to
 * the receiver (a domain that published one keeps working if its zone ever
 * reaches the Worker), and still accepted as "reports to Averrow" by
 * ruaIncludesAverrow. `dmarc_rua@averrow.com` cannot actually receive mail
 * (Workspace MX) — kept so a domain that published it is recognised and the
 * setup endpoint can tell the operator to switch.
 */
export const DMARC_RUA_LEGACY_ADDRESSES: readonly string[] = [
  "dmarc_rua@averrow.com",
  "dmarc_rua@trustradar.ca",
];

/** Every address the email handler routes to the DMARC receiver (lowercase). */
export const DMARC_RUA_ADDRESSES: readonly string[] = [DMARC_RUA_PRIMARY, ...DMARC_RUA_LEGACY_ADDRESSES];

const RUA_ADDRESS_SET: ReadonlySet<string> = new Set(DMARC_RUA_ADDRESSES.map((a) => a.toLowerCase()));

/**
 * The host under which `<customer-domain>._report._dmarc.<host>` must carry
 * `v=DMARC1` for receivers to deliver reports to an address outside the
 * customer's own organizational domain (RFC 7489 §7.1 "external destination
 * verification"). Derived from the primary address's domain. It is itself a
 * registrable domain, which isRuaAuthorizationRequired relies on.
 */
export const DMARC_REPORT_AUTH_HOST: string = DMARC_RUA_PRIMARY.slice(DMARC_RUA_PRIMARY.indexOf("@") + 1).toLowerCase();

/** The exact `rua=` tag value to tell a customer to publish. */
export const DMARC_RUA_TAG_VALUE = `rua=mailto:${DMARC_RUA_PRIMARY}`;

/**
 * Normalise an SMTP recipient for routing: trim, strip one pair of angle
 * brackets, lowercase. Email Routing hands `message.to` over as a bare
 * address today; the bracket strip is defensive.
 */
export function normalizeRecipient(to: string | null | undefined): string {
  let s = (to ?? "").trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim();
  return s.toLowerCase();
}

/** True when the (any-case) recipient is one of our DMARC RUA addresses. */
export function isDmarcRuaRecipient(to: string | null | undefined): boolean {
  return RUA_ADDRESS_SET.has(normalizeRecipient(to));
}

/**
 * Does a DMARC `rua=` tag value include one of our addresses?
 *
 * The value is a comma-separated list of URIs (RFC 7489 §6.4 / RFC 9989):
 * `mailto:a@x.example,mailto:dmarc_rua@averrow.ca!10m`. Each URI may carry a
 * `!<size>[kmgt]` size limit (RFC 7489 only; harmless to strip), may be
 * percent-encoded, and the scheme is case-insensitive. Non-mailto URIs are
 * ignored. Accepts the full tag (`rua=mailto:…`) as well as the bare value.
 */
export function ruaIncludesAverrow(rua: string | null | undefined): boolean {
  if (!rua) return false;
  let value = rua.trim();
  if (/^rua\s*=/i.test(value)) value = value.slice(value.indexOf("=") + 1);
  for (const raw of value.split(",")) {
    let uri = raw.trim();
    if (!/^mailto:/i.test(uri)) continue;
    uri = uri.slice("mailto:".length);
    // Size-limit suffix: `!10m`, `!50k`, `!1g`, `!2048`.
    const bang = uri.lastIndexOf("!");
    if (bang >= 0 && /^![0-9]+[kmgt]?$/i.test(uri.slice(bang))) uri = uri.slice(0, bang);
    // Any `?query` part of a mailto URI is not part of the address.
    const q = uri.indexOf("?");
    if (q >= 0) uri = uri.slice(0, q);
    let addr = uri;
    try {
      addr = decodeURIComponent(uri);
    } catch {
      // Malformed escape — compare the raw text.
    }
    if (RUA_ADDRESS_SET.has(normalizeRecipient(addr))) return true;
  }
  return false;
}

/** Lowercase, no trailing dot. */
function normDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Whether reports for `domain` need the external-destination authorization
 * record. Not needed when the domain is the auth host or a subdomain of it
 * (same organizational domain — DMARC_REPORT_AUTH_HOST is registrable).
 */
export function isRuaAuthorizationRequired(domain: string): boolean {
  const d = normDomain(domain);
  return !(d === DMARC_REPORT_AUTH_HOST || d.endsWith(`.${DMARC_REPORT_AUTH_HOST}`));
}

/** `<domain>._report._dmarc.<auth host>` — the record WE publish. */
export function ruaAuthorizationRecordName(domain: string): string {
  return `${normDomain(domain)}._report._dmarc.${DMARC_REPORT_AUTH_HOST}`;
}
