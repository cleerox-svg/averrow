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
 * Measured numbers are in docs/THREAT_FEEDS.md (NRD section).
 *
 * ── Keywords (buildBrandKeywords) ──
 * Brands are ordered by id (the deterministic tie-break, below). Per brand,
 * up to three keywords, deduped:
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
 * booking, apple, amazon, office, revenue, ...), or itself a STRONG/WEAK
 * vocabulary word. Everything else is DISTINCTIVE. No embedded dictionary:
 * the stop-list only has to cover words that are, or are likely to become, a
 * monitored brand's keyword, and the runtime demotion below catches the rest.
 *
 * ── Needles (keywordNeedles) ──
 *   * DISTINCTIVE keyword: the keyword + every single-character homoglyph
 *     variant (l↔1/i, o→0, i↔1/l, a→4/@, e→3, s→5/$), all distinctive.
 *   * GENERIC keyword: the keyword itself, generic. If it is ≥5 chars, ALSO
 *     its digit/symbol-only variants (o→0, l/i→1, a→4/@, e→3, s→5/$ — no
 *     l↔i letter swap) as DISTINCTIVE needles: a dictionary word with a digit
 *     swapped in (`amaz0n`, `app1e`, `0utlook`, `dr0pbox`) is itself the
 *     impersonation signal. Such a variant must not touch another digit
 *     (`merak123.world` is not `meraki`).
 *
 * ── Matching (per domain) ──
 * The domain's registrable part (public suffix dropped: last label, or last
 * two for `co.uk`-style ccSLDs) is split into SEGMENTS on '-' and '.'. A
 * needle occurrence counts only if the rest of its segment(s) decomposes
 * entirely into vocabulary words and digit runs — i.e. the keyword is a
 * delimited token or is concatenated with lure/glue words, never embedded
 * inside an arbitrary word:
 *   * DISTINCTIVE needle: the rest of its segment ∈ (STRONG ∪ WEAK ∪ digits)*.
 *     `paypal.to`, `coinbase66.com`, `mygoogle.me`, `coinbasevalidate.com`,
 *     `docsharepoint.top`, `amaz0n-login.com` match; `canvashouse.uk`,
 *     `betonline.com` (T Online), `bahiahondastatepark.com` do not.
 *   * GENERIC needle: the rest of its segment ∈ (STRONG ∪ GLUE ∪ digits)*,
 *     AND a STRONG word is present — in that segment, or in the nearest
 *     non-GLUE segment on either side, provided that segment is made only of
 *     STRONG/GLUE words and digits (GLUE-only segments such as `com`, `www`,
 *     `id`, `prime`, `24` are transparent). `att-login.com`, `dhlpayment.net`,
 *     `att.com-login.net`, `apple-id-verify.com`, `myamazon-account.com`,
 *     `amazon-prime-login.com` match; `line-store.com`, `onlineline.hair`,
 *     `frontier-era-security.com` do not.
 * STRONG = phishing/parcel-scam action words (login, verify, secure, wallet,
 * refund, billing, support, tracking, parcel, redelivery, customs, ...).
 * WEAK = neutral glue allowed next to a distinctive needle (my, official,
 * app, web, doc, share, ...). GLUE = the few WEAK words that may also sit
 * next to a GENERIC keyword (my, id, pay, prime, www, com) — never enough on
 * their own.
 *
 * ── Winner (deterministic, order-independent of D1) ──
 * Among qualifying occurrences of all brands: the LONGEST needle wins
 * (`amazonaws-login` → Amazonaws, not Amazon), ties go to the LOWEST brand
 * index — brands are sorted by id, so the lowest brand id. A brand never
 * matches its own canonical domain (another brand may). One row per distinct
 * domain; in-list repeats are in-payload duplicates; same ThreatRow fields.
 *
 * ── Runtime demotion (the measured hit-rate rule) ──
 * A BRAND that has produced `demoteAfter` (default NRD_KEYWORD_DEMOTE_AFTER =
 * 100) rows in ONE run through distinctive needles has all its keyword texts
 * demoted for the rest of that run: every needle of those texts (the keyword
 * and its homoglyph variants, for every brand sharing the text) is then
 * matched under the GENERIC rule, i.e. still matches, but only with a STRONG
 * word. Reported by `demotedKeywords()` (logged as
 * `nrd_hagezi_keywords_demoted` — add them to GENERIC_KEYWORDS). The busiest
 * brand on a measured day had ~30 rows, so this only fires on an
 * unanticipated dictionary word (a new brand called "Home"), capping its
 * distinctive-path flood at 100 rows per brand per run. Deterministic: the
 * list is processed in byte-sorted order, so a retry demotes at the same
 * domain.
 *
 * Cost: needle lookups are a Map probe per (position × distinct needle
 * length), independent of brand count; the segment decomposition only runs
 * for domains with a raw needle hit and is O(length × vocabulary word
 * lengths). ~2 s per 443K domains.
 */

/** Phishing / parcel-scam action words: what makes a GENERIC keyword count. */
export const STRONG_WORDS: ReadonlySet<string> = new Set([
  "login", "logon", "signin", "signon", "secure", "security", "verify", "verification", "verified",
  "account", "accounts", "acct", "auth", "authenticate", "authentication", "password", "passwd",
  "unlock", "unlocked", "recovery", "recover", "reset", "confirm", "confirmation", "validate",
  "validation", "suspended", "suspend", "locked", "limited", "kyc", "sso", "mfa", "2fa", "otp",
  "wallet", "refund", "refunds", "billing", "invoice", "payment", "payments", "helpdesk", "support",
  "customerservice", "airdrop", "claim", "update", "updates", "alert", "alerts", "notice",
  "notification", "restore",
  // parcel smishing lures ("toll"/"package" left out: TollBit, software
  // packages — measured false positives on the real list)
  "tracking", "parcel", "parcels", "delivery", "redelivery", "redeliver", "shipment", "customs",
]);

/** Glue that may also sit next to a GENERIC keyword (and is transparent between segments). */
export const GLUE_WORDS: ReadonlySet<string> = new Set(["my", "id", "pay", "prime", "www", "com"]);

/** Neutral glue words: allowed next to a DISTINCTIVE needle, never sufficient for a generic one. */
export const WEAK_WORDS: ReadonlySet<string> = new Set([
  ...GLUE_WORDS,
  "the", "get", "go", "official", "online", "web", "mobile", "app", "apps",
  "access", "connect", "portal", "center", "centre", "team", "desk", "help", "service", "services",
  "customer", "care", "bank", "banking", "card", "cards", "mail", "webmail", "inbox", "store",
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

/** Homoglyph substitutions for DISTINCTIVE keywords. */
const HOMOGLYPHS: Record<string, string[]> = {
  l: ["1", "i"],
  o: ["0"],
  i: ["1", "l"],
  a: ["4", "@"],
  e: ["3"],
  s: ["5", "$"],
};

/** Digit/symbol-only substitutions (no letter swaps) for ≥5-char GENERIC keywords. */
const DIGIT_HOMOGLYPHS: Record<string, string[]> = {
  l: ["1"],
  o: ["0"],
  i: ["1"],
  a: ["4", "@"],
  e: ["3"],
  s: ["5", "$"],
};

/** Brand → its keywords matched as generic for the rest of the run after this many distinctive-path rows. */
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
  return flat.length <= GENERIC_MAX_LEN || GENERIC_KEYWORDS.has(flat)
    || STRONG_WORDS.has(flat) || WEAK_WORDS.has(flat);
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
 * Brand rows (as loaded from D1) → matcher input: sorted by id (so the
 * lowest-id tie-break never depends on D1 row order), deduped by id (a brand
 * monitored by several tenants appears once per monitored_brands row).
 * Brands with no usable keyword are dropped.
 */
export function buildBrandKeywords(
  rows: Array<{ id: string; name: string; canonical_domain: string }>,
): BrandMatchEntry[] {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  const out: BrandMatchEntry[] = [];
  for (const r of sorted) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const keywords = brandKeywords(r.name ?? "", r.canonical_domain ?? "");
    if (keywords.length === 0) continue;
    out.push({ id: r.id, domain: (r.canonical_domain ?? "").toLowerCase(), keywords });
  }
  return out;
}

function substitutions(keyword: string, table: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (let i = 0; i < keyword.length; i++) {
    for (const sub of table[keyword[i]!] ?? []) out.push(keyword.slice(0, i) + sub + keyword.slice(i + 1));
  }
  return out;
}

/**
 * Every needle a keyword is matched by, with the rule each one uses
 * (module header, "Needles"). Exported for tests.
 */
export interface KeywordNeedle {
  needle: string;
  /** Matched under the GENERIC rule (else DISTINCTIVE). */
  generic: boolean;
  /** Digit/symbol variant of a generic keyword: must not touch another digit. */
  digitVariant: boolean;
}

export function keywordNeedles(spec: BrandKeywordSpec): KeywordNeedle[] {
  if (!spec.generic) {
    return [spec.keyword, ...substitutions(spec.keyword, HOMOGLYPHS)]
      .map((needle) => ({ needle, generic: false, digitVariant: false }));
  }
  const out: KeywordNeedle[] = [{ needle: spec.keyword, generic: true, digitVariant: false }];
  if (spec.keyword.replace(/-/g, "").length > GENERIC_MAX_LEN) {
    for (const needle of substitutions(spec.keyword, DIGIT_HOMOGLYPHS)) {
      out.push({ needle, generic: false, digitVariant: true });
    }
  }
  return out;
}

// ─── Segment decomposition ──────────────────────────────────────────

const DISTINCTIVE_VOCAB: ReadonlySet<string> = new Set([...STRONG_WORDS, ...WEAK_WORDS]);
const GENERIC_VOCAB: ReadonlySet<string> = new Set([...STRONG_WORDS, ...GLUE_WORDS]);
const lengthsOf = (s: ReadonlySet<string>) => [...new Set([...s].map((w) => w.length))].sort((a, b) => a - b);
const DISTINCTIVE_LENGTHS = lengthsOf(DISTINCTIVE_VOCAB);
const GENERIC_LENGTHS = lengthsOf(GENERIC_VOCAB);

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

/** core[i-1] or core[j] is a digit. */
function touchesDigit(core: string, i: number, j: number): boolean {
  return (i > 0 && isDigit(core.charCodeAt(i - 1))) || (j < core.length && isDigit(core.charCodeAt(j)));
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
  private readonly distinctive: Array<Decomposition | undefined> = [];
  private readonly generic: Array<Decomposition | undefined> = [];

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

  get count(): number {
    return this.starts.length;
  }

  private seg(s: number): string {
    return this.core.substring(this.starts[s]!, this.ends[s]!);
  }

  /** Decomposition over STRONG ∪ WEAK (distinctive needles). */
  distinctiveOf(s: number): Decomposition {
    return (this.distinctive[s] ??= decompose(this.seg(s), DISTINCTIVE_VOCAB, DISTINCTIVE_LENGTHS));
  }

  /** Decomposition over STRONG ∪ GLUE (generic needles). */
  genericOf(s: number): Decomposition {
    return (this.generic[s] ??= decompose(this.seg(s), GENERIC_VOCAB, GENERIC_LENGTHS));
  }

  /** Flags of segment `s` as a whole over STRONG ∪ GLUE ∪ digits. */
  wholeGeneric(s: number): number {
    return this.genericOf(s).pre[this.ends[s]! - this.starts[s]!]!;
  }

  /**
   * Walking from segment `from` in direction `step`, skip GLUE-only segments
   * (com, www, id, prime, digits); true when the first other segment is made
   * only of STRONG/GLUE words and digits and contains a STRONG word.
   */
  strongBeyond(from: number, step: 1 | -1): boolean {
    for (let t = from + step; t >= 0 && t < this.count; t += step) {
      const f = this.wholeGeneric(t);
      if (!(f & DECOMPOSES)) return false;
      if (f & HAS_STRONG) return true;
    }
    return false;
  }
}

// ─── Matcher ────────────────────────────────────────────────────────

interface NeedleEntry {
  bi: number;
  /** Index into the matcher's keyword-needle table. */
  kw: number;
}

export interface BrandMatcherOptions {
  /** Override NRD_KEYWORD_DEMOTE_AFTER (tests). */
  demoteAfter?: number;
}

/**
 * Needle-indexed matcher. Holds per-run state (brand demotion), so the feed
 * builds one per run and calls `collect` once per flush.
 */
export class BrandMatcher {
  private readonly index = new Map<string, NeedleEntry[]>();
  private readonly lengths: number[];
  /** Per needle group: the keyword TEXT it belongs to (demotion key) and its initial rule. */
  private readonly kwText: string[] = [];
  private readonly kwGeneric: boolean[] = [];
  private readonly kwDigitVariant: boolean[] = [];
  private readonly demoteAfter: number;
  /** Distinctive-path rows this run, per brand index. */
  private readonly rowsByBrand = new Map<number, number>();
  private readonly demotedTexts = new Set<string>();
  private readonly demoted: string[] = [];

  constructor(private readonly brands: BrandMatchEntry[], opts: BrandMatcherOptions = {}) {
    this.demoteAfter = opts.demoteAfter ?? NRD_KEYWORD_DEMOTE_AFTER;
    const lengths = new Set<number>();
    brands.forEach((b, bi) => {
      for (const k of b.keywords) {
        const flat = k.keyword.replace(/-/g, "");
        if (flat.length < MIN_KEYWORD_LEN || k.keyword.startsWith("-") || k.keyword.endsWith("-")) continue;
        // One table slot per (keyword, rule): a generic keyword's digit
        // variants get their own distinctive slot under the same text.
        const slots = new Map<boolean, number>();
        for (const { needle, generic, digitVariant } of keywordNeedles(k)) {
          let kw = slots.get(generic);
          if (kw === undefined) {
            kw = this.kwText.length;
            this.kwText.push(k.keyword);
            this.kwGeneric.push(generic);
            this.kwDigitVariant.push(digitVariant);
            slots.set(generic, kw);
          }
          let list = this.index.get(needle);
          if (!list) { list = []; this.index.set(needle, list); }
          // Brands are visited in ascending order, so lists stay sorted by bi.
          if (!list.some((e) => e.bi === bi && e.kw === kw)) list.push({ bi, kw });
          lengths.add(needle.length);
        }
      }
    });
    this.lengths = [...lengths].sort((a, b) => a - b);
  }

  get empty(): boolean {
    return this.index.size === 0;
  }

  /** Keyword texts demoted to generic this run, in demotion order. */
  demotedKeywords(): string[] {
    return [...this.demoted];
  }

  private isGeneric(kw: number): boolean {
    return this.kwGeneric[kw]! || this.demotedTexts.has(this.kwText[kw]!);
  }

  /** Winning brand + needle slot for `domain`, or null (module header, "Winner"). */
  best(domain: string): { bi: number; kw: number } | null {
    const core = registrableLabels(domain).join(".");
    if (core === "") return null;

    let segmented: SegmentedDomain | null = null;
    let bestLen = 0;
    let bestBi = Number.MAX_SAFE_INTEGER;
    let bestKw = -1;
    // Ascending lengths: a longer qualifying needle always beats a shorter one.
    for (const len of this.lengths) {
      if (len > core.length) break;
      for (let i = 0; i + len <= core.length; i++) {
        const list = this.index.get(core.substring(i, i + len));
        if (!list) continue;
        for (const e of list) {
          if (len === bestLen && e.bi >= bestBi) break; // sorted by bi: no better entry left
          if (this.brands[e.bi]!.domain === domain) continue;
          if (this.kwDigitVariant[e.kw] && touchesDigit(core, i, i + len)) continue;
          segmented ??= new SegmentedDomain(core);
          if (this.qualifies(segmented, i, i + len, this.isGeneric(e.kw))) {
            bestLen = len;
            bestBi = e.bi;
            bestKw = e.kw;
            break;
          }
        }
      }
    }
    return bestKw < 0 ? null : { bi: bestBi, kw: bestKw };
  }

  /** Occurrence core[i, j) is a delimited/lure-concatenated token (module header). */
  private qualifies(d: SegmentedDomain, i: number, j: number, generic: boolean): boolean {
    const si = d.segOf[i]!;
    const sj = d.segOf[j - 1]!;
    if (si < 0 || sj < 0) return false; // needle starts/ends on a delimiter
    const pi = i - d.starts[si]!;
    const pj = j - d.starts[sj]!;
    const l = (generic ? d.genericOf(si) : d.distinctiveOf(si)).pre[pi]!;
    const r = (generic ? d.genericOf(sj) : d.distinctiveOf(sj)).suf[pj]!;
    if (!(l & DECOMPOSES) || !(r & DECOMPOSES)) return false;
    if (!generic) return true;
    return (l & HAS_STRONG) !== 0 || (r & HAS_STRONG) !== 0 || d.strongBeyond(si, -1) || d.strongBeyond(sj, 1);
  }

  collect(domains: string[], matched: Set<string>): { rows: ThreatRow[]; inPayloadDuplicates: number } {
    const rows: ThreatRow[] = [];
    let inPayloadDuplicates = 0;
    for (const domain of domains) {
      const hit = this.best(domain);
      if (!hit) continue;
      if (matched.has(domain)) { inPayloadDuplicates++; continue; }
      matched.add(domain);
      if (!this.kwGeneric[hit.kw]) this.countDistinctiveRow(hit.bi);
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

  /**
   * Per-BRAND distinctive-path row count (so a brand with three keyword
   * spellings is still capped at `demoteAfter`). At the threshold every
   * keyword text of the brand is demoted — for every brand sharing that
   * text, so a duplicate brand row can't pick up the overflow.
   */
  private countDistinctiveRow(bi: number): void {
    const n = (this.rowsByBrand.get(bi) ?? 0) + 1;
    this.rowsByBrand.set(bi, n);
    if (n !== this.demoteAfter) return;
    for (const k of this.brands[bi]!.keywords) {
      if (this.demotedTexts.has(k.keyword)) continue;
      this.demotedTexts.add(k.keyword);
      this.demoted.push(k.keyword);
    }
  }
}

/**
 * Pure domain × brand match pass — no I/O. One row per distinct matched
 * domain (winner per the module header: longest needle, then lowest brand
 * index); a brand's own canonical domain never matches that brand; a domain
 * repeated in the list counts as an in-payload duplicate. Pass `matched` to
 * carry the seen-set across chunks (demotion state does NOT carry across
 * calls — the feed uses one BrandMatcher per run).
 */
export function collectBrandMatchRows(
  domains: string[],
  brands: BrandMatchEntry[],
  matched: Set<string> = new Set<string>(),
  opts: BrandMatcherOptions = {},
): { rows: ThreatRow[]; inPayloadDuplicates: number } {
  return new BrandMatcher(brands, opts).collect(domains, matched);
}
