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
 * 5. glued       — an ALLOWLISTED 4–5 char name (GLUED_BRAND_ALLOWLIST)
 *                  inside one long token whose rest splits into lure words
 *                  ("adobeacrobatdoc" → Adobe); only when 1–4 found nothing
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
 * Credential / account lure words — the vocabulary every "glued" rule
 * segments against (exact words only, never prefixes): the glued-brand rule
 * below, the generic-brand full-domain token rule and the lure-gated
 * generic-brand rule (genericBrandHostMatch).
 */
const CREDENTIAL_LURE_WORDS: readonly string[] = [
  "login", "logon", "signin", "signon", "secure", "security", "verify", "verification", "verified",
  "account", "accounts", "auth", "password", "unlock", "recovery", "recover", "reset", "confirm",
  "validate", "validation", "suspended", "locked", "kyc", "sso", "mfa", "2fa", "otp",
  "update", "updates", "support", "helpdesk", "alert", "alerts", "notice", "notification",
  "wallet", "refund", "billing", "invoice", "payment", "payments", "restore", "claim",
  "tracking", "parcel", "redelivery", "shipment", "facture", "factures",
];

/** Glue that may sit beside a brand without being a lure ("myadobesign"). */
const LURE_GLUE_WORDS: readonly string[] = ["my", "id", "www", "the", "get", "official"];

/** Meeting / document / e-sign lures (glued-brand rule only). */
const DOCUMENT_LURE_WORDS: readonly string[] = [
  "meeting", "meet", "invite", "invitation", "webinar", "join", "sign", "esign", "doc", "docs",
  "document", "documents", "pdf", "acrobat", "reader", "share", "shared", "file", "files", "fax", "scan",
];

/** True when `s` splits ENTIRELY into `vocab` words and digit runs, with at
 *  least one `required` word when `required` is given. Exact words only. */
function segmentsInto(s: string, vocab: ReadonlySet<string>, required?: ReadonlySet<string>): boolean {
  // state per position: 0 = unreachable, 1 = reachable, 2 = reachable with a required word.
  const st = new Uint8Array(s.length + 1);
  st[0] = 1;
  for (let i = 0; i < s.length; i++) {
    const cur = st[i]!;
    if (!cur) continue;
    if (s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) st[i + 1] = Math.max(st[i + 1]!, cur);
    for (const w of vocab) {
      if (s.startsWith(w, i)) {
        const next = required && required.has(w) ? 2 : cur;
        st[i + w.length] = Math.max(st[i + w.length]!, next);
      }
    }
  }
  const end = st[s.length]!;
  return required ? end === 2 : end > 0;
}

const GLUED_VOCAB: ReadonlySet<string> = new Set([...CREDENTIAL_LURE_WORDS, ...DOCUMENT_LURE_WORDS, ...LURE_GLUE_WORDS]);
const GLUED_LURES: ReadonlySet<string> = new Set([...CREDENTIAL_LURE_WORDS, ...DOCUMENT_LURE_WORDS]);

/**
 * Glued-brand rule (2026-10-12): a SHORT brand name (4–5 chars, which
 * otherwise needs a whole token) glued inside one long run-on token
 * ("adobeacrobatdoc" → Adobe, "chaseverifyaccount" → Chase,
 * "invitationlauchjczoommeeting" → Zoom). Applies ONLY to the curated
 * GLUED_BRAND_ALLOWLIST (canonical domain → normalized name) — distinctive,
 * frequently impersonated names; never an arbitrary 4–5 char catalog name
 * (Link, Core, Gate, Port, Voice, Eset, … are dictionary fragments). And:
 *   - the token is >= GLUED_MIN_TOKEN_LEN chars ("kicklogin" stays whole-token);
 *   - the rest of the token, on each side of the name, splits ENTIRELY into
 *     lure / glue words and digits (segmentsInto, exact words — never a
 *     prefix: "documentary", "shareholders", "accountingservices" fail),
 *     with at least one lure word;
 *   - EXCEPT that one side may be a single unsegmentable chunk when the
 *     other side is non-empty, starts right at the name and segments with a
 *     lure word, and the chunk is a long run-on blob (>= GLUED_CHUNK_MIN_LEN:
 *     "invitationlauchjc" + zoom + "meeting"; never the short English
 *     fragment of "pur|chase|verify", "other|wise|login").
 * Never applies to IdP-lure leftovers (whole-token only) and runs only after
 * every other rule found nothing, so existing matches are unchanged.
 */
const GLUED_MIN_TOKEN_LEN = 10;
const GLUED_CHUNK_MIN_LEN = 8;

export const GLUED_BRAND_ALLOWLIST: Readonly<Record<string, string>> = {
  "zoom.us": "zoom", "zoom.com": "zoom", "adobe.com": "adobe", "uber.com": "uber",
  "xero.com": "xero", "hulu.com": "hulu", "nike.com": "nike", "avis.com": "avis",
  "chase.com": "chase", "citi.com": "citi", "ally.com": "ally", "visa.com": "visa",
  "americanexpress.com": "amex", "ebay.com": "ebay", "etsy.com": "etsy", "wise.com": "wise",
  "usps.com": "usps", "fedex.com": "fedex", "lyft.com": "lyft", "venmo.com": "venmo",
  "zellepay.com": "zelle", "xbox.com": "xbox", "sony.com": "sony", "bbva.com": "bbva",
  "hsbc.com": "hsbc", "gmail.com": "gmail", "yahoo.com": "yahoo", "monzo.com": "monzo",
  "steampowered.com": "steam", "hmrc.gov.uk": "hmrc", "bpost.be": "bpost",
};

/** The glued rule for one hyphen token and one allowlisted normalized name. */
function gluedTokenMatch(token: string, norm: string): boolean {
  if (token.length < GLUED_MIN_TOKEN_LEN || token === norm) return false;
  const ok = (side: string) => side === "" || segmentsInto(side, GLUED_VOCAB);
  const lured = (side: string) => side !== "" && segmentsInto(side, GLUED_VOCAB, GLUED_LURES);
  for (let i = token.indexOf(norm); i >= 0; i = token.indexOf(norm, i + 1)) {
    const prefix = token.slice(0, i);
    const suffix = token.slice(i + norm.length);
    if (ok(prefix) && ok(suffix) && (lured(prefix) || lured(suffix))) return true;
    // One unsegmentable run-on chunk on the far side of a lure-adjacent name.
    if (lured(suffix) && prefix.length >= GLUED_CHUNK_MIN_LEN && !ok(prefix)) return true;
    if (lured(prefix) && suffix.length >= GLUED_CHUNK_MIN_LEN && !ok(suffix)) return true;
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
 * beside a credential lure ("line-login.com" targets LINE,
 * "free-facture-login.com" targets Free / free.fr). For these,
 * genericBrandHostMatch additionally accepts the bare word as a token next
 * to a credential lure word, or glued to lure words only ("linelogin",
 * "mylinelogin") — in every writer and in the cleanup alike. Keep this list
 * tiny and per-name justified.
 */
const LURE_GATED_GENERIC_BRANDS: ReadonlySet<string> = new Set(["line", "free"]);

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

/** End positions e such that s[start, e) spells `canon` exactly or with
 *  homoglyphs swapped in; `swapped` says whether any homoglyph was used. */
function spellingEnds(s: string, start: number, canon: string): Array<{ end: number; swapped: boolean }> {
  const out: Array<{ end: number; swapped: boolean }> = [];
  const walk = (i: number, j: number, swapped: boolean): void => {
    if (j === canon.length) { out.push({ end: i, swapped }); return; }
    if (i >= s.length) return;
    const c = canon[j]!;
    if (s[i] === c) walk(i + 1, j + 1, swapped);
    for (const sub of GENERIC_HOMOGLYPHS[c] ?? []) {
      if (s.startsWith(sub, i)) walk(i + sub.length, j + 1, true);
    }
  };
  walk(start, 0, false);
  return out;
}

/** True when `cand` spells `canon` with at least one homoglyph swapped in
 *  ("mai1" / "rnail" for "mail") — never for the identical string. */
function homoglyphSpelling(cand: string, canon: string): boolean {
  return spellingEnds(cand, 0, canon).some((e) => e.end === cand.length && e.swapped);
}

/** Exact or homoglyph spelling of `canon`. */
function spells(cand: string, canon: string): boolean {
  return cand === canon || homoglyphSpelling(cand, canon);
}

/**
 * Generic-word brands that are a PRODUCT of a larger vendor whose
 * credential lures they appear in (owner decision 2026-10-12): a link that
 * the generic rule would clear is moved to the parent brand instead when the
 * host carries that vendor's lure context. Keyed by the generic brand's
 * canonical domain; the vendor's real tokens and own domains are in
 * OWNER_VENDORS (keyed by parent brand).
 */
export const GENERIC_BRAND_OWNERS: Readonly<Record<string, { parentBrandId: string }>> = {
  "live.com": { parentBrandId: "brand_microsoft_com" },
  "office.com": { parentBrandId: "brand_microsoft_com" },
  "cloud.microsoft": { parentBrandId: "brand_microsoft_com" },
};

/**
 * Per parent brand: the vendor's REAL product / brand tokens that a WRITER
 * needs before crediting the parent (review N3 — "cloud", "office", "live"
 * alone never are: cloud-login.com, box-office-login.com), and the vendor's
 * own registrable domains, which are never a lure (outlook.office365.com).
 * Short tokens count only as a whole hyphen token; long ones also glued.
 */
const OWNER_VENDORS: Readonly<Record<string, { tokens: readonly string[]; glued: readonly string[]; ownDomains: ReadonlySet<string> }>> = {
  brand_microsoft_com: {
    tokens: ["msn", "msft", "o365", "m365", "azure", "outlook", "hotmail", "onedrive", "sharepoint",
      "microsoft", "office365", "microsoft365", "windowslive", "livecom"],
    glued: ["microsoft", "microsoftonline", "onmicrosoft", "office365", "microsoft365", "outlook",
      "outlook365", "onedrive", "sharepoint", "hotmail", "windowslive", "msaccount", "msonline"],
    ownDomains: new Set([
      "microsoft.com", "microsoftonline.com", "onmicrosoft.com", "microsoft365.com", "office.com",
      "office.net", "office365.com", "live.com", "outlook.com", "hotmail.com", "msn.com", "sharepoint.com",
      "onedrive.com", "azure.com", "windows.net", "msft.net", "msauth.net", "msftauth.net",
    ]),
  },
};

/** Cheap superset precheck: any vendor token as a substring at all. */
const OWNER_PRECHECK: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(OWNER_VENDORS).map(([id, v]) => [id, [...new Set([...v.tokens, ...v.glued])]]),
);

/**
 * Parent brand for a vendor-product generic brand (GENERIC_BRAND_OWNERS),
 * or null — ONE rule for every writer (matcher, NRD, CT, Analyst) and the
 * brand-link cleanup: the host must name the generic product word
 * ("office365-login", "outlook-live-login") AND carry a REAL vendor token
 * (OWNER_VENDORS.tokens as a hyphen token, or OWNER_VENDORS.glued inside
 * one); the generic word alone never suffices ("cloud-login.com",
 * "live-login.com", "box-office-login.com" → null). Never on a shared /
 * tenant host, the generic brand's own domain or the vendor's own domains
 * (OWNER_VENDORS.ownDomains: "outlook.office365.com").
 */
export function genericBrandOwnerCredit(
  raw: string,
  canonical: string | null | undefined,
): { parentBrandId: string } | null {
  const spec = genericSpec(canonical ?? "", false);
  if (!spec) return null;
  const ctx = hostCtx(raw);
  if (!ctx) return null;
  return ownerCreditSpec(ctx, spec);
}

function ownerCreditSpec(ctx: HostCtx, spec: GenericSpec): { parentBrandId: string } | null {
  const owner = GENERIC_BRAND_OWNERS[spec.canonHost];
  if (!owner) return null;
  const vendor = OWNER_VENDORS[owner.parentBrandId];
  if (!vendor) return null;
  const { host } = ctx;
  // Cheap substring precheck before any parsing (review N1).
  if (!(OWNER_PRECHECK.get(owner.parentBrandId) ?? []).some((t) => host.includes(t))) return null;
  // Shared / tenant hosts (safelinks wrappers, x.sharepoint.com,
  // onedrive.live.com) carry the vendor's name but not a lure.
  if (platformSuffixFor(host) !== null || isMultiTenantHost(host)) return null;
  // The generic brand's own domain and the vendor's own domains are not lures.
  if (host === spec.canonHost || host.endsWith(spec.canonDot)) return null;
  const reg = registrableDomain(host);
  if (reg && vendor.ownDomains.has(reg)) return null;
  const labels = ctx.labels();
  const word = spec.canon[0]!.replace(/-/g, "");
  if (!labels.some((l) => l.includes(word))) return null;
  for (const label of labels) {
    for (const t of label.split(/[-_]/).filter((x) => x.length > 0)) {
      if (vendor.tokens.includes(t) || vendor.glued.some((g) => t.includes(g))) return { parentBrandId: owner.parentBrandId };
    }
  }
  return null;
}

/** What may be glued onto a generic brand's full-domain token or bare
 *  lure-gated word: credential lures, glue words and digits, exact words
 *  only ("mymailru", "mailru24", "mailruwallet", "linelogin"). */
const GENERIC_GLUE_VOCAB: ReadonlySet<string> = new Set([...CREDENTIAL_LURE_WORDS, ...LURE_GLUE_WORDS]);

/**
 * THE predicate for "may this host be credited to this generic-word brand"
 * — used by every writer (brand matcher, Analyst pre-match, NRD, CT,
 * typosquat scanner, numbered-variant scan, lookalike seeder, spam trap,
 * abuse mailbox) AND the brand-link cleanup, so they cannot disagree:
 *   canonical  — the canonical domain itself, or (subdomains: true) a
 *                subdomain of it that is not a platform tenant / multi-
 *                tenant host ("e.mail.ru"; never "x.my.site.com",
 *                "cloud.mail.ru")
 *   token      — the full canonical as consecutive labels left of the host's
 *                own registrable domain ("mail.ru.secure-login.com"); its
 *                tokens as a hyphen run ("mail-ru.com", "login-gov.us"); or
 *                the joined full-domain token inside one token with only
 *                credential lures / glue / digits around it ("mymailru",
 *                "mailru24", "mailruwallet"); lureGated brands (LINE, Free)
 *                also by the bare word beside / glued to a credential lure
 *                ("line-login.com", "linelogin.xyz", "free-facture-login.com")
 *   levenshtein — any of the above spelled with homoglyphs ("mai1.ru",
 *                "rnail.ru", "maiiru.com", "mai1ru-login.com")
 * The bare word never qualifies otherwise: "1lookupmails.com",
 * "emailrules.com", "zs-mail.com", "olivecompany.com", "rnail.info" → null.
 * Tier-agnostic and catalog-free. Use matchGenericBrand to derive
 * `lureGated` from the brand name.
 */
export function genericBrandHostMatch(
  raw: string,
  canonical: string | null | undefined,
  opts: { subdomains: boolean; lureGated?: boolean },
): BrandMatchMethod | null {
  const spec = genericSpec(canonical ?? "", !!opts.lureGated);
  if (!spec) return null;
  const ctx = hostCtx(raw);
  if (!ctx) return null;
  return genericMatchSpec(ctx, spec, opts.subdomains);
}

function genericMatchSpec(ctx: HostCtx, spec: GenericSpec, subdomains: boolean): BrandMatchMethod | null {
  const { host } = ctx;
  if (host === spec.canonHost) return "canonical";
  if (host.endsWith(spec.canonDot)) {
    // A tenant subdomain of a platform ("evil.pages.dev" for "Pages",
    // "x.my.site.com" for "Site") or a multi-tenant host ("cloud.mail.ru")
    // belongs to an arbitrary party, not the brand.
    if (!subdomains || platformSuffixFor(host) !== null || isMultiTenantHost(host)) return null;
    return "canonical";
  }
  // Cheap early exit (2026-10-12 perf, review N1). The token rules below
  // need the canonical host as labels, its tokens joined or hyphen/underscore
  // separated (raw or homoglyph-folded — homoglyphSkeleton), or — lure-gated
  // brands only — the bare word; the tail rule needs the canonical's
  // suffix at the end. Most hosts fail all of them.
  const sk = ctx.skeleton;
  const tailOnly = !sk.includes(spec.skelFirstTok) || !(host.includes(spec.canonHost) || sk.includes(spec.skelJoined)
    || sk.includes(spec.skelHyphen) || sk.includes(spec.skelUnderscore)
    || (spec.lureGated && host.includes(spec.word) && LURE_GATED_LURE_LIST.some((w) => host.includes(w))));
  if (tailOnly && !host.endsWith(spec.suffixDot)) return null;

  const all = ctx.all;
  // Homoglyph spelling of the canonical under the same suffix: mai1.ru.
  // (The suffix check is host.endsWith(suffixDot); the label must fold to
  // the same skeleton before the exact spelling walk.)
  const ti = all.length - spec.canon.length;
  if (ti >= 0 && host.endsWith(spec.suffixDot) && ctx.labelSkeleton(ti) === spec.skelFirstLabel
      && homoglyphSpelling(all[ti]!, spec.canon[0]!)) {
    return "levenshtein";
  }
  if (tailOnly) return null;

  // The canonical as consecutive labels, entirely LEFT of the host's own
  // registrable domain: mail.ru.secure-login.com, never x.site.com.br
  // (whose registrable domain is site.com.br itself).
  const regStart = ctx.regStart();
  for (let k = 0; k + spec.canon.length <= regStart; k++) {
    if (spec.canon.every((l, i) => all[k + i] === l)) return "token";
  }

  const glue = (side: string) => side === "" || segmentsInto(side, GENERIC_GLUE_VOCAB);
  const gated = (side: string) => side === "" || segmentsInto(side, LURE_GATED_VOCAB);
  const gatedLured = (side: string) => side !== "" && segmentsInto(side, LURE_GATED_VOCAB, LURE_GATED_LURES);
  for (const label of ctx.labels()) {
    const tokens = label.split(/[-_]/).filter((t) => t.length > 0);
    // Hyphen run of the canonical's tokens: mail-ru, login-gov, mai1-ru.
    for (let i = 0; i + spec.canonTokens.length <= tokens.length; i++) {
      if (spec.canonTokens.every((t, k) => spells(tokens[i + k]!, t))) {
        return spec.canonTokens.every((t, k) => tokens[i + k] === t) ? "token" : "levenshtein";
      }
    }
    for (const [ti, t] of tokens.entries()) {
      // Joined full-domain token with only lure / glue / digits around it.
      for (let i = 0; i < t.length; i++) {
        for (const { end, swapped } of spellingEnds(t, i, spec.joined)) {
          if (glue(t.slice(0, i)) && glue(t.slice(end))) return swapped ? "levenshtein" : "token";
        }
      }
      if (!spec.lureGated) continue;
      // Lure-gated bare word (LINE, Free): beside a NARROW credential lure
      // token (LURE_GATED_LURES), or glued to such lures / glue only.
      const word = spec.word;
      if (t === word && (gatedLured(tokens[ti - 1] ?? "") || gatedLured(tokens[ti + 1] ?? ""))) return "token";
      for (let i = t.indexOf(word); i >= 0; i = t.indexOf(word, i + 1)) {
        const pre = t.slice(0, i);
        const post = t.slice(i + word.length);
        if (gated(pre) && gated(post) && (gatedLured(pre) || gatedLured(post))) return "token";
      }
    }
  }
  return null;
}

/**
 * Narrow lure set for lure-gated generic brands (LINE, Free — review N4):
 * only sign-in / account words. The broad CREDENTIAL_LURE_WORDS (claim,
 * wallet, tracking, update, support, refund) are everyday words next to
 * "free"/"line" ("free-claim", "freetracking", "linesupport").
 */
const LURE_GATED_LURES: ReadonlySet<string> = new Set([
  "login", "logon", "signin", "signon", "verify", "verification", "account", "accounts",
  "password", "auth", "secure", "id", "facture",
]);
const LURE_GATED_LURE_LIST: readonly string[] = [...LURE_GATED_LURES];
const LURE_GATED_VOCAB: ReadonlySet<string> = new Set([...LURE_GATED_LURES, "my", "www", "the", "get", "official"]);

interface GenericSpec {
  canon: string[];
  canonHost: string;
  canonDot: string;
  suffix: string;
  suffixDot: string;
  canonTokens: string[];
  joined: string;
  word: string;
  skelJoined: string;
  skelFirstLabel: string;
  skelFirstTok: string;
  skelHyphen: string;
  skelUnderscore: string;
  lureGated: boolean;
}

/** Per (canonical, lureGated) precomputation — a handful of generic brands,
 *  so a plain Map is enough (review N1). */
const genericSpecCache = new Map<string, GenericSpec | null>();

function genericSpec(canonical: string, lureGated: boolean): GenericSpec | null {
  const key = `${canonical}|${lureGated ? 1 : 0}`;
  const hit = genericSpecCache.get(key);
  if (hit !== undefined) return hit;
  const canon = canonicalLabels(canonical);
  let spec: GenericSpec | null = null;
  if (canon.length >= 2) {
    const canonHost = canon.join(".");
    const canonTokens = canon.flatMap((l) => l.split("-")).filter((t) => t.length > 0);
    const suffix = canon.slice(1).join(".");
    spec = {
      canon, canonHost, canonDot: `.${canonHost}`, suffix, suffixDot: `.${suffix}`, canonTokens,
      joined: canonTokens.join(""), word: canon[0]!.replace(/-/g, ""),
      skelJoined: homoglyphSkeleton(canonTokens.join("")), skelFirstLabel: homoglyphSkeleton(canon[0]!),
      skelFirstTok: homoglyphSkeleton(canonTokens[0]!), skelHyphen: homoglyphSkeleton(canonTokens.join("-")),
      skelUnderscore: homoglyphSkeleton(canonTokens.join("_")), lureGated,
    };
  }
  if (genericSpecCache.size > 10_000) genericSpecCache.clear();
  genericSpecCache.set(key, spec);
  return spec;
}

/**
 * Fold every GENERIC_HOMOGLYPHS spelling onto one character, so a host
 * that spells a word with homoglyphs CONTAINS the word's skeleton
 * ("rnai1" → "mall", "mail" → "mall"). Used only as a superset prefilter.
 */
/** ASCII fold table: each GENERIC_HOMOGLYPHS single-char spelling → the
 *  character it stands for (1/i → l, 0 → o, 3 → e, …). */
const SKELETON_FOLD: Uint8Array = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < 128; i++) t[i] = i;
  const set = (from: string, to: string) => { t[from.charCodeAt(0)] = to.charCodeAt(0); };
  set("1", "l"); set("i", "l"); set("0", "o"); set("3", "e"); set("4", "a");
  set("5", "s"); set("7", "t"); set("9", "g"); set("6", "b");
  return t;
})();
const CH_R = 114, CH_N = 110, CH_M = 109, CH_V = 118, CH_W = 119, CH_C = 99, CH_L = 108, CH_D = 100;

function homoglyphSkeleton(s: string): string {
  // One pass: fold single-char homoglyphs, then merge rn → m, vv → w,
  // cl → d over the folded stream (same result as folding first and then
  // replacing the pairs left to right).
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const f = c < 128 ? SKELETON_FOLD[c]! : c;
    const last = out.length - 1;
    const prev = last >= 0 ? out[last] : -1;
    if (prev === CH_R && f === CH_N) out[last] = CH_M;
    else if (prev === CH_V && f === CH_V) out[last] = CH_W;
    else if (prev === CH_C && f === CH_L) out[last] = CH_D;
    else out.push(f);
  }
  return String.fromCharCode(...out);
}

interface HostCtx {
  host: string;
  all: string[];
  skeleton: string;
  labelSkeleton: (i: number) => string;
  regStart: () => number;
  labels: () => string[];
}

/** Host parsed once and reused across every generic brand checked for it
 *  (single-entry memo — the writers check one host against all brands in a
 *  row). null for non-hostnames. */
let lastHostCtx: { raw: string; ctx: HostCtx | null } | null = null;

function hostCtx(raw: string): HostCtx | null {
  if (lastHostCtx && lastHostCtx.raw === raw) return lastHostCtx.ctx;
  const host = hostOf(raw);
  let ctx: HostCtx | null = null;
  if (HOSTNAME_RE.test(host) && !IPV4_RE.test(host)) {
    const all = host.split(".").filter((l) => l.length > 0);
    let regStart: number | undefined;
    let labels: string[] | undefined;
    const labelSkels: string[] = [];
    ctx = {
      host, all, skeleton: homoglyphSkeleton(host),
      labelSkeleton: (i: number) => (labelSkels[i] ??= homoglyphSkeleton(all[i] ?? "")),
      regStart: () => {
        if (regStart === undefined) {
          const reg = registrableDomain(host);
          regStart = reg ? all.length - reg.split(".").length : all.length;
        }
        return regStart;
      },
      labels: () => (labels ??= all.slice(0, all.length - suffixLabelCount(host))),
    };
  }
  lastHostCtx = { raw, ctx };
  return ctx;
}

/**
 * A prepared set of generic-word brands for the high-volume writers (brand
 * matcher index, NRD, CT, Analyst): each brand's spec is built once, each
 * host is parsed once, and owner credit is tried only when the set holds a
 * vendor-product brand and the host passes its cheap vendor-token precheck
 * (review N1). credit() == the first creditGenericBrand hit over the brands
 * in order, own-brand matches before any parent credit.
 */
export class GenericBrandSet {
  private readonly entries: Array<{ id: string; spec: GenericSpec; canonical: string; owner: boolean }> = [];
  readonly size: number;

  constructor(
    brands: ReadonlyArray<{ id: string; name: string | null; canonical_domain: string | null }>,
    private readonly brandExists: (brandId: string) => boolean,
    /** NRD / CT: a brand never matches its own canonical domain. */
    private readonly opts: { excludeOwnDomain?: boolean } = {},
  ) {
    for (const b of brands) {
      const canonical = b.canonical_domain ?? "";
      const spec = genericSpec(canonical, isLureGatedGenericBrand(b.name));
      if (!spec) continue;
      this.entries.push({ id: b.id, spec, canonical, owner: GENERIC_BRAND_OWNERS[spec.canonHost] !== undefined });
    }
    this.size = this.entries.length;
    // Union of the owners' vendor tokens: one substring sweep per host
    // decides whether any parent credit is possible at all.
    this.ownerPrecheck = [...new Set(this.entries.filter((e) => e.owner)
      .flatMap((e) => OWNER_PRECHECK.get(GENERIC_BRAND_OWNERS[e.spec.canonHost]!.parentBrandId) ?? []))];
  }

  private readonly ownerPrecheck: string[];

  /** `via` is the generic brand that produced the credit (== brandId unless
   *  a parent was credited). */
  credit(raw: string): { brandId: string; method: BrandMatchMethod; via: string } | null {
    if (this.entries.length === 0) return null;
    const ctx = hostCtx(raw);
    if (!ctx) return null;
    for (const e of this.entries) {
      if (this.opts.excludeOwnDomain && ctx.host === e.spec.canonHost) continue;
      const m = genericMatchSpec(ctx, e.spec, false);
      if (m) return { brandId: e.id, method: m, via: e.id };
    }
    if (this.ownerPrecheck.length === 0 || !this.ownerPrecheck.some((t) => ctx.host.includes(t))) return null;
    for (const e of this.entries) {
      if (!e.owner) continue;
      const owner = ownerCreditSpec(ctx, e.spec);
      if (owner && owner.parentBrandId !== e.id && this.brandExists(owner.parentBrandId)) {
        return { brandId: owner.parentBrandId, method: "token", via: e.id };
      }
    }
    return null;
  }
}

/** genericBrandHostMatch with `lureGated` derived from the brand name. */
export function matchGenericBrand(
  raw: string,
  brand: { name: string | null; canonical_domain: string | null },
  opts: { subdomains: boolean },
): BrandMatchMethod | null {
  return genericBrandHostMatch(raw, brand.canonical_domain, {
    subdomains: opts.subdomains, lureGated: isLureGatedGenericBrand(brand.name),
  });
}

/**
 * What a WRITER credits for a host when the candidate brand is generic:
 * the brand itself (matchGenericBrand, never by subdomain), else — for a
 * vendor-product generic brand (GENERIC_BRAND_OWNERS) on a host with that
 * vendor's lure context — its parent brand, provided `brandExists` knows it.
 * The cleanup (decideGenericLink) applies the same two steps, with the
 * catalog matcher's pick in between.
 */
export function creditGenericBrand(
  raw: string,
  brand: { id: string; name: string | null; canonical_domain: string | null },
  brandExists: (brandId: string) => boolean,
): { brandId: string; method: BrandMatchMethod } | null {
  const own = matchGenericBrand(raw, brand, { subdomains: false });
  if (own) return { brandId: brand.id, method: own };
  const owner = genericBrandOwnerCredit(raw, brand.canonical_domain);
  if (owner && owner.parentBrandId !== brand.id && brandExists(owner.parentBrandId)) {
    return { brandId: owner.parentBrandId, method: "token" };
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
  // Salesforce Experience Cloud customer sites (<org>.my.site.com): the
  // tenant is any Salesforce customer, never the "Site" (site.com) brand.
  "my.site.com",
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
  // Path-addressed user content under a generic-word brand's own domain
  // (cloud.mail.ru/public/<id>, sites.free.fr/<user>, Orange perso pages):
  // never evidence for that brand (brandDetect genericBrandHostMatch).
  "cloud.mail.ru", "sites.free.fr", "pagesperso-orange.free.fr", "pagesperso-orange.fr",
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

/** PLATFORM_SUFFIXES entry → its FIRST list index (the order decides ties). */
const PLATFORM_SUFFIX_INDEX: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  PLATFORM_SUFFIXES.forEach((p, i) => { if (!m.has(p)) m.set(p, i); });
  return m;
})();

const MULTI_TENANT_SET: ReadonlySet<string> = new Set(MULTI_TENANT_HOSTS);

/** host is a MULTI_TENANT_HOSTS entry or a subdomain of one (suffix walk). */
function inMultiTenantHosts(host: string): boolean {
  if (MULTI_TENANT_SET.has(host)) return true;
  for (let i = host.indexOf("."); i >= 0; i = host.indexOf(".", i + 1)) {
    if (MULTI_TENANT_SET.has(host.slice(i + 1))) return true;
  }
  return false;
}

/**
 * The PLATFORM_SUFFIXES entry `host` is a tenant of, or null. A
 * vendor-owned subdomain of an IdP suffix (login.okta.com, eu.auth0.com,
 * status.okta.com — the classifier's corp-label exclusion via
 * idpTenantLabel) is NOT a tenant: it belongs to the vendor.
 */
function platformSuffixFor(host: string): string | null {
  // Suffix walk over a list-index map instead of scanning every entry
  // (review N1). Picks the matching entry with the LOWEST list index —
  // exactly what the original first-match loop over PLATFORM_SUFFIXES did.
  let best = -1;
  for (let i = host.indexOf("."); i >= 0; i = host.indexOf(".", i + 1)) {
    const idx = PLATFORM_SUFFIX_INDEX.get(host.slice(i + 1));
    if (idx === undefined || (best >= 0 && idx > best)) continue;
    const p = PLATFORM_SUFFIXES[idx]!;
    if (IDP_SUFFIXES.has(p) && idpTenantLabel(host) === null) continue;
    best = idx;
  }
  return best >= 0 ? PLATFORM_SUFFIXES[best]! : null;
}

/** Original first-match loop — kept for the equivalence test only. */
export function platformSuffixForSlow(host: string): string | null {
  for (const p of PLATFORM_SUFFIXES) {
    if (!host.endsWith(`.${p}`)) continue;
    if (IDP_SUFFIXES.has(p) && idpTenantLabel(host) === null) continue;
    return p;
  }
  return null;
}

/** The PLATFORM_SUFFIXES list, for the equivalence test. */
export function platformSuffixList(): readonly string[] {
  return PLATFORM_SUFFIXES;
}

/** platformSuffixFor, exported for the equivalence test. */
export function platformSuffixOf(host: string): string | null {
  return platformSuffixFor(host);
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
  return inMultiTenantHosts(host);
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
  /** Allowlisted 4–5 char name eligible for the glued rule (GLUED_BRAND_ALLOWLIST). */
  glued: boolean;
  /** Generic-word brand (isGenericBrand) outside the tracked catalog, with a
   *  canonical domain: credited by genericBrandHostMatch only. */
  genericLookalike: boolean;
  /** Generic brand that may also match by the bare word beside a lure. */
  lureGated: boolean;
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
    glued: matchable && norm.length < MIN_SUBSTRING_LEN && GLUED_BRAND_ALLOWLIST[canonical] === norm,
    genericLookalike: generic && b.tier !== "tracked" && canonical.includes("."),
    lureGated: isLureGatedGenericBrand(b.name),
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
  /** Every brand id in the catalog (owner-credit targets must exist). */
  ids: Set<string>;
  /** idx.generic as a prepared GenericBrandSet (built after the loop). */
  genericSet: GenericBrandSet | null;
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
    long: [], longByFirst: new Map(), glued: [], generic: [], ids: new Set(), genericSet: null,
  };
  const genericRows: BrandRow[] = [];
  for (const b of brands) {
    const p = prepareOne(b);
    idx.ids.add(p.id);
    if (p.canonical && !idx.canonical.has(p.canonical)) idx.canonical.set(p.canonical, p.id);
    if (p.genericLookalike) { idx.generic.push(p); genericRows.push(b); }
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
  idx.genericSet = new GenericBrandSet(genericRows, (id) => idx.ids.has(id));
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
  if (p.genericLookalike) {
    return genericBrandHostMatch(parts.host, p.canonical, { subdomains: true, lureGated: p.lureGated });
  }
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
  // Own-brand full-canonical lookalikes first, then a vendor-product
  // brand's parent (Live / Office / Cloud → Microsoft) — GenericBrandSet.
  const hit = idx.genericSet?.credit(host);
  return hit ? { brandId: hit.brandId, method: hit.method } : null;
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
