/**
 * Social Handle Availability Checker
 *
 * Checks whether a brand name is taken on major social platforms
 * by making simple HTTP requests to public profile URLs.
 * Useful for detecting potential impersonation vectors.
 */

export interface SocialCheckResult {
  platform: string;
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

function toHandle(brandName: string): string {
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
  brandName: string,
): Promise<SocialCheckResult[]> {
  const handle = toHandle(brandName);
  if (!handle || handle.length < 2) {
    return PLATFORMS.map((p) => ({
      platform: p.name,
      handle: brandName,
      available: null,
      url: p.urlTemplate(brandName),
    }));
  }

  // Check all platforms in parallel (each has its own 2s timeout)
  const results = await Promise.all(
    PLATFORMS.map((p) => checkPlatform(p, handle)),
  );

  return results;
}
