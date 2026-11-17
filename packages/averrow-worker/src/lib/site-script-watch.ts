/**
 * Site Script Watch — client-side supply-chain monitoring of a brand's OWN
 * website (Magecart / polyfill.io class of compromise).
 *
 * PR1: pure logic + read helpers. No agent, cron, route or alert uses this
 * yet. Schema: migrations/0337_site_script_watch.sql (its header documents
 * every column, finding kind and the intended retention).
 *
 *   normaliseScriptUrl       URL → { host, path_norm (path + identity params), url, scheme, port }
 *   normaliseInlineScriptText / inlineScriptPathNorm   inline-script identity
 *   isExecutableScriptType   which inline <script type> values are code (data blocks skipped)
 *   isFirstPartyHost         host equals / sits under the brand's canonical domain (punycode)
 *   looksContentHashed / contentHashStem   build-hashed file paths (app.3f9a2c1b.js) and their stem
 *   diffSiteScan             scan vs stored inventory → new_host / new_script /
 *                            body_changed / sri_removed
 *   diffContactedHosts       requests vs stored contacted hosts → new_contacted_host
 *   isBaselineScan / assessScanPlausibility   caller-side scan bookkeeping
 *   findingDedupeKey         site_script_findings.dedupe_key
 *   matchHostsAgainstThreats hosts → ACTIVE threats (malicious_domain exact + parents, ip_address)
 *   matchUrlsAgainstThreats  script URLs → ACTIVE threats (malicious_url)
 *
 * Host normalisation, parent-domain expansion, the suffix-set lookup and the
 * shared-hosting list are the ones the official-domain triage uses
 * (lib/safeDomains.ts), so the two features agree on what "a subdomain of X"
 * means.
 */

import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types";
import {
  SHARED_HOSTING_DOMAINS,
  findHostSuffix,
  hostAndParents,
  isUnderSharedHosting,
  normalizeHost,
} from "./safeDomains";

// ─── Host helpers ───────────────────────────────────────────────────

/**
 * Lowercase ASCII host: normalizeHost, then IDNA → punycode
 * (`bücher.de` → `xn--bcher-kva.de`), the form URL parsing gives script
 * hosts. Unconvertible input is returned normalised but unconverted.
 */
export function toAsciiHost(raw: string): string {
  const h = normalizeHost(raw);
  if (!h || /^[\x21-\x7e]*$/.test(h)) return h;
  try {
    return new URL(`http://${h}/`).hostname.replace(/\.+$/, "");
  } catch {
    return h;
  }
}

/**
 * The bare IP for an IP-literal host (`203.0.113.7`, `[2001:db8::1]` →
 * `2001:db8::1`), or null for a hostname. URL parsing has already
 * canonicalised exotic IPv4 spellings (`0x7f.1` → `127.0.0.1`).
 */
export function ipLiteral(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;
  const v6 = /^\[([0-9a-f:.]+)\]$/.exec(h);
  if (v6 && v6[1]!.includes(":")) return v6[1]!;
  return null;
}

// ─── Normalisation ──────────────────────────────────────────────────

/** Longest path_norm stored; longer keys are truncated (keeps the UNIQUE key bounded). */
export const SITE_SCRIPT_PATH_MAX = 1024;

/** Longest URL kept in finding evidence. */
export const SITE_SCRIPT_EVIDENCE_URL_MAX = 2048;

/** Query params that identify a script on EVERY host (gtm.js?id=GTM-…). */
export const SCRIPT_IDENTITY_PARAMS_ALWAYS: readonly string[] = ["id"];

/**
 * Extra identity-bearing query params per host (matched as the host or a
 * subdomain of it, most specific entry wins). Everything not listed is a
 * cache-buster / tuning knob and is dropped from the key. A param here
 * changes which code loads or whose account it serves — a skimmer swapping
 * a PayPal `client-id` reroutes the payment.
 */
export const SCRIPT_IDENTITY_PARAMS_BY_HOST: ReadonlyMap<string, readonly string[]> = new Map([
  ["googletagmanager.com", ["id"]],
  ["google-analytics.com", ["id"]],
  ["maps.googleapis.com", ["key", "libraries", "v"]],
  ["google.com", ["render"]], // reCAPTCHA api.js?render=<site key>
  ["recaptcha.net", ["render"]],
  ["paypal.com", ["client-id", "merchant-id"]],
  ["polyfill.io", ["features"]],
]);

export interface NormalisedScriptUrl {
  /** Lowercase ASCII (punycode) hostname, no trailing dot, no port. IPv6 literals keep their brackets. */
  host: string;
  /**
   * Inventory key: URL path plus the identity-bearing query params only
   * (SCRIPT_IDENTITY_PARAMS_*, sorted by name then value). The fragment and
   * every other param (cache-busters) are dropped.
   */
  path_norm: string;
  /** Resolved absolute URL, fragment dropped, full query kept (evidence). */
  url: string;
  /** 'http' | 'https'. */
  scheme: string;
  /** Explicit non-default port, else null. Not part of the inventory key. */
  port: string | null;
}

function identityParamsFor(host: string): ReadonlySet<string> {
  const entry = findHostSuffix(host, SCRIPT_IDENTITY_PARAMS_BY_HOST);
  return new Set([...SCRIPT_IDENTITY_PARAMS_ALWAYS, ...(entry ? SCRIPT_IDENTITY_PARAMS_BY_HOST.get(entry) ?? [] : [])]);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function parseAbsolute(raw: string, baseUrl: string | null | undefined, protocols: ReadonlySet<string>): URL | null {
  const input = raw.trim();
  if (!input) return null;
  let url: URL;
  try {
    url = baseUrl ? new URL(input, baseUrl) : new URL(input);
  } catch {
    return null;
  }
  if (!protocols.has(url.protocol)) return null;
  if (!url.hostname.replace(/\.+$/, "")) return null;
  url.hash = "";
  return url;
}

const SCRIPT_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);
const REQUEST_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Normalise a script `src`. Relative URLs resolve against `baseUrl` (the
 * page it was seen on) when given. Returns null for anything that is not an
 * absolute http(s) URL with a host (data:, blob:, javascript:, garbage).
 */
export function normaliseScriptUrl(raw: string, baseUrl?: string | null): NormalisedScriptUrl | null {
  const url = parseAbsolute(raw, baseUrl, SCRIPT_PROTOCOLS);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const keep = identityParamsFor(host);
  const kept = [...url.searchParams.entries()]
    .filter(([k]) => keep.has(k))
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const qs = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
  return {
    host,
    path_norm: truncate((url.pathname || "/") + qs, SITE_SCRIPT_PATH_MAX),
    url: url.href,
    scheme: url.protocol.slice(0, -1),
    port: url.port || null,
  };
}

/**
 * A URL safe to STORE as evidence (finding page_url / evidence url /
 * initiator_url, inventory first_page_url): query param NAMES are kept but
 * their VALUES are dropped (`?token=abc&id=GTM-1` → `?token=&id=GTM-1`),
 * except the identity params normaliseScriptUrl keeps for that host (`id`
 * everywhere plus SCRIPT_IDENTITY_PARAMS_BY_HOST). A page or beacon URL can
 * carry a session token or a shopper's data (an exfil request IS that data);
 * none of it belongs in our store. The fragment and any userinfo are
 * dropped. Matching and the inventory keys use the unredacted URL; only what
 * is persisted is redacted. Unparseable input keeps only what precedes the
 * first `?` / `#`. Truncated to SITE_SCRIPT_EVIDENCE_URL_MAX.
 */
export function redactEvidenceUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return truncate(raw.split(/[?#]/)[0] ?? "", SITE_SCRIPT_EVIDENCE_URL_MAX);
  }
  url.hash = "";
  url.username = "";
  url.password = "";
  if (url.search) {
    const keep = identityParamsFor(url.hostname.toLowerCase().replace(/\.+$/, ""));
    const params = new URLSearchParams();
    for (const [k, v] of url.searchParams.entries()) params.append(k, keep.has(k) ? v : "");
    url.search = params.toString();
  }
  return truncate(url.href, SITE_SCRIPT_EVIDENCE_URL_MAX);
}

// ─── Inline scripts ─────────────────────────────────────────────────

/** script_host of an inline-script inventory row (never a valid hostname). */
export const INLINE_SCRIPT_HOST = "(inline)";

/**
 * JavaScript MIME type essences (HTML spec): a `<script type>` equal to one
 * of these (trimmed, ASCII case-insensitive, NO parameters) executes.
 */
const JS_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

/**
 * Does a `<script>` with this `type` attribute execute? Absent / empty,
 * `module` and the JavaScript MIME types do; everything else is a data
 * block the browser never runs (application/json, application/ld+json,
 * importmap, speculationrules, text/template, text/x-handlebars …).
 *
 * Only executable inline scripts are hashed and inventoried: a data block
 * (Next.js `<script id="__NEXT_DATA__" type="application/json">`, JSON-LD)
 * carries per-request state and would mint a "new" inline script on every
 * scan. The decision is made on `type` ONLY, never on `id`: a
 * `<script id="__NEXT_DATA__">` with no type executes like any other, so an
 * id cannot exempt code from the inventory.
 */
export function isExecutableScriptType(type: string | null | undefined): boolean {
  if (type === null || type === undefined) return true;
  const t = type.trim().toLowerCase();
  return t === "" || t === "module" || JS_MIME_TYPES.has(t);
}

const BASE58_CHARS = "[1-9A-HJ-NP-Za-km-z]";
/**
 * Wallet-address shapes the long-token mask must NOT hide (a skimmer / drainer
 * swaps the recipient address; the hash has to change): Ethereum-style
 * `0x` + 40 hex (EIP-55 mixed case included), Bitcoin legacy / P2SH base58
 * (`1…` / `3…`, 26-35 chars) and TRON (`T` + 33 base58).
 */
const WALLET_ADDRESS_RE = new RegExp(`^(?:0x[0-9a-fA-F]{40}|[13]${BASE58_CHARS}{25,34}|T${BASE58_CHARS}{33})$`);

const INLINE_NOISE_RE = new RegExp(
  [
    // 1. Ethereum-style address: kept verbatim (consumed first so no later rule masks part of it).
    "0x[0-9a-fA-F]{40}(?![0-9A-Za-z])",
    // 2. UUID.
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
    // 3. ISO-8601 date-time (seconds, fraction and offset optional).
    "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?",
    // 4. Standalone hex run ≥ 32 (nonces, digests, build ids).
    "(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])",
    // 5. Any alphanumeric run ≥ 24 (decided in the callback).
    "[A-Za-z0-9]{24,}",
    // 6. Digit run ≥ 8 (epoch timestamps, request ids).
    "\\d{8,}",
  ].join("|"),
  "g",
);

function maskInlineNoise(m: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(m)) return m;
  if (/^[0-9a-fA-F]{8}-/.test(m)) return "#";
  if (/^\d{4}-\d{2}-\d{2}/.test(m)) return "T0";
  if (/^\d{8,}$/.test(m)) return "0";
  if (/^[0-9a-fA-F]{32,}$/.test(m)) return "#";
  // Alphanumeric run ≥ 24: a per-request token (CSRF, session, nonce) when it
  // mixes digits, upper and lower case. Long camelCase identifiers (no digit)
  // and wallet addresses stay; inside a kept run only ≥ 8-digit runs are masked.
  if (WALLET_ADDRESS_RE.test(m)) return m;
  if (/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m)) return "#";
  return m.replace(/\d{8,}/g, "0");
}

/**
 * Normalise inline-script text before hashing, so per-request noise does
 * not mint a "new" script on every scan. Whitespace is collapsed, then:
 *   - UUIDs                                         → `#`
 *   - ISO-8601 date-times                           → `T0`
 *   - standalone hex runs ≥ 32 (nonces, digests)    → `#`
 *   - alphanumeric runs ≥ 24 mixing digits, upper and lower case
 *     (CSRF / session tokens)                       → `#`
 *   - digit runs ≥ 8 (epoch timestamps)             → `0`
 * NOT masked: `0x` + 40-hex (Ethereum-style wallet addresses), Bitcoin
 * legacy / P2SH and TRON base58 addresses — a drainer swapping the recipient
 * must change the hash.
 *
 * Masking trade-offs (an attacker change that ONLY touches a masked value is
 * invisible to the inline hash):
 *   - numeric ids of ≥ 8 digits (merchant / account numbers, phone numbers)
 *     are masked like timestamps; shorter numbers are kept, so a per-request
 *     counter under 8 digits still churns the hash;
 *   - base58 addresses of other chains (Solana: 32-44 mixed-case base58) are
 *     indistinguishable from tokens and are masked;
 *   - a long mixed-case token that happens to carry an API / publishable key
 *     (e.g. a 24+ char payment publishable key) is masked, so swapping it is
 *     not seen here (external SDK URLs keep their key params — see
 *     SCRIPT_IDENTITY_PARAMS_BY_HOST);
 *   - lowercase-only base36 tokens shorter than 32 chars are kept and churn.
 * The caller hashes the result (SHA-256) and passes the hex as the inline
 * script's sha256 — for executable scripts only (isExecutableScriptType).
 */
export function normaliseInlineScriptText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(INLINE_NOISE_RE, maskInlineNoise);
}

/** path_norm of an inline-script row: `sha256:<hex>` of the normalised text. */
export function inlineScriptPathNorm(sha256: string): string {
  return `sha256:${sha256.trim().toLowerCase()}`;
}

// ─── First-party classification ─────────────────────────────────────

/**
 * Is `host` first-party for a brand whose canonical domain is
 * `canonicalDomain`? True when it equals the canonical domain or is a
 * subdomain of it. Both sides are compared in punycode (an IDN canonical
 * domain matches the ASCII host a URL parse yields). A leading `www.` on the
 * canonical domain is ignored.
 *
 * Same rule as the official-domain triage: when the canonical domain is, or
 * sits under, a shared-hosting domain (acme.github.io, myshopify.com) only
 * an EXACT match counts, because subdomains there belong to other tenants.
 */
export function isFirstPartyHost(host: string, canonicalDomain: string): boolean {
  const h = toAsciiHost(host);
  const canon = toAsciiHost(canonicalDomain).replace(/^www\./, "");
  if (!h || !canon) return false;
  if (h === canon) return true;
  if (isUnderSharedHosting(canon)) return false;
  return h.endsWith(`.${canon}`);
}

// ─── Shared script CDNs / file hosts ────────────────────────────────

/**
 * Public script CDNs: a host here serves many unrelated sites, so its first
 * appearance on a brand's page says nothing about the brand on its own
 * (no new_host / new_contacted_host). The CONTENT still matters: several of
 * them (jsDelivr /gh/ and /npm/, unpkg, esm.sh, skypack) serve code anyone
 * can publish, so every script on a CDN host is still diffed — a never-seen
 * path raises new_script, even on the CDN's first appearance for the brand,
 * and an inventoried one raises body_changed / sri_removed. A host matches an entry when it equals
 * it or is a subdomain of it. Deliberately NOT here: tag managers /
 * analytics (a new one is worth a look), polyfill.io (the 2024 compromise
 * this feature exists for) and tenant hosting (*.herokuapp.com,
 * *.cloudfront.net, *.workers.dev … — where skimmers are actually hosted).
 */
export const WELL_KNOWN_SCRIPT_CDNS: ReadonlySet<string> = new Set([
  "cdnjs.cloudflare.com",
  "jsdelivr.net",
  "unpkg.com",
  "ajax.googleapis.com",
  "fonts.googleapis.com",
  "gstatic.com",
  "code.jquery.com",
  "bootstrapcdn.com",
  "ajax.aspnetcdn.com",
  "cdn.shopify.com",
  "akamaihd.net",
  "esm.sh",
  "skypack.dev",
]);

/** Is `host` a well-known script CDN (or a subdomain of one)? */
export function isWellKnownScriptCdn(host: string): boolean {
  return findHostSuffix(host, WELL_KNOWN_SCRIPT_CDNS) !== null;
}

/**
 * Shared infrastructure for the IOC lookup: a shared-hosting domain or a
 * public script CDN. Hosts here match threats EXACTLY only (their parents
 * are the provider's domain). Not used to suppress new_host.
 */
export function isSharedScriptHost(host: string): boolean {
  return isUnderSharedHosting(host) || isWellKnownScriptCdn(host);
}

/**
 * Public file / code hosts where the HOST says nothing and the PATH names
 * the content: a feed listing `raw.githubusercontent.com` for one bad file
 * must not flag every site that loads any file from it. Scripts on these
 * hosts are matched only by full URL (threats.malicious_url,
 * matchUrlsAgainstThreats), never by host. Matched as the host or a
 * subdomain. Exception: a subdomain of a storage-bucket service
 * (STORAGE_BUCKET_HOSTS: `bucket.s3.amazonaws.com`,
 * `acct.blob.core.windows.net`) is one tenant's bucket, so it ALSO gets an
 * exact-host lookup key (threatLookupKeys), like a shared-hosting tenant.
 */
export const URL_ONLY_IOC_HOSTS: ReadonlySet<string> = new Set([
  "githubusercontent.com",
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "storage.googleapis.com",
  "firebasestorage.googleapis.com",
  "drive.google.com",
  "docs.google.com",
  "drive.usercontent.google.com",
  "cdn.discordapp.com",
  "media.discordapp.net",
  "dropbox.com",
  "dropboxusercontent.com",
  "onedrive.live.com",
  "1drv.ms",
  "blob.core.windows.net",
  "s3.amazonaws.com",
  "pastebin.com",
  "paste.ee",
  "transfer.sh",
  "mega.nz",
  "codepen.io",
  "jsfiddle.net",
]);

/** Is `host` a public file host matched by URL only (URL_ONLY_IOC_HOSTS)? */
export function isUrlOnlyIocHost(host: string): boolean {
  return findHostSuffix(host, URL_ONLY_IOC_HOSTS) !== null;
}

/**
 * Object-storage services whose SUBDOMAINS are customer buckets / accounts
 * (virtual-hosted style). The service host itself stays URL-only; a bucket
 * host is a tenant and is looked up exactly (never its parents).
 */
export const STORAGE_BUCKET_HOSTS: ReadonlySet<string> = new Set([
  "s3.amazonaws.com",
  "blob.core.windows.net",
  "storage.googleapis.com",
  "firebasestorage.googleapis.com",
]);

/** Is `host` a tenant (strict subdomain) of a STORAGE_BUCKET_HOSTS service? */
export function isStorageBucketTenant(host: string): boolean {
  const h = normalizeHost(host);
  const entry = findHostSuffix(h, STORAGE_BUCKET_HOSTS);
  return entry !== null && entry !== h;
}

// ─── Content-hashed build files ─────────────────────────────────────

/** Minimum length of a path token treated as a build hash. */
export const CONTENT_HASH_MIN_LEN = 8;

/**
 * An all-digit token that reads as a date / time: YYYYMMDD, YYYYMMDDhhmm,
 * YYYYMMDDhhmmss (years 1990-2099, valid month and day) or a 10 / 13 digit
 * epoch (seconds / milliseconds, 2001-2033). A dated release directory
 * (`/js/20231105/checkout.js`) is a stable name, not a build hash.
 */
function isDateLikeDigits(t: string): boolean {
  if (!/^\d+$/.test(t)) return false;
  if ((t.length === 10 || t.length === 13) && t.startsWith("1")) return true;
  if (t.length !== 8 && t.length !== 12 && t.length !== 14) return false;
  const y = Number(t.slice(0, 4));
  const mo = Number(t.slice(4, 6));
  const d = Number(t.slice(6, 8));
  return y >= 1990 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
}

/** A digit-free camelCase / PascalCase word sequence (CheckOut, PayPalSdk, checkOut). */
const CAMEL_WORDS_RE = /^[a-z]*(?:[A-Z][a-z]+)+$/;

/**
 * Is `t` a build hash?
 *
 * Whole-name tokens (a whole dot-separated part of a segment: `app.<t>.js`,
 * a `/<t>/` directory) count only when they are
 *   - hex with at least one digit (`3f9a2c1b`, `0123abcd4567ef89`), or
 *   - long (≥ 16) base64url with digits AND upper AND lower case (a Next.js
 *     buildId `/_next/static/Xk9_2bQzT1aPq7LmN0vW/`).
 * So digit-free names (`CheckOut`, `PayPalSdk`) and non-hex short names with
 * digits (`sk1mmer2`) never count.
 *
 * Separator suffixes (after `-` / `_`: Vite / rollup `index-C5K0wNNo`) may
 * also be mixed-case base36 / base64url: digits plus letters, or — digit-
 * free — at least two upper and two lower case letters that are not a
 * camelCase word sequence (`index-BxQzkPaL` yes, `app-CheckOut` no).
 *
 * Always: 8-128 chars, no run of ≥ 5 lowercase letters (a word: vendors,
 * polyfills, handler), and never a date-like all-digit token.
 */
function isHashToken(t: string, separatorSuffix: boolean): boolean {
  if (t.length < CONTENT_HASH_MIN_LEN || t.length > 128) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(t)) return false;
  if (/[a-z]{5,}/.test(t)) return false;
  if (isDateLikeDigits(t)) return false;
  const digits = (t.match(/\d/g) ?? []).length;
  const upper = (t.match(/[A-Z]/g) ?? []).length;
  const lower = (t.match(/[a-z]/g) ?? []).length;
  if (/^[0-9a-f]+$/i.test(t)) return digits >= 1;
  if (!separatorSuffix) return t.length >= 16 && digits >= 1 && upper >= 1 && lower >= 1;
  if (digits >= 1) return upper + lower >= 1;
  return upper >= 2 && lower >= 2 && !CAMEL_WORDS_RE.test(t.replace(/[-_]/g, ""));
}

/**
 * The hashed part of one dot-separated token: the whole token, else the
 * SHORTEST hashed separator suffix (from the last `-` / `_` whose remainder
 * is a hash, so `_app-0123abcd4567ef89` keeps its `_app-` name), or null.
 */
function hashedPartOf(tok: string): { start: number } | null {
  if (isHashToken(tok, false)) return { start: 0 };
  for (let i = tok.length - 1; i >= 0; i--) {
    if ((tok[i] === "-" || tok[i] === "_") && isHashToken(tok.slice(i + 1), true)) return { start: i + 1 };
  }
  return null;
}

/**
 * Does `path` look content-hashed — a build hash that changes on every
 * deploy? Checked on every path segment (filename and directories), split
 * on `.`: each part is tested whole and by its `-` / `_` suffixes (rules in
 * isHashToken). `app.3f9a2c1b.js`, `main.0123abcd4567ef89.chunk.js`,
 * `index-C5K0wNNo.js`, rollup's `index-B-x_9aQz.js` and a Next.js buildId
 * directory match; `checkout.js`, `CheckOut.js`, `PayPalSdk.js`,
 * `sk1mmer2.js`, `/js/20231105/checkout.js`, `jquery-3.7.1.min.js` and
 * `polyfills-es2015.js` do not. Query string ignored.
 *
 * A hashed path alone is NOT a reason to stay silent — diffSiteScan also
 * needs the predecessor it replaces (contentHashStem).
 */
export function looksContentHashed(path: string): boolean {
  const pathname = path.split("?")[0] ?? "";
  return pathname.split("/").some((seg) => seg.split(".").some((tok) => hashedPartOf(tok) !== null));
}

/**
 * `path` with every build hash replaced by `#` (`/assets/index-C5K0wNNo.js`
 * → `/assets/index-#.js`, `/app.3f9a2c1b.js` → `/app.#.js`); the query
 * (identity params) is kept. Two builds of the same file share a stem.
 */
export function contentHashStem(path: string): string {
  const q = path.indexOf("?");
  const pathname = q === -1 ? path : path.slice(0, q);
  const query = q === -1 ? "" : path.slice(q);
  const stem = pathname
    .split("/")
    .map((seg) =>
      seg
        .split(".")
        .map((tok) => {
          const part = hashedPartOf(tok);
          return part ? `${tok.slice(0, part.start)}#` : tok;
        })
        .join("."),
    )
    .join("/");
  return stem + query;
}

// ─── Findings ───────────────────────────────────────────────────────

/** site_script_findings.kind values (free text in the schema, no CHECK). */
export type SiteScriptFindingKind =
  | "new_host"
  | "new_script"
  | "body_changed"
  | "sri_removed"
  | "new_contacted_host"
  | "ioc_match";

export interface SiteScriptFindingEvidence {
  /** Resolved absolute URL (fragment dropped); null for an inline script. */
  url: string | null;
  sha256?: string | null;
  prev_sha256?: string | null;
  integrity?: string | null;
  prev_integrity?: string | null;
  /** Present only when not https (e.g. 'http'). */
  scheme?: string;
  /** Present only for an explicit non-default port. */
  port?: string;
  /** http script / request on an https page. */
  mixed_content?: true;
  /** new_contacted_host: the script that made the request, when known. */
  initiator_url?: string | null;
}

export interface SiteScriptFinding {
  kind: SiteScriptFindingKind;
  host: string;
  path_norm: string | null;
  /** The page the finding was observed on. */
  page_url: string | null;
  threat_id: string | null;
  evidence: SiteScriptFindingEvidence;
}

/**
 * Kinds that describe a HOST, not one script on it: one open finding per
 * (brand, kind, host), whichever path / threat surfaced it.
 */
export const HOST_LEVEL_FINDING_KINDS: ReadonlySet<SiteScriptFindingKind> = new Set([
  "new_host",
  "new_contacted_host",
  "ioc_match",
]);

/**
 * site_script_findings.dedupe_key, JSON-encoded (unambiguous for any path):
 *   - host-level kinds (new_host, new_contacted_host, ioc_match): kind + host.
 *     new_host is raised on whichever new path came first, and ioc_match on
 *     the lowest matching threat id — neither must open a second finding for
 *     the same host when the path or the matching threat differs. (A URL-only
 *     ioc_match on a file host therefore collapses distinct bad files on that
 *     host into one open finding; the first one's evidence is kept.)
 *   - script-level kinds (new_script, body_changed, sri_removed): kind + host
 *     + path_norm, plus the new sha256 for body_changed, so a second change
 *     while the first is still open is recorded.
 * page_url is never part of it: the same script on ten pages is one finding.
 */
export function findingDedupeKey(f: Pick<SiteScriptFinding, "kind" | "host" | "path_norm" | "evidence">): string {
  if (HOST_LEVEL_FINDING_KINDS.has(f.kind)) return JSON.stringify([f.kind, f.host]);
  const parts: string[] = [f.kind, f.host, f.path_norm ?? ""];
  if (f.kind === "body_changed") parts.push(f.evidence.sha256 ?? "");
  return JSON.stringify(parts);
}

// ─── Scan bookkeeping (caller side) ─────────────────────────────────

/**
 * Is this the brand's baseline scan? The caller decides from site_scans
 * history: true when no earlier scan finished `complete`. (Not inferred from
 * an empty inventory — a wiped or swept inventory must not silently re-baseline.)
 */
export function isBaselineScan(priorCompleteScans: number): boolean {
  return priorCompleteScans <= 0;
}

/** A scan with 0 scripts is implausible when the previous complete scan had at least this many. */
export const SCAN_IMPLAUSIBLE_PREV_MIN = 3;
/** A scan with ≤ 10% of the previous complete scan's scripts is implausible when that scan had at least this many. */
export const SCAN_IMPLAUSIBLE_RATIO_PREV_MIN = 10;
/** After this many consecutive `skipped` scans the next one is accepted (the site really changed). */
export const SCAN_SKIP_ACCEPT_AFTER = 3;

export interface ScanPlausibility {
  status: "complete" | "skipped";
  reason: string | null;
}

/**
 * Flag a scan that is implausibly small next to the previous COMPLETE scan
 * (bot wall, render failure, truncated capture) as `skipped`: it is stored
 * but neither diffed nor written to the inventory. Rules: 0 scripts where
 * the previous had ≥ SCAN_IMPLAUSIBLE_PREV_MIN, or ≤ 10% where it had ≥
 * SCAN_IMPLAUSIBLE_RATIO_PREV_MIN. Once SCAN_SKIP_ACCEPT_AFTER scans in a
 * row were skipped the scan is accepted, so a real redesign is not skipped
 * forever. No previous complete scan → always complete.
 */
export function assessScanPlausibility(
  scriptsCount: number,
  previousCompleteScriptsCount: number | null,
  consecutiveSkips = 0,
): ScanPlausibility {
  const prev = previousCompleteScriptsCount;
  if (prev === null || consecutiveSkips >= SCAN_SKIP_ACCEPT_AFTER) return { status: "complete", reason: null };
  if (scriptsCount === 0 && prev >= SCAN_IMPLAUSIBLE_PREV_MIN) {
    return { status: "skipped", reason: `0 scripts; previous complete scan had ${prev}` };
  }
  if (prev >= SCAN_IMPLAUSIBLE_RATIO_PREV_MIN && scriptsCount * 10 <= prev) {
    return { status: "skipped", reason: `${scriptsCount} scripts; previous complete scan had ${prev}` };
  }
  return { status: "complete", reason: null };
}

// ─── Scan diff ──────────────────────────────────────────────────────

/** One script observed on a scan. */
export interface ScannedScript {
  /** External script src (relative resolves against page_url). Ignored when inline. */
  url?: string | null;
  /** Inline <script> body; sha256 is then the hash of normaliseInlineScriptText(text). */
  inline?: boolean;
  /**
   * The tag's `type` attribute (undefined / null = absent). An inline script
   * whose type is not executable (isExecutableScriptType: application/json,
   * ld+json, importmap …) is a data block and is dropped (counted in
   * SiteScanDiff.data_blocks). External scripts are not filtered on it.
   */
  type?: string | null;
  /** External: SHA-256 of the body, null = not fetched. Inline: required. */
  sha256: string | null;
  /** The tag's SRI `integrity` attribute: undefined = not captured, null / '' = absent. */
  integrity?: string | null;
  /** The page the script was seen on (defaults to DiffSiteScanOptions.pageUrl). */
  page_url?: string | null;
}

/** The stored inventory columns the diff needs (site_script_inventory). */
export interface InventoryRow {
  script_host: string;
  path_norm: string;
  last_sha256: string | null;
  integrity?: string | null;
}

/** A script after normalisation and de-duplication, ready to upsert. */
export interface ObservedScript {
  host: string;
  path_norm: string;
  /** Resolved absolute URL; null for inline. */
  url: string | null;
  page_url: string | null;
  sha256: string | null;
  /** undefined = not captured (an upsert must leave the stored value alone). */
  integrity?: string | null;
  is_first_party: boolean;
  is_inline: boolean;
  /** Public script CDN (WELL_KNOWN_SCRIPT_CDNS): exempt from new_host. */
  cdn: boolean;
  /** Under SHARED_HOSTING_DOMAINS: NOT exempt from new_host; exact-only IOC lookup. */
  shared_hosting: boolean;
  scheme: string | null;
  port: string | null;
}

export interface SiteScanDiff {
  /** Distinct (host, path_norm) scripts in this scan, first occurrence wins. */
  observed: ObservedScript[];
  findings: SiteScriptFinding[];
  /** True when nothing was compared (baseline scan): no findings are produced. */
  baseline: boolean;
  /** Inputs dropped (non-http(s) / unparseable src, inline without a hash). */
  rejected: number;
  /** Inline non-executable data blocks dropped (JSON, JSON-LD, import maps …). */
  data_blocks: number;
}

export interface DiffSiteScanOptions {
  /** Brand's canonical domain, for first-party classification. */
  canonicalDomain: string;
  /** Default page URL: resolves relative srcs and fills page_url. */
  pageUrl?: string;
  /**
   * Baseline scan (decide with isBaselineScan from site_scans history): only
   * builds the inventory, produces no findings. Defaults to FALSE — the safe
   * side: a caller that forgets the flag over-reports (every external host
   * on a first scan is new_host) instead of silently treating a page that is
   * compromised today as the trusted baseline.
   */
  baseline?: boolean;
}

function scriptKey(host: string, pathNorm: string): string {
  return `${host}\u0000${pathNorm}`;
}

function locationEvidence(o: { url: string | null; scheme: string | null; port: string | null }, pageUrl: string | null): Partial<SiteScriptFindingEvidence> {
  const out: Partial<SiteScriptFindingEvidence> = {};
  if (o.scheme && o.scheme !== "https" && o.scheme !== "wss") out.scheme = o.scheme;
  if (o.port) out.port = o.port;
  if (pageUrl && (o.scheme === "http" || o.scheme === "ws")) {
    try {
      if (new URL(pageUrl).protocol === "https:") out.mixed_content = true;
    } catch {
      /* unparseable page URL: no mixed-content flag */
    }
  }
  return out;
}

function hasIntegrity(v: string | null | undefined): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Diff one scan against the brand's stored inventory.
 *
 *   new_host     — an EXTERNAL script host with no inventory row for the
 *                  brand, one finding per host (on its first new path).
 *                  Only public script CDNs (WELL_KNOWN_SCRIPT_CDNS) are
 *                  exempt; a tenant on shared hosting (x.herokuapp.com,
 *                  d1.cloudfront.net, y.workers.dev) is exactly where a
 *                  skimmer lives and DOES raise it.
 *   new_script   — a new path_norm on a third-party host that is already
 *                  inventoried OR is a public script CDN (a CDN's first
 *                  appearance suppresses new_host, not its scripts:
 *                  jsDelivr /gh/, unpkg and esm.sh serve attacker-published
 *                  code). Always for third-party hosts. On an inventoried
 *                  first-party host a content-hashed build file
 *                  (looksContentHashed) is skipped ONLY when it replaces an
 *                  inventoried file with the same contentHashStem on that
 *                  host that this scan no longer loads (each predecessor
 *                  covers one new file); a hashed file with no disappeared
 *                  counterpart still raises new_script.
 *                  Inline scripts: '(inline)' counts as a first-party host,
 *                  so a new inline hash raises new_script once the inventory
 *                  holds any inline row (until then inline scripts are
 *                  silently baselined, like a new first-party host). Inline
 *                  data blocks (non-executable `type`) are dropped.
 *   body_changed — same host + path_norm, both hashes known, different.
 *                  First-party scripts included (injected first-party JS is
 *                  the classic skimmer).
 *   sri_removed  — the stored row had an integrity attribute and this scan
 *                  captured the tag without one (undefined = not captured →
 *                  no finding).
 */
export function diffSiteScan(
  scripts: readonly ScannedScript[],
  inventory: readonly InventoryRow[],
  opts: DiffSiteScanOptions,
): SiteScanDiff {
  const observed: ObservedScript[] = [];
  const seen = new Map<string, ObservedScript>();
  let rejected = 0;
  let dataBlocks = 0;

  for (const s of scripts) {
    const pageUrl = s.page_url ?? opts.pageUrl ?? null;
    let o: ObservedScript;
    if (s.inline) {
      if (!isExecutableScriptType(s.type)) {
        dataBlocks++;
        continue;
      }
      const sha = s.sha256?.trim().toLowerCase();
      if (!sha) {
        rejected++;
        continue;
      }
      o = {
        host: INLINE_SCRIPT_HOST,
        path_norm: inlineScriptPathNorm(sha),
        url: null,
        page_url: pageUrl,
        sha256: sha,
        is_first_party: true,
        is_inline: true,
        cdn: false,
        shared_hosting: false,
        scheme: null,
        port: null,
      };
    } else {
      const n = s.url ? normaliseScriptUrl(s.url, pageUrl) : null;
      if (!n) {
        rejected++;
        continue;
      }
      o = {
        host: n.host,
        path_norm: n.path_norm,
        url: n.url,
        page_url: pageUrl,
        sha256: s.sha256 || null,
        is_first_party: isFirstPartyHost(n.host, opts.canonicalDomain),
        is_inline: false,
        cdn: isWellKnownScriptCdn(n.host),
        shared_hosting: isUnderSharedHosting(n.host),
        scheme: n.scheme,
        port: n.port,
      };
      if (s.integrity !== undefined) o.integrity = s.integrity || null;
    }
    const key = scriptKey(o.host, o.path_norm);
    const prior = seen.get(key);
    if (prior) {
      // Same script loaded twice (cache-buster variants, several pages):
      // keep the first occurrence, fill in what it lacked.
      if (prior.sha256 === null && o.sha256) prior.sha256 = o.sha256;
      if (prior.integrity === undefined && o.integrity !== undefined) prior.integrity = o.integrity;
      continue;
    }
    seen.set(key, o);
    observed.push(o);
  }

  if (opts.baseline === true) return { observed, findings: [], baseline: true, rejected, data_blocks: dataBlocks };

  const knownHosts = new Set<string>();
  const known = new Map<string, InventoryRow>();
  for (const r of inventory) {
    const host = r.script_host === INLINE_SCRIPT_HOST ? r.script_host : normalizeHost(r.script_host);
    knownHosts.add(host);
    known.set(scriptKey(host, r.path_norm), r);
  }

  // Hashed first-party files this scan no longer loads, per (host, stem):
  // the predecessors a new hashed build file may replace (one each).
  const replaceable = new Map<string, number>();
  for (const [key, r] of known) {
    if (seen.has(key)) continue;
    const host = key.slice(0, key.indexOf("\u0000"));
    if (host === INLINE_SCRIPT_HOST || !looksContentHashed(r.path_norm)) continue;
    const sk = scriptKey(host, contentHashStem(r.path_norm));
    replaceable.set(sk, (replaceable.get(sk) ?? 0) + 1);
  }
  const replacesDisappeared = (o: ObservedScript): boolean => {
    const sk = scriptKey(o.host, contentHashStem(o.path_norm));
    const n = replaceable.get(sk) ?? 0;
    if (n <= 0) return false;
    replaceable.set(sk, n - 1);
    return true;
  };

  const findings: SiteScriptFinding[] = [];
  const newHostRaised = new Set<string>();
  const finding = (
    kind: SiteScriptFindingKind,
    o: ObservedScript,
    extra: Partial<SiteScriptFindingEvidence> = {},
  ): SiteScriptFinding => ({
    kind,
    host: o.host,
    path_norm: o.path_norm,
    page_url: o.page_url,
    threat_id: null,
    evidence: { url: o.url, sha256: o.sha256, ...locationEvidence(o, o.page_url), ...extra },
  });

  for (const o of observed) {
    if (!knownHosts.has(o.host)) {
      // A new public script CDN: no new_host, but fall through so each of
      // its scripts raises new_script below (it serves anyone's code).
      if (!o.cdn) {
        if (!o.is_first_party && !newHostRaised.has(o.host)) {
          newHostRaised.add(o.host);
          findings.push(finding("new_host", o));
        }
        continue;
      }
    }
    const row = known.get(scriptKey(o.host, o.path_norm));
    if (!row) {
      const hashedReplacement =
        !o.is_inline && o.is_first_party && looksContentHashed(o.path_norm) && replacesDisappeared(o);
      if (!hashedReplacement) findings.push(finding("new_script", o));
      continue;
    }
    const prev = row.last_sha256 ?? null;
    if (prev && o.sha256 && prev !== o.sha256) {
      findings.push(finding("body_changed", o, { prev_sha256: prev }));
    }
    if (hasIntegrity(row.integrity) && o.integrity !== undefined && !hasIntegrity(o.integrity)) {
      findings.push(finding("sri_removed", o, { integrity: null, prev_integrity: row.integrity }));
    }
  }
  return { observed, findings, baseline: false, rejected, data_blocks: dataBlocks };
}

// ─── Contacted-host diff ────────────────────────────────────────────

/** One network request the page made (script, XHR / fetch, beacon, websocket). */
export interface ContactedRequest {
  url: string;
  /**
   * Requests this entry stands for (default 1). The site-scan driver records
   * ONE entry per contacted host (its first URL + initiator) with the
   * host's request count, so a request cap can never hide a late new host.
   */
  count?: number;
  /** URL of the script that made the request, when the capture knows it. */
  initiator_url?: string | null;
  /** The page it was made from (defaults to DiffContactedHostsOptions.pageUrl). */
  page_url?: string | null;
}

/** One distinct contacted host, ready to upsert into site_contacted_hosts. */
export interface ObservedContactedHost {
  host: string;
  request_count: number;
  /** First request URL to the host (fragment dropped, truncated). */
  first_url: string;
  /** The script behind the first request that named an initiator. */
  initiator_host: string | null;
  initiator_path: string | null;
  initiator_url: string | null;
  page_url: string | null;
  is_first_party: boolean;
  cdn: boolean;
  scheme: string;
  port: string | null;
}

export interface ContactedHostDiff {
  observed: ObservedContactedHost[];
  findings: SiteScriptFinding[];
  baseline: boolean;
  rejected: number;
}

export interface DiffContactedHostsOptions {
  canonicalDomain: string;
  pageUrl?: string;
  /** Same contract and FALSE default as DiffSiteScanOptions.baseline. */
  baseline?: boolean;
}

/**
 * Diff the hosts a scan contacted against the brand's stored
 * site_contacted_hosts. `new_contacted_host` — one finding per host never
 * contacted before: the exfil endpoint of a skimmer whose loader looks
 * innocent. First-party hosts and public script CDNs are exempt; shared-
 * hosting tenants are not. http(s) and ws(s) requests count; anything else
 * (data:, blob:, chrome-extension:) is rejected.
 */
export function diffContactedHosts(
  requests: readonly ContactedRequest[],
  knownHosts: readonly string[],
  opts: DiffContactedHostsOptions,
): ContactedHostDiff {
  const byHost = new Map<string, ObservedContactedHost>();
  const observed: ObservedContactedHost[] = [];
  let rejected = 0;
  for (const r of requests) {
    const pageUrl = r.page_url ?? opts.pageUrl ?? null;
    const url = parseAbsolute(r.url, pageUrl, REQUEST_PROTOCOLS);
    if (!url) {
      rejected++;
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    const init = r.initiator_url ? normaliseScriptUrl(r.initiator_url, pageUrl) : null;
    const n = typeof r.count === "number" && Number.isFinite(r.count) && r.count >= 1 ? Math.floor(r.count) : 1;
    const prior = byHost.get(host);
    if (prior) {
      prior.request_count += n;
      if (!prior.initiator_host && init) {
        prior.initiator_host = init.host;
        prior.initiator_path = init.path_norm;
        prior.initiator_url = init.url;
      }
      continue;
    }
    const o: ObservedContactedHost = {
      host,
      request_count: n,
      first_url: truncate(url.href, SITE_SCRIPT_EVIDENCE_URL_MAX),
      initiator_host: init?.host ?? null,
      initiator_path: init?.path_norm ?? null,
      initiator_url: init?.url ?? null,
      page_url: pageUrl,
      is_first_party: isFirstPartyHost(host, opts.canonicalDomain),
      cdn: isWellKnownScriptCdn(host),
      scheme: url.protocol.slice(0, -1),
      port: url.port || null,
    };
    byHost.set(host, o);
    observed.push(o);
  }

  if (opts.baseline === true) return { observed, findings: [], baseline: true, rejected };

  const known = new Set(knownHosts.map((h) => normalizeHost(h)));
  const findings: SiteScriptFinding[] = [];
  for (const o of observed) {
    if (known.has(o.host) || o.is_first_party || o.cdn) continue;
    findings.push({
      kind: "new_contacted_host",
      host: o.host,
      path_norm: null,
      page_url: o.page_url,
      threat_id: null,
      evidence: {
        url: o.first_url,
        initiator_url: o.initiator_url,
        ...locationEvidence({ url: o.first_url, scheme: o.scheme, port: o.port }, o.page_url),
      },
    });
  }
  return { observed, findings, baseline: false, rejected };
}

// ─── IOC match against active threats ───────────────────────────────

/** Max lookup keys bound per statement (D1 caps a statement at 100 binds). */
export const SITE_SCRIPT_MATCH_CHUNK = 90;

export interface ThreatMatch {
  /** The input host (normalised); for a URL match, the URL's host. */
  host: string;
  /** The threats value that matched: domain, IP or URL. */
  matched_value: string;
  /**
   * exact / parent — threats.malicious_domain equals the host / a parent;
   * ip — threats.ip_address equals the IP-literal host;
   * url — threats.malicious_url equals the script URL.
   */
  match_kind: "exact" | "parent" | "ip" | "url";
  threat_id: string;
  /** source_feed of that (lowest-id) threat. */
  source_feed: string | null;
}

function isNoiseKey(k: string): boolean {
  return SHARED_HOSTING_DOMAINS.has(k) || isWellKnownScriptCdn(k) || isUrlOnlyIocHost(k);
}

/**
 * threats.malicious_domain lookup keys for one host: the host itself, plus
 * its parent domains down to the registrable domain.
 *   - IP literal → the IP alone (no parents).
 *   - Storage bucket (a subdomain of STORAGE_BUCKET_HOSTS:
 *     `evil-bucket.s3.amazonaws.com`) → the host exactly. It is one tenant's
 *     bucket; its scripts are ALSO matched by URL.
 *   - Other public file host (URL_ONLY_IOC_HOSTS) → none: matched by URL only.
 *   - Shared hosting / public CDN tenant → the host exactly (its parents are
 *     the provider's domain, not the operator's).
 *   - A key that is itself a shared-hosting domain, CDN or file host is never
 *     looked up — a feed listing `cdn.jsdelivr.net` would flag every site.
 */
export function threatLookupKeys(host: string): string[] {
  const h = toAsciiHost(host);
  if (!h || h.includes(" ")) return [];
  if (ipLiteral(h)) return [h];
  if (isStorageBucketTenant(h)) return [h];
  if (isUrlOnlyIocHost(h)) return [];
  if (isSharedScriptHost(h)) return isNoiseKey(h) ? [] : [h];
  const keys = new Set<string>([h]);
  for (const k of hostAndParents(h)) if (!isNoiseKey(k)) keys.add(k);
  return [...keys];
}

/**
 * threats.malicious_url lookup keys for one script URL: the absolute URL
 * (fragment dropped) and, when it has a query, the same URL without it.
 * Only http(s) URLs; bound values, never interpolated.
 */
export function threatUrlLookupKeys(raw: string): string[] {
  const url = parseAbsolute(raw, null, SCRIPT_PROTOCOLS);
  if (!url) return [];
  const keys = [url.href];
  if (url.search) {
    url.search = "";
    keys.push(url.href);
  }
  return keys;
}

/** threats columns the IOC lookup probes (a fixed set, never caller input). */
export type ThreatMatchColumn = "malicious_domain" | "malicious_url" | "ip_address";

/**
 * The lookup statement for `n` values of one threats column. Columns are a
 * fixed set (never caller input); values are always bound. `source_feed` is
 * a bare column next to the single MIN() aggregate, so SQLite returns it
 * from the row MIN(id) picked (the matched threat's own feed) — no second
 * round trip to read it.
 *
 *   malicious_domain — idx_threats_domain. `ioc_value`'s index (0001) went
 *     with 0013's table rebuild and was never restored (see 0312's header),
 *     so `ioc_value` is not probed.
 *   malicious_url    — idx_threats_malicious_url (0278, partial on NOT NULL;
 *     `IN (…)` implies NOT NULL).
 *   ip_address       — idx_threats_ip_source_feed (0123, leading column
 *     ip_address). 0001's idx_threats_ip did not survive 0013's rebuild.
 *
 * `+status` (unary plus) is load-bearing: without it SQLite picks
 * idx_threats_status_created and walks every ACTIVE threat instead of
 * seeking the column index for the few bound values (pinned by the EXPLAIN
 * QUERY PLAN tests).
 */
export function threatMatchSql(n: number, column: ThreatMatchColumn = "malicious_domain"): string {
  const placeholders = Array.from({ length: n }, () => "?").join(", ");
  return (
    `SELECT ${column} AS matched_value, MIN(id) AS threat_id, source_feed FROM threats ` +
    `WHERE ${column} IN (${placeholders}) AND +status = 'active' ` +
    `GROUP BY ${column}`
  );
}

interface ThreatRow {
  matched_value: string;
  threat_id: string;
  source_feed: string | null;
}

async function probeThreats(
  db: D1Database | D1DatabaseSession,
  column: ThreatMatchColumn,
  keys: readonly string[],
): Promise<ThreatRow[]> {
  const out: ThreatRow[] = [];
  for (let i = 0; i < keys.length; i += SITE_SCRIPT_MATCH_CHUNK) {
    const chunk = keys.slice(i, i + SITE_SCRIPT_MATCH_CHUNK);
    const res = await db
      .prepare(threatMatchSql(chunk.length, column))
      .bind(...chunk)
      .all<ThreatRow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

function addKey(map: Map<string, Set<string>>, key: string, source: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(source);
  map.set(key, set);
}

/**
 * Match hosts (script hosts, contacted hosts) against ACTIVE threats:
 * threats.malicious_domain for the host and its parents (threatLookupKeys),
 * and threats.ip_address for IP-literal hosts. One row per (host, matched
 * value) with the lowest matching threat id. Values are always bound,
 * ≤ SITE_SCRIPT_MATCH_CHUNK per statement. Pass a read session. Public file
 * hosts never match here — use matchUrlsAgainstThreats.
 */
export async function matchHostsAgainstThreats(
  db: D1Database | D1DatabaseSession,
  hosts: readonly string[],
): Promise<ThreatMatch[]> {
  const domainKeys = new Map<string, Set<string>>();
  const ipKeys = new Map<string, Set<string>>();
  for (const raw of hosts) {
    if (raw === INLINE_SCRIPT_HOST) continue;
    const host = toAsciiHost(raw);
    for (const k of threatLookupKeys(host)) addKey(domainKeys, k, host);
    const ip = ipLiteral(host);
    if (ip) addKey(ipKeys, ip, host);
  }

  const out: ThreatMatch[] = [];
  if (domainKeys.size) {
    for (const row of await probeThreats(db, "malicious_domain", [...domainKeys.keys()])) {
      for (const host of domainKeys.get(row.matched_value) ?? []) {
        out.push({
          host,
          matched_value: row.matched_value,
          match_kind: row.matched_value === host ? "exact" : "parent",
          threat_id: row.threat_id,
          source_feed: row.source_feed ?? null,
        });
      }
    }
  }
  if (ipKeys.size) {
    for (const row of await probeThreats(db, "ip_address", [...ipKeys.keys()])) {
      for (const host of ipKeys.get(row.matched_value) ?? []) {
        out.push({ host, matched_value: row.matched_value, match_kind: "ip", threat_id: row.threat_id, source_feed: row.source_feed ?? null });
      }
    }
  }
  return out;
}

/**
 * Match full script URLs against ACTIVE threats on threats.malicious_url
 * (threatUrlLookupKeys: the URL, and the URL without its query). This is
 * the only IOC path for public file hosts (URL_ONLY_IOC_HOSTS) and also
 * catches URL-only IOCs (TAXII stores them with malicious_domain NULL).
 * One row per (input URL, matched value). Pass a read session.
 */
export async function matchUrlsAgainstThreats(
  db: D1Database | D1DatabaseSession,
  urls: readonly string[],
): Promise<ThreatMatch[]> {
  const keys = new Map<string, Set<string>>();
  for (const u of urls) for (const k of threatUrlLookupKeys(u)) addKey(keys, k, u);
  if (keys.size === 0) return [];
  const out: ThreatMatch[] = [];
  for (const row of await probeThreats(db, "malicious_url", [...keys.keys()])) {
    for (const u of keys.get(row.matched_value) ?? []) {
      // Same host form as matchHostsAgainstThreats (trailing dot stripped), so
      // a URL match and a host match on one host share an ioc_match dedupe key.
      const host = parseAbsolute(u, null, SCRIPT_PROTOCOLS)?.hostname.toLowerCase().replace(/\.+$/, "") ?? "";
      out.push({ host, matched_value: row.matched_value, match_kind: "url", threat_id: row.threat_id, source_feed: row.source_feed ?? null });
    }
  }
  return out;
}
