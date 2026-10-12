/**
 * Brand Auto-Detection — Match threat domains against known brands.
 *
 * Strategies (in order of confidence), all evaluated against the HOST
 * only (never a URL path) and never against its public suffix — so
 * "drasw.club" can't match a brand named "Club":
 * 1. canonical   — host equals brands.canonical_domain
 * 2. token       — a host label / hyphen-token equals the brand name,
 *                  optionally after stripping phishing filler words
 *                  ("kick-login.com", "kicklogin.com" → Kick)
 * 3. substring   — brand name (>= 6 chars) appears inside a label,
 *                  raw or filler-stripped ("paypalsecure.com" → PayPal)
 * 4. levenshtein — label within edit distance of the brand name: 1 for
 *                  6–7 char names, 2 for 8+; same first character
 * 5. glued       — a 4–5 char name inside one long run-on token next to a
 *                  lure word ("invitationlauchjczoommeeting" → Zoom);
 *                  only when 1–4 found nothing (gluedTokenMatch)
 *
 * Generic-word brand names ("Data", "Login", "Mail", "Site", …) never
 * match by name: only their canonical domain or a genuine lookalike of the
 * FULL canonical domain ("mai1.ru", "mail-ru.com" — genericBrandHostMatch),
 * tried after every other rule. The catalog holds 100K+ brands, and a
 * dictionary-word name otherwise matches unrelated infrastructure.
 */

import { registrableDomain } from "./domain-utils";
import { SHARED_HOSTING_DOMAINS } from "./safeDomains";
import {
  IDP_TENANT_HOSTS,
  IDP_VENDOR_BRAND_TOKEN,
  classifyIdpImpersonation,
  idpTenantLabel,
  isIdpVendorFamilyToken,
  splitIdpLureToken,
  type IdpProvider,
} from "./idp-impersonation";
import { tagThreat, brandTokensFrom, idpTagUpdateStmt, isIdpFamilyTag } from "./idp-tagging";
import { enqueueAutoCaptures } from "./page-capture";

export interface BrandRow {
  id: string;
  name: string;
  canonical_domain: string;
  /**
   * brands.tier. `tracked` = the passive Tranco top-1M catalog (~112K rows,
   * full of dictionary words and hosting services) — matches ONLY by exact
   * canonical domain. `monitored` / `customer` (or unknown) get the full
   * fuzzy rule set. Production dry run 2026-10-01: 74% of the new matcher's
   * relinks landed on tracked brands ("Protocol", "Shield", "Dynv6",
   * "Vault", …); the real targets (T-Mobile, Ledger, MetaMask) are monitored.
   */
  tier?: string | null;
  /**
   * brands.tranco_rank. Only consulted for IdP-lure leftovers: a leftover
   * may credit a brand only if it is monitored/customer tier or well known
   * (rank <= IDP_LEFTOVER_MAX_RANK) — never Tranco catalog junk.
   */
  tranco_rank?: number | null;
}

/** Which rule produced a match — persisted to threats.brand_match_method. */
export type BrandMatchMethod = "canonical" | "token" | "substring" | "levenshtein";

export interface BrandMatch {
  brandId: string;
  method: BrandMatchMethod;
  /**
   * Set when an idp_lookalike host had no other brand evidence and the IdP
   * VENDOR itself was credited (okta-login-secure.com, logmein-
   * microsoftonline.com). Lets the re-attribution backfill keep the existing
   * vendor link instead of moving it between duplicate vendor brand rows.
   */
  vendorCredit?: true;
}

/** Brand names shorter than this need a whole-token match (no substring/fuzzy). */
const MIN_SUBSTRING_LEN = 6;

/**
 * Glued-substring rule (2026-10-12) for 4–5 char names, which otherwise
 * need a whole token: the name may sit INSIDE one long run-on token
 * ("invitationlauchjczoommeeting" → Zoom, "adobeacrobatdoc" → Adobe,
 * "myadobesign" → Adobe) when ALL of:
 *   - the brand is matchable (monitored/customer or untiered, not generic);
 *   - the hyphen token is at least GLUED_MIN_TOKEN_LEN chars (a short
 *     glue like "kicklogin"/"helpscout" stays a non-match);
 *   - a phishing / document-lure word (GLUED_LURE_WORDS) sits DIRECTLY
 *     beside the name on at least one side — the whole remaining side for a
 *     short word ("…sign"), or a prefix/suffix of it for a word of 5+ chars
 *     ("…meeting…", "acrobat…");
 *   - a name that is a common fragment of English words
 *     (GLUED_EMBED_HAZARD: purchase→chase, pineapple→apple, citizen→citi)
 *     must also sit at the token's start or end, with the lure on the
 *     other side ("chaseverifyaccount", "loginchase" yes; "purchaseverify",
 *     "pineapplelogin" no).
 * Never applies to IdP-lure leftovers (whole-token only) and runs only
 * after every other rule found nothing, so existing matches are unchanged.
 */
const GLUED_MIN_TOKEN_LEN = 10;

const GLUED_LURE_WORDS: readonly string[] = [
  // account / credential lures
  "login", "logon", "signin", "signon", "secure", "security", "verify", "verification",
  "account", "accounts", "update", "confirm", "support", "password", "wallet", "billing",
  "invoice", "payment", "refund", "recovery", "unlock", "alert", "notice", "auth",
  // meeting / document / e-sign lures
  "meeting", "meet", "invite", "invitation", "webinar", "join", "sign", "esign", "doc", "docs",
  "document", "documents", "pdf", "acrobat", "reader", "share", "shared", "file", "files",
  "drive", "fax", "scan",
];

/** 4–5 char brand names that are common fragments of English words — an
 *  occurrence embedded mid-token is more likely the word than the brand. */
const GLUED_EMBED_HAZARD: ReadonlySet<string> = new Set([
  "chase", "ally", "citi", "meta", "uber", "dell", "visa", "wells", "steam", "kick", "wise",
  "bolt", "epic", "apple", "intel", "chime", "curve", "slack", "shell", "opera", "metro",
  "three", "hinge", "crave", "coles", "slate", "sushi", "lumen", "gusto", "wiley", "unity",
  "azure", "globo", "forms", "pages", "ring", "nest", "mint", "bing", "ford", "audi", "wish",
  "ramp", "tron", "atom", "near", "scout", "flow", "desk", "post",
]);

function gluedLureAt(side: string, atEnd: boolean): boolean {
  if (side.length === 0) return false;
  for (const w of GLUED_LURE_WORDS) {
    if (side === w) return true;
    if (w.length >= 5 && (atEnd ? side.endsWith(w) : side.startsWith(w))) return true;
  }
  return false;
}

/** The glued-substring rule for one hyphen token and one normalized name. */
function gluedTokenMatch(token: string, norm: string): boolean {
  if (token.length < GLUED_MIN_TOKEN_LEN || token === norm) return false;
  const edgeOnly = GLUED_EMBED_HAZARD.has(norm);
  for (let i = token.indexOf(norm); i >= 0; i = token.indexOf(norm, i + 1)) {
    const prefix = token.slice(0, i);
    const suffix = token.slice(i + norm.length);
    if (edgeOnly) {
      if ((prefix === "" && gluedLureAt(suffix, false)) || (suffix === "" && gluedLureAt(prefix, true))) return true;
    } else if (gluedLureAt(suffix, false) || gluedLureAt(prefix, true)) {
      return true;
    }
  }
  return false;
}

/** Words commonly inserted into typosquat / phishing domains to obfuscate. */
const OBFUSCATION_WORDS = [
  "login", "logon", "log", "signin", "signin", "sign", "verify",
  "secure", "account", "support", "help", "official", "update",
  "confirm", "alert", "service", "customer", "online", "web",
];

const OBFUSCATION_RE = new RegExp(OBFUSCATION_WORDS.join("|"), "gi");

/**
 * Strip common phishing obfuscation words and hyphens from a string.
 */
export function stripObfuscation(input: string): string {
  return input
    .replace(/-/g, "")
    .replace(OBFUSCATION_RE, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "");
}

/**
 * Levenshtein edit distance between two strings.
 * Bails out early if distance exceeds maxDist.
 */
export function levenshtein(a: string, b: string, maxDist = 2): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;

  // Single-row DP with early bail-out
  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);

  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }

  return prev[lb];
}

/** Normalized brand name (lowercase, alphanumeric only). */
export function normalizeBrand(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Brand names that are dictionary words, phishing filler, or TLD labels.
 * These brands match ONLY by exact canonical domain: as a token they hit
 * unrelated infrastructure ("Data" had 164K links, "Login" 88K, "Click"
 * matched every *.click domain). Compared against the normalized name.
 */
const GENERIC_BRAND_NAMES = new Set([
  // original short URL fragments
  "www", "one", "bit", "dns", "app", "web", "api", "cdn", "dev", "net", "goo",
  // TLD / public-suffix labels seen as brand names
  "com", "org", "info", "xyz", "top", "club", "click", "link", "links", "site",
  "sites", "online", "store", "shop", "shops", "live", "cloud", "page", "pages",
  "observer", "space", "zone", "world", "today", "news", "blog", "tech", "group",
  // phishing filler / account-flow words
  "login", "logon", "signin", "sign", "verify", "secure", "security", "account",
  "accounts", "support", "help", "official", "update", "confirm", "alert",
  "service", "services", "customer", "auth", "admin", "portal", "access",
  "user", "users", "mail", "email", "webmail", "office", "drive", "docs",
  "file", "files", "share", "form", "forms", "invoice", "billing", "payment",
  "payments", "wallet", "bank", "banking", "card", "cash", "money", "crypto",
  "coin", "track", "tracking", "delivery", "parcel", "order", "orders",
  // generic dictionary words observed as catalog brand names
  "data", "word", "words", "list", "lists", "line", "digital", "media",
  "china", "factory", "workers", "home", "free", "best", "global", "market",
  "trade", "deal", "deals", "plus", "smart", "host", "hosting", "server",
  "domain", "center", "centre", "mobile", "phone", "chat", "video", "photo",
  "music", "movie", "search", "health", "care", "life", "travel", "network",
  "system", "systems", "solutions", "express", "direct", "first", "safe",
  "fast", "easy", "star", "city", "land", "house", "family", "school",
  "social", "stream", "view", "watch", "event", "events", "ticket", "tickets",
  "gift", "bonus", "promo", "offer", "reward", "rewards", "lucky", "casino",
  "sport", "sports", "auto", "energy", "power", "green", "blue", "black",
  "white", "gold", "design", "studio", "agency", "capital", "finance",
  "invest", "insurance", "loan", "loans", "credit", "legal", "public",
  "national", "international", "united", "general", "central", "union",
  "mart", "base", "labs", "code", "test", "demo", "beta", "next", "daily",
  "open", "team", "work", "works", "tools", "apps", "games", "game", "play",
  "company", "people", "matrix", "token", "photo", "food", "love", "bill",
  // 2026-10-12 generic-brand audit. Sub-4-char words never reach the
  // name matcher (MIN length 4) but the keyword writers (NRD, CT, spam
  // trap, abuse mailbox, typosquat scanner) read this list too.
  "pay", "gnu", "inbox", "message", "messages", "connect",
]);

/** The generic-word list (normalized), for SQL prefilters
 *  (brand-link cleanup generic_brands scope). Numeric names are separate. */
export function genericBrandWords(): string[] {
  return [...GENERIC_BRAND_NAMES];
}

/** Returns true if a normalized brand name may only match by canonical domain. */
export function isGenericBrand(normalized: string): boolean {
  return /^\d+$/.test(normalized) || GENERIC_BRAND_NAMES.has(normalized);
}

/**
 * The one shared "is this a generic-word brand" predicate over a raw brand
 * NAME ("Mail", "Site", "Login", "1&1"). Every writer that credits a brand
 * by name or keyword (brand matcher, Analyst keyword pre-match, NRD
 * keyword matcher, CT keyword feed, typosquat scanner, numbered-variant
 * scan, lookalike seeder, spam trap, abuse mailbox) consults it: a generic
 * brand is credited ONLY for its canonical domain, a subdomain of it, or a
 * genuine lookalike of the FULL canonical domain (genericBrandHostMatch) —
 * never for the bare word in a host ("1lookupmails.com" is not Mail.ru).
 */
export function isGenericBrandName(name: string | null | undefined): boolean {
  return isGenericBrand(normalizeBrand(name ?? ""));
}

/**
 * Generic-word names that are ALSO the trading name phishers spell out bare
 * beside a lure ("line-login.com" targets LINE). Only the NRD keyword
 * matcher — whose generic rule demands an adjacent STRONG lure word
 * (lib/nrd-brand-match.ts) — keeps the bare word for these; every other
 * writer treats them like any generic brand. Keep this list tiny and
 * per-name justified.
 */
const LURE_GATED_GENERIC_BRANDS: ReadonlySet<string> = new Set(["line"]);

export function isLureGatedGenericBrand(name: string | null | undefined): boolean {
  return LURE_GATED_GENERIC_BRANDS.has(normalizeBrand(name ?? ""));
}

/** Canonical domain → lowercase labels, `www.` and trailing dot dropped.
 *  [] when that leaves a bare public suffix ("www.gov.uk" → "gov.uk"),
 *  which names no brand. */
function canonicalLabels(canonical: string): string[] {
  const labels = canonical.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "")
    .split(".").filter((l) => l.length > 0);
  const host = labels.join(".");
  if (labels.length >= 2 && registrableDomain(`x.${host}`) === `x.${host}`) return [];
  return labels;
}

/**
 * Keyword spellings of a generic brand's FULL canonical domain, for the
 * keyword-based writers: "mail.ru" → ["mailru", "mail-ru"], "login.gov" →
 * ["logingov", "login-gov"]. These carry the TLD-distinguishing token, so
 * they name the brand's domain rather than the dictionary word. [] when
 * the canonical has fewer than two labels.
 */
export function genericBrandDomainKeywords(canonical: string | null | undefined): string[] {
  const labels = canonicalLabels(canonical ?? "").map((l) => l.replace(/[^a-z0-9-]/g, ""))
    .filter((l) => l.length > 0);
  if (labels.length < 2) return [];
  return [...new Set([labels.join("").replace(/-/g, ""), labels.join("-")])];
}

/** Visual homoglyphs, keyed by the CANONICAL character (multi-char allowed:
 *  m → rn, w → vv, d → cl). Letter↔letter swaps limited to i/l. */
const GENERIC_HOMOGLYPHS: Readonly<Record<string, readonly string[]>> = {
  a: ["4"], e: ["3"], i: ["1", "l"], l: ["1", "i"], o: ["0"], s: ["5"],
  t: ["7"], g: ["9"], b: ["6"], m: ["rn"], w: ["vv"], d: ["cl"],
};

/** True when `cand` spells `canon` with at least one homoglyph swapped in
 *  ("mai1" / "rnail" for "mail") — never for the identical string. */
function homoglyphSpelling(cand: string, canon: string): boolean {
  if (cand === canon) return false;
  const walk = (i: number, j: number): boolean => {
    if (j === canon.length) return i === cand.length;
    if (i >= cand.length) return false;
    const c = canon[j]!;
    if (cand[i] === c && walk(i + 1, j + 1)) return true;
    for (const sub of GENERIC_HOMOGLYPHS[c] ?? []) {
      if (cand.startsWith(sub, i) && walk(i + sub.length, j + 1)) return true;
    }
    return false;
  };
  return walk(0, 0);
}

/**
 * Generic-word brands that are a PRODUCT of a larger vendor whose
 * credential lures they appear in (owner decision 2026-10-12): a link that
 * the generic rule would clear is moved to the parent brand instead when the
 * host carries that vendor's lure context. Keyed by the generic brand's
 * canonical domain; `family` is the vendor's product family in
 * lib/idp-impersonation.ts (isIdpVendorFamilyToken).
 */
export const GENERIC_BRAND_OWNERS: Readonly<Record<string, { parentBrandId: string; family: IdpProvider }>> = {
  "live.com": { parentBrandId: "brand_microsoft_com", family: "entra" },
  "office.com": { parentBrandId: "brand_microsoft_com", family: "entra" },
  "cloud.microsoft": { parentBrandId: "brand_microsoft_com", family: "entra" },
};

/** Vendor-family words that are also everyday words ("live", "office",
 *  "teams", "edge") — never vendor context on their own. */
const OWNER_WEAK_FAMILY_TOKENS: ReadonlySet<string> = new Set([
  "live", "office", "windows", "teams", "edge", "loop", "stream", "forms", "viva", "planner",
  "bookings", "sway", "whiteboard", "excel", "exchange", "dynamics", "defender", "intune",
  "bing", "xbox", "visio", "yammer", "azure", "copilot", "drive", "docs", "meet", "accounts",
  "workspace", "calendar", "chrome", "android", "slides", "sheets",
]);

/** Credential-lure words: the generic word itself beside one ("live-login",
 *  "officesignin") is vendor context too. */
const OWNER_LURE_WORDS: readonly string[] = [
  "login", "logon", "signin", "signon", "verify", "verification", "account", "accounts",
  "secure", "security", "auth", "password", "webmail", "mfa",
];

/**
 * Parent brand to credit instead of clearing a generic-brand link
 * (GENERIC_BRAND_OWNERS), or null. Vendor context = a strong vendor-family
 * token (microsoft, outlook, o365, hotmail, msn, onedrive, sharepoint, …;
 * one-edit typos of the high-value ones), a strong family word glued inside
 * a label, or the generic word itself beside a credential lure word
 * ("live-login.com", "office365" counts on its own; "live-stream.tv" and
 * "zs-office.com" do not).
 */
export function genericBrandOwnerCredit(
  raw: string,
  canonical: string | null | undefined,
): { parentBrandId: string } | null {
  const canon = canonicalLabels(canonical ?? "");
  const owner = GENERIC_BRAND_OWNERS[canon.join(".")];
  if (!owner) return null;
  const host = hostOf(raw);
  if (!HOSTNAME_RE.test(host) || IPV4_RE.test(host)) return null;
  const all = host.split(".").filter((l) => l.length > 0);
  const labels = all.slice(0, all.length - suffixLabelCount(host));
  const word = canon[0]!.replace(/-/g, "");
  const strong = (t: string) => !OWNER_WEAK_FAMILY_TOKENS.has(t) && isIdpVendorFamilyToken(t, owner.family);
  for (const label of labels) {
    const tokens = label.split(/[-_]/).filter((t) => t.length > 0);
    for (const [i, t] of tokens.entries()) {
      if (strong(t)) return { parentBrandId: owner.parentBrandId };
      if (t === word && (OWNER_LURE_WORDS.includes(tokens[i - 1] ?? "") || OWNER_LURE_WORDS.includes(tokens[i + 1] ?? ""))) {
        return { parentBrandId: owner.parentBrandId };
      }
      if (OWNER_LURE_WORDS.some((w) => t === word + w || t === w + word)) return { parentBrandId: owner.parentBrandId };
      if (OWNER_GLUED_FAMILY.some((w) => t.includes(w))) return { parentBrandId: owner.parentBrandId };
    }
  }
  return null;
}

/** Strong family words (>= 6 chars) matched glued inside a token, exact
 *  spelling only ("hotmailsecure", "myoutlookverify"). */
const OWNER_GLUED_FAMILY: readonly string[] = [
  "microsoft", "microsoftonline", "onmicrosoft", "office365", "microsoft365", "outlook",
  "outlook365", "onedrive", "sharepoint", "hotmail", "windowslive", "msaccount", "msonline",
];

/** Lure words that may be glued onto a generic brand's full-domain token
 *  ("mymailru", "mailru-login" is covered by the token run). */
const GENERIC_DOMAIN_GLUE: ReadonlySet<string> = new Set([
  "my", "secure", "login", "logon", "signin", "verify", "account", "accounts", "support",
  "help", "update", "confirm", "online", "web", "official", "auth", "id",
]);

/**
 * How `raw` (domain, URL, IOC) relates to a GENERIC brand's canonical domain
 * — the single definition of what may credit a generic-word brand:
 *   canonical  — the canonical domain itself, or (subdomains: true) a
 *                subdomain of it ("e.mail.ru")
 *   token      — the full canonical as consecutive labels of a longer host
 *                ("mail.ru.secure-login.com"), or the full-domain token in
 *                a label ("mail-ru.com", "login-gov.us", "mymailru.net")
 *   levenshtein — a homoglyph spelling of the canonical under the SAME
 *                suffix ("mai1.ru", "rnail.ru")
 * The bare word never qualifies: "1lookupmails.com", "zs-mail.com",
 * "membersecurelogin.com", "x.site-enfejar.com", "rnail.info" → null.
 * Tier-agnostic and catalog-free.
 */
export function genericBrandHostMatch(
  raw: string,
  canonical: string | null | undefined,
  opts: { subdomains: boolean },
): BrandMatchMethod | null {
  const canon = canonicalLabels(canonical ?? "");
  if (canon.length < 2) return null;
  const canonHost = canon.join(".");
  const host = hostOf(raw);
  if (!HOSTNAME_RE.test(host) || IPV4_RE.test(host)) return null;
  if (host === canonHost) return "canonical";
  // Cheap exact-superset prefilter (the catalog matcher calls this per
  // generic brand for every unmatched host): every rule below needs the
  // canonical's suffix at the end (subdomain / homoglyph) or all of its
  // tokens somewhere in the host (label / token rules).
  const canonTokens = canon.flatMap((l) => l.split("-")).filter((t) => t.length > 0);
  if (!host.endsWith(`.${canon.slice(1).join(".")}`) && !canonTokens.every((t) => host.includes(t))) return null;
  if (host.endsWith(`.${canonHost}`)) {
    // A tenant subdomain of a platform ("evil.pages.dev" for "Pages") or a
    // multi-tenant host belongs to an arbitrary party, not the brand.
    if (!opts.subdomains || platformSuffixFor(host) !== null || isMultiTenantHost(host)) return null;
    return "canonical";
  }

  const all = host.split(".").filter((l) => l.length > 0);
  // The canonical as consecutive labels, entirely LEFT of the host's own
  // registrable domain: mail.ru.secure-login.com, never x.site.com.br
  // (whose registrable domain is site.com.br itself).
  const reg = registrableDomain(host);
  const regStart = reg ? all.length - reg.split(".").length : all.length;
  for (let k = 0; k + canon.length <= regStart; k++) {
    if (canon.every((l, i) => all[k + i] === l)) return "token";
  }
  const tail = all.slice(-canon.length);
  if (tail.length === canon.length && tail.slice(1).join(".") === canon.slice(1).join(".")
      && homoglyphSpelling(tail[0]!, canon[0]!)) {
    return "levenshtein";
  }

  const joined = canon.join("").replace(/-/g, "");
  const labels = all.slice(0, all.length - suffixLabelCount(host));
  for (const label of labels) {
    const tokens = label.split(/[-_]/).filter((t) => t.length > 0);
    for (let i = 0; i + canonTokens.length <= tokens.length; i++) {
      if (canonTokens.every((t, k) => tokens[i + k] === t)) return "token";
    }
    for (const t of tokens) {
      if (t === joined) return "token";
      if (t.startsWith(joined) && GENERIC_DOMAIN_GLUE.has(t.slice(joined.length))) return "token";
      if (t.endsWith(joined) && GENERIC_DOMAIN_GLUE.has(t.slice(0, -joined.length))) return "token";
    }
  }
  return null;
}

/**
 * Extract the hostname from a domain, URL, or IOC string.
 * "https://paypa1-login.evil.com/account" → "paypa1-login.evil.com"
 */
export function hostOf(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/[:/?#].*$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

interface HostParts {
  host: string;
  /** Labels with the public/platform suffix removed: "a-b.evil.co.uk" → ["a-b", "evil"]. */
  labels: string[];
  /** Labels with "-"/"_" removed: ["ab", "evil"]. */
  flat: string[];
  /** Hyphen/underscore-split tokens of those labels: ["a", "b", "evil"]. */
  tokens: string[];
  /** Unique flat labels + tokens — the candidates for exact and fuzzy matching. */
  candidates: string[];
  /**
   * Set when the host is an idp_lookalike and the IdP lure tokens were
   * removed (idpLureParts) — the remaining labels name the TARGETED brand,
   * and they may also match a brand's canonical-domain owner label
   * ("withpersona" ↔ withpersona.com).
   */
  idpLure?: boolean;
  /** Vendor-credit parts of an idp_lookalike: whole-token vendor names only. */
  idpVendor?: boolean;
  /**
   * idpLure only: candidates derived by peeling a glued phishing word or a
   * glued lure off a leftover (paypalsecure → paypal, acmesso → acme).
   * Matched against brand NAMES exactly — never owner labels or fuzzy.
   */
  peeled?: string[];
  /**
   * idp_lookalike only: the full-host parts under the pre-2026-10-12 rules
   * (all tokens + lure names, token/substring/fuzzy). Used ONLY by the
   * catalog-free pair validator matchBrandToHost, so the general
   * brand-link cleanup never invalidates a link the old rules accepted.
   */
  legacy?: HostParts;
  /**
   * idp_lookalike only: the full-host parts (plus bare lure names) to match
   * when the remainder matches NO brand — a leftover that names no known
   * brand (www2, a8f3kd, a random tenant id) is not evidence of a different
   * target, so the IdP vendor itself is credited.
   */
  vendorFallback?: HostParts;
}

const HOSTNAME_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** A bare brand name, e.g. PhishTank's `target` field ("PayPal", "Bank of America"). */
const BARE_NAME_RE = /^[a-z0-9 ]{1,64}$/;
/** Unprefixed hex digests (md5/sha1/sha256) — never a brand name. */
const HEX_DIGEST_RE = /^[0-9a-f]{16,}$/;

/**
 * Shared-hosting / platform suffixes: the label in front belongs to an
 * arbitrary tenant, so the platform's own name is NOT brand evidence
 * ("paypal-login.github.io" impersonates PayPal, not GitHub). Treated
 * like a public suffix — excluded from matching. The platform itself
 * still matches by canonical domain.
 */
const PLATFORM_SUFFIXES = [
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "r2.dev", "vercel.app",
  "netlify.app", "web.app", "firebaseapp.com", "herokuapp.com", "azurewebsites.net",
  "azurefd.net", "cloudfront.net", "appspot.com", "blogspot.com", "weebly.com",
  "weeblysite.com", "wixsite.com", "godaddysites.com", "webflow.io", "framer.app",
  "glitch.me", "replit.app", "repl.co", "ngrok.io", "ngrok-free.app", "b-cdn.net",
  "backblazeb2.com", "s3.amazonaws.com", "onrender.com", "fly.dev", "surge.sh",
  "wasmer.app", "alwaysdata.net", "square.site", "carrd.co", "notion.site",
  "in.net", "web.id",
  // Dynamic DNS / tunnels / more shared hosting (2026-10-01 dry run).
  "dynv6.net", "dynuddns.net", "dynu.com", "mydns.jp", "ydns.eu", "duckdns.org",
  "ddns.net", "hopto.org", "zapto.org", "sytes.net", "bounceme.net", "no-ip.com",
  "trycloudflare.com", "portmap.host", "edgeone.app", "gateway.dev", "wixstudio.com",
  "cloudapp.net", "webcindario.com", "temporary.site",
  "mytemp.website", "contaboserver.net",
  // Free site builders addressed by SUBDOMAIN (<site>.jimdofree.com,
  // <project>.tilda.ws): the builder's name is not brand evidence
  // (chase-login.jimdofree.com is Chase, not Jimdo). square.site and
  // wixstudio.com are listed above. Path-addressed builders
  // (sites.google.com/<site>, editorx.io/<site>) are deliberately absent.
  // jimdo.com is NOT listed: it is Jimdo's corporate domain (help.jimdo.com,
  // accounts.jimdo.com), not a free-site host.
  "jimdofree.com", "jimdosite.com", "tilda.ws", "mystrikingly.com",
  "yolasite.com", "webnode.page", "site123.me", "framer.website",
  // Subdomain-style IPFS gateways: <cid>.ipfs.dweb.link (path-style hosts
  // are in SHARED_HOSTS below).
  "ipfs.dweb.link", "ipfs.w3s.link", "ipfs.nftstorage.link", "ipfs.4everland.io",
  "mypinata.cloud", "ipfs.cf-ipfs.com",
  // Identity-provider tenant hosts (acme-sso.okta.com, acme.eu.auth0.com):
  // the tenant label names the TARGETED brand, never the IdP vendor
  // (docs/IDP_IMPERSONATION_PLAN_2026-10.md owner decision 4 — the abused
  // IdP is recorded separately in threats.impersonated_idp). Derived from
  // the classifier's table; longest first so a regional suffix
  // (eu.auth0.com) wins over its parent in suffixLabelCount.
  ...Object.keys(IDP_TENANT_HOSTS).sort((a, b) => b.length - a.length),
];

/**
 * Shared content gateways: a threat AT this exact host is hosted content
 * (ipfs.io/ipfs/<cid>), not the gateway operator's brand — the host carries
 * no brand evidence at all, so it is not matched by any rule.
 */
const SHARED_HOSTS: ReadonlySet<string> = new Set([
  "ipfs.io", "dweb.link", "cloudflare-ipfs.com", "gateway.pinata.cloud",
  "w3s.link", "nftstorage.link", "4everland.io",
]);

/**
 * Multi-tenant collaboration / file-share / code-hosting / shortener /
 * redirector hosts. Unlike PLATFORM_SUFFIXES (where each subdomain is ONE
 * tenant), many unrelated parties publish under the SAME host here — one
 * attacker repo on github.com or one document on drive.google.com says
 * nothing about another link on that host. Matched as the host itself or
 * any subdomain of it (`*.safelinks.protection.outlook.com`, `*.google.com`).
 */
export const MULTI_TENANT_HOSTS: ReadonlyArray<string> = [
  // Collaboration / file share
  "docs.google.com", "drive.google.com", "sites.google.com", "forms.gle",
  "storage.googleapis.com", "googleusercontent.com", "dropbox.com",
  "dropboxusercontent.com", "1drv.ms", "onedrive.live.com", "sharepoint.com",
  "forms.office.com", "box.com", "wetransfer.com", "we.tl", "notion.so",
  "mediafire.com", "pastebin.com", "cdn.discordapp.com", "media.discordapp.net",
  // Code hosting
  "github.com", "gist.github.com", "raw.githubusercontent.com",
  "objects.githubusercontent.com", "gitlab.com", "bitbucket.org",
  // Cloud object / CDN endpoints addressed by path
  "amazonaws.com", "azureedge.net", "core.windows.net",
  // Shorteners / redirectors / link wrappers
  "bit.ly", "t.co", "tinyurl.com", "ow.ly", "lnkd.in", "linktr.ee",
  "safelinks.protection.outlook.com", "urldefense.com", "urldefense.proofpoint.com",
  "l.facebook.com", "lm.facebook.com",
  // google.com/url?q= open redirect (and every *.google.com service)
  "google.com",
];

/**
 * True when `raw` (domain, URL, or IOC) is a shared content gateway
 * (SHARED_HOSTS) or the bare APEX of a tenant-subdomain platform
 * (PLATFORM_SUFFIXES, e.g. "pages.dev" itself). A tenant subdomain such as
 * "x.pages.dev" is NOT shared — it belongs to one tenant, so a feed listing
 * it is evidence about that tenant.
 */
export function isSharedHostingHost(raw: string): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  if (SHARED_HOSTS.has(host)) return true;
  // An IdP apex (okta.com) is the vendor's own site, not shared hosting.
  return PLATFORM_SUFFIXES.includes(host) && !IDP_SUFFIXES.has(host);
}

const IDP_SUFFIXES: ReadonlySet<string> = new Set(Object.keys(IDP_TENANT_HOSTS));

/**
 * The PLATFORM_SUFFIXES entry `host` is a tenant of, or null. A
 * vendor-owned subdomain of an IdP suffix (login.okta.com, eu.auth0.com,
 * status.okta.com — the classifier's corp-label exclusion via
 * idpTenantLabel) is NOT a tenant: it belongs to the vendor.
 */
function platformSuffixFor(host: string): string | null {
  for (const p of PLATFORM_SUFFIXES) {
    if (!host.endsWith(`.${p}`)) continue;
    if (IDP_SUFFIXES.has(p) && idpTenantLabel(host) === null) continue;
    return p;
  }
  return null;
}

/** True when `raw` is a single tenant's subdomain of a PLATFORM_SUFFIXES
 *  platform ("x.pages.dev", "x.duckdns.org", "bucket.s3.amazonaws.com"). */
export function isPlatformTenantHost(raw: string): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  return platformSuffixFor(host) !== null;
}

/** True when `raw` is a customer tenant of an identity provider
 *  (acme.okta.com, acme.eu.auth0.com) — never a vendor-owned subdomain. */
export function isIdpTenantHost(raw: string): boolean {
  const host = hostOf(raw);
  return !!host && idpTenantLabel(host) !== null;
}

/**
 * Abuse-mailbox domain-level evidence gate: true when a domain-level
 * threat-intel match on this host must NOT be treated as evidence about a
 * different URL on the same host. Shared gateways, platform apexes and
 * MULTI_TENANT_HOSTS (incl. subdomains) qualify; a platform TENANT
 * subdomain never does (checked first, so "bucket.s3.amazonaws.com" stays
 * single-tenant even though "amazonaws.com" is multi-tenant).
 */
export function isMultiTenantHost(raw: string): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  if (isPlatformTenantHost(host)) return false;
  if (isSharedHostingHost(host)) return true;
  return MULTI_TENANT_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

function suffixLabelCount(host: string): number {
  const p = platformSuffixFor(host);
  if (p) return p.split(".").length;
  const reg = registrableDomain(host);
  // Registrable labels minus its one owner label.
  return reg ? reg.split(".").length - 1 : 0;
}

function buildParts(host: string, labels: string[], tokens: string[]): HostParts {
  const flat = labels.map((l) => l.replace(/[-_]/g, "")).filter((l) => l.length > 0);
  const candidates = [...new Set([...flat, ...tokens])];
  return { host, labels, flat, tokens, candidates };
}

function hostParts(raw: string): HostParts | null {
  const trimmed = raw.trim().toLowerCase();
  if (BARE_NAME_RE.test(trimmed)) {
    const joined = trimmed.replace(/ /g, "");
    if (!joined || /^\d+$/.test(joined) || HEX_DIGEST_RE.test(joined)) return null;
    const words = trimmed.split(" ").filter((w) => w.length > 0);
    return buildParts(joined, [joined], words);
  }
  // Everything else must be a real hostname. JSON IOC blobs
  // ({"ip":…,"dataplane_feed":"telnetlogin"}), "hash:sha-256:…" values,
  // "1.2.3.4 (6 lists)" and IP literals were matched as free text before
  // ("Login", "Ashs", "List", "1x1x5") — they carry no brand signal.
  const host = hostOf(raw);
  if (!HOSTNAME_RE.test(host) || IPV4_RE.test(host) || SHARED_HOSTS.has(host)) return null;
  // IdP tenant: attribute on the normalized tenant label only
  // (acme-admin.okta.com → "acme", openam-acme.forgeblocks.com → "acme").
  const idpLabel = idpTenantLabel(host);
  if (idpLabel) {
    return buildParts(host, [idpLabel], idpLabel.split(/[-_]/).filter((t) => t.length > 0));
  }
  const all = host.split(".").filter((l) => l.length > 0);
  const labels = all.slice(0, all.length - suffixLabelCount(host));
  const lure = idpLureParts(host, labels, sharedHostingStart(all));
  if (lure) return lure;
  const tokens = labels.flatMap((l) => l.split(/[-_]/)).filter((t) => t.length > 0);
  return buildParts(host, labels, tokens);
}

/**
 * Words that, glued to or beside an IdP lure, carry no brand evidence
 * (okta-login-secure.com, oktaportal, linksso, my-sso). The existing
 * filler + generic-brand lists, plus the classifier's auth glue words.
 */
const IDP_LURE_FILLER: ReadonlySet<string> = new Set([
  ...OBFUSCATION_WORDS, ...GENERIC_BRAND_NAMES,
  "my", "id", "mfa", "2fa", "otp", "connect", "verification", "session", "sessions",
  "signon", "logins", "identity", "workforce", "employee", "employees", "staff", "corp",
  "hr", "it", "vpn", "remote", "idp", "saml", "oauth", "token",
  // Login-flow / Entra-URL words that are ALSO catalog brand names
  // (register.com, LogMeIn, …): beside an IdP lure they are part of the
  // lure phrase, never the target (production dry run 2026-10-12:
  // register.microsoftonline-p-int.com → register.com, logmein-
  // microsoftonline.com → LogMeIn).
  "register", "registration", "signup", "logmein", "logout", "signout", "authorize",
  "authorization", "authenticate", "authentication", "authenticator", "oauth2", "openid",
  "common", "organizations", "consumers", "tenant", "saml2", "wsfed", "adfs", "sso",
  "callback", "redirect", "password", "passwd", "reset", "recover", "recovery", "unlock",
  "validate", "validation", "review", "notice", "notification", "approve", "approval",
  "webapp", "owa", "cdn", "static", "assets", "admin", "manage", "login2", "signin2",
  // The classifier's weak IdP lures — part of the lure phrase, not a target.
  "helpdesk", "servicedesk", "itsupport",
]);

/** www, www2, w3 / v1, v2.0 fragments — host noise, never a brand. */
const NOISE_TOKEN_RE = /^(?:www\d*|w\d|v\d+|\d+[a-z]?)$/;

/** A remaining token that could name a targeted brand — not filler, not a
 *  number, and long enough that a leftover syllable ("gnu", "abc") does not
 *  count. Mirrors the matcher's own 4-char matchable floor. */
function isSubstantiveToken(t: string): boolean {
  return t.length >= 4 && !/^\d+$/.test(t) && !NOISE_TOKEN_RE.test(t) && !IDP_LURE_FILLER.has(t);
}

/** Phishing words that are glued directly onto a brand (paypalsecure,
 *  loginacme). Peeling one off a leftover token yields a candidate that must
 *  EQUAL a brand name — never an owner label, substring or fuzzy match.
 *  Deliberately excludes everyday prefixes (help, mail, my, auth, service):
 *  helpscout / helpdesk / mailchimp must not become Scout / Desk / Chimp. */
const PEEL_WORDS = [
  "login", "logon", "signin", "signon", "secure", "verify", "verification", "account",
  "accounts", "update", "confirm",
];

function peelGluedFiller(t: string): string[] {
  const out: string[] = [];
  for (const w of PEEL_WORDS) {
    if (t.length - w.length < 4) continue;
    if (t.startsWith(w)) out.push(t.slice(w.length));
    if (t.endsWith(w)) out.push(t.slice(0, -w.length));
  }
  return out;
}

/** Leftovers from an IdP-lure host may credit a brand only when it is in
 *  platform scope (monitored/customer) or well known. Rows without a tier
 *  field at all (legacy callers) are not gated. */
export const IDP_LEFTOVER_MAX_RANK = 20000;

/**
 * Leftover name/owner-label eligibility: monitored / customer tier, or a
 * `tracked` catalog brand that is well known (Tranco rank <= 20000 —
 * asana.com, logmein.com), so a top site the platform does not yet monitor
 * is still credited while long-tail catalog junk (author.today) is not.
 * Rows without a tier field at all (legacy callers) are not gated.
 * Typo (fuzzy) leftovers are stricter: monitored/customer only (`matchable`).
 */
function isIdpLeftoverEligible(b: BrandRow): boolean {
  if (b.tier === undefined) return true;
  if (b.tier === "monitored" || b.tier === "customer") return true;
  return typeof b.tranco_rank === "number" && b.tranco_rank > 0 && b.tranco_rank <= IDP_LEFTOVER_MAX_RANK;
}

/**
 * Attribution for an IdP-lure lookalike (classifier vector idp_lookalike):
 * the IdP name in the host is the LURE, not the target
 * (docs/IDP_IMPERSONATION_PLAN_2026-10.md owner decision 4 — credit the
 * targeted brand; the abused IdP is recorded in threats.impersonated_idp).
 *
 *   withpersona.okta-linksso.com → leftover ["withpersona"] → Persona
 *   okta-acme.com                → leftover ["acme"]        → Acme
 *   okta-login-secure.com        → no leftover → the IdP vendor's own brand
 *
 * Leftover rules (production dry run 2026-10-12, 7 of 11 proposals wrong):
 *   - Lure tokens (strong lure whole, or glued to filler: oktalogin, linksso)
 *     are dropped.
 *   - Filler (login-flow words incl. register / logmein / authorize /
 *     common / oauth2), host noise (www2, v2) and the SAME VENDOR's products
 *     (outlook / onedrive / teams / o365 beside a Microsoft lure) are not
 *     brand evidence — the vendor keeps the credit.
 *   - What remains is brand evidence only as a WHOLE token: equal to a
 *     brand name or canonical owner label (in-scope or well-known brands,
 *     isIdpLeftoverEligible), equal to a brand name after peeling one glued
 *     phishing word (paypalsecure → paypal), or a whole-token typo of a
 *     monitored/customer brand (paypa1 → PayPal). Never a substring/prefix
 *     of a longer word ("authorize" is not author.today).
 *   - Applies only when a real vendor lure is present; a generic "sso"
 *     alone keeps the ordinary matcher.
 *   - When the leftover matches no brand (www2, a8f3kd, contosoltd), the
 *     vendor is credited: `vendorFallback` holds only the vendor's
 *     canonical name + the lure names, matched whole-token.
 * Returns null when the host is not an idp_lookalike or no lure was stripped.
 */
/** Index of the first label of the shared-hosting / free-builder domain
 *  (lib/safeDomains SHARED_HOSTING_DOMAINS) `all` sits under, else
 *  all.length. login-microsoftonnline.jimdofree.com → 1. */
function sharedHostingStart(all: string[]): number {
  for (let i = 1; i < all.length - 1; i++) {
    if (SHARED_HOSTING_DOMAINS.has(all.slice(i).join("."))) return i;
  }
  return all.length;
}

function idpLureParts(host: string, labels: string[], leftoverEnd = labels.length): HostParts | null {
  if (labels.length === 0) return null;
  if (classifyIdpImpersonation({ host })?.vector !== "idp_lookalike") return null;
  const lures: string[] = [];
  const providers = new Set<IdpProvider>();
  const glued: string[] = [];
  const perLabel: string[][] = [];
  for (const [li, label] of labels.entries()) {
    const rest: string[] = [];
    // Labels of the shared-hosting / free-builder domain the host sits under
    // (jimdofree in login-microsoftonnline.jimdofree.com) name the platform,
    // never the target: lures there still count, leftovers don't. Host-
    // relative on purpose — slack.com / zendesk.com / okta.com are in
    // SHARED_HOSTING_DOMAINS too, yet zendesk-okta.com targets Zendesk.
    const leftoverAllowed = li < leftoverEnd;
    for (const t of label.split(/[-_]/)) {
      if (t.length === 0) continue;
      const s = splitIdpLureToken(t);
      if (s && (s.rest === "" || IDP_LURE_FILLER.has(s.rest) || isIdpVendorFamilyToken(s.rest, s.provider))) {
        lures.push(s.lure);
        providers.add(s.provider);
        continue;
      }
      // Lure glued to a non-filler word (acmesso): keep the token, and its
      // remainder is one more exact-name candidate.
      if (!leftoverAllowed) continue;
      if (s) glued.push(s.rest);
      rest.push(t);
    }
    perLabel.push(rest);
  }
  if (lures.length === 0) return null;
  // Only a REAL vendor lure (Okta, Entra, Duo, …) triggers the strict
  // leftover rule. A bare generic "sso" (paypa1-sso.com, amazonprime-sso.com)
  // names no vendor that could be wrongly credited — keep the ordinary
  // token / substring / fuzzy matcher over the whole host.
  if (![...providers].some((p) => p !== "generic_sso")) return null;

  const provs = [...providers];
  const vendorTokens = [...new Set([
    ...provs.map((p) => IDP_VENDOR_BRAND_TOKEN[p]).filter((v): v is string => !!v),
    ...lures,
  ])];
  const fullTokens = labels.flatMap((l) => l.split(/[-_]/)).filter((t) => t.length > 0);
  const legacy = buildParts(host, labels, [...fullTokens, ...lures]);
  const vendor: HostParts = { ...buildParts(host, vendorTokens, vendorTokens), idpVendor: true, legacy };

  const evidence = (t: string) => isSubstantiveToken(t) && !provs.some((p) => isIdpVendorFamilyToken(t, p));
  const keptLabels = perLabel.map((ts) => ts.filter(evidence)).filter((ts) => ts.length > 0);
  const tokens = keptLabels.flat();
  if (tokens.length === 0) return vendor;
  const peeled = [...new Set([...tokens.flatMap(peelGluedFiller), ...glued])].filter(evidence);
  return {
    ...buildParts(host, keptLabels.map((ts) => ts.join("-")), tokens),
    idpLure: true,
    peeled,
    vendorFallback: vendor,
    legacy,
  };
}

interface PreparedBrand {
  id: string;
  canonical: string;
  norm: string;
  /** False for generic / too-short names — canonical-domain match only. */
  matchable: boolean;
  /** May be credited by name / owner label from an IdP-lure leftover
   *  (isIdpLeftoverEligible + the generic/short-name floor). */
  leftoverMatchable: boolean;
  /** 4–5 char matchable name eligible for the glued-substring rule. */
  glued: boolean;
  /** Generic-word brand (isGenericBrand) outside the tracked catalog, with a
   *  canonical domain: credited by genericBrandHostMatch only. */
  genericLookalike: boolean;
}

function prepareOne(b: BrandRow): PreparedBrand {
  const norm = normalizeBrand(b.name);
  const canonical = (b.canonical_domain ?? "").toLowerCase().replace(/^www\./, "");
  const generic = isGenericBrand(norm);
  const matchable = norm.length >= 4 && !generic && b.tier !== "tracked";
  return {
    id: b.id,
    canonical,
    norm,
    matchable,
    leftoverMatchable: norm.length >= 4 && !generic && isIdpLeftoverEligible(b),
    glued: matchable && norm.length < MIN_SUBSTRING_LEN,
    genericLookalike: generic && b.tier !== "tracked" && canonical.includes("."),
  };
}

/** Lookup structures over the brand catalog (100K+ rows). */
interface BrandIndex {
  canonical: Map<string, string>;
  token: Map<string, string>;
  /**
   * IdP-lure leftovers only (HostParts.idpLure), leftover-eligible matchable
   * brands: normalized name → brand, and canonical-domain owner label →
   * brand ("withpersona" → Persona).
   */
  leftoverToken: Map<string, string>;
  ownerLabel: Map<string, string>;
  /** Matchable brands with names long enough for substring matching. */
  long: PreparedBrand[];
  /** Same, bucketed by first character for edit-distance matching. */
  longByFirst: Map<string, PreparedBrand[]>;
  /** 4–5 char names eligible for the glued-substring rule, longest first. */
  glued: PreparedBrand[];
  /** Generic-word brands credited only via genericBrandHostMatch. */
  generic: PreparedBrand[];
}

/** Owner label of a canonical domain when it is specific enough to be brand
 *  evidence on its own: "withpersona.com" → "withpersona"; null for short or
 *  generic labels ("one.com", "login.gov", "abc.xyz"). */
function ownerLabelOf(canonical: string): string | null {
  if (!canonical) return null;
  const all = canonical.split(".").filter((l) => l.length > 0);
  const owner = all[all.length - 1 - suffixLabelCount(canonical)];
  if (!owner) return null;
  const flat = owner.replace(/[-_]/g, "");
  // Filler owner labels (remote.com, identity.com) are never brand evidence
  // beside an IdP lure: okta-acme-remote.com is Acme.
  return flat.length >= 5 && !isGenericBrand(flat) && !IDP_LURE_FILLER.has(flat) ? flat : null;
}

// Built once per brands array — callers load the catalog once per run and
// match hundreds of threats against it. First brand in array order wins a
// key, matching the old first-hit semantics.
const indexCache = new WeakMap<BrandRow[], BrandIndex>();

function indexBrands(brands: BrandRow[]): BrandIndex {
  const cached = indexCache.get(brands);
  if (cached) return cached;
  const idx: BrandIndex = {
    canonical: new Map(), token: new Map(), leftoverToken: new Map(), ownerLabel: new Map(),
    long: [], longByFirst: new Map(), glued: [], generic: [],
  };
  for (const b of brands) {
    const p = prepareOne(b);
    if (p.canonical && !idx.canonical.has(p.canonical)) idx.canonical.set(p.canonical, p.id);
    if (p.genericLookalike) idx.generic.push(p);
    if (p.glued) idx.glued.push(p);
    if (p.leftoverMatchable) {
      if (!idx.leftoverToken.has(p.norm)) idx.leftoverToken.set(p.norm, p.id);
      const owner = ownerLabelOf(p.canonical);
      if (owner && !idx.ownerLabel.has(owner)) idx.ownerLabel.set(owner, p.id);
    }
    if (!p.matchable) continue;
    if (!idx.token.has(p.norm)) idx.token.set(p.norm, p.id);
    if (p.norm.length >= MIN_SUBSTRING_LEN) {
      idx.long.push(p);
      const first = p.norm[0] ?? "";
      const bucket = idx.longByFirst.get(first);
      if (bucket) bucket.push(p);
      else idx.longByFirst.set(first, [p]);
    }
  }
  // Longest name first (stable: array order breaks ties), so a 5-char name
  // beats a 4-char one glued into the same token.
  idx.glued.sort((a, b) => b.norm.length - a.norm.length);
  indexCache.set(brands, idx);
  return idx;
}

/**
 * Optimal-string-alignment distance: Levenshtein plus adjacent
 * transposition as a single edit ("camosda" → "camsoda" = 1), the most
 * common typosquat pattern after single-character substitution.
 */
function osaDistance(a: string, b: string): number {
  // Three rolling rows (i-2, i-1, i); untyped like levenshtein() above.
  let prev2 = new Array(b.length + 1);
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + 1);
      }
    }
    [prev2, prev, curr] = [prev, curr, prev2];
  }
  return prev[b.length];
}

/** Max edit distance allowed for a brand name of this length (0 = none). */
function maxEditDistance(len: number): number {
  if (len >= 8) return 2;
  if (len >= MIN_SUBSTRING_LEN) return 1;
  return 0;
}

/**
 * Exact whole-label / whole-token equality. No filler stripping here:
 * stripping inside a short word manufactures matches ("helpscout" →
 * "Scout", "webflow" → "Flow").
 */
function tokenMatch(parts: HostParts, norm: string): boolean {
  return parts.candidates.includes(norm);
}

/** Substring (names >= 6 chars), raw or with phishing filler stripped. */
function substringMatch(parts: HostParts, norm: string): boolean {
  if (norm.length < MIN_SUBSTRING_LEN) return false;
  for (const l of parts.flat) {
    if (l.includes(norm) || stripObfuscation(l).includes(norm)) return true;
  }
  return false;
}

function fuzzyMatch(candidate: string, norm: string): boolean {
  const maxDist = maxEditDistance(norm.length);
  if (maxDist === 0) return false;
  if (candidate[0] !== norm[0]) return false;
  if (Math.abs(candidate.length - norm.length) > maxDist) return false;
  return osaDistance(candidate, norm) <= maxDist;
}

/**
 * Decide whether a single (host, brand) pair is a valid match under the
 * current rules, and by which method. Pure — used for the matcher itself
 * and to re-validate existing threat→brand links.
 *
 * IdP-lure hosts: permissive by design. Without the catalog this cannot
 * tell whether the leftover names SOME other brand, so it accepts the strict
 * leftover rule, the vendor credit, AND the pre-2026-10-12 full-host rules
 * (`legacy`): the general brand-link cleanup (lib/brand-link-cleanup.ts)
 * must never invalidate a link the old rules accepted (an Okta link on
 * withpersona.okta-linksso.com, an Outlook link on
 * microsoftonline-outlook.live, PayPal on paypa1-okta.com). Catalog-aware
 * re-attribution goes through fuzzyMatchBrandDetailed
 * (handlers/admin/idpReattribution.ts).
 */
export function matchBrandToHost(raw: string, brand: BrandRow): BrandMatchMethod | null {
  return pairMatch(raw, brand, "permissive");
}

/**
 * As matchBrandToHost, but on an IdP-lure host accepts the brand ONLY as the
 * TARGET named by the leftover (whole-token / owner-label / peeled / typo
 * rule) — never via the vendor fallback and never via the pre-2026-10-12
 * full-host rules. Used by the all_idp re-attribution to keep a link the
 * current rules still accept when the host names two brands
 * (contoso-withpersona.okta-sso.com), without also "accepting" the IdP
 * vendor on withpersona.okta-linksso.com. Non-IdP hosts: same as
 * matchBrandToHost.
 */
export function matchBrandAsLeftoverTarget(raw: string, brand: BrandRow): BrandMatchMethod | null {
  return pairMatch(raw, brand, "leftover");
}

function pairMatch(raw: string, brand: BrandRow, mode: "permissive" | "leftover"): BrandMatchMethod | null {
  const parts = hostParts(raw);
  if (!parts) return null;
  const p = prepareOne(brand);
  if (p.canonical && parts.host === p.canonical) return "canonical";
  // Generic-word brand: canonical / subdomain / full-domain lookalike only.
  // A subdomain is accepted here (an existing link to e.mail.ru stays
  // valid) but the catalog matcher never CREATES one — a generic brand's
  // subdomains are often multi-tenant (cloud.mail.ru, *.my.site.com).
  if (p.genericLookalike) return genericBrandHostMatch(parts.host, p.canonical, { subdomains: true });
  if (parts.idpLure || parts.idpVendor) {
    if (mode === "leftover") return parts.idpLure ? matchIdpPartsToBrand(parts, p) : null;
    const strict = matchIdpPartsToBrand(parts, p)
      ?? (parts.vendorFallback ? matchIdpPartsToBrand(parts.vendorFallback, p) : null);
    if (strict) return strict;
    return p.matchable && parts.legacy ? matchPreparedToParts(parts.legacy, p) : null;
  }
  if (!p.matchable) return null;
  return matchPreparedToParts(parts, p);
}

/** The strict IdP-lure rule for one brand (mirrors matchPartsInIndex). */
function matchIdpPartsToBrand(parts: HostParts, p: PreparedBrand): BrandMatchMethod | null {
  if (parts.idpVendor) return p.matchable && tokenMatch(parts, p.norm) ? "token" : null;
  if (p.leftoverMatchable) {
    const owner = ownerLabelOf(p.canonical);
    if (owner && parts.candidates.includes(owner)) return "token";
    if (tokenMatch(parts, p.norm) || (parts.peeled ?? []).includes(p.norm)) return "token";
  }
  if (p.matchable && parts.candidates.some((c) => fuzzyMatch(c, p.norm))) return "levenshtein";
  return null;
}

function matchPreparedToParts(parts: HostParts, p: PreparedBrand): BrandMatchMethod | null {
  if (tokenMatch(parts, p.norm)) return "token";
  if (substringMatch(parts, p.norm)) return "substring";
  if (parts.candidates.some((c) => fuzzyMatch(c, p.norm))) return "levenshtein";
  if (p.glued && parts.tokens.some((t) => gluedTokenMatch(t, p.norm))) return "substring";
  return null;
}

/**
 * Keyword pre-match used by the Analyst agent (brand keywords, aliases,
 * typo variants). Same boundary rules as the brand matcher.
 */
export function keywordMatchesHost(keyword: string, raw: string): boolean {
  const norm = normalizeBrand(keyword);
  if (norm.length < 4 || isGenericBrand(norm)) return false;
  const parts = hostParts(raw);
  if (!parts) return false;
  return tokenMatch(parts, norm) || substringMatch(parts, norm);
}

/**
 * Fuzzy brand matching — tries each strategy across all brands before
 * falling to the next, per input string. Returns the first match.
 *
 * @param haystacks - non-null strings to check (domain, url, ioc_value)
 * @param brands - list of known brands
 */
export function fuzzyMatchBrandDetailed(haystacks: string[], brands: BrandRow[]): BrandMatch | null {
  const idx = indexBrands(brands);
  for (const raw of haystacks) {
    if (!raw) continue;
    const parts = hostParts(raw);
    if (!parts) continue;

    const canonicalId = idx.canonical.get(parts.host);
    if (canonicalId) return { brandId: canonicalId, method: "canonical" };

    const hit = matchPartsInIndex(parts, idx)
      ?? (parts.vendorFallback ? matchPartsInIndex(parts.vendorFallback, idx) : null)
      ?? matchGenericInIndex(parts.host, idx);
    if (hit) return hit;
  }
  return null;
}

/** Strategies 2–4 (plus the IdP-remainder owner-label pass) over the catalog. */
function matchPartsInIndex(parts: HostParts, idx: BrandIndex): BrandMatch | null {
  // IdP-lure leftover: WHOLE-token evidence only. A label equal to a
  // brand's canonical owner label ("withpersona") is the strongest evidence
  // left; then a token (or peeled token) equal to an eligible brand name;
  // then a whole-token typo of a monitored/customer brand (paypa1). Never a
  // substring of a longer word.
  if (parts.idpLure) {
    for (const c of parts.candidates) {
      const id = idx.ownerLabel.get(c);
      if (id) return { brandId: id, method: "token" };
    }
    for (const c of [...parts.candidates, ...(parts.peeled ?? [])]) {
      const id = idx.leftoverToken.get(c);
      if (id) return { brandId: id, method: "token" };
    }
    for (const c of parts.candidates) {
      for (const b of idx.longByFirst.get(c[0] ?? "") ?? []) {
        if (fuzzyMatch(c, b.norm)) return { brandId: b.id, method: "levenshtein" };
      }
    }
    return null;
  }
  // Vendor credit: the vendor's canonical name / lure names, whole token.
  if (parts.idpVendor) {
    for (const c of parts.candidates) {
      const id = idx.token.get(c);
      if (id) return { brandId: id, method: "token", vendorCredit: true };
    }
    return null;
  }

  for (const c of parts.candidates) {
    const id = idx.token.get(c);
    if (id) return { brandId: id, method: "token" };
  }

  const stripped = parts.flat.map(stripObfuscation);
  for (const b of idx.long) {
    if (parts.flat.some((l, i) => l.includes(b.norm) || (stripped[i] ?? "").includes(b.norm))) {
      return { brandId: b.id, method: "substring" };
    }
  }

  for (const c of parts.candidates) {
    for (const b of idx.longByFirst.get(c[0] ?? "") ?? []) {
      if (fuzzyMatch(c, b.norm)) return { brandId: b.id, method: "levenshtein" };
    }
  }

  // Glued-substring rule — only when every rule above found nothing.
  const longTokens = parts.tokens.filter((t) => t.length >= GLUED_MIN_TOKEN_LEN);
  if (longTokens.length > 0) {
    for (const b of idx.glued) {
      if (longTokens.some((t) => gluedTokenMatch(t, b.norm))) return { brandId: b.id, method: "substring" };
    }
  }
  return null;
}

/** Generic-word brands: full-domain lookalikes of the canonical only. */
function matchGenericInIndex(host: string, idx: BrandIndex): BrandMatch | null {
  for (const b of idx.generic) {
    const method = genericBrandHostMatch(host, b.canonical, { subdomains: false });
    if (method) return { brandId: b.id, method };
  }
  return null;
}

/** As fuzzyMatchBrandDetailed, returning only the brand id. */
export function fuzzyMatchBrand(haystacks: string[], brands: BrandRow[]): string | null {
  return fuzzyMatchBrandDetailed(haystacks, brands)?.brandId ?? null;
}

/** True when the input is a hostname or bare name the matcher can evaluate. */
export function isMatchableInput(raw: string): boolean {
  return hostParts(raw) !== null;
}

/**
 * IdP tagging for a threat that just gained its target brand (lib/idp-tagging.ts).
 * No-op unless it classifies (rare — one extra statement per IdP hit). Best-effort:
 * a failure never undoes the brand match.
 */
export async function tagIdpAfterBrandMatch(
  db: D1Database,
  row: { id: string; malicious_domain: string | null; malicious_url: string | null; technique: string | null },
  brand: Pick<BrandRow, "name" | "canonical_domain"> | undefined,
): Promise<void> {
  if (!brand) return;
  const tag = tagThreat(row, brandTokensFrom(brand.name, brand.canonical_domain));
  if (!tag.impersonated_idp) return;
  try {
    const res = await idpTagUpdateStmt(db, row.id, tag).run();
    // Newly IdP-tagged → page-capture queue (lib/page-capture.ts). Never
    // throws, never awaits the browser.
    if ((res.meta?.changes ?? 0) > 0 && isIdpFamilyTag(tag)) {
      await enqueueAutoCaptures(db, [{ threatId: row.id, maliciousUrl: row.malicious_url, maliciousDomain: row.malicious_domain }]);
    }
  } catch {
    // Best-effort — the IdP backfill re-covers it.
  }
}

/**
 * Load all brands from DB.
 */
export async function loadBrands(db: D1Database): Promise<BrandRow[]> {
  const rows = await db.prepare("SELECT id, name, canonical_domain, tier, tranco_rank FROM brands").all<BrandRow>();
  return rows.results;
}

/**
 * Enrich threats that have a malicious_domain but no target_brand_id.
 * Matches against known brands and updates threats in-place.
 */
export async function enrichBrands(db: D1Database): Promise<{ matched: number; total: number }> {
  const brands = await loadBrands(db);
  if (brands.length === 0) return { matched: 0, total: 0 };

  // Get threats missing brand assignment
  const rows = await db.prepare(
    `SELECT id, malicious_domain, malicious_url, technique FROM threats
     WHERE malicious_domain IS NOT NULL AND target_brand_id IS NULL
     LIMIT 500`,
  ).all<{ id: string; malicious_domain: string; malicious_url: string | null; technique: string | null }>();
  const brandById = new Map(brands.map((b) => [b.id, b]));

  const total = rows.results.length;
  if (total === 0) return { matched: 0, total: 0 };

  let matched = 0;

  for (const row of rows.results) {
    const match = fuzzyMatchBrandDetailed([row.malicious_domain], brands);
    if (!match) continue;
    const brandId = match.brandId;

    try {
      await db.prepare(
        "UPDATE threats SET target_brand_id = ?, brand_match_method = ? WHERE id = ? AND target_brand_id IS NULL",
      ).bind(brandId, match.method, row.id).run();

      // Now that the brand is known, a weak IdP lure (acme-helpdesk.com) can
      // classify. Only rows matched here; the UPDATE keeps the
      // never-overwrite-a-non-family-technique guard.
      await tagIdpAfterBrandMatch(db, row, brandById.get(brandId));

      // Increment brand threat count
      await db.prepare(
        `UPDATE brands SET
           threat_count = threat_count + 1,
           last_threat_seen = datetime('now')
         WHERE id = ?`,
      ).bind(brandId).run();

      matched++;
    } catch (err) {
      console.error(`[brand-detect] update failed for ${row.id}:`, err);
    }
  }

  return { matched, total };
}
