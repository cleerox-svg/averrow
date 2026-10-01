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
  /** Labels with the public suffix removed: "a-b.evil.co.uk" → ["a-b", "evil"]. */
  labels: string[];
  /** Hyphen-split tokens of those labels: ["a", "b", "evil"]. */
  tokens: string[];
}

const HOSTNAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** A bare brand name, e.g. PhishTank's `target` field ("PayPal", "Bank of America"). */
const BARE_NAME_RE = /^[a-z0-9 ]+$/;

function hostParts(raw: string): HostParts | null {
  const trimmed = raw.trim().toLowerCase();
  if (BARE_NAME_RE.test(trimmed) && !/^\d+$/.test(trimmed.replace(/ /g, ""))) {
    const words = trimmed.split(" ").filter((w) => w.length > 0);
    return { host: words.join(""), labels: [words.join("")], tokens: words };
  }
  // Everything else must be a real hostname. JSON IOC blobs
  // ({"ip":…,"dataplane_feed":"telnetlogin"}), "hash:sha-256:…" values,
  // "1.2.3.4 (6 lists)" and IP literals were matched as free text before
  // ("Login", "Ashs", "List", "1x1x5") — they carry no brand signal.
  const host = hostOf(raw);
  if (!HOSTNAME_RE.test(host) || IPV4_RE.test(host)) return null;
  const all = host.split(".").filter((l) => l.length > 0);
  const reg = registrableDomain(host);
  // Suffix label count = registrable labels minus its one owner label.
  const suffixLen = reg ? reg.split(".").length - 1 : 0;
  const labels = all.slice(0, all.length - suffixLen).filter((l) => l.length > 0);
  const tokens = labels.flatMap((l) => l.split("-")).filter((t) => t.length > 0);
  return { host, labels, tokens };
}

interface PreparedBrand {
  id: string;
  canonical: string;
  norm: string;
  /** False for generic / too-short names — canonical-domain match only. */
  matchable: boolean;
}

// Normalizing 100K+ brand names per call dominated the old loop; cache the
// prepared list per brands array (callers load it once per run).
const preparedCache = new WeakMap<BrandRow[], PreparedBrand[]>();

function prepareOne(b: BrandRow): PreparedBrand {
  const norm = normalizeBrand(b.name);
  return {
    id: b.id,
    canonical: (b.canonical_domain ?? "").toLowerCase().replace(/^www\./, ""),
    norm,
    matchable: norm.length >= 4 && !isGenericBrand(norm),
  };
}

function prepare(brands: BrandRow[]): PreparedBrand[] {
  let prepared = preparedCache.get(brands);
  if (!prepared) {
    prepared = brands.map(prepareOne);
    preparedCache.set(brands, prepared);
  }
  return prepared;
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

function tokenMatch(parts: HostParts, norm: string): boolean {
  for (const t of parts.tokens) {
    if (t === norm) return true;
  }
  for (const l of parts.labels) {
    const flat = l.replace(/-/g, "");
    if (flat === norm || stripObfuscation(flat) === norm) return true;
  }
  return false;
}

function substringMatch(parts: HostParts, norm: string): boolean {
  if (norm.length < MIN_SUBSTRING_LEN) return false;
  for (const l of parts.labels) {
    const flat = l.replace(/-/g, "");
    if (flat.includes(norm) || stripObfuscation(flat).includes(norm)) return true;
  }
  return false;
}

function levenshteinMatch(parts: HostParts, norm: string): boolean {
  const maxDist = maxEditDistance(norm.length);
  if (maxDist === 0) return false;
  for (const t of [...parts.labels, ...parts.tokens]) {
    if (t[0] !== norm[0]) continue;
    if (Math.abs(t.length - norm.length) > maxDist) continue;
    if (osaDistance(t, norm) <= maxDist) return true;
  }
  return false;
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
  if (levenshteinMatch(parts, p.norm)) return "levenshtein";
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
  const prepared = prepare(brands);
  for (const raw of haystacks) {
    if (!raw) continue;
    const parts = hostParts(raw);
    if (!parts) continue;

    for (const b of prepared) {
      if (b.canonical && parts.host === b.canonical) return { brandId: b.id, method: "canonical" };
    }
    for (const b of prepared) {
      if (b.matchable && tokenMatch(parts, b.norm)) return { brandId: b.id, method: "token" };
    }
    for (const b of prepared) {
      if (b.matchable && substringMatch(parts, b.norm)) return { brandId: b.id, method: "substring" };
    }
    for (const b of prepared) {
      if (b.matchable && levenshteinMatch(parts, b.norm)) return { brandId: b.id, method: "levenshtein" };
    }
  }
  return null;
}

/** As fuzzyMatchBrandDetailed, returning only the brand id. */
export function fuzzyMatchBrand(haystacks: string[], brands: BrandRow[]): string | null {
  return fuzzyMatchBrandDetailed(haystacks, brands)?.brandId ?? null;
}

/**
 * Load all brands from DB.
 */
async function loadBrands(db: D1Database): Promise<BrandRow[]> {
  const rows = await db.prepare("SELECT id, name, canonical_domain FROM brands").all<BrandRow>();
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
