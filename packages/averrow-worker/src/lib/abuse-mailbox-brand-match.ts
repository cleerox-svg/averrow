// Brand matching for abuse-mailbox submissions (PR-BA).
//
// Returns the monitored brand that an inbound abuse-mailbox submission
// most likely impersonates, along with the signal that triggered the
// match. Stamped onto `abuse_inbox_messages.brand_id` at intake so the
// classifier's promotion step carries the brand through to
// `target_brand_id` on every promoted `threats` row.
//
// Without this, abuse-mailbox-sourced threats land in the global
// threats table with `target_brand_id=NULL` and never appear in the
// impersonated brand's threat aggregate. Tenants monitoring "McAfee"
// see PhishTank and CertStream hits but miss the user-reported one.
//
// ── Signals (highest confidence first) ──────────────────────────
//
//   1. URL-domain exact match against a monitored brand's
//      canonical_domain (counter-intuitive but possible: phisher
//      reuses the real brand domain in a URL via open redirect /
//      typo'd subdomain).
//   2. URL-domain typosquat: a homoglyph or single-edit variant of
//      a canonical domain. Strongest signal — typosquats of a
//      monitored brand are almost always impersonation.
//   3. From-domain typosquat: same machinery applied to the inner
//      `From:` address's domain. Catches "notify@mcafee-secure-
//      update.example" → McAfee.
//   4. Subject substring match: brand name (≥4 chars, normalised
//      a-z0-9) appearing in the inner Subject. Common phishing
//      lures call out the impersonated brand by name.
//   5. Body substring match: same applied to the first ~1500 chars
//      of the inner body.
//
// We try them in order and return the first hit. Confidence labels
// surface to the classifier prompt so Haiku can weight its verdict
// (e.g., URL-typosquat is much stronger evidence than body keyword).

import type { Env } from "../types";

const HOMOGLYPHS: Record<string, string[]> = {
  l: ["1", "i"],
  o: ["0"],
  i: ["1", "l"],
  a: ["4", "@"],
  e: ["3"],
  s: ["5", "$"],
};

const MIN_KEYWORD_LEN = 4;
const BODY_SCAN_MAX   = 1500;

export interface MonitoredBrandRow {
  /** brands.id (also brands.brand_id alias depending on caller). */
  id:               string;
  name:             string;
  canonical_domain: string;
}

export type BrandMatchSignal =
  | "url_domain_exact"
  | "url_domain_typosquat"
  | "from_domain_exact"
  | "from_domain_typosquat"
  | "subject_keyword"
  | "body_keyword";

export interface BrandMatch {
  brand_id:  string;
  brand_name: string;
  signal:    BrandMatchSignal;
  /** The exact string that matched (for forensic logging). */
  matched_on: string;
  /** 0-100. URL exact = 95, URL typosquat = 90, From typosquat = 85,
   *  subject = 65, body = 50. */
  confidence: number;
}

export interface BrandMatchInput {
  from_domain:   string | null;
  subject:       string | null;
  body_snippet:  string | null;
  url_domains:   ReadonlyArray<string | null>;
}

/**
 * Loads the active monitored-brand catalog. Cheap — JOIN brands ×
 * monitored_brands. Caches on a per-tick basis are the caller's
 * responsibility (the abuse-mailbox handler queries once per
 * inbound message).
 *
 * For PUBLIC alias submissions (`org_id` is Averrow's house org),
 * we want EVERY monitored brand across all orgs so community
 * reports get matched too. For TENANT alias submissions, we'd
 * still match against the same global catalog because the
 * promoted threat is platform-wide intel; a tenant reporting a
 * brand they don't subscribe to but someone else does is still
 * valid signal. Keep this simple: one query, no per-org scoping.
 */
export async function loadMonitoredBrands(env: Env): Promise<MonitoredBrandRow[]> {
  const res = await env.DB.prepare(`
    SELECT DISTINCT b.id AS id, b.name AS name, b.canonical_domain AS canonical_domain
    FROM brands b
    INNER JOIN monitored_brands mb ON mb.brand_id = b.id
    WHERE mb.status = 'active'
      AND b.canonical_domain IS NOT NULL
      AND b.canonical_domain != ''
  `).all<MonitoredBrandRow>();
  return res.results.filter((b) => b.name && b.canonical_domain);
}

/** Normalize for substring matching: a-z0-9 only, lowercased. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Generate homoglyph variants of a keyword (single-char substitutions). */
function homoglyphVariants(keyword: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < keyword.length; i++) {
    const ch = keyword[i]!;
    const subs = HOMOGLYPHS[ch];
    if (!subs) continue;
    for (const sub of subs) {
      out.push(keyword.slice(0, i) + sub + keyword.slice(i + 1));
    }
  }
  return out;
}

/**
 * Best-match brand for an abuse-mailbox submission. Returns null if
 * none of the signals fire above the noise floor.
 *
 * Pure function — no I/O. Caller passes in the pre-loaded brand
 * catalog so this can be unit-tested in isolation.
 */
export function matchAbuseMailboxBrand(
  input: BrandMatchInput,
  brands: ReadonlyArray<MonitoredBrandRow>,
): BrandMatch | null {
  if (brands.length === 0) return null;

  // Pre-normalize once.
  const brandIndex = brands.map((b) => ({
    id:                b.id,
    name:              b.name,
    canonical_domain:  b.canonical_domain.toLowerCase(),
    keyword:           normalize(b.name),
  })).filter((b) => b.keyword.length >= MIN_KEYWORD_LEN && b.canonical_domain.includes("."));

  // ── 1 & 2: URL-domain signals ────────────────────────────────
  for (const rawDomain of input.url_domains) {
    if (!rawDomain) continue;
    const dom = rawDomain.toLowerCase();
    for (const b of brandIndex) {
      // Exact / subdomain of the canonical → high confidence.
      if (dom === b.canonical_domain || dom.endsWith("." + b.canonical_domain)) {
        return {
          brand_id:   b.id,
          brand_name: b.name,
          signal:     "url_domain_exact",
          matched_on: dom,
          confidence: 95,
        };
      }
    }
  }
  for (const rawDomain of input.url_domains) {
    if (!rawDomain) continue;
    const dom = rawDomain.toLowerCase();
    const sld = sldLabel(dom);
    for (const b of brandIndex) {
      if (isTyposquatOf(sld, b.canonical_domain)) {
        return {
          brand_id:   b.id,
          brand_name: b.name,
          signal:     "url_domain_typosquat",
          matched_on: dom,
          confidence: 90,
        };
      }
    }
  }

  // ── 3: From-domain ──────────────────────────────────────────
  const fromDom = input.from_domain?.toLowerCase() ?? null;
  if (fromDom) {
    for (const b of brandIndex) {
      if (fromDom === b.canonical_domain || fromDom.endsWith("." + b.canonical_domain)) {
        return {
          brand_id:   b.id,
          brand_name: b.name,
          signal:     "from_domain_exact",
          matched_on: fromDom,
          confidence: 95,
        };
      }
    }
    const fromSld = sldLabel(fromDom);
    for (const b of brandIndex) {
      if (isTyposquatOf(fromSld, b.canonical_domain)) {
        return {
          brand_id:   b.id,
          brand_name: b.name,
          signal:     "from_domain_typosquat",
          matched_on: fromDom,
          confidence: 85,
        };
      }
    }
  }

  // ── 4: Subject keyword ──────────────────────────────────────
  const subjectNorm = input.subject ? normalize(input.subject) : "";
  if (subjectNorm.length >= MIN_KEYWORD_LEN) {
    for (const b of brandIndex) {
      if (subjectNorm.includes(b.keyword)) {
        return {
          brand_id:   b.id,
          brand_name: b.name,
          signal:     "subject_keyword",
          matched_on: input.subject ?? "",
          confidence: 65,
        };
      }
    }
  }

  // ── 5: Body keyword ─────────────────────────────────────────
  if (input.body_snippet) {
    const bodyNorm = normalize(input.body_snippet.slice(0, BODY_SCAN_MAX));
    if (bodyNorm.length >= MIN_KEYWORD_LEN) {
      for (const b of brandIndex) {
        if (bodyNorm.includes(b.keyword)) {
          return {
            brand_id:   b.id,
            brand_name: b.name,
            signal:     "body_keyword",
            matched_on: input.body_snippet.slice(0, 80),
            confidence: 50,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Extract the SLD label (the leftmost dotted-segment of the
 * "registrable domain"). Approximate — we don't ship a PSL, so we
 * take the second-to-last label for two-label domains and the
 * second-to-last for three+ assuming a single-label TLD. Good
 * enough for typosquat detection where the SLD itself is the
 * impersonation surface.
 */
function sldLabel(domain: string): string {
  const parts = domain.split(".");
  if (parts.length < 2) return domain;
  // For "mcafee-secure-update.example" → "mcafee-secure-update"
  // For "login.mcafee-secure-update.example" → "mcafee-secure-update"
  return parts[parts.length - 2] ?? domain;
}

/** Canonical domain's SLD for comparison. */
function canonicalSld(canonical: string): string {
  return sldLabel(canonical);
}

/**
 * Is `candidate` a likely typosquat of `canonical`? Compared at the
 * SLD level (the part most users actually look at). Checks:
 *
 *   1. Homoglyph substitution: any single-char swap from the
 *      HOMOGLYPHS table that turns canonical's SLD into candidate.
 *   2. Containment with extra characters: candidate SLD contains
 *      canonical SLD as a substring AND is at most 2× longer (e.g.,
 *      "mcafee-secure-update" contains "mcafee"). Catches the
 *      hyphenated-suffix pattern.
 *   3. Levenshtein-1: single character edit away. Conservative —
 *      only matched when both SLDs are ≥6 chars to avoid noise on
 *      common short words.
 */
export function isTyposquatOf(candidateSld: string, canonical: string): boolean {
  const canSld = canonicalSld(canonical);
  if (!canSld || canSld.length < MIN_KEYWORD_LEN) return false;
  if (candidateSld === canSld) return false; // exact = handled by exact path
  if (canonical === candidateSld) return false;

  // (1) Homoglyph
  for (const variant of homoglyphVariants(canSld)) {
    if (candidateSld === variant) return true;
  }
  // (2) Hyphenated containment: candidate contains canonical's SLD
  if (candidateSld.length >= canSld.length + 2 &&
      candidateSld.length <= canSld.length * 2 + 20 &&
      candidateSld.includes(canSld)) {
    return true;
  }
  // (3) Single-edit distance for ≥6-char SLDs
  if (canSld.length >= 6 && levenshteinAtMost1(candidateSld, canSld)) {
    return true;
  }
  return false;
}

/** True iff edit distance ≤ 1 (insertion/deletion/substitution). */
function levenshteinAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  // Substitution
  if (la === lb) {
    let diffs = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diffs++;
        if (diffs > 1) return false;
      }
    }
    return diffs === 1;
  }
  // Insertion / deletion — make a the shorter one
  const [shorter, longer] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] !== longer[j]) {
      edits++;
      if (edits > 1) return false;
      j++;
    } else {
      i++; j++;
    }
  }
  return true;
}
