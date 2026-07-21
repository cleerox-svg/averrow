/**
 * Executive Social-Impersonation Detection — deterministic core (Stage 3)
 *
 * Given ONE org_executives row, generate plausible impersonation handles
 * from the executive's full name, HEAD-check which ones actually exist on
 * the watched platforms, and score name-similarity for the ones that do.
 *
 * This module is PURE detection logic and SIDE-EFFECT-FREE:
 *   - No AI calls (100% deterministic — permutation + HEAD + Levenshtein).
 *   - No D1 writes, no createAlert, no agent_runs/agent_events.
 *   - Takes the exec row + an injectable existence-checker; the only I/O is
 *     the injected HEAD probe (defaults to the real one, mocked in tests).
 *
 * Stage 4 wraps `runExecutiveMonitorForExec` in a dispatched agent that
 * persists results and creates `executive_impersonation` alerts; the
 * triage rule that gates those alerts is `decideExecutiveImpersonationTriage`
 * in lib/alert-triage.ts. This file just RETURNS candidates.
 *
 * Reuse (do NOT reinvent): mirrors scanners/social-monitor.ts's
 * `runSocialMonitorForBrand`, reuses the exact same HEAD checker
 * (lib/social-check.ts) and the exact same deterministic scorer
 * (scanners/impersonation-scorer.ts) the brand path uses, so behaviour is
 * consistent across the social / app-store / executive alert families.
 */

import { checkSocialHandles, type SocialCheckResult } from '../lib/social-check';
import { normalizeHandleForPlatform } from '../lib/handle-normalize';
import {
  scoreImpersonation,
  nameSimilarity,
  type ImpersonationSignals,
} from './impersonation-scorer';
import { SUPPORTED_PLATFORMS, PLATFORM_URL_TEMPLATES } from './social-monitor';

// COUPLING NOTE (OPTIONAL/INFO): the platform KEYS we match against below
// (`r.platform === platform`) are produced by lib/social-check.ts's own
// `PLATFORMS` array, which is independent of `SUPPORTED_PLATFORMS` here.
// They currently hold the same six lowercase keys. If social-check.ts ever
// renames/reorders a platform key, this list must track it (or both should
// be sourced from one shared const). Kept as-is for now — the sets match.

// ─── Types ──────────────────────────────────────────────────────

/** The minimal slice of an org_executives row the detector needs. */
export interface ExecutiveScanInput {
  id: string;
  full_name: string;
  /** JSON object text: platform -> handle. Mirrors brands.official_handles. */
  official_handles: string | null;
  /** JSON array text of platform keys to monitor (social-monitor's 6). */
  watch_platforms: string | null;
}

/** One existing handle surfaced by the detector. Stage 4 turns the
 *  non-official, over-threshold ones into `executive_impersonation` alerts. */
export interface ExecutiveImpersonationCandidate {
  execId: string;
  platform: string;
  /** The candidate handle actually probed on THIS platform — normalized per
   *  the platform's own rules (bug #22): dots kept on Instagram/TikTok/YouTube,
   *  stripped on X/GitHub. Equals the exact string the HEAD probe requested. */
  handle: string;
  /** Always true here — we only return handles the HEAD probe found to exist. */
  exists: boolean;
  /** Deterministic impersonation score 0.0-1.0 (name-similarity driven). */
  score: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Human-readable score reasons from the shared scorer. */
  signals: string[];
  /** True when this handle IS the exec's registered official handle for the
   *  platform — Stage 4/triage Rule B dismisses these as always-safe. */
  isOfficialHandle: boolean;
  profileUrl: string;
}

/** Injectable HEAD-existence checker. Same signature as
 *  `checkSocialHandles` — one call covers all six platforms. Injected so
 *  tests run offline/deterministically. */
export type SocialExistenceChecker = (handle: string) => Promise<SocialCheckResult[]>;

// ─── Bounds (Stage 4's cron batches on top of these) ─────────────

/** Max candidate handles probed per exec. Each is ONE `checkSocialHandles`
 *  network call (which already covers all 6 platforms), so this also caps
 *  network calls/exec at ~12 — mirrors the brand scanner's ~16 and keeps a
 *  per-exec run well under the Workers cron CPU ceiling. Stage 4 must still
 *  cap execs/run (the brand scanner's BATCH_LIMIT=10 lesson). */
export const MAX_CANDIDATES_PER_EXEC = 12;

/** Platforms probed per exec — never more than the supported set. */
export const MAX_PLATFORMS_PER_EXEC = SUPPORTED_PLATFORMS.length;

// The scanner returns EVERY existing candidate with its computed score; it
// applies no score floor of its own (FIX 3 — a local floor would be dead
// code: handle_is_permutation (0.25) + not-verified (0.10) alone floor
// every candidate at ~0.35). The single, documented keep/dismiss cut is the
// tunable `impersonationThreshold` (default 0.5) in
// decideExecutiveImpersonationTriage, which Stage 4 / ops tune there.

// ─── Name → candidate handle generation ──────────────────────────

/**
 * Normalize one name token to handle-safe characters, ASCII-FOLDING
 * diacritics first (José -> jose, García -> garcia) so realistic
 * transliterated squat handles are generated. Fold is deterministic and
 * dependency-free: NFD decomposes accented letters into base + combining
 * mark, then the combining marks (U+0300–U+036F) are stripped.
 *
 * Residual limitation: characters that DON'T NFD-decompose to an ASCII base
 * (e.g. ø, ł, ð) are dropped rather than transliterated. Accepted gap — the
 * common Latin-1 accents (é, á, í, ó, ú, ü, ñ, ç, â, ê…) all fold correctly.
 */
function normalizeToken(token: string): string {
  return token
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Generate plausible impersonation handles for a person's full name.
 *
 * The brand `generateHandlePermutations` is brand-token oriented
 * (_official/_hq/_inc suffixes, char substitution). People get impersonated
 * with a different, name-shaped vocabulary, so this produces the realistic
 * personal forms: `janedoe`, `jane.doe`, `jane_doe`, `jane-doe`,
 * `janedoeofficial`, `realjanedoe`, `officialjanedoe`, `jdoe`, plus
 * full-surname / hyphenated forms for multi-token names (`janedoesmith`,
 * `jane-doe-smith`).
 *
 * Deterministic and bounded (<= MAX_CANDIDATES_PER_EXEC, priority-ordered:
 * canonical first+last forms, then multi-token surname forms, then the
 * "official/real" dressing, then initials/digits). FALSE-POSITIVE CONTROL —
 * the first line of defence against common-name flooding:
 *   - Requires >= 2 name tokens (a first AND a last name). Mononyms and
 *     single tokens ("Cher", "Madonna", "John") yield NO candidates.
 *   - Each usable token must be >= 2 chars; the combined base must be
 *     >= 4 chars.
 *   - Middle names are dropped from the first+last core (matching how the
 *     platform derives initials elsewhere), but ARE included in the
 *     multi-token forms so hyphenated surnames aren't missed.
 * When the gate fails, returns [] → the scanner produces nothing.
 */
export function generateExecutiveHandleCandidates(fullName: string): string[] {
  const tokens = fullName
    .split(/[\s._\-]+/)
    .map(normalizeToken)
    .filter((t) => t.length >= 2);

  // FP gate: need at least a first + last name token.
  if (tokens.length < 2) return [];

  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!; // drop middle names for the core forms
  const base = `${first}${last}`;
  if (base.length < 4) return [];

  const allBase = tokens.join(''); // full name incl. middle / hyphenated parts
  const firstInitial = first.slice(0, 1);

  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string): void => {
    const clean = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
    if (clean.length < 4 || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };

  // Canonical first+last forms.
  add(`${first}${last}`);            // janedoe
  add(`${first}.${last}`);           // jane.doe
  add(`${first}_${last}`);           // jane_doe
  add(`${first}-${last}`);           // jane-doe

  // Multi-token forms (middle name OR hyphenated surname) — FIX 2b.
  if (tokens.length > 2) {
    add(allBase);                    // janedoesmith
    add(tokens.join('.'));           // jane.doe.smith
    add(tokens.join('-'));           // jane-doe-smith
    add(tokens.join('_'));           // jane_doe_smith
  }

  // "Verified/official" impersonation dressing.
  add(`${base}official`);            // janedoeofficial
  add(`real${base}`);                // realjanedoe
  add(`official${base}`);            // officialjanedoe
  add(`${base}_official`);           // janedoe_official
  add(`the${base}`);                 // thejanedoe

  // Initial + last, and trailing-digit takeover variants.
  add(`${firstInitial}${last}`);     // jdoe
  add(`${base}1`);                   // janedoe1
  add(`${base}0`);                   // janedoe0

  return out.slice(0, MAX_CANDIDATES_PER_EXEC);
}

// ─── Single Executive Monitor (pure, side-effect-free) ───────────

/**
 * Run impersonation detection for ONE executive. Returns the existing
 * candidate handles across the exec's watched platforms. Writes nothing,
 * creates no alerts, makes no AI calls.
 *
 * Normalization consistency (bug #22, now fixed at the root). The HEAD probe
 * (`checkSocialHandles`) normalizes PER PLATFORM: dots survive on
 * Instagram/TikTok/YouTube, are stripped on X/GitHub. So each candidate is
 * matched against the exact handle the probe resolved for that platform
 * (`platformResult.handle`), and the exec's official handle is compared with
 * the SAME per-platform normalization. Consequences:
 *   - On X, `jane.doe` and `janedoe` collapse to one account (`janedoe`) and
 *     are emitted once; on Instagram they are DISTINCT accounts, so an
 *     impostor at `janedoe` is no longer masked by the exec's real `jane.doe`.
 *   - An official handle `jane.doe` matches the probed `jane.doe` on Instagram
 *     (isOfficialHandle=true, never emitted as impersonation) but does NOT
 *     match a probed `janedoe`.
 * This supersedes the earlier `toHandle`-for-consistency workaround, which
 * only made the path internally consistent while still conflating the two
 * dotted/undotted accounts.
 *
 * @param exec         the org_executives row slice
 * @param checkHandles injectable HEAD-existence probe (defaults to the real
 *                     `checkSocialHandles`; mocked in tests)
 */
export async function runExecutiveMonitorForExec(
  exec: ExecutiveScanInput,
  checkHandles: SocialExistenceChecker = checkSocialHandles,
): Promise<ExecutiveImpersonationCandidate[]> {
  // Parse official handles (platform -> RAW handle). Kept raw here; normalized
  // per-platform at compare time (bug #22) so the dot-rules match the probe.
  const officialByPlatform: Record<string, string> = {};
  try {
    const parsed = exec.official_handles ? JSON.parse(exec.official_handles) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [platform, handle] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof handle === 'string' && handle.trim()) {
          officialByPlatform[platform.toLowerCase()] = handle;
        }
      }
    }
  } catch {
    // Malformed JSON — treat as no official handles.
  }

  // Resolve watched platforms → clamp to the supported set, dedupe, bound.
  let watched: string[] = [];
  try {
    const parsed = exec.watch_platforms ? JSON.parse(exec.watch_platforms) : null;
    if (Array.isArray(parsed)) {
      watched = parsed.filter((p): p is string => typeof p === 'string');
    }
  } catch {
    // Malformed JSON — fall through to default below.
  }
  const supported = new Set<string>(SUPPORTED_PLATFORMS);
  const platformSeen = new Set<string>();
  const platforms: string[] = [];
  for (const raw of watched.length > 0 ? watched : SUPPORTED_PLATFORMS) {
    const p = raw.toLowerCase();
    if (supported.has(p) && !platformSeen.has(p)) {
      platformSeen.add(p);
      platforms.push(p);
    }
    if (platforms.length >= MAX_PLATFORMS_PER_EXEC) break;
  }

  // Generate candidate handles, kept in RAW dot-preserving form and deduped on
  // that raw form. Per-platform normalization (bug #22) happens inside the
  // probe and at compare time — NOT here — so dots survive to the platforms
  // that allow them.
  const candSeen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of generateExecutiveHandleCandidates(exec.full_name)) {
    const key = raw.toLowerCase();
    if (key.length < 2 || candSeen.has(key)) continue;
    candSeen.add(key);
    candidates.push(raw);
  }
  if (candidates.length === 0 || platforms.length === 0) return [];

  // Dedupe network checks: ONE call per unique raw candidate covers all
  // platforms (the probe normalizes per-platform internally).
  const resultsByHandle = new Map<string, SocialCheckResult[]>();
  for (const handle of candidates) {
    resultsByHandle.set(handle, await checkHandles(handle));
  }

  const out: ExecutiveImpersonationCandidate[] = [];
  for (const platform of platforms) {
    // The exec's own handle for this platform, normalized to compare against
    // the probed handle under the platform's rules.
    const officialForPlatform =
      officialByPlatform[platform] !== undefined
        ? normalizeHandleForPlatform(officialByPlatform[platform]!, platform)
        : undefined;

    // Distinct raw candidates can resolve to the SAME probed handle on a given
    // platform (e.g. `jane.doe` and `janedoe` both → `janedoe` on X) — emit once.
    const emittedOnPlatform = new Set<string>();

    for (const rawHandle of candidates) {
      const platformResult = resultsByHandle
        .get(rawHandle)
        ?.find((r) => r.platform === platform);

      // available===false means "profile exists (taken)". Anything else
      // (available / unknown / no result) is not an impersonation hit.
      if (!platformResult || platformResult.available !== false) continue;

      // The handle the probe ACTUALLY resolved for this platform.
      const probedHandle = platformResult.handle;
      if (!probedHandle || probedHandle.length < 2) continue;
      if (emittedOnPlatform.has(probedHandle)) continue;
      emittedOnPlatform.add(probedHandle);

      const signals: ImpersonationSignals = {
        name_similarity: nameSimilarity(exec.full_name, probedHandle),
        uses_brand_keywords: false, // person, not a brand — no brand-keyword signal
        account_age_suspicious: false, // HEAD-only, cannot determine
        low_followers: false, // HEAD-only, cannot determine
        verified: false, // HEAD-only — assume unverified (conservative)
        handle_is_permutation: true, // by construction
      };
      const scored = scoreImpersonation(signals);

      const isOfficialHandle =
        officialForPlatform !== undefined && officialForPlatform === probedHandle;

      out.push({
        execId: exec.id,
        platform,
        handle: probedHandle,
        exists: true,
        score: scored.score,
        severity: scored.severity,
        signals: scored.reasons,
        isOfficialHandle,
        profileUrl: platformResult.url || PLATFORM_URL_TEMPLATES[platform]?.(probedHandle) || '',
      });
    }
  }

  return out;
}
