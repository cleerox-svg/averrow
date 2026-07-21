/**
 * Platform-aware social-handle normalization.
 *
 * A social HANDLE is not the same thing as a brand/person NAME. Turning a
 * display NAME into candidate handles (stripping spaces/punctuation) is a
 * DIFFERENT operation from normalizing an actual HANDLE so it matches the
 * exact string a platform will resolve. This module owns the latter.
 *
 * The bug this fixes (follow-up #22): the old `toHandle` (lib/social-check.ts)
 * stripped ALL of `[^a-z0-9_-]`, DROPPING dots, while the triage decider's
 * old platform-agnostic normalizer kept dots. So a canonical dotted personal
 * handle like `jane.doe` was probed as `janedoe` yet compared as `jane.doe` —
 * the probe hit the wrong URL and could conflate two distinct accounts. Dots
 * are legal on some platforms and illegal on others, so a single
 * platform-agnostic transform can NEVER be correct for all six.
 *
 * `normalizeHandleForPlatform` strips only the characters INVALID for the
 * given platform, so `jane.doe` stays `jane.doe` on Instagram/TikTok/YouTube
 * (dot-bearing accounts are distinct) but correctly collapses to `janedoe`
 * on X/Twitter and GitHub (which forbid dots). Used BOTH when deriving the
 * probe URL (lib/social-check.ts) AND when comparing against an official
 * handle (lib/alert-triage.ts deciders) so probe and match agree.
 *
 * Per-platform rules (source of truth: the profile-URL forms in
 * scanners/social-monitor.ts `PLATFORM_URL_TEMPLATES` + each platform's
 * documented username grammar):
 *
 *   twitter (X)   x.com/{h}                letters, digits, `_`         (no `.`, no `-`)
 *   instagram     instagram.com/{h}/       letters, digits, `.`, `_`    (no `-`)
 *   tiktok        tiktok.com/@{h}          letters, digits, `.`, `_`    (no `-`)
 *   youtube       youtube.com/@{h}         letters, digits, `.`, `_`, `-`
 *   github        github.com/{h}           letters, digits, `-`         (no `.`, no `_`)
 *   linkedin      linkedin.com/company/{h} letters, digits, `-`         (no `.`, no `_`)
 *
 * Deterministic and dependency-free. No AI.
 */

/** Per-platform "strip everything NOT in the allowed set" patterns. Keyed by
 *  the lowercase platform name used across the social paths. */
const PLATFORM_STRIP: Record<string, RegExp> = {
  twitter: /[^a-z0-9_]/g, // X/Twitter: alphanumeric + underscore
  instagram: /[^a-z0-9._]/g, // Instagram: + dot + underscore
  tiktok: /[^a-z0-9._]/g, // TikTok: + dot + underscore
  youtube: /[^a-z0-9._-]/g, // YouTube @handles: + dot + underscore + hyphen
  github: /[^a-z0-9-]/g, // GitHub: alphanumeric + hyphen
  linkedin: /[^a-z0-9-]/g, // LinkedIn slugs: alphanumeric + hyphen
};

/** Fallback for an unrecognized platform: keep the full handle-safe set
 *  (`.`, `_`, `-`) so we never over-strip and cause a spurious match. This is
 *  strictly more permissive than the old `toHandle`, which dropped dots. */
const DEFAULT_STRIP = /[^a-z0-9._-]/g;

/** The platforms with an explicit rule above (the supported six). */
export const HANDLE_NORMALIZED_PLATFORMS = Object.freeze(
  Object.keys(PLATFORM_STRIP),
);

/**
 * Normalize a raw social handle to exactly the string the given platform
 * would resolve: trim, lowercase, drop a single leading `@`, strip the
 * characters that platform forbids, and cap at 30 chars.
 *
 * Passing an unknown/empty platform falls back to the permissive
 * handle-safe set (keeps `.`/`_`/`-`) rather than guessing a stricter rule.
 */
export function normalizeHandleForPlatform(
  handle: string,
  platform: string | null | undefined,
): string {
  let h = handle.trim().toLowerCase();
  if (h.startsWith('@')) h = h.slice(1);
  const strip = (platform && PLATFORM_STRIP[platform.toLowerCase()]) || DEFAULT_STRIP;
  return h.replace(strip, '').slice(0, 30);
}
