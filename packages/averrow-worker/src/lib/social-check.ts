/**
 * Social Handle Availability Checker
 *
 * Checks whether a brand name is taken on major social platforms
 * by making simple HTTP requests to public profile URLs.
 * Useful for detecting potential impersonation vectors.
 */

import { normalizeHandleForPlatform } from './handle-normalize';

export interface SocialCheckResult {
  platform: string;
  /** The handle actually probed for THIS platform — normalized per that
   *  platform's rules (e.g. `jane.doe` on Instagram, `janedoe` on X). Read
   *  this, not the caller's raw input, as the authoritative probed handle. */
  handle: string;
  available: boolean | null; // null = couldn't check
  url: string;
}

// ─── Platform definitions ───────────────────────────────────────

interface PlatformConfig {
  name: string;
  urlTemplate: (handle: string) => string;
  /** HTTP status that means "profile exists" (usually 200) */
  existsStatus: number[];
  /** HTTP status that means "profile does NOT exist" (usually 404) */
  notFoundStatus: number[];
}

const PLATFORMS: PlatformConfig[] = [
  {
    name: 'twitter',
    urlTemplate: (h) => `https://x.com/${h}`,
    existsStatus: [200],
    notFoundStatus: [404],
  },
  {
    name: 'instagram',
    urlTemplate: (h) => `https://www.instagram.com/${h}/`,
    existsStatus: [200],
    notFoundStatus: [404],
  },
  {
    name: 'linkedin',
    urlTemplate: (h) => `https://www.linkedin.com/company/${h}`,
    existsStatus: [200],
    notFoundStatus: [404],
  },
  {
    name: 'tiktok',
    urlTemplate: (h) => `https://www.tiktok.com/@${h}`,
    existsStatus: [200],
    notFoundStatus: [404],
  },
  {
    name: 'github',
    urlTemplate: (h) => `https://github.com/${h}`,
    existsStatus: [200],
    notFoundStatus: [404],
  },
  {
    name: 'youtube',
    urlTemplate: (h) => `https://www.youtube.com/@${h}`,
    existsStatus: [200],
    notFoundStatus: [404],
  },
];

// ─── Normalize brand name to a likely social handle ─────────────

/**
 * Legacy platform-AGNOSTIC name→base-handle transform. Strips everything
 * except [a-z0-9_-] — notably DROPS dots — lowercases, and caps at 30 chars.
 *
 * @deprecated for handle normalization. Because it drops dots uniformly it is
 * wrong for the platforms that ALLOW dots (Instagram/TikTok/YouTube): it made
 * `jane.doe` probe `janedoe`, conflating two distinct accounts (bug #22). The
 * probe below and the triage deciders now use `normalizeHandleForPlatform`
 * (lib/handle-normalize.ts) so probing and official-handle matching agree
 * per-platform. Retained only for callers that genuinely reduce a NAME to a
 * loose base slug; do NOT use it to normalize an actual handle for probing.
 */
export function toHandle(brandName: string): string {
  return brandName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 30);
}

// ─── Check a single platform ────────────────────────────────────

async function checkPlatform(
  platform: PlatformConfig,
  handle: string,
): Promise<SocialCheckResult> {
  const url = platform.urlTemplate(handle);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Averrow/1.0; +https://averrow.com)',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(2000),
    });

    if (platform.existsStatus.includes(res.status)) {
      return { platform: platform.name, handle, available: false, url };
    }
    if (platform.notFoundStatus.includes(res.status)) {
      return { platform: platform.name, handle, available: true, url };
    }

    // Ambiguous status — could be rate-limited, blocked, etc.
    return { platform: platform.name, handle, available: null, url };
  } catch {
    // Timeout or network error — can't determine
    return { platform: platform.name, handle, available: null, url };
  }
}

// ─── Check all platforms ────────────────────────────────────────

export async function checkSocialHandles(
  rawHandle: string,
): Promise<SocialCheckResult[]> {
  // Normalize the handle PER PLATFORM (bug #22): dots survive on
  // Instagram/TikTok/YouTube but are stripped for X/Twitter and GitHub, so a
  // single input can resolve to different exact handles on different
  // platforms. Each platform is probed with its own normalized handle and the
  // returned result carries that handle + the real URL that was requested.
  const results = await Promise.all(
    PLATFORMS.map(async (p): Promise<SocialCheckResult> => {
      const handle = normalizeHandleForPlatform(rawHandle, p.name);
      if (!handle || handle.length < 2) {
        // Nothing probe-able for this platform after normalization.
        return { platform: p.name, handle, available: null, url: p.urlTemplate(handle) };
      }
      return checkPlatform(p, handle);
    }),
  );

  return results;
}
