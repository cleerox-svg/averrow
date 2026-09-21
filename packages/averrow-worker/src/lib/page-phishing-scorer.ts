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
import { CHALLENGE_PHRASES } from './page-fetch';

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
  /**
   * Brand-agnostic anti-bot-wall family the fetcher detected
   * (`turnstile|recaptcha|hcaptcha|cf_challenge`), or null when none. The
   * brand-relative `js_challenge` family is NOT set here — it is resolved
   * in the scorer (needs brand context). See T4.1 spec §0.2 / §1.
   */
  antiBotWall: string | null;

  // ── Lane 3 (AI-build artifacts / exfil sinks) — SHADOW MODE ──────
  // Consumed ONLY by computeShadowPageSignals below. None of these
  // reaches `score`, `signals` or `credentialHarvest` in this phase.
  /**
   * Bounded sample of inline `<script>` text (40 KB cap) — the same
   * slice extractJsRedirectTargets already walks, now also surfaced for
   * the `llm_refusal_leakage` literal scan.
   */
  scriptTextSample: string;
  /**
   * Quoted literals following request-shaped script markers (`fetch(`,
   * `.open(`, `XMLHttpRequest`, `navigator.sendBeacon(`, `axios.post(`).
   * This is the surface `offdomain_form_exfil` cannot see.
   */
  scriptSinkTargets: string[];
  /**
   * Captured HTML comments, one entry per comment (bounded). An ARRAY,
   * not one blob: `agent_scaffold_comment` is scoped to a SINGLE comment
   * because the structure inside one comment is the signal.
   */
  commentSamples: string[];
  /** `<meta name="generator">` content, truncated to 64 chars, or null. */
  metaGenerator: string | null;
  /** Inline `<svg>` subtree containing `<script>`/`<foreignObject>`/an `on*` attr. */
  svgScriptPayload: boolean;
  /** `<a download="x.pdf">` whose href is a `data:image/svg+xml` URI. */
  svgDownloadDisguise: boolean;
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
  /**
   * Authoritative anti-bot-wall family (cloaking-as-signal, rec 4), or
   * null when no wall was detected. One of
   * `turnstile|recaptcha|hcaptcha|cf_challenge|js_challenge`. Reconciles
   * the fetcher's brand-agnostic `parsed.antiBotWall` with the
   * brand-relative `js_challenge` resolved here (js_challenge overrides a
   * fetcher cf_challenge in the overlap — T4.1 spec §1.5). Instrumentation
   * only: the single `anti_bot_wall` fired key scores identically for any
   * family. Persisted to lookalike_domains.page_anti_bot_wall for the
   * crawler blind-spot metric.
   */
  antiBotWallFamily: string | null;

  // ── Lane 3 SHADOW-MODE OUTPUT ────────────────────────────────────
  // Everything below is computed but NOT acted on. It is persisted to
  // lookalike_domains (migration 0264) so firing rates, lift and FP rate
  // can be measured before any of it is allowed to move an
  // operator-facing verdict (spec §5.1). Read by the diagnostics
  // `page_analysis.ai_build` / `.exfil` blocks and by nothing else.
  /** Shadow signal keys that fired (`ShadowSignalKey[]`). Never merged into `signals`. */
  aiSignals: string[];
  /** Would-be score contribution: min(20, Class A sum) + Class B + Class C. Never added to `score`. */
  scoreDelta: number;
  /** Fired key → matched literal, truncated to 64 chars (spec §5.5). */
  evidence: Record<string, string>;
  /** M1: `<meta name="generator">`, weight 0, grouping dimension only. */
  pageGenerator: string | null;
  /** M2: host of the covert/relay exfil sink that matched, or null. */
  exfilSink: string | null;
  /** M2: Telegram bot id / Discord webhook id from that sink — the pivot key. */
  exfilSinkId: string | null;
}

/** Signal weights. Sum can exceed 100; final score is capped. */
export const SIGNAL_WEIGHTS = {
  /** Form posts credentials to a different registrable domain — the
   *  single strongest tell. */
  offdomain_form_exfil: 45,
  /** A live password input exists. */
  credential_form: 30,
  /** Anti-bot wall gating a plain crawler (cloaking-as-signal, rec 4) —
   *  inferred evasion intent. Same evidentiary class/weight as
   *  cloaking_redirect (both hide the real payload). */
  anti_bot_wall: 20,
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

// NOTE: the Lane 3 shadow signals are deliberately NOT in the table
// above. They live in SHADOW_SIGNAL_WEIGHTS at the bottom of this file
// with their own key union, so this LIVE weight table — and therefore
// `score`, `signals` and `PageSignalKey` — is provably unchanged in
// Phase 1. Phase 2 promotion merges the promoted keys in here.

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

  // 7. Anti-bot wall (cloaking-as-signal, rec 4). Two surfaces reconcile
  //    into one authoritative 5-family label:
  //    (a) the fetcher's brand-agnostic `parsed.antiBotWall`
  //        (turnstile|recaptcha|hcaptcha|cf_challenge, or null), and
  //    (b) the brand-relative `js_challenge`, resolved here because it
  //        needs `brandReg`.
  //    `js_challenge` is the exact inverse of `cloaking_redirect`: a
  //    trivially-detectable JS redirect to a NON-brand domain (vs
  //    cloaking_redirect's bounce TO the brand) — mutually exclusive on a
  //    given target — combined with a challenge phrase. When brandReg is
  //    null, condition 1 can never hold, so jsChallenge is false.
  const jsRedirectToNonBrand =
    brandReg !== null &&
    parsed.scriptRedirectTargets.some((t) => {
      const reg = refRegistrableDomain(t, suspectHost);
      return reg !== null && reg !== brandReg;
    });
  const challengePhrasePresent = (() => {
    const title = parsed.title.toLowerCase();
    const body = parsed.bodyTextSample.toLowerCase();
    return CHALLENGE_PHRASES.some((p) => title.includes(p) || body.includes(p));
  })();
  const jsChallenge = jsRedirectToNonBrand && challengePhrasePresent;

  if (parsed.antiBotWall !== null || jsChallenge) fired.add('anti_bot_wall');

  // Family reconciliation (§1.5): js_challenge overrides a fetcher
  // cf_challenge in the overlap — the non-brand-redirect mechanism is the
  // higher-value forensic marker (it tells us WHERE the wall bounces). This
  // does not change scoring; the single fired key scores identically.
  const antiBotWallFamily: string | null = jsChallenge ? 'js_challenge' : parsed.antiBotWall;

  let score = 0;
  for (const key of fired) score += SIGNAL_WEIGHTS[key];
  score = Math.min(100, score);

  const credentialHarvest = fired.has('credential_form') && fired.has('offdomain_form_exfil');

  // ── Lane 3 SHADOW MODE — computed, persisted, NOT acted on ───────
  // Everything above this line is byte-for-byte the pre-Lane-3 scorer:
  // `fired` is closed, `score` is summed, `credentialHarvest` is
  // derived. The call below cannot reach any of them — it takes
  // `parsed` and returns a separate bundle that is spread into new
  // result fields only. Phase 1 must not change a single existing
  // verdict; see spec §5.1.
  const shadow = computeShadowPageSignals(parsed);

  return {
    score,
    signals: Array.from(fired),
    credentialHarvest,
    antiBotWallFamily,
    aiSignals: shadow.aiSignals,
    scoreDelta: shadow.scoreDelta,
    evidence: shadow.evidence,
    pageGenerator: shadow.pageGenerator,
    exfilSink: shadow.exfilSink,
    exfilSinkId: shadow.exfilSinkId,
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
 *   - bare anti-bot wall (score 20, < 30)                   -> MEDIUM floor
 *
 * The `antiBotWall` flag is derived caller-side from the fired set
 * (`result.signals.includes('anti_bot_wall')`) so this stays a pure
 * value-in / value-out function. The bare-wall floor is the LAST branch
 * in the else-chain, so it only bites when score < 30 (the isolated-wall
 * case) — any wall that combines with another >= 10 signal already reaches
 * MEDIUM via the >= 30 branch. The terminal
 * `LEVEL_ORDER[target] > LEVEL_ORDER[current]` guard is retained
 * unchanged, so the floor can lift LOW -> MEDIUM but can NEVER downgrade an
 * already-HIGH/CRITICAL page.
 */
export function escalateThreatLevelForPage(
  current: PageThreatLevel,
  result: Pick<PagePhishingResult, 'score' | 'credentialHarvest'> & { antiBotWall: boolean },
): PageThreatLevel {
  let target: PageThreatLevel = current;
  if (result.credentialHarvest) target = 'CRITICAL';
  else if (result.score >= 60) target = 'HIGH';
  else if (result.score >= 30) target = 'MEDIUM';
  else if (result.antiBotWall) target = 'MEDIUM';
  return LEVEL_ORDER[target] > LEVEL_ORDER[current] ? target : current;
}

// ════════════════════════════════════════════════════════════════════
// Lane 3 — AI-build artifacts & covert exfil sinks. SHADOW MODE.
// docs/LANE3_AI_BUILD_ARTIFACTS_SPEC.md §3.1 / §3.3 / §5.
//
// PHASE 1 CONTRACT — read before touching anything below.
//   * Nothing here feeds `score`, `signals`, `credentialHarvest`,
//     `escalateThreatLevelForPage`, alert triage, or the AI judge.
//   * `escalateThreatLevelForPage` above is UNTOUCHED. No new floor.
//   * These signals may never dismiss, never lower a score, and never
//     enter a safe-path condition (spec §4.3, same standing as
//     `weaponization_flag` and `page_anti_bot_wall`).
//   * Nothing here writes phishing_pattern_signals.ai_generated_probability
//     — that is pinned NULL by doctrine (spec §4.4).
//   * NO REGEX over attacker HTML anywhere below. Bounded `.includes`
//     and hand-rolled token walks only, per the fetcher's SSRF/ReDoS
//     contract (page-fetch.ts:394-412). The "regex shapes" in the spec
//     are descriptive; a regex in this path must be rejected.
//   * This module stays PURE — no env, no fetch, no Date, no I/O.
//
// Three classes with different authority (spec §2):
//   A  synthetic build  — "machine-built and shipped unreviewed?".
//                         A proxy for disposable mass production, NOT
//                         for malice: a legitimate small business on an
//                         AI site builder trips these. Capped at 20.
//   B  exfil sink       — "does this page ship credentials to a covert
//                         channel?". Nothing to do with AI.
//   C  payload structure— "does this page carry a payload?".
// ════════════════════════════════════════════════════════════════════

/**
 * Shadow weights. SEPARATE from SIGNAL_WEIGHTS on purpose — keeping the
 * live table untouched is what makes Phase 1's no-op guarantee checkable
 * at a glance. Phase 2 merges promoted keys into SIGNAL_WEIGHTS.
 */
export const SHADOW_SIGNAL_WEIGHTS = {
  /** B1: credentials shipped to a named covert channel (Telegram bot,
   *  Discord/Slack webhook, tunnel host, bare IP form action). */
  covert_exfil_sink: 20,
  /** B2: a generic form-relay backend (Formspree, Google Forms, …).
   *  Near-useless alone — it is the default contact-form backend for a
   *  large share of legitimate static sites — and earns its 10 only
   *  because "legitimate contact form" and "password input" do not
   *  co-occur. 10 alone = LOW; 10 + credential_form's 30 = MEDIUM. */
  form_relay_sink: 10,
  /** C1: SVG carrying script, or an SVG disguised as a document download. */
  svg_script_payload: 15,
  /** A1: model refusal text left in the shipped page. */
  llm_refusal_leakage: 15,
  /** A2: a template token that never got substituted — a structural
   *  BUILD FAILURE, not a string an author chose. */
  unrendered_template_token: 12,
  /** A3: the scaffold's default <title>, never replaced. */
  default_scaffold_title: 12,
  /** A4: placeholder copy left in rendered text or a comment. */
  build_placeholder_text: 8,
  /** A5: an agent's to-do / plan checklist left in an HTML comment. */
  agent_scaffold_comment: 8,
} as const;

export type ShadowSignalKey = keyof typeof SHADOW_SIGNAL_WEIGHTS;

/** Class A (synthetic build) membership. Everything else is B or C. */
export const SHADOW_CLASS_A_KEYS: readonly ShadowSignalKey[] = [
  'llm_refusal_leakage',
  'unrendered_template_token',
  'default_scaffold_title',
  'build_placeholder_text',
  'agent_scaffold_comment',
];

/**
 * Class A's TOTAL contribution cap.
 *
 * THE CLASS A WEIGHTS SUM TO 55 AND THE CAP IS 20. THIS IS INTENTIONAL —
 * DO NOT "FIX" IT (spec §3.1, §3.3). The individual weights express
 * relative confidence *within* the family; the cap expresses confidence
 * *in the family*. Two properties must hold, and the cap is what makes
 * them hold:
 *   1. Class A can NEVER reach MEDIUM (30) alone — all five firing on an
 *      otherwise-clean page is 20, still LOW.
 *   2. Class A can NEVER flip MEDIUM → HIGH. The worst realistic MEDIUM
 *      stack is brand_asset_hotlink + favicon_clone + title_keyword_density
 *      = 37; 37 + 20 = 57, still MEDIUM. At a cap of 25 that breaks
 *      (37 + 25 = 62 → HIGH). Hence 20, not 25.
 * Anyone raising this number must re-check property 2 first.
 */
export const SHADOW_CLASS_A_CAP = 20;

/** Max length of a persisted evidence literal (spec §5.5). */
const MAX_EVIDENCE_LEN = 64;

// ── Literal tables (all lowercase; matched via bounded .includes) ────

/** B1 — host+path prefixes that only a covert exfil channel produces. */
const COVERT_SINK_PREFIXES: readonly string[] = [
  'discord.com/api/webhooks/',
  'discordapp.com/api/webhooks/',
  'api.telegram.org/bot',
  'hooks.slack.com/services/',
];

/** B1 structural variant — ephemeral tunnel hosts (suffix match on host). */
const EPHEMERAL_TUNNEL_SUFFIXES: readonly string[] = [
  '.ngrok.io', '.ngrok-free.app', '.trycloudflare.com', '.loca.lt',
];

/** B2 — generic form-relay backends. */
const RELAY_SINK_LITERALS: readonly string[] = [
  'formspree.io', 'formsubmit.co', 'getform.io', 'web3forms.com',
  'staticforms.xyz', 'usebasin.com', 'herotofu.com',
];

/** A1 — model refusal / self-identification text left in the page. */
const REFUSAL_LITERALS: readonly string[] = [
  'as an ai language model',
  'as a large language model',
  'i cannot assist with',
  "i can't assist with",
  "i'm sorry, but i can't",
  'i cannot create content that',
  "i'm unable to provide",
  'my knowledge cutoff',
  "i'm just an ai",
];

/**
 * A3 — default scaffold titles. EXACT-OR-PREFIX ONLY, NEVER SUBSTRING:
 * substring matching turns `document` into a detector for every
 * "Secure Document Portal" on the web.
 *
 * Residual FP acknowledged: the prefix leg still fires on a real title
 * that happens to START with a list entry (e.g. "Document Management
 * Portal"). That is the rule as specified, and shadow mode exists
 * precisely to measure it — the §5.3 brand-canonical negative control
 * disqualifies any Class A signal firing above 2-3%.
 */
const DEFAULT_SCAFFOLD_TITLES: readonly string[] = [
  'create next app', 'vite + react', 'vite app', 'react app', 'document',
  'untitled', 'untitled page', 'my site', 'my app', 'home page',
  'nuxt app', 'svelte app', 'astro', 'streamlit', 'index', 'replit',
  'webpage', 'new project', 'title',
];

/**
 * A4 — placeholder copy. Scanned over RENDERED TEXT AND COMMENTS ONLY,
 * never over `placeholder=` attributes, where every one of these appears
 * legitimately. That restriction is structural here: the fetcher never
 * captures the `placeholder` attribute at all.
 */
const PLACEHOLDER_LITERALS: readonly string[] = [
  'lorem ipsum', 'dolor sit amet', 'your company name', 'your brand here',
  'your api key', 'your_api_key', 'api_key_here', 'replace_me',
  'replace with your', 'insert your', 'placeholder text',
  'your-domain.com', 'example@example.com', 'john@example.com',
  '+1 (555) 123-4567', '123-456-7890',
];

/** A5 — markdown checkbox forms. Matched on lowercased text, so `- [X]`
 *  is covered by `- [x]`. */
const CHECKBOX_LITERALS: readonly string[] = ['- [ ]', '- [x]', '* [ ]'];

/** A5 — explicit plan headings. */
const PLAN_LITERALS: readonly string[] = [
  'implementation plan', 'remaining tasks', 'next steps:',
];

/** A2 — template delimiter pairs. */
const TEMPLATE_DELIMS: ReadonlyArray<readonly [string, string]> = [
  ['{{', '}}'], ['{%', '%}'], ['${', '}'],
];
/** A2 — max chars between opener and closer for the pair to count. */
const TEMPLATE_WINDOW = 64;

// ── Small character helpers (no regex) ──────────────────────────────

const isAsciiAlpha = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isAsciiDigit = (c: string): boolean => c >= '0' && c <= '9';

/** First literal from `needles` present in `haystack`, else null. */
function firstLiteralHit(haystack: string, needles: readonly string[]): string | null {
  for (const n of needles) if (haystack.includes(n)) return n;
  return null;
}

/**
 * Hostname of an absolute http(s) reference, lowercased. Null for
 * relative refs, non-http schemes, and unparseable junk. Uses the URL
 * parser, never a regex.
 */
function candidateHost(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const candidate = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `host` is a bare IP literal rather than a name. `URL`
 * normalizes IPv6 to a bracketed form, so the bracket test is exact.
 * IPv4 is a hand-rolled dotted-quad walk — no regex.
 */
function isIpLiteralHost(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true;
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return false;
    for (const ch of part) if (!isAsciiDigit(ch)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * Read the run of digits immediately after `marker` in `lowered`.
 * Bounded. This is how the Telegram bot id and the Discord webhook id
 * come out of a sink URL.
 */
function digitsAfterMarker(lowered: string, marker: string): string | null {
  const at = lowered.indexOf(marker);
  if (at === -1) return null;
  let i = at + marker.length;
  let out = '';
  while (i < lowered.length && out.length < 32 && isAsciiDigit(lowered[i]!)) {
    out += lowered[i]!;
    i += 1;
  }
  return out.length > 0 ? out : null;
}

/**
 * M2 — the pivot key. Telegram exposes the bot id in
 * `api.telegram.org/bot<id>:<token>/`; Discord exposes the webhook id in
 * `/api/webhooks/<id>/<token>`. Both are published in client-side
 * JavaScript by the kit operator, and one of them serves many kits
 * across many brands — which is the clustering finding this lane exists
 * to produce. Slack's `/services/` path is an opaque triple with no
 * stable leading id, so it yields no id.
 */
function extractSinkId(lowered: string): string | null {
  return (
    digitsAfterMarker(lowered, 'api.telegram.org/bot') ??
    digitsAfterMarker(lowered, 'discord.com/api/webhooks/') ??
    digitsAfterMarker(lowered, 'discordapp.com/api/webhooks/')
  );
}

interface SinkMatch {
  /** Host to persist as page_exfil_sink. */
  host: string;
  /** Bot / webhook id, when one was extractable. */
  id: string | null;
  /** Literal (or host) to persist as evidence. */
  evidence: string;
}

/**
 * B1 — covert exfil sink. `allowIpLiteral` is true only for `<form
 * action>` entries: the spec scopes the bare-IP-host variant to form
 * actions, where a numeric host is unambiguous, and not to script
 * literals, where an IP string is far more likely to be incidental.
 */
function matchCovertSink(ref: string, allowIpLiteral: boolean): SinkMatch | null {
  const lowered = ref.trim().toLowerCase();
  if (!lowered) return null;

  // Literal host+path prefixes. Checked on the raw lowered reference so a
  // scheme-less or protocol-relative literal still matches.
  const prefix = firstLiteralHit(lowered, COVERT_SINK_PREFIXES);
  if (prefix) {
    const host = candidateHost(ref);
    // Prefixes are `host/path`, so the leading segment IS the host when
    // the reference did not parse as an absolute URL.
    const literalHost = prefix.slice(0, prefix.indexOf('/'));
    return { host: host ?? literalHost, id: extractSinkId(lowered), evidence: prefix };
  }

  const host = candidateHost(ref);
  if (!host) return null;

  const tunnel = EPHEMERAL_TUNNEL_SUFFIXES.find((s) => host.endsWith(s));
  if (tunnel) return { host, id: null, evidence: host };

  if (allowIpLiteral && isIpLiteralHost(host)) {
    return { host, id: null, evidence: host };
  }
  return null;
}

/** B2 — generic form-relay backend. Google Forms needs BOTH literals. */
function matchRelaySink(ref: string): SinkMatch | null {
  const lowered = ref.trim().toLowerCase();
  if (!lowered) return null;

  if (lowered.includes('docs.google.com/forms/') && lowered.includes('/formresponse')) {
    return {
      host: candidateHost(ref) ?? 'docs.google.com',
      id: null,
      evidence: 'docs.google.com/forms/…/formResponse',
    };
  }
  const lit = firstLiteralHit(lowered, RELAY_SINK_LITERALS);
  if (!lit) return null;
  return { host: candidateHost(ref) ?? lit, id: null, evidence: lit };
}

/**
 * A2 — is the run between a template opener and closer an identifier?
 * `[A-Za-z_][A-Za-z0-9_. ]*`, at least 3 chars, expressed as a character
 * walk. The run is TRIMMED first: the charset admits spaces precisely so
 * that `{{ user.name }}` counts, and without the trim its leading space
 * would fail the first-character rule.
 */
function isTemplateIdentifier(run: string): boolean {
  if (run.length < 3) return false;
  const first = run[0]!;
  if (!isAsciiAlpha(first) && first !== '_') return false;
  for (const c of run) {
    if (!isAsciiAlpha(c) && !isAsciiDigit(c) && c !== '_' && c !== '.' && c !== ' ') {
      return false;
    }
  }
  return true;
}

/** A2 — first unrendered template token in rendered body text, or null. */
function findUnrenderedTemplateToken(body: string): string | null {
  for (const [open, close] of TEMPLATE_DELIMS) {
    let from = 0;
    for (let i = 0; i < 64; i++) {
      const at = body.indexOf(open, from);
      if (at === -1) break;
      const contentStart = at + open.length;
      const seg = body.slice(contentStart, Math.min(body.length, contentStart + TEMPLATE_WINDOW));
      const closeAt = seg.indexOf(close);
      if (closeAt !== -1) {
        const run = seg.slice(0, closeAt).trim();
        if (isTemplateIdentifier(run)) return `${open}${run}${close}`;
      }
      from = contentStart;
    }
  }
  return null;
}

/** A5 — does a trimmed line open a numbered step (`step 3:` / `3. `)? */
function isStepLineStart(line: string): boolean {
  if (line.startsWith('step ')) {
    const rest = line.slice('step '.length);
    let i = 0;
    while (i < rest.length && isAsciiDigit(rest[i]!)) i += 1;
    if (i > 0 && rest[i] === ':') return true;
  }
  let j = 0;
  while (j < line.length && isAsciiDigit(line[j]!)) j += 1;
  return j > 0 && line.slice(j, j + 2) === '. ';
}

/**
 * A5 — agent scaffold comment. Netcraft's literal stated tell, and the
 * one that needs the sharpest discipline.
 *
 * A BARE `TODO` SUBSTRING MATCH IS DISQUALIFIED. `TODO` in an HTML
 * comment is one of the most common strings on the unminified web;
 * matched naively this fires on a large fraction of WordPress themes and
 * is worse than nothing. THE STRUCTURE IS THE SIGNAL, THE WORD IS NOT —
 * hence a checkbox, or TWO markers, or TWO numbered steps, or an
 * explicit plan heading, all scoped to ONE comment.
 *
 * Returns the evidence string when it fires, else null.
 */
function matchAgentScaffoldComment(comment: string): string | null {
  const lower = comment.toLowerCase();

  const box = firstLiteralHit(lower, CHECKBOX_LITERALS);
  if (box) return box;

  const markers = countOccurrences(lower, 'todo:') + countOccurrences(lower, 'fixme:');
  if (markers >= 2) return `todo:/fixme: x${markers}`;

  let steps = 0;
  for (const rawLine of lower.split('\n')) {
    if (isStepLineStart(rawLine.trim())) {
      steps += 1;
      if (steps >= 2) return `numbered step plan (${steps}+)`;
    }
  }

  return firstLiteralHit(lower, PLAN_LITERALS);
}

/** Breakdown of the shadow delta. Pure arithmetic over fired keys. */
export interface ShadowDelta {
  /** Uncapped sum of fired Class A weights. */
  classASum: number;
  /** min(SHADOW_CLASS_A_CAP, classASum) — what actually contributes. */
  classAContribution: number;
  /** Sum of fired Class B + Class C weights (uncapped, no cap applies). */
  classBCSum: number;
  /** classAContribution + classBCSum. */
  delta: number;
  /** True when the Class A cap actually bound (classASum > cap). */
  capHit: boolean;
}

/**
 * Pure, reusable delta arithmetic over a set of fired shadow keys.
 * Shared by the scorer and by the diagnostics aggregator so the
 * "would-be contribution" is computed in exactly one place. Unknown keys
 * and duplicates are ignored.
 */
export function shadowScoreDelta(keys: readonly string[]): ShadowDelta {
  let classASum = 0;
  let classBCSum = 0;
  const seen = new Set<string>();
  const classA = SHADOW_CLASS_A_KEYS as readonly string[];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!Object.prototype.hasOwnProperty.call(SHADOW_SIGNAL_WEIGHTS, key)) continue;
    const weight = SHADOW_SIGNAL_WEIGHTS[key as ShadowSignalKey];
    if (classA.includes(key)) classASum += weight;
    else classBCSum += weight;
  }
  const classAContribution = Math.min(SHADOW_CLASS_A_CAP, classASum);
  return {
    classASum,
    classAContribution,
    classBCSum,
    delta: classAContribution + classBCSum,
    capHit: classASum > SHADOW_CLASS_A_CAP,
  };
}

/** The shadow bundle spread into PagePhishingResult. */
export interface ShadowPageSignals {
  aiSignals: ShadowSignalKey[];
  scoreDelta: number;
  evidence: Record<string, string>;
  pageGenerator: string | null;
  exfilSink: string | null;
  exfilSinkId: string | null;
}

/**
 * Compute the Lane 3 shadow signal set. PURE: takes parsed page signals,
 * returns a bundle. Brand context is deliberately NOT a parameter —
 * none of these eight signals is brand-relative, which is also why none
 * of them can be tuned per-customer.
 *
 * DEFENSIVE READS, on purpose: the new `ParsedPageSignals` fields are
 * required in the type, but `test/` is excluded from `tsconfig.json`
 * `include` (spec §7.2), so existing fixtures construct this interface
 * without them and would hand us `undefined` at runtime. The `??`
 * fallbacks below keep that a no-op rather than a throw. They come out
 * when defect 7.2 is fixed and `test/` is typechecked.
 */
export function computeShadowPageSignals(parsed: ParsedPageSignals): ShadowPageSignals {
  const title = (parsed.title ?? '').toLowerCase();
  const body = parsed.bodyTextSample ?? '';
  const bodyLower = body.toLowerCase();
  const scriptLower = (parsed.scriptTextSample ?? '').toLowerCase();
  const comments = parsed.commentSamples ?? [];
  const formActions = parsed.formActions ?? [];
  const sinkTargets = parsed.scriptSinkTargets ?? [];

  /** Fired key → matched literal. Insertion order is the report order. */
  const fired = new Map<ShadowSignalKey, string>();
  const fire = (key: ShadowSignalKey, evidence: string) => {
    if (!fired.has(key)) fired.set(key, evidence.slice(0, MAX_EVIDENCE_LEN));
  };

  // ── B1 covert_exfil_sink ────────────────────────────────────────
  // Two surfaces: <form action> (which offdomain_form_exfil already
  // reads) and script literals (which it CANNOT see — the live false
  // negative this lane exists to close).
  let exfilSink: string | null = null;
  let exfilSinkId: string | null = null;
  for (const action of formActions) {
    const m = matchCovertSink(action, true);
    if (m) { exfilSink = m.host; exfilSinkId = m.id; fire('covert_exfil_sink', m.evidence); break; }
  }
  if (!fired.has('covert_exfil_sink')) {
    for (const target of sinkTargets) {
      const m = matchCovertSink(target, false);
      if (m) { exfilSink = m.host; exfilSinkId = m.id; fire('covert_exfil_sink', m.evidence); break; }
    }
  }

  // ── B2 form_relay_sink ──────────────────────────────────────────
  for (const ref of [...formActions, ...sinkTargets]) {
    const m = matchRelaySink(ref);
    if (m) {
      fire('form_relay_sink', m.evidence);
      // B1's sink wins the metadata columns when both fired — a named
      // covert channel is the higher-value pivot.
      if (exfilSink === null) exfilSink = m.host;
      break;
    }
  }

  // ── C1 svg_script_payload ───────────────────────────────────────
  if (parsed.svgScriptPayload) fire('svg_script_payload', 'svg subtree: script/foreignObject/on*');
  else if (parsed.svgDownloadDisguise) fire('svg_script_payload', 'a[download] -> data:image/svg+xml');

  // ── A1 llm_refusal_leakage ──────────────────────────────────────
  // Title + rendered body + inline script sample. Budget for retiring
  // this one (spec §5.6): builder tooling is adding output filtering, so
  // its recall decays to zero. Its lasting value is evidentiary — it is
  // the sentence that goes in the takedown notice.
  const refusal =
    firstLiteralHit(title, REFUSAL_LITERALS) ??
    firstLiteralHit(bodyLower, REFUSAL_LITERALS) ??
    firstLiteralHit(scriptLower, REFUSAL_LITERALS);
  if (refusal) fire('llm_refusal_leakage', refusal);

  // ── A2 unrendered_template_token ────────────────────────────────
  // bodyTextSample ONLY — rendered text, not attributes, not script.
  // The best of the scaffolding family: a structural build failure, not
  // a string an author chose, and harder to strip than a comment.
  const templateToken = findUnrenderedTemplateToken(body);
  if (templateToken) fire('unrendered_template_token', templateToken);

  // ── A3 default_scaffold_title ───────────────────────────────────
  // Exact-or-prefix, NEVER substring. Longest match wins so the evidence
  // reads `untitled page` rather than `untitled`.
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    let best: string | null = null;
    for (const d of DEFAULT_SCAFFOLD_TITLES) {
      if ((trimmedTitle === d || trimmedTitle.startsWith(d)) && (best === null || d.length > best.length)) {
        best = d;
      }
    }
    if (best) fire('default_scaffold_title', best);
  }

  // ── A4 build_placeholder_text ───────────────────────────────────
  // Rendered text and comments only. `placeholder=` attributes are never
  // captured by the fetcher, so that exclusion is structural.
  let placeholder = firstLiteralHit(bodyLower, PLACEHOLDER_LITERALS);
  if (!placeholder) {
    for (const c of comments) {
      placeholder = firstLiteralHit(c.toLowerCase(), PLACEHOLDER_LITERALS);
      if (placeholder) break;
    }
  }
  if (placeholder) fire('build_placeholder_text', placeholder);

  // ── A5 agent_scaffold_comment ───────────────────────────────────
  // Per-comment, never over a concatenated blob.
  for (const c of comments) {
    const hit = matchAgentScaffoldComment(c);
    if (hit) { fire('agent_scaffold_comment', hit); break; }
  }

  const aiSignals = Array.from(fired.keys());
  const evidence: Record<string, string> = {};
  for (const [key, lit] of fired) evidence[key] = lit;

  return {
    aiSignals,
    scoreDelta: shadowScoreDelta(aiSignals).delta,
    evidence,
    pageGenerator: parsed.metaGenerator ?? null,
    exfilSink,
    exfilSinkId,
  };
}
