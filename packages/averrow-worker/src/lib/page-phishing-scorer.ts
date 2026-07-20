/**
 * Deterministic page-content phishing scorer (S2.4 / D6 increment 1).
 *
 * PURE, unit-testable, NO I/O and NO AI. Takes the raw signals that
 * lib/page-fetch.ts extracts from a suspect page's HTML via HTMLRewriter
 * plus the impersonated brand's canonical context, and produces a
 * weighted 0-100 score + the array of fired signal keys — the same
 * shape/idea as lib/impersonation-scorer.ts.
 *
 * The scorer never does network, DB, or clock work; the fetcher hands it
 * everything it needs. Weights err toward the two strongest phishing
 * tells — a live credential form and a form that exfiltrates to an
 * off-domain endpoint — so a page combining them lands squarely in
 * HIGH/CRITICAL.
 *
 * Doctrine (CLAUDE.md §13): SQL/code does correlation, AI does narrative.
 * This whole signal is deterministic string comparison — zero tokens.
 */

import { registrableDomain } from './domain-utils';

/**
 * Raw signals extracted from the fetched HTML. The fetcher populates
 * these; the scorer decides. Kept deliberately flat and JSON-friendly.
 */
export interface ParsedPageSignals {
  /** Any <input type="password"> present. */
  hasPasswordInput: boolean;
  /** Raw <form action> values (may be relative, absolute, or empty). */
  formActions: string[];
  /** src/href of <img>/<script>/<link> resources (absolute or relative). */
  resourceUrls: string[];
  /** href of <link rel~="icon"> / shortcut-icon elements. */
  iconHrefs: string[];
  /** <meta http-equiv="refresh"> content attribute, if present. */
  metaRefresh: string | null;
  /** Targets of trivially-detectable JS redirects (location assignments). */
  scriptRedirectTargets: string[];
  /** <title> text (bounded length). */
  title: string;
  /** Bounded sample of body text for keyword-density scoring. */
  bodyTextSample: string;
}

/** Context describing the impersonated brand + the suspect's own host. */
export interface PageScoreContext {
  /** The suspect lookalike host itself (e.g. "acme-secure-login.com"). */
  suspectDomain: string;
  /** The impersonated brand's canonical domain (e.g. "acme.com"). */
  brandDomain: string | null;
  /** The impersonated brand's display name (e.g. "Acme Corp"). */
  brandName: string | null;
}

export interface PagePhishingResult {
  /** 0-100 weighted score. */
  score: number;
  /** Signal keys that fired, stable + machine-readable. */
  signals: string[];
  /**
   * True when the page is a credential-harvest page: a live password
   * field AND a form posting to an off-domain endpoint. This is the
   * flag the alert-triage guard consumes to withhold auto-dismissal.
   */
  credentialHarvest: boolean;
}

/** Signal weights. Sum can exceed 100; final score is capped. */
export const SIGNAL_WEIGHTS = {
  /** Form posts credentials to a different registrable domain — the
   *  single strongest tell. */
  offdomain_form_exfil: 45,
  /** A live password input exists. */
  credential_form: 30,
  /** Cloaking redirect to the real brand (meta-refresh or JS). */
  cloaking_redirect: 20,
  /** Real-brand assets hotlinked (logo/CSS/JS served from brand domain). */
  brand_asset_hotlink: 15,
  /** Favicon cloned from the real brand's domain. */
  favicon_clone: 12,
  /** Brand name / keyword density in <title> or body on a non-brand host. */
  title_keyword_density: 10,
} as const;

export type PageSignalKey = keyof typeof SIGNAL_WEIGHTS;

/**
 * Resolve a possibly-relative URL/href to a registrable domain, using
 * `base` (the suspect host) to anchor relative references. Returns null
 * when the reference is relative (same-origin) or unparseable.
 */
function refRegistrableDomain(ref: string, baseHost: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  // Protocol-relative //host/... — treat as absolute.
  let candidate = trimmed;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  try {
    // Absolute URL (has a scheme + host).
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return registrableDomain(u.hostname);
  } catch {
    // Relative reference (path, "#", "javascript:", "mailto:", data:,
    // "/foo", "foo.html"): same-origin as the suspect — not off-domain.
    void baseHost;
    return null;
  }
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack` using a
 * linear indexOf scan. No regex — cannot catastrophically backtrack on
 * attacker-controlled input.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Pure scorer. Given parsed page signals + brand context, returns the
 * weighted phishing score, the fired signal keys, and the
 * credential-harvest flag.
 */
export function scorePagePhishing(
  parsed: ParsedPageSignals,
  ctx: PageScoreContext,
): PagePhishingResult {
  const fired = new Set<PageSignalKey>();

  const suspectReg = registrableDomain(ctx.suspectDomain);
  const brandReg = ctx.brandDomain ? registrableDomain(ctx.brandDomain) : null;
  const suspectHost = ctx.suspectDomain.trim().toLowerCase();

  // 1. Credential form — any password input.
  if (parsed.hasPasswordInput) {
    fired.add('credential_form');
  }

  // 2. Off-domain form exfil — a form action whose registrable domain
  //    differs from the suspect's own. Relative actions (same origin)
  //    never count. STRONGEST single signal.
  const offDomainForm = parsed.formActions.some((action) => {
    const actionReg = refRegistrableDomain(action, suspectHost);
    return actionReg !== null && suspectReg !== null && actionReg !== suspectReg;
  });
  if (offDomainForm) fired.add('offdomain_form_exfil');

  // 3. Real-brand asset hotlinking — an img/script/link resource served
  //    from the impersonated brand's registrable domain.
  if (brandReg) {
    const hotlink = parsed.resourceUrls.some((url) => {
      const reg = refRegistrableDomain(url, suspectHost);
      return reg !== null && reg === brandReg;
    });
    if (hotlink) fired.add('brand_asset_hotlink');

    // 4. Favicon / logo cloning — <link rel=icon> pointing at the real
    //    brand's domain.
    const faviconClone = parsed.iconHrefs.some((href) => {
      const reg = refRegistrableDomain(href, suspectHost);
      return reg !== null && reg === brandReg;
    });
    if (faviconClone) fired.add('favicon_clone');
  }

  // 5. Title / keyword density — the brand name appears in <title> or is
  //    densely repeated in body text, on a host that is NOT the brand's
  //    own registrable domain.
  const onBrandDomain = brandReg !== null && suspectReg === brandReg;
  if (!onBrandDomain && ctx.brandName) {
    const name = ctx.brandName.trim().toLowerCase();
    if (name.length >= 2) {
      const titleHit = parsed.title.toLowerCase().includes(name);
      const bodyHits = countOccurrences(parsed.bodyTextSample.toLowerCase(), name);
      if (titleHit || bodyHits >= 3) fired.add('title_keyword_density');
    }
  }

  // 6. Cloaking redirect — meta-refresh or trivially-detectable JS
  //    redirect that targets the real brand's domain.
  if (brandReg) {
    const redirectTargets: string[] = [...parsed.scriptRedirectTargets];
    if (parsed.metaRefresh) {
      // meta refresh content: "5; url=https://acme.com/..." — pull the url.
      const lower = parsed.metaRefresh.toLowerCase();
      const marker = 'url=';
      const at = lower.indexOf(marker);
      if (at !== -1) redirectTargets.push(parsed.metaRefresh.slice(at + marker.length).trim());
    }
    const cloaking = redirectTargets.some((t) => {
      const reg = refRegistrableDomain(t, suspectHost);
      return reg !== null && reg === brandReg;
    });
    if (cloaking) fired.add('cloaking_redirect');
  }

  let score = 0;
  for (const key of fired) score += SIGNAL_WEIGHTS[key];
  score = Math.min(100, score);

  const credentialHarvest = fired.has('credential_form') && fired.has('offdomain_form_exfil');

  return {
    score,
    signals: Array.from(fired),
    credentialHarvest,
  };
}

/** Threat levels in monotonic order for escalation comparisons. */
export type PageThreatLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
const LEVEL_ORDER: Record<PageThreatLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/**
 * Pure, MONOTONIC threat-level escalation from a page result. Only ever
 * raises the level — never lowers an existing HIGH/CRITICAL. Mirrors the
 * has_mx/has_web/BIMI boosts already in checkLookalikeBatch, extended
 * with the page score:
 *   - credential-harvest page (password + off-domain exfil) -> CRITICAL
 *   - strong page score (>= 60)                             -> HIGH
 *   - moderate page score (>= 30)                           -> MEDIUM
 */
export function escalateThreatLevelForPage(
  current: PageThreatLevel,
  result: Pick<PagePhishingResult, 'score' | 'credentialHarvest'>,
): PageThreatLevel {
  let target: PageThreatLevel = current;
  if (result.credentialHarvest) target = 'CRITICAL';
  else if (result.score >= 60) target = 'HIGH';
  else if (result.score >= 30) target = 'MEDIUM';
  return LEVEL_ORDER[target] > LEVEL_ORDER[current] ? target : current;
}
