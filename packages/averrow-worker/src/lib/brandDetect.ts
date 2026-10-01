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
 *
 * Generic-word brand names ("Data", "Login", "Click", …) only ever match
 * by canonical domain — the catalog holds 100K+ brands, and a
 * dictionary-word name otherwise matches unrelated infrastructure.
 */

import { registrableDomain } from "./domain-utils";

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
}

/** Which rule produced a match — persisted to threats.brand_match_method. */
export type BrandMatchMethod = "canonical" | "token" | "substring" | "levenshtein";

export interface BrandMatch {
  brandId: string;
  method: BrandMatchMethod;
}

/** Brand names shorter than this need a whole-token match (no substring/fuzzy). */
const MIN_SUBSTRING_LEN = 6;

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
]);

/** Returns true if a normalized brand name may only match by canonical domain. */
export function isGenericBrand(normalized: string): boolean {
  return /^\d+$/.test(normalized) || GENERIC_BRAND_NAMES.has(normalized);
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
  "wixsite.com", "cloudapp.net", "webcindario.com", "temporary.site",
  "mytemp.website", "contaboserver.net",
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

function suffixLabelCount(host: string): number {
  for (const p of PLATFORM_SUFFIXES) {
    if (host.endsWith(`.${p}`)) return p.split(".").length;
  }
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
  const all = host.split(".").filter((l) => l.length > 0);
  const labels = all.slice(0, all.length - suffixLabelCount(host));
  const tokens = labels.flatMap((l) => l.split(/[-_]/)).filter((t) => t.length > 0);
  return buildParts(host, labels, tokens);
}

interface PreparedBrand {
  id: string;
  canonical: string;
  norm: string;
  /** False for generic / too-short names — canonical-domain match only. */
  matchable: boolean;
}

function prepareOne(b: BrandRow): PreparedBrand {
  const norm = normalizeBrand(b.name);
  return {
    id: b.id,
    canonical: (b.canonical_domain ?? "").toLowerCase().replace(/^www\./, ""),
    norm,
    matchable: norm.length >= 4 && !isGenericBrand(norm) && b.tier !== "tracked",
  };
}

/** Lookup structures over the brand catalog (100K+ rows). */
interface BrandIndex {
  canonical: Map<string, string>;
  token: Map<string, string>;
  /** Matchable brands with names long enough for substring matching. */
  long: PreparedBrand[];
  /** Same, bucketed by first character for edit-distance matching. */
  longByFirst: Map<string, PreparedBrand[]>;
}

// Built once per brands array — callers load the catalog once per run and
// match hundreds of threats against it. First brand in array order wins a
// key, matching the old first-hit semantics.
const indexCache = new WeakMap<BrandRow[], BrandIndex>();

function indexBrands(brands: BrandRow[]): BrandIndex {
  const cached = indexCache.get(brands);
  if (cached) return cached;
  const idx: BrandIndex = { canonical: new Map(), token: new Map(), long: [], longByFirst: new Map() };
  for (const b of brands) {
    const p = prepareOne(b);
    if (p.canonical && !idx.canonical.has(p.canonical)) idx.canonical.set(p.canonical, p.id);
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
 */
export function matchBrandToHost(raw: string, brand: BrandRow): BrandMatchMethod | null {
  const parts = hostParts(raw);
  if (!parts) return null;
  const p = prepareOne(brand);
  if (p.canonical && parts.host === p.canonical) return "canonical";
  if (!p.matchable) return null;
  if (tokenMatch(parts, p.norm)) return "token";
  if (substringMatch(parts, p.norm)) return "substring";
  if (parts.candidates.some((c) => fuzzyMatch(c, p.norm))) return "levenshtein";
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
 * Load all brands from DB.
 */
export async function loadBrands(db: D1Database): Promise<BrandRow[]> {
  const rows = await db.prepare("SELECT id, name, canonical_domain, tier FROM brands").all<BrandRow>();
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
    `SELECT id, malicious_domain FROM threats
     WHERE malicious_domain IS NOT NULL AND target_brand_id IS NULL
     LIMIT 500`,
  ).all<{ id: string; malicious_domain: string }>();

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
