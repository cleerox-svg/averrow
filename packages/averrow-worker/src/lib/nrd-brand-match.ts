import type { ThreatRow } from "../feeds/types";
import { threatId } from "../feeds/types";

/**
 * NRD brand-keyword matcher (nrd_hagezi feed): finds COMBOSQUATS, i.e. new
 * domains that put a monitored brand's keyword in a label next to lure words
 * (`paypal-secure-login.com`, `coinbasevalidate.com`, `micros0ft-support.net`,
 * `att-login.com`). Exact dnstwist-style typosquats are not this module's
 * job: nrd_domains + lib/lookalike-nrd-matcher.ts claim those precisely.
 *
 * Why it is not a substring scan any more (2026-10-06). The old matcher
 * flagged any domain CONTAINING a brand-name needle. On the full Hagezi day
 * (~443K NRDs × 817 monitored brands) that was 43,010 threats in one run,
 * nearly all dictionary noise: "line" in `006zhiboonline.com.cn`, "one" in
 * `101graystone.com`, "nic" in `...clinic.com`, "intel" in `intelligence`.
 * Measured on a 443K-domain sample of the real list: old = 51,564 hits/day,
 * this matcher = ~310 hits/day (see docs/THREAT_FEEDS.md, NRD section).
 *
 * ── Keywords (buildBrandKeywords) ──
 * Per brand, up to three keywords, deduped:
 *   * the display name with non-alphanumerics removed (`standardchartered`),
 *   * the display name's words hyphen-joined when it has ≥2 words of ≥2
 *     chars (`standard-chartered`), so the hyphenated spelling matches too,
 *   * the canonical domain's registrable label (`zellepay` from zellepay.com),
 *     only when the canonical has no subdomain/path (`tv.apple.com` would
 *     yield the PARENT brand's label) AND that label is distinctive.
 * Keywords under 3 chars (hyphens ignored) and NEVER_KEYWORDS (infrastructure
 * words that are themselves lure vocabulary: www, mail, cloud, web, ...) are
 * dropped.
 *
 * ── Classification (isGenericKeyword) ──
 * GENERIC = ≤4 chars, or in GENERIC_KEYWORDS (a compact curated stop-list of
 * dictionary/common words that are monitored brand names today: line, live,
 * booking, apple, amazon, office, revenue, ...). Everything else is
 * DISTINCTIVE. No embedded dictionary: the stop-list only has to cover words
 * that are, or are likely to become, a monitored brand's keyword, and the
 * runtime demotion below catches the ones it misses.
 *
 * ── Matching (per domain) ──
 * The domain's registrable part (public suffix dropped: last label, or last
 * two for `co.uk`-style ccSLDs) is split into SEGMENTS on '-' and '.'. A
 * keyword occurrence counts only if the rest of its segment(s) decomposes
 * entirely into vocabulary words and digit runs — i.e. the keyword is a
 * delimited token or is concatenated with lure words, never embedded inside
 * an arbitrary word:
 *   * DISTINCTIVE keyword (+ homoglyph variants, as before): the rest of its
 *     segment ∈ (STRONG ∪ WEAK ∪ digits)*. `paypal.to`, `coinbase66.com`,
 *     `mygoogle.me`, `coinbasevalidate.com`, `docsharepoint.top` match;
 *     `canvashouse.uk`, `betonline.com` (T Online), `bahiahondastatepark.com`
 *     do not.
 *   * GENERIC keyword (no homoglyph variants): the rest of its segment ∈
 *     (STRONG ∪ digits)*, AND a STRONG lure word is present — in that
 *     segment or as an adjacent segment made only of STRONG words/digits.
 *     `att-login.com`, `dhlpayment.net`, `meta-validate.com` match;
 *     `line-store.com`, `onlineline.hair`, `frontier-era-security.com` (not
 *     adjacent) do not.
 * STRONG = phishing-action words (login, verify, secure, wallet, refund,
 * billing, support, ...). WEAK = neutral glue (my, official, app, web, doc,
 * share, ...): fine next to a distinctive brand, never enough on its own.
 *
 * ── Runtime demotion (the measured hit-rate rule) ──
 * A distinctive keyword that has produced `demoteAfter` (default
 * NRD_KEYWORD_DEMOTE_AFTER = 100) threat rows in ONE run is treated as
 * generic for the rest of that run, and reported by `demotedKeywords()`
 * (logged as `nrd_hagezi_keywords_demoted` — add it to GENERIC_KEYWORDS).
 * The busiest distinctive keyword on the measured day had ~30 hits, so this
 * only fires on an unanticipated dictionary word (a new brand called "Home"),
 * capping its flood at 100 rows. Deterministic: the list is processed in
 * byte-sorted order, so a retry of the same diff demotes at the same domain.
 *
 * Unchanged semantics: one row per distinct domain; the LOWEST-index brand
 * (load order) with a qualifying occurrence wins; a brand never matches its
 * own canonical domain (it falls through to the next brand); in-list repeats
 * are in-payload duplicates; same ThreatRow fields.
 *
 * Cost: needle lookups are the same Map probe per (position × distinct needle
 * length) as before, independent of brand count; the segment decomposition
 * only runs for domains with a raw needle hit (~12% of a day) and is
 * O(length × vocabulary word lengths). ~1–2 s per 443K domains.
 */

/** Phishing-action lure words: the only words that make a GENERIC keyword count. */
const STRONG_WORDS: ReadonlySet<string> = new Set([
  "login", "logon", "signin", "signon", "secure", "security", "verify", "verification", "verified",
  "account", "accounts", "acct", "auth", "authenticate", "authentication", "password", "passwd",
  "unlock", "unlocked", "recovery", "recover", "reset", "confirm", "confirmation", "validate",
  "validation", "suspended", "suspend", "locked", "limited", "kyc", "sso", "mfa", "2fa", "otp",
  "wallet", "refund", "refunds", "billing", "invoice", "payment", "payments", "helpdesk", "support",
  "customerservice", "airdrop", "claim", "update", "updates", "alert", "alerts", "notice",
  "notification", "restore",
]);

/** Neutral glue words: allowed next to a DISTINCTIVE keyword, never sufficient for a generic one. */
const WEAK_WORDS: ReadonlySet<string> = new Set([
  "my", "the", "www", "get", "go", "official", "online", "web", "mobile", "app", "apps", "id",
  "access", "connect", "portal", "center", "centre", "team", "desk", "help", "service", "services",
  "customer", "care", "pay", "bank", "banking", "card", "cards", "mail", "webmail", "inbox", "store",
  "shop", "info", "doc", "docs", "document", "documents", "drive", "file", "files", "share", "office",
  "cloud",
]);

/**
 * Dictionary / common words that are (or were) monitored-brand keywords:
 * matched only as GENERIC. Every entry is ≥5 chars (≤4 is generic by length).
 * Chosen by measuring each keyword's token hits on a real 443K-domain NRD day
 * and reading them: a brand stays distinctive when its hits read as brand
 * abuse (`coinbase66`, `tesla-hr.careers`), and lands here when they read as
 * unrelated businesses (`riviera-booking.org`, `azure-boutique.co`,
 * `revenue-bench.com`). Compare hyphen-stripped.
 */
export const GENERIC_KEYWORDS: ReadonlySet<string> = new Set([
  // everyday English words
  "intel", "office", "windows", "workers", "forms", "pages", "static", "archive", "example", "apple", "amazon",
  "opera", "domain", "shell", "subway", "nature", "medium", "current", "discover", "progressive",
  "compound", "optimism", "frontier", "metro", "chime", "lemonade", "travelers", "nationwide",
  "rainbow", "jupiter", "three", "prudential", "humana", "crave", "hinge", "coles", "telegraph",
  "weather", "speedtest", "android", "apache", "launchpad", "issuu", "slate", "quora", "curve",
  "oracle", "merkle", "springer", "indeed", "globo", "dropbox", "discord", "twitch", "booking",
  "blockchain", "revenue", "sushi", "lumen", "regions", "huntington", "anthem", "europa", "zurich",
  "celsius", "clarity", "meraki", "marcus", "hermes", "sentry", "fidelity", "vanguard", "gusto",
  "wiley", "chevron", "dominos", "chipotle", "slack", "stripe", "outlook", "azure", "docker", "unity",
  // multi-word names that are generic phrases
  "livevideo", "nameservices", "inneractive", "standardbank", "citizensbank", "firstnationalbank",
  "nationalgrid", "generalmotors", "newbalance", "sunlife", "bestwestern", "justeat", "wholefoods",
]);

/**
 * Never a keyword: infrastructure words that are lure vocabulary themselves
 * (a "mail"/"cloud" brand can't be told apart from `secure-mail-login.com`)
 * or that identify no brand at all.
 */
const NEVER_KEYWORDS: ReadonlySet<string> = new Set([
  "www", "com", "net", "org", "http", "https", "mail", "email", "webmail", "online", "web", "app",
  "cloud", "dns", "cdn", "static", "pages", "workers", "forms", "domain", "example", "archive", "media",
]);

/** Second-level labels that, under a 2-letter ccTLD, are part of the public suffix (`co.uk`). */
const CC_SECOND_LEVEL: ReadonlySet<string> = new Set([
  "co", "com", "gov", "ac", "org", "net", "govt", "gc", "edu", "or", "ne",
]);

/** Common homoglyph substitutions (distinctive keywords only). */
const HOMOGLYPHS: Record<string, string[]> = {
  l: ["1", "i"],
  o: ["0"],
  i: ["1", "l"],
  a: ["4", "@"],
  e: ["3"],
  s: ["5", "$"],
};

/** Distinctive keyword → generic for the rest of the run after this many rows. */
export const NRD_KEYWORD_DEMOTE_AFTER = 100;

/** Shortest keyword (hyphens ignored) that can match at all. */
const MIN_KEYWORD_LEN = 3;

/** Keywords of this length or shorter are generic. */
const GENERIC_MAX_LEN = 4;

export interface BrandKeywordSpec {
  /** Lowercase [a-z0-9-], no leading/trailing hyphen. */
  keyword: string;
  generic: boolean;
}

export interface BrandMatchEntry {
  id: string;
  /** Lowercased canonical domain — never matched for this brand. */
  domain: string;
  keywords: BrandKeywordSpec[];
}

export function isGenericKeyword(keyword: string): boolean {
  const flat = keyword.replace(/-/g, "");
  return flat.length <= GENERIC_MAX_LEN || GENERIC_KEYWORDS.has(flat);
}

/**
 * Labels of `domain` left of its public suffix (approximation: the last
 * label, or the last two for `<2-letter-sld-word>.<cc>` such as co.uk /
 * com.au / gov.uk). `paypal.com` → ["paypal"], `x.co.uk` → ["x"],
 * `a.b.com` → ["a", "b"].
 */
export function registrableLabels(domain: string): string[] {
  const labels = domain.split("/")[0]!.split(".").filter((l) => l !== "");
  const n = labels.length;
  if (n >= 3 && CC_SECOND_LEVEL.has(labels[n - 2]!) && labels[n - 1]!.length === 2) return labels.slice(0, -2);
  return labels.slice(0, -1);
}

function foldName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['’]/g, "");
}

/**
 * Keywords for one brand (see module header). Exported for tests.
 */
export function brandKeywords(name: string, canonicalDomain: string): BrandKeywordSpec[] {
  const folded = foldName(name);
  const candidates: Array<{ keyword: string; fromName: boolean }> = [];
  candidates.push({ keyword: folded.replace(/[^a-z0-9]/g, ""), fromName: true });
  const words = folded.split(/[^a-z0-9]+/).filter((w) => w !== "");
  if (words.length > 1 && words.every((w) => w.length >= 2)) {
    candidates.push({ keyword: words.join("-"), fromName: true });
  }
  const canonical = canonicalDomain.trim().toLowerCase();
  if (!canonical.includes("/")) {
    const core = registrableLabels(canonical);
    if (core.length === 1) {
      const label = core[0]!.replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
      candidates.push({ keyword: label, fromName: false });
    }
  }

  const out: BrandKeywordSpec[] = [];
  for (const { keyword, fromName } of candidates) {
    const flat = keyword.replace(/-/g, "");
    if (flat.length < MIN_KEYWORD_LEN || NEVER_KEYWORDS.has(flat)) continue;
    const generic = isGenericKeyword(keyword);
    // A domain-derived keyword adds value only when distinctive (zellepay
    // for "Zelle"): a generic canonical label (cat.com, key.com, revenue.ie)
    // would just reintroduce dictionary noise under a misleading brand.
    if (generic && !fromName) continue;
    if (out.some((k) => k.keyword === keyword)) continue;
    out.push({ keyword, generic });
  }
  return out;
}

/**
 * Brand rows (as loaded from D1) → matcher input, deduped by brand id in load
 * order (a brand monitored by several tenants appears once per
 * monitored_brands row). Brands with no usable keyword are dropped.
 */
export function buildBrandKeywords(
  rows: Array<{ id: string; name: string; canonical_domain: string }>,
): BrandMatchEntry[] {
  const seen = new Set<string>();
  const out: BrandMatchEntry[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const keywords = brandKeywords(r.name ?? "", r.canonical_domain ?? "");
    if (keywords.length === 0) continue;
    out.push({ id: r.id, domain: (r.canonical_domain ?? "").toLowerCase(), keywords });
  }
  return out;
}

/** The keyword followed by its single-substitution homoglyph variants. */
function homoglyphVariants(keyword: string): string[] {
  const out = [keyword];
  for (let i = 0; i < keyword.length; i++) {
    for (const sub of HOMOGLYPHS[keyword[i]!] ?? []) {
      out.push(keyword.slice(0, i) + sub + keyword.slice(i + 1));
    }
  }
  return out;
}

// ─── Segment decomposition ──────────────────────────────────────────

const ALL_WORDS: ReadonlySet<string> = new Set([...STRONG_WORDS, ...WEAK_WORDS]);
const ALL_WORD_LENGTHS = [...new Set([...ALL_WORDS].map((w) => w.length))].sort((a, b) => a - b);
const STRONG_WORD_LENGTHS = [...new Set([...STRONG_WORDS].map((w) => w.length))].sort((a, b) => a - b);

/** Bit flags per prefix/suffix position. */
const DECOMPOSES = 1;
const HAS_STRONG = 2;

interface Decomposition {
  /** pre[j]: flags for seg[0, j). */
  pre: Uint8Array;
  /** suf[j]: flags for seg[j, len). */
  suf: Uint8Array;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/**
 * Which prefixes/suffixes of `seg` are a concatenation of `vocab` words and
 * digit runs, and whether that concatenation contains a STRONG word.
 */
function decompose(seg: string, vocab: ReadonlySet<string>, lengths: number[]): Decomposition {
  const n = seg.length;
  const pre = new Uint8Array(n + 1);
  const suf = new Uint8Array(n + 1);
  pre[0] = DECOMPOSES;
  for (let j = 1; j <= n; j++) {
    let f = 0;
    if (isDigit(seg.charCodeAt(j - 1)) && pre[j - 1]! & DECOMPOSES) f |= pre[j - 1]!;
    for (const L of lengths) {
      if (L > j) break;
      const p = pre[j - L]!;
      if (!(p & DECOMPOSES)) continue;
      const w = seg.substring(j - L, j);
      if (!vocab.has(w)) continue;
      f |= DECOMPOSES | (p & HAS_STRONG) | (STRONG_WORDS.has(w) ? HAS_STRONG : 0);
    }
    pre[j] = f;
  }
  suf[n] = DECOMPOSES;
  for (let j = n - 1; j >= 0; j--) {
    let f = 0;
    if (isDigit(seg.charCodeAt(j)) && suf[j + 1]! & DECOMPOSES) f |= suf[j + 1]!;
    for (const L of lengths) {
      if (j + L > n) break;
      const s = suf[j + L]!;
      if (!(s & DECOMPOSES)) continue;
      const w = seg.substring(j, j + L);
      if (!vocab.has(w)) continue;
      f |= DECOMPOSES | (s & HAS_STRONG) | (STRONG_WORDS.has(w) ? HAS_STRONG : 0);
    }
    suf[j] = f;
  }
  return { pre, suf };
}

/** One domain's registrable part, split into '-'/'.'-delimited segments; decompositions computed lazily. */
class SegmentedDomain {
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  /** Segment index of each character position (delimiters: -1). */
  readonly segOf: Int16Array;
  private readonly weak: Array<Decomposition | undefined> = [];
  private readonly strong: Array<Decomposition | undefined> = [];

  constructor(readonly core: string) {
    this.segOf = new Int16Array(core.length);
    let start = 0;
    for (let i = 0; i <= core.length; i++) {
      const c = i < core.length ? core[i] : ".";
      if (c === "-" || c === ".") {
        if (i > start) {
          const s = this.starts.length;
          this.starts.push(start);
          this.ends.push(i);
          for (let k = start; k < i; k++) this.segOf[k] = s;
        }
        if (i < core.length) this.segOf[i] = -1;
        start = i + 1;
      }
    }
  }

  private seg(s: number): string {
    return this.core.substring(this.starts[s]!, this.ends[s]!);
  }

  /** Decomposition over STRONG ∪ WEAK (distinctive keywords). */
  weakOf(s: number): Decomposition {
    return (this.weak[s] ??= decompose(this.seg(s), ALL_WORDS, ALL_WORD_LENGTHS));
  }

  /** Decomposition over STRONG only (generic keywords). */
  strongOf(s: number): Decomposition {
    return (this.strong[s] ??= decompose(this.seg(s), STRONG_WORDS, STRONG_WORD_LENGTHS));
  }

  /** Segment `s` is made only of STRONG words/digits and contains one. */
  isStrongContext(s: number): boolean {
    if (s < 0 || s >= this.starts.length) return false;
    const len = this.ends[s]! - this.starts[s]!;
    return (this.strongOf(s).pre[len]! & HAS_STRONG) !== 0;
  }
}

// ─── Matcher ────────────────────────────────────────────────────────

interface NeedleEntry {
  bi: number;
  /** Global keyword index. */
  kw: number;
}

export interface BrandMatcherOptions {
  /** Override NRD_KEYWORD_DEMOTE_AFTER (tests). */
  demoteAfter?: number;
}

/**
 * Needle-indexed matcher. Holds per-run state (keyword demotion), so the
 * feed builds one per run and calls `collect` once per flush.
 */
export class BrandMatcher {
  private readonly index = new Map<string, NeedleEntry[]>();
  private readonly lengths: number[];
  private readonly kwText: string[] = [];
  private readonly kwGeneric: boolean[] = [];
  /** Distinctive-path rows this run, by keyword TEXT (brands sharing a keyword share the count). */
  private readonly rowsByKeyword = new Map<string, number>();
  private readonly demoteAfter: number;
  private readonly demoted: string[] = [];

  constructor(private readonly brands: BrandMatchEntry[], opts: BrandMatcherOptions = {}) {
    this.demoteAfter = opts.demoteAfter ?? NRD_KEYWORD_DEMOTE_AFTER;
    const lengths = new Set<number>();
    brands.forEach((b, bi) => {
      for (const k of b.keywords) {
        const flat = k.keyword.replace(/-/g, "");
        if (flat.length < MIN_KEYWORD_LEN || k.keyword.startsWith("-") || k.keyword.endsWith("-")) continue;
        const kw = this.kwText.length;
        this.kwText.push(k.keyword);
        this.kwGeneric.push(k.generic);
        const needles = k.generic ? [k.keyword] : homoglyphVariants(k.keyword);
        for (const n of needles) {
          let list = this.index.get(n);
          if (!list) { list = []; this.index.set(n, list); }
          // Brands are visited in ascending order, so lists stay sorted by bi.
          list.push({ bi, kw });
          lengths.add(n.length);
        }
      }
    });
    this.lengths = [...lengths].sort((a, b) => a - b);
  }

  get empty(): boolean {
    return this.index.size === 0;
  }

  /** Keywords demoted to generic this run, in demotion order. */
  demotedKeywords(): string[] {
    return [...this.demoted];
  }

  /** Winning brand + keyword for `domain`, or null. */
  private best(domain: string): { bi: number; kw: number } | null {
    const core = registrableLabels(domain).join(".");
    if (core === "") return null;

    let segmented: SegmentedDomain | null = null;
    let bestBi = Number.MAX_SAFE_INTEGER;
    let bestKw = -1;
    for (const len of this.lengths) {
      if (len > core.length) break;
      for (let i = 0; i + len <= core.length; i++) {
        const list = this.index.get(core.substring(i, i + len));
        if (!list || list[0]!.bi >= bestBi) continue;
        segmented ??= new SegmentedDomain(core);
        for (const e of list) {
          if (e.bi >= bestBi) break;
          if (this.brands[e.bi]!.domain === domain) continue;
          if (this.qualifies(segmented, i, i + len, this.isGeneric(e.kw))) {
            bestBi = e.bi;
            bestKw = e.kw;
            break;
          }
        }
        if (bestBi === 0) return { bi: 0, kw: bestKw };
      }
    }
    return bestKw < 0 ? null : { bi: bestBi, kw: bestKw };
  }

  private isGeneric(kw: number): boolean {
    return this.kwGeneric[kw]! || (this.rowsByKeyword.get(this.kwText[kw]!) ?? 0) >= this.demoteAfter;
  }

  /** Occurrence core[i, j) is a delimited/lure-concatenated token (module header). */
  private qualifies(d: SegmentedDomain, i: number, j: number, generic: boolean): boolean {
    const si = d.segOf[i]!;
    const sj = d.segOf[j - 1]!;
    if (si < 0 || sj < 0) return false; // needle starts/ends on a delimiter
    const pi = i - d.starts[si]!;
    const pj = j - d.starts[sj]!;
    const left = generic ? d.strongOf(si) : d.weakOf(si);
    const right = generic ? d.strongOf(sj) : d.weakOf(sj);
    const l = left.pre[pi]!;
    const r = right.suf[pj]!;
    if (!(l & DECOMPOSES) || !(r & DECOMPOSES)) return false;
    if (!generic) return true;
    return (l & HAS_STRONG) !== 0 || (r & HAS_STRONG) !== 0
      || d.isStrongContext(si - 1) || d.isStrongContext(sj + 1);
  }

  collect(domains: string[], matched: Set<string>): { rows: ThreatRow[]; inPayloadDuplicates: number } {
    const rows: ThreatRow[] = [];
    let inPayloadDuplicates = 0;
    for (const domain of domains) {
      const hit = this.best(domain);
      if (!hit) continue;
      if (matched.has(domain)) { inPayloadDuplicates++; continue; }
      matched.add(domain);
      if (!this.kwGeneric[hit.kw]) {
        // Count rows of initially-distinctive keywords; demote at the
        // threshold. Keyed by text so a second brand sharing the keyword
        // (two "Whatsapp" rows) can't pick up what the first was demoted on.
        const text = this.kwText[hit.kw]!;
        const n = (this.rowsByKeyword.get(text) ?? 0) + 1;
        this.rowsByKeyword.set(text, n);
        if (n === this.demoteAfter) this.demoted.push(text);
      }
      rows.push({
        id: threatId("nrd_hagezi", "domain", domain),
        source_feed: "nrd_hagezi",
        threat_type: "typosquatting",
        malicious_url: null,
        malicious_domain: domain,
        target_brand_id: this.brands[hit.bi]!.id,
        ioc_value: domain,
        severity: "medium",
        confidence_score: 60,
      });
    }
    return { rows, inPayloadDuplicates };
  }
}

/**
 * Pure domain × brand match pass — no I/O. One row per distinct matched
 * domain: the FIRST brand (in `brands` order) with a qualifying keyword
 * occurrence wins, a brand's own canonical domain never matches that brand,
 * and a domain repeated in the list counts as an in-payload duplicate. Pass
 * `matched` to carry the seen-set across chunks (keyword demotion state does
 * NOT carry across calls — the feed uses one BrandMatcher per run).
 */
export function collectBrandMatchRows(
  domains: string[],
  brands: BrandMatchEntry[],
  matched: Set<string> = new Set<string>(),
  opts: BrandMatcherOptions = {},
): { rows: ThreatRow[]; inPayloadDuplicates: number } {
  return new BrandMatcher(brands, opts).collect(domains, matched);
}
